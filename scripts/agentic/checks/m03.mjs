import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createEvidenceStore } from '../../../electron/services/workflow/evidence-store.ts'
import { WorkflowError } from '../../../electron/services/workflow/project-contract.ts'

function fixture({ text = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight', files } = {}) {
  const capabilities = new WeakSet()
  let stale = false
  const whitelist = files ?? [{ fileId: 'f1', relPath: 'src/a.ts', byteLength: Buffer.byteLength(text), sourceKind: 'code' }]
  const snapshot = {
    projectId: 'fixture-project', snapshotId: 'fixture-snapshot', policyVersion: 'fixture-policy', files: Object.freeze(whitelist),
    summary: Object.freeze({ name: 'fixture', totalFiles: whitelist.length, contentFileCount: whitelist.length, truncated: false }),
    async assertCurrent() { if (stale) throw new WorkflowError('stale-snapshot') },
    async readFile() { throw new WorkflowError('unreadable') },
    ownsRead(value) { return typeof value === 'object' && value !== null && capabilities.has(value) }
  }
  function mint(file = whitelist[0], fields = {}) {
    const body = { snapshotId: snapshot.snapshotId, fileId: file.fileId, relPath: file.relPath, sourceKind: file.sourceKind, text, contentHash: createHash('sha256').update(text).digest('hex'), readBytes: Buffer.byteLength(text), lineMapping: 'preserved', redactionVersion: 'fixture-redaction-v1', parserVersion: 'fixture-parser-v1', analysis: null, indexStatus: 'unavailable', ...fields }
    const read = Object.freeze(body)
    capabilities.add(read)
    return read
  }
  return { snapshot, mint, stale(value) { stale = value } }
}

const rejection = async (promise, code) => assert.rejects(promise, error => error instanceof WorkflowError && error.code === code)

export function createChecks() {
  const checks = new Map()
  checks.set('m03:forged-id', async ctx => {
    const f = fixture(); const store = createEvidenceStore(f.snapshot); const read = f.mint()
    await rejection(store.issue({ ...read }, { startLine: 1, endLine: 1 }), 'permission-denied')
    await rejection(store.resolve(['ev_forged'], f.snapshot.snapshotId), 'unknown-evidence')
    assert.equal(store.metadata().records, 0)
    ctx.recordMetric('invalidEvidenceAccepted', 0, 'assertion:m03:copied-read-and-fabricated-id-rejected')
    return { copiedCapabilityRejected: true, fabricatedIdRejected: true }
  })
  checks.set('m03:stale-snapshot', async () => {
    const f = fixture(); const store = createEvidenceStore(f.snapshot); f.stale(true)
    await rejection(store.issue(f.mint(), { startLine: 1, endLine: 1 }), 'stale-snapshot')
    await rejection(store.resolve([], f.snapshot.snapshotId), 'stale-snapshot')
    assert.equal(store.metadata().records, 0)
    return { staleIssueAndResolveRejected: true }
  })
  checks.set('m03:path-escape', async () => {
    const f = fixture(); const store = createEvidenceStore(f.snapshot)
    await rejection(store.issue(f.mint(undefined, { relPath: '../outside.ts' }), { startLine: 1, endLine: 1 }), 'permission-denied')
    await rejection(store.issue(f.mint(undefined, { contentHash: '0'.repeat(64) }), { startLine: 1, endLine: 1 }), 'permission-denied')
    assert.equal(store.metadata().records, 0)
    return { pathAndHashRejected: true }
  })
  checks.set('m03:overlapping-ranges', async () => {
    const f = fixture(); const store = createEvidenceStore(f.snapshot); const read = f.mint()
    const first = await store.issue(read, { startLine: 1, endLine: 5 })
    const overlap = await store.issue(read, { startLine: 4, endLine: 8 })
    assert.equal(overlap.length, 2)
    assert.equal(overlap[0].id, first[0].id)
    assert.deepEqual(overlap.map(record => record.displayRange), [{ startLine: 1, endLine: 5 }, { startLine: 6, endLine: 8 }])
    assert.equal(store.metadata().records, 2)
    return { immutableOverlapReuse: true }
  })
  checks.set('m03:same-text-distinct-source', async () => {
    const text = 'same\ntext'
    const files = [
      { fileId: 'f1', relPath: 'src/a.ts', byteLength: 9, sourceKind: 'code' },
      { fileId: 'f2', relPath: 'docs/b.md', byteLength: 9, sourceKind: 'documentation' }
    ]
    const f = fixture({ text, files }); const store = createEvidenceStore(f.snapshot)
    const a = await store.issue(f.mint(files[0]), { startLine: 1, endLine: 2 })
    const b = await store.issue(f.mint(files[1]), { startLine: 1, endLine: 2 })
    assert.notEqual(a[0].id, b[0].id)
    assert.equal(a[0].contentHash, b[0].contentHash)
    assert.equal(store.metadata().records, 2)
    return { distinctSourcesPreserved: true }
  })
  checks.set('m03:redaction-location', async () => {
    const f = fixture(); const store = createEvidenceStore(f.snapshot)
    const evidence = await store.issue(f.mint(undefined, { lineMapping: 'unknown' }), { startLine: 2, endLine: 3 })
    assert.deepEqual(evidence[0].displayRange, { startLine: 2, endLine: 3 })
    assert.equal(evidence[0].originalRange, null)
    return { unknownOriginalLocationPreserved: true }
  })
  checks.set('m03:capacity-exhaustion', async ctx => {
    const f = fixture(); const store = createEvidenceStore(f.snapshot, { maxBytes: 3, maxRecords: 1 })
    await rejection(store.issue(f.mint(), { startLine: 1, endLine: 2 }), 'capacity-exhausted')
    assert.deepEqual(store.metadata(), { records: 0, bytes: 0, ids: [] })
    const trace = JSON.stringify(store.metadata())
    assert.equal(trace.includes('one'), false)
    ctx.recordMetric('sourcePayloadInTrace', 0, 'assertion:m03:metadata-trace-has-no-source-payload')
    return { noPartialCommit: true, metadataSourceFree: true }
  })
  return checks
}

export const checks = createChecks()

// Load and validate only this safe fixture's declaration; fixture status never determines a gate result.
const fixtureMetadata = JSON.parse(await readFile(new URL('../fixtures/m03.json', import.meta.url), 'utf8'))
assert.equal(fixtureMetadata.version, 1)
assert.deepEqual([...createChecks().keys()], fixtureMetadata.requiredCheckIds)
