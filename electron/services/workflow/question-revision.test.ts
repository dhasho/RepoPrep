import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { InterviewResult, LlmProfile, QuestionItem } from '../../../shared/types.ts'
import type { CallOptions } from '../llm.ts'
import type { ModelTransport } from './model-gateway.ts'
import type { WorkflowProjectSnapshot } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createWorkflowSnapshot } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createFrozenEvaluationQuestionSource, createRevisionQuestionSourceRecorder, createGenerationQuestionSourceRecorder } from './question-source.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createQuestionReviewService, readQuestionReviewDispatches } from './question-review.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createQuestionRevisionService, readQuestionRevisionDispatches, createQuestionRevisionTarget, createSingleQuestionRevisionTarget, readQuestionRevisionTarget, readSingleQuestionRevisionTarget, readAcceptedQuestionRevisionSource, ownsQuestionRevisionSourceRecorder } from './question-revision.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { estimateMessageTokens } from '../../../shared/token-budget.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { fingerprintQuestion } from './question-evidence.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { WorkflowError } from './project-contract.ts'
import type { QuestionRevisionInput, QuestionRevisionOutcome, QuestionRevisionTarget, SingleQuestionRevisionTarget } from './question-revision.ts'
import type { QuestionRevisionClaim } from './question-review.ts'
import type { WorkflowEvidenceStore } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { createEvidenceGenerationAdapter } from './evidence-generation.ts'

