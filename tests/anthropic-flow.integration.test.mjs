// The real generator and streaming LLM client against a local synthetic Messages responder.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { generateInterview, buildExplainMessages } from '../electron/services/generator.ts'
import { chatCompletionStream } from '../electron/services/llm.ts'
import { scanProject } from '../electron/services/scanner.ts'
import { GRANULARITY_QUESTION_BUDGET } from '../shared/types.ts'

function sse(event, value) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
}

test('production generation and explanation clients use Anthropic Messages over a real local HTTP connection', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-anthropic-flow-'))
  const allowedRoot = path.resolve(os.tmpdir())
  const resolvedFixture = path.resolve(fixtureRoot)
  assert.ok(resolvedFixture.startsWith(`${allowedRoot}${path.sep}`), 'fixture must stay below the operating-system temp directory')
  assert.ok(path.basename(resolvedFixture).startsWith('repoprep-anthropic-flow-'))

  const sourceFile = path.join(fixtureRoot, 'src', 'index.ts')
  const serverErrors = []
  const requests = []
  const server = http.createServer(async (request, response) => {
    let stage = 'request-received'
    try {
      stage = 'loopback-peer'
      assert.equal(request.socket.remoteAddress, '127.0.0.1')
      stage = 'request-route'
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/messages')
      stage = 'request-headers'
      assert.equal(request.headers['x-api-key'], 'synthetic-anthropic-key')
      assert.equal(request.headers['anthropic-version'], '2023-06-01')
      assert.equal(request.headers.authorization, undefined)
      assert.match(request.headers['content-type'] ?? '', /^application\/json\b/i)

      stage = 'request-body'
      const bodyChunks = []
      let bodyBytes = 0
      for await (const chunk of request) {
        bodyBytes += chunk.length
        assert.ok(bodyBytes <= 2 * 1024 * 1024, 'synthetic request body remains bounded')
        bodyChunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'))
      assert.equal(body.model, 'claude-synthetic')
      assert.equal(body.temperature, undefined)
      assert.equal(body.max_tokens, 16_384)
      requests.push({ url: request.url, body })

      stage = body.stream ? 'stream-response' : 'message-response'
      response.setHeader('connection', 'close')
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (body.system?.includes('资深技术面试官')) {
          const userMessage = body.messages.find((message) => message.role === 'user')?.content ?? ''
          const quota = Number(userMessage.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1] ?? 20)
          const content = JSON.stringify({
            projectSummary: 'Synthetic project for the Anthropic integration flow.',
            sections: [{ title: 'Synthetic section', questions: Array.from({ length: quota }, (_, index) => ({
              title: `实现机制 ${index + 1}`, question: `Anthropic question ${index + 1}`, answer: `Synthetic answer ${index + 1}`, followUps: []
            })) }], glossary: {}
          })
          response.write(sse('message_start', { type: 'message_start', message: { type: 'message', usage: { input_tokens: 30, output_tokens: 0 } } }))
          response.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
          for (let offset = 0; offset < content.length; offset += 41) {
            response.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.slice(offset, offset + 41) } }))
          }
          response.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
          response.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } }))
          response.end(sse('message_stop', { type: 'message_stop' }))
          return
        }
        const wire = [
          sse('message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [] } }),
          sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Claude explanation' } }),
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning omitted' } }),
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' streamed' } }),
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
          sse('message_stop', { type: 'message_stop' })
        ]
        for (const chunk of wire) response.write(chunk)
        response.end()
        return
      }

      const userMessage = body.messages.find((message) => message.role === 'user')?.content ?? ''
      const quota = Number(userMessage.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1] ?? 20)
      const generated = {
        projectSummary: 'Synthetic project for the Anthropic integration flow.',
        sections: [{
          title: 'Synthetic section',
          questions: Array.from({ length: quota }, (_, index) => ({
            question: `Anthropic question ${index + 1}`,
            answer: `Synthetic answer ${index + 1}`,
            followUps: []
          }))
        }],
        glossary: {}
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'private reasoning omitted' }, { type: 'text', text: JSON.stringify(generated) }],
        stop_reason: 'end_turn'
      }))
    } catch (error) {
      serverErrors.push(stage)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('synthetic local responder failed')
    }
  })

  let serverListening = false
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    serverListening = true
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const profile = {
      id: 'synthetic-anthropic-profile',
      name: 'Synthetic Claude',
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'synthetic-anthropic-key',
      model: 'claude-synthetic',
      protocol: 'anthropic'
    }

    await fs.mkdir(path.dirname(sourceFile), { recursive: true })
    await fs.writeFile(path.join(fixtureRoot, 'README.md'), '# Synthetic Anthropic flow\n')
    await fs.writeFile(sourceFile, 'export const client = "synthetic"\n')
    const scan = await scanProject(fixtureRoot)

    let result
    try {
      result = await generateInterview({
        scan,
        granularity: 'medium',
        roleFocus: 'backend',
        profile,
        signal: new AbortController().signal,
        onProgress: () => undefined
      })
    } catch (error) {
      assert.deepEqual(serverErrors, [], `local responder stages: ${serverErrors.join(',') || 'no request received'}`)
      throw error
    }
    const questions = result.sections.flatMap((section) => section.questions)
    const budget = GRANULARITY_QUESTION_BUDGET.medium
    assert.ok(questions.length >= budget.min && questions.length <= budget.max)
    assert.equal(result.profileId, profile.id)
    assert.ok(!JSON.stringify(result).includes(profile.apiKey), 'synthetic API key never enters the generated result')
    assert.ok(requests.length > 0 && requests.every((request) => request.body.stream === true))
    assert.deepEqual(result.generationDiagnostics.actualUsage, { inputTokens: 30, outputTokens: 500, totalTokens: 530 }, 'streamed cumulative usage is recorded once')
    assert.ok(requests.every((request) => typeof request.body.system === 'string'))
    assert.ok(requests.every((request) => request.body.max_tokens === 16_384), 'production generation gets enough default output tokens for its full structured batch')

    const streamedDeltas = []
    const explanation = await chatCompletionStream(
      profile,
      buildExplainMessages({
        term: 'Anthropic',
        projectSummary: result.projectSummary,
        question: questions[0].question,
        snippet: questions[0].answer
      }),
      (delta) => streamedDeltas.push(delta)
    )
    assert.equal(explanation, 'Claude explanation streamed')
    assert.deepEqual(streamedDeltas, ['Claude explanation', ' streamed'])
    assert.equal(requests.at(-1).body.stream, true)
    assert.equal(requests.at(-1).body.max_tokens, 16_384, 'streaming explanations also carry the required output-token budget')
    assert.ok(!explanation.includes('private reasoning'))
    assert.deepEqual(serverErrors, [], 'the local HTTP responder accepted every production request')
  } finally {
    if (serverListening) {
      server.closeAllConnections?.()
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
    assert.ok(resolvedFixture.startsWith(`${allowedRoot}${path.sep}`), 'cleanup path remains under the temp directory')
    assert.ok(path.basename(resolvedFixture).startsWith('repoprep-anthropic-flow-'), 'cleanup prefix must match this integration fixture')
    const fixtureStat = await fs.lstat(resolvedFixture)
    assert.ok(fixtureStat.isDirectory() && !fixtureStat.isSymbolicLink(), 'cleanup target is the isolated fixture directory')
    await fs.rm(resolvedFixture, { recursive: true, force: true })
  }
})
