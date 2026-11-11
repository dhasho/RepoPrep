import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { beginOrdinaryModelCompletion, createBudgetLedger, enableBudgetLedgerDurability, exportBudgetLedgerState, requiresDurableModelAdmission, restoreBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createLedgerBinding, hashSemanticModelOperation, validateLedgerState } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { normalizeBaseUrl } from '../llm.ts'
import type { BudgetLedger } from './budget-ledger.ts'
import type { DurableModelJournal } from './model-journal.ts'
import type { ModelGatewayOptions, ModelTransport } from './model-gateway.ts'

const profile = { id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49152, maxOutputTokens: 4096 }
const spec = createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'prompt-v1', toolVersion: 'tool-v1', policyVersion: 'policy-v1' })
const clocks = { clock: () => 0, utcClock: () => 1_000_000 }
const binding = createLedgerBinding(spec, { sequence: 0, hash: '0'.repeat(64) })
const messages = [{ role: 'user' as const, content: 'synthetic request' }]
const usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
const operation = { semanticHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64) }
const invalid = { code: 'invalid-argument' }
const request = (id = 'request-01') => ({ id, stage: 'generation' as const, messages })
const fresh = () => createBudgetLedger(spec, clocks)
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

/** In-memory ordering fixture only; production store authority/fsync is tested separately. */
function journal(events: string[] = []): DurableModelJournal {
  let sequence = binding.journal.sequence
  return {
    binding, attemptId: 'attempt-01', fence: 1, assertCurrent() {},
    async appendAndFlush(event, build) {
      const position = { sequence: ++sequence, hash: createHash('sha256').update(JSON.stringify([sequence, event])).digest('hex') }
      validateLedgerState(spec, build(position))
      events.push(event.kind)
      return position
    }
  }
}
function witnessedTransport(witness = { entries: 0, http: 0 }, events: string[] = []): ModelTransport {
  return async (_p, _m, _emit, options) => {
    witness.entries++
    await options.beforeRequest!()
    options.beforeFetch!()
    witness.http++ // The actual synthetic send boundary, distinct from transport entry.
    events.push('HTTP')
    options.onUsage!(usage)
    return 'synthetic output'
  }
}
function restoredHealthy() {
  const original = fresh()
  original.reserveModel({ id: 'known-history', stage: 'generation', inputTokens: 8, outputTokens: 8 })
  original.markDispatched('known-history'); original.settleModel('known-history', usage)
  const state = exportBudgetLedgerState(original, binding)
  const restored = restoreBudgetLedger(spec, state, { ...clocks, authority: { binding, assertCurrent() {} } })
  assert.equal(restored.snapshot().blocked, false)
  assert.ok(restored.snapshot().remaining.modelRequests > 0)
  assert.equal(state.models[0].semanticHash, null, 'historical nullable codec rows remain supported')
  return restored
}

for (const [kind, make] of [
  ['created durable', () => createBudgetLedger(spec, { ...clocks, durable: true })],
  ['enabled', () => { const l = fresh(); enableBudgetLedgerDurability(l); return l }],
  ['exported', () => { const l = fresh(); exportBudgetLedgerState(l, binding); return l }],
  ['restored healthy', restoredHealthy]
] as const) {
  test(`${kind} genuine ledger rejects omitted journal even with operation omitted`, () => {
    const ledger = make(); const witness = { entries: 0, http: 0 }
    assert.equal(requiresDurableModelAdmission(ledger), true)
    const before = ledger.snapshot()
    assert.throws(() => createModelGateway(spec, profile, ledger, { transport: witnessedTransport(witness) }), invalid)
    assert.deepEqual(ledger.snapshot(), before)
    assert.deepEqual(witness, { entries: 0, http: 0 })
  })
}

