import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node runner executes explicit TypeScript module paths.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner executes explicit TypeScript module paths.
import { createRunSpec } from './run-spec.ts'

function spec(overrides: Record<string, unknown> = {}) {
  return createRunSpec({
    version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1',
    roleFocus: 'backend', granularity: 'fine', model: { profileId: 'profile-01', model: 'synthetic', endpointFingerprint: 'a'.repeat(64), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 },
    promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: overrides
  })
}
const receipt = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })

test('M05 normal-settlement records usage and returns frozen non-sensitive snapshots', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'call-1', stage: 'generation', inputTokens: 100, outputTokens: 100, contextChars: 75 })
  ledger.markDispatched('call-1')
  ledger.settleModel('call-1', receipt(80, 40))
  const snapshot = ledger.snapshot()
  assert.equal(snapshot.total.dispatchedRequests, 1)
  assert.equal(snapshot.total.inputTokens, 80)
  assert.equal(snapshot.total.outputTokens, 40)
  assert.equal(snapshot.total.estimatedInputTokens, 100)
  assert.deepEqual(snapshot.total.actualProviderUsage, receipt(80, 40))
  assert.equal(snapshot.reservations[0].contextChars, 75)
  assert.equal(snapshot.usageComplete, true)
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.reservations[0]))
  assert.equal(JSON.stringify(snapshot).includes('apiKey'), false)
})

test('M05 investigation-exhaustion refuses requests beyond investigation caps', () => {
  const ledger = createBudgetLedger(spec())
  const limit = spec().budget.investigation.maxModelRequests
  for (let i = 0; i < limit; i++) {
    const id = `investigation-${i}`
    ledger.reserveModel({ id, stage: 'investigation', inputTokens: 1, outputTokens: 1 }); ledger.markDispatched(id); ledger.settleModel(id, receipt(1, 1))
  }
  assert.throws(() => ledger.reserveModel({ id: 'investigation-over', stage: 'investigation', inputTokens: 1, outputTokens: 1 }))
})

test('M05 generation-reserve keeps investigation below withheld generation capacity', () => {
  const ledger = createBudgetLedger(spec({ maxModelRequests: 3, inputTokens: 30_000, outputTokens: 5_000 }))
  const inv = ledger.snapshot()
  assert.ok(spec({ maxModelRequests: 3, inputTokens: 30_000, outputTokens: 5_000 }).budget.generationReserve.maxModelRequests >= 1)
  ledger.reserveModel({ id: 'inv', stage: 'investigation', inputTokens: 1, outputTokens: 1 })
  ledger.markDispatched('inv')
  ledger.settleModel('inv', receipt(1, 1))
  assert.equal(ledger.snapshot().metrics.generationReserveProtected, true)
  assert.ok(inv.total.dispatchedRequests === 0)
})

test('M05 pre-request-failure releases unsent token and request reservations', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'pre', stage: 'generation', inputTokens: 20, outputTokens: 30 })
  ledger.releaseUnsent('pre')
  assert.equal(ledger.snapshot().total.reservedRequests, 0)
  assert.equal(ledger.snapshot().total.dispatchedRequests, 0)
  assert.equal(ledger.snapshot().total.inputTokens, 0)
})

test('M05 dispatched-request-failure conservatively retains reservation', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'sent-fail', stage: 'generation', inputTokens: 20, outputTokens: 30 }); ledger.markDispatched('sent-fail')
  assert.equal(ledger.snapshot().usageComplete, false)
  assert.equal(ledger.snapshot().total.actualProviderUsage, null)
  assert.equal(ledger.snapshot().total.inputTokens, 20)
  assert.throws(() => ledger.releaseUnsent('sent-fail'))
})

test('M05 partial-receipt is unknown and never treated as zero', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'partial', stage: 'generation', inputTokens: 20, outputTokens: 30 }); ledger.markDispatched('partial'); ledger.settleModel('partial', { inputTokens: 7 })
  assert.equal(ledger.snapshot().usageComplete, false)
  assert.equal(ledger.snapshot().total.inputTokens, 20)
  assert.equal(ledger.snapshot().metrics.unknownUsageTreatedAsZero, 0)
})

test('M05 missing-receipt keeps maximum reservation', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'missing', stage: 'generation', inputTokens: 20, outputTokens: 30 }); ledger.markDispatched('missing'); ledger.settleModel('missing', null)
  assert.equal(ledger.snapshot().total.inputTokens, 20)
  assert.equal(ledger.snapshot().total.outputTokens, 30)
  assert.equal(ledger.snapshot().usageComplete, false)
})

test('M05 retry counts every dispatched attempt', () => {
  const ledger = createBudgetLedger(spec())
  for (const id of ['retry-1', 'retry-2']) { ledger.reserveModel({ id, stage: 'generation', inputTokens: 1, outputTokens: 1 }); ledger.markDispatched(id); ledger.settleModel(id, receipt(1, 1)) }
  assert.equal(ledger.snapshot().total.dispatchedRequests, 2)
})

