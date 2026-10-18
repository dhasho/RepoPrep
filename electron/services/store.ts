// 配置与生成结果的本地持久化（存于 Electron userData 目录）
import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SCAN_LIMIT_BOUNDS, type AnalysisPage, type AnalysisSummary, type Granularity, type InterviewResult, type LlmProfile, type LlmProfileDraft, type PublicSettings, type RecentProject, type RoleFocus, type Settings, type SettingsSaveRequest } from '@shared/types'
import { assertInterviewResultContract, LLM_PROFILE_LIMITS, MAX_LLM_PROFILES, RESULT_CONTRACT_MESSAGES } from '@shared/result-contract'
import {
  archiveCorrupt,
  atomicReplaceBytes,
  cleanupOrphanTemps,
  readBounded,
  writeBackup
} from './atomic-json'
import {
  isStorageDiagnosticId,
  STORAGE_MESSAGES,
  type StorageDiagnostic,
  type StorageKind,
  type StorageProblem
} from '@shared/storage-contract'
import { isFilesystemRoot, projectDisplayName } from './project-display-name'
import { decryptCredential, encryptCredential, type CredentialCrypto } from './credential-vault'
import { nativeCredentialCrypto } from './native-credential-crypto'

const SETTINGS_MAX_BYTES = 2 * 1024 * 1024
const SETTINGS_ARCHIVE_MAX_BYTES = SETTINGS_MAX_BYTES * 2 + 64 * 1024
const SETTINGS_ARCHIVE_MAGIC = Buffer.from('RepoPrep encrypted settings archive v1\n', 'utf8')
const RECENT_MAX_BYTES = 2 * 1024 * 1024
const RESULT_MAX_BYTES = 8 * 1024 * 1024
const HISTORY_PAGE_SIZE = 50
const RECENT_PROJECT_LIMIT = 200
const MAX_DIAGNOSTICS = 128
const STORAGE_WRITE_FAILED = '保存本地数据失败，请检查磁盘空间或权限后重试。'

interface DiagnosticRecord {
  diagnostic: StorageDiagnostic
  target: string
  maxBytes: number
  validate: (value: unknown) => value is unknown
}

interface StoredProfile extends Omit<LlmProfile, 'apiKey'> {
  apiKey?: string
  credential?: { version: 1; ciphertext: string }
}

interface StoredSettings {
  profiles: StoredProfile[]
  defaultProfileId?: string | null
  scanLimits?: Settings['scanLimits']
  schemaVersion?: 2
}

const diagnostics = new Map<string, DiagnosticRecord>()
let settingsTail: Promise<void> = Promise.resolve()

function serializeSettings<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsTail.then(operation, operation)
  settingsTail = result.then(() => undefined, () => undefined)
  return result
}

function userDataFile(name: string): string {
  return path.join(app.getPath('userData'), name)
}

function projectsDir(): string {
  return path.join(app.getPath('userData'), 'projects')
}

function resultFile(projectPath: string): string {
  const hash = createHash('sha1').update(projectPath).digest('hex')
  return path.join(projectsDir(), `${hash}.json`)
}

function resultId(projectPath: string): string {
  return `result:${createHash('sha1').update(projectPath).digest('hex')}`
}

function analysisHistoryDir(projectPath: string): string {
  const hash = createHash('sha1').update(projectPath).digest('hex')
  return path.join(projectsDir(), `${hash}.history`)
}

function analysisId(result: InterviewResult): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex')
}

function analysisFilename(summary: AnalysisSummary): string {
  return `${Date.parse(summary.createdAt)}-${summary.granularity}-${summary.roleFocus}-${summary.id}.json`
}

function isStoredResultReadError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === STORAGE_MESSAGES.corruptResult || error.message === STORAGE_MESSAGES.unreadableResult
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LEGACY_GITHUB_FIELDS = new Set([
  'login', 'name', 'repoOwner', 'repo', 'repoHtmlUrl', 'defaultBranch', 'fetchedAt', 'stats',
  'commits', 'pullRequests', 'issues', 'reviewedPullRequests', 'contextText', 'truncated'
])
const LEGACY_GITHUB_TEXT_FIELDS = new Set([
  'login', 'name', 'repoOwner', 'repo', 'repoHtmlUrl', 'defaultBranch', 'fetchedAt', 'contextText'
])
const LEGACY_GITHUB_LIST_FIELDS = new Set(['commits', 'pullRequests', 'issues', 'reviewedPullRequests'])