for (const activate of ['enable', 'export', 'second gateway'] as const) {
  test(`gateway constructed before ${activate} cannot attach a journal late`, async () => {
    const ledger = fresh(); const witness = { entries: 0, http: 0 }
    const options: ModelGatewayOptions = { transport: witnessedTransport(witness) }
    const old = createModelGateway(spec, profile, ledger, options)
    if (activate === 'enable') enableBudgetLedgerDurability(ledger)
    else if (activate === 'export') exportBudgetLedgerState(ledger, binding)
    else createModelGateway(spec, profile, ledger, { durability: journal() })
    Object.assign(options, { durability: journal() })
    await assert.rejects(old.complete(request()), invalid)
    assert.equal(ledger.snapshot().reservations.length, 0)
    assert.deepEqual(witness, { entries: 0, http: 0 })
  })
}

test('copied and structural ledger objects cannot forge the internal requirement or lease', () => {
  const original = fresh()
  for (const forged of [{ ...original }, Object.create(original), {}, null] as BudgetLedger[]) {
    assert.throws(() => requiresDurableModelAdmission(forged), invalid)
    assert.throws(() => beginOrdinaryModelCompletion(forged), invalid)
    assert.throws(() => createModelGateway(spec, profile, forged), invalid)
  }
  assert.equal(requiresDurableModelAdmission(original), false)
  assert.equal(Object.hasOwn(original, 'durable'), false)
  assert.equal(Object.hasOwn(original.snapshot(), 'durable'), false)
})

test('durable new reservations require all four valid immutable commitments without changing historical codec rows', () => {
  const ledger = createBudgetLedger(spec, { ...clocks, durable: true })
  const reservation = { id: 'valid-operation', stage: 'generation' as const, inputTokens: 8, outputTokens: 8, contextChars: 20, semanticHash: operation.semanticHash, semanticOperationHash: hashSemanticModelOperation(spec, 'generation', operation.semanticHash), requestHash: 'a'.repeat(64), manifestHash: operation.manifestHash }
  const before = exportBudgetLedgerState(ledger, binding)
  assert.throws(() => ledger.reserveModel({ id: 'missing-all', stage: 'generation', inputTokens: 1, outputTokens: 1 }), invalid)
  for (const key of ['semanticHash', 'semanticOperationHash', 'requestHash', 'manifestHash'] as const) {
    assert.throws(() => ledger.reserveModel({ ...reservation, [key]: undefined }), invalid)
    assert.throws(() => ledger.reserveModel({ ...reservation, [key]: 'malformed' }), invalid)
  }
  assert.throws(() => ledger.reserveModel({ ...reservation, semanticOperationHash: 'b'.repeat(64) }), invalid)
  assert.throws(() => ledger.reserveModel({ ...reservation, contextChars: undefined }), invalid)
  assert.deepEqual(exportBudgetLedgerState(ledger, binding), before)
  ledger.reserveModel(reservation)
  assert.deepEqual(exportBudgetLedgerState(ledger, binding).models[0], { ...reservation, state: 'reserved', usage: null })
  assert.throws(() => ledger.releaseUnsent(reservation.id), invalid)
})

test('captured durable admission still requires operation metadata and flushes before the synthetic HTTP boundary', async () => {
  const ledger = fresh(); const witness = { entries: 0, http: 0 }; const events: string[] = []
  const gateway = createModelGateway(spec, profile, ledger, { durability: journal(events), transport: witnessedTransport(witness, events) })
  await assert.rejects(gateway.complete(request('missing-operation')), invalid)
  await assert.rejects(gateway.complete({ ...request('partial-operation'), durableOperation: { semanticHash: operation.semanticHash } as never }), invalid)
  assert.deepEqual(witness, { entries: 0, http: 0 }); assert.equal(ledger.snapshot().reservations.length, 0)
  assert.equal((await gateway.complete({ ...request(), durableOperation: operation })).content, 'synthetic output')
  assert.deepEqual(events, ['reservation', 'intent', 'HTTP', 'receipt'])
  assert.equal(requiresDurableModelAdmission(ledger), true)
  assert.equal(ledger.snapshot().reservations[0].state, 'settled')
})

