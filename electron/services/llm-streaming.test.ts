// These are sanitized snapshots derived from official docs/protocol behavior, not captures from real accounts.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { readFile } from 'node:fs/promises'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { chatCompletionStream, LlmRequestError } from './llm.ts'

const profile = {
  id: 'p1', name: 'Demo', baseUrl: 'https://private.example/api', apiKey: 'secret-key', model: 'private-model'
}
const messages = [{ role: 'user' as const, content: 'hello' }]
const encoder = new TextEncoder()
const fixtureRoot = new URL('../../tests/fixtures/llm-sse/', import.meta.url)

async function withFetch(mockFetch: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = mockFetch
  try { await run() } finally { globalThis.fetch = original }
}

function bytes(text: string): Uint8Array { return encoder.encode(text) }

function createResponse(chunks: Uint8Array[], close = true): {
  response: Response
  get cancelCalls(): number
} {
  let cancelCalls = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (close) controller.close()
    },
    cancel() { cancelCalls++ }
  })
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    get cancelCalls() { return cancelCalls }
  }
}

function openResponse(firstChunk: string): {
  response: Response
  enqueue: (text: string) => void
  close: () => void
  get cancelCalls(): number
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelCalls = 0
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      if (firstChunk) controller.enqueue(bytes(firstChunk))
    },
    cancel() { cancelCalls++ }
  })
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    enqueue: (text) => controller.enqueue(bytes(text)),
    close: () => controller.close(),
    get cancelCalls() { return cancelCalls }
  }
}

async function callWithChunks(
  chunks: Uint8Array[],
  onDelta?: (delta: string) => void
): Promise<{ result: string; response: Response }> {
  let response!: Response
  let result = ''
  await withFetch(async () => {
    response = createResponse(chunks).response
    return response
  }, async () => {
    result = await chatCompletionStream(profile, messages, onDelta ?? (() => {}))
    assert.equal(response.body?.locked, false, 'completed response reader must release its lock')
  })
  return { result, response }
}

function sseData(value: unknown, ending = '\r\n\r\n'): string {
  return `data: ${JSON.stringify(value)}${ending}`
}

function chatChunk(delta: Record<string, unknown>, finish: unknown = null, index?: number): Record<string, unknown> {
  const choice = { delta, finish_reason: finish, ...(index === undefined ? {} : { index }) }
  return { id: 'chatcmpl-snapshot', object: 'chat.completion.chunk', created: 1, model: 'snapshot-model', choices: [choice] }
}

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, fixtureRoot)))
}

test('official protocol snapshots complete only with DONE or stop; errors and interruptions reject', async () => {
  const expectedFixtures: Record<string, string> = {
    'openai-chat.sse': 'Hello世界',
    'compatible-multiline.sse': '你好，世界 ✨',
    'finish-stop-tail.sse': '尾部✨'
  }
  for (const [name, expected] of Object.entries(expectedFixtures)) {
    const encoded = await readFixture(name)
    const { result } = await callWithChunks([encoded])
    assert.equal(result, expected, name)
    for (let cut = 1; cut < encoded.length; cut++) {
      const splitResult = await callWithChunks([encoded.slice(0, cut), encoded.slice(cut)])
      assert.equal(splitResult.result, expected, `${name} split at byte ${cut}`)
    }
    const singleByte = await callWithChunks(Array.from(encoded, (byte) => Uint8Array.of(byte)))
    assert.equal(singleByte.result, expected, `${name} single-byte chunks`)
  }
  for (const name of ['error-event.sse', 'interrupted.sse']) {
    const { response } = await (async () => {
      let captured!: Response
      await withFetch(async () => {
        captured = createResponse([await readFixture(name)]).response
        return captured
      }, async () => {
        await assert.rejects(chatCompletionStream(profile, messages, () => {}), (error: unknown) => {
          assert.ok(error instanceof LlmRequestError)
          assert.equal(error.kind, 'response')
          assert.doesNotMatch(error.message, /private\.example|secret-key|UPSTREAM/)
          return true
        })
      })
      return { response: captured }
    })()
    assert.equal(response.body?.locked, false)
  }
})

test('all byte cut points, single-byte reads, and deterministic random chunks preserve UTF-8 text', async () => {
  const wire = '\uFEFF' +
    sseData({ ...chatChunk({ role: 'assistant', content: null, reasoning_content: 'not shown' }), system_fingerprint: 'fp' }) +
    sseData({ ...chatChunk({ content: '你好 ' }, null, 0), usage: { prompt_tokens: 1 } }) +
    sseData({ choices: [], usage: { completion_tokens: 3 }, id: 'usage-only', object: 'chat.completion.chunk' }) +
    sseData(chatChunk({ content: '🌍🙂' }, null, 0)) +
    sseData(chatChunk({}, 'stop', 0))
  const encoded = bytes(wire)
  const expected = '你好 🌍🙂'

  for (let cut = 1; cut < encoded.length; cut++) {
    const { result } = await callWithChunks([encoded.slice(0, cut), encoded.slice(cut)])
    assert.equal(result, expected, `split at byte ${cut}`)
  }
  const { result: singleByteResult } = await callWithChunks(Array.from(encoded, (byte) => Uint8Array.of(byte)))
  assert.equal(singleByteResult, expected)

  let seed = 0x51f15e
  const randomChunks: Uint8Array[] = []
  for (let offset = 0; offset < encoded.length;) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const length = Math.min(encoded.length - offset, 1 + (seed % 19))
    randomChunks.push(encoded.slice(offset, offset + length))
    offset += length
  }
  const { result: randomResult } = await callWithChunks(randomChunks)
  assert.equal(randomResult, expected)
})

