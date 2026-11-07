import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createEvidenceStore } from '../../../electron/services/workflow/evidence-store.ts'
import { assertPackedDispatch, packEvidence } from '../../../electron/services/workflow/evidence-packer.ts'
import { WorkflowError } from '../../../electron/services/workflow/project-contract.ts'
import { createRunSpec } from '../../../electron/services/workflow/run-spec.ts'
import { normalizeBaseUrl } from '../../../electron/services/llm.ts'

const profile = { id: 'profile-m07', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }
const spec = createRunSpec({ version: 1, runId: 'run-m07', projectId: 'project-m07', snapshotId: 'snapshot-m07', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
const ids = ['complete-pack', 'exact-budget', 'over-budget-by-one', 'overlap', 'same-text-distinct-source', 'required-bundle-does-not-fit', 'unknown-id', 'stale-snapshot', 'unicode', 'document-excerpt', 'declaration-context', 'final-fit-truncation']
const buildMessages = text => [{ role: 'system', content: 'Trusted fixture preamble.' }, { role: 'user', content: `Analyze quoted evidence:\n${text}` }]
const selection = (selectedIds, requiredBundles = []) => ({ selectedIds, requiredBundles, unresolved: [] })
const hasCode = (error, code) => error instanceof WorkflowError && error.code === code

function fixture(sources) {
  const owned = new WeakSet()
  let stale = false
  const files = sources.map(({ fileId, relPath, text, sourceKind = 'code' }) => ({ fileId, relPath, text, sourceKind }))
  const snapshot = {
    projectId: spec.projectId, snapshotId: spec.snapshotId, policyVersion: 'fixture-policy',
    files: Object.freeze(files.map(({ fileId, relPath, text, sourceKind }) => Object.freeze({ fileId, relPath, byteLength: Buffer.byteLength(text), sourceKind }))),
    summary: Object.freeze({ name: 'synthetic fixture', totalFiles: files.length, contentFileCount: files.length, truncated: false }),
    async assertCurrent() { if (stale) throw new WorkflowError('stale-snapshot') },
    async readFile() { throw new WorkflowError('unreadable') },
    ownsRead(value) { return typeof value === 'object' && value !== null && owned.has(value) }
  }
  const store = createEvidenceStore(snapshot)
  return {
    store,
    stale(value) { stale = value },
    async issue(fileId, startLine = 1, endLine) {
      const source = files.find(item => item.fileId === fileId)
      const read = Object.freeze({ snapshotId: spec.snapshotId, fileId, relPath: source.relPath, sourceKind: source.sourceKind, text: source.text, contentHash: createHash('sha256').update(source.text).digest('hex'), readBytes: Buffer.byteLength(source.text), lineMapping: 'preserved', redactionVersion: 'fixture-redaction-v1', parserVersion: 'fixture-parser-v1', analysis: null, indexStatus: 'unavailable' })
      owned.add(read)
      return store.issue(read, { startLine, endLine: endLine ?? source.text.split(/\r\n|\n|\r/).length })
    }
  }
}

async function pack(store, selectedIds, options = {}) {
  return packEvidence({ spec, store, selection: selection(selectedIds, options.requiredBundles), buildMessages, ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }), ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }) })
}

