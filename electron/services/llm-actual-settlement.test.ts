import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node runner.
import { chatCompletion, chatCompletionStream, LlmRequestError } from './llm.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createActualSettlement } from './actual-settlement.ts'

const profile = { id: 'synthetic', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic' }
const messages = [{ role: 'user' as const, content: 'synthetic input' }]
const usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function watched<T>(promise: Promise<T>) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  return { promise, settled: () => settled }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const json = (content = 'synthetic output') => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try { await run() } finally { globalThis.fetch = original }
}

for (const durable of [true, false]) test((durable ? 'actual' : 'legacy') + ' delta abort observes the original callback lifetime', async () => {
  const controller = new AbortController(); const entered = deferred(); const gate = deferred()
  let callbacks = 0; let callbackFinished = false
  const receipts: unknown[] = []
  await withFetch(async () => json(), async () => {
    const result = watched(chatCompletionStream(profile, messages, async () => {
      callbacks++; entered.resolve(); await gate.promise; callbackFinished = true
    }, { signal: controller.signal, awaitActualSettlement: durable, onUsage: value => { receipts.push(value) } }))
    const rejected = assert.rejects(result.promise, { kind: 'cancelled' })
    try {
      await entered.promise; controller.abort(); await turn()
      assert.equal(result.settled(), !durable)
      assert.equal(callbackFinished, false)
      assert.deepEqual(receipts, [usage])
    } finally { gate.resolve() }
    await rejected; await turn()
    assert.equal(callbackFinished, true); assert.equal(callbacks, 1)
  })
})

test('actual delta timeout does not turn its abort race into callback settlement', async () => {
  const entered = deferred(); const gate = deferred(); const aborted = deferred()
  await withFetch(async (_url, options) => {
    options!.signal!.addEventListener('abort', () => aborted.resolve(), { once: true })
    return json()
  }, async () => {
    const result = watched(chatCompletionStream(profile, messages, async () => { entered.resolve(); await gate.promise }, { awaitActualSettlement: true, timeoutMs: 20 }))
    const rejected = assert.rejects(result.promise, { kind: 'timeout' })
    try {
      await entered.promise; await aborted.promise; await turn()
      assert.equal(result.settled(), false)
    } finally { gate.resolve() }
    await rejected
  })
})

test('actual admission captures a returned thenable once and never sends after cancellation', async () => {
  const controller = new AbortController(); const entered = deferred(); const gate = deferred()
  let sends = 0; let getterReads = 0
  const thenable = Object.defineProperty({}, 'then', { get() {
    getterReads++
    return (resolve: () => void, reject: (error: unknown) => void) => { entered.resolve(); void gate.promise.then(resolve, reject) }
  } })
  await withFetch(async () => { sends++; return json() }, async () => {
    const result = watched(chatCompletion(profile, messages, { signal: controller.signal, awaitActualSettlement: true, beforeRequest: () => thenable as Promise<void> }))
    const rejected = assert.rejects(result.promise, { kind: 'cancelled' })
    try {
      await entered.promise; controller.abort(); await turn()
      assert.equal(result.settled(), false); assert.equal(sends, 0)
    } finally { gate.resolve() }
    await rejected
    assert.equal(getterReads, 1); assert.equal(sends, 0)
  })
})

for (const durable of [true, false]) test((durable ? 'actual' : 'legacy') + ' malformed asynchronous final fence sends zero requests', async () => {
  const entered = deferred(); const gate = deferred(); let sends = 0
  const unhandled: unknown[] = []; const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await withFetch(async () => { sends++; return json() }, async () => {
      const result = watched(chatCompletion(profile, messages, { awaitActualSettlement: durable, beforeFetch: async () => {
        entered.resolve(); await gate.promise; throw Error('SYNTHETIC_SECRET malformed fence')
      } }))
      const rejected = assert.rejects(result.promise, error => error instanceof LlmRequestError && error.kind === 'response' && !JSON.stringify(error).includes('SYNTHETIC_SECRET'))
      try {
        await entered.promise; await turn()
        assert.equal(sends, 0); assert.equal(result.settled(), !durable)
      } finally { gate.resolve() }
      await rejected; await turn()
      assert.deepEqual(unhandled, [])
    })
  } finally { process.removeListener('unhandledRejection', onUnhandled) }
})

for (const durable of [true, false]) test((durable ? 'actual' : 'legacy') + ' request and usage observers keep diagnostic failures observational', async () => {
  const requestGate = deferred(); const usageGate = deferred(); const usageEntered = deferred()
  let requestCount = 0; let usageCount = 0
  const unhandled: unknown[] = []; const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await withFetch(async () => json(), async () => {
      const result = watched(chatCompletion(profile, messages, {
        awaitActualSettlement: durable,
        onRequest: async () => { requestCount++; await requestGate.promise; throw Error('SYNTHETIC_SECRET request observer') },
        onUsage: async value => { usageCount++; assert.deepEqual(value, usage); usageEntered.resolve(); await usageGate.promise; throw Error('SYNTHETIC_SECRET usage observer') }
      }))
      try {
        await usageEntered.promise; await turn()
        assert.equal(result.settled(), !durable)
        usageGate.resolve(); await turn()
        assert.equal(result.settled(), !durable)
      } finally { requestGate.resolve(); usageGate.resolve() }
      assert.equal(await result.promise, 'synthetic output'); await turn()
      assert.equal(requestCount, 1); assert.equal(usageCount, 1); assert.deepEqual(unhandled, [])
    })
  } finally { process.removeListener('unhandledRejection', onUnhandled) }
})

