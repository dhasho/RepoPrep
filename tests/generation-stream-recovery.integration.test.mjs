import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { GenerationDraftStore } from '../electron/services/generation-draft-store.ts'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sentinel = 'SYNTHETIC_PRIVATE_API_KEY'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function questionsIn(draft) {
  return draft.checkpoint?.pending?.batch?.sections?.flatMap((section) => section.questions) ?? []
}

function makeQuestion(index, overrides = {}) {
  const number = String(index).padStart(2, '0')
  return {
    title: `考察存储恢复第${number}题`,
    question: `存储恢复问题${number}：如何保证「原子性」与 {状态}？`,
    answer: `答案${number}包含中文、转义引号「他说：\\"继续\\"」和花括号 { value: ${index} }。需要说明数据何时持久化，以及失败时如何恢复。`,
    followUps: [{ question: `追问${number}：断电后怎么办？`, answer: `追问答案${number}说明先读已提交检查点，再继续剩余工作。`, followUps: [] }],
    ...overrides
  }
}

function modelJson(list, projectSummary = '合成项目说明，包含中文和花括号 {数据}。') {
  return JSON.stringify({
    projectSummary,
    sections: [{ title: '流式恢复', summary: '检查题目级检查点和进程恢复。', questions: list }],
    glossary: {}
  })
}