type FinalOptions = CallOptions & { beforeFetch?: () => void }
const sourceText = 'export function fixedNumber() { return 42 }\n'
function question(index = 0): QuestionItem { return { id: `original-author-sample-${index}`, title: `Function ${index}`, question: `How does function ${index} return a value?`, answer: 'It returns a fixed number.', followUps: [{ question: 'Which value?', answer: 'A fixed number.', followUps: [] }] } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture(input: { clock?: () => number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-revision-'))
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/value.ts'), sourceText)
  const scan = await scanProject(root)
  const actualSnapshot = await createWorkflowSnapshot(scan, { projectId: 'revision-project' })
  let hook: (() => Promise<void>) | undefined
  const snapshot: WorkflowProjectSnapshot = Object.freeze({ ...actualSnapshot, async assertCurrent(signal?: AbortSignal) { await hook?.(); await actualSnapshot.assertCurrent(signal) } })
  const store = createEvidenceStore(snapshot)
  const file = snapshot.files.find(file => file.relPath === 'src/value.ts')!
  const profile: LlmProfile = { id: 'revision-profile', name: 'Synthetic only', model: 'revision-model', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-revision-secret', protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 8192 }
  const spec = createRunSpec({ version: 1, runId: 'revision-run', projectId: snapshot.projectId, snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'coarse', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'revision-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
  const ledger = createBudgetLedger(spec, { clock: input.clock })
  const controller = new AbortController()
  const imported = await createFrozenEvaluationQuestionSource({ spec, ledger, snapshot, store, signal: controller.signal, question: question(), glossary: { Existing: 'An existing term. It remains available.' }, evidence: [{ fileId: file.fileId, range: { startLine: 1, endLine: 1 } }] })
  const result: InterviewResult = { version: 1, createdAt: '2026-11-11T00:00:00.000Z', projectName: scan.name, projectPath: root, granularity: 'coarse', roleFocus: 'backend', profileId: profile.id, modelUsed: `${profile.name} / ${profile.model}`, projectSummary: 'Synthetic project.', sections: [{ id: 'section-functions', title: 'Functions', questions: Array.from({ length: 10 }, (_, index) => index ? question(index) : structuredClone(imported.question)) }], glossary: { ...imported.glossary } }
  return { root, scan, actualSnapshot, snapshot, store, file, profile, spec, ledger, signal: controller.signal, abort: () => controller.abort(), ...imported, result, setSnapshotHook: (value: typeof hook) => { hook = value }, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function transport(value: unknown, usage = true): ModelTransport {
  return async (_profile, messages, _emit, options) => {
    await options.beforeRequest?.(); (options as FinalOptions).beforeFetch?.()
    if (usage) { const inputTokens = estimateMessageTokens(messages); options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 }) }
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
}
function proposal(f: Fixture, answer = 'It returns the constant value [[AnswerValue]].') { const { id: _id, ...content } = f.question; return { question: { ...content, answer }, evidenceIds: [...f.authority.describe(f.source, f.question).evidenceIds], glossary: { AnswerValue: 'A value used as an answer. It is fixed for this function.' } } }
async function review(f: Fixture) {
  const ids = f.authority.describe(f.source, f.question).evidenceIds
  const outcome = await createQuestionReviewService({ authority: f.authority, profile: f.profile, glossary: f.glossary, transport: transport({ assessment: 'material-risk', findings: [{ kind: 'missing-condition', path: 'answer', evidenceIds: ids, reason: 'Synthetic selected finding prose.' }, { kind: 'unsupported-claim', path: 'followUps.0.answer', evidenceIds: ids, reason: 'Synthetic unselected finding prose.' }] }) }).review(f)
  assert.equal(outcome.status, 'assessed'); if (outcome.status !== 'assessed') throw new Error('Expected review.')
  return outcome
}
async function ready(f: Fixture, full = false) {
  const target = full ? createQuestionRevisionTarget({ authority: f.authority, result: f.result }) : createSingleQuestionRevisionTarget(f)
  const outcome = await review(f)
  const request: QuestionRevisionInput = { target, source: f.source, questionId: f.question.id, outcome, findingIds: [outcome.findings[0].id] }
  return { target, outcome, request }
}
function service(f: Fixture, actualTransport = transport(proposal(f))) { return createQuestionRevisionService({ authority: f.authority, profile: f.profile, transport: actualTransport }) }
function applied(value: QuestionRevisionOutcome): Extract<QuestionRevisionOutcome, { status: 'applied' }> { assert.equal(value.status, 'applied', JSON.stringify(value)); if (value.status !== 'applied') throw new Error(JSON.stringify(value)); return value }

test('single-question revision atomically applies and issues a same-authority source with complete repair lineage for re-review', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await ready(f)
  const before = readSingleQuestionRevisionTarget(state.target)
  const outcome = applied(await service(f).revise(state.request))
  const after = readSingleQuestionRevisionTarget(state.target)
  assert.equal(before.version, 0); assert.equal(after.version, 1)
  assert.equal(after.question.id, f.question.id); assert.equal(after.question.answer, proposal(f).question.answer)
  assert.equal(f.question.answer, before.question.answer)
  assert.equal(outcome.verification, 'source-bound-unverified')
  assert.equal(readAcceptedQuestionRevisionSource(state.target, f.question.id), outcome.source)
  const description = await f.authority.assertCurrent(outcome.source, after.question)
  assert.equal(description.origin, 'completed-semantic-revision'); assert.equal(description.verification, 'source-bound-unverified')
  assert.equal(description.questionFingerprint, fingerprintQuestion(after.question))
  assert.equal(description.revision?.before.questionFingerprint, fingerprintQuestion(before.question))
  assert.equal(description.revision?.before.requestId, null)
  assert.equal(description.revision?.after.requestId, description.requestId)
  assert.equal(description.revision?.after.manifestHash, description.manifestHash)
  assert.deepEqual(description.revision?.findingIds, state.request.findingIds)
  assert.ok(f.ledger.snapshot().reservations.some(entry => entry.id === description.requestId && entry.state === 'settled' && entry.stage === 'repair'))
  const reassessed = await createQuestionReviewService({ authority: f.authority, profile: f.profile, glossary: after.glossary, transport: transport({ assessment: 'no-material-risk', findings: [] }) }).review({ source: outcome.source, question: after.question })
  assert.equal(reassessed.status, 'assessed')
  assert.throws(() => f.authority.describe(f.source, after.question), { code: 'unknown-evidence' })
  assert.throws(() => f.authority.describe({ ...outcome.source }, after.question), { code: 'unknown-evidence' })
  assert.throws(() => f.authority.describe(structuredClone(outcome.source), after.question), { code: 'unknown-evidence' })
})

test('full target owns detached immutable data without freezing or mutating caller values', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await ready(f, true)
  assert.equal(Object.isFrozen(f.result), false); assert.equal(Object.isFrozen(f.result.sections[0].questions[0]), false)
  const before = readQuestionRevisionTarget(state.target)
  assert.equal(Object.isFrozen(before.result), true); assert.equal(Object.isFrozen(before.result.sections[0].questions[0]), true)
  applied(await service(f).revise(state.request))
  const after = readQuestionRevisionTarget(state.target)
  assert.equal(after.version, 1)
  assert.deepEqual(after.result.sections[0].questions.slice(1), f.result.sections[0].questions.slice(1))
  assert.equal(after.result.glossary.Existing, f.glossary.Existing)
  assert.equal(after.result.glossary.AnswerValue, proposal(f).glossary.AnswerValue)
  assert.equal(before.result.sections[0].questions[0].answer, f.question.answer)
})

test('full targets bind granularity, role, profile and model metadata to the authority RunSpec', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const fine: InterviewResult = { ...structuredClone(f.result), granularity: 'fine', sections: [{ ...structuredClone(f.result.sections[0]), questions: Array.from({ length: 25 }, (_, index) => question(index)) }] }
  const mismatches: InterviewResult[] = [
    fine,
    { ...structuredClone(f.result), roleFocus: 'frontend' },
    { ...structuredClone(f.result), profileId: 'different-profile' },
    { ...structuredClone(f.result), modelUsed: `${f.profile.name} / different-model` },
    { ...structuredClone(f.result), modelUsed: ` / ${f.profile.model}` }
  ]
  for (const result of mismatches) assert.throws(() => createQuestionRevisionTarget({ authority: f.authority, result }), { code: 'invalid-argument' })
  assert.equal(fine.sections[0].questions.length, 25)
  assert.equal(Object.isFrozen(fine), false)
  // RunSpec captures the model identity, while a profile display name is not an authority field.
  const renamed = { ...structuredClone(f.result), modelUsed: `A renamed display profile / ${f.profile.model}` }
  assert.equal(readQuestionRevisionTarget(createQuestionRevisionTarget({ authority: f.authority, result: renamed })).result.modelUsed, renamed.modelUsed)
})

test('copied/cloned/cross-authority targets, outcomes, claims and fake recorder owners cannot authorize any repair', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await ready(f)
  const other = await fixture(); t.after(other.cleanup)
  let requests = 0
  const revision = service(f, async () => { requests++; return '{}' })
  for (const target of [{ ...state.target }, structuredClone(state.target), JSON.parse(JSON.stringify(state.target)), createSingleQuestionRevisionTarget(other)]) {
    assert.throws(() => readSingleQuestionRevisionTarget({ ...target }), { code: 'unknown-evidence' })
    assert.deepEqual(await revision.revise({ ...state.request, target }), { status: 'incomplete', reason: 'invalid-target' })
  }
  for (const outcome of [{ ...state.outcome }, structuredClone(state.outcome), { kind: 'question-revision-claim' }]) assert.equal((await revision.revise({ ...state.request, outcome })).status, 'incomplete')
  for (const findingIds of [[], ['invented'], [state.outcome.findings[0].id, state.outcome.findings[0].id]]) assert.equal((await revision.revise({ ...state.request, findingIds })).status, 'incomplete')
  const input = { authority: f.authority, source: f.source, question: f.question, claim: Object.freeze({ kind: 'question-revision-claim' as const }) as QuestionRevisionClaim }
  for (const owner of [{}, { ...input }, { authorize() { return true } }]) {
    assert.equal(ownsQuestionRevisionSourceRecorder(owner, input), false)
    assert.throws(() => createRevisionQuestionSourceRecorder(input, owner), { code: 'permission-denied' })
    assert.throws(() => createGenerationQuestionSourceRecorder(f, owner), { code: 'permission-denied' })
  }
  assert.equal(requests, 0)
  // Failed authorization attempts above do not consume the actual outcome.
  applied(await service(f).revise(state.request))
})

test('same genuine outcome is synchronously consumed once across concurrent/duplicate revision calls', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await ready(f)
  const entered = deferred(); const release = deferred(); let requests = 0; const value = proposal(f)
  const revision = service(f, async (profile, messages, emit, options) => { requests++; await options.beforeRequest?.(); entered.resolve(); await release.promise; return transport(value)(profile, messages, emit, { ...options, beforeRequest: undefined }) })
  const one = revision.revise(state.request)
  const two = revision.revise(state.request)
  assert.deepEqual(await two, { status: 'incomplete', reason: 'invalid-authorization' })
  await entered.promise; release.resolve(); applied(await one)
  assert.deepEqual(await revision.revise(state.request), { status: 'incomplete', reason: 'invalid-authorization' })
  assert.equal(requests, 1)
})

test('unchanged and valid-schema invalid prospective results reject without retry or target/source mutation', async t => {
  for (const mode of ['unchanged', 'duplicate', 'glossary-conflict', 'missing-term'] as const) {
    const f = await fixture(); t.after(f.cleanup)
    const state = await ready(f, true)
    const before = readQuestionRevisionTarget(state.target)
    const value = proposal(f)
    if (mode === 'unchanged') value.question.answer = f.question.answer
    if (mode === 'duplicate') value.question.question = f.result.sections[0].questions[1].question
    if (mode === 'glossary-conflict') Object.assign(value.glossary, { Existing: 'Conflicting existing definition.' })
    if (mode === 'missing-term') value.question.answer = 'A [[MissingTerm]] was introduced.'
    let requests = 0
    const outcome = await service(f, async (profile, messages, emit, options) => { requests++; return transport(value)(profile, messages, emit, options) }).revise(state.request)
    assert.deepEqual(outcome, { status: 'incomplete', reason: mode === 'unchanged' ? 'unchanged' : 'invalid-result' })
    assert.equal(requests, 1); assert.equal(readQuestionRevisionTarget(state.target).result, before.result)
    assert.equal(readAcceptedQuestionRevisionSource(state.target, f.question.id), undefined)
  }
})

test('format retry requires settled known usage, uses a fresh opaque unit, and is capped at one', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const state = await ready(f)
  const messages: string[] = []; const limits: number[] = []; const operations: string[] = []; let requests = 0
  const revision = createQuestionRevisionService({ authority: f.authority, profile: f.profile, trace: event => operations.push(event.operation), transport: async (profile, actual, emit, options) => { requests++; messages.push(JSON.stringify(actual)); limits.push(options.maxOutputTokens!); return transport(requests === 1 ? '{malformed' : proposal(f))(profile, actual, emit, options) } })
  const accepted = applied(await revision.revise({ ...state.request, maxOutputTokens: 97 }))
  assert.equal(accepted.provenance.source.revision?.after.requestHash, createHash('sha256').update(messages[1]).digest('hex'))
  assert.equal(accepted.provenance.source.requestId, f.ledger.snapshot().reservations.filter(entry => entry.stage === 'repair').at(-1)?.id)
  assert.equal(requests, 2); assert.notEqual(messages[0], messages[1]); assert.deepEqual(limits, [97, 97]); assert.ok(operations.includes('semantic-revision-format'))
  const g = await fixture(); t.after(g.cleanup); const invalid = await ready(g); let attempts = 0
  const outcome = await service(g, async (profile, actual, emit, options) => { attempts++; return transport({ question: { id: 'forged' }, evidenceIds: [], glossary: {} })(profile, actual, emit, options) }).revise(invalid.request)
  assert.deepEqual(outcome, { status: 'incomplete', reason: 'malformed-output' }); assert.equal(attempts, 2)
  assert.equal(readSingleQuestionRevisionTarget(invalid.target).version, 0)
})