test('compatibility events allow role/null/empty/reasoning/usage metadata and select only choice zero', async () => {
  const wire = [
    sseData({ choices: [{ delta: { role: 'assistant', content: null, reasoning: 'private reasoning' }, finish_reason: null }] }),
    sseData({ choices: [{ index: 1, delta: { content: 'wrong choice' }, finish_reason: null }] }),
    sseData({ choices: [{ delta: { content: '' }, finish_reason: null }] }),
    sseData({ choices: [], usage: { total_tokens: 2 }, vendor: { trace: 'kept in protocol' } }),
    sseData(chatChunk({ content: 'answer' }, null, 0)),
    sseData(chatChunk({}, 'stop', 0))
  ].join('')
  const deltas: string[] = []
  const { result } = await callWithChunks([bytes(wire)], (delta) => deltas.push(delta))
  assert.equal(result, 'answer')
  assert.deepEqual(deltas, ['answer'])
})

test('delta is delivered before the upstream stream closes', async () => {
  const response = openResponse(sseData(chatChunk({ content: 'early' }, null, 0)))
  let resolveDelta!: () => void
  const gotDelta = new Promise<void>((resolve) => { resolveDelta = resolve })
  const deltas: string[] = []
  const pending = withFetch(async () => response.response, async () => {
    const result = await chatCompletionStream(profile, messages, (delta) => {
      deltas.push(delta)
      resolveDelta()
    })
    assert.equal(result, 'early')
  })
  await gotDelta
  assert.deepEqual(deltas, ['early'])
  response.enqueue(sseData(chatChunk({}, 'stop', 0)))
  response.close()
  await pending
  assert.equal(response.response.body?.locked, false)
})

test('DONE returns promptly after visible text and cancels/releases a stream that never closes', async () => {
  const response = openResponse(sseData(chatChunk({ content: 'visible' }, null, 0)))
  let resolveDelta!: () => void
  const gotDelta = new Promise<void>((resolve) => { resolveDelta = resolve })
  const pending = withFetch(async () => response.response, async () => {
    assert.equal(await chatCompletionStream(profile, messages, resolveDelta), 'visible')
  })
  await gotDelta
  response.enqueue('data: [DONE]\r\n\r\n')
  await pending
  assert.equal(response.cancelCalls, 1)
  assert.equal(response.response.body?.locked, false)
})

test('stop continues through usage metadata and later errors, whether events share or split a read', async () => {
  const stop = sseData(chatChunk({ content: 'answer' }, 'stop', 0))
  const usage = sseData({ choices: [], usage: { completion_tokens: 1 } })
  const error = 'event: error\r\ndata: {"error":{"message":"private upstream detail"}}\r\n\r\n'
  for (const chunks of [[bytes(stop + usage + error)], [bytes(stop), bytes(usage), bytes(error)]]) {
    const { response } = createResponse(chunks)
    await withFetch(async () => response, async () => {
      await assert.rejects(chatCompletionStream(profile, messages, () => {}), (failure: unknown) => {
        assert.ok(failure instanceof LlmRequestError)
        assert.equal(failure.kind, 'response')
        assert.doesNotMatch(failure.message, /private upstream detail|secret-key/)
        return true
      })
    })
    assert.equal(response.body?.locked, false)
  }

  const valid = stop + usage + 'data: [DONE]\r\n\r\n'
  const { result } = await callWithChunks([bytes(valid)])
  assert.equal(result, 'answer')
})

test('empty and ping heartbeat events are ignored, but do not make a stream complete', async () => {
  const mixed = [
    'event: ping\r\n\r\n',
    'data:\r\n\r\n',
    sseData(chatChunk({ content: 'answer' }, null, 0)),
    sseData(chatChunk({}, 'stop', 0))
  ].join('')
  const { result } = await callWithChunks([bytes(mixed)])
  assert.equal(result, 'answer')

  for (const heartbeat of ['event: ping\r\n\r\n', 'data:\r\n\r\n']) {
    const { response } = createResponse([bytes(heartbeat)])
    await withFetch(async () => response, async () => {
      await assert.rejects(chatCompletionStream(profile, messages, () => {}), (error: unknown) => {
        assert.ok(error instanceof LlmRequestError)
        assert.equal(error.kind, 'response')
        return true
      })
    })
  }
})

