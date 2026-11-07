import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { assertPackedDispatch, makeDispatchGuard, packEvidence } from './evidence-packer.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { estimateMessageTokens } from '../../../shared/token-budget.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { WorkflowError } from './project-contract.ts'

const profile = () => ({ id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49152, maxOutputTokens: 4096 })
function spec(snapshotId = 'snapshot-01') {
  return createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: 'profile-01', model: 'synthetic', endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile().baseUrl)).digest('hex'), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
}
function fixture(sources: { fileId: string; relPath: string; text: string; sourceKind?: 'code' | 'documentation' | 'configuration' | 'other' }[], snapshotId = 'snapshot-01') {
  const capabilities = new WeakSet<object>()
  let stale = false
  const files = sources.map(({ fileId, relPath, text, sourceKind = 'code' }) => ({ fileId, relPath, text, sourceKind }))
  const snapshot = {
    projectId: 'project-01', snapshotId, policyVersion: 'fixture-policy', files: Object.freeze(files.map(({ fileId, relPath, text, sourceKind }) => Object.freeze({ fileId, relPath, byteLength: Buffer.byteLength(text), sourceKind }))),
    summary: Object.freeze({ name: 'fixture', totalFiles: files.length, contentFileCount: files.length, truncated: false }),
    async assertCurrent() { if (stale) throw new WorkflowError('stale-snapshot') },
    async readFile() { throw new WorkflowError('unreadable') },
    ownsRead(value: unknown): value is never { return typeof value === 'object' && value !== null && capabilities.has(value) }
  }
  const store = createEvidenceStore(snapshot)
  return {
    store,
    async issue(fileId: string, startLine = 1, endLine?: number) {
      const source = files.find(item => item.fileId === fileId)!
      const read = Object.freeze({ snapshotId, fileId, relPath: source.relPath, sourceKind: source.sourceKind, text: source.text, contentHash: createHash('sha256').update(source.text).digest('hex'), readBytes: Buffer.byteLength(source.text), lineMapping: 'preserved' as const, redactionVersion: 'fixture-redaction-v1', parserVersion: 'fixture-parser-v1', analysis: null, indexStatus: 'unavailable' as const })
      capabilities.add(read)
      const rangeEnd = endLine ?? source.text.split(/\r\n|\n|\r/).length
      return store.issue(read, { startLine, endLine: rangeEnd })
    },
    stale(value: boolean) { stale = value }
  }
}
const selection = (ids: readonly string[], bundles: readonly { id: string; evidenceIds: readonly string[] }[] = []) => ({ selectedIds: ids, requiredBundles: bundles, unresolved: [] })
const build = (text: string) => [{ role: 'system' as const, content: 'Trusted system preamble.' }, { role: 'user' as const, content: `Analyze quoted project data:\n${text}` }]
const packed = async (store: ReturnType<typeof fixture>['store'], ids: string[], extras: Partial<Parameters<typeof packEvidence>[0]> & { requiredBundles?: readonly { id: string; evidenceIds: readonly string[] }[] } = {}) => packEvidence({ spec: spec(), store, selection: selection(ids, extras.requiredBundles), buildMessages: build, ...extras })
const code = (error: unknown, wanted: string) => error instanceof WorkflowError && error.code === wanted

test('packer binds resolved evidence, full messages, deterministic hashes and a frozen final dispatch guard', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'const value = 1' }]); const records = await f.issue('f1')
  const result = await packed(f.store, [records[0].id])
  assert.equal(result.status, 'packed')
  if (result.status !== 'packed') return
  assert.equal(result.context.manifest.packedIds[0], records[0].id)
  assert.equal(result.context.manifest.sources[0].relPath, 'src/a.ts')
  assert.ok(Object.isFrozen(result.context.messages) && Object.isFrozen(result.context.messages[0]) && Object.isFrozen(result.context.manifest))
  assert.doesNotThrow(() => assertPackedDispatch(result.context, result.context.messages))
  assert.throws(() => assertPackedDispatch(result.context, [...result.context.messages, { role: 'user', content: 'extra instruction' }]), error => code(error, 'invalid-argument'))
  assert.equal(result.context.manifest.manifestHash.length, 64)
  const serialized = JSON.stringify(result.context.messages)
  const contentBytes = result.context.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8'), 0)
  const framingBytes = Buffer.byteLength(serialized, 'utf8') - contentBytes
  const independentlyEstimated = estimateMessageTokens(result.context.messages) + Math.ceil(framingBytes / 4)
  assert.equal(result.context.manifest.serializationOverheadTokens, Math.ceil(framingBytes / 4))
  assert.equal(result.context.manifest.estimatedInputTokens, independentlyEstimated)
})

