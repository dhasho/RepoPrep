import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createLedgerBinding } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { normalizeBaseUrl } from '../llm.ts'
import type { DurableModelEvent, DurableModelJournal } from './model-journal.ts'

const profile = { id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49152, maxOutputTokens: 4096 }
const spec = createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'prompt-v1', toolVersion: 'tool-v1', policyVersion: 'policy-v1' })
const messages = [{ role: 'user' as const, content: 'synthetic input' }]
const operation = { semanticHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64) }
const usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function watched<T>(promise: Promise<T>) { let settled = false; void promise.then(() => { settled = true }, () => { settled = true }); return { promise, settled: () => settled } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const json = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
async function withFetch(mock: typeof fetch, run: () => Promise<void>) { const original = globalThis.fetch; globalThis.fetch = mock; try { await run() } finally { globalThis.fetch = original } }

/** Accounting-only journal fixture; neither this fixture nor custom transports prove W ownership. */
function fixture(pauseReceipt?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> }, failReceipt = false, clock = () => 0) {
  const ledger = createBudgetLedger(spec, { durable: true, clock, utcClock: () => 1_000_000 })
  const events: DurableModelEvent[] = []; let sequence = 0
  const journal: DurableModelJournal = {
    binding: createLedgerBinding(spec, { sequence: 0, hash: '0'.repeat(64) }), attemptId: 'attempt-01', fence: 1,
    assertCurrent() {},
    async appendAndFlush(event, build) {
      events.push(event)
      const position = { sequence: ++sequence, hash: createHash('sha256').update(String(sequence)).digest('hex') }
      build(position)
      if (event.kind === 'receipt') {
        pauseReceipt?.entered.resolve()
        if (pauseReceipt) await pauseReceipt.gate.promise
        if (failReceipt) throw Error('SYNTHETIC_SECRET receipt failure')
      }
      return position
    }
  }
  return { ledger, journal, events }
}
const input = (signal?: AbortSignal) => ({ id: 'request-01', stage: 'generation' as const, messages, durableOperation: operation, ...(signal ? { signal } : {}) })

test('durable production gateway waits for original delta, receipt flush and L afterFlush on abort', async () => {
  const receiptEntered = deferred(); const receiptGate = deferred()
  const actual = fixture({ entered: receiptEntered, gate: receiptGate })
  const controller = new AbortController(); const deltaEntered = deferred(); const deltaGate = deferred(); let deltas = 0
  await withFetch(async () => json('synthetic output long enough for streamed safe content'), async () => {
    const gateway = createModelGateway(spec, profile, actual.ledger, { durability: actual.journal })
    const result = watched(gateway.complete({ ...input(controller.signal), onDelta: async () => { deltas++; deltaEntered.resolve(); await deltaGate.promise } }))
    const rejected = assert.rejects(result.promise, { code: 'cancelled' })
    try {
      await deltaEntered.promise; controller.abort(); await turn()
      assert.equal(result.settled(), false)
      assert.equal(actual.ledger.snapshot().reservations[0].state, 'dispatched')
      deltaGate.resolve(); await receiptEntered.promise; await turn()
      assert.equal(result.settled(), false)
      assert.equal(actual.ledger.snapshot().reservations[0].state, 'dispatched')
    } finally { deltaGate.resolve(); receiptGate.resolve() }
    await rejected
    assert.equal(deltas, 1)
    assert.equal(actual.ledger.snapshot().reservations[0].state, 'settled')
    assert.deepEqual(actual.ledger.snapshot().total.actualProviderUsage, usage)
    assert.equal(actual.events.at(-1)?.kind, 'receipt')
    assert.equal(actual.events.at(-1)?.outputStatus, 'missing')
  })
})

test('durable gateway final held-back delta is actual work and retains a known receipt on cancellation', async () => {
  const h = fixture(); const controller = new AbortController(); const entered = deferred(); const gate = deferred(); let calls = 0
  await withFetch(async () => json('tail'), async () => {
    const gateway = createModelGateway(spec, profile, h.ledger, { durability: h.journal })
    const result = watched(gateway.complete({ ...input(controller.signal), onDelta: async delta => { calls++; assert.equal(delta, 'tail'); entered.resolve(); await gate.promise } }))
    const rejected = assert.rejects(result.promise, { code: 'cancelled' })
    try { await entered.promise; controller.abort(); await turn(); assert.equal(result.settled(), false) }
    finally { gate.resolve() }
    await rejected
    assert.equal(calls, 1); assert.equal(h.ledger.snapshot().reservations[0].state, 'settled')
    assert.deepEqual(h.ledger.snapshot().total.actualProviderUsage, usage)
  })
})

test('durable trace promises settle before completion and cannot mask settled usage or success', async () => {
  const h = fixture(); const entered = deferred(); const gates = { reserved: deferred(), dispatched: deferred(), settled: deferred(), failed: deferred() }
  const calls: string[] = []; const unhandled: unknown[] = []; const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await withFetch(async () => json('ok'), async () => {
      const gateway = createModelGateway(spec, profile, h.ledger, { durability: h.journal, trace: async event => {
        calls.push(event.type)
        if (event.type === 'settled') { assert.equal(h.ledger.snapshot().reservations[0].state, 'settled'); entered.resolve() }
        await gates[event.type].promise
        throw Error('SYNTHETIC_SECRET trace rejection')
      } })
      const result = watched(gateway.complete(input()))
      try {
        await entered.promise; await turn()
        assert.equal(result.settled(), false); assert.deepEqual(calls, ['reserved', 'dispatched', 'settled'])
        gates.settled.resolve(); gates.dispatched.resolve(); await turn()
        assert.equal(result.settled(), false)
      } finally { for (const gate of Object.values(gates)) gate.resolve() }
      assert.equal((await result.promise).content, 'ok'); await turn()
      assert.deepEqual(unhandled, []); assert.deepEqual(h.ledger.snapshot().total.actualProviderUsage, usage)
    })
  } finally { process.removeListener('unhandledRejection', onUnhandled) }
})

