import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { InterviewResult, LlmProfile, QuestionItem } from '../../../shared/types.ts'
import type { ModelTransport } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createWorkflowSnapshot } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createEvidenceGenerationAdapter } from './evidence-generation.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createFrozenEvaluationQuestionSource, createGenerationQuestionSourceRecorder, assertQuestionSourceAuthority } from './question-source.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { estimateMessageTokens } from '../../../shared/token-budget.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { fingerprintQuestion } from './question-evidence.ts'

const sourceText = 'export function syntheticValue() { return 42 }\n'
function question(index = 0): QuestionItem { return { id: `question-${index}`, title: `Topic ${index}`, question: `How does function ${index} work?`, answer: 'It returns a number.', followUps: [] } }
async function fixture(runId = 'source-run', readBytes?: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-p5-source-'))
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src/value.ts'), sourceText)
  const scan = await scanProject(root)
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'source-project' })
  const store = createEvidenceStore(snapshot)
  const file = snapshot.files.find(file => file.relPath === 'src/value.ts')!
  const { read } = await snapshot.readFile(file.fileId)
  const ids = (await store.issue(read, { startLine: 1, endLine: 1 })).map(record => record.id)
  const profile: LlmProfile = { id: 'source-profile', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-key-for-local-only', model: 'source-model', protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 4096 }
  const spec = createRunSpec({ version: 1, runId, projectId: snapshot.projectId, snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'coarse', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', ...(readBytes !== undefined ? { budget: { readBytes } } : {}) })
  const ledger = createBudgetLedger(spec)
  const controller = new AbortController()
  return { root, scan, snapshot, store, spec, ledger, profile, ids, file, signal: controller.signal, abort: () => controller.abort(), cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function result(f: Fixture, questions: QuestionItem[]): InterviewResult { return { version: 1, createdAt: '2026-11-10T00:00:00.000Z', projectName: f.scan.name, projectPath: f.scan.root, granularity: 'coarse', roleFocus: 'backend', profileId: f.profile.id, modelUsed: `${f.profile.name} / ${f.profile.model}`, projectSummary: 'Synthetic.', sections: [{ id: 'source-section', title: 'Functions', questions }], glossary: {} } }
const syntheticTransport: ModelTransport = async (_profile, messages, _emit, options) => {
  options.beforeRequest?.()
  const inputTokens = estimateMessageTokens(messages)
  options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
  return '{}'
}
async function adapterFor(f: Fixture, transport: ModelTransport = syntheticTransport) {
  const adapter = await createEvidenceGenerationAdapter({ ...f, selection: { selectedIds: f.ids, requiredBundles: [], unresolved: [] }, topics: [{ id: 'topic', title: 'Function', mechanism: 'Returns a number.', valueRationale: 'Explains the return.', difficulty: 'basic', evidenceIds: f.ids, evidenceNeeds: [], unconfirmed: [] }], transport })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare({ requestId: 'actual-request', stage: 'generation', batchIndex: 0, label: 'Functions', quota: 10, maxChars: 40_000, maxInputTokens: f.spec.generationInputTokens, signal: f.signal, buildMessages: text => [{ role: 'system', content: 'Synthetic local test.' }, { role: 'user', content: `Quoted source:\n${text}` }] })
  const questions = Array.from({ length: 10 }, (_, index) => question(index))
  const accept = () => { for (const q of questions) adapter.requestAdapter.acceptQuestion({ requestId: prepared.requestId, rawQuestion: { ...q, evidenceIds: f.ids }, question: q }) }
  return { adapter, prepared, questions, accept }
}
async function completed(f: Fixture) {
  const state = await adapterFor(f)
  await state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal })
  state.accept()
  const sidecar = await state.adapter.finalize(result(f, state.questions))
  return { ...state, sidecar }
}

test('real guarded dispatch issues an opaque source bound to exact messages, final fingerprint and original references', async t => {
  const f = await fixture(); t.after(f.cleanup)
  let actualHash = ''
  const state = await adapterFor(f, async (profile, messages, emit, options) => {
    actualHash = createHash('sha256').update(JSON.stringify(messages)).digest('hex')
    return syntheticTransport(profile, messages, emit, options)
  })
  await assert.rejects(state.adapter.sourceFor(state.questions[0]), { code: 'unknown-evidence' })
  await state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal })
  state.accept()
  await state.adapter.finalize(result(f, state.questions))
  const capability = await state.adapter.sourceFor(state.questions[0])
  const authority = state.adapter.sourceAuthority
  const description = await authority.assertCurrent(capability, state.questions[0])
  assert.equal(authority.spec, f.spec); assert.equal(authority.ledger, f.ledger)
  assert.equal(authority.snapshot, f.snapshot); assert.equal(authority.store, f.store)
  assert.equal(description.origin, 'completed-generation')
  assert.equal(description.requestId, state.prepared.requestId)
  assert.equal(description.requestHash, actualHash)
  assert.equal(description.manifestHash, state.adapter.metadata()[0].manifest.manifestHash)
  assert.equal(description.questionFingerprint, fingerprintQuestion(state.questions[0]))
  assert.deepEqual(description.evidenceIds, f.ids)
  assert.equal(description.verification, 'source-bound-unverified')
  assert.equal(Object.isFrozen(description.evidenceIds), true)
  const serialized = JSON.stringify(description)
  assert.equal(serialized.includes(sourceText.trim()), false)
  assert.equal(serialized.includes(f.profile.apiKey), false)
  assert.equal(serialized.includes('Quoted source'), false)
  assert.deepEqual(Object.keys(capability), ['kind'])
  assert.equal('recordDispatch' in authority, false)
})