test('unexpected then getters on thenables and native promises stay observational and settle once', async () => {
  for (const target of [{}, Promise.resolve()]) {
    let reads = 0
    const unexpected = Object.defineProperty(target, 'then', { get() { reads++; throw Error('SYNTHETIC_SECRET then getter') } })
    await withFetch(async () => json(), async () => {
      assert.equal(await chatCompletion(profile, messages, { awaitActualSettlement: true, onRequest: () => unexpected }), 'synthetic output')
      assert.equal(reads, 1)
    })
  }
})

for (const durable of [true, false]) test((durable ? 'actual' : 'legacy') + ' HTTP body cancellation settles once without masking the original failure', async () => {
  const entered = deferred(); const gate = deferred(); let cancellations = 0
  const unhandled: unknown[] = []; const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await withFetch(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; entered.resolve(); return gate.promise } }), { status: 503 }), async () => {
      const result = watched(chatCompletion(profile, messages, { awaitActualSettlement: durable }))
      const rejected = assert.rejects(result.promise, error => error instanceof LlmRequestError && error.kind === 'http' && error.modelFailure?.httpStatus === 503 && !JSON.stringify(error).includes('SYNTHETIC_SECRET'))
      try {
        await entered.promise; await turn()
        assert.equal(result.settled(), !durable); assert.equal(cancellations, 1)
      } finally { gate.reject(Error('SYNTHETIC_SECRET cleanup failure')) }
      await rejected; await turn()
      assert.equal(cancellations, 1); assert.deepEqual(unhandled, [])
    })
  } finally { process.removeListener('unhandledRejection', onUnhandled) }
})

test('actual early abort after fetch drains the unused body cancellation', async () => {
  const controller = new AbortController(); const entered = deferred(); const gate = deferred(); let cancellations = 0
  await withFetch(async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; entered.resolve(); return gate.promise } }))
    controller.abort()
    return response
  }, async () => {
    const result = watched(chatCompletion(profile, messages, { awaitActualSettlement: true, signal: controller.signal }))
    const rejected = assert.rejects(result.promise, { kind: 'cancelled' })
    try { await entered.promise; await turn(); assert.equal(result.settled(), false) }
    finally { gate.resolve() }
    await rejected; assert.equal(cancellations, 1)
  })
})

for (const probing of [true, false]) test('actual ' + (probing ? 'probe' : 'SSE reader') + ' cancellation remains pending until original cleanup settles', async () => {
  const controller = new AbortController(); const entered = deferred(); const reading = deferred(); const gate = deferred(); let cancellations = 0; let readerCancelCalls = 0
  const body = new ReadableStream<Uint8Array>({
    start(stream) { if (probing) stream.enqueue(new TextEncoder().encode('   ')) },
    pull() { reading.resolve() },
    cancel() { cancellations++; entered.resolve(); return gate.promise }
  })
  const getReader = body.getReader.bind(body)
  Object.defineProperty(body, 'getReader', { value() {
    const reader = getReader()
    const cancel = reader.cancel.bind(reader)
    Object.defineProperty(reader, 'cancel', { value() { readerCancelCalls++; return cancel() } })
    return reader
  } })
  await withFetch(async () => new Response(body, { headers: { 'content-type': probing ? 'application/octet-stream' : 'text/event-stream' } }), async () => {
    const result = watched(chatCompletionStream(profile, messages, () => {}, { awaitActualSettlement: true, signal: controller.signal }))
    const rejected = assert.rejects(result.promise, { kind: 'cancelled' })
    try {
      await reading.promise; await turn(); controller.abort(); await entered.promise; await turn()
      assert.equal(result.settled(), false); assert.equal(cancellations, 1)
    } finally { gate.resolve() }
    await rejected; assert.equal(cancellations, 1); assert.equal(readerCancelCalls, 1); assert.equal(body.locked, false)
  })
})

test('actual normal SSE termination also waits for reader cancellation and preserves usage', async () => {
  const entered = deferred(); const gate = deferred(); let cancellations = 0; let receipt: unknown
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n')) },
    cancel() { cancellations++; entered.resolve(); return gate.promise }
  })
  await withFetch(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), async () => {
    const result = watched(chatCompletionStream(profile, messages, () => {}, { awaitActualSettlement: true, onUsage: value => { receipt = value } }))
    try { await entered.promise; await turn(); assert.equal(result.settled(), false); assert.deepEqual(receipt, usage) }
    finally { gate.resolve() }
    assert.equal(await result.promise, 'ok'); assert.equal(cancellations, 1); assert.equal(body.locked, false)
  })
})

test('local settlement seals admission and cannot wait for its own accepted callback', async () => {
  const settlement = createActualSettlement()
  const self = settlement.capture(() => settlement.sealAndDrain())
  await assert.rejects(self.settlement, /cannot wait for itself/)
  const gate = deferred(); let childFinished = false
  settlement.capture(() => {
    settlement.capture(async () => { await gate.promise; childFinished = true })
  })
  const drain = watched(settlement.sealAndDrain())
  assert.throws(() => settlement.capture(() => {}), /admission is closed/)
  try { await turn(); assert.equal(drain.settled(), false) } finally { gate.resolve() }
  await drain.promise; assert.equal(childFinished, true)
})
