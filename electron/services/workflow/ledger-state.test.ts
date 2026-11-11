import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createBudgetLedger, exportBudgetLedgerState, restoreBudgetLedger, sealBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createLedgerBinding, encodeLedgerState, decodeLedgerState, validateLedgerState, hashSemanticModelOperation, worstCaseLedgerBytes, LEDGER_STATE_MAX_BYTES } from './ledger-state.ts'
import type { LedgerStateV1 } from './ledger-state.ts'
const makeSpec = (ids = {}) => createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: 'profile-01', model: 'synthetic', endpointFingerprint: 'a'.repeat(64), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'prompt-v1', toolVersion: 'tool-v1', policyVersion: 'policy-v1', ...ids })
const spec = makeSpec(); const binding = createLedgerBinding(spec, { sequence: 1, hash: 'b'.repeat(64) })
const receipt = (inputTokens = 3, outputTokens = 2) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })
const options = { clock: () => 0, utcClock: () => 1_000_000, durable: true }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const restore = (value: unknown, extra = {}) => restoreBudgetLedger(spec, value, { ...options, authority: { binding, assertCurrent() {}, proveModelUnsent: () => true }, ...extra })
function initial(): LedgerStateV1 { return exportBudgetLedgerState(createBudgetLedger(spec, options), binding) }

test('complete codec round-trip retains reads, tools, released IDs, partitions and immutable canonical data', () => {
  // Historical ordinary rows, including released IDs, remain codec-compatible after activation.
  const ledger = createBudgetLedger(spec, { ...options, durable: false })
  ledger.reserveModel({ id: 'released-model', stage: 'generation', inputTokens: 2, outputTokens: 2 }); ledger.releaseUnsent('released-model')
  ledger.reserveRead('released-read', 3); ledger.releaseRead('released-read')
  ledger.reserveModel({ id: 'z-model', stage: 'generation', inputTokens: 10, outputTokens: 10, contextChars: 40, semanticHash: 'c'.repeat(64), semanticOperationHash: hashSemanticModelOperation(spec, 'generation', 'c'.repeat(64)), requestHash: 'd'.repeat(64), manifestHash: 'e'.repeat(64) }); ledger.markDispatched('z-model'); ledger.settleModel('z-model', receipt())
  ledger.reserveModel({ id: 'a-model', stage: 'review', inputTokens: 5, outputTokens: 7 })
  ledger.reserveRead('read-hold', 12); ledger.chargeRead('read-settled', 5); ledger.chargeTool('tool-1', 'review'); ledger.chargeTool('tool-2')
  const state = exportBudgetLedgerState(ledger, binding)
  const decoded = decodeLedgerState(spec, encodeLedgerState(spec, state))
  const recovered = restore(decoded)
  assert.deepEqual(recovered.snapshot(), { ...ledger.snapshot(), reservations: [...ledger.snapshot().reservations].sort((a, b) => a.id.localeCompare(b.id)) })
  assert.deepEqual(exportBudgetLedgerState(recovered, binding), state)
  assert.equal(recovered.snapshot().total.readBytes, 17)
  for (const id of ['released-model', 'released-read']) assert.throws(() => recovered.chargeTool(id))
  assert.equal(state.models[0].id, 'a-model')
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.binding.journal) && Object.isFrozen(state.models) && Object.isFrozen(state.models[1].usage) && Object.isFrozen(state.reads[0]))
  assert.equal(encodeLedgerState(spec, { ...state, models: [...state.models].reverse(), issuedIds: [...state.issuedIds].reverse() }), encodeLedgerState(spec, state))
})

test('unknown, unknown-unsent and intent recovery retain full holds and forbid paid work', () => {
  for (const kind of ['unknown', 'unknown-unsent', 'dispatched', 'reserved'] as const) {
    const ledger = createBudgetLedger(spec, { ...options, durable: false })
    ledger.reserveModel({ id: 'held', stage: 'generation', inputTokens: 20, outputTokens: 30 })
    if (kind === 'dispatched' || kind === 'unknown') ledger.markDispatched('held')
    if (kind === 'unknown') ledger.settleModel('held', null)
    if (kind === 'unknown-unsent') ledger.markUnknownUnsent('held')
    const state = exportBudgetLedgerState(ledger, binding)
    const recovered = restore(state, { authority: { binding, assertCurrent() {} } })
    assert.equal(recovered.snapshot().total.inputTokens, 20)
    assert.equal(recovered.snapshot().total.outputTokens, 30)
    assert.equal(recovered.snapshot().blocked, true)
    assert.equal(recovered.snapshot().reservations[0].state, kind === 'dispatched' ? 'unknown' : kind === 'reserved' ? 'unknown-unsent' : kind)
    assert.throws(() => recovered.releaseUnsent('held'))
    assert.throws(() => recovered.reserveModel({ id: 'new-id', stage: 'repair', inputTokens: 1, outputTokens: 1 }))
  }
})

