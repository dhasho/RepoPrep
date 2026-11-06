import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node runner executes explicit TypeScript module paths.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner executes explicit TypeScript module paths.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node runner executes explicit TypeScript module paths.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner executes explicit TypeScript module paths.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node runner executes explicit TypeScript module paths.
import { estimateMessageTokens } from '../../../shared/token-budget.ts'

const profile = () => ({ id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49152, maxOutputTokens: 4096 })
function spec() {
  return createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: 'profile-01', model: 'synthetic', endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile().baseUrl)).digest('hex'), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
}
const messages = [{ role: 'user' as const, content: 'synthetic request' }]
const usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
const hasCode = (error: unknown, code: string): boolean => error instanceof WorkflowError && error.code === code

test('gateway validates private profile against normalized public model contract', () => {
  assert.doesNotThrow(() => createModelGateway(spec(), profile(), createBudgetLedger(spec())))
  assert.throws(() => createModelGateway(spec(), { ...profile(), model: 'other' }, createBudgetLedger(spec())), error => hasCode(error, 'configuration-changed'))
  assert.throws(() => createModelGateway(spec(), { ...profile(), baseUrl: 'https://elsewhere.invalid' }, createBudgetLedger(spec())), error => hasCode(error, 'configuration-changed'))
})

test('gateway bounds output, counts dispatch, and returns receipt without exposing credentials', async () => {
  const runSpec = spec(); const ledger = createBudgetLedger(runSpec)
  let capturedKey: string | undefined
  const mutableProfile = profile()
  const gateway = createModelGateway(runSpec, mutableProfile, ledger, { transport: async (selected, _messages, _delta, options) => {
    capturedKey = selected.apiKey
    assert.ok(options.maxOutputTokens! <= runSpec.generationOutputTokens)
    options.beforeRequest!()
    options.onUsage!(usage)
    return 'synthetic response'
  } })
  mutableProfile.apiKey = 'CHANGED_AFTER_FACTORY'
  const result = await gateway.complete({ id: 'request-1', stage: 'generation', messages })
  assert.equal(result.content, 'synthetic response')
  assert.deepEqual(result.usage, usage)
  assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().reservations[0].contextChars, messages[0].content.length)
  assert.equal(JSON.stringify(ledger.snapshot()).includes('SYNTHETIC_SECRET'), false)
  assert.equal(capturedKey, 'SYNTHETIC_SECRET')
})

test('gateway releases pre-request failure without counting an attempt', async () => {
  const ledger = createBudgetLedger(spec())
  const gateway = createModelGateway(spec(), profile(), ledger, { transport: async () => { throw new Error('synthetic serialization failure') } })
  await assert.rejects(gateway.complete({ id: 'pre-request', stage: 'generation', messages }))
  assert.equal(ledger.snapshot().total.dispatchedRequests, 0)
  assert.equal(ledger.snapshot().total.reservedRequests, 0)
})

test('gateway keeps dispatched failures and missing receipts reserved', async () => {
  const ledger = createBudgetLedger(spec())
  const gateway = createModelGateway(spec(), profile(), ledger, { transport: async (_p, _m, _d, options) => { options.beforeRequest!(); throw new Error('synthetic connection lost') } })
  await assert.rejects(gateway.complete({ id: 'dispatched-failure', stage: 'generation', messages }))
  assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().usageComplete, false)
})

test('gateway treats malformed partial receipt as unknown, never zero', async () => {
  const ledger = createBudgetLedger(spec())
  const gateway = createModelGateway(spec(), profile(), ledger, { transport: async (_p, _m, _d, options) => { options.beforeRequest!(); options.onUsage!({ inputTokens: 1 } as never); return 'response' } })
  await gateway.complete({ id: 'partial', stage: 'generation', messages })
  assert.equal(ledger.snapshot().total.inputTokens, ledger.snapshot().reservations[0].inputTokens)
  assert.equal(ledger.snapshot().metrics.unknownUsageTreatedAsZero, 0)
  assert.equal(ledger.snapshot().usageComplete, false)
})

test('gateway passes cancellation signal and keeps post-dispatch cancellation conservative', async () => {
  const controller = new AbortController(); const ledger = createBudgetLedger(spec())
  const gateway = createModelGateway(spec(), profile(), ledger, { transport: async (_p, _m, _d, options) => { options.beforeRequest!(); assert.equal(options.signal, controller.signal); throw new Error('synthetic cancellation') } })
  await assert.rejects(gateway.complete({ id: 'cancelled', stage: 'generation', messages, signal: controller.signal }))
  assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().usageComplete, false)
})

