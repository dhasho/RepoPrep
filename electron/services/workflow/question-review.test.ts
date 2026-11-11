import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import type { InterviewResult, LlmProfile, QuestionItem } from '../../../shared/types.ts'
import type { CallOptions } from '../llm.ts'
import type { ModelTransport } from './model-gateway.ts'
import type { WorkflowProjectSnapshot } from './project-contract.ts'
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
import { createFrozenEvaluationQuestionSource } from './question-source.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createEvidenceGenerationAdapter } from './evidence-generation.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { packEvidence } from './evidence-packer.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { estimateMessageTokens } from '../../../shared/token-budget.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { createQuestionReviewService, readQuestionReviewDispatches, validateQuestionReviewResponse, claimQuestionRevision, guardQuestionRevisionClaim, describeQuestionRevisionClaim, beginQuestionRevisionAttempt, assertQuestionRevisionClaimCurrent, invalidateQuestionReviewAfterReplacement } from './question-review.ts'
import type { QuestionReviewOutcome } from './question-review.ts'

const sourceText = 'export function localValue() { return 42 }\n'
function question(id = 'original-author-sample-007'): QuestionItem { return { id, title: 'Function return', question: 'What does localValue return?', answer: 'It returns a number.', followUps: [{ question: 'What kind?', answer: 'A number.', followUps: [{ question: 'Which one?', answer: 'A constant.', followUps: [] }] }] } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
type FinalOptions = CallOptions & { beforeFetch?: () => void }
async function fixture(input: { clock?: () => number; pauseSnapshot?: boolean; terms?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-review-'))
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src/value.ts'), sourceText)
  const scan = await scanProject(root)
  const actualSnapshot = await createWorkflowSnapshot(scan, { projectId: 'review-project' })
  let snapshotHook: (() => Promise<void>) | undefined
  const snapshot: WorkflowProjectSnapshot = input.pauseSnapshot ? Object.freeze({ ...actualSnapshot, async assertCurrent(signal?: AbortSignal) { await snapshotHook?.(); await actualSnapshot.assertCurrent(signal) } }) : actualSnapshot
  const store = createEvidenceStore(snapshot)
  const file = snapshot.files.find(file => file.relPath === 'src/value.ts')!
  const profile: LlmProfile = { id: 'review-profile', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-review-secret', model: 'review-model', protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 8192 }
  const spec = createRunSpec({ version: 1, runId: 'review-run', projectId: snapshot.projectId, snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'coarse', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'review-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
  const ledger = createBudgetLedger(spec, { clock: input.clock })
  const controller = new AbortController()
  const q = question()
  const glossary: Record<string, string> = input.terms ? { Constant: 'A fixed value. It remains the same.' } : {}
  if (input.terms) q.answer = 'It returns a [[Constant]].'
  const imported = await createFrozenEvaluationQuestionSource({ spec, ledger, snapshot, store, signal: controller.signal, question: q, glossary, evidence: [{ fileId: file.fileId, range: { startLine: 1, endLine: 1 } }] })
  return { root, scan, snapshot, actualSnapshot, store, file, profile, spec, ledger, signal: controller.signal, abort: () => controller.abort(), ...imported, setSnapshotHook: (hook: typeof snapshotHook) => { snapshotHook = hook }, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function findings(ids: readonly string[], path = 'answer') { return { assessment: 'material-risk', findings: [{ kind: 'contradiction', path, evidenceIds: [...ids], reason: 'Synthetic finding reason, never trace this prose.' }] } }
const noRisk = { assessment: 'no-material-risk', findings: [] }
function output(f: Fixture, value: unknown = noRisk, usage = true): ModelTransport {
  return async (_profile, messages, _emit, options) => {
    await options.beforeRequest?.()
    ;(options as FinalOptions).beforeFetch?.()
    if (usage) { const inputTokens = estimateMessageTokens(messages); options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 }) }
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
}
function service(f: Fixture, transport = output(f)) { return createQuestionReviewService({ authority: f.authority, profile: f.profile, glossary: f.glossary, transport }) }
function assessed(outcome: QuestionReviewOutcome): Extract<QuestionReviewOutcome, { status: 'assessed' }> { assert.equal(outcome.status, 'assessed'); if (outcome.status !== 'assessed') throw new Error('Expected assessment'); return outcome }
function claim(f: Fixture, outcome: QuestionReviewOutcome) { const result = assessed(outcome); return claimQuestionRevision({ outcome, authority: f.authority, source: f.source, question: f.question, findingIds: result.findings.map(item => item.id) }) }

// No network: every transport and credential below is synthetic.
test('review sends exact frozen source plus a fresh opaque unit; metadata is bounded and assessment unverified', async t => {
  const f = await fixture({ terms: true }); t.after(f.cleanup)
  const prompts: string[] = []
  const limits: number[] = []
  const traces: unknown[] = []
  const reviewer = createQuestionReviewService({ authority: f.authority, profile: f.profile, glossary: f.glossary, trace: event => traces.push(event), transport: async (profile, messages, emit, options) => {
    assert.equal(Object.isFrozen(messages), true)
    assert.equal(messages.every(Object.isFrozen), true)
    prompts.push(JSON.stringify(messages)); limits.push(options.maxOutputTokens!)
    return output(f)(profile, messages, emit, options)
  } })
  const one = assessed(await reviewer.review({ source: f.source, question: f.question }))
  const two = assessed(await reviewer.review({ source: f.source, question: f.question, maxOutputTokens: 37 }))
  assert.equal(one.verification, 'model-assessed-unverified')
  assert.equal(one.assessment, 'no-material-risk')
  assert.equal(one.requestHash, createHash('sha256').update(prompts[0]).digest('hex'))
  assert.notEqual(one.requestHash, two.requestHash)
  assert.deepEqual(limits, [4096, 37])
  for (const prompt of prompts) {
    assert.ok(prompt.includes(sourceText.trim())); assert.ok(prompt.includes('untrusted data')); assert.ok(prompt.includes('[[Constant]]'))
    for (const excluded of [f.question.id, f.spec.runId, f.spec.strategyVersion, f.profile.apiKey, 'author-label', 'expected-fact', 'topic-card']) assert.equal(prompt.includes(excluded), false)
  }
  for (const event of traces) assert.deepEqual(Object.keys(event as object).sort(), ['event', 'operation', 'requestId'])
  const serialized = JSON.stringify(traces)
  for (const excluded of [sourceText.trim(), f.profile.apiKey, f.question.answer, 'Synthetic finding reason']) assert.equal(serialized.includes(excluded), false)
})

test('material findings use real nested paths and program IDs; uncertain has no revision authority or retry', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const ids = f.authority.describe(f.source, f.question).evidenceIds
  const result = assessed(await service(f, output(f, findings(ids, 'followUps.0.followUps.0.answer'))).review(f))
  assert.match(result.findings[0].id, /^finding-/)
  assert.equal(Object.isFrozen(result.findings[0].evidenceIds), true)
  const proof = claim(f, result)
  guardQuestionRevisionClaim(proof); guardQuestionRevisionClaim(proof)
  const context = describeQuestionRevisionClaim(proof)
  assert.equal(context.authority, f.authority); assert.equal(context.source, f.source)
  assert.deepEqual(context.findings, result.findings)
  await assertQuestionRevisionClaimCurrent(proof)
  let requests = 0
  const uncertain = assessed(await service(f, async (profile, messages, emit, options) => { requests++; return output(f, { assessment: 'uncertain', findings: [] })(profile, messages, emit, options) }).review(f))
  assert.equal(uncertain.assessment, 'uncertain'); assert.equal(requests, 1)
  assert.throws(() => claim(f, uncertain))
  assert.throws(() => guardQuestionRevisionClaim(proof), { reason: 'superseded' })
})

test('strict schema rejects extra keys, custom prototypes, sparse/accessor arrays, noncanonical paths and evidence', () => {
  const q = question(); const ids = ['ev-synthetic']
  const valid = findings(ids)
  const wrong: unknown[] = [null, { ...valid, action: 'repair' }, { ...valid, assessment: 'verified' }, { assessment: 'material-risk', findings: [] }, { assessment: 'no-material-risk', findings: valid.findings }, { ...valid, findings: [{ ...valid.findings[0], kind: 'execute' }] }, { ...valid, findings: [{ ...valid.findings[0], path: 'followUps.00.answer' }] }, { ...valid, findings: [{ ...valid.findings[0], path: 'followUps.1.answer' }] }, { ...valid, findings: [{ ...valid.findings[0], path: 'followUps.0.followUps.0.followUps.0.answer' }] }, { ...valid, findings: [{ ...valid.findings[0], evidenceIds: ['foreign'] }] }, { ...valid, findings: [{ ...valid.findings[0], evidenceIds: [...ids, ...ids] }] }, { ...valid, findings: [{ ...valid.findings[0], reason: ' ' }] }, { ...valid, findings: [{ ...valid.findings[0], reason: 'x'.repeat(501) }] }, { ...valid, findings: [{ ...valid.findings[0], budget: 10 }] }, Object.assign(Object.create({ custom: true }), valid), { ...valid, findings: new Array(1) }, { ...valid, findings: Object.assign([], { extra: true }) }]
  let getterCalls = 0
  const getterArray: unknown[] = []
  Object.defineProperty(getterArray, '0', { enumerable: true, get() { getterCalls++; throw new Error('must not execute') } })
  wrong.push({ ...valid, findings: getterArray }, { ...valid, findings: [{ ...valid.findings[0], evidenceIds: getterArray }] })
  const getterObject = { ...valid }
  Object.defineProperty(getterObject, 'findings', { enumerable: true, get() { getterCalls++; return [] } })
  wrong.push(getterObject)
  for (const value of wrong) assert.throws(() => validateQuestionReviewResponse(value, q, ids), { reason: 'malformed-output' })
  assert.equal(getterCalls, 0)
  assert.equal(validateQuestionReviewResponse(valid, q, ids).findings.length, 1)
})

test('forged authorities, sources, outcomes and claims cannot cross the process registry boundary', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const other = await fixture(); t.after(other.cleanup)
  assert.throws(() => createQuestionReviewService({ authority: { ...f.authority }, profile: f.profile }), { code: 'unknown-evidence' })
  for (const source of [{ ...f.source }, structuredClone(f.source), other.source]) {
    const outcome = await service(f).review({ ...f, source })
    assert.deepEqual(outcome, { status: 'incomplete', reason: 'rule-failed', ruleFailures: ['source-binding'] })
  }
  const ids = f.authority.describe(f.source, f.question).evidenceIds
  const outcome = assessed(await service(f, output(f, findings(ids))).review(f))
  const input = { outcome, authority: f.authority, source: f.source, question: f.question, findingIds: [outcome.findings[0].id] }
  for (const fake of [{ ...outcome }, structuredClone(outcome), JSON.parse(JSON.stringify(outcome))]) assert.throws(() => claimQuestionRevision({ ...input, outcome: fake }), { code: 'unknown-evidence' })
  assert.throws(() => claimQuestionRevision({ ...input, authority: other.authority }), { code: 'unknown-evidence' })
  assert.throws(() => claimQuestionRevision({ ...input, source: other.source }), { code: 'unknown-evidence' })
  assert.throws(() => claimQuestionRevision({ ...input, findingIds: [] }))
  assert.throws(() => claimQuestionRevision({ ...input, findingIds: [outcome.findings[0].id, outcome.findings[0].id] }))
  assert.throws(() => claimQuestionRevision({ ...input, findingIds: ['finding-invented'] }))
  const proof = claimQuestionRevision(input)
  assert.throws(() => claimQuestionRevision(input), { code: 'unknown-evidence' })
  for (const fake of [{ ...proof }, structuredClone(proof), { kind: 'question-revision-claim', guard() {} }]) {
    assert.throws(() => guardQuestionRevisionClaim(fake), { code: 'unknown-evidence' })
    await assert.rejects(assertQuestionRevisionClaimCurrent(fake), { code: 'unknown-evidence' })
    assert.throws(() => describeQuestionRevisionClaim(fake), { code: 'unknown-evidence' })
  }
  guardQuestionRevisionClaim(proof); guardQuestionRevisionClaim(proof)
})

test('unknown receipt is incomplete missing-usage, consumes one request and never retries', async t => {
  const f = await fixture(); t.after(f.cleanup)
  let requests = 0
  const outcome = await service(f, async (profile, messages, emit, options) => { requests++; return output(f, '{malformed', false)(profile, messages, emit, options) }).review(f)
  assert.deepEqual(outcome, { status: 'incomplete', reason: 'missing-usage', ruleFailures: [] })
  assert.equal(requests, 1); assert.equal(f.ledger.snapshot().usageComplete, false)
  assert.equal(f.ledger.snapshot().reservations.at(-1)?.state, 'unknown')
})

test('malformed responses have one fresh format retry only after settled complete usage', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const hashes: string[] = []
  const traces: string[] = []
  let requests = 0
  const reviewer = createQuestionReviewService({ authority: f.authority, profile: f.profile, trace: event => traces.push(event.operation), transport: async (profile, messages, emit, options) => { hashes.push(JSON.stringify(messages)); requests++; return output(f, requests === 1 ? 'x'.repeat(32_769) : noRisk)(profile, messages, emit, options) } })
  const outcome = assessed(await reviewer.review(f))
  assert.equal(outcome.assessment, 'no-material-risk'); assert.equal(requests, 2)
  assert.notEqual(hashes[0], hashes[1]); assert.ok(traces.includes('semantic-review-format'))
  assert.equal(f.ledger.snapshot().reservations.filter(item => item.state === 'settled').length, 2)
  const g = await fixture(); t.after(g.cleanup)
  let failures = 0
  const invalid = await service(g, async (profile, messages, emit, options) => { failures++; return output(g, '{bad')(profile, messages, emit, options) }).review(g)
  assert.deepEqual(invalid, { status: 'incomplete', reason: 'malformed-output', ruleFailures: [] }); assert.equal(failures, 2)
})

test('budget exhaustion and known timeout/model failures cannot acquire authority or retry', async t => {
  const f = await fixture(); t.after(f.cleanup)
  for (let i = 0; i < f.spec.budget.total.maxModelRequests; i++) { const id = `spent-${i}`; f.ledger.reserveModel({ id, stage: 'generation', inputTokens: 1, outputTokens: 1 }); f.ledger.markDispatched(id); f.ledger.settleModel(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }) }
  let requests = 0
  const outcome = await service(f, async () => { requests++; return '{}' }).review(f)
  assert.deepEqual(outcome, { status: 'not-run-budget', reason: 'budget-exhausted', ruleFailures: [] }); assert.equal(requests, 0)
  for (const code of ['timeout', 'model-failed'] as const) {
    const g = await fixture(); t.after(g.cleanup)
    let attempts = 0
    const failure = await service(g, async (_profile, messages, _emit, options) => { attempts++; await options.beforeRequest?.(); const inputTokens = estimateMessageTokens(messages); options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 }); throw new WorkflowError(code) }).review(g)
    assert.deepEqual(failure, { status: 'incomplete', reason: code, ruleFailures: [] }); assert.equal(attempts, 1)
  }
})