function isLegacyGithubMetadata(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false
  return Object.entries(value).every(([key, item]) => {
    if (!LEGACY_GITHUB_FIELDS.has(key)) return false
    if (LEGACY_GITHUB_TEXT_FIELDS.has(key)) return typeof item === 'string' || (key === 'name' && item === null)
    if (key === 'stats') return isObject(item)
    if (LEGACY_GITHUB_LIST_FIELDS.has(key)) return Array.isArray(item)
    if (key === 'truncated') return typeof item === 'boolean'
    return false
  })
}

function isInterviewResult(value: unknown): value is InterviewResult {
  try {
    // GitHub enrichment was stored on historical results but is no longer part of
    // the result contract. Drop only its recognized top-level shape while reading;
    // the parsed object is in memory and the original bounded file bytes stay intact.
    if (isObject(value) && Object.hasOwn(value, 'github')) {
      if (!isLegacyGithubMetadata(value.github)) return false
      delete value.github
    }
    if (
      isObject(value) && value.projectName === '' && typeof value.projectPath === 'string' &&
      path.isAbsolute(value.projectPath) && isFilesystemRoot(value.projectPath)
    ) {
      value.projectName = projectDisplayName(value.projectPath)
    }
    assertInterviewResultContract(value, path.isAbsolute)
    return true
  } catch {
    return false
  }
}

function validText(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0')
}

function isSettings(value: unknown): value is StoredSettings {
  if (!isObject(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => !['profiles', 'defaultProfileId', 'scanLimits', 'schemaVersion'].includes(key))) return false
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) return false
  const profiles = value.profiles === undefined ? [] : value.profiles
  if (!Array.isArray(profiles) || profiles.length > MAX_LLM_PROFILES) return false
  const ids = new Set<string>()
  for (const profile of profiles) {
    if (!isObject(profile) || Object.keys(profile).some((key) => !['id', 'name', 'baseUrl', 'apiKey', 'credential', 'model', 'protocol', 'temperature'].includes(key))) return false
    if (!validText(profile.id, LLM_PROFILE_LIMITS.id)) return false
    if (ids.has(profile.id)) return false
    ids.add(profile.id)
    if (!validText(profile.name, LLM_PROFILE_LIMITS.name)) return false
    if (!validText(profile.baseUrl, LLM_PROFILE_LIMITS.baseUrl)) return false
    try {
      const url = new URL(profile.baseUrl)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return false
    } catch {
      return false
    }
    if (profile.apiKey !== undefined && !validText(profile.apiKey, LLM_PROFILE_LIMITS.apiKey, 0)) return false
    if (profile.credential !== undefined && (!isObject(profile.credential) || Object.keys(profile.credential).some((key) => !['version', 'ciphertext'].includes(key)) || profile.credential.version !== 1 || !validText(profile.credential.ciphertext, 64 * 1024))) return false
    if (profile.apiKey !== undefined && profile.credential !== undefined) return false
    if (!validText(profile.model, LLM_PROFILE_LIMITS.model)) return false
    if (profile.protocol !== undefined && profile.protocol !== 'openai' && profile.protocol !== 'anthropic') return false
    if (profile.temperature !== undefined && (typeof profile.temperature !== 'number' || !Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2)) return false
  }
  if (value.defaultProfileId !== undefined && value.defaultProfileId !== null && !validText(value.defaultProfileId, 128)) return false
  if (typeof value.defaultProfileId === 'string' && !profiles.some((profile) => isObject(profile) && profile.id === value.defaultProfileId)) return false
  if (value.scanLimits !== undefined) {
    if (!isObject(value.scanLimits) || Object.keys(value.scanLimits).some((key) => !['maxFiles', 'maxTreeNodes', 'maxContentFileBytes'].includes(key))) return false
    for (const [key, bounds] of Object.entries(SCAN_LIMIT_BOUNDS)) {
      const field = value.scanLimits[key]
      if (field !== undefined && (typeof field !== 'number' || !Number.isInteger(field) || field < bounds.min || field > bounds.max)) return false
    }
  }
  return true
}

function isRecentProjects(value: unknown): value is RecentProject[] {
  return Array.isArray(value) && value.length <= RECENT_PROJECT_LIMIT && value.every((entry) =>
    isObject(entry) &&
    validText(entry.path, 4096) && path.isAbsolute(entry.path) &&
    validText(entry.name, 256) &&
    validText(entry.lastUsedAt, 128) && Number.isFinite(Date.parse(entry.lastUsedAt)) &&
    (entry.granularity === undefined || entry.granularity === 'coarse' || entry.granularity === 'medium' || entry.granularity === 'fine')
  )
}

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) as unknown }
  } catch {
    return { ok: false }
  }
}

