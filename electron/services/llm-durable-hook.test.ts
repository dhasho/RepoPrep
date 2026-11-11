import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node runner.
import { chatCompletion, chatCompletionStream, LlmRequestError } from './llm.ts'
const messages = [{ role: 'user' as const, content: 'synthetic input' }]
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
for (const protocol of ['openai', 'anthropic'] as const) for (const stream of [false, true]) {
  const label = protocol + (stream ? '-stream' : '-non-stream')
  const profile = { id: 'p', name: 'Synthetic', baseUrl: 'https://synthetic.invalid', apiKey: 'SYNTHETIC', model: 'synthetic', protocol }
  const response = () => new Response(JSON.stringify(protocol === 'anthropic' ? { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'synthetic response' }], usage: { input_tokens: 2, output_tokens: 1 } } : { choices: [{ message: { content: 'synthetic response' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
  const call = (options: Parameters<typeof chatCompletion>[2]) => stream ? chatCompletionStream(profile, messages, () => {}, options) : chatCompletion(profile, messages, options)
  test(label + ' awaits admission before fetch and observer', async () => {
    const original = globalThis.fetch; const gate = deferred(); const entered = deferred(); const events: string[] = []
    globalThis.fetch = async () => { events.push('fetch'); return response() }
    try {
      const result = call({ beforeRequest: async () => { events.push('guard'); entered.resolve(); await gate.promise; events.push('flush') }, onRequest: () => { events.push('observer') } })
      await entered.promise
      assert.deepEqual(events, ['guard']); gate.resolve()
      assert.equal(await result, 'synthetic response'); assert.deepEqual(events, ['guard', 'flush', 'observer', 'fetch'])
    } finally { globalThis.fetch = original }
  })
  test(label + ' rejects async admission and cancellation during await before HTTP', async () => {
    const original = globalThis.fetch; let calls = 0
    globalThis.fetch = async () => { calls++; return response() }
    try {
      const safeFailure = Error('Static admission failure.')
      await assert.rejects(call({ beforeRequest: async () => { await Promise.resolve(); throw safeFailure } }), error => error === safeFailure)
      const controller = new AbortController(); const gate = deferred(); const entered = deferred()
      const rejected = assert.rejects(call({ signal: controller.signal, beforeRequest: async () => { entered.resolve(); await gate.promise } }))
      await entered.promise; controller.abort(); gate.resolve(); await rejected
      assert.equal(calls, 0)
      await assert.rejects(call({ signal: controller.signal }))
      assert.equal(calls, 0)
    } finally { globalThis.fetch = original }
  })
  test(label + ' runs the final synchronous fence after observers without another await', async () => {
    const original = globalThis.fetch; const events: string[] = []
    globalThis.fetch = async () => { events.push('fetch'); return response() }
    try {
      const result = call({ beforeRequest() { events.push('admission') }, onRequest() { events.push('observer') }, beforeFetch() { events.push('fence') } })
      assert.deepEqual(events, ['admission', 'observer', 'fence', 'fetch'])
      assert.equal(await result, 'synthetic response')
    } finally { globalThis.fetch = original }
  })
  test(label + ' rechecks live authorization after asynchronous preparation with the signal still alive', async () => {
    const original = globalThis.fetch; const controller = new AbortController(); const gate = deferred(); const entered = deferred()
    const failure = new Error('Static final fence failure.'); let current = true; let calls = 0
    globalThis.fetch = async () => { calls++; return response() }
    try {
      const rejected = assert.rejects(call({ signal: controller.signal, beforeRequest: async () => { entered.resolve(); await gate.promise }, beforeFetch() { if (!current) throw failure } }), error => error === failure)
      await entered.promise; current = false; gate.resolve(); await rejected
      assert.equal(controller.signal.aborted, false); assert.equal(calls, 0)
    } finally { globalThis.fetch = original }
  })
  test(label + ' prevents fetch when an observer revokes authorization or the final guard cancels', async () => {
    const original = globalThis.fetch; let calls = 0
    globalThis.fetch = async () => { calls++; return response() }
    try {
      const failure = new Error('Static final fence failure.'); let current = true
      await assert.rejects(call({ onRequest() { current = false; throw Error('observer failure') }, beforeFetch() { if (!current) throw failure } }), error => error === failure)
      const controller = new AbortController()
      await assert.rejects(call({ signal: controller.signal, beforeFetch() { controller.abort() } }), { kind: 'cancelled' })
      assert.equal(calls, 0)
    } finally { globalThis.fetch = original }
  })
  test(label + ' rejects asynchronous and non-void final guards as authoritative failures before HTTP', async () => {
    const original = globalThis.fetch; let calls = 0
    globalThis.fetch = async () => { calls++; return response() }
    const guards: (() => unknown)[] = [() => true, () => null, () => Promise.resolve(), async () => { throw Error('SYNTHETIC_SECRET invalid async fence') }]
    try {
      for (const beforeFetch of guards) await assert.rejects(call({ beforeFetch: beforeFetch as () => void }), error => error instanceof LlmRequestError && error.kind === 'response' && !JSON.stringify(error).includes('SYNTHETIC_SECRET'))
      assert.equal(calls, 0)
    } finally { globalThis.fetch = original }
  })
}
