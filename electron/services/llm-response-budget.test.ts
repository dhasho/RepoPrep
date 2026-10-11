// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { chatCompletion, LLM_RESPONSE_LIMITS, listModels } from './llm.ts'

const profile = {
  id: 'p1', name: 'Demo', baseUrl: 'https://private.example/api', apiKey: 'fake-api-key', model: 'private-model'
}
const messages = [{ role: 'user' as const, content: 'hello' }]
const encoder = new TextEncoder()

type StreamStats = { pulls: number; cancelled: number }

async function withFetch(mockFetch: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = mockFetch
  try { await run() } finally { globalThis.fetch = original }
}

function chunkedBody(chunks: Uint8Array[], stats?: StreamStats): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats) stats.pulls++
      if (index === chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    },
    cancel() { if (stats) stats.cancelled++ }
  })
}

function endlessBody(chunk: Uint8Array, stats: StreamStats): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulls++
      controller.enqueue(chunk)
    },
    cancel() { stats.cancelled++ }
  })
}

function openAfterFirstChunkBody(chunk: Uint8Array, stats: StreamStats): ReadableStream<Uint8Array> {
  let releasePendingPull: (() => void) | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(chunk) },
    pull() {
      stats.pulls++
      return new Promise<void>((resolve) => { releasePendingPull = resolve })
    },
    cancel() {
      stats.cancelled++
      releasePendingPull?.()
    }
  })
}

function splitBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)))
  }
  return chunks
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function paddedJson(value: unknown, targetBytes: number): Uint8Array {
  const prefix = encoder.encode(JSON.stringify(value))
  assert.ok(prefix.length <= targetBytes)
  const result = new Uint8Array(targetBytes)
  result.set(prefix)
  result.fill(0x20, prefix.length)
  return result
}

function safeFailure(result: { ok: boolean; models: string[]; message: string }): void {
  assert.equal(result.ok, false)
  assert.deepEqual(result.models, [])
  assert.doesNotMatch(result.message, /fake-api-key|private\.example|secret-upstream/)
}

test('chat accepts an exact byte-cap body and rejects one byte over without trusting headers', async () => {
  const json = { choices: [{ message: { content: 'exact-cap' } }] }
  const cap = LLM_RESPONSE_LIMITS.chatBodyBytes
  for (const headers of [undefined, { 'content-length': '1' }, { 'content-length': String(cap + 1) }]) {
    const bytes = paddedJson(json, cap)
    await withFetch(async () => new Response(chunkedBody([bytes]), { headers }), async () => {
      assert.equal(await chatCompletion(profile, messages), 'exact-cap')
    })
  }

  const secretPayload = { choices: [{ message: { content: 'secret-upstream https://private.example/api fake-api-key' } }] }
  const secretPrefix = encoder.encode(JSON.stringify(secretPayload))
  const tooLarge = new Uint8Array(cap + 1)
  tooLarge.set(secretPrefix)
  tooLarge.fill(0x20, secretPrefix.length)
  for (const headers of [undefined, { 'content-length': '1' }]) {
    await withFetch(async () => new Response(chunkedBody([tooLarge]), { headers }), async () => {
      await assert.rejects(chatCompletion(profile, messages), (error: unknown) => {
        assert.match((error as Error).message, /大模型服务返回内容格式不正确/)
        assert.doesNotMatch((error as Error).message, /fake-api-key|private\.example|secret-upstream/)
        return true
      })
    })
  }
})

test('models accepts an exact byte-cap body and rejects one byte over safely', async () => {
  const json = { data: [{ id: 'exact-cap-model' }] }
  const cap = LLM_RESPONSE_LIMITS.modelsBodyBytes
  const exact = paddedJson(json, cap)
  await withFetch(async () => new Response(chunkedBody([exact]), { headers: { 'content-length': '1' } }), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['exact-cap-model'])
  })

  const secretPayload = { data: [{ id: 'small' }, { error: 'secret-upstream https://private.example/api fake-api-key' }] }
  const secretPrefix = encoder.encode(JSON.stringify(secretPayload))
  const over = new Uint8Array(cap + 1)
  over.set(secretPrefix)
  over.fill(0x20, secretPrefix.length)
  for (const headers of [undefined, { 'content-length': '1' }]) {
    await withFetch(async () => new Response(chunkedBody([over]), { headers }), async () => {
      safeFailure(await listModels(profile))
    })
  }
})