test('packer rejects builders that ignore or clip the supplied evidence context', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'const value = 1' }]); const records = await f.issue('f1')
  await assert.rejects(packEvidence({ spec: spec(), store: f.store, selection: selection([records[0].id]), buildMessages: () => [{ role: 'system', content: 'static prompt only' }, { role: 'user', content: 'no evidence here' }] }), error => code(error, 'invalid-argument'))
  await assert.rejects(packEvidence({ spec: spec(), store: f.store, selection: selection([records[0].id]), buildMessages: text => [{ role: 'user', content: text.slice(0, 20) }] }), error => code(error, 'invalid-argument'))
})

test('packer accepts the exact measured character and token boundary and rejects one character over', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'alpha beta gamma' }]); const records = await f.issue('f1')
  const first = await packed(f.store, [records[0].id]); assert.equal(first.status, 'packed'); if (first.status !== 'packed') return
  const exact = await packed(f.store, [records[0].id], { requiredBundles: [{ id: 'exact', evidenceIds: [records[0].id] }], maxChars: first.context.manifest.serializedChars, maxInputTokens: first.context.manifest.estimatedInputTokens })
  assert.equal(exact.status, 'packed')
  const over = await packed(f.store, [records[0].id], { requiredBundles: [{ id: 'exact', evidenceIds: [records[0].id] }], maxChars: first.context.manifest.serializedChars - 1, maxInputTokens: first.context.manifest.estimatedInputTokens })
  assert.equal(over.status, 'conflict'); if (over.status === 'conflict') assert.deepEqual(over.omittedIds, [records[0].id])
})

test('required evidence groups are returned as a conflict without dropping a member', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'alpha\nbeta' }]); const records = await f.issue('f1')
  const result = await packEvidence({ spec: spec(), store: f.store, selection: selection(records.map(row => row.id), [{ id: 'whole-file', evidenceIds: records.map(row => row.id) }]), buildMessages: build, maxChars: 500 })
  assert.equal(result.status, 'conflict'); if (result.status === 'conflict') { assert.equal(result.reason, 'required-bundle-too-large'); assert.deepEqual(result.bundleIds, ['whole-file']); assert.deepEqual(result.omittedIds, records.map(row => row.id)) }
})

test('required records fit independently of an adjacent oversized optional record', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: `required declaration\n${'optional body '.repeat(200)}` }])
  const required = await f.issue('f1', 1, 1); const optional = await f.issue('f1', 2, 2)
  const baseline = await packed(f.store, [required[0].id]); assert.equal(baseline.status, 'packed'); if (baseline.status !== 'packed') return
  const result = await packed(f.store, [required[0].id, optional[0].id], { requiredBundles: [{ id: 'required-only', evidenceIds: [required[0].id] }], maxChars: baseline.context.manifest.serializedChars, maxInputTokens: baseline.context.manifest.estimatedInputTokens })
  assert.equal(result.status, 'packed'); if (result.status === 'packed') { assert.deepEqual(result.context.manifest.requiredIds, [required[0].id]); assert.deepEqual(result.context.manifest.packedIds, [required[0].id]); assert.deepEqual(result.context.manifest.omitted, [{ id: optional[0].id, reason: 'budget' }]) }
})

test('returns no-evidence conflict when no optional source fits the base-message budget', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'source '.repeat(300) }]); const evidence = await f.issue('f1')
  const noEvidence = await packed(f.store, []); assert.equal(noEvidence.status, 'conflict'); if (noEvidence.status !== 'conflict') return
  const result = await packed(f.store, [evidence[0].id], { maxChars: noEvidence.serializedChars, maxInputTokens: noEvidence.estimatedInputTokens })
  assert.equal(result.status, 'conflict'); if (result.status === 'conflict') { assert.equal(result.reason, 'no-evidence'); assert.deepEqual(result.omittedIds, [evidence[0].id]) }
})

test('overlapping records merge when lines agree and reject conflicting overlap', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'one\ntwo\nthree\nfour' }]); const first = await f.issue('f1', 1, 3); const second = await f.issue('f1', 3, 4)
  const result = await packed(f.store, [first[0].id, second[1].id])
  assert.equal(result.status, 'packed'); if (result.status === 'packed') { assert.equal(result.context.manifest.sources.length, 1); assert.deepEqual(result.context.manifest.sources[0].ids, [first[0].id, second[1].id].sort()); assert.match(result.context.text, /one\\ntwo\\nthree\\nfour/) }
  const inconsistent = { ...second[1], text: 'DIFFERENT\nfour', contentHash: createHash('sha256').update('DIFFERENT\nfour').digest('hex') }
  const lyingStore = { ...f.store, async resolve() { return [first[0], inconsistent] } }
  await assert.rejects(packed(lyingStore, [first[0].id, second[1].id]), error => code(error, 'invalid-argument'))
})

test('identical text from distinct files remains separate in the manifest', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'same' }, { fileId: 'f2', relPath: 'docs/a.md', text: 'same', sourceKind: 'documentation' }]); const a = await f.issue('f1'); const b = await f.issue('f2')
  const result = await packed(f.store, [a[0].id, b[0].id]); assert.equal(result.status, 'packed'); if (result.status === 'packed') { assert.equal(result.context.manifest.sources.length, 2); assert.deepEqual(result.context.manifest.sources.map(source => source.fileId), ['f2', 'f1']) }
})