test('gateway default stream transport invokes the pre-request guard before synthetic fetch', async () => {
  const runSpec = spec(); const ledger = createBudgetLedger(runSpec)
  const originalFetch = globalThis.fetch
  let fetchCount = 0; let dispatchedAtFetch = 0; let payloadJson = ''
  globalThis.fetch = async (_input, init) => {
    fetchCount++
    dispatchedAtFetch = ledger.snapshot().total.dispatchedRequests
    payloadJson = String(init?.body)
    return new Response(JSON.stringify({
      usage: { prompt_tokens: estimateMessageTokens(messages), completion_tokens: 3 },
      choices: [{ message: { content: 'synthetic default transport' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const gateway = createModelGateway(runSpec, profile(), ledger)
    const result = await gateway.complete({ id: 'default-transport', stage: 'generation', messages })
    assert.equal(fetchCount, 1)
    assert.equal(dispatchedAtFetch, 1)
    assert.equal((JSON.parse(payloadJson) as Record<string, unknown>).max_tokens, runSpec.generationOutputTokens)
    assert.equal(result.content, 'synthetic default transport')
    assert.deepEqual(result.usage, { inputTokens: estimateMessageTokens(messages), outputTokens: 3, totalTokens: estimateMessageTokens(messages) + 3 })
    assert.deepEqual(ledger.snapshot().total.actualProviderUsage, result.usage)
  } finally { globalThis.fetch = originalFetch }
})

test('gateway rejects unguarded successful transports while retaining their reservation', async () => {
  const ledger = createBudgetLedger(spec())
  const gateway = createModelGateway(spec(), profile(), ledger, { transport: async () => 'free synthetic result' })
  await assert.rejects(gateway.complete({ id: 'unguarded', stage: 'generation', messages }), error => hasCode(error, 'model-failed'))
  const state = ledger.snapshot()
  assert.equal(state.total.dispatchedRequests, 0)
  assert.equal(state.total.reservedRequests, 1)
  assert.equal(state.usageComplete, false)
})

test('gateway blocks a private-key echo split across stream deltas', async () => {
  const ledger = createBudgetLedger(spec()); const emitted: string[] = []
  const gateway = createModelGateway(spec(), profile(), ledger, { transport: async (_p, _m, onDelta, options) => {
    options.beforeRequest!()
    await onDelta('safe prefix SYNTHETIC_')
    await onDelta('SECRET safe suffix')
    options.onUsage!(usage)
    return 'safe prefix SYNTHETIC_SECRET safe suffix'
  } })
  await assert.rejects(gateway.complete({ id: 'delta-key-echo', stage: 'generation', messages, onDelta: delta => { emitted.push(delta) } }), error => hasCode(error, 'model-failed') && error instanceof Error && !error.message.includes('SYNTHETIC_SECRET'))
  assert.equal(emitted.join('').includes('SYNTHETIC_SECRET'), false)
  assert.equal(ledger.snapshot().usageComplete, false)
})

test('gateway blocks a private-key echo in default JSON completion content', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ usage, choices: [{ message: { content: 'SYNTHETIC_SECRET' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const gateway = createModelGateway(spec(), profile(), createBudgetLedger(spec()))
    await assert.rejects(gateway.complete({ id: 'json-key-echo', stage: 'generation', messages }), error => hasCode(error, 'model-failed') && error instanceof Error && !error.message.includes('SYNTHETIC_SECRET'))
  } finally { globalThis.fetch = originalFetch }
})

test('gateway bounds aggregate characters and investigation input separately', async () => {
  let calls = 0
  const runSpec = spec(); const ledger = createBudgetLedger(runSpec)
  const gateway = createModelGateway(runSpec, profile(), ledger, { transport: async () => { calls++; return 'unused' } })
  await assert.rejects(gateway.complete({ id: 'oversized-global-context', stage: 'generation', messages: [{ role: 'user', content: 'x'.repeat(160_001) }] }), error => hasCode(error, 'budget-exhausted'))
  await assert.rejects(gateway.complete({ id: 'oversized-investigation-context', stage: 'investigation', messages: [{ role: 'user', content: 'x'.repeat(72_001) }] }), error => hasCode(error, 'budget-exhausted'))
  assert.equal(calls, 0)
  assert.equal(ledger.snapshot().total.dispatchedRequests, 0)
})

test('gateway timeout is bounded by the remaining investigation deadline', async () => {
  let time = 0
  const runSpec = spec(); const ledger = createBudgetLedger(runSpec, { clock: () => time })
  const gateway = createModelGateway(runSpec, profile(), ledger, { transport: async (_p, _m, _d, options) => {
    assert.equal(options.timeoutMs, 10_000)
    options.beforeRequest!(); options.onUsage!(usage); return 'response'
  } })
  time = 170_000
  await gateway.complete({ id: 'bounded-investigation-timeout', stage: 'investigation', messages })
})

test('gateway rejects responses completed beyond either hard deadline while settling known usage', async () => {
  for (const scenario of [
    { stage: 'investigation' as const, deadline: 180_000 },
    { stage: 'generation' as const, deadline: 600_000 }
  ]) {
    let time = 0
    const runSpec = spec(); const ledger = createBudgetLedger(runSpec, { clock: () => time })
    const gateway = createModelGateway(runSpec, profile(), ledger, { transport: async (_p, _m, _d, options) => {
      options.beforeRequest!()
      options.onUsage!(usage)
      time = scenario.deadline
      return 'late response'
    } })
    await assert.rejects(gateway.complete({ id: `late-${scenario.stage}`, stage: scenario.stage, messages }), error => hasCode(error, 'budget-exhausted'))
    assert.equal(ledger.snapshot().usageComplete, true)
    assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
    assert.deepEqual(ledger.snapshot().total.actualProviderUsage, usage)
  }
})

test('gateway retries and compensation share actual request cap', async () => {
  const runSpec = createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: 'profile-01', model: 'synthetic', endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile().baseUrl)).digest('hex'), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { maxModelRequests: 2 } })
  const ledger = createBudgetLedger(runSpec)
  const gateway = createModelGateway(runSpec, profile(), ledger, { transport: async (_p, _m, _d, options) => { options.beforeRequest!(); options.onUsage!(usage); return 'response' } })
  await gateway.complete({ id: 'attempt-1', stage: 'generation', messages })
  await gateway.complete({ id: 'attempt-2', stage: 'compensation', messages })
  assert.equal(ledger.snapshot().total.dispatchedRequests, 2)
  await assert.rejects(gateway.complete({ id: 'attempt-3', stage: 'repair', messages }))
  assert.equal(ledger.snapshot().total.dispatchedRequests, 2)
})