function rememberDiagnostic(
  id: string,
  kind: StorageKind,
  problem: StorageProblem,
  usingBackup: boolean,
  canRecover: boolean,
  target: string,
  maxBytes: number,
  validate: (value: unknown) => value is unknown,
  projectPath?: string
): void {
  const diagnostic: StorageDiagnostic = {
    id,
    kind,
    problem,
    usingBackup,
    canRecover,
    ...(kind === 'result' && projectPath ? { projectPath } : {})
  }
  diagnostics.delete(id)
  diagnostics.set(id, { diagnostic, target, maxBytes, validate })
  while (diagnostics.size > MAX_DIAGNOSTICS) {
    const oldest = diagnostics.keys().next().value as string | undefined
    if (!oldest) break
    diagnostics.delete(oldest)
  }
}

function clearDiagnostic(id: string): void {
  diagnostics.delete(id)
}

function readValid<T>(file: string, maxBytes: number, validate: (value: unknown) => value is T):
  | { status: 'valid'; bytes: Buffer; value: T }
  | { status: 'missing' | 'unreadable' | 'corrupt' } {
  const read = readBounded(file, maxBytes)
  if (read.status !== 'ok') return { status: read.status }
  const parsed = parseJson(read.bytes)
  if (!parsed.ok || !validate(parsed.value)) return { status: 'corrupt' }
  return { status: 'valid', bytes: read.bytes, value: parsed.value }
}

function readWithBackup<T>(options: {
  id: string
  kind: StorageKind
  target: string
  maxBytes: number
  validate: (value: unknown) => value is T
  projectPath?: string
}): { status: 'valid'; value: T } | { status: 'missing' | 'corrupt' | 'unreadable' } {
  cleanupOrphanTemps(options.target)
  const primary = readValid(options.target, options.maxBytes, options.validate)
  if (primary.status === 'valid') {
    clearDiagnostic(options.id)
    return { status: 'valid', value: primary.value }
  }
  const backup = readValid(`${options.target}.bak`, options.maxBytes, options.validate)
  if (primary.status === 'missing' && backup.status === 'missing') {
    clearDiagnostic(options.id)
    return { status: 'missing' }
  }
  if (backup.status === 'valid') {
    rememberDiagnostic(
      options.id, options.kind, primary.status, true, true,
      options.target, options.maxBytes, options.validate, options.projectPath
    )
    return { status: 'valid', value: backup.value }
  }
  const problem = primary.status === 'missing' ? backup.status : primary.status
  rememberDiagnostic(
    options.id,
    options.kind,
    problem,
    false,
    false,
    options.target,
    options.maxBytes,
    options.validate,
    options.projectPath
  )
  return { status: problem === 'missing' ? 'corrupt' : problem }
}

function writePreserving(file: string, data: unknown, maxBytes: number, validate: (value: unknown) => value is unknown): void {
  if (!validate(data)) throw new Error('Invalid storage data')
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  if (bytes.byteLength > maxBytes) throw new Error('Storage size limit exceeded')
  cleanupOrphanTemps(file)
  const old = readValid(file, maxBytes, validate)
  if (old.status === 'valid') {
    writeBackup(file, old.bytes)
  } else if (old.status === 'corrupt') {
    const raw = readBounded(file, maxBytes)
    if (raw.status !== 'ok') throw new Error('Existing storage could not be archived')
    archiveCorrupt(file, raw.bytes)
  } else if (old.status === 'unreadable') {
    throw new Error('Existing storage could not be read')
  }
  atomicReplaceBytes(file, bytes)
}

const DEFAULT_SETTINGS: Settings = { profiles: [], defaultProfileId: null }

let credentialCrypto: CredentialCrypto = nativeCredentialCrypto
export function setCredentialCryptoForTests(crypto: CredentialCrypto | null): void {
  credentialCrypto = crypto ?? nativeCredentialCrypto
}

function publicSettings(settings: StoredSettings, status: PublicSettings['profiles'][number]['credentialStatus'] = 'stored'): PublicSettings {
  return {
    defaultProfileId: settings.defaultProfileId ?? null,
    ...(settings.scanLimits !== undefined ? { scanLimits: settings.scanLimits } : {}),
    profiles: settings.profiles.map((profile) => {
      const hasApiKey = Boolean(profile.apiKey || profile.credential)
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: profile.baseUrl,
        model: profile.model,
        ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
        ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
        hasApiKey,
        credentialStatus: hasApiKey ? status : 'missing'
      }
    })
  }
}

