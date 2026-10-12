// 配置与生成结果的本地持久化（存于 Electron userData 目录）
import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SCAN_LIMIT_BOUNDS, type InterviewResult, type RecentProject, type Settings } from '@shared/types'
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

const SETTINGS_MAX_BYTES = 2 * 1024 * 1024
const RECENT_MAX_BYTES = 2 * 1024 * 1024
const RESULT_MAX_BYTES = 8 * 1024 * 1024
const MAX_DIAGNOSTICS = 128
const STORAGE_WRITE_FAILED = '保存本地数据失败，请检查磁盘空间或权限后重试。'

interface DiagnosticRecord {
  diagnostic: StorageDiagnostic
  target: string
  maxBytes: number
  validate: (value: unknown) => value is unknown
}

const diagnostics = new Map<string, DiagnosticRecord>()

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInterviewResult(value: unknown): value is InterviewResult {
  try {
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

function isSettings(value: unknown): value is Settings {
  if (!isObject(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => !['profiles', 'defaultProfileId', 'scanLimits'].includes(key))) return false
  const profiles = value.profiles === undefined ? [] : value.profiles
  if (!Array.isArray(profiles) || profiles.length > MAX_LLM_PROFILES) return false
  for (const profile of profiles) {
    if (!isObject(profile) || Object.keys(profile).some((key) => !['id', 'name', 'baseUrl', 'apiKey', 'model', 'temperature'].includes(key))) return false
    if (!validText(profile.id, LLM_PROFILE_LIMITS.id)) return false
    if (!validText(profile.name, LLM_PROFILE_LIMITS.name)) return false
    if (!validText(profile.baseUrl, LLM_PROFILE_LIMITS.baseUrl)) return false
    try {
      const url = new URL(profile.baseUrl)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return false
    } catch {
      return false
    }
    if (!validText(profile.apiKey, LLM_PROFILE_LIMITS.apiKey, 0)) return false
    if (!validText(profile.model, LLM_PROFILE_LIMITS.model)) return false
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
  return Array.isArray(value) && value.length <= 20 && value.every((entry) =>
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

export function getSettings(): Settings {
  const file = userDataFile('settings.json')
  const result = readWithBackup({
    id: 'settings', kind: 'settings', target: file, maxBytes: SETTINGS_MAX_BYTES, validate: isSettings
  })
  if (result.status === 'valid') return { ...DEFAULT_SETTINGS, ...result.value }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: Settings): void {
  try {
    writePreserving(userDataFile('settings.json'), settings, SETTINGS_MAX_BYTES, isSettings)
    clearDiagnostic('settings')
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    const wrapped = new Error(STORAGE_WRITE_FAILED) as NodeJS.ErrnoException
    if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      wrapped.code = code
    }
    throw wrapped
  }
}

export function saveResult(projectPath: string, result: InterviewResult): void {
  try {
    assertInterviewResultContract(result, path.isAbsolute)
  } catch {
    throw new Error(RESULT_CONTRACT_MESSAGES.generated)
  }
  const target = resultFile(projectPath)
  try {
    writePreserving(target, result, RESULT_MAX_BYTES, isInterviewResult)
    clearDiagnostic(resultId(projectPath))
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

export function deleteResult(projectPath: string): void {
  const target = resultFile(projectPath)
  const files = [`${target}.bak`, `${target}.corrupt`, target]
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // Continue so a failure on one copy does not prevent attempts on others.
    }
  }
  let allAbsent = true
  for (const file of files) {
    try {
      fs.lstatSync(file)
      allAbsent = false
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== 'ENOENT') allAbsent = false
    }
  }
  const id = resultId(projectPath)
  if (allAbsent) {
    clearDiagnostic(id)
    return
  }
  try {
    loadResult(projectPath)
  } catch {
    // The read path refreshes diagnostics; delete failure remains the public outcome.
  }
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
  list.unshift({
    path: entry.path,
    name,
    lastUsedAt: new Date().toISOString(),
    ...(entry.granularity ? { granularity: entry.granularity as RecentProject['granularity'] } : {})
  })
  const capped = list.slice(0, 20)
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

export function recoverStorage(id: string): void {
  if (!isStorageDiagnosticId(id)) throw new Error(STORAGE_MESSAGES.restoreFailed)
  const record = diagnostics.get(id)
  if (!record) throw new Error(STORAGE_MESSAGES.restoreFailed)
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
    throw new Error(STORAGE_MESSAGES.restoreFailed)
  }
  try {
    atomicReplaceBytes(record.target, backup.bytes)
  } catch {
    throw new Error(STORAGE_MESSAGES.restoreFailed)
  }
  clearDiagnostic(id)
}