test('unknown and unknown-unsent receipts stay incomplete missing-usage and never retry', async t => {
  for (const mode of ['unknown', 'unknown-unsent']) {
    const f = await fixture(); t.after(f.cleanup)
    const state = await ready(f); let requests = 0
    const release = deferred(); const entered = deferred()
    const outcome = await service(f, async (profile, messages, emit, options) => {
      requests++
      if (mode === 'unknown') return transport('{malformed', false)(profile, messages, emit, options)
      f.setSnapshotHook(async () => { entered.resolve(); await release.promise })
      void options.beforeRequest?.(); await entered.promise
      return JSON.stringify(proposal(f))
    }).revise(state.request)
    assert.deepEqual(outcome, { status: 'incomplete', reason: 'missing-usage' }); assert.equal(requests, 1)
    assert.equal(f.ledger.snapshot().reservations.at(-1)?.state, mode)
    assert.equal(readSingleQuestionRevisionTarget(state.target).version, 0)
    release.resolve(); await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(readAcceptedQuestionRevisionSource(state.target, f.question.id), undefined)
  }
})

test('budget exhaustion, overspend, known timeout and deadline expiry cannot mutate a target or retry', async t => {
  for (const mode of ['budget', 'overspend', 'timeout', 'deadline'] as const) {
    let clock = 0
    const f = await fixture({ clock: () => clock }); t.after(f.cleanup)
    const state = await ready(f); const value = proposal(f); let requests = 0
    if (mode === 'budget') for (let index = 1; index < f.spec.budget.total.maxModelRequests; index++) { const id = `spent-${index}`; f.ledger.reserveModel({ id, stage: 'generation', inputTokens: 1, outputTokens: 1 }); f.ledger.markDispatched(id); f.ledger.settleModel(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }) }
    const outcome = await service(f, async (_profile, messages, _emit, options) => {
      requests++; await options.beforeRequest?.(); (options as FinalOptions).beforeFetch?.()
      const inputTokens = estimateMessageTokens(messages); const outputTokens = mode === 'overspend' ? options.maxOutputTokens! + 1 : 1
      options.onUsage?.({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })
      if (mode === 'timeout') throw new WorkflowError('timeout')
      if (mode === 'deadline') clock = f.spec.budget.total.wallClockMs + 1
      return JSON.stringify(value)
    }).revise(state.request)
    assert.deepEqual(outcome, { status: mode === 'budget' ? 'not-run-budget' : 'incomplete', reason: mode === 'timeout' ? 'timeout' : 'budget-exhausted' })
    assert.equal(requests, mode === 'budget' ? 0 : 1); assert.equal(readSingleQuestionRevisionTarget(state.target).version, 0)
  }
})