function settingsCopies(file: string): string[] {
  const dir = path.dirname(file)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [file] }
  const base = path.basename(file)
  return names
    .filter((name) => name === base || name === `${base}.bak` || name === `${base}.corrupt` || isManagedSettingsTemp(name, base))
    .map((name) => path.join(dir, name))
}

function isManagedSettingsTemp(name: string, base: string): boolean {
  for (const target of [base, `${base}.bak`, `${base}.corrupt`]) {
    const prefix = `.${target}.projectlens-`
    if (!name.startsWith(prefix)) continue
    const match = /^(\d+)-[a-f0-9]{24}\.tmp$/.exec(name.slice(prefix.length))
    if (!match) return false
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
    try { process.kill(pid, 0); return false } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      return code === 'ESRCH'
    }
  }
  return false
}

function canonicalEndpoint(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null
    return parsed.href.replace(/\/+$/, '')
  } catch { return null }
}

function containsLegacyCredential(settings: { profiles: readonly { apiKey?: string }[] }): boolean {
  return settings.profiles.some((profile) => typeof profile.apiKey === 'string')
}

function isEncryptedArchive(bytes: Buffer): boolean {
  return bytes.byteLength > SETTINGS_ARCHIVE_MAGIC.byteLength && bytes.subarray(0, SETTINGS_ARCHIVE_MAGIC.byteLength).equals(SETTINGS_ARCHIVE_MAGIC) && bytes.byteLength <= SETTINGS_ARCHIVE_MAX_BYTES
}

export async function decryptSettingsArchiveBytes(bytes: Buffer): Promise<Buffer> {
  if (!isEncryptedArchive(bytes)) throw new Error('settings-archive-invalid')
  try {
    if (!await credentialCrypto.isAvailable()) throw new Error('credential-store-unavailable')
    const encoded = await credentialCrypto.decrypt(bytes.subarray(SETTINGS_ARCHIVE_MAGIC.byteLength))
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('settings-archive-invalid')
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.byteLength > SETTINGS_MAX_BYTES || decoded.toString('base64') !== encoded) throw new Error('settings-archive-invalid')
    return decoded
  } catch {
    throw new Error('settings-archive-unavailable')
  }
}

function hasPendingMigration(file: string): boolean {
  for (const candidate of settingsCopies(file)) {
    const read = readBounded(candidate, SETTINGS_ARCHIVE_MAX_BYTES)
    if (read.status === 'missing') continue
    if (read.status !== 'ok') return true
    const parsed = parseJson(read.bytes)
    if (parsed.ok && isSettings(parsed.value)) {
      if (containsLegacyCredential(parsed.value)) return true
      continue
    }
    if (isEncryptedArchive(read.bytes)) continue
    return true
  }
  return false
}

async function migrateSettingsCopies(file: string): Promise<void> {
  const copies = settingsCopies(file)
  const replacements: Array<{ path: string; bytes: Buffer }> = []
  try {
    for (const candidate of copies) {
      const read = readBounded(candidate, SETTINGS_ARCHIVE_MAX_BYTES)
      if (read.status === 'missing') continue
      if (read.status !== 'ok') throw new Error('settings-migration-pending')
      if (isEncryptedArchive(read.bytes)) continue
      if (read.bytes.byteLength > SETTINGS_MAX_BYTES) throw new Error('settings-migration-pending')
      const parsed = parseJson(read.bytes)
      if (!parsed.ok || !isSettings(parsed.value)) {
        let ciphertext: Buffer
        try {
          if (!await credentialCrypto.isAvailable()) throw new Error('credential-store-unavailable')
          ciphertext = await credentialCrypto.encrypt(read.bytes.toString('base64'))
        } catch { throw new Error('settings-migration-pending') }
        const archive = Buffer.concat([SETTINGS_ARCHIVE_MAGIC, ciphertext])
        if (archive.byteLength > SETTINGS_ARCHIVE_MAX_BYTES) throw new Error('settings-migration-pending')
        replacements.push({ path: candidate, bytes: archive })
        continue
      }
      if (!containsLegacyCredential(parsed.value)) continue
      const profiles = []
      for (const profile of parsed.value.profiles) {
        const secret = profile.apiKey ?? ''
        const { apiKey: _discard, ...metadata } = profile
        profiles.push({ ...metadata, ...(secret ? { credential: await encryptCredential(secret, credentialCrypto) } : {}) })
      }
      const migrated = { ...parsed.value, schemaVersion: 2, profiles }
      replacements.push({ path: candidate, bytes: Buffer.from(JSON.stringify(migrated, null, 2), 'utf8') })
    }
    for (const item of replacements) atomicReplaceBytes(item.path, item.bytes)
  } catch {
    throw new Error('settings-migration-pending')
  }
}