test('cancellation, stale source and question edits across transport awaits reject the final assessment', async t => {
  for (const mode of ['cancelled', 'stale-snapshot', 'stale-question'] as const) {
    const f = await fixture(); t.after(f.cleanup)
    const entered = deferred(); const release = deferred()
    const mutable = structuredClone(f.question)
    const pending = service(f, async (profile, messages, emit, options) => { await options.beforeRequest?.(); entered.resolve(); await release.promise; return output(f)(profile, messages, emit, { ...options, beforeRequest: undefined }) }).review({ ...f, question: mutable })
    await entered.promise
    if (mode === 'cancelled') f.abort()
    if (mode === 'stale-question') mutable.answer = 'Changed during review.'
    if (mode === 'stale-snapshot') await fs.writeFile(path.join(f.root, 'src/value.ts'), sourceText + '// changed\n')
    release.resolve()
    assert.deepEqual(await pending, { status: 'incomplete', reason: mode, ruleFailures: [] })
  }
})

test('prefetch awaits snapshot validation; cancellation/staleness cannot dispatch or return a model finding', async t => {
  for (const mode of ['cancelled', 'stale-snapshot'] as const) {
    const f = await fixture({ pauseSnapshot: true }); t.after(f.cleanup)
    const entered = deferred(); const release = deferred(); let fetches = 0
    const pending = service(f, async (_profile, _messages, _emit, options) => {
      f.setSnapshotHook(async () => { entered.resolve(); await release.promise })
      await options.beforeRequest?.(); fetches++
      return JSON.stringify(noRisk)
    }).review(f)
    await entered.promise
    if (mode === 'cancelled') f.abort()
    else await fs.writeFile(path.join(f.root, 'src/value.ts'), '// stale\n')
    release.resolve()
    const outcome = await pending
    assert.equal(outcome.status, 'incomplete'); assert.equal('reason' in outcome && outcome.reason, mode); assert.equal(fetches, 0)
    assert.equal(f.ledger.snapshot().total.dispatchedRequests, 0)
  }
})