test('a newer R epoch, cancellation or stale snapshot during repair rejects without overwriting', async t => {
  for (const mode of ['review', 'cancelled', 'stale-snapshot'] as const) {
    const f = await fixture(); t.after(f.cleanup)
    const state = await ready(f, true); const value = proposal(f)
    const entered = deferred(); const release = deferred()
    const pending = service(f, async (profile, messages, emit, options) => { await options.beforeRequest?.(); entered.resolve(); await release.promise; return transport(value)(profile, messages, emit, { ...options, beforeRequest: undefined }) }).revise(state.request)
    await entered.promise
    if (mode === 'review') await createQuestionReviewService({ authority: f.authority, profile: f.profile, glossary: f.glossary, transport: transport({ assessment: 'uncertain', findings: [] }) }).review(f)
    if (mode === 'cancelled') f.abort()
    if (mode === 'stale-snapshot') await fs.writeFile(path.join(f.root, 'src/value.ts'), '// changed source\n')
    release.resolve()
    const outcome = await pending
    assert.deepEqual(outcome, { status: 'incomplete', reason: mode === 'review' ? 'superseded' : mode })
    assert.equal(readAcceptedQuestionRevisionSource(state.target, f.question.id), undefined)
    assert.equal(readQuestionRevisionTarget(state.target).result.sections[0].questions[0].answer, f.question.answer)
  }
})