test('forged, copied, structured-cloned, metadata-only and cross-run capabilities are rejected', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await completed(f)
  const source = await state.adapter.sourceFor(state.questions[0])
  const authority = state.adapter.sourceAuthority
  assertQuestionSourceAuthority(authority)
  assert.throws(() => assertQuestionSourceAuthority({ ...authority }), { code: 'unknown-evidence' })
  assert.throws(() => ({ ...authority }).describe(source, state.questions[0]), { code: 'unknown-evidence' })
  assert.throws(() => createGenerationQuestionSourceRecorder({ spec: f.spec, ledger: f.ledger, snapshot: f.snapshot, store: f.store, signal: f.signal }, {}), { code: 'permission-denied' })
  for (const value of [{}, { ...source }, structuredClone(source), JSON.parse(JSON.stringify(source)), authority.describe(source, state.questions[0]), state.sidecar.questions[0]]) {
    assert.throws(() => authority.describe(value, state.questions[0]), { code: 'unknown-evidence' })
  }
  const foreign = await fixture('other-run'); t.after(foreign.cleanup)
  const other = await completed(foreign)
  assert.throws(() => other.adapter.sourceAuthority.describe(source, state.questions[0]), { code: 'unknown-evidence' })
  assert.throws(() => authority.describe(source, { ...state.questions[0], id: 'another-question' }), { code: 'unknown-evidence' })
})

test('captured and finalized question fingerprints reject stale content before or after capability issuance', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await adapterFor(f)
  await state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal })
  state.accept()
  state.questions[0].answer = 'Changed after acceptance.'
  await state.adapter.finalize(result(f, state.questions))
  await assert.rejects(state.adapter.sourceFor(state.questions[0]), { code: 'unknown-evidence' })
  const source = await state.adapter.sourceFor(state.questions[1])
  assert.throws(() => state.adapter.sourceAuthority.describe(source, { ...state.questions[1], answer: 'Stale.' }), { code: 'unknown-evidence' })
  const checking = state.adapter.sourceAuthority.assertCurrent(source, state.questions[1])
  state.questions[1].answer = 'Changed while awaiting authorized snapshot.'
  await assert.rejects(checking, { code: 'unknown-evidence' })
})

test('question identity cannot change while source issuance awaits the current snapshot', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await completed(f)
  const pending = state.adapter.sourceFor(state.questions[0])
  state.questions[0].id = 'swapped-id'
  await assert.rejects(pending, { code: 'unknown-evidence' })
})

test('an actually pending guarded dispatch cannot finalize or issue before its receipt settles', async t => {
  const f = await fixture(); t.after(f.cleanup)
  let release!: () => void
  let dispatched!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { dispatched = resolve })
  const state = await adapterFor(f, async (_profile, messages, _emit, options) => {
    options.beforeRequest?.()
    dispatched()
    await waiting
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  })
  const completing = state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal })
  await ready
  assert.equal(f.ledger.snapshot().reservations[0].state, 'dispatched')
  await assert.rejects(state.adapter.finalize(result(f, state.questions)), { code: 'budget-exhausted' })
  await assert.rejects(state.adapter.sourceFor(state.questions[0]), { code: 'unknown-evidence' })
  release()
  await completing
  state.accept()
  await state.adapter.finalize(result(f, state.questions))
  assert.equal((await state.adapter.sourceFor(state.questions[0])).kind, 'question-source')
})