test('many small chunks are counted cumulatively and an endless producer is stopped at the chat budget', async () => {
  const cap = LLM_RESPONSE_LIMITS.chatBodyBytes
  const chunk = new Uint8Array(16 * 1024).fill(0x20)
  const stats: StreamStats = { pulls: 0, cancelled: 0 }
  const body = endlessBody(chunk, stats)
  await withFetch(async () => new Response(body), async () => {
    await assert.rejects(chatCompletion(profile, messages), /大模型服务返回内容格式不正确/)
  })
  assert.ok(stats.pulls <= Math.ceil(cap / chunk.length) + 2, `read ${stats.pulls} chunks before stopping`)
  assert.equal(stats.cancelled, 1)
  assert.equal(body.locked, false)

  const manyChunks = splitBytes(paddedJson({ choices: [{ message: { content: 'many-chunks' } }] }, 4096), 7)
  await withFetch(async () => new Response(chunkedBody(manyChunks)), async () => {
    assert.equal(await chatCompletion(profile, messages), 'many-chunks')
  })
})

test('an endless models producer is stopped at its separate byte budget', async () => {
  const cap = LLM_RESPONSE_LIMITS.modelsBodyBytes
  const chunk = new Uint8Array(8 * 1024).fill(0x20)
  const stats: StreamStats = { pulls: 0, cancelled: 0 }
  const body = endlessBody(chunk, stats)
  await withFetch(async () => new Response(body), async () => {
    safeFailure(await listModels(profile))
  })
  assert.ok(stats.pulls <= Math.ceil(cap / chunk.length) + 2, `read ${stats.pulls} chunks before stopping`)
  assert.equal(stats.cancelled, 1)
  assert.equal(body.locked, false)
})

test('fragmented UTF-8 is decoded only after bounded byte accounting, and malformed EOF is rejected', async () => {
  const valid = encoder.encode(JSON.stringify({ choices: [{ message: { content: 'split-漢字-😀' } }] }))
  const splitAt = valid.findIndex((byte, index) => byte >= 0xe0 && index > 0)
  assert.ok(splitAt > 0)
  const chunks = [valid.subarray(0, splitAt + 1), ...splitBytes(valid.subarray(splitAt + 1), 1)]
  await withFetch(async () => new Response(chunkedBody(chunks)), async () => {
    assert.equal(await chatCompletion(profile, messages), 'split-漢字-😀')
  })

  for (const bytes of [
    joinBytes(encoder.encode('{"choices":[{"message":{"content":"'), new Uint8Array([0xc3, 0x28]), encoder.encode('"}}]}')),
    joinBytes(encoder.encode('{"choices":[{"message":{"content":"'), new Uint8Array([0xe2, 0x82]))
  ]) {
    await withFetch(async () => new Response(chunkedBody(splitBytes(bytes, 1))), async () => {
      await assert.rejects(chatCompletion(profile, messages), /大模型服务返回内容格式不正确/)
    })
  }
})

test('model-list reader preserves split UTF-8 and rejects invalid or incomplete UTF-8 at EOF', async () => {
  const valid = encoder.encode(JSON.stringify({ data: [{ id: '模型-😀' }] }))
  await withFetch(async () => new Response(chunkedBody(splitBytes(valid, 1))), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['模型-😀'])
  })

  for (const bytes of [
    joinBytes(encoder.encode('{"data":[{"id":"'), new Uint8Array([0xc3, 0x28]), encoder.encode('"}]}')),
    joinBytes(encoder.encode('{"data":[{"id":"'), new Uint8Array([0xe2, 0x82]))
  ]) {
    await withFetch(async () => new Response(chunkedBody(splitBytes(bytes, 1))), async () => {
      safeFailure(await listModels(profile))
    })
  }
})

test('chat content enforces the character budget while accepting a valid surrogate pair at the boundary', async () => {
  const limit = LLM_RESPONSE_LIMITS.chatContentChars
  const exactContent = `${'a'.repeat(limit - 2)}😀`
  await withFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: exactContent } }] })), async () => {
    assert.equal((await chatCompletion(profile, messages)).length, limit)
  })

  const overContent = `${'a'.repeat(limit - 1)}😀`
  await withFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: overContent } }] })), async () => {
    await assert.rejects(chatCompletion(profile, messages), /大模型服务返回内容格式不正确/)
  })

  await withFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: '\ud800' } }] })), async () => {
    await assert.rejects(chatCompletion(profile, messages), /大模型服务返回内容格式不正确/)
  })
})