test('discarded asynchronous prefetch admission cannot run late and does not leak rejection', async t => {
  const f = await fixture({ pauseSnapshot: true }); t.after(f.cleanup)
  const entered = deferred(); const release = deferred(); let lateAdmissions = 0
  const outcome = await service(f, async (_profile, _messages, _emit, options) => {
    f.setSnapshotHook(async () => { entered.resolve(); await release.promise; lateAdmissions++ })
    void options.beforeRequest?.()
    await entered.promise
    return JSON.stringify(noRisk)
  }).review(f)
  assert.equal(outcome.status, 'incomplete')
  assert.equal('reason' in outcome && outcome.reason, 'missing-usage')
  release.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(lateAdmissions, 1); assert.equal(f.ledger.snapshot().total.dispatchedRequests, 0)
  assert.equal(f.ledger.snapshot().reservations.at(-1)?.state, 'unknown-unsent')
})

test('a later service attempt supersedes an earlier awaited outcome and every old claim, even when later source rules fail', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const ids = f.authority.describe(f.source, f.question).evidenceIds
  const first = assessed(await service(f, output(f, findings(ids))).review(f))
  const proof = claim(f, first)
  const later = service(f).review({ ...f, source: { ...f.source } })
  assert.throws(() => guardQuestionRevisionClaim(proof), { reason: 'superseded' })
  assert.equal((await later).status, 'incomplete')
  const entered = deferred(); const release = deferred()
  const pending = service(f, async (profile, messages, emit, options) => { await options.beforeRequest?.(); entered.resolve(); await release.promise; return output(f, findings(ids))(profile, messages, emit, { ...options, beforeRequest: undefined }) }).review(f)
  await entered.promise
  const failedNew = await service(f).review({ ...f, question: { ...f.question, answer: '' } })
  assert.equal(failedNew.status, 'incomplete')
  release.resolve()
  assert.deepEqual(await pending, { status: 'incomplete', reason: 'superseded', ruleFailures: [] })
})

