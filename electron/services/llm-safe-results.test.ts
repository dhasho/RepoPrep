// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { chatCompletion, listModels, testConnection } from './llm.ts'

const profile = { id: 'p1', name: 'Demo', baseUrl: 'https://private.example/api', apiKey: 'secret-key', model: 'private-model' }

async function withFetch(mockFetch: typeof fetch, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('connection success never echoes model generated text', async () => {
  const secret = 'MODEL_REPLY_SECRET https://private.example/api secret-key'
  await withFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: secret } }] })), async () => {
    const result = await testConnection(profile)
    assert.equal(result.ok, true)
    assert.equal(result.message, '连接成功，配置可用。')
    assert.doesNotMatch(result.message, /MODEL_REPLY_SECRET|private\.example|secret-key/)
  })
})

test('HTTP usage reports bounded numeric receipts and honors explicit output override precedence', async () => {
  let body: Record<string, unknown> | undefined
  const usage: unknown[] = []
  let requests = 0
  await withFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }))
  }, async () => {
    await chatCompletion({ ...profile, maxOutputTokens: 512 }, [{ role: 'user', content: 'hi' }], { maxOutputTokens: 16, onRequest: () => { requests++ }, onUsage: (receipt) => usage.push(receipt) })
  })
  assert.equal(requests, 1)
  assert.equal(body?.max_tokens, 16)
  assert.deepEqual(usage, [{ inputTokens: 7, outputTokens: 3, totalTokens: 10 }])
})

test('missing or invalid provider usage stays unknown', async () => {
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }]) {
    let calls = 0
    await withFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], ...(usage === undefined ? {} : { usage }) })), async () => {
      await chatCompletion(profile, [{ role: 'user', content: 'hello' }], { onUsage: () => { calls++ } })
    })
    assert.equal(calls, 0)
  }
})

test('model-list HTTP errors expose status and recovery guidance but not provider response data', async () => {
  const secret = 'UPSTREAM_SECRET https://private.example/path secret-key'
  await withFetch(async () => new Response(secret, { status: 401, statusText: 'Unauthorized' }), async () => {
    const result = await listModels(profile)
    assert.equal(result.ok, false)
    assert.match(result.message, /HTTP 401/)
    assert.match(result.message, /手动填写模型名/)
    assert.doesNotMatch(result.message, /UPSTREAM_SECRET|private\.example|secret-key|Unauthorized/)
  })
})

test('connection failures return actionable generic text without transport details', async () => {
  await withFetch(async () => { throw new Error('https://private.example secret-key /private/path') }, async () => {
    const result = await testConnection(profile)
    assert.equal(result.ok, false)
    assert.match(result.message, /连接测试失败，请检查网络、服务地址和配置后重试/)
    assert.doesNotMatch(result.message, /private\.example|secret-key|private\/path/)
  })
})

test('chat HTTP errors never reflect response body, endpoint, or API key', async () => {
  const secret = 'UPSTREAM_SECRET https://private.example/path secret-key'
  await withFetch(async () => new Response(secret, { status: 403 }), async () => {
    await assert.rejects(
      chatCompletion(profile, [{ role: 'user', content: 'hello' }]),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /HTTP 403/)
        assert.doesNotMatch(error.message, /UPSTREAM_SECRET|private\.example|secret-key/)
        return true
      }
    )
  })
})