export async function getSettings(): Promise<PublicSettings> {
  const file = userDataFile('settings.json')
  const result = readWithBackup({
    id: 'settings', kind: 'settings', target: file, maxBytes: SETTINGS_MAX_BYTES, validate: isSettings
  })
  if (result.status === 'valid') {
    const pending = hasPendingMigration(file)
    let available = false
    try { available = await credentialCrypto.isAvailable() } catch { available = false }
    return publicSettings(result.value, pending ? 'migration-pending' : available ? 'stored' : 'locked')
  }
  return publicSettings({ profiles: [], defaultProfileId: null })
}

async function getPrivateProfileUnlocked(profileId: string): Promise<LlmProfile | null> {
  const file = userDataFile('settings.json')
  await migrateSettingsCopies(file)
  const result = readWithBackup({ id: 'settings', kind: 'settings', target: file, maxBytes: SETTINGS_MAX_BYTES, validate: isSettings })
  if (result.status !== 'valid') return null
  const raw = result.value.profiles.find((profile) => profile.id === profileId)
  if (!raw) return null
  const stored = raw as LlmProfile & { credential?: unknown }
  const { credential, ...metadata } = stored
  const apiKey = typeof stored.apiKey === 'string' ? stored.apiKey : credential ? await decryptCredential(credential, credentialCrypto) : ''
  return { ...metadata, apiKey }
}

export function getPrivateProfile(profileId: string): Promise<LlmProfile | null> {
  return serializeSettings(() => getPrivateProfileUnlocked(profileId))
}

export function saveSettings(settings: SettingsSaveRequest): Promise<void> {
  return serializeSettings(async () => {
    try {
      const file = userDataFile('settings.json')
      await migrateSettingsCopies(file)
      const stored = readWithBackup({ id: 'settings', kind: 'settings', target: file, maxBytes: SETTINGS_MAX_BYTES, validate: isSettings })
      const previous = stored.status === 'valid' ? stored.value : DEFAULT_SETTINGS
      const priorById = new Map(previous.profiles.map((profile) => [profile.id, profile]))
      const profiles: Array<Record<string, unknown>> = []
      const ids = new Set<string>()
      for (const requested of settings.profiles) {
        if (ids.has(requested.id)) throw new Error('Invalid settings')
        ids.add(requested.id)
        const prior = priorById.get(requested.id) as (LlmProfile & { credential?: unknown }) | undefined
        const action = requested.credentialAction ?? (requested.apiKey ? 'replace' : 'keep')
        const { apiKey = '', protocol, credentialAction: _action, useSavedCredential: _reference, hasApiKey: _claim, credentialStatus: _status, ...metadata } = requested
        const profileMetadata = { ...metadata, ...(protocol !== undefined ? { protocol } : {}) }
        let credential: unknown
        if (action === 'replace') {
          credential = apiKey ? await encryptCredential(apiKey, credentialCrypto) : undefined
        } else if (action === 'keep') {
          if (prior?.credential && canonicalEndpoint(prior.baseUrl) !== canonicalEndpoint(requested.baseUrl)) {
            throw new Error('credential-endpoint-changed')
          }
          if (
            (prior?.credential || prior?.apiKey) &&
            (prior.protocol ?? 'openai') !== (requested.protocol ?? 'openai')
          ) {
            throw new Error('credential-protocol-changed')
          }
          if (typeof prior?.apiKey === 'string' && prior.apiKey) {
            credential = await encryptCredential(prior.apiKey, credentialCrypto)
          } else {
            credential = prior?.credential
          }
        } else if (action !== 'clear') throw new Error('Invalid settings')
        profiles.push({ ...profileMetadata, ...(credential ? { credential } : {}) })
      }
      const persisted = { ...settings, schemaVersion: 2, profiles }
      writePreserving(file, persisted, SETTINGS_MAX_BYTES, isSettings)
      clearDiagnostic('settings')
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (error instanceof Error && error.message === 'credential-endpoint-changed') throw new Error('修改接口地址前，请先替换或清除已保存的 API Key。')
      if (error instanceof Error && error.message === 'credential-protocol-changed') throw new Error('修改接口协议前，请先替换或清除已保存的 API Key。')
      if (error instanceof Error && error.message === 'settings-migration-pending') throw new Error('设置尚未完成安全迁移，请检查系统凭据存储后重试。')
      if (error instanceof Error && (error.message === 'credential-store-unavailable' || error.message === 'credential-encryption-failed')) throw new Error('系统凭据存储当前不可用，设置未更改。请稍后重试。')
      const wrapped = new Error(STORAGE_WRITE_FAILED) as NodeJS.ErrnoException
      if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        wrapped.code = code
      }
      throw wrapped
    }
  })
}