test('identity, configuration, journal and current authorization remain separate checks', () => {
  const state = initial()
  for (const ids of [{ runId: 'different-run' }, { projectId: 'different-project' }, { snapshotId: 'different-snapshot' }, { promptVersion: 'new-version' }]) assert.throws(() => restoreBudgetLedger(makeSpec(ids), state, { ...options, authority: { binding, assertCurrent() {} } }))
  assert.throws(() => restore(state, { authority: { binding: { ...binding, journal: { sequence: 2, hash: 'b'.repeat(64) } }, assertCurrent() {} } }))
  assert.throws(() => restore(state, { authority: { binding, assertCurrent() { throw Error('static authorization failure') } } }))
  assert.throws(() => restoreBudgetLedger(spec, state, options as never))
  assert.throws(() => restore(state, { authority: { binding, assertCurrent: async () => {} } }))
})

test('strict schemas reject extra keys, accessors, hostile prototypes, sparse arrays and unsafe numbers without invoking getters', () => {
  let reads = 0
  const getter = Object.defineProperty({ ...initial() }, 'blocked', { enumerable: true, get() { reads++; return false } })
  assert.throws(() => validateLedgerState(spec, getter)); assert.equal(reads, 0)
  for (const value of [{ ...initial(), totals: {} }, Object.assign(Object.create({ custom: true }), initial()), { ...initial(), issuedIds: Array(1) }, { ...initial(), time: { ...initial().time, elapsedHighWaterMs: Number.MAX_SAFE_INTEGER + 1 } }, { ...initial(), diagnostics: { ...initial().diagnostics, doubleSettlements: -1 } }]) assert.throws(() => validateLedgerState(spec, value))
  const bad = clone(initial()) as any; bad.issuedIds = ['same']; bad.reads = [{ id: 'same', reservedBytes: 1, state: 'reserved', actualBytes: null }]; bad.tools = [{ id: 'same', stage: 'review' }]
  assert.throws(() => restore(bad))
  bad.tools = []; bad.reads[0].actualBytes = 0
  assert.throws(() => restore(bad))
})

test('primary records recompute totals; diagnostic safety floors cannot hide overspend or unknown budgets', () => {
  const ledger = createBudgetLedger(spec, { ...options, durable: false })
  ledger.reserveModel({ id: 'over', stage: 'generation', inputTokens: 1, outputTokens: 1 }); ledger.markDispatched('over'); ledger.settleModel('over', receipt(2, 3))
  const state = exportBudgetLedgerState(ledger, binding)
  const forged = clone(state) as any; forged.diagnostics.overspendInputTokens = 0
  assert.throws(() => restore(forged))
  const historical = { ...state, blocked: true, diagnostics: { ...state.diagnostics, overspendAdmissions: 4, doubleSettlements: 2 } }
  const recovered = restore(historical)
  assert.deepEqual(recovered.snapshot().total, ledger.snapshot().total)
  assert.equal(recovered.snapshot().metrics.overspendAdmissions, 4)
  assert.equal(recovered.snapshot().metrics.doubleSettlements, 2)
  assert.throws(() => recovered.chargeTool('after'))
  const overflow = clone(state) as any; overflow.models[0].usage = receipt(Number.MAX_SAFE_INTEGER, 1)
  assert.throws(() => restore(overflow))
})

test('unsettled read bytes remain reserved across restore and over-budget primary records remain inspectable', () => {
  const ledger = createBudgetLedger(spec, options); ledger.reserveRead('read', 100)
  const state = exportBudgetLedgerState(ledger, binding)
  const recovered = restore(state); assert.equal(recovered.snapshot().total.readBytes, 100)
  const over = { ...state, reads: [{ ...state.reads[0], reservedBytes: Number.MAX_SAFE_INTEGER }] }
  const blocked = restore(over); assert.equal(blocked.snapshot().total.readBytes, Number.MAX_SAFE_INTEGER); assert.equal(blocked.snapshot().blocked, true)
  assert.throws(() => blocked.chargeTool('after'))
})