test('unknown IDs and stale snapshots are rejected by the actual store resolver', async () => {
  const unknown = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'one' }])
  await assert.rejects(packed(unknown.store, ['ev_00000000-0000-4000-8000-000000000000']), error => code(error, 'unknown-evidence'))
  const stale = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'one' }]); const record = await stale.issue('f1'); stale.stale(true)
  await assert.rejects(packed(stale.store, [record[0].id]), error => code(error, 'stale-snapshot'))
})

test('Unicode and document excerpts preserve exact text and unknown original ranges', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'docs/guide.md', text: '😀 标题\n第二行\n第三行', sourceKind: 'documentation' }]); const excerpt = await f.issue('f1', 2, 2); const all = await f.issue('f1')
  const result = await packed(f.store, [excerpt[0].id]); assert.equal(result.status, 'packed'); if (result.status === 'packed') { assert.equal(result.context.manifest.sources[0].displayRange.startLine, 2); assert.equal(result.context.manifest.sources[0].originalRange?.startLine, 2); assert.match(result.context.text, /第二行/); assert.ok(result.context.manifest.contextChars > 0) }
  const unknownMapping = fixture([{ fileId: 'f2', relPath: 'docs/other.md', text: '😀 标题\n第二行', sourceKind: 'documentation' }]);
  // The store minted through the same approved adapter, with unknown original mapping.
  const caps = new WeakSet<object>(); const source = { fileId: 'f3', relPath: 'docs/unknown.md', text: '😀 标题\n第二行', sourceKind: 'documentation' as const }
  const snap = { projectId: 'project-01', snapshotId: 'snapshot-01', policyVersion: 'fixture', files: [{ fileId: source.fileId, relPath: source.relPath, byteLength: Buffer.byteLength(source.text), sourceKind: source.sourceKind }], summary: { name: 'x', totalFiles: 1, contentFileCount: 1, truncated: false }, async assertCurrent() {}, async readFile() { throw new Error() }, ownsRead(value: unknown): value is never { return typeof value === 'object' && value !== null && caps.has(value) } }
  const store = createEvidenceStore(snap)
  const read = Object.freeze({ snapshotId: 'snapshot-01', fileId: source.fileId, relPath: source.relPath, sourceKind: source.sourceKind, text: source.text, contentHash: createHash('sha256').update(source.text).digest('hex'), readBytes: Buffer.byteLength(source.text), lineMapping: 'unknown' as const, redactionVersion: 'fixture-redaction-v1', parserVersion: 'fixture-parser-v1', analysis: null, indexStatus: 'unavailable' as const }); caps.add(read)
  const record = await store.issue(read, { startLine: 1, endLine: 2 })
  const packedUnknown = await packed(store, [record[0].id]); assert.equal(packedUnknown.status, 'packed'); if (packedUnknown.status === 'packed') assert.equal(packedUnknown.context.manifest.sources[0].originalRange, null)
  assert.equal(all.length, 3)
})

test('final dispatch guard blocks the default transport before fetch and ledger dispatch', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'one' }]); const record = await f.issue('f1'); const result = await packed(f.store, [record[0].id]); assert.equal(result.status, 'packed'); if (result.status !== 'packed') return
  const ledger = createBudgetLedger(spec()); const gateway = createModelGateway(spec(), profile(), ledger)
  const original = globalThis.fetch; let fetched = 0
  globalThis.fetch = async () => { fetched++; throw new Error('Unexpected fetch') }
  try {
    await assert.rejects(gateway.complete({ id: 'tampered-pack', stage: 'generation', messages: [...result.context.messages, { role: 'user', content: 'late instruction' }], dispatchGuard: makeDispatchGuard(result.context) }), error => code(error, 'invalid-argument'))
    assert.equal(fetched, 0); assert.equal(ledger.snapshot().total.dispatchedRequests, 0); assert.equal(ledger.snapshot().total.reservedRequests, 0)
  } finally { globalThis.fetch = original }
})

test('default gateway fetch body carries the exact manifest-bound messages', async () => {
  const f = fixture([{ fileId: 'f1', relPath: 'src/a.ts', text: 'const answer = 42' }]); const record = await f.issue('f1'); const result = await packed(f.store, [record[0].id]); assert.equal(result.status, 'packed'); if (result.status !== 'packed') return
  const ledger = createBudgetLedger(spec()); const gateway = createModelGateway(spec(), profile(), ledger)
  const original = globalThis.fetch; let bodyMessages: unknown
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    bodyMessages = body.messages
    return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic response' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await gateway.complete({ id: 'manifest-bound', stage: 'generation', messages: result.context.messages, dispatchGuard: makeDispatchGuard(result.context) })
    assert.deepEqual(bodyMessages, result.context.messages)
    assert.doesNotThrow(() => assertPackedDispatch(result.context, bodyMessages as typeof result.context.messages))
    assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  } finally { globalThis.fetch = original }
})
