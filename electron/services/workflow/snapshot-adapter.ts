import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node TS test runner requires explicit extension.
import { captureProjectSnapshot, isProjectSnapshotCurrent } from '../project-snapshot.ts'
// @ts-ignore TS5097 -- direct Node TS test runner requires explicit extension.
import { readProjectContent } from '../project-content-reader.ts'
// @ts-ignore TS5097 -- direct Node TS test runner requires explicit extension.
import { redactSensitiveContent } from '../sensitive.ts'
// @ts-ignore TS5097 -- direct Node TS test runner requires explicit extension.
import { analyzeSource } from '../source-analysis.ts'
// @ts-ignore TS5097 -- direct Node TS test runner requires explicit extension.
import type { ScanResult, ScannedFile } from '../scanner.ts'
import { WorkflowError, type ApprovedProjectRead, type EvidenceSourceKind, type WorkflowFile, type WorkflowProjectSnapshot } from './project-contract'

const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024
const DEFAULT_POLICY = 'scanner-policy-v1'
const DEFAULT_REDACTION = 'sensitive-content-v1'
const DEFAULT_PARSER = 'source-analysis-v1'
const ownedReads = new WeakMap<object, SnapshotState>()

type StateFile = { scanFile: ScannedFile; file: WorkflowFile }
type SnapshotState = { invalid: boolean; cache: Map<string, ApprovedProjectRead>; cacheBytes: number; readonly fileMap: Map<string, StateFile> }
type Reader = typeof readProjectContent
type Analyzer = typeof analyzeSource