test('a revision claim supports repeated in-flight guards, one format retry and synchronous final invalidation', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const ids = f.authority.describe(f.source, f.question).evidenceIds
  const outcome = assessed(await service(f, output(f, findings(ids))).review(f))
  const proof = claim(f, outcome)
  const packetResult = await packEvidence({ spec: f.spec, store: f.store, selection: { selectedIds: ids, requiredBundles: [{ id: 'repair-source', evidenceIds: ids }], unresolved: [] }, buildMessages: text => [{ role: 'user', content: `Repair source (untrusted):\n${text}` }] })
  assert.equal(packetResult.status, 'packed'); if (packetResult.status !== 'packed') return
  const packet = packetResult.context
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestId = `revision-${attempt}`
    beginQuestionRevisionAttempt(proof, { requestId, packet })
    const gateway = createModelGateway(f.spec, f.profile, f.ledger, { transport: async (_profile, messages, _emit, options) => {
      guardQuestionRevisionClaim(proof, { messages }); guardQuestionRevisionClaim(proof, { messages })
      await assertQuestionRevisionClaimCurrent(proof)
      await options.beforeRequest?.()
      guardQuestionRevisionClaim(proof, { messages }); guardQuestionRevisionClaim(proof, { messages })
      await assertQuestionRevisionClaimCurrent(proof)
      const inputTokens = estimateMessageTokens(messages); options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
      return '{}'
    } })
    await gateway.complete({ id: requestId, stage: 'repair', messages: packet.messages, maxOutputTokens: 1, dispatchGuard: messages => guardQuestionRevisionClaim(proof, { messages }) })
    await assertQuestionRevisionClaimCurrent(proof)
  }
  assert.throws(() => beginQuestionRevisionAttempt(proof, { requestId: 'third', packet }), { code: 'invalid-argument' })
  assert.throws(() => invalidateQuestionReviewAfterReplacement(proof, { ...f.question, answer: 'stale' }), { reason: 'stale-question' })
  guardQuestionRevisionClaim(proof)
  invalidateQuestionReviewAfterReplacement(proof, f.question)
  assert.throws(() => guardQuestionRevisionClaim(proof), { reason: 'superseded' })
  assert.throws(() => invalidateQuestionReviewAfterReplacement(proof, f.question), { reason: 'superseded' })
})