test('model list supports all wire shapes, deduplicates and sorts usable IDs', async () => {
  const cases: unknown[] = [
    { data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }] },
    { models: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }] },
    [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }]
  ]
  for (const payload of cases) {
    await withFetch(async () => new Response(JSON.stringify(payload)), async () => {
      const result = await listModels(profile)
      assert.equal(result.ok, true)
      assert.deepEqual(result.models, ['alpha', 'zeta'])
    })
  }
  await withFetch(async () => new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }] })), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['alpha', 'zeta'])
  })
})

test('models enforce raw count before deduplication and cap usable IDs and output count', async () => {
  const count = LLM_RESPONSE_LIMITS.modelCount
  const idsAtLimit = Array.from({ length: count }, (_, index) => ({ id: `model-${String(index).padStart(4, '0')}` }))
  await withFetch(async () => new Response(JSON.stringify({ data: idsAtLimit })), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, true)
    assert.equal(result.models.length, count)
  })

  const repeatedOverLimit = Array.from({ length: count + 1 }, () => ({ id: 'same-model' }))
  await withFetch(async () => new Response(JSON.stringify({ data: repeatedOverLimit })), async () => {
    safeFailure(await listModels(profile))
  })

  const idLimit = LLM_RESPONSE_LIMITS.modelIdChars
  for (const [id, accepted] of [[ 'm'.repeat(idLimit), true ], [ 'm'.repeat(idLimit + 1), false ]] as const) {
    await withFetch(async () => new Response(JSON.stringify({ models: [id] })), async () => {
      const result = await listModels(profile)
      assert.equal(result.ok, accepted)
      if (accepted) assert.deepEqual(result.models, [id])
      else safeFailure(result)
    })
  }
})

test('models reject responses with no usable IDs rather than claiming an empty success', async () => {
  const payload = { data: [{ id: '' }, { id: '   ' }, { id: 7 }, { id: 'bad\u0000id' }, { id: '\ud800' }] }
  await withFetch(async () => new Response(JSON.stringify(payload)), async () => {
    safeFailure(await listModels(profile))
  })
  await withFetch(async () => new Response(JSON.stringify({ data: [{ id: ' usable name ' }, { id: '   ' }, { id: 'bad\u0000id' }, { id: '\ud800' }] })), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, [' usable name '])
  })
})

test('oversize failures cancel readers, release locks, clear timers and remove caller abort listeners', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers: Array<{ callback: (...args: unknown[]) => void; delay: number; cleared: boolean }> = []
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0) => {
    const timer = { callback, delay, cleared: false }
    timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    const record = timer as unknown as { cleared: boolean }
    record.cleared = true
  }) as typeof clearTimeout

  const caller = new AbortController()
  let activeAbortListeners = 0
  const trackedSignal = {
    get aborted() { return caller.signal.aborted },
    addEventListener(...args: Parameters<AbortSignal['addEventListener']>) {
      if (args[0] === 'abort') activeAbortListeners++
      caller.signal.addEventListener(...args)
    },
    removeEventListener(...args: Parameters<AbortSignal['removeEventListener']>) {
      if (args[0] === 'abort') activeAbortListeners--
      caller.signal.removeEventListener(...args)
    }
  } as AbortSignal
  const stats: StreamStats = { pulls: 0, cancelled: 0 }
  const oversized = new Uint8Array(LLM_RESPONSE_LIMITS.chatBodyBytes + 1)
  oversized.fill(0x20)
  const body = openAfterFirstChunkBody(oversized, stats)
  const modelStats: StreamStats = { pulls: 0, cancelled: 0 }
  const modelBody = openAfterFirstChunkBody(
    new Uint8Array(LLM_RESPONSE_LIMITS.modelsBodyBytes + 1).fill(0x20),
    modelStats
  )
  try {
    await withFetch(async () => new Response(body), async () => {
      await assert.rejects(chatCompletion(profile, messages, { signal: trackedSignal }), /大模型服务返回内容格式不正确/)
    })

    await withFetch(async () => new Response(modelBody), async () => {
      safeFailure(await listModels(profile))
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
  assert.equal(stats.cancelled, 1)
  assert.equal(body.locked, false)
  assert.equal(activeAbortListeners, 0)
  assert.equal(timers.length, 2)
  assert.equal(timers[0].delay, 300_000)
  assert.equal(timers[0].cleared, true)
  assert.equal(modelStats.cancelled, 1)
  assert.equal(modelBody.locked, false)
  assert.equal(timers[1].delay, 20_000)
  assert.equal(timers[1].cleared, true)
})