test('wall-clock capacity includes downtime; expiry, UTC rollback and monotonic rollback fail closed', () => {
  let clock = 0; let utc = 1_000_000
  const ledger = createBudgetLedger(spec, { clock: () => clock, utcClock: () => utc, durable: true })
  clock = 500; utc += 500
  const state = exportBudgetLedgerState(ledger, binding)
  const resumed = restore(state, { clock: () => 9, utcClock: () => 1_100_000 })
  assert.equal(resumed.snapshot().elapsedMs, 100_000)
  assert.equal(resumed.snapshot().remaining.investigationWallClockMs, Math.max(0, spec.budget.investigation.wallClockMs - 100_000))
  const expired = restore(state, { utcClock: () => state.time.expiresUtcMs })
  assert.equal(expired.snapshot().elapsedMs, spec.budget.total.wallClockMs)
  assert.throws(() => expired.assertCanContinue())
  assert.throws(() => restore(state, { utcClock: () => state.time.utcHighWaterMs - 1 }))
  clock = 499; assert.throws(() => ledger.snapshot()); clock = 501; assert.throws(() => ledger.assertCanContinue())
})

test('byte and issued-ID ceilings are independent, bounded and checked before decoding/admission', () => {
  assert.throws(() => decodeLedgerState(spec, Buffer.alloc(LEDGER_STATE_MAX_BYTES + 1)))
  const counts = { models: { length: 100_000 }, reads: { length: 0 }, tools: { length: 0 }, issuedIds: { length: 100_000 } }
  assert.ok(worstCaseLedgerBytes(counts) > 0)
  assert.ok(worstCaseLedgerBytes(counts) > LEDGER_STATE_MAX_BYTES, 'expanded model commitments may exhaust bytes before the independent issued-ID limit')
  // This exercises durable admission at the count boundary using released history, not paid calls.
  const state = { ...initial(), issuedIds: Array.from({ length: 100_000 }, (_, i) => 'released-' + i) }
  const ledger = restore(state)
  assert.throws(() => ledger.reserveRead('new-id', 0))
  assert.throws(() => restore({ ...state, issuedIds: [...state.issuedIds, 'extra'] }))
  assert.throws(() => decodeLedgerState(spec, new Uint8Array([0xff])))
})


test('terminal diagnostics freeze elapsed time across inspection and restart', () => {
  let clock = 0; let utc = 1_000_000
  const ledger = createBudgetLedger(spec, { clock: () => clock, utcClock: () => utc, durable: true })
  clock = 50; utc += 50; sealBudgetLedger(ledger)
  const state = exportBudgetLedgerState(ledger, binding)
  clock = 100; utc += 50
  assert.equal(ledger.snapshot().elapsedMs, 50)
  const recovered = restore(state, { utcClock: () => 2_000_000 })
  assert.equal(recovered.snapshot().elapsedMs, 50)
  assert.throws(() => recovered.assertCanContinue())
  assert.deepEqual(exportBudgetLedgerState(recovered, binding), state)
})

test('recovered reads cannot be released without journal proof of no I/O', () => {
  const ledger = createBudgetLedger(spec, options); ledger.reserveRead('pending-read', 100)
  const state = exportBudgetLedgerState(ledger, binding)
  assert.throws(() => restore(state).releaseRead('pending-read'))
  const recovered = restore(state, { authority: { binding, assertCurrent() {}, proveReadUnsent: () => true } })
  recovered.releaseRead('pending-read')
  assert.equal(recovered.snapshot().total.readBytes, 0)
  assert.throws(() => recovered.reserveRead('pending-read', 1))
})


test('binding preserves the full valid RunSpec policy-version range', () => {
  const longSpec = makeSpec({ policyVersion: 'a'.repeat(64) + '-v1234' })
  const longBinding = createLedgerBinding(longSpec, binding.journal)
  const state = exportBudgetLedgerState(createBudgetLedger(longSpec, options), longBinding)
  assert.equal(decodeLedgerState(longSpec, encodeLedgerState(longSpec, state)).binding.policyVersion, longSpec.policyVersion)
})