test('duplicate genuine generation capabilities use the same authority/question epoch', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const ids = f.authority.describe(f.source, f.question).evidenceIds
  const adapter = await createEvidenceGenerationAdapter({ ...f, snapshot: f.actualSnapshot, selection: { selectedIds: ids, requiredBundles: [], unresolved: [] }, topics: [], transport: output(f, '{}') })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare({ requestId: 'production-request', stage: 'generation', batchIndex: 0, label: 'Function', quota: 10, maxChars: 40_000, maxInputTokens: f.spec.generationInputTokens, signal: f.signal, buildMessages: text => [{ role: 'user', content: text }] })
  await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal })
  const questions = Array.from({ length: 10 }, (_, index) => question(`production-${index}`))
  for (const q of questions) adapter.requestAdapter.acceptQuestion({ requestId: prepared.requestId, rawQuestion: { ...q, evidenceIds: ids }, question: q })
  const result: InterviewResult = { version: 1, createdAt: '2026-11-11T00:00:00.000Z', projectName: f.scan.name, projectPath: f.root, granularity: 'coarse', roleFocus: 'backend', profileId: f.profile.id, modelUsed: 'Synthetic / review-model', projectSummary: 'Synthetic.', sections: [{ id: 'section', title: 'Functions', questions }], glossary: {} }
  await adapter.finalize(result)
  const sourceA = await adapter.sourceFor(questions[0]); const sourceB = await adapter.sourceFor(questions[0])
  assert.notEqual(sourceA, sourceB)
  const authority = adapter.sourceAuthority
  const first = assessed(await createQuestionReviewService({ authority, profile: f.profile, transport: output(f, findings(ids)) }).review({ source: sourceA, question: questions[0] }))
  const proof = claimQuestionRevision({ outcome: first, authority, source: sourceA, question: questions[0], findingIds: [first.findings[0].id] })
  const next = createQuestionReviewService({ authority, profile: f.profile, transport: output(f) }).review({ source: sourceB, question: questions[0] })
  assert.throws(() => guardQuestionRevisionClaim(proof), { reason: 'superseded' })
  assert.equal((await next).status, 'assessed')
})
test('review guards repeat synchronously and reject revoked/nonvoid final fences after awaited gateway admission', async t => {
  if (!process.env.REPOPREP_REVIEW_FENCE_MODE) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-review-fence-'))
    t.after(() => fs.rm(temporary, { recursive: true, force: true }))
    const gatewayFile = path.join(temporary, 'gateway.mjs')
    const loaderFile = path.join(temporary, 'loader.mjs')
    await fs.writeFile(gatewayFile, `import { createModelGateway as actual } from ${JSON.stringify(new URL('./model-gateway.ts', import.meta.url).href)};
export function createModelGateway(spec, profile, ledger, options = {}) {
  const gateway = actual(spec, profile, ledger, { ...options, transport: async (profile, messages, emit, gatewayOptions) => {
    return options.transport(profile, messages, emit, { ...gatewayOptions,
      beforeRequest: async () => { await Promise.resolve(); if (process.env.REPOPREP_REVIEW_FENCE_MODE === 'reject-admission') throw new Error('synthetic admission rejection'); await gatewayOptions.beforeRequest?.(); globalThis.__reviewAfterIntent = true; },
      beforeFetch: () => {
        const mode = process.env.REPOPREP_REVIEW_FENCE_MODE;
        if (mode === 'revoked' && globalThis.__reviewRevoked) throw new Error('synthetic fence revoked');
        if (mode === 'promise') return Promise.reject(new Error('must be observed safely'));
        if (mode === 'nonvoid') return 1;
        gatewayOptions.beforeFetch?.();
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
    await fs.writeFile(loaderFile, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './model-gateway.ts' && context.parentURL === ${JSON.stringify(new URL('./question-review.ts', import.meta.url).href)}) return { url: ${JSON.stringify(pathToFileURL(gatewayFile).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
} });
`)
    for (const mode of ['repeat', 'revoked', 'promise', 'nonvoid', 'reject-admission']) {
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--import', new URL('../../../tests/register-shared-alias.mjs', import.meta.url).href, '--import', pathToFileURL(loaderFile).href, '--test', '--test-name-pattern', '^review guards repeat synchronously and reject revoked/nonvoid final fences after awaited gateway admission$', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, REPOPREP_REVIEW_FENCE_MODE: mode } })
      assert.equal(child.status, 0, `${mode}\n${child.stdout}\n${child.stderr}`)
    }
    return
  }
  const mode = process.env.REPOPREP_REVIEW_FENCE_MODE
  const f = await fixture({ pauseSnapshot: true }); t.after(f.cleanup)
  const globals = globalThis as typeof globalThis & { __reviewAfterIntent?: boolean; __reviewRevoked?: boolean }
  const entered = deferred(); const release = deferred()
  let fetches = 0
  const pending = service(f, async (profile, messages, emit, options) => {
    f.setSnapshotHook(async () => { if (globals.__reviewAfterIntent && mode === 'revoked') { entered.resolve(); await release.promise } })
    await options.beforeRequest?.()
    ;(options as FinalOptions).beforeFetch?.()
    fetches++
    return output(f)(profile, messages, emit, { ...options, beforeRequest: undefined })
  }).review(f)
  if (mode === 'revoked') { await entered.promise; globals.__reviewRevoked = true; release.resolve() }
  const outcome = await pending
  if (mode === 'repeat') { assert.equal(outcome.status, 'assessed'); assert.equal(fetches, 1) }
  else { assert.equal(outcome.status, 'incomplete'); assert.equal(fetches, 0) }
})

