// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { chatCompletion, chatCompletionStream, isLlmTimeoutError, LlmRequestError, listModels, testConnection } from './llm.ts'

const profile = {
  id: 'p1', name: 'Demo', baseUrl: 'https://private.example/api', apiKey: 'secret-key', model: 'private-model'
}
const messages = [{ role: 'user' as const, content: 'hello' }]

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function withFetch(mockFetch: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = mockFetch
  try { await run() } finally { globalThis.fetch = original }
}

function jsonResponse(content = 'ok'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function assertKind(error: unknown, kind: LlmRequestError['kind']): void {
  assert.ok(error instanceof LlmRequestError)
  assert.equal(error.kind, kind)
}

type FakeTimer = { callback: () => void; delay: number; cleared: boolean }
async function withFakeTimers(run: (timers: FakeTimer[]) => Promise<void>): Promise<void> {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers: FakeTimer[] = []
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timer: FakeTimer = { callback: () => callback(...args), delay, cleared: false }
    timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((value: ReturnType<typeof setTimeout>) => {
    const timer = value as unknown as FakeTimer
    timer.cleared = true
  }) as typeof clearTimeout
  try { await run(timers) } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
}

function trackedSignal(controller: AbortController): { signal: AbortSignal; active: () => number; counts: () => [number, number] } {
  let listeners = 0
  let adds = 0
  let removes = 0
  const signal = {
    get aborted() { return controller.signal.aborted },
    addEventListener(...args: Parameters<AbortSignal['addEventListener']>) {
      if (args[0] === 'abort') { listeners++; adds++ }
      controller.signal.addEventListener(...args)
    },
    removeEventListener(...args: Parameters<AbortSignal['removeEventListener']>) {
      if (args[0] === 'abort') { listeners--; removes++ }
      controller.signal.removeEventListener(...args)
    }
  } as AbortSignal
  return { signal, active: () => listeners, counts: () => [adds, removes] }
}

test('success and HTTP failures release response readers and never expose provider bodies', async () => {
  let successResponse: Response | null = null
  await withFetch(async () => {
    successResponse = jsonResponse('answer')
    return successResponse
  }, async () => {
    assert.equal(await chatCompletion(profile, messages), 'answer')
    assert.equal(successResponse?.body?.locked, false)
  })

  let failedResponse: Response | null = null
  await withFetch(async () => {
    failedResponse = new Response('UPSTREAM_SECRET https://private.example secret-key', { status: 401 })
    return failedResponse
  }, async () => {
    await assert.rejects(chatCompletion(profile, messages), (error: unknown) => {
      assertKind(error, 'http')
      assert.doesNotMatch((error as Error).message, /UPSTREAM_SECRET|private\.example|secret-key/)
      assert.match((error as Error).message, /401/)
      return true
    })
    assert.equal(failedResponse?.body?.locked, false)
  })
})

test('unrelated AbortError is a network failure, while an already-aborted caller never fetches', async () => {
  await withFetch(async () => {
    const error = new Error('upstream AbortError')
    error.name = 'AbortError'
    throw error
  }, async () => {
    await assert.rejects(chatCompletion(profile, messages), (error: unknown) => {
      assertKind(error, 'network')
      assert.doesNotMatch((error as Error).message, /upstream/)
      return true
    })
  })

  const controller = new AbortController()
  controller.abort()
  let fetchCalls = 0
  await withFetch(async () => { fetchCalls++; return jsonResponse() }, async () => {
    await assert.rejects(chatCompletion(profile, messages, { signal: controller.signal }), (error: unknown) => {
      assertKind(error, 'cancelled')
      return true
    })
  })
  assert.equal(fetchCalls, 0)
})

test('more than twenty requests sharing one signal remove every external abort listener', async () => {
  const controller = new AbortController()
  const tracked = trackedSignal(controller)
  await withFetch(async () => jsonResponse('ok'), async () => {
    for (let i = 0; i < 25; i++) {
      assert.equal(await chatCompletion(profile, messages, { signal: tracked.signal }), 'ok')
      assert.equal(tracked.active(), 0)
    }
  })
  assert.deepEqual(tracked.counts(), [25, 25])
})

test('streaming delivers deltas incrementally and releases the response reader on completion', async () => {
  const encoder = new TextEncoder()
  let response: Response | null = null
  await withFetch(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":" second"},"finish_reason":null}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    return response
  }, async () => {
    const deltas: string[] = []
    assert.equal(await chatCompletionStream(profile, messages, (delta) => deltas.push(delta)), 'first second')
    assert.deepEqual(deltas, ['first', ' second'])
    assert.equal(response?.body?.locked, false)
  })
})