test('M05 compensation uses shared global ceilings', () => {
  const ledger = createBudgetLedger(spec({ maxModelRequests: 2 }))
  for (const [id, stage] of [['generation-1', 'generation'], ['compensate', 'compensation']] as const) { ledger.reserveModel({ id, stage, inputTokens: 1, outputTokens: 1 }); ledger.markDispatched(id); ledger.settleModel(id, receipt(1, 1)) }
  assert.equal(ledger.snapshot().total.dispatchedRequests, 2)
  assert.throws(() => ledger.reserveModel({ id: 'compensate-again', stage: 'compensation', inputTokens: 1, outputTokens: 1 }))
})

test('M05 cancellation after dispatch retains an unknown reservation', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'cancelled', stage: 'generation', inputTokens: 8, outputTokens: 9 }); ledger.markDispatched('cancelled'); ledger.settleModel('cancelled', null)
  assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().usageComplete, false)
  assert.equal(ledger.snapshot().total.outputTokens, 9)
})

test('M05 duplicate-receipt is rejected without mutation', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'once', stage: 'generation', inputTokens: 10, outputTokens: 10 }); ledger.markDispatched('once'); ledger.settleModel('once', receipt(5, 3))
  const before = ledger.snapshot().total
  assert.throws(() => ledger.settleModel('once', receipt(6, 3)))
  assert.deepEqual(ledger.snapshot().total, before)
  assert.equal(ledger.snapshot().metrics.doubleSettlements, 0)
})

test('M05 unknown-after-recovery counts sent work and cannot be released or redispatched', () => {
  const ledger = createBudgetLedger(spec())
  ledger.markUnknownRecovery({ id: 'recovered', stage: 'repair', inputTokens: 15, outputTokens: 25 })
  assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().usageComplete, false)
  assert.throws(() => ledger.markDispatched('recovered'))
  assert.throws(() => ledger.releaseUnsent('recovered'))
})

test('overspend blocks every later model admission', () => {
  const ledger = createBudgetLedger(spec())
  ledger.reserveModel({ id: 'overspent', stage: 'generation', inputTokens: 1, outputTokens: 1 }); ledger.markDispatched('overspent'); ledger.settleModel('overspent', receipt(2, 2))
  assert.throws(() => ledger.reserveModel({ id: 'after-overspend', stage: 'repair', inputTokens: 1, outputTokens: 1 }))
  assert.equal(ledger.snapshot().metrics.overspendAdmissions, 0)
  assert.deepEqual(ledger.snapshot().overspend, { inputTokens: 1, outputTokens: 1, readBytes: 0 })
})

test('read reservations are atomic and overreads block future admissions', () => {
  const ledger = createBudgetLedger(spec({ readBytes: 10 }))
  ledger.reserveRead('read-before-io-failure', 1)
  ledger.releaseRead('read-before-io-failure')
  assert.equal(ledger.snapshot().remaining.readBytes, 10)
  ledger.reserveRead('read-1', 9)
  assert.throws(() => ledger.reserveRead('read-2', 2))
  ledger.settleRead('read-1', 10)
  assert.equal(ledger.snapshot().overspend.readBytes, 1)
  assert.throws(() => ledger.reserveModel({ id: 'after-overread', stage: 'generation', inputTokens: 1, outputTokens: 1 }))
})

test('tool charges enforce bounded investigation cap and unique IDs', () => {
  const ledger = createBudgetLedger(spec())
  for (let index = 0; index < 8; index++) ledger.chargeTool(`tool-${index}`)
  assert.throws(() => ledger.chargeTool('tool-limit'))
  assert.throws(() => ledger.chargeTool('tool-0'))
})

test('wall clock is checked at reserve and dispatch', () => {
  let time = 0
  const ledger = createBudgetLedger(spec({ wallClockMs: 1 }), { clock: () => time })
  ledger.reserveModel({ id: 'time', stage: 'generation', inputTokens: 1, outputTokens: 1 })
  time = 1
  assert.throws(() => ledger.markDispatched('time'))
})

test('investigation wall clock is enforced independently from the run deadline', () => {
  let time = 0
  const ledger = createBudgetLedger(spec(), { clock: () => time })
  ledger.reserveModel({ id: 'investigation-time', stage: 'investigation', inputTokens: 1, outputTokens: 1 })
  time = spec().budget.investigation.wallClockMs
  assert.throws(() => ledger.markDispatched('investigation-time'), error => error instanceof WorkflowError && error.code === 'budget-exhausted')
  ledger.releaseUnsent('investigation-time')
})

test('non-monotonic injected clocks are rejected', () => {
  let time = 10
  const ledger = createBudgetLedger(spec(), { clock: () => time })
  time = 9
  assert.throws(() => ledger.snapshot(), error => error instanceof WorkflowError && error.code === 'invalid-argument')
})
