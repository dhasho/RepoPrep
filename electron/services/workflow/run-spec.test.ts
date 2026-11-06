// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { test } from 'node:test'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createRunSpec, fingerprintRunSpec } from './run-spec.ts'

const validInput = () => ({
  version: 1,
  runId: 'run-01',
  projectId: 'project-01',
  snapshotId: 'snapshot-01',
  strategy: 'agentic',
  strategyVersion: 'agentic-v1',
  roleFocus: 'backend',
  granularity: 'fine',
  model: {
    profileId: 'profile-01',
    model: 'example-model',
    protocol: 'openai',
    reasoningEffort: 'high',
    contextWindowTokens: 49_152,
    maxOutputTokens: 4096
  },
  promptVersion: 'workflow-prompt-v1',
  toolVersion: 'read-tools-v1',
  policyVersion: 'read-policy-v1'
})

test('accepts a valid spec with fixed question and total/investigation budgets', () => {
  const spec = createRunSpec(validInput())
  assert.equal(spec.questionBudget.target, 32)
  assert.equal(spec.budget.total.maxModelRequests, 14)
  assert.equal(spec.budget.investigation.maxModelRequests, 3)
  assert.equal(spec.budget.investigation.maxToolCalls, 8)
  assert.equal(spec.budget.investigation.inputTokens, 18_000)
  assert.equal(spec.budget.investigation.outputTokens, 6_000)
  assert.equal(spec.budget.investigation.readBytes, 2 * 1024 * 1024)
  assert.equal(spec.budget.investigation.wallClockMs, 180_000)
  assert.equal(spec.budget.total.inputTokens, 128_000)
  assert.equal(spec.budget.total.outputTokens, 65_536)
  assert.equal(spec.budget.total.wallClockMs, 600_000)
  assert.ok(spec.budget.generationReserve.maxModelRequests >= 11)
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.model) && Object.isFrozen(spec.budget.total))
  assert.throws(() => { (spec.model as { model: string }).model = 'changed' }, TypeError)
})

test('fingerprint is stable, normalized and intentionally excludes run/project/snapshot identity', () => {
  const first = createRunSpec(validInput())
  const changedIdentity = createRunSpec({ ...validInput(), runId: 'run-02', projectId: 'project-02', snapshotId: 'snapshot-02' })
  assert.equal(fingerprintRunSpec(first), fingerprintRunSpec(changedIdentity))
  assert.match(fingerprintRunSpec(first), /^[a-f0-9]{64}$/)
  assert.notEqual(fingerprintRunSpec(first), fingerprintRunSpec(createRunSpec({ ...validInput(), promptVersion: 'workflow-prompt-v2' })))
})

test('rejects the exact 12 invalid cases in the M01 plan gate without echoing input', () => {
  const invalidCases: Array<[string, () => unknown]> = [
    ['missing identity', () => { const input = validInput() as Record<string, unknown>; delete input.projectId; return input }],
    ['malformed identity', () => ({ ...validInput(), runId: '../secret' })],
    ['unknown strategy', () => ({ ...validInput(), strategy: 'dynamic' })],
    ['unknown role', () => ({ ...validInput(), roleFocus: 'manager' })],
    ['unknown granularity', () => ({ ...validInput(), granularity: 'ultra' })],
    ['negative budget', () => ({ ...validInput(), budget: { inputTokens: -1 } })],
    ['non-finite budget', () => ({ ...validInput(), budget: { inputTokens: Number.POSITIVE_INFINITY } })],
    ['output reserve exceeds model window', () => ({ ...validInput(), model: { ...validInput().model, contextWindowTokens: 4096, maxOutputTokens: 4096 } })],
    ['illegal output reserve exceeds global output cap', () => ({ ...validInput(), model: { ...validInput().model, maxOutputTokens: 65_537 } })],
    ['renderer supplied private key', () => ({ ...validInput(), model: { ...validInput().model, apiKey: 'do-not-echo' } })],
    ['unknown nested action field', () => ({ ...validInput(), model: { ...validInput().model, action: 'shell' } })],
    ['incompatible strategy version', () => ({ ...validInput(), strategyVersion: 'agentic-v2' })]
  ]
  assert.equal(invalidCases.length, 12)
  for (const [name, input] of invalidCases) {
    assert.throws(() => createRunSpec(input()), (error: unknown) => {
      assert.ok(error instanceof Error, name)
      assert.equal(error.message, 'Invalid RunSpec input.', name)
      assert.equal(error.message.includes('do-not-echo'), false, name)
      return true
    }, name)
  }
})

test('rejects unsupported global limits and keeps a narrowed request within ceilings', () => {
  assert.throws(() => createRunSpec({ ...validInput(), budget: { inputTokens: 128_001 } }))
  const minimalCalls = createRunSpec({ ...validInput(), budget: { maxModelRequests: 1 } })
  assert.equal(minimalCalls.budget.investigation.maxModelRequests, 0)
  assert.equal(minimalCalls.budget.generationReserve.maxModelRequests, 1)
  assert.throws(() => createRunSpec({ ...validInput(), budget: { inputTokens: 0 } }))
  assert.throws(() => createRunSpec({ ...validInput(), budget: { wallClockMs: 0 } }))

  const deepseek = createRunSpec({
    ...validInput(),
    granularity: 'medium',
    model: { profileId: 'profile-01', model: 'deepseek-flash' },
    budget: { outputTokens: 65_536 }
  })
  assert.equal(deepseek.generationOutputTokens, 65_536)
  assert.equal(deepseek.budget.investigation.outputTokens, 0)
  assert.equal(deepseek.budget.generationReserve.outputTokens, 65_536)

  const tightened = createRunSpec({
    ...validInput(),
    granularity: 'coarse',
    model: { profileId: 'profile-01', model: 'small-window', contextWindowTokens: 4096, maxOutputTokens: 2048 },
    budget: { maxModelRequests: 2, inputTokens: 4096, outputTokens: 4096, readBytes: 512, wallClockMs: 1000 }
  })
  assert.equal(tightened.budget.investigation.maxModelRequests, 1)
  assert.equal(tightened.budget.generationReserve.maxModelRequests, 1)
  assert.equal(tightened.budget.investigation.inputTokens, 2048)
  assert.equal(tightened.budget.generationReserve.inputTokens, tightened.generationInputTokens)
  assert.equal(tightened.budget.investigation.outputTokens, 2048)
  assert.equal(tightened.budget.generationReserve.outputTokens, tightened.generationOutputTokens)
  assert.equal(tightened.budget.generationReserve.readBytes, 0)
  assert.equal(tightened.budget.generationReserve.wallClockMs, 1)
})

test('rejects accessor based input without invoking the getter', () => {
  const input = validInput() as Record<string, unknown>
  let invoked = false
  Object.defineProperty(input, 'projectId', { enumerable: true, get() { invoked = true; return 'project-01' } })
  assert.throws(() => createRunSpec(input))
  assert.equal(invoked, false)
})
