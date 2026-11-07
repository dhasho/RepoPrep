import { createHash, randomUUID } from 'node:crypto'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import type { ApprovedProjectRead, EvidenceRecord, LineRange, WorkflowEvidenceStore, WorkflowProjectSnapshot } from './project-contract.ts'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { WorkflowError } from './project-contract.ts'

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_RECORDS = 1024
const MAX_ALLOWED_BYTES = 8 * 1024 * 1024
const MAX_ALLOWED_RECORDS = 4096

function fail(code: ConstructorParameters<typeof WorkflowError>[0]): never { throw new WorkflowError(code) }
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) fail('cancelled') }
function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function validRange(range: LineRange, lineCount: number): boolean {
  return typeof range === 'object' && range !== null && hasExactKeys(range, ['startLine', 'endLine']) && Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && range.startLine >= 1 && range.endLine >= range.startLine && range.endLine <= lineCount
}
function freezeRange(range: LineRange): LineRange { return Object.freeze({ startLine: range.startLine, endLine: range.endLine }) }

export function createEvidenceStore(snapshot: WorkflowProjectSnapshot, options?: { maxBytes?: number; maxRecords?: number }): WorkflowEvidenceStore {
  if (options !== undefined && (typeof options !== 'object' || options === null || !hasExactKeys(options, Object.keys(options).filter(key => key === 'maxBytes' || key === 'maxRecords')))) fail('invalid-argument')
  if (options !== undefined && Object.keys(options).some(key => key !== 'maxBytes' && key !== 'maxRecords')) fail('invalid-argument')
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ALLOWED_BYTES || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_ALLOWED_RECORDS) fail('invalid-argument')
  const records: EvidenceRecord[] = []
  const sourceVersions = new Map<string, { contentHash: string; transformationVersion: string }>()
  let bytes = 0

  const store: WorkflowEvidenceStore = {
    async issue(read: ApprovedProjectRead, range: LineRange, signal?: AbortSignal): Promise<readonly EvidenceRecord[]> {
      try {
        checkSignal(signal)
        await snapshot.assertCurrent(signal)
        checkSignal(signal)
        if (!snapshot.ownsRead(read) || read.snapshotId !== snapshot.snapshotId) fail('permission-denied')
        const file = snapshot.files.find(item => item.fileId === read.fileId)
        if (!file || file.relPath !== read.relPath || file.sourceKind !== read.sourceKind || typeof read.text !== 'string' || !/^[0-9a-f]{64}$/.test(read.contentHash) || typeof read.redactionVersion !== 'string' || !read.redactionVersion || sha256(read.text) !== read.contentHash) fail('permission-denied')
        const priorVersion = sourceVersions.get(read.fileId)
        if (priorVersion && (priorVersion.contentHash !== read.contentHash || priorVersion.transformationVersion !== read.redactionVersion)) fail('permission-denied')
        const lines = read.text.split(/\r\n|\n|\r/)
        if (!validRange(range, lines.length)) fail('invalid-argument')

        const relevant = records.filter(record => record.fileId === read.fileId && record.displayRange.startLine <= range.endLine && record.displayRange.endLine >= range.startLine)
        const spans: LineRange[] = []
        let cursor = range.startLine
        for (const existing of relevant.slice().sort((a, b) => a.displayRange.startLine - b.displayRange.startLine)) {
          if (existing.displayRange.startLine > cursor) spans.push({ startLine: cursor, endLine: existing.displayRange.startLine - 1 })
          cursor = Math.max(cursor, existing.displayRange.endLine + 1)
          if (cursor > range.endLine) break
        }
        if (cursor <= range.endLine) spans.push({ startLine: cursor, endLine: range.endLine })
        const additions = spans.map(span => {
          const text = lines.slice(span.startLine - 1, span.endLine).join('\n')
          return { span, text }
        })
        const addedBytes = additions.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0)
        if (records.length + additions.length > maxRecords || bytes + addedBytes > maxBytes) fail('capacity-exhausted')
        checkSignal(signal)

        const created = additions.map(({ span, text }): EvidenceRecord => Object.freeze({
          id: `ev_${randomUUID()}`,
          snapshotId: snapshot.snapshotId,
          fileId: read.fileId,
          relPath: read.relPath,
          originalRange: read.lineMapping === 'preserved' ? freezeRange(span) : null,
          displayRange: freezeRange(span),
          contentHash: sha256(text),
          text,
          sourceKind: read.sourceKind,
          readStatus: 'complete',
          parseStatus: read.indexStatus === 'available' ? 'parsed' : 'unavailable',
          omission: 'none',
          transformationVersion: read.redactionVersion,
          ...(read.redactionSummary ? {
            redactionSummary: Object.freeze({
              totalMatches: read.redactionSummary.totalMatches,
              matchesByCategory: Object.freeze({ ...read.redactionSummary.matchesByCategory })
            })
          } : {})
        }))
        records.push(...created)
        bytes += addedBytes
        if (!priorVersion) sourceVersions.set(read.fileId, { contentHash: read.contentHash, transformationVersion: read.redactionVersion })
        return Object.freeze([...relevant, ...created].sort((a, b) => a.displayRange.startLine - b.displayRange.startLine || a.id.localeCompare(b.id)))
      } catch (error) {
        if (error instanceof WorkflowError) throw error
        if (signal?.aborted) fail('cancelled')
        fail('unreadable')
      }
    },
    async resolve(ids: readonly string[], snapshotId: string, signal?: AbortSignal): Promise<readonly EvidenceRecord[]> {
      try {
        checkSignal(signal)
        await snapshot.assertCurrent(signal)
        checkSignal(signal)
        if (snapshotId !== snapshot.snapshotId || !Array.isArray(ids) || ids.length > MAX_ALLOWED_RECORDS || ids.some(id => typeof id !== 'string' || id.length > 39 || !/^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) fail('unknown-evidence')
        const uniqueIds = [...new Set(ids)]
        const found = uniqueIds.map(id => records.find(record => record.id === id))
        if (found.some(record => !record || record.snapshotId !== snapshotId)) fail('unknown-evidence')
        checkSignal(signal)
        return Object.freeze(found as EvidenceRecord[])
      } catch (error) {
        if (error instanceof WorkflowError) throw error
        if (signal?.aborted) fail('cancelled')
        fail('stale-snapshot')
      }
    },
    metadata() { return Object.freeze({ records: records.length, bytes, ids: Object.freeze(records.map(record => record.id)) }) }
  }
  return Object.freeze(store)
}
