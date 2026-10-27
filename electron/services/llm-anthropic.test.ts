// Synthetic Anthropic Messages wire tests; no account or provider credentials are used.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { chatCompletion, chatCompletionStream, LlmRequestError, listModels, LLM_RESPONSE_LIMITS, testConnection } from './llm.ts'

const profile = {
  id: 'synthetic-claude',
  name: 'Synthetic Claude',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'synthetic-anthropic-key',
  model: 'claude-synthetic',
  protocol: 'anthropic' as const,
  temperature: 0.1
}
const messages = [
  { role: 'system' as const, content: 'System one.' },
  { role: 'user' as const, content: 'Question one.' },
  { role: 'system' as const, content: 'System two.' },
  { role: 'assistant' as const, content: 'Earlier answer.' },
  { role: 'user' as const, content: 'Question two.' }
]
const encoder = new TextEncoder()

async function withFetch(mockFetch: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = mockFetch
  try { await run() } finally { globalThis.fetch = original }
}

function messageResponse(content: unknown[], stopReason: unknown = 'end_turn'): Response {
  return new Response(JSON.stringify({ type: 'message', role: 'assistant', content, stop_reason: stopReason }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function event(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`
}

function streamResponse(chunks: Array<string | Uint8Array>): { response: Response; get cancelCalls(): number } {
  let cancelCalls = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
    cancel() { cancelCalls++ }
  })
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    get cancelCalls() { return cancelCalls }
  }
}

function assertSafeError(error: unknown, kind: LlmRequestError['kind'] = 'response'): void {
  assert.ok(error instanceof LlmRequestError)
  assert.equal(error.kind, kind)
  assert.doesNotMatch(error.message, /synthetic-anthropic-key|api\.anthropic\.com|UPSTREAM_SECRET/)
}

test('Anthropic Messages uses normalized endpoints, dedicated headers, required max_tokens, and text blocks only', async () => {
  let captured: { url: string; init: RequestInit } | undefined
  await withFetch(async (input, init) => {
    captured = { url: String(input), init: init ?? {} }
    return messageResponse([
      { type: 'thinking', thinking: 'THINKING_MUST_NOT_ESCAPE' },
      { type: 'text', text: 'Hello ' },
      { type: 'tool_use', id: 'tool', name: 'ignored', input: { secret: 'not text' } },
      { type: 'text', text: '世界' }
    ])
  }, async () => {
    assert.equal(await chatCompletion(profile, messages), 'Hello 世界')
  })

  assert.equal(captured?.url, 'https://api.anthropic.com/v1/messages')
  const headers = captured?.init.headers as Record<string, string>
  assert.equal(headers['x-api-key'], 'synthetic-anthropic-key')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers.Authorization, undefined)
  const body = JSON.parse(String(captured?.init.body)) as Record<string, unknown>
  assert.equal(body.model, profile.model)
  assert.equal(body.system, 'System one.\n\nSystem two.')
  assert.equal(body.max_tokens, 16_384)
  assert.equal(body.stream, false)
  assert.equal(body.temperature, undefined, 'Anthropic must omit sampling temperature')
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'Question one.' },
    { role: 'assistant', content: 'Earlier answer.' },
    { role: 'user', content: 'Question two.' }
  ])
})

test('Anthropic usage receipts expose only bounded numeric token counts', async () => {
  const receipts: unknown[] = []
  await withFetch(async () => new Response(JSON.stringify({
    type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    usage: { input_tokens: 19, output_tokens: 3 }
  })), async () => {
    assert.equal(await chatCompletion(profile, [{ role: 'user', content: 'hello' }], { onUsage: (usage) => receipts.push(usage) }), 'ok')
  })
  assert.deepEqual(receipts, [{ inputTokens: 19, outputTokens: 3, totalTokens: 22 }])
})

test('Anthropic requests normalize compatible provider base paths and honor an explicit output limit', async () => {
  const cases = [
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic/v1/messages'],
    ['https://open.bigmodel.cn/api/anthropic', 'https://open.bigmodel.cn/api/anthropic/v1/messages']
  ] as const
  for (const [baseUrl, expectedUrl] of cases) {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: Record<string, unknown> = {}
    await withFetch(async (input, init) => {
      capturedUrl = String(input)
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return messageResponse([{ type: 'text', text: 'ok' }])
    }, async () => {
      assert.equal(await chatCompletion({ ...profile, baseUrl, apiKey: '' }, messages, { maxOutputTokens: 37 }), 'ok')
    })
    assert.equal(capturedUrl, expectedUrl)
    assert.equal(capturedHeaders['x-api-key'], undefined, 'a blank key is not sent as a header')
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01')
    assert.equal(capturedBody.max_tokens, 37)
  }
})

test('non-streaming Anthropic responses validate blocks, Unicode, output bounds, and truncation', async () => {
  for (const body of [
    { type: 'message', content: 'not an array', stop_reason: 'end_turn' },
    { type: 'message', content: [{ type: 'text', text: '\ud800' }], stop_reason: 'end_turn' },
    { type: 'message', content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' },
    { type: 'message', content: [{ type: 'text' }], stop_reason: 'end_turn' }
  ]) {
    await withFetch(async () => new Response(JSON.stringify(body)), async () => {
      await assert.rejects(chatCompletion(profile, messages), (error: unknown) => {
        assertSafeError(error)
        return true
      })
    })
  }

  const oversized = 'a'.repeat(LLM_RESPONSE_LIMITS.chatContentChars + 1)
  await withFetch(async () => messageResponse([{ type: 'text', text: oversized }]), async () => {
    await assert.rejects(chatCompletion(profile, messages), (error: unknown) => {
      assertSafeError(error)
      return true
    })
  })

  await withFetch(async () => messageResponse([{ type: 'text', text: '' }]), async () => {
    assert.equal(await chatCompletion(profile, messages), '', 'a structurally valid empty non-streaming response remains legal')
  })
})

test('connection testing uses Anthropic protocol and returns only static success guidance', async () => {
  let capturedUrl = ''
  let capturedHeaders: Record<string, string> = {}
  let capturedBody: Record<string, unknown> = {}
  await withFetch(async (input, init) => {
    capturedUrl = String(input)
    capturedHeaders = init?.headers as Record<string, string>
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return messageResponse([{ type: 'text', text: 'provider could echo arbitrary model content' }])
  }, async () => {
    assert.deepEqual(await testConnection(profile), { ok: true, message: '连接成功，配置可用。' })
  })
  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages')
  assert.equal(capturedHeaders['x-api-key'], profile.apiKey)
  assert.equal(capturedBody.max_tokens, 16)
  assert.equal(capturedBody.temperature, undefined)
})

test('Anthropic SSE handles initial text, deltas, thinking, ping, tools, and future events', async () => {
  const wire = [
    event('message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [] } }),
    event('ping', { type: 'ping' }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hello' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'THINKING_MUST_NOT_ESCAPE' } }),
    event('future_event_v99', { future: 'this JSON shape is intentionally unknown' }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' 世界' } }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool', name: 'ignore', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"secret":true}' } }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }),
    event('message_stop', { type: 'message_stop' })
  ].join('')
  const encoded = encoder.encode(wire)
  const response = streamResponse(Array.from(encoded, (_byte, index) => encoded.subarray(index, index + 1)))
  const deltas: string[] = []
  await withFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(body.stream, true)
    assert.equal(body.max_tokens, 16_384)
    assert.equal(body.temperature, undefined)
    return response.response
  }, async () => {
    assert.equal(await chatCompletionStream(profile, messages, (delta) => { deltas.push(delta) }), 'Hello 世界')
  })
  assert.deepEqual(deltas, ['Hello', ' 世界'])
  assert.equal(response.response.body?.locked, false)
})

test('Anthropic streaming usage accumulates across message_start and message_delta', async () => {
  const response = streamResponse([
    event('message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 11 } } }),
    event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    event('message_stop', { type: 'message_stop' })
  ])
  const receipts: unknown[] = []
  await withFetch(async () => response.response, async () => {
    assert.equal(await chatCompletionStream(profile, messages, () => {}, { onUsage: (usage) => receipts.push(usage) }), 'answer')
  })
  assert.deepEqual(receipts, [{ inputTokens: 11, outputTokens: 5, totalTokens: 16 }])
})

test('Anthropic stream fallback accepts one JSON response and invokes the callback once', async () => {
  let calls = 0
  const deltas: string[] = []
  await withFetch(async () => {
    calls++
    return new Response(JSON.stringify({
      type: 'message', content: [{ type: 'text', text: 'whole answer' }], stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 4 }
    }))
  }, async () => {
    assert.equal(await chatCompletionStream(profile, messages, async (delta) => { deltas.push(delta) }), 'whole answer')
  })
  assert.equal(calls, 1)
  assert.deepEqual(deltas, ['whole answer'])
})

test('Anthropic SSE rejects errors, malformed data, max_tokens truncation, missing terminal events, and empty output', async () => {
  const invalidStreams = [
    [event('error', { type: 'error', error: { message: 'UPSTREAM_SECRET synthetic-anthropic-key' } })],
    [event('content_block_delta', { type: 'content_block_delta', error: { message: 'UPSTREAM_SECRET' } })],
    [event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }), event('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } })],
    [event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }), event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })],
    [event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '   ' } }), event('message_stop', { type: 'message_stop' })],
    ['event: content_block_delta\ndata: {not-json}\n\n'],
    [event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(LLM_RESPONSE_LIMITS.chatContentChars + 10) } })]
  ]
  for (const chunks of invalidStreams) {
    const response = streamResponse(chunks)
    await withFetch(async () => response.response, async () => {
      await assert.rejects(chatCompletionStream(profile, messages, () => {}), (error: unknown) => {
        assertSafeError(error)
        return true
      })
    })
    assert.equal(response.response.body?.locked, false)
  }
})

test('Anthropic SSE callback errors retain the existing failure and reader cleanup behavior', async () => {
  const response = streamResponse([
    event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } }),
    event('message_stop', { type: 'message_stop' })
  ])
  const callbackError = new Error('synthetic callback error')
  await withFetch(async () => response.response, async () => {
    await assert.rejects(chatCompletionStream(profile, messages, () => { throw callbackError }), (error: unknown) => {
      return error === callbackError
    })
  })
  assert.equal(response.response.body?.locked, false)
})

test('Anthropic request timeout and caller cancellation retain the shared request lifecycle', async () => {
  await withFetch(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal
    signal.addEventListener('abort', () => {
      const error = new Error('synthetic transport abort')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  }), async () => {
    await assert.rejects(chatCompletion(profile, messages, { timeoutMs: 5 }), (error: unknown) => {
      assertSafeError(error, 'timeout')
      return true
    })
  })

  const caller = new AbortController()
  let bodyCancelCalls = 0
  let started!: () => void
  const reading = new Promise<void>((resolve) => { started = resolve })
  const body = new ReadableStream<Uint8Array>({
    start() { started() },
    cancel() { bodyCancelCalls++ }
  })
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  await withFetch(async () => response, async () => {
    const pending = chatCompletionStream(profile, messages, () => {}, { signal: caller.signal })
    await reading
    caller.abort()
    await assert.rejects(pending, (error: unknown) => {
      assertSafeError(error, 'cancelled')
      return true
    })
  })
  assert.ok(bodyCancelCalls > 0)
  assert.equal(response.body?.locked, false)
})

test('Anthropic model listing follows cursors, tolerates one-page third-party data, and rejects repeated cursors safely', async () => {
  const seenUrls: URL[] = []
  await withFetch(async (input, init) => {
    const url = new URL(String(input))
    seenUrls.push(url)
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], profile.apiKey)
    assert.equal((init?.headers as Record<string, string>)['anthropic-version'], '2023-06-01')
    if (!url.searchParams.has('after_id')) {
      return new Response(JSON.stringify({ data: [{ id: 'claude-alpha' }], has_more: true, last_id: 'cursor-one' }))
    }
    assert.equal(url.searchParams.get('after_id'), 'cursor-one')
    return new Response(JSON.stringify({ data: [{ id: 'claude-beta' }, { id: 'claude-alpha' }], has_more: false, last_id: 'ignored-final' }))
  }, async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['claude-alpha', 'claude-beta'])
  })
  assert.equal(seenUrls.length, 2)
  assert.equal(seenUrls[0].pathname, '/v1/models')
  assert.equal(seenUrls[0].searchParams.get('limit'), '100')

  await withFetch(async () => new Response(JSON.stringify({ data: [{ id: 'manual-model' }] })), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['manual-model'])
  })

  let fetchCalls = 0
  await withFetch(async () => {
    fetchCalls++
    return new Response(JSON.stringify({ data: [{ id: 'model' }], has_more: true, last_id: 'repeat-me' }))
  }, async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, false)
    assert.deepEqual(result.models, [])
    assert.doesNotMatch(result.message, /synthetic-anthropic-key|api\.anthropic\.com/)
  })
  assert.equal(fetchCalls, 2, 'the repeated cursor terminates the page sequence')
})

test('Anthropic model pagination is bounded by cumulative bytes and exposes only manual-entry guidance for 404', async () => {
  let pages = 0
  await withFetch(async () => {
    pages++
    const largePage = `${JSON.stringify({ data: [{ id: 'model' }], has_more: true, last_id: 'cursor-' + pages })}${' '.repeat(900_000)}`
    return new Response(largePage)
  }, async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, false)
    assert.deepEqual(result.models, [])
    assert.match(result.message, /大小超出限制/)
  })
  assert.equal(pages, 5, 'the cumulative byte ceiling stops later pages')

  const tooMany = { data: Array.from({ length: LLM_RESPONSE_LIMITS.modelCount + 1 }, (_, index) => ({ id: `model-${index}` })) }
  await withFetch(async () => new Response(JSON.stringify(tooMany)), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, false)
    assert.match(result.message, /大小超出限制/)
  })

  await withFetch(async () => new Response('UPSTREAM_SECRET synthetic-anthropic-key', { status: 404 }), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, false)
    assert.match(result.message, /可手动填写模型名/)
    assert.doesNotMatch(result.message, /UPSTREAM_SECRET|synthetic-anthropic-key/)
  })
})