test('wall clock budget expiry across transport awaits cannot yield an assessment', async t => {
  let clock = 0
  const f = await fixture({ clock: () => clock }); t.after(f.cleanup)
  let requests = 0
  const outcome = await service(f, async (profile, messages, emit, options) => {
    requests++
    const content = await output(f)(profile, messages, emit, options)
    clock = f.spec.budget.total.wallClockMs + 1
    return content
  }).review(f)
  assert.deepEqual(outcome, { status: 'incomplete', reason: 'budget-exhausted', ruleFailures: [] })
  assert.equal(requests, 1)
})

test('a new review synchronously invalidates a revision claim already awaiting a current-source check', async t => {
  const f = await fixture({ pauseSnapshot: true }); t.after(f.cleanup)
  const ids = f.authority.describe(f.source, f.question).evidenceIds
  const result = assessed(await service(f, output(f, findings(ids))).review(f))
  const proof = claim(f, result)
  const entered = deferred(); const release = deferred()
  f.setSnapshotHook(async () => { entered.resolve(); await release.promise })
  const current = assertQuestionRevisionClaimCurrent(proof)
  await entered.promise
  const newer = service(f).review({ ...f, source: { ...f.source } })
  assert.throws(() => guardQuestionRevisionClaim(proof), { reason: 'superseded' })
  release.resolve()
  await assert.rejects(current, { reason: 'superseded' })
  assert.equal((await newer).status, 'incomplete')
})