test('pending, failed, unknown-usage and undispatched responses never issue completed-generation capabilities', async t => {
  for (const mode of ['failed', 'unknown', 'unguarded'] as const) {
    const f = await fixture(`source-${mode}`); t.after(f.cleanup)
    const state = await adapterFor(f, async (_profile, messages, _emit, options) => {
      if (mode !== 'unguarded') options.beforeRequest?.()
      if (mode === 'failed') {
        const inputTokens = estimateMessageTokens(messages)
        options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
        throw new Error('Synthetic transport failure.')
      }
      return '{}'
    })
    await assert.rejects(state.adapter.sourceFor(state.questions[0]))
    await assert.rejects(state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal }))
    if (mode === 'failed') {
      state.accept()
      await state.adapter.finalize(result(f, state.questions))
      await assert.rejects(state.adapter.sourceFor(state.questions[0]), { code: 'unknown-evidence' })
    } else {
      assert.equal(f.ledger.snapshot().usageComplete, false)
      await assert.rejects(state.adapter.sourceFor(state.questions[0]))
    }
  }
})

test('stale authorized snapshot and cancellation reject source access, including after asynchronous checks begin', async t => {
  const stale = await fixture('stale-run'); t.after(stale.cleanup)
  const state = await completed(stale)
  const source = await state.adapter.sourceFor(state.questions[0])
  await fs.writeFile(path.join(stale.root, 'src/value.ts'), 'export const changed = true\n')
  await assert.rejects(state.adapter.sourceAuthority.assertCurrent(source, state.questions[0]), { code: 'stale-snapshot' })
  await assert.rejects(state.adapter.sourceFor(state.questions[0]), { code: 'stale-snapshot' })
  const cancelled = await fixture('cancelled-run'); t.after(cancelled.cleanup)
  const other = await completed(cancelled)
  const otherSource = await other.adapter.sourceFor(other.questions[0])
  const pending = other.adapter.sourceAuthority.assertCurrent(otherSource, other.questions[0])
  cancelled.abort()
  await assert.rejects(pending, { code: 'cancelled' })
  assert.throws(() => other.adapter.sourceAuthority.describe(otherSource, other.questions[0]), { code: 'cancelled' })
})

test('unknown receipt on the original ledger blocks an existing capability and a new ledger cannot reset it', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await completed(f)
  const source = await state.adapter.sourceFor(state.questions[0])
  f.ledger.markUnknownRecovery({ id: 'unknown-review', stage: 'review', inputTokens: 1, outputTokens: 1 })
  const unrelatedLedger = createBudgetLedger(f.spec)
  assert.equal(unrelatedLedger.snapshot().usageComplete, true)
  assert.throws(() => state.adapter.sourceAuthority.describe(source, state.questions[0]), { code: 'budget-exhausted' })
})

test('frozen evaluation import rebuilds actual evidence with an explicit unpaid unverified origin', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const imported = await createFrozenEvaluationQuestionSource({ spec: f.spec, ledger: f.ledger, snapshot: f.snapshot, store: f.store, signal: f.signal, question: question(), glossary: {}, evidence: [{ fileId: f.file.fileId, range: { startLine: 1, endLine: 1 } }] })
  const description = await imported.authority.assertCurrent(imported.source, imported.question)
  assert.equal(description.origin, 'frozen-evaluation-input')
  assert.equal(description.verification, 'imported-input-unverified')
  assert.equal(description.requestId, null)
  assert.equal(f.ledger.snapshot().total.dispatchedRequests, 0)
  assert.deepEqual(f.ledger.snapshot().reservations, [])
  assert.deepEqual(description.evidenceIds, f.ids)
  assert.equal(Object.isFrozen(imported.question), true)
  assert.equal('result' in imported, false)
  await assert.rejects(createFrozenEvaluationQuestionSource({ ...f, question: question(), glossary: {}, evidence: [{ fileId: 'forged-file', range: { startLine: 1, endLine: 1 } }] }), { code: 'unknown-evidence' })
})


