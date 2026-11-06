import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { WorkflowError, type ApprovedProjectRead, type WorkflowFile, type WorkflowProjectSnapshot } from './project-contract.ts'

function fixture(text = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta') {
  const issued = new WeakSet<object>()
  const file: WorkflowFile = Object.freeze({ fileId: 'file-a', relPath: 'src/a.ts', byteLength: Buffer.byteLength(text), sourceKind: 'code' })
  let stale = false
  const snapshot: WorkflowProjectSnapshot = {
    projectId: 'project-test', snapshotId: 'snapshot-test', policyVersion: 'policy-test', files: Object.freeze([file]),
    summary: Object.freeze({ name: 'fixture', totalFiles: 1, contentFileCount: 1, truncated: false }),
    async assertCurrent() { if (stale) throw new WorkflowError('stale-snapshot') },
    async readFile() { throw new WorkflowError('unreadable') },
    ownsRead(value): value is ApprovedProjectRead { return typeof value === 'object' && value !== null && issued.has(value) }
  }
  function read(overrides: Partial<ApprovedProjectRead> = {}, fileOverride = file): ApprovedProjectRead {
    const payload = { snapshotId: snapshot.snapshotId, fileId: fileOverride.fileId, relPath: fileOverride.relPath, sourceKind: fileOverride.sourceKind, text, contentHash: createHash('sha256').update(text).digest('hex'), readBytes: Buffer.byteLength(text), lineMapping: 'preserved' as const, redactionVersion: 'redact-v1', parserVersion: 'parser-v1', analysis: null, indexStatus: 'unavailable' as const, ...overrides }
    const value = Object.freeze(payload)
    issued.add(value)
    return value
  }
  return { snapshot, read, setStale(value: boolean) { stale = value }, addFile(value: WorkflowFile) { Object.assign(snapshot, { files: Object.freeze([...snapshot.files, value]) }) } }
}

test('issues immutable evidence and deduplicates overlap without changing prior IDs', async () => {
  const f = fixture()
  const store = createEvidenceStore(f.snapshot)
  const read = f.read()
  const first = await store.issue(read, { startLine: 1, endLine: 5 })
  const second = await store.issue(read, { startLine: 4, endLine: 8 })
  assert.deepEqual(first.map(record => record.displayRange), [{ startLine: 1, endLine: 5 }])
  assert.deepEqual(second.map(record => record.displayRange), [{ startLine: 1, endLine: 5 }, { startLine: 6, endLine: 8 }])
  assert.equal(second[0].id, first[0].id)
  assert.ok(Object.isFrozen(first[0]) && Object.isFrozen(first[0].displayRange))
  assert.deepEqual(store.metadata(), { records: 2, bytes: Buffer.byteLength('alpha\nbeta\ngamma\ndelta\nepsilon') + Buffer.byteLength('zeta\neta\ntheta'), ids: [first[0].id, second[1].id] })
})

test('rejects copied capabilities and changed content hash', async () => {
  const f = fixture()
  const store = createEvidenceStore(f.snapshot)
  const read = f.read()
  await assert.rejects(store.issue({ ...read }, { startLine: 1, endLine: 1 }), { code: 'permission-denied' })
  await assert.rejects(store.issue(f.read({ contentHash: '0'.repeat(64) }), { startLine: 1, endLine: 1 }), { code: 'permission-denied' })
  assert.equal(store.metadata().records, 0)
})

test('rejects conflicting approved content for a file after its evidence version is pinned', async () => {
  const f = fixture()
  const store = createEvidenceStore(f.snapshot)
  await store.issue(f.read(), { startLine: 1, endLine: 2 })
  const changedText = 'replacement content'
  const changedHash = createHash('sha256').update(changedText).digest('hex')
  await assert.rejects(store.issue(f.read({ text: changedText, contentHash: changedHash }), { startLine: 3, endLine: 4 }), { code: 'permission-denied' })
  assert.equal(store.metadata().records, 1)
})

test('rejects stale snapshots and invalid file whitelist entries', async () => {
  const f = fixture()
  const store = createEvidenceStore(f.snapshot)
  f.setStale(true)
  await assert.rejects(store.issue(f.read(), { startLine: 1, endLine: 1 }), { code: 'stale-snapshot' })
  f.setStale(false)
  await assert.rejects(store.issue(f.read({ relPath: '../outside.ts' }), { startLine: 1, endLine: 1 }), { code: 'permission-denied' })
})

test('keeps equal text from distinct files separate and original locations unknown after redaction', async () => {
  const f = fixture('same\ntext')
  const secondFile: WorkflowFile = Object.freeze({ fileId: 'file-b', relPath: 'docs/b.md', byteLength: 9, sourceKind: 'documentation' })
  f.addFile(secondFile)
  const store = createEvidenceStore(f.snapshot)
  const first = await store.issue(f.read({ lineMapping: 'unknown' }), { startLine: 1, endLine: 2 })
  const second = await store.issue(f.read({}, secondFile), { startLine: 1, endLine: 2 })
  assert.notEqual(first[0].id, second[0].id)
  assert.equal(first[0].originalRange, null)
  assert.equal(second[0].sourceKind, 'documentation')
})

test('capacity failure leaves no partial records and resolve is all-or-nothing', async () => {
  const f = fixture()
  const store = createEvidenceStore(f.snapshot, { maxBytes: 4, maxRecords: 1 })
  await assert.rejects(store.issue(f.read(), { startLine: 1, endLine: 2 }), { code: 'capacity-exhausted' })
  assert.equal(store.metadata().records, 0)
  const ok = createEvidenceStore(f.snapshot)
  const [record] = await ok.issue(f.read(), { startLine: 1, endLine: 1 })
  await assert.rejects(ok.resolve([record.id, 'ev_missing'], f.snapshot.snapshotId), { code: 'unknown-evidence' })
  await assert.rejects(ok.resolve(Array(4097).fill(record.id), f.snapshot.snapshotId), { code: 'unknown-evidence' })
  assert.deepEqual(await ok.resolve([record.id, record.id], f.snapshot.snapshotId), [record])
})

test('validates bounded options, ranges and pre-commit cancellation', async () => {
  const f = fixture()
  assert.throws(() => createEvidenceStore(f.snapshot, { maxBytes: Infinity }), { code: 'invalid-argument' })
  assert.throws(() => createEvidenceStore(f.snapshot, { maxRecords: 4097 }), { code: 'invalid-argument' })
  const store = createEvidenceStore(f.snapshot)
  await assert.rejects(store.issue(f.read(), { startLine: 0, endLine: 1 }), { code: 'invalid-argument' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(store.issue(f.read(), { startLine: 1, endLine: 1 }, controller.signal), { code: 'cancelled' })
  assert.equal(store.metadata().records, 0)
})
