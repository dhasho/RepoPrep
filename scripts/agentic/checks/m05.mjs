import assert from 'node:assert/strict'
import { createBudgetLedger } from '../../../electron/services/workflow/budget-ledger.ts'
import { createModelGateway } from '../../../electron/services/workflow/model-gateway.ts'
import { createRunSpec } from '../../../electron/services/workflow/run-spec.ts'
import { normalizeBaseUrl } from '../../../electron/services/llm.ts'
import { createHash } from 'node:crypto'

const ids = ['normal-settlement', 'investigation-exhaustion', 'generation-reserve', 'pre-request-failure', 'dispatched-request-failure', 'partial-receipt', 'missing-receipt', 'retry', 'compensation', 'cancellation', 'duplicate-receipt', 'unknown-after-recovery']
const profile = () => ({ id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 })
function makeSpec(budget = {}) {
  return createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: 'profile-01', model: 'synthetic', endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile().baseUrl)).digest('hex'), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', ...(Object.keys(budget).length ? { budget } : {}) })
}
const receipt = { inputTokens: 4, outputTokens: 3, totalTokens: 7 }
const messages = [{ role: 'user', content: 'synthetic fixture request' }]

export function createChecks() {
  const checks = new Map()
  checks.set('m05:normal-settlement', ctx => {
    const ledger = createBudgetLedger(makeSpec())
    ledger.reserveModel({ id: 'normal', stage: 'generation', inputTokens: 10, outputTokens: 10 }); ledger.markDispatched('normal'); ledger.settleModel('normal', receipt)
    const state = ledger.snapshot()
    assert.equal(state.total.dispatchedRequests, 1); assert.equal(state.total.inputTokens, receipt.inputTokens); assert.equal(state.usageComplete, true)
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.reservations[0]))
    ctx.addRawReference('assertion:m05:normal-settlement')
    return { dispatched: state.total.dispatchedRequests, settledInputTokens: state.total.inputTokens }
  })
  checks.set('m05:investigation-exhaustion', ctx => {
    const spec = makeSpec(); const ledger = createBudgetLedger(spec)
    for (let i = 0; i < spec.budget.investigation.maxModelRequests; i++) {
      const id = `investigation-${i}`; ledger.reserveModel({ id, stage: 'investigation', inputTokens: 1, outputTokens: 1 }); ledger.markDispatched(id); ledger.settleModel(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    }
    assert.throws(() => ledger.reserveModel({ id: 'investigation-excess', stage: 'investigation', inputTokens: 1, outputTokens: 1 }))
    assert.equal(ledger.snapshot().metrics.generationReserveProtected, true)
    ctx.addRawReference('assertion:m05:investigation-limit')
    return { investigationRequests: spec.budget.investigation.maxModelRequests }
  })
  checks.set('m05:generation-reserve', ctx => {
    const spec = makeSpec({ maxModelRequests: 3 }); const ledger = createBudgetLedger(spec)
    assert.ok(spec.budget.generationReserve.maxModelRequests >= 1)
    ledger.reserveModel({ id: 'investigation', stage: 'investigation', inputTokens: 1, outputTokens: 1 }); ledger.markDispatched('investigation'); ledger.settleModel('investigation', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    const protectedReserve = ledger.snapshot().metrics.generationReserveProtected
    assert.equal(protectedReserve, true)
    ctx.recordMetric('generationReserveProtected', protectedReserve, 'assertion:m05:investigation-below-withheld-generation-capacity')
    return { generationReserveRequests: spec.budget.generationReserve.maxModelRequests }
  })
  checks.set('m05:pre-request-failure', ctx => {
    const ledger = createBudgetLedger(makeSpec()); const gateway = createModelGateway(makeSpec(), profile(), ledger, { transport: async () => { throw new Error('synthetic-pre-request-failure') } })
    return gateway.complete({ id: 'pre-request', stage: 'generation', messages }).then(() => { throw new Error('expected pre-request failure') }, () => {
      const state = ledger.snapshot(); assert.equal(state.total.dispatchedRequests, 0); assert.equal(state.total.reservedRequests, 0)
      ctx.addRawReference('assertion:m05:pre-request-reservation-released')
      return { dispatched: state.total.dispatchedRequests, reserved: state.total.reservedRequests }
    })
  })
  checks.set('m05:dispatched-request-failure', ctx => {
    const spec = makeSpec(); const ledger = createBudgetLedger(spec); const gateway = createModelGateway(spec, profile(), ledger, { transport: async (_p, _m, _d, options) => { options.beforeRequest(); throw new Error('synthetic-dispatched-failure') } })
    return gateway.complete({ id: 'dispatched-failure', stage: 'generation', messages }).then(() => { throw new Error('expected dispatched failure') }, () => {
      const state = ledger.snapshot(); assert.equal(state.total.dispatchedRequests, 1); assert.equal(state.usageComplete, false); assert.ok(state.total.inputTokens > 0)
      ctx.addRawReference('assertion:m05:dispatched-failure-retains-max-reservation')
      return { dispatched: state.total.dispatchedRequests, usageComplete: state.usageComplete }
    })
  })
  checks.set('m05:partial-receipt', ctx => {
    const ledger = createBudgetLedger(makeSpec()); ledger.reserveModel({ id: 'partial', stage: 'generation', inputTokens: 10, outputTokens: 10 }); ledger.markDispatched('partial'); ledger.settleModel('partial', { inputTokens: 4 })
    const state = ledger.snapshot(); assert.equal(state.usageComplete, false); assert.equal(state.total.inputTokens, 10); assert.equal(state.metrics.unknownUsageTreatedAsZero, 0)
    ctx.recordMetric('unknownUsageTreatedAsZero', state.metrics.unknownUsageTreatedAsZero, 'assertion:m05:partial-receipt-keeps-reservation')
    ctx.addRawReference('assertion:m05:partial-receipt')
    return { usageComplete: state.usageComplete, reservedInputTokens: state.total.inputTokens }
  })
  checks.set('m05:missing-receipt', ctx => {
    const ledger = createBudgetLedger(makeSpec()); ledger.reserveModel({ id: 'missing', stage: 'generation', inputTokens: 11, outputTokens: 12 }); ledger.markDispatched('missing'); ledger.settleModel('missing', null)
    const state = ledger.snapshot(); assert.equal(state.usageComplete, false); assert.equal(state.total.inputTokens, 11); assert.equal(state.total.outputTokens, 12)
    ctx.addRawReference('assertion:m05:missing-receipt')
    return { usageComplete: state.usageComplete, retained: state.total.inputTokens + state.total.outputTokens }
  })
  checks.set('m05:retry', ctx => {
    const ledger = createBudgetLedger(makeSpec())
    for (const id of ['attempt-1', 'attempt-2']) { ledger.reserveModel({ id, stage: 'generation', inputTokens: 4, outputTokens: 3 }); ledger.markDispatched(id); ledger.settleModel(id, receipt) }
    assert.equal(ledger.snapshot().total.dispatchedRequests, 2)
    ctx.addRawReference('assertion:m05:each-retry-is-a-dispatched-attempt')
    return { dispatchedAttempts: ledger.snapshot().total.dispatchedRequests }
  })
  checks.set('m05:compensation', ctx => {
    const spec = makeSpec({ maxModelRequests: 2 }); const ledger = createBudgetLedger(spec)
    for (const [id, stage] of [['generation', 'generation'], ['compensation', 'compensation']]) { ledger.reserveModel({ id, stage, inputTokens: 4, outputTokens: 3 }); ledger.markDispatched(id); ledger.settleModel(id, receipt) }
    assert.equal(ledger.snapshot().total.dispatchedRequests, 2)
    assert.throws(() => ledger.reserveModel({ id: 'compensation-2', stage: 'compensation', inputTokens: 1, outputTokens: 1 }))
    ctx.addRawReference('assertion:m05:compensation-shares-global-request-ceiling')
    return { requests: ledger.snapshot().total.dispatchedRequests }
  })
  checks.set('m05:cancellation', ctx => {
    const ledger = createBudgetLedger(makeSpec()); ledger.reserveModel({ id: 'cancelled', stage: 'generation', inputTokens: 5, outputTokens: 6 }); ledger.markDispatched('cancelled'); ledger.settleModel('cancelled', null)
    const state = ledger.snapshot(); assert.equal(state.total.dispatchedRequests, 1); assert.equal(state.usageComplete, false); assert.equal(state.total.outputTokens, 6)
    ctx.addRawReference('assertion:m05:post-dispatch-cancellation-keeps-reservation')
    return { dispatched: state.total.dispatchedRequests, reservedOutputTokens: state.total.outputTokens }
  })
  checks.set('m05:duplicate-receipt', ctx => {
    const ledger = createBudgetLedger(makeSpec()); ledger.reserveModel({ id: 'once', stage: 'generation', inputTokens: 10, outputTokens: 10 }); ledger.markDispatched('once'); ledger.settleModel('once', receipt)
    const before = ledger.snapshot().total
    assert.throws(() => ledger.settleModel('once', receipt))
    assert.deepEqual(ledger.snapshot().total, before)
    assert.equal(ledger.snapshot().metrics.doubleSettlements, 0)
    ctx.recordMetric('doubleSettlements', ledger.snapshot().metrics.doubleSettlements, 'assertion:m05:duplicate-receipt-rejected')
    ctx.addRawReference('assertion:m05:duplicate-receipt')
    return { rejectedDuplicates: ledger.snapshot().metrics.doubleSettlements }
  })
  checks.set('m05:unknown-after-recovery', ctx => {
    const ledger = createBudgetLedger(makeSpec()); ledger.markUnknownRecovery({ id: 'recovered', stage: 'repair', inputTokens: 17, outputTokens: 19 })
    const state = ledger.snapshot(); assert.equal(state.total.dispatchedRequests, 1); assert.equal(state.usageComplete, false)
    assert.throws(() => ledger.markDispatched('recovered')); assert.throws(() => ledger.releaseUnsent('recovered'))
    const overspendLedger = createBudgetLedger(makeSpec())
    overspendLedger.reserveModel({ id: 'over', stage: 'generation', inputTokens: 1, outputTokens: 1 }); overspendLedger.markDispatched('over'); overspendLedger.settleModel('over', { inputTokens: 2, outputTokens: 2, totalTokens: 4 })
    assert.throws(() => overspendLedger.reserveModel({ id: 'after-over', stage: 'repair', inputTokens: 1, outputTokens: 1 }))
    assert.equal(overspendLedger.snapshot().overspend.inputTokens, 1)
    assert.equal(overspendLedger.snapshot().metrics.overspendAdmissions, 0)
    ctx.recordMetric('overspendAdmissions', overspendLedger.snapshot().metrics.overspendAdmissions, 'assertion:m05:overspend-blocks-later-admission')
    ctx.addRawReference('assertion:m05:unknown-after-recovery')
    return { dispatched: state.total.dispatchedRequests, retainedInputTokens: state.total.inputTokens }
  })
  assert.deepEqual([...checks.keys()], ids.map(id => `m05:${id}`))
  return checks
}

export const checks = createChecks()