function ensureHistoryDirectory(projectPath: string): string {
  const projects = projectsDir()
  fs.mkdirSync(projects, { recursive: true })
  const projectsStat = fs.lstatSync(projects)
  if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink()) throw new Error('Unsafe history directory')
  const directory = analysisHistoryDir(projectPath)
  try {
    fs.mkdirSync(directory)
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code !== 'EEXIST') throw error
  }
  const historyStat = fs.lstatSync(directory)
  if (!historyStat.isDirectory() || historyStat.isSymbolicLink()) throw new Error('Unsafe history directory')
  return directory
}

function archivePreviousAnalysis(projectPath: string, bytes: Buffer, value: InterviewResult): void {
  const summary: AnalysisSummary = {
    id: analysisId(value),
    createdAt: value.createdAt,
    granularity: value.granularity,
    roleFocus: value.roleFocus
  }
  const directory = ensureHistoryDirectory(projectPath)
  const target = path.join(directory, analysisFilename(summary))
  try {
    const existingStat = fs.lstatSync(target)
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) throw new Error('Unsafe history entry')
    const existing = readValid(target, RESULT_MAX_BYTES, isInterviewResult)
    if (existing.status !== 'valid' || analysisId(existing.value) !== summary.id) throw new Error('Invalid immutable history entry')
    return
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code !== 'ENOENT') throw error
  }
  atomicReplaceBytes(target, bytes)
}

function historySummaries(projectPath: string): AnalysisSummary[] {
  const projects = projectsDir()
  try {
    const projectsStat = fs.lstatSync(projects)
    if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink()) throw new Error(STORAGE_MESSAGES.unreadableResult)
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') return []
    throw error
  }
  const directory = analysisHistoryDir(projectPath)
  let directoryStat: fs.Stats
  try {
    directoryStat = fs.lstatSync(directory)
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') return []
    throw error
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(STORAGE_MESSAGES.unreadableResult)
  const summaries: AnalysisSummary[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const match = /^(-?\d{1,16})-(coarse|medium|fine)-(general|frontend|backend|algorithm)-([a-f0-9]{64})\.json$/.exec(entry.name)
    if (!match) continue
    const timestamp = Number(match[1])
    if (!Number.isSafeInteger(timestamp)) continue
    const createdAt = new Date(timestamp)
    if (!Number.isFinite(createdAt.getTime())) continue
    summaries.push({
      id: match[4],
      createdAt: createdAt.toISOString(),
      granularity: match[2] as Granularity,
      roleFocus: match[3] as RoleFocus
    })
  }
  return summaries
}

export function saveResult(projectPath: string, result: InterviewResult): string {
  try {
    assertInterviewResultContract(result, path.isAbsolute)
  } catch {
    throw new Error(RESULT_CONTRACT_MESSAGES.generated)
  }
  const target = resultFile(projectPath)
  try {
    const previous = readValid(target, RESULT_MAX_BYTES, isInterviewResult)
    if (previous.status === 'unreadable') throw new Error('Existing result could not be read')
    if (previous.status === 'valid') {
      archivePreviousAnalysis(projectPath, previous.bytes, previous.value)
    } else {
      const backup = readValid(`${target}.bak`, RESULT_MAX_BYTES, isInterviewResult)
      if (backup.status === 'valid') archivePreviousAnalysis(projectPath, backup.bytes, backup.value)
    }
    writePreserving(target, result, RESULT_MAX_BYTES, isInterviewResult)
    clearDiagnostic(resultId(projectPath))
    return analysisId(result)
  } catch {
    throw new Error(STORAGE_MESSAGES.saveResult)
  }
}

export function loadResult(projectPath: string): InterviewResult | null {
  const id = resultId(projectPath)
  const result = readWithBackup({
    id,
    kind: 'result',
    target: resultFile(projectPath),
    maxBytes: RESULT_MAX_BYTES,
    projectPath,
    validate: isInterviewResult
  })
  if (result.status === 'valid') return result.value
  if (result.status === 'missing') return null
  if (result.status === 'corrupt') throw new Error(STORAGE_MESSAGES.corruptResult)
  throw new Error(STORAGE_MESSAGES.unreadableResult)
}

