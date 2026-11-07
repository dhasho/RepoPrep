import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { recomputeRetrievalMetrics, verifyRetrievalReport, runRetrievalEvaluation, verifyProfileBinding, evaluationConfigFingerprint, evaluationRunConfigFingerprint, createGlobalBudgetCollector, createGuardedTransport, createOneShotAuthorizationClaim, createRetrievalRunSpec, loadRetrievalBundle, validateRetrievalBundle, sanitizeModelFailure, RETRIEVAL_LIMITS } from './retrieval-eval.mjs'
import { normalizeBaseUrl } from '../../electron/services/llm.ts'
import { createBudgetLedger } from '../../electron/services/workflow/budget-ledger.ts'
import { createModelGateway } from '../../electron/services/workflow/model-gateway.ts'
import { createRunSpec } from '../../electron/services/workflow/run-spec.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await loadRetrievalBundle(path.join(root, 'scripts/agentic/datasets/v1'))
assert.equal(validateRetrievalBundle(bundle).valid, true)
assert.deepEqual(Object.keys(bundle), ['projects', 'retrievalTasks', 'retrievalLabels'])
const projects = new Map(bundle.projects.projects.map(project => [project.id, project]))

function evaluatorOnlyEvidence(taskId) {
  const task = bundle.retrievalTasks.tasks.find(item => item.id === taskId)
  const project = projects.get(task.projectId)
  const label = bundle.retrievalLabels.labels.find(item => item.taskId === taskId)
  const refs = label.requiredEvidenceGroups.flatMap(group => group.allOf)
  return refs.map((ref, index) => {
    const source = project.files.find(file => file.path === ref.path).content
    const content = source.split('\n').slice(ref.startLine - 1, ref.endLine).join('\n')
    const hex = createHash('sha256').update(`${taskId}-${index}`).digest('hex')
    const id = `ev_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    return { id, path: ref.path, startLine: ref.startLine, endLine: ref.endLine, contentHash: createHash('sha256').update(content).digest('hex'), sourceKind: 'code', readStatus: 'complete', parseStatus: task.indexMode === 'unavailable' ? 'unavailable' : 'parsed', omission: 'none' }
  })
}

function completeReceipt() {
  return { requests: 1, providerUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, knownProviderUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, chargedTokens: { inputTokens: 10, outputTokens: 10 }, usageComplete: true, readBytes: 100, elapsedMs: 100, readRequests: 4, repeatedReads: 0, invalidToolExecutions: 0, overspend: { inputTokens: 0, outputTokens: 0, readBytes: 0 }, blocked: false, reservations: [{ id: 'inv-00000000-0000-4000-8000-000000000000', stage: 'investigation', state: 'settled', reservedInputTokens: 20, reservedOutputTokens: 2000, contextChars: 80, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } }] }
}

function syntheticReport() {
  const provider = { endpointFingerprint: 'a'.repeat(64), model: 'synthetic-model', protocol: 'openai', temperature: 0.4, reasoningEffort: null, contextWindowTokens: 49152, maxOutputTokensPerRequest: 2000 }
  return { schemaVersion: 1, mode: 'synthetic', purpose: 'm06-retrieval-v1', provider, configurationFingerprint: evaluationConfigFingerprint(provider), runs: bundle.retrievalTasks.tasks.flatMap(task => [1, 2].map(repeat => { const evidence = evaluatorOnlyEvidence(task.id); return { taskId: task.id, repeat, status: 'completed', stopReason: 'finished', condition: { indexMode: task.indexMode, indexStatus: task.indexMode === 'unavailable' ? 'unavailable' : 'available' }, retrievedEvidence: evidence, selectedEvidence: evidence, runConfigFingerprint: evaluationRunConfigFingerprint(task, provider), receipt: completeReceipt() } })) }
}

test('recomputes coverage from selected source ranges and rejects synthetic mode as a real gate report', () => {
  const report = syntheticReport()
  const metrics = recomputeRetrievalMetrics(report, bundle)
  assert.equal(metrics.runCount, 40)
  assert.equal(metrics.uniqueCells, 40)
  assert.equal(metrics.completeEvidenceTaskRate, 1)
  assert.equal(metrics.usageComplete, true)
  const verified = verifyRetrievalReport(report, bundle)
  assert.equal(verified.valid, false)
  assert.ok(verified.issues.includes('report-not-real'))
})

test('partial, duplicated, malformed, or over-budget receipts cannot pass the frozen matrix', () => {
  const report = syntheticReport()
  report.runs.pop()
  report.runs.push({ ...report.runs[0], selectedEvidence: [] })
  report.runs[1] = { ...report.runs[1], receipt: { ...completeReceipt(), requests: 4, repeatedReads: 40 } }
  const metrics = recomputeRetrievalMetrics(report, bundle)
  assert.equal(metrics.runCount, 40)
  assert.ok(metrics.uniqueCells < 40)
  assert.ok(metrics.completeEvidenceTaskRate < 1)
  assert.equal(metrics.usageComplete, false)
  assert.ok(metrics.limitViolations > 0)
  assert.ok(metrics.repeatedReadRate > RETRIEVAL_LIMITS.repeats)
  const truncated = syntheticReport()
  truncated.runs.pop()
  assert.equal(recomputeRetrievalMetrics(truncated, bundle).completeEvidenceTaskRate, 39 / 40)
})

test('incomplete usage keeps exact totals unknown and reports settled usage plus conservative charges', () => {
  const report = syntheticReport()
  const receipt = completeReceipt()
  receipt.requests = 2
  receipt.providerUsage = null
  receipt.usageComplete = false
  receipt.knownProviderUsage = { inputTokens: 846, outputTokens: 401, totalTokens: 1247 }
  receipt.chargedTokens = { inputTokens: 18000, outputTokens: 4000 }
  receipt.reservations[0] = { ...receipt.reservations[0], reservedInputTokens: 1000, usage: { inputTokens: 846, outputTokens: 401, totalTokens: 1247 } }
  receipt.reservations.push({ id: 'inv-00000000-0000-4000-8000-000000000001', stage: 'investigation', state: 'unknown', reservedInputTokens: 9000, reservedOutputTokens: 2000, contextChars: 120, usage: null })
  report.runs[0].receipt = receipt

  const metrics = recomputeRetrievalMetrics(report, bundle)
  assert.equal(metrics.usageComplete, false)
  assert.equal(metrics.inputTokens, null)
  assert.equal(metrics.outputTokens, null)
  assert.equal(metrics.knownInputTokens, 1236)
  assert.equal(metrics.knownOutputTokens, 791)
  assert.equal(metrics.unknownRequests, 1)
  assert.equal(metrics.chargedInputTokens, 18390)
  assert.equal(metrics.chargedOutputTokens, 4390)
  assert.ok(verifyRetrievalReport(report, bundle).issues.includes('receipt-or-limit-invalid'))
})

test('incomplete matrix reports missing cells without labeling them duplicate', () => {
  const report = syntheticReport()
  report.runs.pop()
  const verified = verifyRetrievalReport(report, bundle)
  assert.ok(verified.issues.includes('run-matrix-incomplete'))
  assert.ok(!verified.issues.includes('run-matrix-duplicate'))
})

test('unavailable failed-run evidence stays null and does not break aggregate accounting', () => {
  const report = syntheticReport()
  report.runs[0] = { ...report.runs[0], retrievedEvidence: null, retrievedCount: null, selectedEvidence: null, selectedCount: null }
  const metrics = recomputeRetrievalMetrics(report, bundle)
  assert.equal(metrics.usageComplete, true)
  assert.equal(metrics.inputTokens, 400)
  assert.ok(metrics.invalidToolExecution > 0)
})

test('model failure diagnostics retain only allowlisted scalar metadata', () => {
  assert.deepEqual(sanitizeModelFailure({ kind: 'http', httpStatus: 429, finishReason: 'length', message: 'secret', body: 'private' }), { kind: 'http', httpStatus: 429, finishReason: 'length' })
  assert.equal(sanitizeModelFailure({ kind: 'unknown', httpStatus: 429 }), null)
  assert.deepEqual(sanitizeModelFailure({ kind: 'network', httpStatus: 999, finishReason: 'secret' }), { kind: 'network' })
})

test('verifier binds selected metadata to retrieved metadata and enforces unavailable index conditions', () => {
  const report = syntheticReport()
  const first = report.runs[0]
  first.selectedEvidence[0] = { ...first.selectedEvidence[0], path: 'redirected.ts' }
  const indexFailure = report.runs.find(cell => bundle.retrievalTasks.tasks.find(task => task.id === cell.taskId)?.indexMode === 'unavailable')
  indexFailure.condition.indexStatus = 'available'
  indexFailure.retrievedEvidence.forEach(item => { item.parseStatus = 'parsed' })
  const metrics = recomputeRetrievalMetrics(report, bundle)
  assert.ok(metrics.invalidToolExecution > 0)
  assert.ok(metrics.completeEvidenceTaskRate < 1)
})

test('real runner blocks missing authorization before reading or invoking a profile', async () => {
  let touched = false
  const profile = new Proxy({}, { get() { touched = true; throw new Error('must-not-touch-profile') } })
  await assert.rejects(runRetrievalEvaluation({ repoRoot: root, outputDir: path.join(root, '.validation/agentic/unused'), profile }), /authorization-required/)
  assert.equal(touched, false)
})

test('profile binding uses synthetic metadata and limits only an in-memory clone', () => {
  const profile = { id: 'synthetic-profile', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-model', protocol: 'openai', temperature: 0.4, contextWindowTokens: 49152 }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  const auth = { endpointFingerprint, model: profile.model, protocol: profile.protocol, temperature: 0.4, reasoningEffort: null, contextWindowTokens: profile.contextWindowTokens }
  const clone = verifyProfileBinding(profile, auth)
  assert.equal(clone.maxOutputTokens, RETRIEVAL_LIMITS.perRequestOutputTokens)
  assert.equal(profile.maxOutputTokens, undefined)
  assert.throws(() => verifyProfileBinding({ ...profile, baseUrl: 'https://other.invalid/v1' }, auth), /profile-binding-mismatch/)
})

test('guarded default transport calls the M05 guard once and makes one mocked .invalid fetch', async () => {
  const profile = { id: 'synthetic-profile', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-model', protocol: 'openai', temperature: 0.4, contextWindowTokens: 49152, maxOutputTokens: 2000 }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  const spec = createRunSpec({ version: 1, runId: 'test-run', projectId: 'test-project', snapshotId: 'test-snapshot', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, endpointFingerprint, model: profile.model, protocol: 'openai', temperature: 0.4, contextWindowTokens: 49152, maxOutputTokens: 2000 }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { maxModelRequests: 3, inputTokens: 128000, outputTokens: 10000, readBytes: 2 * 1024 * 1024, wallClockMs: 180000 } })
  const ledger = createBudgetLedger(spec)
  const collector = createGlobalBudgetCollector({ maxRequests: 3, maxInputTokens: 18000, maxOutputTokens: 6000 })
  const events = []
  const journal = []
  let dispatches = 0, fetches = 0
  const priorFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    fetches++
    assert.match(String(input), /^https:\/\/provider\.invalid\//u)
    assert.equal(init.method, 'POST')
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"actions":[]}' } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const guarded = createGuardedTransport({ collector, runId: 'test-run', getReservation: () => ledger.snapshot().reservations.find(item => item.state === 'reserved' && item.stage === 'investigation'), appendJournal: event => journal.push(event) })
    const gateway = createModelGateway(spec, profile, ledger, { transport: guarded, trace: event => { events.push(event); if (event.type === 'dispatched') dispatches++ } })
    const completion = await gateway.complete({ id: 'decision-1', stage: 'investigation', messages: [{ role: 'user', content: 'synthetic test only' }] })
    assert.equal(completion.content, '{"actions":[]}')
    assert.deepEqual(completion.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 })
    assert.equal(dispatches, 1)
    assert.equal(fetches, 1)
    assert.equal(collector.snapshot().admittedRequests, 1)
    assert.equal(collector.snapshot().reservedInputTokens, 0)
    assert.equal(collector.snapshot().actualInputTokens, 7)
    assert.deepEqual(journal.map(event => event.type), ['request-admitted', 'provider-usage'])
  } finally { globalThis.fetch = priorFetch }
})

test('actual retrieval RunSpec admits the first investigation request in every granularity', async () => {
  const profile = { id: 'synthetic-profile', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-model', protocol: 'openai', temperature: 0.4, contextWindowTokens: 49152, maxOutputTokens: 2000 }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  const priorFetch = globalThis.fetch
  let fetchCount = 0
  globalThis.fetch = async (input, init) => {
    fetchCount++
    assert.match(String(input), /^https:\/\/provider\.invalid\//u)
    assert.equal(init.method, 'POST')
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"actions":[]}' } }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    for (const granularity of ['coarse', 'medium', 'fine']) {
      const task = { id: `budget-${granularity}`, projectId: 'budget-project', objective: 'synthetic test objective', roleFocus: 'backend', granularity, indexMode: 'normal' }
      const snapshot = { projectId: task.projectId, snapshotId: `snapshot-${granularity}` }
      const spec = createRetrievalRunSpec(task, profile, snapshot, `run-${granularity}`)
      assert.equal(spec.budget.total.inputTokens, 128_000)
      assert.equal(spec.budget.total.outputTokens, 65_536)
      assert.equal(spec.budget.total.wallClockMs, 600_000)
      assert.equal(spec.budget.investigation.maxModelRequests, 3)
      assert.equal(spec.budget.investigation.maxToolCalls, 8)
      assert.equal(spec.budget.investigation.inputTokens, 18_000)
      assert.equal(spec.budget.investigation.outputTokens, 6_000)
      assert.equal(spec.budget.investigation.readBytes, 2 * 1024 * 1024)
      assert.equal(spec.budget.investigation.wallClockMs, 180_000)
      const ledger = createBudgetLedger(spec)
      const collector = createGlobalBudgetCollector({ maxRequests: 120, maxInputTokens: 720_000, maxOutputTokens: 240_000 })
      const guarded = createGuardedTransport({ collector, runId: spec.runId, getReservation: () => ledger.snapshot().reservations.find(item => item.state === 'reserved' && item.stage === 'investigation'), appendJournal: () => {} })
      const gateway = createModelGateway(spec, profile, ledger, { transport: guarded })
      const completion = await gateway.complete({ id: `decision-${granularity}`, stage: 'investigation', messages: [{ role: 'user', content: 'synthetic only' }] })
      assert.equal(completion.content, '{"actions":[]}')
      assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
      assert.equal(collector.snapshot().admittedRequests, 1)
    }
    assert.equal(fetchCount, 3)
  } finally { globalThis.fetch = priorFetch }
})

test('global collector refunds known reservations and blocks unknown usage without treating it as zero', () => {
  const known = createGlobalBudgetCollector({ maxRequests: 2, maxInputTokens: 100, maxOutputTokens: 100 })
  const first = known.admit('run-1', { id: 'call-1', estimatedInputTokens: 80, outputTokens: 60, contextChars: 200 })
  known.settle(first, { inputTokens: 10, outputTokens: 20, totalTokens: 30 })
  assert.equal(known.snapshot().reservedInputTokens, 0)
  assert.equal(known.snapshot().actualInputTokens, 10)
  const second = known.admit('run-2', { id: 'call-2', estimatedInputTokens: 90, outputTokens: 80, contextChars: 240 })
  assert.equal(second.estimatedInputTokens, 90)

  const unknown = createGlobalBudgetCollector({ maxRequests: 2, maxInputTokens: 100, maxOutputTokens: 100 })
  const paidUnknown = unknown.admit('run-1', { id: 'call-unknown', estimatedInputTokens: 70, outputTokens: 50, contextChars: 140 })
  unknown.markUnknown(paidUnknown)
  assert.equal(unknown.snapshot().actualInputTokens, 0)
  assert.equal(unknown.snapshot().reservedInputTokens, 70)
  assert.equal(unknown.snapshot().blocked, true)
  assert.throws(() => unknown.admit('run-2', { id: 'call-2', estimatedInputTokens: 1, outputTokens: 1 }))
})

test('missing usage blocks the controller transport immediately and does not admit a second attempt', async () => {
  const profile = { id: 'synthetic-profile', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-model', protocol: 'openai', temperature: 0.4, contextWindowTokens: 49152, maxOutputTokens: 2000 }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  const spec = createRunSpec({ version: 1, runId: 'unknown-run', projectId: 'test-project', snapshotId: 'test-snapshot', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, endpointFingerprint, model: profile.model, protocol: 'openai', temperature: 0.4, contextWindowTokens: 49152, maxOutputTokens: 2000 }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { maxModelRequests: 3, inputTokens: 128000, outputTokens: 10000, readBytes: 2 * 1024 * 1024, wallClockMs: 180000 } })
  const ledger = createBudgetLedger(spec), collector = createGlobalBudgetCollector({ maxRequests: 3, maxInputTokens: 18000, maxOutputTokens: 6000 })
  let transportAttempts = 0
  const guarded = createGuardedTransport({ collector, runId: 'unknown-run', getReservation: () => ledger.snapshot().reservations.find(item => item.state === 'reserved' && item.stage === 'investigation'), appendJournal: () => {}, transport: async (_profile, _messages, _onDelta, options) => { transportAttempts++; options.beforeRequest(); return 'synthetic response without usage' } })
  const gateway = createModelGateway(spec, profile, ledger, { transport: guarded })
  await assert.rejects(gateway.complete({ id: 'decision-1', stage: 'investigation', messages: [{ role: 'user', content: 'synthetic only' }] }))
  assert.equal(collector.snapshot().blocked, true)
  assert.ok(collector.snapshot().reservedInputTokens > 0)
  await assert.rejects(gateway.complete({ id: 'decision-2', stage: 'investigation', messages: [{ role: 'user', content: 'must not send' }] }))
  assert.equal(transportAttempts, 1)
  assert.equal(collector.snapshot().admittedRequests, 1)
})

test('authorization claims are atomic and one-shot, including interrupted runs', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm06-claim-test-'))
  const claimsDir = path.join(temp, 'claims')
  await mkdir(claimsDir)
  const binding = { reference: 'offline-approval', sourceCommit: 'a'.repeat(40), retrievalDataHash: 'b'.repeat(64) }
  try {
    const first = await createOneShotAuthorizationClaim(claimsDir, binding)
    assert.equal(first.reference, binding.reference)
    await assert.rejects(createOneShotAuthorizationClaim(claimsDir, binding), error => error?.code === 'EEXIST')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('sanitized child environment can secure a private temp directory without username variables', async () => {
  const launcherPath = path.join(root, 'scripts/evaluation/run-retrieval-profile.cjs')
  const { safeEnv } = createRequire(import.meta.url)(launcherPath)
  const environment = safeEnv({ ...process.env, API_KEY: 'SYNTHETIC_SECRET', NODE_OPTIONS: '--require unexpected', ELECTRON_RUN_AS_NODE: '1' })
  for (const key of ['API_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'USERNAME', 'USERDOMAIN']) assert.equal(Object.hasOwn(environment, key), false)
  const folder = await mkdtemp(path.join(os.tmpdir(), 'm06-runtime-acl-'))
  try {
    const child = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).secureTemporaryDirectory(process.argv[2]);process.stdout.write("secured")', launcherPath, folder], { env: environment, encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 0, 'private-runtime preparation must work in the actual sanitized child environment')
    assert.equal(child.stdout, 'secured')
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()))
    assert.match(path.basename(folder), /^m06-runtime-acl-/u)
    await rm(folder, { recursive: true, force: true })
  }
})