test('frozen evaluation imports reserve real reads, settle cache hits at zero and retain failed I/O charges', async t => {
  const f = await fixture('charged-evaluation'); t.after(f.cleanup)
  let reads = 0
  const snapshot = await createWorkflowSnapshot(f.scan, { projectId: f.spec.projectId, reader: async (_scan, file) => { reads++; return fs.readFile(path.join(f.root, file.relPath), 'utf8') } })
  const store = createEvidenceStore(snapshot)
  const input = { spec: f.spec, ledger: f.ledger, snapshot, store, signal: f.signal, question: question(), glossary: {}, evidence: [{ fileId: f.file.fileId, range: { startLine: 1, endLine: 1 } }] }
  await createFrozenEvaluationQuestionSource(input)
  assert.equal(reads, 1)
  assert.equal(f.ledger.snapshot().total.readBytes, f.file.byteLength)
  await createFrozenEvaluationQuestionSource(input)
  assert.equal(reads, 1)
  assert.equal(f.ledger.snapshot().total.readBytes, f.file.byteLength)
  const failed = await fixture('failed-evaluation-read'); t.after(failed.cleanup)
  const failingSnapshot = await createWorkflowSnapshot(failed.scan, { projectId: failed.spec.projectId, reader: async (_scan, file) => { await fs.readFile(path.join(failed.root, file.relPath)); throw new Error('Synthetic failure after I/O.') } })
  await assert.rejects(createFrozenEvaluationQuestionSource({ spec: failed.spec, ledger: failed.ledger, snapshot: failingSnapshot, store: createEvidenceStore(failingSnapshot), signal: failed.signal, question: question(), glossary: {}, evidence: [{ fileId: failed.file.fileId, range: { startLine: 1, endLine: 1 } }] }), { code: 'unreadable' })
  assert.equal(failed.ledger.snapshot().total.readBytes, failed.file.byteLength)
  const limited = await fixture('limited-evaluation-read', 1); t.after(limited.cleanup)
  let blockedReads = 0
  const limitedSnapshot = await createWorkflowSnapshot(limited.scan, { projectId: limited.spec.projectId, reader: async () => { blockedReads++; return sourceText } })
  await assert.rejects(createFrozenEvaluationQuestionSource({ spec: limited.spec, ledger: limited.ledger, snapshot: limitedSnapshot, store: createEvidenceStore(limitedSnapshot), signal: limited.signal, question: question(), glossary: {}, evidence: [{ fileId: limited.file.fileId, range: { startLine: 1, endLine: 1 } }] }), { code: 'budget-exhausted' })
  assert.equal(blockedReads, 0)
  assert.equal(limited.ledger.snapshot().total.readBytes, 0)
})


test('an asynchronous outer admission hook settles before gateway dispatch, source registration or fetch acceptance', async t => {
  const f = await fixture('async-admission'); t.after(f.cleanup)
  let resolveHook!: () => void
  let enteredHook!: () => void
  const waiting = new Promise<void>(resolve => { resolveHook = resolve })
  const entered = new Promise<void>(resolve => { enteredHook = resolve })
  let accepted = 0
  let notifications = 0
  const state = await adapterFor(f, async (_profile, messages, _emit, options) => {
    await options.beforeRequest?.()
    accepted++
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  })
  const completing = state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal, beforeRequest: async () => { enteredHook(); await waiting }, onRequest: () => { notifications++ } })
  try {
    await entered
    assert.equal(accepted, 0)
    assert.equal(notifications, 0)
    assert.equal(f.ledger.snapshot().total.dispatchedRequests, 0)
    assert.equal(f.ledger.snapshot().total.reservedRequests, 1)
    assert.deepEqual(state.adapter.metadata(), [])
    await assert.rejects(state.adapter.sourceFor(state.questions[0]))
  } finally { resolveHook() }
  await completing
  assert.equal(accepted, 1)
  assert.equal(notifications, 1)
  state.accept()
  await state.adapter.finalize(result(f, state.questions))
  const source = await state.adapter.sourceFor(state.questions[0])
  assert.equal(state.adapter.sourceAuthority.describe(source, state.questions[0]).requestId, state.prepared.requestId)
  assert.equal(state.adapter.metadata().length, 1)
})

test('asynchronous admission rejection, cancellation and stale snapshot fail before gateway dispatch with no unhandled rejection', async t => {
  const unhandled: unknown[] = []
  const observe = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', observe)
  t.after(() => process.off('unhandledRejection', observe))
  for (const mode of ['reject', 'cancel', 'stale'] as const) {
    const f = await fixture(`async-${mode}`); t.after(f.cleanup)
    let accepted = 0
    let notifications = 0
    const state = await adapterFor(f, async (_profile, _messages, _emit, options) => { await options.beforeRequest?.(); accepted++; return '{}' })
    const outcome = state.adapter.requestAdapter.complete(state.prepared, () => undefined, {
      signal: f.signal,
      beforeRequest: async () => {
        await Promise.resolve()
        if (mode === 'reject') throw new Error('Synthetic admission rejection.')
        if (mode === 'cancel') f.abort()
        if (mode === 'stale') await fs.writeFile(path.join(f.root, 'src/value.ts'), 'export const changedAfterAdmission = true\n')
      },
      onRequest: () => { notifications++ }
    }).then(() => null, error => error as { code: string })
    const error = await outcome
    assert.equal(error?.code, mode === 'cancel' ? 'cancelled' : mode === 'stale' ? 'stale-snapshot' : 'model-failed')
    assert.equal(accepted, 0)
    assert.equal(notifications, 0)
    assert.equal(f.ledger.snapshot().total.dispatchedRequests, 0)
    assert.equal(f.ledger.snapshot().total.reservedRequests, 0)
    assert.deepEqual(state.adapter.metadata(), [])
    await assert.rejects(state.adapter.sourceFor(state.questions[0]))
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})

test('a transport that discards asynchronous admission cannot register a late source or leak a rejected Promise', async t => {
  const f = await fixture('discarded-admission'); t.after(f.cleanup)
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const unhandled: unknown[] = []
  const observe = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', observe)
  t.after(() => process.off('unhandledRejection', observe))
  const state = await adapterFor(f, async (_profile, _messages, _emit, options) => { options.beforeRequest?.(); return '{}' })
  const outcome = state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal, beforeRequest: () => waiting }).then(() => null, error => error as { code: string })
  assert.equal((await outcome)?.code, 'model-failed')
  assert.equal(f.ledger.snapshot().usageComplete, false)
  assert.deepEqual(state.adapter.metadata(), [])
  release()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(state.adapter.metadata(), [])
  assert.deepEqual(unhandled, [])
})