export function listAnalyses(projectPath: string, cursor?: string): AnalysisPage {
  const summaries = new Map<string, AnalysisSummary>()
  try {
    const latest = loadResult(projectPath)
    if (latest) {
      const summary: AnalysisSummary = {
        id: analysisId(latest),
        createdAt: latest.createdAt,
        granularity: latest.granularity,
        roleFocus: latest.roleFocus
      }
      summaries.set(summary.id, summary)
    }
  } catch (error) {
    // A damaged latest file is diagnosed by loadResult; archived rows remain browseable.
    if (!isStoredResultReadError(error)) throw error
  }
  for (const summary of historySummaries(projectPath)) {
    if (!summaries.has(summary.id)) summaries.set(summary.id, summary)
  }
  const sorted = [...summaries.values()].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)
  )
  const start = cursor === undefined ? 0 : sorted.findIndex((item) => item.id === cursor) + 1
  if (cursor !== undefined && start === 0) return { items: [], nextCursor: null }
  const items = sorted.slice(start, start + HISTORY_PAGE_SIZE)
  const hasMore = start + items.length < sorted.length
  return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null }
}

export function loadAnalysis(projectPath: string, id: string): InterviewResult | null {
  if (!/^[a-f0-9]{64}$/.test(id)) return null
  try {
    const latest = loadResult(projectPath)
    if (latest && analysisId(latest) === id) return latest
  } catch (error) {
    // Continue to the immutable archive when the current result is damaged.
    if (!isStoredResultReadError(error)) throw error
  }
  const directory = analysisHistoryDir(projectPath)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(directory)
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') return null
    throw new Error(STORAGE_MESSAGES.unreadableResult)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(STORAGE_MESSAGES.unreadableResult)
  const filename = historySummaries(projectPath).find((summary) => summary.id === id)
  if (!filename) return null
  const target = path.join(directory, analysisFilename(filename))
  try {
    const entryStat = fs.lstatSync(target)
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error('Unsafe history entry')
    const record = readValid(target, RESULT_MAX_BYTES, isInterviewResult)
    if (record.status !== 'valid') throw new Error(STORAGE_MESSAGES.corruptResult)
    const actualId = analysisId(record.value)
    if (actualId !== id || Date.parse(record.value.createdAt) !== Date.parse(filename.createdAt) || record.value.granularity !== filename.granularity || record.value.roleFocus !== filename.roleFocus) {
      throw new Error(STORAGE_MESSAGES.corruptResult)
    }
    return record.value
  } catch (error) {
    if (error instanceof Error && Object.values(STORAGE_MESSAGES).some((message) => message === error.message)) throw error
    throw new Error(STORAGE_MESSAGES.unreadableResult)
  }
}

export function deleteResult(projectPath: string): void {
  const projects = projectsDir()
  const target = resultFile(projectPath)
  const managedTargets = [target, `${target}.bak`, `${target}.corrupt`, analysisHistoryDir(projectPath)]
  const [primary, backup, corrupt, history] = managedTargets
  const resultCopies = [backup, corrupt, primary]
  try {
    const projectsStat = fs.lstatSync(projects)
    if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink()) throw new Error('Unsafe project storage')
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') {
      clearDiagnostic(resultId(projectPath))
      return
    }
    throw new Error(STORAGE_MESSAGES.deleteResult)
  }

  let historyExists = false
  try {
    const historyStat = fs.lstatSync(history)
    if (!historyStat.isDirectory() || historyStat.isSymbolicLink()) throw new Error('Unsafe history directory')
    historyExists = true
    for (const entry of fs.readdirSync(history, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe history entry')
    }
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code !== 'ENOENT') throw new Error(STORAGE_MESSAGES.deleteResult)
  }

  for (const file of resultCopies) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // Continue so a failure on one copy does not prevent attempts on others.
    }
  }
  if (historyExists) {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(history, { withFileTypes: true })
    } catch {
      // The final absence check below reports an unreadable or retained directory.
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      try {
        fs.rmSync(path.join(history, entry.name), { force: true })
      } catch {
        // Continue so one locked archive does not prevent attempts on the rest.
      }
    }
    try {
      fs.rmdirSync(history)
    } catch {
      // The final absence check below reports a directory that could not be removed.
    }
  }

  const finalState = new Map<string, 'absent' | 'present' | 'unknown'>()
  for (const file of managedTargets) {
    try {
      fs.lstatSync(file)
      finalState.set(file, 'present')
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      finalState.set(file, code === 'ENOENT' ? 'absent' : 'unknown')
    }
  }
  const id = resultId(projectPath)
  if ([...finalState.values()].every((state) => state === 'absent')) {
    clearDiagnostic(id)
    return
  }
  const currentOrBackup = [primary, backup]
  if (currentOrBackup.some((file) => finalState.get(file) !== 'absent')) {
    try {
      loadResult(projectPath)
    } catch {
      // The read path refreshes diagnostics; delete failure remains the public outcome.
    }
  } else if (finalState.get(history) === 'absent') clearDiagnostic(id)
  throw new Error(STORAGE_MESSAGES.deleteResult)
}

