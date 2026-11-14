import assert from 'node:assert/strict'
import { createRunSpec, fingerprintRunSpec } from '../../../electron/services/workflow/run-spec.ts'
import { GRANULARITY_QUESTION_BUDGET } from '../../../shared/types.ts'

function input() {
  return {
    version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01',
    strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine',
    model: { profileId: 'profile-01', model: 'synthetic', endpointFingerprint: 'a'.repeat(64), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 },
    promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1'
  }
}

const invalidCases = [
  ['missing-identity', () => { const value = input(); delete value.projectId; return value }],
  ['malformed-identity', () => ({ ...input(), runId: '../outside' })],
  ['unknown-policy', () => ({ ...input(), strategy: 'unknown' })],
  ['unknown-role', () => ({ ...input(), roleFocus: 'unknown' })],
  ['unknown-granularity', () => ({ ...input(), granularity: 'unknown' })],
  ['negative-budget', () => ({ ...input(), budget: { inputTokens: -1 } })],
  ['non-finite-budget', () => ({ ...input(), budget: { inputTokens: Infinity } })],
  ['window-overflow', () => ({ ...input(), model: { ...input().model, contextWindowTokens: 4096, maxOutputTokens: 4096 } })],
  ['output-reserve', () => ({ ...input(), model: { ...input().model, maxOutputTokens: 65537 } })],
  ['renderer-private-key', () => ({ ...input(), model: { ...input().model, apiKey: 'SYNTHETIC_SECRET' } })],
  ['unknown-action', () => ({ ...input(), action: 'shell' })],
  ['incompatible-config-version', () => ({ ...input(), version: 2 })]
]

export function createChecks() {
  let rejected = 0
  const checks = new Map()
  checks.set('m01:valid-spec-accepted', ctx => {
    for (const granularity of ['coarse', 'medium', 'fine']) {
      const spec = createRunSpec({ ...input(), granularity })
      assert.deepEqual(spec.questionBudget, GRANULARITY_QUESTION_BUDGET[granularity])
      assert.equal(spec.budget.total.maxModelRequests, granularity === 'fine' ? 14 : 5)
      assert.equal(spec.budget.total.inputTokens, 128000)
      assert.equal(spec.budget.total.outputTokens, 65536)
      assert.equal(spec.budget.total.wallClockMs, 600000)
      assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.model) && Object.isFrozen(spec.questionBudget) && Object.isFrozen(spec.budget))
      for (const stage of ['total', 'investigation', 'generationReserve']) assert.ok(Object.isFrozen(spec.budget[stage]))
      assert.ok(spec.budget.generationReserve.maxModelRequests >= 1)
      assert.ok(spec.budget.generationReserve.inputTokens >= spec.generationInputTokens)
      assert.ok(spec.budget.generationReserve.outputTokens >= spec.generationOutputTokens)
    }
    ctx.recordMetric('validSpecAccepted', true, 'assertion:m01:three-granularities')
    return { granularities: 3 }
  })
  for (const [id, makeInvalid] of invalidCases) checks.set(`m01:invalid:${id}`, ctx => {
    assert.throws(() => createRunSpec(makeInvalid()), error => error instanceof Error && error.message === 'Invalid RunSpec input.')
    rejected++
    ctx.addRawReference(`assertion:m01:invalid:${id}`)
    if (id === invalidCases.at(-1)[0]) {
      assert.equal(rejected, 12)
      ctx.recordMetric('invalidSpecsRejected', rejected, 'assertion:m01:12-independent-invalid-inputs')
    }
    return { rejected: true }
  })
  checks.set('m01:fingerprint-stable', ctx => {
    const first = createRunSpec(input())
    const reordered = Object.fromEntries(Object.entries(input()).reverse())
    const second = createRunSpec({ ...reordered, runId: 'run-02' })
    assert.equal(fingerprintRunSpec(first), fingerprintRunSpec(second))
    assert.notEqual(fingerprintRunSpec(first), fingerprintRunSpec(createRunSpec({ ...input(), promptVersion: 'workflow-prompt-v2' })))
    assert.notEqual(fingerprintRunSpec(first), fingerprintRunSpec(createRunSpec({ ...input(), model: { ...input().model, endpointFingerprint: 'b'.repeat(64) } })))
    assert.match(fingerprintRunSpec(first), /^[0-9a-f]{64}$/)
    ctx.recordMetric('fingerprintStable', true, 'assertion:m01:stable-and-version-sensitive')
  })
  checks.set('m01:private-fields-rejected', ctx => {
    const missingEndpoint = input()
    delete missingEndpoint.model.endpointFingerprint
    for (const value of [
      missingEndpoint,
      { ...input(), model: { ...input().model, endpointFingerprint: 'malformed' } },
      { ...input(), apiKey: 'SYNTHETIC_SECRET' },
      { ...input(), model: { ...input().model, apiKey: 'SYNTHETIC_SECRET' } },
      { ...input(), budget: { apiKey: 'SYNTHETIC_SECRET' } }
    ]) assert.throws(() => createRunSpec(value), error => error instanceof Error && error.message === 'Invalid RunSpec input.')
    ctx.recordMetric('privateFieldsRejected', true, 'assertion:m01:private-fields-at-three-levels')
  })
  return checks
}

export const checks = createChecks()