test('repair prompt contains only opaque unit, selected program findings and actual source; trace excludes reasons and secrets', async t => {
  const f = await fixture(); t.after(f.cleanup); const state = await ready(f)
  const prompts: string[] = []; const traces: unknown[] = []; const limits: number[] = []
  const revision = createQuestionRevisionService({ authority: f.authority, profile: f.profile, trace: event => traces.push(event), transport: async (profile, messages, emit, options) => { assert.equal(Object.isFrozen(messages), true); prompts.push(JSON.stringify(messages)); limits.push(options.maxOutputTokens!); return transport(proposal(f))(profile, messages, emit, options) } })
  const outcome = applied(await revision.revise(state.request))
  assert.ok(limits[0] <= 8192)
  const prompt = prompts[0]
  assert.ok(prompt.includes(sourceText.trim())); assert.ok(prompt.includes(state.request.findingIds[0])); assert.ok(prompt.includes('Synthetic selected finding prose.'))
  for (const absent of [f.question.id, f.spec.runId, f.spec.strategyVersion, f.profile.apiKey, state.outcome.findings[1].id, 'Synthetic unselected finding prose.', 'expected-fact']) assert.equal(prompt.includes(absent), false)
  assert.equal(outcome.provenance.source.requestHash, createHash('sha256').update(prompt).digest('hex'))
  for (const event of traces) assert.deepEqual(Object.keys(event as object).sort(), ['event', 'operation', 'requestId'])
  for (const absent of [sourceText.trim(), f.profile.apiKey, 'Synthetic selected finding prose.', f.question.answer]) assert.equal(JSON.stringify(traces).includes(absent), false)
})


async function productionFixture() {
  const f = await fixture()
  const originalStore = createEvidenceStore(f.actualSnapshot)
  let storeHook: (() => Promise<void>) | undefined
  const store: WorkflowEvidenceStore = Object.freeze({ ...originalStore, async resolve(ids: readonly string[], snapshotId: string, signal?: AbortSignal) { await storeHook?.(); return originalStore.resolve(ids, snapshotId, signal) } })
  const { read } = await f.actualSnapshot.readFile(f.file.fileId)
  const ids = (await store.issue(read, { startLine: 1, endLine: 1 })).map(record => record.id)
  const adapter = await createEvidenceGenerationAdapter({ ...f, snapshot: f.actualSnapshot, store, selection: { selectedIds: ids, requiredBundles: [], unresolved: [] }, topics: [], transport: transport('{}') })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare({ requestId: 'actual-generation', stage: 'generation', batchIndex: 0, label: 'Functions', quota: 10, maxChars: 40_000, maxInputTokens: f.spec.generationInputTokens, signal: f.signal, buildMessages: text => [{ role: 'user', content: text }] })
  await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal })
  for (const q of f.result.sections[0].questions) adapter.requestAdapter.acceptQuestion({ requestId: prepared.requestId, rawQuestion: { ...q, evidenceIds: ids }, question: q })
  await adapter.finalize(f.result)
  const sources = await Promise.all(f.result.sections[0].questions.slice(0, 2).map(q => adapter.sourceFor(q)))
  return { ...f, authority: adapter.sourceAuthority, source: sources[0], store, sources, ids, setStoreHook: (value: typeof storeHook) => { storeHook = value } }
}

