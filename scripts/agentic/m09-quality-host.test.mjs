import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir, copyFile, readdir, link, symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  SEMANTIC_NATIVE_COLLABORATION_V2, buildSemanticReviewPackets,
  createSemanticJudgeInput, createSemanticAdjudicatorInput,
  semanticJsonBytes, semanticSha256, semanticInvocationInputs,
  validateSemanticJudgments, scoreSemanticQuality
} from './semantic-review.mjs'
import { createRootSupervisedM09NativeBridge } from './m09-native-collaboration.mjs'
import { createM09QualityHost, captureM09QualitySession, captureM09CheckerSession, preflightM09Gate, measureM09ExecutionBudgets } from './m09-quality-host.mjs'
import { M09_LIMITS, M09_SCOPED_PROTOCOL, M09_MANIFEST_PATH, M09_LOCK_PATH, loadM09ScopedManifest, readM09BoundFile } from './m09-manifest.mjs'
import { measureM09Quality, createChecks } from './checks/m09.mjs'
import { loadChecks } from './checks/index.mjs'
import { runGate } from './gate-runner.mjs'
import { fixture, documents, syntheticJudgment, temporaryRoot, copy } from './m09-e4-test-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const v2 = Object.freeze({ invocationProtocol: SEMANTIC_NATIVE_COLLABORATION_V2 })
let unique = 0
function pureFixture(options = v2) {
  const data = documents(); const bundle = buildSemanticReviewPackets(data.projection)
  const input = createSemanticJudgeInput(bundle.publicPackets, options)
  const a = semanticJsonBytes(syntheticJudgment(input)).toString('utf8') + '\n \t'
  const b = a + '\n'
  const final = semanticJsonBytes(syntheticJudgment(input, true)).toString('utf8') + '\n'
  const judgmentBytes = semanticJsonBytes({ schemaVersion: 1, submissions: [{ role: 'A', output: a }, { role: 'B', output: b }, { role: 'adjudicator', output: final }] })
  const inputs = semanticInvocationInputs(bundle.publicPackets, JSON.parse(judgmentBytes).submissions, options)
  const invocations = JSON.parse(judgmentBytes).submissions.map(({ role, output }) => ({ schemaVersion: 2, protocol: SEMANTIC_NATIVE_COLLABORATION_V2, role, model: 'gpt-6.1-sol', nativeTaskName: `/root/pure_offline_${++unique}_${role}`, forkTurns: 'none', inputSha256: semanticSha256(inputs[role]), outputSha256: semanticSha256(output), serviceUsage: { availability: 'unavailable' } }))
  return { ...data, bundle, judgmentBytes, invocations, inputs, a, b }
}
const verify = data => validateSemanticJudgments(data.projection, data.bundle, data.judgmentBytes, data.invocations, v2)
const spawn = (request, overrides = {}) => ({ task_name: `/root/observation_offline_${++unique}`, model: 'gpt-6.1-sol', fork_turns: 'none', inputBytes: request.inputBytes, ...overrides })
const completion = (request, name, overrides = {}) => ({ task_name: name, model: 'gpt-6.1-sol', fork_turns: 'none', inputBytes: request.inputBytes, status: 'completed', rawFinal: '{}\n \t', ...overrides })