test('strict operation records retain separate immutable commitments and validate stable semantic identity', () => {
  const ledger = createBudgetLedger(spec, options)
  const commitment = { semanticHash: 'c'.repeat(64), semanticOperationHash: hashSemanticModelOperation(spec, 'generation', 'c'.repeat(64)), requestHash: 'd'.repeat(64), manifestHash: 'e'.repeat(64) }
  ledger.reserveModel({ id: 'logical', stage: 'generation', inputTokens: 2, outputTokens: 3, contextChars: 10, ...commitment })
  const state = decodeLedgerState(spec, encodeLedgerState(spec, exportBudgetLedgerState(ledger, binding)))
  assert.deepEqual(Object.fromEntries(Object.keys(commitment).map(key => [key, (state.models[0] as any)[key]])), commitment)
  assert.equal(Object.isFrozen(state.models[0]), true)
  assert.equal(Object.hasOwn(ledger.snapshot().reservations[0], 'semanticHash'), false)
  assert.equal(Object.hasOwn(ledger.snapshot().reservations[0], 'requestHash'), false)
  for (const key of Object.keys(commitment)) {
    const missing = clone(state) as any; delete missing.models[0][key]
    assert.throws(() => validateLedgerState(spec, missing))
    const partial = clone(state) as any; partial.models[0][key] = null
    assert.throws(() => validateLedgerState(spec, partial))
    const malformed = clone(state) as any; malformed.models[0][key] = 'unvalidated'
    assert.throws(() => validateLedgerState(spec, malformed))
  }
  for (const changed of [{ semanticHash: 'f'.repeat(64) }, { semanticOperationHash: 'f'.repeat(64) }, { stage: 'review' }]) {
    assert.throws(() => validateLedgerState(spec, { ...state, models: [{ ...state.models[0], ...changed }] }))
  }
  const duplicate = { ...state.models[0], id: 'other-uuid', requestHash: 'f'.repeat(64), manifestHash: 'f'.repeat(64), outputTokens: 1 }
  assert.throws(() => validateLedgerState(spec, { ...state, models: [...state.models, duplicate], issuedIds: [...state.issuedIds, duplicate.id] }))
  let invoked = false
  const accessor = Object.defineProperty({ ...state.models[0] }, 'semanticHash', { enumerable: true, get() { invoked = true; return commitment.semanticHash } })
  assert.throws(() => validateLedgerState(spec, { ...state, models: [accessor] })); assert.equal(invoked, false)
  assert.throws(() => ledger.reserveModel({ id: 'partial', stage: 'generation', inputTokens: 1, outputTokens: 1, semanticOperationHash: commitment.semanticOperationHash }))
})

test('expanded worst-case byte capacity refuses an additional record before changing held accounting', () => {
  const counts = (length: number) => ({ models: { length }, reads: { length: 0 }, tools: { length: 0 }, issuedIds: { length } })
  const base = worstCaseLedgerBytes(counts(0)); const perRecord = worstCaseLedgerBytes(counts(1)) - base
  const capacity = Math.floor((LEDGER_STATE_MAX_BYTES - base) / perRecord)
  assert.ok(capacity > 0 && capacity < 100_000)
  assert.ok(worstCaseLedgerBytes(counts(capacity)) <= LEDGER_STATE_MAX_BYTES)
  const models = Array.from({ length: capacity }, (_, i) => ({ id: 'capacity-' + i, stage: 'generation' as const, inputTokens: 0, outputTokens: 0, contextChars: null, state: 'reserved' as const, usage: null, semanticHash: null, semanticOperationHash: null, requestHash: null, manifestHash: null }))
  const state = { ...initial(), models, issuedIds: models.map(model => model.id) }
  const ledger = restore(state)
  assert.throws(() => ledger.markUnknownRecovery({ id: 'one-more', stage: 'generation', inputTokens: 1, outputTokens: 1 }), { code: 'budget-exhausted' })
  assert.equal(ledger.snapshot().reservations.length, capacity)
  assert.equal(ledger.snapshot().total.inputTokens, 0)
  assert.throws(() => validateLedgerState(spec, { ...state, models: [...models, { ...models[0], id: 'one-more' }], issuedIds: [...state.issuedIds, 'one-more'] }))
})