export function getRecentProjects(): RecentProject[] {
  const file = userDataFile('recent.json')
  const result = readWithBackup({
    id: 'recent', kind: 'recent', target: file, maxBytes: RECENT_MAX_BYTES, validate: isRecentProjects
  })
  return result.status === 'valid' ? result.value : []
}

export function addRecentProject(entry: { path: string; name: string; granularity?: string }): RecentProject[] {
  const name = entry.name || (isFilesystemRoot(entry.path) ? projectDisplayName(entry.path) : entry.name)
  const list = getRecentProjects().filter((p) => p.path !== entry.path)
  if (list.length >= RECENT_PROJECT_LIMIT) throw new Error(STORAGE_WRITE_FAILED)
  list.unshift({
    path: entry.path,
    name,
    lastUsedAt: new Date().toISOString(),
    ...(entry.granularity ? { granularity: entry.granularity as RecentProject['granularity'] } : {})
  })
  const capped = list
  try {
    writePreserving(userDataFile('recent.json'), capped, RECENT_MAX_BYTES, isRecentProjects)
    clearDiagnostic('recent')
    return capped
  } catch {
    throw new Error(STORAGE_WRITE_FAILED)
  }
}

export function removeRecentProject(projectPath: string): void {
  const list = getRecentProjects().filter((p) => p.path !== projectPath)
  try {
    writePreserving(userDataFile('recent.json'), list, RECENT_MAX_BYTES, isRecentProjects)
    clearDiagnostic('recent')
  } catch {
    throw new Error(STORAGE_WRITE_FAILED)
  }
}

export function getStorageDiagnostics(): StorageDiagnostic[] {
  return [...diagnostics.values()].map(({ diagnostic }) => ({ ...diagnostic }))
}

export function recoverStorage(id: string): Promise<void> {
  return serializeSettings(async () => {
    if (!isStorageDiagnosticId(id)) throw new Error(STORAGE_MESSAGES.restoreFailed)
    const record = diagnostics.get(id)
    if (!record) throw new Error(STORAGE_MESSAGES.restoreFailed)
    if (record.diagnostic.kind === 'settings') {
      try { await migrateSettingsCopies(record.target) } catch { throw new Error('设置尚未完成安全迁移，请检查系统凭据存储后重试。') }
    }
    const backup = readValid(`${record.target}.bak`, record.maxBytes, record.validate)
    if (backup.status !== 'valid') {
      rememberDiagnostic(
        id, record.diagnostic.kind, record.diagnostic.problem, false, false,
        record.target, record.maxBytes, record.validate, record.diagnostic.projectPath
      )
      throw new Error(STORAGE_MESSAGES.noBackup)
    }
    const current = readValid(record.target, record.maxBytes, record.validate)
    if (current.status === 'valid') {
      clearDiagnostic(id)
      return
    }
    if (current.status === 'corrupt') {
      const raw = readBounded(record.target, record.maxBytes)
      if (raw.status !== 'ok') throw new Error(STORAGE_MESSAGES.restoreFailed)
      try {
        archiveCorrupt(record.target, raw.bytes)
      } catch {
        throw new Error(STORAGE_MESSAGES.restoreFailed)
      }
    } else if (current.status === 'unreadable') {
      if (record.diagnostic.kind === 'settings') {
        const archived = readBounded(record.target, SETTINGS_ARCHIVE_MAX_BYTES)
        if (archived.status !== 'ok' || !isEncryptedArchive(archived.bytes)) throw new Error(STORAGE_MESSAGES.restoreFailed)
        try { archiveCorrupt(record.target, archived.bytes) } catch { throw new Error(STORAGE_MESSAGES.restoreFailed) }
      } else {
        throw new Error(STORAGE_MESSAGES.restoreFailed)
      }
    }
    try {
      atomicReplaceBytes(record.target, backup.bytes)
    } catch {
      throw new Error(STORAGE_MESSAGES.restoreFailed)
    }
    clearDiagnostic(id)
  })
}