test('request notification cancellation is fenced before the transport accepts fetch', async t => {
  const f = await fixture('notification-cancel'); t.after(f.cleanup)
  let accepted = 0
  const state = await adapterFor(f, async (_profile, _messages, _emit, options) => { await options.beforeRequest?.(); accepted++; return '{}' })
  await assert.rejects(state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal, onRequest: f.abort }), { code: 'cancelled' })
  assert.equal(accepted, 0)
  assert.equal(f.ledger.snapshot().usageComplete, false)
  await assert.rejects(state.adapter.sourceFor(state.questions[0]), { code: 'cancelled' })
})

test('repeatable pure guards preserve one actual prefetch registration', async t => {
  if (process.env.REPOPREP_REPEAT_SOURCE_GUARDS !== '1') {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-repeat-guards-'))
    t.after(() => fs.rm(temporary, { recursive: true, force: true }))
    const gatewayFile = path.join(temporary, 'gateway.mjs')
    const loaderFile = path.join(temporary, 'loader.mjs')
    const actualGateway = new URL('./model-gateway.ts', import.meta.url).href
    await fs.writeFile(gatewayFile, `import { createModelGateway as actual } from ${JSON.stringify(actualGateway)};
export function createModelGateway(spec, profile, ledger, options) {
  const gateway = actual(spec, profile, ledger, { ...options, transport: (profile, messages, emit, gatewayOptions) => options.transport(profile, messages, emit, { ...gatewayOptions, beforeRequest: async () => { await Promise.resolve(); gatewayOptions.beforeRequest?.(); } }) });
  return { async complete(input) {
    const check = () => { if (input.dispatchGuard?.(input.messages) !== undefined) throw new Error('Dispatch guard must be synchronous.'); };
    check(); check();
    const completion = await gateway.complete(input);
    check(); check();
    return completion;
  } };
}
`)
    const sourceModule = new URL('./evidence-generation.ts', import.meta.url).href
    await fs.writeFile(loaderFile, `import { registerHooks } from 'node:module';
process.env.REPOPREP_REPEAT_SOURCE_GUARDS = '1';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './model-gateway.ts' && context.parentURL === ${JSON.stringify(sourceModule)}) return { url: ${JSON.stringify(pathToFileURL(gatewayFile).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
} });
`)
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--import', new URL('../../../tests/register-shared-alias.mjs', import.meta.url).href, '--import', pathToFileURL(loaderFile).href, '--test', '--test-name-pattern', '^repeatable pure guards preserve one actual prefetch registration$', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
    return
  }
  const f = await fixture('repeated-pure-guards'); t.after(f.cleanup)
  let hooks = 0
  let notifications = 0
  let accepted = 0
  const state = await adapterFor(f, async (_profile, messages, _emit, options) => {
    await options.beforeRequest?.()
    accepted++
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  })
  await state.adapter.requestAdapter.complete(state.prepared, () => undefined, { signal: f.signal, beforeRequest: async () => { hooks++; await Promise.resolve() }, onRequest: () => { notifications++ } })
  state.accept()
  await state.adapter.finalize(result(f, state.questions))
  await state.adapter.sourceFor(state.questions[0])
  assert.equal(hooks, 1)
  assert.equal(notifications, 1)
  assert.equal(accepted, 1)
  assert.equal(state.adapter.metadata().length, 1)
  assert.equal(f.ledger.snapshot().total.dispatchedRequests, 1)
})
