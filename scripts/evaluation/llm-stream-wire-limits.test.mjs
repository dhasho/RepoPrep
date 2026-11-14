import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { chatCompletion, chatCompletionStream, LlmRequestError, LLM_RESPONSE_LIMITS } from '../../electron/services/llm.ts'
import { estimateMessageTokens } from '../../shared/token-budget.ts'
import { createBudgetLedger } from '../../electron/services/workflow/budget-ledger.ts'
import { createModelGateway } from '../../electron/services/workflow/model-gateway.ts'
import { createRunSpec } from '../../electron/services/workflow/run-spec.ts'
import { normalizeBaseUrl } from '../../electron/services/llm.ts'

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

function reasoningStreamFixture(reasoningFrames, usage = { inputTokens: 500, outputTokens: 10_000 }) {
  const visibleJson = '{"projectSummary":"synthetic","sections":[],"glossary":{}}'
  const envelope = delta => ({
    id: 'chatcmpl-synthetic-wire-frame',
    object: 'chat.completion.chunk',
    created: 1_793_000_000,
    model: 'synthetic-32k-model',
    system_fingerprint: 'fp_synthetic',
    choices: [{ index: 0, delta, finish_reason: null }]
  })
  const events = [frame(envelope({ content: visibleJson }))]
  for (let index = 0; index < reasoningFrames; index++) events.push(frame(envelope({ reasoning_content: 'r' })))
  events.push(frame({ ...envelope({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  const usageTail = frame({ id: 'chatcmpl-synthetic-usage', object: 'chat.completion.chunk', created: 1_793_000_000, model: 'synthetic-32k-model', choices: [], usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens } }) + 'data: [DONE]\n\n'
  return { visibleJson, events, usageTail, wire: events.join('') + usageTail }
}

async function withSyntheticFetch(fetcher, operation) {
  const previous = globalThis.fetch
  globalThis.fetch = fetcher
  try { return await operation() } finally { globalThis.fetch = previous }
}

async function observeStream(body, { timeoutMs = 5000, maxOutputTokens = 32_768, maxStreamBodyBytes } = {}) {
  let visible = '', usage = null, dispatched = false, failure = null, returned = null
  try {
    returned = await chatCompletionStream(profile, messages, delta => { visible += delta }, {
      timeoutMs,
      maxOutputTokens,
      ...(maxStreamBodyBytes !== undefined ? { maxStreamBodyBytes } : {}),
      beforeRequest: () => { dispatched = true },
      onUsage: value => { usage = value }
    })
  } catch (error) { failure = error }
  return { visible, usage, dispatched, failure, returned }
}

test('ignored reasoning frames count toward the 4 MiB SSE wire cap and can hide the final usage tail', async t => {
  const reasoningFrames = 20_000
  const { visibleJson, events, usageTail, wire } = reasoningStreamFixture(reasoningFrames)
  const body = streamFromText(wire)
  const tailStartByte = encoder.encode(events.join('')).byteLength
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response(body.body, { headers: { 'content-type': 'text/event-stream' } })
  let observed
  try { observed = await observeStream(body.body) } finally { globalThis.fetch = previous }
  const safeKind = observed.failure instanceof LlmRequestError ? observed.failure.kind : 'other'
  const safeFinishReason = observed.failure instanceof LlmRequestError ? observed.failure.modelFailure.finishReason ?? 'none' : 'none'
  const safeResponseLimit = observed.failure instanceof LlmRequestError ? observed.failure.modelFailure.responseLimit ?? 'none' : 'none'
  t.diagnostic(JSON.stringify({
    wireBytes: body.totalBytes,
    bodyLimitBytes: LLM_RESPONSE_LIMITS.chatBodyBytes,
    bytesPulledByStream: body.producedBytes,
    ignoredReasoningChars: reasoningFrames,
    usageTailStartByte: tailStartByte,
    visibleContentChars: observed.visible.length,
    dispatchStarted: observed.dispatched,
    usageReported: observed.usage !== null,
    errorKind: safeKind,
    finishReason: safeFinishReason,
    responseLimit: safeResponseLimit
  }))
  assert.ok(body.totalBytes > LLM_RESPONSE_LIMITS.chatBodyBytes)
  assert.ok(reasoningFrames < 32_768, 'synthetic ignored reasoning remains below the authorized output-token ceiling')
  assert.ok(tailStartByte >= LLM_RESPONSE_LIMITS.chatBodyBytes)
  assert.equal(observed.dispatched, true)
  assert.equal(observed.visible, visibleJson)
  assert.equal(observed.usage, null)
  assert.equal(body.cancelled, true)
  assert.ok(observed.failure instanceof LlmRequestError)
  assert.equal(observed.failure.kind, 'response')
  assert.equal(observed.failure.modelFailure.finishReason, undefined)
  assert.equal(observed.failure.modelFailure.responseLimit, 'stream-bytes')

  const belowLimitEvents = [events[0], ...events.slice(1, 10_001), events.at(-1), usageTail]
  const belowLimitWire = belowLimitEvents.join('')
  const belowLimitBody = streamFromText(belowLimitWire)
  assert.ok(belowLimitBody.totalBytes < LLM_RESPONSE_LIMITS.chatBodyBytes)
  const belowLimit = await withSyntheticFetch(async () => new Response(belowLimitBody.body, { headers: { 'content-type': 'text/event-stream' } }), () => observeStream(belowLimitBody.body))
  assert.equal(belowLimit.returned, visibleJson)
  assert.deepEqual(belowLimit.usage, { inputTokens: 500, outputTokens: 10_000, totalTokens: 10_500 })
})

test('M05 reserved output allowance permits a 32k stream with small visible output and one complete receipt', async () => {
  const profile = { ...({ id: 'm05-wire-profile', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-model', protocol: 'openai', temperature: 0.4 }), contextWindowTokens: 65_536, maxOutputTokens: 32_768 }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  const spec = createRunSpec({
    version: 1, runId: 'm05-wire-32k', projectId: 'synthetic-project', snapshotId: 'synthetic-snapshot', strategy: 'agentic', strategyVersion: 'agentic-v1',
    roleFocus: 'backend', granularity: 'fine',
    model: { profileId: profile.id, endpointFingerprint, model: profile.model, protocol: profile.protocol, temperature: 0.4, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens },
    promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1'
  })
  const requestMessages = [{ role: 'user', content: 'synthetic M05 request '.repeat(100) }]
  const inputTokens = estimateMessageTokens(requestMessages)
  const fixture = reasoningStreamFixture(20_000, { inputTokens, outputTokens: 10_000 })
  const body = streamFromText(fixture.wire)
  const ledger = createBudgetLedger(spec)
  const gateway = createModelGateway(spec, profile, ledger)
  let requestBody
  const completion = await withSyntheticFetch(async (_url, init) => {
    requestBody = JSON.parse(init.body)
    return new Response(body.body, { headers: { 'content-type': 'text/event-stream' } })
  }, () => gateway.complete({ id: 'm05-wire-call', stage: 'generation', messages: requestMessages }))

  assert.equal(completion.content, fixture.visibleJson)
  assert.deepEqual(completion.usage, { inputTokens, outputTokens: 10_000, totalTokens: inputTokens + 10_000 })
  assert.equal(requestBody.max_tokens, 32_768)
  assert.equal(Object.hasOwn(requestBody, 'maxStreamBodyBytes'), false)
  assert.ok(fixture.wire.length > LLM_RESPONSE_LIMITS.chatBodyBytes)
  assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().usageComplete, true)
  assert.equal(ledger.snapshot().reservations[0].state, 'settled')
  assert.equal(ledger.snapshot().total.outputTokens, 10_000)
  assert.deepEqual(ledger.snapshot().total.actualProviderUsage, { inputTokens, outputTokens: 10_000, totalTokens: inputTokens + 10_000 })
  assert.equal(body.cancelled, false)
})

test('an explicitly smaller stream allowance rejects the same wire before usage and releases its reader', async () => {
  const { wire } = reasoningStreamFixture(20_000)
  const body = streamFromText(wire)
  const allowance = LLM_RESPONSE_LIMITS.chatBodyBytes + 1024
  assert.ok(body.totalBytes > allowance)
  const result = await withSyntheticFetch(async () => new Response(body.body, { headers: { 'content-type': 'text/event-stream' } }), () => observeStream(body.body, { maxStreamBodyBytes: allowance }))
  assert.ok(result.failure instanceof LlmRequestError)
  assert.equal(result.failure.modelFailure.responseLimit, 'stream-bytes')
  assert.equal(result.usage, null)
  assert.equal(body.cancelled, true)
  assert.equal(body.body.locked, false)
})

test('an M05 request with the 2k output reservation keeps unknown usage when its 4 MiB floor is exceeded', async () => {
  const profile = { ...({ id: 'm05-wire-2k', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-model', protocol: 'openai', temperature: 0.4 }), contextWindowTokens: 49_152, maxOutputTokens: 2000 }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  const spec = createRunSpec({
    version: 1, runId: 'm05-wire-2k', projectId: 'synthetic-project', snapshotId: 'synthetic-snapshot', strategy: 'agentic', strategyVersion: 'agentic-v1',
    roleFocus: 'backend', granularity: 'fine',
    model: { profileId: profile.id, endpointFingerprint, model: profile.model, protocol: profile.protocol, temperature: 0.4, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens },
    promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1'
  })
  const requestMessages = [{ role: 'user', content: 'synthetic M05 request '.repeat(100) }]
  const inputTokens = estimateMessageTokens(requestMessages)
  const wire = reasoningStreamFixture(20_000, { inputTokens, outputTokens: 1000 }).wire
  const body = streamFromText(wire)
  const ledger = createBudgetLedger(spec)
  const gateway = createModelGateway(spec, profile, ledger)
  await withSyntheticFetch(async () => new Response(body.body, { headers: { 'content-type': 'text/event-stream' } }), async () => {
    await assert.rejects(gateway.complete({ id: 'm05-wire-2k-call', stage: 'generation', messages: requestMessages }), error => {
      assert.equal(error?.modelFailure?.responseLimit, 'stream-bytes')
      return true
    })
  })
  assert.equal(ledger.snapshot().total.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().usageComplete, false)
  assert.equal(ledger.snapshot().reservations[0].state, 'unknown')
  assert.equal(body.cancelled, true)
  assert.equal(body.body.locked, false)
})

test('unknown content-type probing uses bounded prefix state and JSON fallback keeps its 4 MiB cap', async () => {
  const prefix = ' '.repeat(LLM_RESPONSE_LIMITS.chatBodyBytes + 64)
  const json = `${prefix}{"choices":[{"message":{"content":"synthetic"}}]}`
  const body = streamFromText(json, encoder.encode(json).byteLength)
  assert.ok(body.totalBytes < 8 * 1024 * 1024)
  await withSyntheticFetch(async () => new Response(body.body, { headers: { 'content-type': 'application/octet-stream' } }), async () => {
    await assert.rejects(chatCompletionStream(profile, messages, () => undefined, { maxStreamBodyBytes: 8 * 1024 * 1024 }), error => error instanceof LlmRequestError && error.kind === 'response' && error.modelFailure.responseLimit === undefined)
  })
  assert.equal(body.body.locked, false)
})

test('M05 output reservation derives the legacy floor, invalid caps block before fetch, and JSON stays at 4 MiB', async () => {
  let fetchCalls = 0, beforeRequestCalls = 0
  await withSyntheticFetch(async () => { fetchCalls++; throw new Error('fetch-must-not-run') }, async () => {
    await assert.rejects(chatCompletionStream(profile, messages, () => undefined, {
      maxOutputTokens: 32_768,
      maxStreamBodyBytes: LLM_RESPONSE_LIMITS.maxStreamBodyBytes + 1,
      beforeRequest: () => { beforeRequestCalls++ }
    }), error => error instanceof LlmRequestError && error.kind === 'response')
  })
  assert.equal(fetchCalls, 0)
  assert.equal(beforeRequestCalls, 0)
  assert.equal(Math.max(LLM_RESPONSE_LIMITS.chatBodyBytes, Math.min(LLM_RESPONSE_LIMITS.maxStreamBodyBytes, 2000 * 1024)), LLM_RESPONSE_LIMITS.chatBodyBytes)

  const jsonBody = JSON.stringify({ choices: [{ message: { content: 'synthetic' } }], padding: 'x'.repeat(LLM_RESPONSE_LIMITS.chatBodyBytes + 16) })
  assert.ok(encoder.encode(jsonBody).byteLength > LLM_RESPONSE_LIMITS.chatBodyBytes)
  await withSyntheticFetch(async () => new Response(jsonBody, { headers: { 'content-type': 'application/json' } }), async () => {
    await assert.rejects(chatCompletionStream(profile, messages, () => undefined, { maxStreamBodyBytes: LLM_RESPONSE_LIMITS.maxStreamBodyBytes }), error => error instanceof LlmRequestError && error.kind === 'response' && error.modelFailure.responseLimit === undefined)
  })
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