function activate(ledger: BudgetLedger, kind: 'enable' | 'export' | 'second gateway') {
  if (kind === 'enable') enableBudgetLedgerDurability(ledger)
  else if (kind === 'export') exportBudgetLedgerState(ledger, binding)
  else createModelGateway(spec, profile, ledger, { durability: journal() })
}
for (const kind of ['enable', 'export', 'second gateway'] as const) {
  for (const boundary of ['guard', 'awaited hook', 'final-fetch guard'] as const) {
    test(`${kind} refuses activation from an ordinary ${boundary} without changing mode or sending HTTP`, async () => {
      const ledger = fresh(); const witness = { entries: 0, http: 0 }; let guards = 0
      const gateway = createModelGateway(spec, profile, ledger, { transport: async (_p, _m, _emit, options) => {
        witness.entries++
        await options.beforeRequest!()
        if (boundary === 'awaited hook') { await Promise.resolve(); activate(ledger, kind) }
        options.beforeFetch!()
        witness.http++
        options.onUsage!(usage)
        return 'forbidden'
      } })
      await assert.rejects(gateway.complete({ ...request(), dispatchGuard() {
        guards++
        if (boundary === 'guard' && guards === 1 || boundary === 'final-fetch guard' && guards === 2) activate(ledger, kind)
      } }), invalid)
      assert.equal(witness.entries, 1); assert.equal(witness.http, 0)
      assert.equal(requiresDurableModelAdmission(ledger), false, 'failed activation cannot switch the ledger mode')
      const snapshot = ledger.snapshot()
      assert.equal(snapshot.reservations.length, boundary === 'guard' ? 0 : 1)
      if (boundary !== 'guard') {
        assert.equal(snapshot.reservations[0].state, 'unknown')
        assert.ok(snapshot.total.inputTokens > 0 && snapshot.total.outputTokens > 0)
      }
      activate(ledger, kind) // Full completion/failure accounting has now run.
      assert.equal(requiresDurableModelAdmission(ledger), true)
      assert.deepEqual(ledger.snapshot(), snapshot, 'activation cannot reset consumed or unknown accounting')
    })
  }
}

for (const kind of ['enable', 'export', 'second gateway'] as const) {
  test(`${kind} cannot activate after HTTP until the ordinary completion has actually settled`, async () => {
    const ledger = fresh(); const response = deferred(); const sent = deferred(); const witness = { entries: 0, http: 0 }
    const gateway = createModelGateway(spec, profile, ledger, { transport: async (_p, _m, _emit, options) => {
      witness.entries++; await options.beforeRequest!(); options.beforeFetch!(); witness.http++; sent.resolve()
      await response.promise
      options.onUsage!(usage)
      return 'synthetic output'
    } })
    const completion = gateway.complete(request())
    try {
      await sent.promise
      const before = ledger.snapshot()
      assert.equal(before.reservations[0].state, 'dispatched')
      assert.throws(() => activate(ledger, kind), invalid)
      assert.equal(requiresDurableModelAdmission(ledger), false)
      assert.deepEqual(ledger.snapshot(), before)
    } finally { response.resolve() }
    await completion
    assert.deepEqual(witness, { entries: 1, http: 1 })
    const settled = ledger.snapshot()
    assert.equal(settled.reservations[0].state, 'settled')
    assert.deepEqual(settled.total.actualProviderUsage, usage)
    activate(ledger, kind)
    assert.equal(requiresDurableModelAdmission(ledger), true)
    assert.deepEqual(ledger.snapshot(), settled)
    await assert.rejects(gateway.complete(request('old-gateway-new-id')), invalid)
    assert.equal(witness.http, 1)
  })
}