function sseFrame(content) {
  return Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`, 'utf8')
}

async function writeFrame(response, content, splitUtf8 = false) {
  const frame = sseFrame(content)
  if (splitUtf8) {
    // Split inside a multibyte character at the HTTP chunk boundary. The SSE
    // parser must join decoded text without corrupting Chinese characters.
    const offset = frame.findIndex((byte, index) => byte >= 0xe0 && index + 2 < frame.length)
    if (offset >= 0) {
      response.write(frame.subarray(0, offset + 1))
      await sleep(2)
      response.write(frame.subarray(offset + 1))
      await sleep(2)
      return
    }
  }
  response.write(frame)
  await sleep(2)
}

async function writeContent(response, text) {
  // Model deltas may split JSON escapes and object syntax at any point.
  const characters = Array.from(text)
  const chunks = []
  for (let index = 0; index < characters.length; index += 23) chunks.push(characters.slice(index, index + 23).join(''))
  for (let index = 0; index < chunks.length; index++) {
    await writeFrame(response, chunks[index], index === 0)
  }
}

async function waitForPersistedPrefix(store, projectPath, progressPath) {
  const until = Date.now() + 12_000
  while (Date.now() < until) {
    const draft = store.read(projectPath)
    let progress = null
    try { progress = JSON.parse(await fs.readFile(progressPath, 'utf8')) } catch { /* worker has not reported yet */ }
    if (draft?.summary.completedQuestions >= 3 && questionsIn(draft).length === 3 && progress?.savedQuestions >= 3) return draft
    await sleep(25)
  }
  const draft = store.read(projectPath)
  assert.fail(`Timed out waiting for three durable streamed questions (summary=${draft?.summary.completedQuestions ?? 'missing'}, pending=${questionsIn(draft).length})`)
}

function questionObjects(result) {
  return result.sections.flatMap((section) => section.questions)
}

function safeCleanupTarget(directory) {
  const base = path.resolve(os.tmpdir())
  const target = path.resolve(directory)
  const relative = path.relative(base, target)
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'cleanup target must stay below os.tmpdir()')
  assert.match(path.basename(target), /^repoprep-stream-recovery-/)
  return target
}

test('a fresh process resumes a durable question prefix after a real SSE disconnect', { timeout: 60_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-stream-recovery-'))
  const cleanupTarget = safeCleanupTarget(directory)
  const projectPath = path.join(directory, 'project')
  const progressPath = path.join(directory, 'progress.json')
  await fs.mkdir(projectPath)
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Synthetic stream fixture\nA small project for a single medium-granularity request.\n')
  await fs.writeFile(path.join(projectPath, 'index.ts'), 'export function resume(value: string) { return { value, ready: true } }\n')

  const store = new GenerationDraftStore(directory)
  let releaseInitialPrefix
  let initialPrefixReady
  const prefixGate = new Promise((resolve) => { releaseInitialPrefix = resolve })
  let resolveInitialPrefixReady
  // Keep the resolver separate from the promise declaration for compatibility
  // with older Node releases used by local test runners.
  initialPrefixReady = new Promise((resolve) => { resolveInitialPrefixReady = resolve })
  const requests = []
  const serverErrors = []
  const server = http.createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      const prompt = payload.messages.map((message) => message.content).join('\n')
      requests.push({ payload, prompt, headers: request.headers })
      if (request.headers['last-event-id'] !== undefined) serverErrors.push('unexpected Last-Event-ID header')
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.flushHeaders()

      if (requests.length === 1) {
        assert.equal(payload.stream, true, 'initial generation must request streaming')
        const prefix = '{"projectSummary":"合成项目说明 {数据}","sections":[{"title":"流式恢复","summary":"检查题目级检查点。","questions":['
        await writeContent(response, prefix)
        for (let index = 1; index <= 3; index++) {
          if (index > 1) await writeContent(response, ',')
          await writeContent(response, JSON.stringify(makeQuestion(index)))
        }
        resolveInitialPrefixReady()
        await prefixGate
        // This object is deliberately incomplete and must never enter a checkpoint.
        await writeContent(response, ',{"question":"半截题不能保存","answer":"尚未结束 { value: "')
        response.destroy()
        return
      }

      assert.equal(payload.stream, true, 'resume generation must request streaming')
      const quotaMatch = prompt.match(/(?:严格|约)\s*(\d+)\s*题/)
      assert.ok(quotaMatch, 'resume prompt must state the remaining quota')
      assert.equal(Number(quotaMatch[1]), 17)
      for (const prior of [1, 2, 3].map(makeQuestion)) {
        assert.ok(prompt.includes(prior.question), 'resume prompt must include each saved question stem to prevent repeats')
      }
      const resumedQuestions = [makeQuestion(1, { title: '与旧题重复的改写标题', answer: '重复题的替代答案不应覆盖已保存答案。' }), ...Array.from({ length: 17 }, (_, index) => makeQuestion(index + 4))]
      const responseBody = modelJson(resumedQuestions, '合成项目续传说明。')
      await writeContent(response, responseBody)
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : 'mock server failure')
      if (!response.destroyed) { response.writeHead(500); response.end() }
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const worker = (phase) => execFileAsync(process.execPath, [
    '--experimental-strip-types', '--import', './tests/register-shared-alias.mjs',
    'tests/fixtures/generation-stream-recovery-worker.mjs', phase, directory, baseUrl, progressPath
  ], { cwd: root, windowsHide: true, timeout: 25_000, maxBuffer: 64 * 1024 })

  try {
    const failingWorker = worker('fail').then((value) => ({ value }), (error) => ({ error }))
    await Promise.race([initialPrefixReady, sleep(10_000).then(() => assert.fail('mock server did not begin the streamed response'))])
    const savedDraft = await waitForPersistedPrefix(store, projectPath, progressPath)
    const savedQuestions = questionsIn(savedDraft)
    assert.equal(savedDraft.checkpoint.entries.length, 0, 'partial request is not a completed batch')
    assert.equal(savedDraft.summary.completedQuestions, 3)
    assert.equal(savedQuestions.length, 3)
    assert.ok(savedDraft.checkpoint.pending, 'partial request should have a pending checkpoint')
    releaseInitialPrefix()

    const firstOutcome = await failingWorker
    if (firstOutcome.error) throw firstOutcome.error
    const firstRun = firstOutcome.value
    assert.match(firstRun.stdout, /FAILED_WITH_THREE_DURABLE_QUESTIONS/)
    assert.ok(!firstRun.stdout.includes(sentinel) && !firstRun.stderr.includes(sentinel), 'credentials must not appear in worker output')
    const failedDraft = store.read(projectPath)
    assert.ok(failedDraft)
    assert.equal(failedDraft.summary.completedQuestions, 3)
    assert.equal(failedDraft.checkpoint.entries.length, 0)
    assert.equal(questionsIn(failedDraft).length, 3, 'the incomplete fourth question must be discarded')
    assert.equal(failedDraft.result, undefined, 'failed generation must not publish a result')
    assert.ok(!JSON.stringify(failedDraft).includes(sentinel), 'credentials must not enter the private journal')

    const resumeRun = await worker('resume')
    assert.match(resumeRun.stdout, /RESUMED_AND_COMPLETED/)
    assert.ok(!resumeRun.stdout.includes(sentinel) && !resumeRun.stderr.includes(sentinel), 'credentials must not appear in worker output')
    assert.equal(requests.length, 2, 'resume uses one new model call and does not retry the failed request')
    assert.equal(requests[0].payload.stream, true)
    assert.equal(requests[1].payload.stream, true)
    assert.equal(requests[1].headers['last-event-id'], undefined)
    assert.deepEqual(serverErrors, [])

    const completedDraft = store.read(projectPath)
    assert.ok(completedDraft?.summary.ready && completedDraft.result)
    const finalQuestions = questionObjects(completedDraft.result)
    assert.equal(finalQuestions.length, 20)
    assert.equal(new Set(finalQuestions.map((question) => question.question)).size, 20)
    for (const original of savedQuestions) {
      const restored = finalQuestions.find((question) => question.id === original.id)
      assert.ok(restored, 'saved question id must survive recovery')
      assert.deepEqual(restored, original, 'saved question title, text, answer, and follow-ups remain byte-for-byte equivalent')
    }
    assert.ok(finalQuestions.every((question) => question.question !== '半截题不能保存'))
    assert.ok(!JSON.stringify(completedDraft).includes(sentinel))

    const beforePublish = requests.length
    const publishRun = await worker('publish')
    assert.match(publishRun.stdout, /PUBLISHED_WITHOUT_GENERATION/)
    assert.equal(requests.length, beforePublish, 'a ready draft is reused without a model request')
    const published = JSON.parse(await fs.readFile(path.join(directory, 'published.json'), 'utf8'))
    assert.equal(questionObjects(published).length, 20)
    assert.ok(!JSON.stringify(published).includes(sentinel))
    assert.equal(store.read(projectPath), null, 'publish removes the completed private draft')
  } finally {
    releaseInitialPrefix()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    const info = await fs.lstat(cleanupTarget)
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'only the test-owned temp directory may be removed')
    await fs.rm(cleanupTarget, { recursive: true, force: true })
  }
})