test('settled concurrent revisions preserve another accepted question and glossary, reject late conflicts and stale same-question writes', async t => {
  for (const mode of ['preserve', 'glossary-conflict', 'same-question'] as const) {
    const f = await productionFixture(); t.after(f.cleanup)
    const state = await ready(f, true)
    const value = proposal(f)
    const entered = deferred(); const release = deferred(); let paused = false
    const pending = service(f, async (profile, messages, emit, options) => {
      const raw = await transport(value)(profile, messages, emit, options)
      f.setStoreHook(async () => {
        if (!paused && f.ledger.snapshot().usageComplete) { paused = true; entered.resolve(); await release.promise }
      })
      return raw
    }).revise(state.request)
    await entered.promise
    const index = mode === 'same-question' ? 0 : 1
    const current = readQuestionRevisionTarget(state.target).result
    const q = current.sections[0].questions[index]
    const source = f.sources[index]
    const ids = f.authority.describe(source, q).evidenceIds
    const result = await createQuestionReviewService({ authority: f.authority, profile: f.profile, glossary: current.glossary, transport: transport({ assessment: 'material-risk', findings: [{ kind: 'missing-condition', path: 'answer', evidenceIds: ids, reason: 'Synthetic second accepted revision.' }] }) }).review({ source, question: q })
    assert.equal(result.status, 'assessed'); if (result.status !== 'assessed') throw new Error('Expected assessment.')
    const { id: _id, ...content } = q
    const second = { question: { ...content, answer: 'The independently revised value is [[OtherTerm]].' }, evidenceIds: ids, glossary: mode === 'glossary-conflict' ? { OtherTerm: 'A second term. It is preserved.', AnswerValue: 'A conflicting accepted definition. It must survive.' } : { OtherTerm: 'A second term. It is preserved.' } }
    const accepted = applied(await service(f, transport(second)).revise({ target: state.target, source, questionId: q.id, outcome: result, findingIds: [result.findings[0].id] }))
    assert.equal(readQuestionRevisionTarget(state.target).version, 1)
    release.resolve()
    const first = await pending
    const after = readQuestionRevisionTarget(state.target)
    if (mode === 'preserve') {
      applied(first)
      assert.equal(after.version, 2)
      assert.equal(after.result.sections[0].questions[0].answer, value.question.answer)
      assert.equal(after.result.glossary.AnswerValue, value.glossary.AnswerValue)
      assert.equal((first as Extract<QuestionRevisionOutcome, { status: 'applied' }>).provenance.source.revision?.before.requestId, 'actual-generation')
    } else {
      assert.deepEqual(first, { status: 'incomplete', reason: mode === 'same-question' ? 'stale-question' : 'invalid-result' })
      assert.equal(after.version, 1)
    }
    assert.equal(after.result.sections[0].questions[index].answer, second.question.answer)
    assert.equal(after.result.glossary.OtherTerm, second.glossary.OtherTerm)
    assert.equal(after.result.glossary.Existing, f.glossary.Existing)
    assert.equal(readAcceptedQuestionRevisionSource(state.target, q.id), accepted.source)
    assert.equal(f.ledger.snapshot().total.dispatchedRequests, 5)
    assert.equal(f.ledger.snapshot().usageComplete, true)
  }
})


test('new review, cancellation and stale source during awaited revised-source preparation cannot expose or apply a candidate', async t => {
  for (const mode of ['review', 'cancelled', 'stale-snapshot'] as const) {
    const f = await productionFixture(); t.after(f.cleanup)
    const state = await ready(f, true)
    const before = readQuestionRevisionTarget(state.target)
    const entered = deferred(); const release = deferred(); let resolves = 0
    const pending = service(f, async (profile, messages, emit, options) => {
      const raw = await transport(proposal(f))(profile, messages, emit, options)
      f.setStoreHook(async () => {
        // The first settled resolve is the post-completion claim check; the second is inside prepareSource.
        if (f.ledger.snapshot().usageComplete && ++resolves === 2) { entered.resolve(); await release.promise }
      })
      return raw
    }).revise(state.request)
    await entered.promise
    assert.equal(f.ledger.snapshot().reservations.at(-1)?.state, 'settled')
    try {
      if (mode === 'review') await review(f)
      if (mode === 'cancelled') f.abort()
      if (mode === 'stale-snapshot') await fs.writeFile(path.join(f.root, 'src/value.ts'), '// source changed during preparation\n')
    } finally { release.resolve() }
    assert.deepEqual(await pending, { status: 'incomplete', reason: mode === 'review' ? 'superseded' : mode })
    assert.equal(readQuestionRevisionTarget(state.target).result, before.result)
    assert.equal(readQuestionRevisionTarget(state.target).version, 0)
    assert.equal(readAcceptedQuestionRevisionSource(state.target, f.question.id), undefined)
  }
})