test('final source fence remains effective after actual asynchronous traces settle', async () => {
  const h = fixture(); const entered = deferred(); const gate = deferred(); let current = true
  await withFetch(async () => json('ok'), async () => {
    const gateway = createModelGateway(spec, profile, h.ledger, { durability: h.journal, trace: async event => {
      if (event.type === 'settled') { entered.resolve(); await gate.promise }
    } })
    const result = gateway.complete({ ...input(), dispatchGuard() { if (!current) throw Error('SYNTHETIC_SECRET stale source') } })
    const rejected = assert.rejects(result, error => (error as { code?: string }).code === 'model-failed' && !JSON.stringify(error).includes('SYNTHETIC_SECRET'))
    try { await entered.promise; current = false } finally { gate.resolve() }
    await rejected
    assert.equal(h.ledger.snapshot().reservations[0].state, 'settled')
    assert.deepEqual(h.ledger.snapshot().total.actualProviderUsage, usage)
  })
})

test('receipt failure retains unknown holds while accepted trace work is still drained', async () => {
  const receipt = { entered: deferred(), gate: deferred() }; const h = fixture(receipt, true); const traceGate = deferred()
  await withFetch(async () => json('ok'), async () => {
    const gateway = createModelGateway(spec, profile, h.ledger, { durability: h.journal, trace: async () => { await traceGate.promise } })
    const result = watched(gateway.complete(input()))
    const rejected = assert.rejects(result.promise, error => (error as { code?: string }).code === 'model-failed' && !JSON.stringify(error).includes('SYNTHETIC_SECRET'))
    try {
      await receipt.entered.promise; receipt.gate.resolve(); await turn()
      assert.equal(result.settled(), false)
      assert.equal(h.ledger.snapshot().reservations[0].state, 'unknown')
      assert.equal(h.ledger.snapshot().blocked, true)
      assert.ok(h.ledger.snapshot().total.outputTokens > 0)
    } finally { receipt.gate.resolve(); traceGate.resolve() }
    await rejected; assert.equal(h.ledger.snapshot().usageComplete, false)
  })
})

test('a durable invalid async dispatch guard sends nothing and is drained before the safe rejection', async () => {
  const h = fixture(); const entered = deferred(); const gate = deferred(); let sends = 0
  await withFetch(async () => { sends++; return json('unexpected') }, async () => {
    const gateway = createModelGateway(spec, profile, h.ledger, { durability: h.journal })
    const result = watched(gateway.complete({ ...input(), dispatchGuard: async () => { entered.resolve(); await gate.promise; throw Error('SYNTHETIC_SECRET invalid guard') } }))
    const rejected = assert.rejects(result.promise, error => (error as { code?: string }).code === 'invalid-argument' && !JSON.stringify(error).includes('SYNTHETIC_SECRET'))
    try { await entered.promise; await turn(); assert.equal(result.settled(), false); assert.equal(sends, 0) }
    finally { gate.resolve() }
    await rejected; assert.equal(h.ledger.snapshot().reservations.length, 0)
  })
})

test('legacy gateway leaves async diagnostic traces responsive and handles their rejections', async () => {
  const ledger = createBudgetLedger(spec); const gate = deferred(); const calls: string[] = []
  await withFetch(async () => json('ok'), async () => {
    const gateway = createModelGateway(spec, profile, ledger, { trace: async event => { calls.push(event.type); await gate.promise; throw Error('SYNTHETIC_SECRET legacy observer') } })
    try { assert.equal((await gateway.complete({ id: 'legacy-01', stage: 'generation', messages })).content, 'ok') }
    finally { gate.resolve() }
    await turn(); assert.deepEqual(calls, ['reserved', 'dispatched', 'settled'])
  })
})


test('production gateway durable opt-in carries actual reader cleanup through its receipt boundary', async () => {
  const h = fixture(); const entered = deferred(); const gate = deferred(); let cancellations = 0
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n')) },
    cancel() { cancellations++; entered.resolve(); return gate.promise }
  })
  await withFetch(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), async () => {
    const gateway = createModelGateway(spec, profile, h.ledger, { durability: h.journal })
    const result = watched(gateway.complete(input()))
    try {
      await entered.promise; await turn()
      assert.equal(result.settled(), false)
      assert.deepEqual(h.events.map(event => event.kind), ['reservation', 'intent'])
      assert.equal(h.ledger.snapshot().reservations[0].state, 'dispatched')
    } finally { gate.resolve() }
    assert.equal((await result.promise).content, 'ok'); assert.equal(cancellations, 1)
    assert.equal(h.events.at(-1)?.kind, 'receipt')
    assert.equal(h.ledger.snapshot().reservations[0].state, 'settled')
  })
})

test('original hard deadline is rechecked after actual trace settlement without losing known usage', async () => {
  let time = 0; const h = fixture(undefined, false, () => time); const entered = deferred(); const gate = deferred()
  await withFetch(async () => json('ok'), async () => {
    const gateway = createModelGateway(spec, profile, h.ledger, { durability: h.journal, trace: async event => {
      if (event.type === 'settled') { entered.resolve(); await gate.promise }
    } })
    const result = gateway.complete(input())
    const rejected = assert.rejects(result, { code: 'budget-exhausted' })
    try { await entered.promise; time = 600_000 } finally { gate.resolve() }
    await rejected
    assert.equal(h.ledger.snapshot().reservations[0].state, 'settled')
    assert.deepEqual(h.ledger.snapshot().total.actualProviderUsage, usage)
  })
})
