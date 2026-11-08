import assert from 'node:assert/strict'
import test from 'node:test'
import { chatCompletionStream, LlmRequestError, LLM_RESPONSE_LIMITS } from '../../electron/services/llm.ts'

const profile = Object.freeze({
  id: 'synthetic-wire-profile', name: 'Synthetic wire diagnostic', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY',
  model: 'synthetic-model', protocol: 'openai', temperature: 0.4, contextWindowTokens: 65_536, maxOutputTokens: 32_768
})
const messages = Object.freeze([{ role: 'user', content: 'synthetic wire limit diagnostic' }])
const encoder = new TextEncoder()
const frame = value => `data: ${JSON.stringify(value)}\n\n`

function streamFromText(text, chunkBytes = 8192) {
  const source = encoder.encode(text)
  let offset = 0, producedBytes = 0, cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= source.byteLength) { controller.close(); return }
      const end = Math.min(source.byteLength, offset + chunkBytes)
      const bytes = source.slice(offset, end)
      offset = end
      producedBytes += bytes.byteLength
      controller.enqueue(bytes)
    },
    cancel() { cancelled = true }
  })
  return { body, get producedBytes() { return producedBytes }, get cancelled() { return cancelled }, totalBytes: source.byteLength }
}

async function withSyntheticFetch(fetcher, operation) {
  const previous = globalThis.fetch
  globalThis.fetch = fetcher
  try { return await operation() } finally { globalThis.fetch = previous }
}

async function observeStream(body, { timeoutMs = 5000, maxOutputTokens = 32_768 } = {}) {
  let visible = '', usage = null, dispatched = false, failure = null, returned = null
  try {
    returned = await chatCompletionStream(profile, messages, delta => { visible += delta }, {
      timeoutMs,
      maxOutputTokens,
      beforeRequest: () => { dispatched = true },
      onUsage: value => { usage = value }
    })
  } catch (error) { failure = error }
  return { visible, usage, dispatched, failure, returned }
}

test('ignored reasoning frames count toward the 4 MiB SSE wire cap and can hide the final usage tail', async t => {
  const visibleJson = '{"projectSummary":"synthetic","sections":[],"glossary":{}}'
  const events = [frame({ choices: [{ index: 0, delta: { content: visibleJson }, finish_reason: null }] })]
  for (let index = 0; index < 128; index++) {
    events.push(frame({ choices: [{ index: 0, delta: { reasoning_content: 'r'.repeat(32_768) }, finish_reason: null }] }))
  }
  events.push(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  const usageTail = frame({ choices: [], usage: { prompt_tokens: 37, completion_tokens: 19, total_tokens: 56 } }) + 'data: [DONE]\n\n'
  const wire = events.join('') + usageTail
  const body = streamFromText(wire)
  const tailStartByte = encoder.encode(events.join('')).byteLength
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response(body.body, { headers: { 'content-type': 'text/event-stream' } })
  let observed
  try { observed = await observeStream(body.body) } finally { globalThis.fetch = previous }
  const safeKind = observed.failure instanceof LlmRequestError ? observed.failure.kind : 'other'
  const safeFinishReason = observed.failure instanceof LlmRequestError ? observed.failure.modelFailure.finishReason ?? 'none' : 'none'
  t.diagnostic(JSON.stringify({
    wireBytes: body.totalBytes,
    bodyLimitBytes: LLM_RESPONSE_LIMITS.chatBodyBytes,
    bytesPulledByStream: body.producedBytes,
    usageTailStartByte: tailStartByte,
    visibleContentChars: observed.visible.length,
    dispatchStarted: observed.dispatched,
    usageReported: observed.usage !== null,
    errorKind: safeKind,
    finishReason: safeFinishReason
  }))
  assert.ok(body.totalBytes > LLM_RESPONSE_LIMITS.chatBodyBytes)
  assert.ok(tailStartByte >= LLM_RESPONSE_LIMITS.chatBodyBytes)
  assert.equal(observed.dispatched, true)
  assert.equal(observed.visible, visibleJson)
  assert.equal(observed.usage, null)
  assert.equal(body.cancelled, true)
  assert.ok(observed.failure instanceof LlmRequestError)
  assert.equal(observed.failure.kind, 'response')
  assert.equal(observed.failure.modelFailure.finishReason, undefined)

  const belowLimitEvents = [events[0], ...events.slice(1, 101), events.at(-1), usageTail]
  const belowLimitWire = belowLimitEvents.join('')
  const belowLimitBody = streamFromText(belowLimitWire)
  assert.ok(belowLimitBody.totalBytes < LLM_RESPONSE_LIMITS.chatBodyBytes)
  const belowLimit = await withSyntheticFetch(async () => new Response(belowLimitBody.body, { headers: { 'content-type': 'text/event-stream' } }), () => observeStream(belowLimitBody.body))
  assert.equal(belowLimit.returned, visibleJson)
  assert.deepEqual(belowLimit.usage, { inputTokens: 37, outputTokens: 19, totalTokens: 56 })
})

test('the 1 MiB SSE event buffer and 1,000,000 visible-content cap are independent limits', async () => {
  const oversizedEventWire = frame({ choices: [{ index: 0, delta: { reasoning_content: 'e'.repeat(1_000_100) }, finish_reason: null }] })
  assert.ok(encoder.encode(oversizedEventWire).byteLength < LLM_RESPONSE_LIMITS.chatBodyBytes)
  const eventBody = streamFromText(oversizedEventWire)
  const eventResult = await withSyntheticFetch(async () => new Response(eventBody.body, { headers: { 'content-type': 'text/event-stream' } }), () => observeStream(eventBody.body))
  assert.ok(eventResult.failure instanceof LlmRequestError)
  assert.equal(eventResult.failure.kind, 'response')
  assert.equal(eventResult.visible, '')
  assert.equal(eventResult.usage, null)

  const contentFrames = Array.from({ length: 11 }, () => frame({ choices: [{ index: 0, delta: { content: 'c'.repeat(100_000) }, finish_reason: null }] }))
  contentFrames.push(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  contentFrames.push(frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }))
  const contentWire = contentFrames.join('')
  assert.ok(encoder.encode(contentWire).byteLength < LLM_RESPONSE_LIMITS.chatBodyBytes)
  const contentBody = streamFromText(contentWire)
  const contentResult = await withSyntheticFetch(async () => new Response(contentBody.body, { headers: { 'content-type': 'text/event-stream' } }), () => observeStream(contentBody.body))
  assert.ok(contentResult.failure instanceof LlmRequestError)
  assert.equal(contentResult.failure.kind, 'response')
  assert.equal(contentResult.visible.length, LLM_RESPONSE_LIMITS.chatContentChars)
  assert.equal(contentResult.usage, null)
})

test('request timeout remains separate from body, event and visible-content bounds', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('synthetic timeout', 'AbortError')), { once: true })
  })
  try {
    const result = await observeStream(null, { timeoutMs: 20, maxOutputTokens: 32_768 })
    assert.ok(result.failure instanceof LlmRequestError)
    assert.equal(result.failure.kind, 'timeout')
    assert.equal(result.usage, null)
    assert.equal(result.visible, '')
  } finally { globalThis.fetch = previous }
})