function fail(code: ConstructorParameters<typeof WorkflowError>[0]): never { throw new WorkflowError(code) }
function validTag(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\w.-]+$/.test(value) }
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function canonical(value: unknown): string {
  if (typeof value === 'bigint') return `"${value.toString()}n"`
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
function sourceKind(file: ScannedFile): EvidenceSourceKind {
  const ext = file.ext.toLowerCase()
  if (/^(md|mdx|txt|rst|adoc)$/.test(ext) || /readme/i.test(file.relPath)) return 'documentation'
  if (/^(json|ya?ml|toml|ini|env|xml|gradle|properties)$/.test(ext)) return 'configuration'
  if (/^(js|jsx|ts|tsx|mjs|cjs|mts|cts|py|go|rs|java|cs|cpp?|h|hpp|rb|php|swift|kt)$/.test(ext)) return 'code'
  return 'other'
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('cancelled') }

export async function createWorkflowSnapshot(scan: ScanResult, options: {
  projectId: string
  policyVersion?: string
  redactionVersion?: string
  parserVersion?: string
  maxCacheBytes?: number
  reader?: Reader
  analyzer?: Analyzer
}): Promise<WorkflowProjectSnapshot> {
  if (!scan || typeof scan !== 'object' || !Array.isArray(scan.files) || !options || !validTag(options.projectId)) fail('invalid-argument')
  const policyVersion = options.policyVersion ?? DEFAULT_POLICY
  const redactionVersion = options.redactionVersion ?? DEFAULT_REDACTION
  const parserVersion = options.parserVersion ?? DEFAULT_PARSER
  const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_CACHE_BYTES
  if (![policyVersion, redactionVersion, parserVersion].every(validTag) || typeof maxCacheBytes !== 'number' || !Number.isFinite(maxCacheBytes) || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes <= 0 || maxCacheBytes > DEFAULT_CACHE_BYTES) fail('invalid-argument')
  if ((options.reader !== undefined && typeof options.reader !== 'function') || (options.analyzer !== undefined && typeof options.analyzer !== 'function')) fail('invalid-argument')
  const reader = options.reader ?? readProjectContent
  const analyzer = options.analyzer ?? analyzeSource
  let captured
  try { captured = await captureProjectSnapshot(scan) } catch { fail('permission-denied') }
  if (!captured.valid || captured.contentReadable !== true || !(await isProjectSnapshotCurrent(captured))) fail('stale-snapshot')
  const approvals = new Set(captured.entries.filter((entry) => entry.type === 'file' && entry.contentApproved === true).map((entry) => entry.path))
  const candidateFiles = scan.files.filter((file) => file.isContentCandidate && approvals.has(file.relPath))
  const snapshotSeed = canonical({ project: options.projectId, entries: captured.entries, policyVersion, redactionVersion, parserVersion })
  const snapshotId = digest(snapshotSeed)
  const fileMap = new Map<string, StateFile>()
  const files: WorkflowFile[] = candidateFiles.map((scanFile) => {
    if (typeof scanFile.relPath !== 'string' || scanFile.relPath.startsWith('/') || scanFile.relPath.split('/').some((part) => !part || part === '.' || part === '..') || !Number.isSafeInteger(scanFile.size) || scanFile.size < 0) fail('permission-denied')
    const fileId = digest(`${snapshotId}\0${scanFile.relPath}`)
    const file = freezeDeep({ fileId, relPath: scanFile.relPath, byteLength: scanFile.size, sourceKind: sourceKind(scanFile) })
    fileMap.set(fileId, { scanFile, file })
    return file
  })
  const state: SnapshotState = { invalid: false, cache: new Map(), cacheBytes: 0, fileMap }
  const assertCurrent = async (signal?: AbortSignal): Promise<void> => {
    checkAbort(signal)
    if (state.invalid) fail('stale-snapshot')
    let current = false
    try { current = await isProjectSnapshotCurrent(captured) } catch { current = false }
    checkAbort(signal)
    if (!current) { state.invalid = true; state.cache.clear(); state.cacheBytes = 0; fail('stale-snapshot') }
  }
  const result: WorkflowProjectSnapshot = {
    projectId: options.projectId,
    snapshotId,
    policyVersion,
    files: freezeDeep(files),
    summary: freezeDeep({ name: scan.name, totalFiles: scan.totalFiles, contentFileCount: files.length, truncated: Boolean(scan.truncation) }),
    assertCurrent,
    async readFile(fileId: string, signal?: AbortSignal) {
      if (typeof fileId !== 'string' || !fileMap.has(fileId)) fail('permission-denied')
      await assertCurrent(signal)
      const cached = state.cache.get(fileId)
      if (cached) { await assertCurrent(signal); return freezeDeep({ read: cached, consumedBytes: 0, cacheHit: true }) }
      const entry = fileMap.get(fileId)!
      let raw: string
      try { checkAbort(signal); raw = await reader(scan, entry.scanFile); checkAbort(signal) }
      catch (error) { if (error instanceof WorkflowError) throw error; if (signal?.aborted) fail('cancelled'); fail('unreadable') }
      await assertCurrent(signal)
      const redaction = redactSensitiveContent(raw)
      const content = redaction.content
      const beforeLines = (raw.match(/\n/g) ?? []).length
      const afterLines = (content.match(/\n/g) ?? []).length
      let analysis = null
      try { analysis = analyzer(entry.scanFile.relPath, content) } catch { analysis = null }
      if (analysis && !analysis.parseable) analysis = null
      const read = freezeDeep({ snapshotId, fileId, relPath: entry.file.relPath, sourceKind: entry.file.sourceKind, text: content,
        contentHash: digest(content), readBytes: entry.scanFile.size, lineMapping: beforeLines === afterLines ? 'preserved' as const : 'unknown' as const,
        redactionVersion, parserVersion, analysis, indexStatus: analysis ? 'available' as const : 'unavailable' as const })
      checkAbort(signal)
      if (state.cacheBytes + Buffer.byteLength(content, 'utf8') <= maxCacheBytes) { state.cache.set(fileId, read); state.cacheBytes += Buffer.byteLength(content, 'utf8') }
      ownedReads.set(read, state)
      return freezeDeep({ read, consumedBytes: read.readBytes, cacheHit: false })
    },
    ownsRead(value: unknown): value is ApprovedProjectRead {
      return !!value && typeof value === 'object' && ownedReads.get(value as object) === state && !state.invalid
    }
  }
  return freezeDeep(result)
}