test('ordinary lease extends through buffered output awaits and settlement trace, not only transport return', async () => {
  const ledger = fresh(); const output = deferred(); const outputEntered = deferred(); let transportReturned = false; let settledTraceChecked = false
  const gateway = createModelGateway(spec, profile, ledger, { transport: async (_p, _m, emit, options) => {
    await options.beforeRequest!(); options.beforeFetch!()
    emit('tail') // Buffered because it is shorter than the synthetic key.
    options.onUsage!(usage); transportReturned = true
    return 'tail'
  }, trace(event) {
    if (event.type === 'settled') {
      assert.equal(ledger.snapshot().reservations[0].state, 'settled')
      assert.throws(() => enableBudgetLedgerDurability(ledger), invalid)
      assert.equal(requiresDurableModelAdmission(ledger), false)
      settledTraceChecked = true
    }
  } })
  const completion = gateway.complete({ ...request(), onDelta: async () => { outputEntered.resolve(); await output.promise } })
  try {
    await outputEntered.promise
    assert.equal(transportReturned, true)
    assert.equal(ledger.snapshot().reservations[0].state, 'dispatched')
    assert.throws(() => exportBudgetLedgerState(ledger, binding), invalid)
    assert.equal(requiresDurableModelAdmission(ledger), false)
  } finally { output.resolve() }
  await completion
  assert.equal(settledTraceChecked, true)
  enableBudgetLedgerDurability(ledger)
  assert.equal(requiresDurableModelAdmission(ledger), true)
})

test('failed activation can be caught without poisoning the unchanged ordinary completion', async () => {
  const ledger = fresh(); let http = 0
  const gateway = createModelGateway(spec, profile, ledger, { transport: async (_p, _m, _emit, options) => {
    await options.beforeRequest!()
    assert.throws(() => exportBudgetLedgerState(ledger, binding), invalid)
    assert.equal(requiresDurableModelAdmission(ledger), false)
    options.beforeFetch!(); http++; options.onUsage!(usage)
    return 'synthetic output'
  } })
  await gateway.complete(request())
  assert.equal(http, 1); assert.equal(ledger.snapshot().reservations[0].state, 'settled')
  const state = exportBudgetLedgerState(ledger, binding)
  assert.equal(state.models[0].semanticHash, null)
  assert.equal(requiresDurableModelAdmission(ledger), true)
})

for (const failure of ['validation', 'before dispatch', 'sent unknown', 'cancelled'] as const) {
  test(`ordinary lease releases after ${failure} while retaining the original failure accounting`, async () => {
    const ledger = fresh(); const controller = new AbortController(); let http = 0
    const gateway = createModelGateway(spec, profile, ledger, { transport: async (_p, _m, _emit, options) => {
      if (failure === 'before dispatch') throw Error('synthetic serialization failure')
      await options.beforeRequest!(); options.beforeFetch!(); http++
      if (failure === 'cancelled') controller.abort()
      throw Error('synthetic disconnect')
    } })
    await assert.rejects(gateway.complete({ ...request(), ...(failure === 'validation' ? { messages: null as never } : {}), signal: controller.signal }))
    assert.equal(http, failure === 'sent unknown' || failure === 'cancelled' ? 1 : 0)
    const before = ledger.snapshot()
    if (http) { assert.equal(before.reservations[0].state, 'unknown'); assert.equal(before.blocked, true) }
    else assert.equal(before.reservations.length, 0)
    enableBudgetLedgerDurability(ledger)
    assert.equal(requiresDurableModelAdmission(ledger), true)
    assert.deepEqual(ledger.snapshot(), before)
  })
}

test('concurrent ordinary completions each retain a lease until all have settled', async () => {
  const ledger = fresh(); const responses = [deferred(), deferred()]; const sent = deferred(); let http = 0
  const gateway = createModelGateway(spec, profile, ledger, { transport: async (_p, _m, _emit, options) => {
    await options.beforeRequest!(); options.beforeFetch!(); const index = http++
    if (http === 2) sent.resolve()
    await responses[index].promise
    options.onUsage!(usage); return 'synthetic output'
  } })
  const completions = [gateway.complete(request('first')), gateway.complete(request('second'))]
  try {
    await sent.promise
    responses[0].resolve(); await completions[0]
    assert.throws(() => enableBudgetLedgerDurability(ledger), invalid)
    assert.equal(requiresDurableModelAdmission(ledger), false)
  } finally { for (const response of responses) response.resolve() }
  await Promise.all(completions)
  assert.equal(http, 2)
  enableBudgetLedgerDurability(ledger)
  assert.equal(ledger.snapshot().total.dispatchedRequests, 2)
  assert.deepEqual(ledger.snapshot().total.actualProviderUsage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 })
})