test('read-only review dispatch intent retains every retry/failure and rejects copied outcomes', async t => {
  for (const mode of ['retry', 'unknown', 'failed', 'none'] as const) {
    const f = await fixture(); t.after(f.cleanup)
    let calls = 0
    const sent: string[] = []
    const actual: ModelTransport = async (profile, messages, emit, options) => {
      calls++; sent.push(JSON.stringify(messages))
      if (mode === 'failed') { await options.beforeRequest?.(); options.onUsage?.({ inputTokens: estimateMessageTokens(messages), outputTokens: 1, totalTokens: estimateMessageTokens(messages) + 1 }); throw new WorkflowError('model-failed') }
      return output(f, mode === 'retry' && calls === 1 ? '{bad' : noRisk, mode !== 'unknown')(profile, messages, emit, options)
    }
    const outcome = await service(f, actual).review(mode === 'none' ? { ...f, question: { ...f.question, answer: '' } } : f)
    const entries = readQuestionReviewDispatches(outcome)
    assert.equal(entries.length, mode === 'none' ? 0 : mode === 'retry' ? 2 : 1)
    assert.equal(calls, entries.length)
    assert.equal(Object.isFrozen(entries), true)
    entries.forEach((entry, index) => {
      assert.equal(Object.isFrozen(entry), true); assert.equal(Object.isFrozen(entry.manifest), true)
      assert.equal(entry.stage, 'review')
      assert.equal(entry.manifest.requestHash, createHash('sha256').update(sent[index]).digest('hex'))
      assert.ok(f.ledger.snapshot().reservations.some(receipt => receipt.id === entry.requestId))
    })
    assert.equal(readQuestionReviewDispatches(outcome), entries)
    assert.throws(() => readQuestionReviewDispatches(structuredClone(outcome)), { code: 'unknown-evidence' })
    assert.throws(() => readQuestionReviewDispatches({ ...outcome }), { code: 'unknown-evidence' })
  }
})