test('synthetic three-role freeze makes zero key reads and only the later branded score opens temporary keys', async t => {
  const f = await fixture(t, { writeKeys: false })
  const observation = await f.throughJudgments()
  assert.equal(f.driver.snapshot().phase, 'judgments-frozen')
  assert.deepEqual(await readdir(f.root), [])
  await f.writePrivateKeys()
  const result = await f.driver.score()
  assert.equal(result.kind, 'synthetic-m09-quality')
  assert.equal(result.quality.review.recall, 1); assert.equal(result.quality.repair.correct, 20)
  assert.equal(result.quality.completeness.complete, true)
  assert.equal(result.quality.invocations.length, 3)
  assert.equal(new Set(result.quality.invocations.map(value => value.nativeTaskName)).size, 3)
  assert.equal(result.quality.invocations[0].outputSha256, semanticSha256(observation.a.rawFinal))
  assert.notEqual(result.quality.invocations[0].outputSha256, semanticSha256(observation.a.rawFinal.trim()))
  assert.deepEqual(result.quality.invocations[0].serviceUsage, { availability: 'unavailable' })
  await assert.rejects(f.driver.gate(), /M09_SYNTHETIC_CANNOT_AUTHORIZE/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
})

for (const method of ['score', 'gate', 'freezeJudgments', 'adjudicate']) test(`early ${method} absorbs to failed before paid work or private reads`, async t => {
  let executions = 0
  const f = await fixture(t, { writeKeys: false, execute: async () => { executions++; throw new Error('must not execute') } })
  await assert.rejects(f.driver[method](), /M09_PHASE_INVALID/u)
  assert.equal(executions, 0); assert.equal(f.driver.snapshot().phase, 'failed')
  await assert.rejects(f.driver.execute(), /M09_PHASE_INVALID/u)
  assert.deepEqual(await readdir(f.root), [])
})

test('A/B bytes are identical, owned and v2 explicit; adjudicator includes actual raw A/B and all20 pairs', async t => {
  const f = await fixture(t, { writeKeys: false }); await f.driver.execute()
  const [a, b] = f.external.pendingRequests()
  assert.deepEqual(a.inputBytes, b.inputBytes)
  assert.equal(a.inputText, b.inputText)
  const input = JSON.parse(a.inputText)
  assert.equal(input.protocol, 'm09-semantic-judge-input-v2')
  assert.equal(input.invocationProtocol, SEMANTIC_NATIVE_COLLABORATION_V2)
  assert.match(input.instruction, /Do not use tools, filesystem access/u)
  const tampered = a.inputBytes; tampered.fill(0)
  assert.notDeepEqual(tampered, a.inputBytes)
  const observedA = f.complete(a); const observedB = f.complete(b)
  await f.driver.adjudicate(); const request = f.external.pendingRequests()[0]; const adjudication = JSON.parse(request.inputText)
  assert.equal(adjudication.protocol, 'm09-semantic-adjudicator-input-v2')
  assert.equal(adjudication.rawSubmissions.A, observedA.rawFinal); assert.equal(adjudication.rawSubmissions.B, observedB.rawFinal)
  assert.equal(adjudication.publicPackets.packets.length, 20)
  assert.equal(adjudication.disputes.length, 20)
  assert.equal(adjudication.disputes.every(value => value.required), true)
  f.complete(request); await f.driver.freezeJudgments()
  assert.deepEqual(await readdir(f.root), [])
})

for (const [name, mutate] of [
  ['wrong model', value => { value.model = 'gpt-6-luna' }],
  ['inherited context', value => { value.fork_turns = 'all' }],
  ['changed input bytes', value => { value.inputBytes = Buffer.from('changed') }],
  ['noncanonical task', value => { value.task_name = 'invented-uuid' }],
  ['fabricated context id', value => { value.contextId = 'fabricated' }],
  ['unobserved usage extension', value => { value.serviceUsage = { availability: 'unavailable' } }]
]) test(`native spawn rejects ${name} and fails the owning session`, async t => {
  const f = await fixture(t); await f.driver.execute(); const request = f.external.pendingRequests()[0]; const observation = spawn(request); mutate(observation)
  assert.throws(() => f.external.observeSpawn(request, observation), /M09_NATIVE_OBSERVATION_INVALID/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  await assert.rejects(f.driver.adjudicate(), /M09_PHASE_INVALID/u)
})

for (const [name, mutate] of [
  ['wrong actual handle', value => { value.task_name += '_other' }],
  ['wrong role wrapper', value => { value.role = 'B' }],
  ['wrong model', value => { value.model = 'gpt-6-luna' }],
  ['wrong context', value => { value.fork_turns = 'all' }],
  ['changed input', value => { value.inputBytes = Buffer.from('different') }],
  ['missing completion', value => { value.status = 'running' }],
  ['changed raw bytes', value => { value.finalBytes = Buffer.from('{}') }],
  ['invalid Unicode', value => { value.rawFinal = '\ud800' }],
  ['invented context field', value => { value.contextId = 'context' }],
  ['unavailable usage with invented counts', value => { value.serviceUsage = { availability: 'unavailable', inputTokens: 0 } }]
]) test(`native completion rejects ${name}`, async t => {
  const f = await fixture(t); await f.driver.execute(); const request = f.external.pendingRequests()[0]; const initial = spawn(request)
  f.external.observeSpawn(request, initial)
  const value = completion(request, initial.task_name); mutate(value)
  assert.throws(() => f.external.observeCompletion(request, value), /M09_NATIVE_OBSERVATION_INVALID/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
})

test('copied, foreign and restarted bridge handles cannot import native observations', async t => {
  const f = await fixture(t); await f.driver.execute(); const request = f.external.pendingRequests()[0]
  assert.throws(() => f.external.observeSpawn({ ...request }, spawn(request)), /M09_NATIVE_OBSERVATION_INVALID/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  const restarted = createRootSupervisedM09NativeBridge()
  assert.throws(() => restarted.observeSpawn(request, spawn(request)), /M09_NATIVE_OBSERVATION_INVALID/u)
  const second = await fixture(t); await second.driver.execute()
  assert.throws(() => second.external.observeSpawn(request, spawn(request)), /M09_NATIVE_OBSERVATION_INVALID/u)
  assert.equal(second.driver.snapshot().phase, 'failed')
})

test('a completion requires its actual preceding spawn, and missing B prevents adjudication', async t => {
  const f = await fixture(t); await f.driver.execute(); const request = f.external.pendingRequests()[0]
  assert.throws(() => f.external.observeCompletion(request, completion(request, '/root/offline_unobserved')), /M09_NATIVE_OBSERVATION_INVALID/u)
  const second = await fixture(t, { writeKeys: false }); await second.driver.execute(); second.complete(second.external.pendingRequests()[0])
  await assert.rejects(second.driver.adjudicate(), /M09_NATIVE_OBSERVATION_INVALID/u)
  assert.equal(second.driver.snapshot().phase, 'failed'); assert.deepEqual(await readdir(second.root), [])
})

test('reused actual task name and repeated completion fail closed', async t => {
  const f = await fixture(t); await f.driver.execute(); const [a, b] = f.external.pendingRequests(); const first = spawn(a)
  f.external.observeSpawn(a, first)
  assert.throws(() => f.external.observeSpawn(b, spawn(b, { task_name: first.task_name })), /M09_NATIVE_OBSERVATION_INVALID/u)
  const second = await fixture(t); await second.driver.execute(); const request = second.external.pendingRequests()[0]; const initial = spawn(request)
  second.external.observeSpawn(request, initial); const observed = completion(request, initial.task_name)
  second.external.observeCompletion(request, observed)
  assert.throws(() => second.external.observeCompletion(request, observed), /M09_NATIVE_OBSERVATION_INVALID/u)
  assert.equal(second.driver.snapshot().phase, 'failed')
})

test('execution mutation and cancel after an awaited verification absorb before private keys or more judges', async t => {
  const f = await fixture(t, { writeKeys: false }); await f.driver.execute()
  for (const request of f.external.pendingRequests()) f.complete(request)
  f.verified.projection.reviews[0].assessment = 'incomplete'
  await assert.rejects(f.driver.adjudicate(), /M09_EXECUTION_CHANGED/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  const second = await fixture(t, { writeKeys: false }); await second.driver.execute(); second.driver.cancel()
  await assert.rejects(second.driver.adjudicate(), /M09_PHASE_INVALID/u)
  assert.deepEqual(await readdir(second.root), [])
})

test('bad adjudicator output freezes no authority and no private reads', async t => {
  const f = await fixture(t, { writeKeys: false }); await f.driver.execute()
  for (const request of f.external.pendingRequests()) f.complete(request)
  await f.driver.adjudicate(); const request = f.external.pendingRequests()[0]; const value = syntheticJudgment(request.inputBytes, true); value.packets.pop()
  f.complete(request, { rawFinal: JSON.stringify(value) })
  await assert.rejects(f.driver.freezeJudgments(), /M09_SESSION_VERIFICATION_FAILED/u)
  assert.equal(f.driver.snapshot().phase, 'failed'); assert.deepEqual(await readdir(f.root), [])
})

test('explicit v2 binds raw trailing whitespace, native actual handles and unavailable usage', () => {
  const data = pureFixture(); const checked = verify(data)
  assert.equal(checked.invocations.length, 3)
  assert.equal(checked.invocations[0].protocol, SEMANTIC_NATIVE_COLLABORATION_V2)
  assert.equal(checked.invocations[0].outputSha256, semanticSha256(data.a))
  assert.notEqual(checked.invocations[0].outputSha256, semanticSha256(data.a.trim()))
  assert.deepEqual(checked.invocations[0].serviceUsage, { availability: 'unavailable' })
  const quality = scoreSemanticQuality({ ...data, invocationProtocol: SEMANTIC_NATIVE_COLLABORATION_V2 })
  assert.equal(quality.repair.correct, 20); assert.equal(Object.hasOwn(quality, 'budgetCompliant'), false)
  assert.throws(() => validateSemanticJudgments(data.projection, data.bundle, data.judgmentBytes, data.invocations), /SEMANTIC_REVIEW_INVALID/u)
})

for (const [name, mutate] of [
  ['mixed v1 protocol', values => { delete values[1].schemaVersion; delete values[1].protocol; delete values[1].nativeTaskName; delete values[1].forkTurns; Object.assign(values[1], { agentId: 'a', taskId: 't', contextId: 'c', contextMode: 'fresh-isolated' }) }],
  ['wrong schema', values => { values[0].schemaVersion = 1 }],
  ['wrong protocol', values => { values[0].protocol = 'native-collaboration-v1' }],
  ['copied task', values => { values[1].nativeTaskName = values[0].nativeTaskName }],
  ['wrong role', values => { values[0].role = 'B' }],
  ['wrong model', values => { values[0].model = 'gpt-6-luna' }],
  ['wrong fork', values => { values[0].forkTurns = 'all' }],
  ['fabricated identity', values => { values[0].contextId = 'fabricated' }],
  ['changed input hash', values => { values[0].inputSha256 = semanticSha256('wrong') }],
  ['trimmed output hash', (values, data) => { values[0].outputSha256 = semanticSha256(data.a.trim()) }],
  ['missing completion receipt', values => { values.pop() }],
  ['missing usage availability', values => { values[0].serviceUsage = {} }]
]) test(`pure explicit v2 rejects ${name}`, () => {
  const data = pureFixture(); mutate(data.invocations, data); assert.throws(() => verify(data), /SEMANTIC_REVIEW_INVALID/u)
})

test('v1 remains selected by default and preserves its independent agent/task/context schema', () => {
  const data = pureFixture({})
  data.invocations = JSON.parse(data.judgmentBytes).submissions.map(({ role, output }) => ({ role, model: 'gpt-6.1-sol', agentId: `v1-agent-${role}`, taskId: `v1-task-${role}`, contextId: `v1-context-${role}`, contextMode: 'fresh-isolated', inputSha256: semanticSha256(data.inputs[role]), outputSha256: semanticSha256(output), serviceUsage: { availability: 'unavailable' } }))
  assert.equal(validateSemanticJudgments(data.projection, data.bundle, data.judgmentBytes, data.invocations).final.packets.length, 20)
  assert.equal(JSON.parse(data.inputs.A).protocol, 'm09-semantic-judge-input-v1')
  assert.throws(() => verify(data), /SEMANTIC_REVIEW_INVALID/u)
})

test('v2 adjudicator hash changes with actual A/B whitespace and cannot omit any of20 pairs', () => {
  const data = pureFixture()
  const a = Buffer.from(data.a); const b = Buffer.from(data.b)
  const exact = createSemanticAdjudicatorInput(data.bundle.publicPackets, a, b, v2)
  const changed = createSemanticAdjudicatorInput(data.bundle.publicPackets, Buffer.from(data.a + '\n'), b, v2)
  assert.notEqual(semanticSha256(exact), semanticSha256(changed))
  const reduced = JSON.parse(data.a); reduced.packets.pop()
  assert.throws(() => createSemanticAdjudicatorInput(data.bundle.publicPackets, semanticJsonBytes(reduced), b, v2), /SEMANTIC_REVIEW_INVALID/u)
})

test('no copied/foreign/synthetic session, receipt JSON or post-restart object enables checker or gate', async t => {
  const f = await fixture(t); await f.throughJudgments(); await f.driver.score()
  for (const session of [undefined, {}, f.driver, { ...f.driver }, f.driver.snapshot(), JSON.parse(JSON.stringify(f.driver.snapshot())), { kind: 'same-host-m09-session', phase: 'scored' }]) {
    await assert.rejects(captureM09QualitySession(session), /M09_SAME_HOST_SCORED_SESSION_REQUIRED/u)
    await assert.rejects(captureM09CheckerSession(session), /M09_SAME_HOST_SCORED_SESSION_REQUIRED/u)
    await assert.rejects(preflightM09Gate(session, {}), /M09_SAME_HOST_GATE_REQUIRED/u)
    let called = false
    const result = await runGate({ module: 'M09', mode: 'real', sourceRoot: path.join(f.root, 'never-read-source'), manifestPath: path.join(f.root, 'never-read-manifest'), checks: { 'm09:frozen-review-and-repair-set': () => { called = true } }, authorization: { authorized: true, reference: 'forged' }, m09Session: session, m09GatePermit: {} })
    assert.equal(result.status, 'incomplete'); assert.equal(result.hashes, null); assert.equal(result.reportPath, null); assert.equal(called, false)
  }
})

test('registry includes M09, while absent host returns unknown without recording metrics', async () => {
  const checks = await loadChecks('M09'); assert.deepEqual([...checks.keys()], ['m09:frozen-review-and-repair-set'])
  let metrics = 0
  const result = await checks.values().next().value({ mode: 'real', definition: { limits: M09_LIMITS }, recordMetric() { metrics++ } })
  assert.equal(result.reason, 'm09-live-same-host-session-unavailable'); assert.equal(metrics, 0)
  const synthetic = await createChecks().values().next().value({ mode: 'synthetic' })
  assert.equal(synthetic.reason, 'm09-real-same-host-required')
})

const budget = { compliant: true, cases: 100, reviews: 80, repairs: 20, accounting: { unknownRequests: 0 } }
function thresholdQuality({ detected = 34, flagged = 4, correct = 14, introduced = 0 } = {}) {
  return { schemaVersion: 1, kind: 'semantic-quality-only', review: { denominator: 80, bad: 40, good: 40, detectedBad: detected, flaggedGood: flagged, recall: detected / 40, falsePositiveRate: flagged / 40, uncertain: 0, incomplete: 0 }, repair: { denominator: 20, correct, correctRate: correct / 20, failed: 20 - correct, introducedIssues: introduced, incomplete: 0, notRun: 0 }, completeness: { complete: true, issues: [] } }
}
for (const [name, options, expected] of [
  ['all exact boundaries', {}, true], ['recall just below .85', { detected: 33 }, false], ['FPR just above .10', { flagged: 5 }, false], ['13 repairs', { correct: 13 }, false], ['14 repairs', { correct: 14 }, true], ['introduced error', { introduced: 1 }, false]
]) test(`M09 threshold ${name}`, () => {
  const measured = measureM09Quality(thresholdQuality(options), budget)
  assert.equal(measured.thresholdsMet, expected)
  assert.deepEqual(Object.keys(measured.metrics), ['errorRecall', 'falsePositiveRate', 'correctRepairs', 'introducedMaterialErrors', 'budgetCompliant'])
})
for (const [name, mutate] of [
  ['review denominator', value => { value.review.denominator = 79 }], ['wrong/correct split', value => { value.review.bad = 39 }], ['repair denominator', value => { value.repair.denominator = 19 }], ['inconsistent recall', value => { value.review.recall = 1 }], ['inconsistent FPR', value => { value.review.falsePositiveRate = 0 }], ['inconsistent repair count', value => { value.repair.failed = 0 }]
]) test(`M09 never changes ${name}`, () => { const value = thresholdQuality(); mutate(value); assert.throws(() => measureM09Quality(value, budget), /M09_QUALITY_DENOMINATOR_INVALID/u) })
test('quality incompleteness, uncertain review, unrun repair and unknown budget stay failures', () => {
  for (const mutate of [value => { value.completeness.complete = false }, value => { value.review.uncertain = 1 }, value => { value.repair.notRun = 1 }, value => { value.repair.incomplete = 1 }]) { const value = thresholdQuality(); mutate(value); assert.equal(measureM09Quality(value, budget).thresholdsMet, false) }
  assert.equal(measureM09Quality(thresholdQuality(), undefined).metrics.budgetCompliant, false)
  assert.equal(measureM09Quality(thresholdQuality(), { ...budget, accounting: { unknownRequests: 1 } }).thresholdsMet, false)
  assert.throws(() => measureM09Quality(thresholdQuality(), budget, { ...M09_LIMITS, correctRepairsMin: 13 }), /M09_LIMITS_CHANGED/u)
})

function budgetFixture() {
  const limits = { aggregate: { maxRequests: 240, inputAdmission: 1_600_000, outputReservation: 1_146_880 }, review: { maxRequests: 2, inputAdmission: 12_000, outputReservation: 8192 }, repair: { maxRequests: 4, inputAdmission: 32_000, outputReservation: 24_576 }, original: { coarseRequests: 5, fineRequests: 14, inputTokens: 128_000, outputTokens: 65_536, wallClockMs: 600_000 } }
  const cases = Array.from({ length: 100 }, (_, index) => {
    const kind = index < 80 ? 'review' : 'repair'; const policy = limits[kind]
    return { kind, spec: { granularity: 'coarse' }, ledger: { elapsedMs: 600_000, usageComplete: true, blocked: false, overspend: { inputTokens: 0, outputTokens: 0, readBytes: 0 }, metrics: { unknownUsageTreatedAsZero: 0 } }, requests: Array.from({ length: policy.maxRequests }, () => ({ inputAdmission: policy.inputAdmission / policy.maxRequests, outputReservation: policy.outputReservation / policy.maxRequests, usage: { inputTokens: 1, outputTokens: 1 }, state: 'known', ledger: { state: 'settled' }, guardIntent: true, fetchFence: true, transportComplete: true })) }
  })
  const accounting = { requests: 240, inputAdmission: 1_600_000, outputReservation: 1_146_880, actualInputTokens: 240, actualOutputTokens: 240, unknownRequests: 0 }
  return { cases, limits, accounting }
}
test('independent budget pass retains all100 receipts and exact240/1.6M/1146880 boundaries', () => {
  const f = budgetFixture(); const result = measureM09ExecutionBudgets(f.cases, f.accounting, f.limits)
  assert.equal(result.compliant, true); assert.equal(result.reviews, 80); assert.equal(result.repairs, 20)
  assert.deepEqual(result.accounting, f.accounting)
})
for (const [name, mutate] of [
  ['elapsed original600000 boundary', f => { f.cases[0].ledger.elapsedMs++ }],
  ['unknown actual usage', f => { f.cases[0].requests[0].usage = null }],
  ['unknown reservation', f => { f.cases[0].requests[0].ledger.state = 'unknown' }],
  ['unknown treated as zero', f => { f.cases[0].ledger.metrics.unknownUsageTreatedAsZero = 1 }],
  ['unsettled receipt', f => { f.cases[0].requests[0].state = 'unknown' }],
  ['missing beforeFetch fence', f => { f.cases[0].requests[0].fetchFence = false }],
  ['actual usage above admission', f => { f.cases[0].requests[0].usage.inputTokens = 12_001 }],
  ['output above reservation', f => { f.cases[0].requests[0].usage.outputTokens = 8193 }],
  ['per-case admission', f => { f.cases[0].requests[0].inputAdmission++ }],
  ['per-case reservation', f => { f.cases[0].requests[0].outputReservation++ }],
  ['per-case request cap', f => { f.cases[0].requests.push(copy(f.cases[0].requests[0])) }],
  ['aggregate counter mismatch', f => { f.accounting.requests-- }],
  ['missing original case', f => { f.cases.pop() }]
]) test(`independent budgets reject ${name}`, () => { const f = budgetFixture(); mutate(f); assert.throws(() => measureM09ExecutionBudgets(f.cases, f.accounting, f.limits), /M09_[A-Z0-9_]+/u) })

test('scoped manifest/lock preserve historical global protocol, assets and source/config/protocol bindings', async () => {
  const historicalBytes = await readFile(path.join(root, 'scripts/agentic/manifest.v2.json'))
  const historicalLockBytes = await readFile(path.join(root, 'scripts/agentic/manifest.v2.lock.json'))
  const frozen = await loadM09ScopedManifest(root, { verifySourceBindings: false })
  const historical = JSON.parse(historicalBytes)
  assert.equal(frozen.manifest.manifestVersion, 2)
  assert.deepEqual(frozen.manifest.configuration.reviewProtocol, historical.configuration.reviewProtocol)
  assert.deepEqual(frozen.manifest.configuration.semanticReviewProtocol, M09_SCOPED_PROTOCOL)
  assert.deepEqual(frozen.manifest.modules.M09.assets, historical.modules.M09.assets)
  assert.equal(Object.hasOwn(frozen.lock.hashes, 'sourceSha256'), false)
  assert.match(frozen.lock.m09.sourceSha256, /^[0-9a-f]{64}$/u)
  assert.equal(frozen.lock.m09.sourceHashMeaning, 'sha256-canonical-scoped-source-file-map-v1')
  assert.equal(frozen.lock.m09.sourceFiles['scripts/agentic/m09-quality-host.mjs'], semanticSha256(await readFile(path.join(root, 'scripts/agentic/m09-quality-host.mjs'))))
  assert.equal(semanticSha256(historicalBytes), '317399efba2720e236858ad2caa4f92e301f8b15a6f9c0c8dcfebadeeffa2d09')
  assert.equal(semanticSha256(Buffer.from(historicalBytes.toString('utf8').replaceAll('\r\n', '\n'))), '5207defd296efdd657b7d9bcb5e6dda7bc6f9c5112ed260e97f56a745fce3574')
  assert.equal(semanticSha256(historicalLockBytes), '81062babf88197cd5608638e6da5e144faa03e1aaf53904996446a5aa5a31767')
})

test('scoped lock rejects manifest, protocol, limits, private asset or source map tampering without reading any key', async t => {
  const temporary = await temporaryRoot(t); await mkdir(path.join(temporary, 'scripts/agentic'), { recursive: true })
  for (const name of ['scripts/agentic/manifest.v2.json', M09_MANIFEST_PATH, M09_LOCK_PATH]) await copyFile(path.join(root, name), path.join(temporary, name))
  const originalManifest = JSON.parse(await readFile(path.join(temporary, M09_MANIFEST_PATH)))
  const originalLock = JSON.parse(await readFile(path.join(temporary, M09_LOCK_PATH)))
  const mutations = [
    (manifest, lock) => { manifest.configuration.semanticReviewProtocol.model = 'gpt-6-luna' },
    (manifest, lock) => { manifest.modules.M09.limits.correctRepairsMin = 13 },
    (manifest, lock) => { manifest.modules.M09.assets[1].sha256 = '0'.repeat(64) },
    (manifest, lock) => { lock.m09.sourceFiles['scripts/agentic/m09-quality-host.mjs'] = '0'.repeat(64) },
    (manifest, lock) => { lock.m09.protocolSha256 = '0'.repeat(64) },
    (manifest, lock) => { lock.hashes.configurationSha256 = '0'.repeat(64) }
  ]
  for (const mutate of mutations) { const manifest = copy(originalManifest); const lock = copy(originalLock); mutate(manifest, lock); await writeFile(path.join(temporary, M09_MANIFEST_PATH), JSON.stringify(manifest)); await writeFile(path.join(temporary, M09_LOCK_PATH), JSON.stringify(lock)); await assert.rejects(loadM09ScopedManifest(temporary, { verifySourceBindings: false }), /M09_[A-Z0-9_]+/u) }
  assert.equal((await readdir(path.join(temporary, 'scripts/agentic'))).includes('datasets'), false)
})

test('canonical loader fails missing genuine E3b before settings access, launch or any native observation', async t => {
  const temporary = await temporaryRoot(t); const agentic = path.join(temporary, 'scripts/agentic'); await mkdir(agentic, { recursive: true })
  for (const name of ['m09-quality-host.mjs', 'semantic-review.mjs', 'semantic-review-score.mjs', 'm09-native-collaboration.mjs', 'm09-manifest.mjs']) await copyFile(path.join(root, 'scripts/agentic', name), path.join(agentic, name))
  const module = await import(pathToFileURL(path.join(agentic, 'm09-quality-host.mjs')).href)
  const external = createRootSupervisedM09NativeBridge(); const descriptor = { path: 'review-key.json', byteLength: 1, sha256: '0'.repeat(64) }
  const options = { sourceRoot: temporary, launchOptions: { repoRoot: temporary, settingsDirectory: path.join(temporary, 'never-open-settings'), profileId: '', reference: 'offline-loader-only', outputDirectory: path.join(temporary, 'never-create-output') }, nativeBridge: external.bridge, privateKeyBindings: { rootDir: path.join(temporary, 'scripts/agentic/datasets/v1'), reviewKey: descriptor, repairKey: { ...descriptor, path: 'repair-key.json' } } }
  await assert.rejects(module.createM09QualityHost(options), /M09_CANONICAL_E3B_UNAVAILABLE/u)
  assert.deepEqual(external.auditRecords(), [])
  assert.deepEqual((await readdir(temporary)).sort(), ['scripts'])
  await assert.rejects(module.createM09QualityHost({ ...options, launch: () => true }), /M09_HOST_CONFIGURATION_INVALID/u)
})

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
test('cancel during private score completion is permanently absorbing', async t => {
  const entered = deferred(); const release = deferred()
  const f = await fixture(t, { afterPrivateScore: async () => { entered.resolve(); await release.promise } })
  await f.throughJudgments()
  const scoring = f.driver.score(); await entered.promise
  assert.equal(f.driver.snapshot().phase, 'judgments-frozen')
  f.driver.cancel(); release.resolve()
  await assert.rejects(scoring, /M09_SESSION_FAILED/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  await assert.rejects(f.driver.gate(), /M09_PHASE_INVALID/u)
  await assert.rejects(captureM09QualitySession(f.driver), /M09_SAME_HOST_SCORED_SESSION_REQUIRED/u)
  assert.equal(f.driver.snapshot().diagnostics[0].code, 'M09_SESSION_CANCELLED')
})
test('cancel during delayed synthetic gate result cannot overwrite failed with gated', async t => {
  const entered = deferred(); const release = deferred()
  const f = await fixture(t, { syntheticGate: async () => { entered.resolve(); await release.promise } })
  await f.throughJudgments(); await f.driver.score()
  const gating = f.driver.gate(); await entered.promise
  f.driver.cancel(); release.resolve()
  await assert.rejects(gating, /M09_SESSION_FAILED/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  assert.equal(f.driver.snapshot().diagnostics[0].code, 'M09_SESSION_CANCELLED')
})
test('synthetic gate phase seam returns no real pass and retains no checker authority', async t => {
  const f = await fixture(t, { syntheticGate: async () => ({ status: 'pass' }) })
  await f.throughJudgments(); await f.driver.score()
  const observation = await f.driver.gate()
  assert.equal(observation.kind, 'synthetic-m09-gate'); assert.equal(observation.status, 'synthetic-complete'); assert.equal(observation.formalGate, false)
  await assert.rejects(captureM09QualitySession(f.driver), /M09_SAME_HOST_SCORED_SESSION_REQUIRED/u)
})

test('scoped bound reader rejects hardlinks, symlinks, traversal and oversized files', async t => {
  const temporary = await temporaryRoot(t)
  const filename = path.join(temporary, 'bound.json')
  await writeFile(filename, 'bounded public bytes')
  assert.equal((await readM09BoundFile(temporary, 'bound.json')).toString('utf8'), 'bounded public bytes')
  await assert.rejects(readM09BoundFile(temporary, '../bound.json'), /M09_BOUND_PATH_INVALID/u)
  await assert.rejects(readM09BoundFile(temporary, 'bound.json', 2), /M09_BOUND_FILE_UNAVAILABLE/u)
  await link(filename, path.join(temporary, 'hardlink.json'))
  await assert.rejects(readM09BoundFile(temporary, 'hardlink.json'), /M09_BOUND_FILE_UNAVAILABLE/u)
  await assert.rejects(readM09BoundFile(temporary, 'bound.json'), /M09_BOUND_FILE_UNAVAILABLE/u)
  const directory = path.join(temporary, 'real'); await mkdir(directory); await writeFile(path.join(directory, 'public.json'), 'public')
  const junction = path.join(temporary, 'junction')
  await symlink(directory, junction, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readM09BoundFile(temporary, 'junction/public.json'), /M09_BOUND_FILE_UNAVAILABLE/u)
})

test('delayed synthetic keys bind distinct raw CRLF bytes and normalized gate hashes', async t => {
  const f = await fixture(t, { keyCRLF: true })
  await f.throughJudgments()
  const raw = await readFile(path.join(f.root, 'review-key.json'))
  assert.notEqual(semanticSha256(raw), semanticSha256(Buffer.from(raw.toString('utf8').replaceAll('\r\n', '\n'))))
  assert.equal(f.privateKeyBindings.reviewKey.sha256, semanticSha256(raw))
  const result = await f.driver.score(); assert.equal(result.quality.review.recall, 1)
})
test('wrong normalized private hash fails only at delayed score even with valid raw descriptor', async t => {
  const f = await fixture(t, { normalizedHashMismatch: true }); await f.throughJudgments()
  assert.equal(f.driver.snapshot().phase, 'judgments-frozen')
  await assert.rejects(f.driver.score(), /M09_SESSION_VERIFICATION_FAILED/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
})
