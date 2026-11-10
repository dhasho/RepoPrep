import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node runner.
import { chatCompletion, chatCompletionStream } from './llm.ts'
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
}