test('malformed, empty, truncated, error, and unsupported finish events reject safely', async () => {
  const invalidStreams: Array<{ name: string; chunks: Uint8Array[] }> = [
    { name: 'malformed JSON', chunks: [bytes('data: {bad json}\n\n')] },
    { name: 'empty stream', chunks: [] },
    { name: 'DONE without text', chunks: [bytes('data: [DONE]\n\n')] },
    { name: 'stop without text', chunks: [bytes(sseData(chatChunk({}, 'stop', 0)))] },
    { name: 'role plus stop without text', chunks: [bytes(sseData(chatChunk({ role: 'assistant' }, 'stop', 0)))] },
    { name: 'whitespace-only text', chunks: [bytes(sseData(chatChunk({ content: '  \n ' }, null, 0)) + sseData(chatChunk({}, 'stop', 0)))] },
    { name: 'missing completion', chunks: [bytes(sseData(chatChunk({ content: 'partial' })))] },
    { name: 'root error', chunks: [bytes(sseData({ error: { message: 'UPSTREAM secret-key' } }))] },
    { name: 'error event with empty data', chunks: [bytes('event: error\n\n')] },
    { name: 'invalid content type', chunks: [bytes(sseData(chatChunk({ content: 42 })))] },
    { name: 'array content', chunks: [bytes(sseData(chatChunk({ content: [{ type: 'text', text: 'x' }] })))] },
    { name: 'length finish', chunks: [bytes(sseData(chatChunk({ content: 'partial' }, 'length', 0)))] },
    { name: 'content filter finish', chunks: [bytes(sseData(chatChunk({}, 'content_filter', 0)))] },
    { name: 'tool call finish', chunks: [bytes(sseData(chatChunk({}, 'tool_calls', 0)))] }
  ]
  for (const item of invalidStreams) {
    const { response } = createResponse(item.chunks)
    await withFetch(async () => response, async () => {
      await assert.rejects(chatCompletionStream(profile, messages, () => {}), (error: unknown) => {
        assert.ok(error instanceof LlmRequestError, item.name)
        assert.equal(error.kind, 'response', item.name)
        assert.doesNotMatch(error.message, /UPSTREAM|secret-key|private\.example/)
        return true
      })
    })
    assert.equal(response.body?.locked, false, item.name)
  }
})

test('invalid UTF-8, lone JSON surrogates, and oversized event/output buffers reject', async () => {
  const badUnicode = [bytes('data: {"choices":[{"index":0,"delta":{"content":"'), Uint8Array.of(0xff), bytes('"},"finish_reason":"stop"}]}\n\n')]
  const loneSurrogate = [bytes('data: {"choices":[{"index":0,"delta":{"content":"\\ud800"},"finish_reason":"stop"}]}\n\n')]
  const oversizedEvent = [bytes(`data: ${'x'.repeat(1_000_001)}`)]
  const outputChunks = [
    bytes(sseData(chatChunk({ content: 'a'.repeat(600_000) }, null, 0))),
    bytes(sseData(chatChunk({ content: 'b'.repeat(500_001) }, null, 0))),
    bytes(sseData(chatChunk({}, 'stop', 0)))
  ]
  for (const chunks of [badUnicode, loneSurrogate, oversizedEvent, outputChunks]) {
    const { response } = createResponse(chunks)
    await withFetch(async () => response, async () => {
      await assert.rejects(chatCompletionStream(profile, messages, () => {}), (error: unknown) => {
        assert.ok(error instanceof LlmRequestError)
        assert.equal(error.kind, 'response')
        return true
      })
    })
    assert.equal(response.body?.locked, false)
  }
})

test('onDelta exceptions reject and still cancel/release the reader', async () => {
  const response = openResponse(sseData(chatChunk({ content: 'delta' }, null, 0)))
  await withFetch(async () => response.response, async () => {
    await assert.rejects(chatCompletionStream(profile, messages, () => { throw new Error('consumer failure') }))
  })
  assert.equal(response.cancelCalls, 1)
  assert.equal(response.response.body?.locked, false)
})

test('external cancellation while streaming rejects as cancelled and leaves no locked reader', async () => {
  const response = openResponse(sseData(chatChunk({ content: 'before cancel' }, null, 0)))
  const caller = new AbortController()
  let resolveDelta!: () => void
  const gotDelta = new Promise<void>((resolve) => { resolveDelta = resolve })
  await withFetch(async (_input, init) => {
    assert.ok((init?.signal as AbortSignal).aborted === false)
    return response.response
  }, async () => {
    const pending = chatCompletionStream(profile, messages, resolveDelta, { signal: caller.signal })
    await gotDelta
    caller.abort()
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof LlmRequestError)
      assert.equal(error.kind, 'cancelled')
      return true
    })
  })
  assert.equal(response.cancelCalls, 1)
  assert.equal(response.response.body?.locked, false)
})