export function createChecks() {
  const checks = new Map()
  checks.set('m07:complete-pack', async ctx => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'const answer = 42' }]); const evidence = await f.issue('a')
    const one = await pack(f.store, [evidence[0].id]); const two = await pack(f.store, [evidence[0].id])
    assert.equal(one.status, 'packed'); assert.equal(two.status, 'packed'); assert.equal(one.context.manifest.requestHash, two.context.manifest.requestHash); assert.equal(one.context.manifest.manifestHash, two.context.manifest.manifestHash)
    assert.doesNotThrow(() => assertPackedDispatch(one.context, one.context.messages))
    ctx.recordMetric('deterministicReplay', one.context.manifest.manifestHash === two.context.manifest.manifestHash, 'assertion:m07:stable-replay-hashes')
    ctx.recordMetric('dispatchManifestMatched', true, 'assertion:m07:frozen-messages-match-manifest')
    return { packed: one.context.manifest.packedIds.length, requestHash: one.context.manifest.requestHash }
  })
  checks.set('m07:exact-budget', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'one two three' }]); const evidence = await f.issue('a'); const first = await pack(f.store, [evidence[0].id])
    assert.equal(first.status, 'packed')
    const exact = await pack(f.store, [evidence[0].id], { requiredBundles: [{ id: 'exact', evidenceIds: [evidence[0].id] }], maxChars: first.context.manifest.serializedChars, maxInputTokens: first.context.manifest.estimatedInputTokens })
    assert.equal(exact.status, 'packed')
    return { serializedChars: exact.context.manifest.serializedChars, estimatedInputTokens: exact.context.manifest.estimatedInputTokens }
  })
  checks.set('m07:over-budget-by-one', async ctx => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'one two three' }]); const evidence = await f.issue('a'); const first = await pack(f.store, [evidence[0].id])
    assert.equal(first.status, 'packed')
    const result = await pack(f.store, [evidence[0].id], { requiredBundles: [{ id: 'exact', evidenceIds: [evidence[0].id] }], maxChars: first.context.manifest.serializedChars - 1, maxInputTokens: first.context.manifest.estimatedInputTokens })
    assert.equal(result.status, 'conflict'); assert.deepEqual(result.omittedIds, [evidence[0].id]); assert.ok(result.serializedChars > result.maxChars)
    ctx.recordMetric('budgetViolations', 0, 'assertion:m07:one-over-character-rejected-without-clipping')
    return { conflict: result.reason, overflowChars: result.serializedChars - result.maxChars }
  })
  checks.set('m07:overlap', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'one\ntwo\nthree\nfour' }]); const a = await f.issue('a', 1, 3); const b = await f.issue('a', 3, 4)
    const result = await pack(f.store, [a[0].id, b[1].id]); assert.equal(result.status, 'packed'); assert.equal(result.context.manifest.sources.length, 1); assert.equal(result.context.manifest.sources[0].displayRange.endLine, 4)
    return { overlapMerged: true, supportingIds: result.context.manifest.sources[0].ids.length }
  })
  checks.set('m07:same-text-distinct-source', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'same text' }, { fileId: 'b', relPath: 'docs/b.md', text: 'same text', sourceKind: 'documentation' }]); const a = await f.issue('a'); const b = await f.issue('b')
    const result = await pack(f.store, [a[0].id, b[0].id]); assert.equal(result.status, 'packed'); assert.equal(result.context.manifest.sources.length, 2); assert.notEqual(result.context.manifest.sources[0].fileId, result.context.manifest.sources[1].fileId)
    return { distinctFilesPreserved: result.context.manifest.sources.length }
  })
  checks.set('m07:required-bundle-does-not-fit', async ctx => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'declaration\nfull body' }]); const evidence = await f.issue('a')
    const result = await pack(f.store, evidence.map(row => row.id), { requiredBundles: [{ id: 'declaration-body', evidenceIds: evidence.map(row => row.id) }], maxChars: 128 })
    assert.equal(result.status, 'conflict'); assert.equal(result.reason, 'required-bundle-too-large'); assert.deepEqual(result.omittedIds, evidence.map(row => row.id))
    ctx.recordMetric('silentRequiredBundleDrops', 0, 'assertion:m07:required-bundle-conflict-retains-every-member-id')
    return { conflict: result.reason, members: result.omittedIds.length }
  })
  checks.set('m07:unknown-id', async ctx => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'ordinary source' }]); const issued = await f.issue('a')
    await assert.rejects(pack(f.store, ['ev_00000000-0000-4000-8000-000000000000']), error => hasCode(error, 'unknown-evidence'))
    const fabricated = { ...issued[0], text: 'fabricated source text' }
    const forgedStore = { ...f.store, async resolve() { return [fabricated] } }
    await assert.rejects(pack(forgedStore, [issued[0].id]), error => hasCode(error, 'invalid-argument'))
    ctx.recordMetric('fabricatedSourceAccepted', 0, 'assertion:m07:unknown-id-and-fabricated-hash-rejected')
    return { unknownIdRejected: true, fabricatedRecordRejected: true }
  })
  checks.set('m07:stale-snapshot', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'ordinary source' }]); const evidence = await f.issue('a'); f.stale(true)
    await assert.rejects(pack(f.store, [evidence[0].id]), error => hasCode(error, 'stale-snapshot'))
    return { staleEvidenceRejected: true }
  })
  checks.set('m07:unicode', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'docs/unicode.md', text: '😀 标题\n第二行', sourceKind: 'documentation' }]); const evidence = await f.issue('a')
    const result = await pack(f.store, [evidence[0].id]); assert.equal(result.status, 'packed'); assert.match(result.context.text, /😀 标题/); assert.match(result.context.text, /第二行/)
    return { codePointsPreserved: true, serializedChars: result.context.manifest.serializedChars }
  })
  checks.set('m07:document-excerpt', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'docs/guide.md', text: '# Guide\nSelected paragraph\nUnselected appendix', sourceKind: 'documentation' }]); const evidence = await f.issue('a', 2, 2)
    const result = await pack(f.store, [evidence[0].id]); assert.equal(result.status, 'packed'); assert.deepEqual(result.context.manifest.sources[0].displayRange, { startLine: 2, endLine: 2 }); assert.ok(!result.context.text.includes('Unselected appendix'))
    return { exactExcerpt: result.context.manifest.sources[0].displayRange }
  })
  checks.set('m07:declaration-context', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'src/worker.ts', text: 'export function run() {\n  return 42\n}' }]); const declaration = await f.issue('a', 1, 1); const body = await f.issue('a', 2, 3)
    const result = await pack(f.store, [declaration[0].id, body[0].id], { requiredBundles: [{ id: 'complete-declaration', evidenceIds: [declaration[0].id, body[0].id] }] })
    assert.equal(result.status, 'packed'); assert.deepEqual(new Set(result.context.manifest.packedIds), new Set([declaration[0].id, body[0].id]))
    return { declarationAndBodyPacked: true }
  })
  checks.set('m07:final-fit-truncation', async () => {
    const f = fixture([{ fileId: 'a', relPath: 'src/a.ts', text: 'small' }, { fileId: 'b', relPath: 'src/b.ts', text: 'large '.repeat(200) }]); const a = await f.issue('a'); const b = await f.issue('b')
    const result = await pack(f.store, [a[0].id, b[0].id], { maxChars: 900 }); assert.equal(result.status, 'packed'); assert.ok(result.context.manifest.packedIds.includes(a[0].id)); assert.ok(result.context.manifest.omitted.some(item => item.id === b[0].id)); assert.ok(result.context.manifest.serializedChars <= 900)
    return { keptPriorityEvidence: true, omitted: result.context.manifest.omitted.length, finalSerializedChars: result.context.manifest.serializedChars }
  })
  return checks
}

export const checks = createChecks()
const metadata = JSON.parse(await readFile(new URL('../fixtures/m07.json', import.meta.url), 'utf8'))
assert.equal(metadata.version, 1)
assert.deepEqual([...createChecks().keys()], metadata.requiredCheckIds)