test('reader failures and body-read aborts cancel/release the reader without masking the request error', async () => {
  const failedBody = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private transport detail')) } })
  let failedResponse: Response | null = null
  await withFetch(async () => {
    failedResponse = new Response(failedBody)
    return failedResponse
  }, async () => {
    await assert.rejects(chatCompletion(profile, messages), (error: unknown) => {
      assertKind(error, 'network')
      assert.doesNotMatch((error as Error).message, /private transport detail/)
      return true
    })
    assert.equal(failedResponse?.body?.locked, false)
  })

  for (const streaming of [false, true]) {
    const caller = new AbortController()
    let cancelCalls = 0
    let response: Response | null = null
    let fetchSignal: AbortSignal | undefined
    await withFetch(async (_input, init) => {
      fetchSignal = init?.signal as AbortSignal
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[] }\n\n')) },
        cancel() { cancelCalls++ }
      })
      response = new Response(body)
      return response
    }, async () => {
      const pending = streaming
        ? chatCompletionStream(profile, messages, () => {}, { signal: caller.signal })
        : chatCompletion(profile, messages, { signal: caller.signal })
      await Promise.resolve()
      await Promise.resolve()
      caller.abort()
      await assert.rejects(pending, (error: unknown) => {
        assertKind(error, 'cancelled')
        return true
      })
      assert.equal(fetchSignal?.aborted, true)
      assert.equal(response?.body?.locked, false)
      assert.equal(cancelCalls, 1)
    })
  }
})

test('a completed request clears its timer and a stale callback cannot abort afterward', async () => {
  await withFakeTimers(async (timers) => {
    let requestSignal: AbortSignal | undefined
    await withFetch(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal
      return jsonResponse()
    }, async () => {
      assert.equal(await chatCompletion(profile, messages), 'ok')
    })
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 300_000)
    assert.equal(timers[0].cleared, true)
    timers[0].callback()
    assert.equal(requestSignal?.aborted, false)
  })
})

test('timeout and user cancellation race are first-wins even if fetch ignores abort and later succeeds', async () => {
  await withFakeTimers(async (timers) => {
    const caller = new AbortController()
    const pendingFetch = deferred<Response>()
    let requestSignal: AbortSignal | undefined
    await withFetch(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal
      return pendingFetch.promise
    }, async () => {
      const pending = chatCompletion(profile, messages, { signal: caller.signal, timeoutMs: 123 })
      assert.equal(timers[0].delay, 123)
      timers[0].callback()
      caller.abort()
      pendingFetch.resolve(jsonResponse('late success'))
      await assert.rejects(pending, (error: unknown) => {
        assertKind(error, 'timeout')
        assert.equal(isLlmTimeoutError(error), true)
        return true
      })
      assert.equal(requestSignal?.aborted, true)
      assert.equal(timers[0].cleared, true)
    })
  })

  await withFakeTimers(async (timers) => {
    const caller = new AbortController()
    const pendingFetch = deferred<Response>()
    await withFetch(async () => pendingFetch.promise, async () => {
      const pending = chatCompletion(profile, messages, { signal: caller.signal, timeoutMs: 123 })
      caller.abort()
      timers[0].callback()
      pendingFetch.resolve(jsonResponse('late success'))
      await assert.rejects(pending, (error: unknown) => {
        assertKind(error, 'cancelled')
        assert.equal(isLlmTimeoutError(error), false)
        return true
      })
      assert.equal(timers[0].cleared, true)
    })
  })
})

test('connection and model-list timeout results identify the stage and offer a retry', async () => {
  await withFakeTimers(async (timers) => {
    const late = deferred<Response>()
    await withFetch(async () => late.promise, async () => {
      const pending = testConnection(profile)
      assert.equal(timers[0].delay, 30_000)
      timers[0].callback()
      late.resolve(jsonResponse())
      const result = await pending
      assert.equal(result.ok, false)
      assert.match(result.message, /连接测试超时/)
      assert.match(result.message, /重试/)
      assert.doesNotMatch(result.message, /private\.example|secret-key/)
      assert.equal(timers[0].cleared, true)
    })
  })

  await withFakeTimers(async (timers) => {
    const late = deferred<Response>()
    await withFetch(async () => late.promise, async () => {
      const pending = listModels(profile)
      assert.equal(timers[0].delay, 20_000)
      timers[0].callback()
      late.resolve(new Response(JSON.stringify({ data: [{ id: 'late-model' }] })))
      const result = await pending
      assert.equal(result.ok, false)
      assert.match(result.message, /模型列表超时/)
      assert.match(result.message, /重试/)
      assert.equal(timers[0].cleared, true)
    })
  })
})