test('revision prefetch composes repeatable caller and gateway fences after awaited admission and before actual fetch', async t => {
  if (!process.env.REPOPREP_REVISION_FENCE_MODE) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-revision-fence-'))
    t.after(() => fs.rm(temporary, { recursive: true, force: true }))
    const gatewayFile = path.join(temporary, 'gateway.mjs')
    const sourceFile = path.join(temporary, 'source.mjs')
    const loaderFile = path.join(temporary, 'loader.mjs')
    await fs.writeFile(gatewayFile, `import { createModelGateway as actual } from ${JSON.stringify(new URL('./model-gateway.ts', import.meta.url).href)};
export function createModelGateway(spec, profile, ledger, options = {}) {
  const gateway = actual(spec, profile, ledger, { ...options, transport: async (profile, messages, emit, gatewayOptions) => {
    return options.transport(profile, messages, emit, { ...gatewayOptions,
      beforeRequest: async () => {
        await Promise.resolve();
        if (process.env.REPOPREP_REVISION_FENCE_MODE === 'reject-admission') throw new Error('Synthetic admission rejection.');
        await gatewayOptions.beforeRequest?.(); globalThis.__revisionAfterIntent = true;
      },
      beforeFetch: () => {
        globalThis.__revisionGatewayFenceCalls = (globalThis.__revisionGatewayFenceCalls || 0) + 1;
        if (globalThis.__revisionRevoked) throw new Error('Synthetic gateway fence revoked.');
        if (process.env.REPOPREP_REVISION_FENCE_MODE === 'gateway-promise') return Promise.reject(new Error('Observe rejected final guard.'));
        if (process.env.REPOPREP_REVISION_FENCE_MODE === 'gateway-nonvoid') return 1;
        return gatewayOptions.beforeFetch?.();
      }
    });
  } });
  return { async complete(input) {
    const check = () => { if (input.dispatchGuard?.(input.messages) !== undefined) throw new Error('Guard was not synchronous.'); };
    check(); check();
    const result = await gateway.complete(input);
    check(); check();
    return result;
  } };
}
`)
    await fs.writeFile(sourceFile, `export * from ${JSON.stringify(new URL('./question-source.ts', import.meta.url).href)};
import { createRevisionQuestionSourceRecorder as actual } from ${JSON.stringify(new URL('./question-source.ts', import.meta.url).href)};
export function createRevisionQuestionSourceRecorder(...args) {
  const recorder = actual(...args);
  return Object.freeze({ ...recorder, recordDispatch(...values) {
    const result = recorder.recordDispatch(...values);
    globalThis.__revisionRegistrations = (globalThis.__revisionRegistrations || 0) + 1;
    return result;
  } });
}
`)
    const revisionModule = new URL('./question-revision.ts', import.meta.url).href
    await fs.writeFile(loaderFile, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './model-gateway.ts' && context.parentURL === ${JSON.stringify(revisionModule)}) return { url: ${JSON.stringify(pathToFileURL(gatewayFile).href)}, shortCircuit: true };
  if (specifier === './question-source.ts' && context.parentURL === ${JSON.stringify(revisionModule)}) return { url: ${JSON.stringify(pathToFileURL(sourceFile).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
} });
`)
    for (const mode of ['repeat', 'revoked', 'observer', 'late-fetch', 'caller-promise', 'caller-nonvoid', 'gateway-promise', 'gateway-nonvoid', 'reject-admission']) {
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--import', new URL('../../../tests/register-shared-alias.mjs', import.meta.url).href, '--import', pathToFileURL(loaderFile).href, '--test', '--test-name-pattern', '^revision prefetch composes repeatable caller and gateway fences after awaited admission and before actual fetch$', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, REPOPREP_REVISION_FENCE_MODE: mode } })
      assert.equal(child.status, 0, `${mode}\n${child.stdout}\n${child.stderr}`)
    }
    return
  }
  const mode = process.env.REPOPREP_REVISION_FENCE_MODE
  type Globals = typeof globalThis & { __revisionAfterIntent?: boolean; __revisionRevoked?: boolean; __revisionGatewayFenceCalls?: number; __revisionRegistrations?: number }
  const globals = globalThis as Globals
  const f = await fixture(); t.after(f.cleanup)
  const state = await ready(f)
  const before = readSingleQuestionRevisionTarget(state.target)
  const entered = deferred(); const release = deferred(); let paused = false
  let admissions = 0; let callerFences = 0; let notifications = 0; let fetches = 0
  const unhandled: unknown[] = []
  const observe = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', observe)
  t.after(() => process.off('unhandledRejection', observe))
  const pending = service(f, async (_profile, messages, _emit, options) => {
    f.setSnapshotHook(async () => {
      if (globals.__revisionAfterIntent && mode === 'revoked' && !paused) { paused = true; entered.resolve(); await release.promise }
    })
    await options.beforeRequest?.()
    if (mode === 'late-fetch') globals.__revisionRevoked = true
    ;(options as FinalOptions).beforeFetch?.(); (options as FinalOptions).beforeFetch?.()
    fetches++
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return JSON.stringify(proposal(f))
  }).revise({ ...state.request,
    beforeRequest: async () => { admissions++; await Promise.resolve() },
    beforeFetch: () => {
      callerFences++
      if (mode === 'caller-promise') return Promise.reject(new Error('Synthetic asynchronous caller fence.'))
      if (mode === 'caller-nonvoid') return 1
      if (globals.__revisionRevoked) throw new Error('Synthetic caller fence revoked.')
    },
    onRequest: () => { notifications++; if (mode === 'observer') globals.__revisionRevoked = true }
  })
  if (mode === 'revoked') { await entered.promise; globals.__revisionRevoked = true; release.resolve() }
  const outcome = await pending
  assert.equal(admissions, 1)
  assert.equal(f.signal.aborted, false)
  if (mode === 'repeat') {
    applied(outcome)
    assert.equal(fetches, 1); assert.equal(notifications, 1); assert.equal(globals.__revisionRegistrations, 1)
    assert.ok(callerFences >= 4); assert.ok((globals.__revisionGatewayFenceCalls ?? 0) >= 4)
  } else {
    assert.equal(outcome.status, 'incomplete'); assert.equal(fetches, 0)
    assert.equal(globals.__revisionRegistrations ?? 0, ['observer', 'late-fetch'].includes(mode!) ? 1 : 0)
    assert.equal(notifications, ['observer', 'late-fetch'].includes(mode!) ? 1 : 0)
    assert.equal(readSingleQuestionRevisionTarget(state.target).question, before.question)
    assert.equal(readSingleQuestionRevisionTarget(state.target).version, 0)
    assert.equal(readAcceptedQuestionRevisionSource(state.target, f.question.id), undefined)
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})


test('revision dispatch metadata records retries and failures, survives epoch invalidation, and never imports authority', async t => {
  for (const mode of ['retry', 'unknown', 'failed', 'none'] as const) {
    const f = await fixture(); t.after(f.cleanup); const state = await ready(f)
    const reviewMetadata = readQuestionReviewDispatches(state.outcome)
    let calls = 0; const sent: string[] = []
    const actual: ModelTransport = async (profile, messages, emit, options) => {
      calls++; sent.push(JSON.stringify(messages))
      if (mode === 'failed') { await options.beforeRequest?.(); options.onUsage?.({ inputTokens: estimateMessageTokens(messages), outputTokens: 1, totalTokens: estimateMessageTokens(messages) + 1 }); throw new WorkflowError('model-failed') }
      return transport(mode === 'retry' && calls === 1 ? '{bad' : proposal(f), mode !== 'unknown')(profile, messages, emit, options)
    }
    const outcome = await service(f, actual).revise(mode === 'none' ? { ...state.request, target: { kind: 'single-question-revision-target' } } : state.request)
    const entries = readQuestionRevisionDispatches(outcome)
    assert.equal(entries.length, mode === 'none' ? 0 : mode === 'retry' ? 2 : 1); assert.equal(calls, entries.length)
    assert.equal(Object.isFrozen(entries), true)
    entries.forEach((entry, index) => {
      assert.equal(Object.isFrozen(entry), true); assert.equal(Object.isFrozen(entry.manifest), true)
      assert.equal(entry.stage, 'repair'); assert.equal(entry.manifest.requestHash, createHash('sha256').update(sent[index]).digest('hex'))
      assert.ok(f.ledger.snapshot().reservations.some(receipt => receipt.id === entry.requestId))
    })
    assert.equal(readQuestionReviewDispatches(state.outcome), reviewMetadata)
    assert.equal(readQuestionRevisionDispatches(outcome), entries)
    assert.throws(() => readQuestionRevisionDispatches(structuredClone(outcome)), { code: 'unknown-evidence' })
    assert.throws(() => readQuestionRevisionDispatches({ ...outcome }), { code: 'unknown-evidence' })
  }
})
