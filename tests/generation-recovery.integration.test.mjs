import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('fresh processes resume saved production batches and reuse completed output without another model request', { timeout: 60_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-resume-process-'))
  const project = path.join(directory, 'project')
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'README.md'), '# Synthetic project\nThree independent modules.\n')
  for (let index = 0; index < 3; index++) {
    await fs.mkdir(path.join(project, `module${index}`))
    await fs.writeFile(path.join(project, `module${index}`, 'index.ts'), `export function module${index}(value: number) { return value + ${index} }\n`)
  }
  let shouldFail = true
  const requests = []
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    const prompt = input.messages.map((item) => item.content).join('\n')
    requests.push(prompt)
    if (shouldFail && requests.length === 3) { response.writeHead(402); response.end('synthetic quota failure'); return }
    const quota = Number(prompt.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1] ?? 2)
    const label = prompt.match(/模块「([^」]+)」/)?.[1] ?? 'global'
    const questions = Array.from({ length: quota }, (_, index) => ({ question: `${label} implementation question ${index}?`, answer: `Explain the concrete ${label} implementation.`, followUps: [] }))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ projectSummary: 'Synthetic project', sections: [{ title: label, questions }], glossary: {} }) } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const worker = (phase) => execFileAsync(process.execPath, ['--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', 'tests/fixtures/generation-recovery-worker.mjs', phase, directory, baseUrl], { cwd: root, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 })
  try {
    assert.match((await worker('fail')).stdout, /FAILED_WITH_TWO_DURABLE_BATCHES/)
    assert.equal(requests.length, 3)
    const firstTwo = requests.slice(0, 2)
    shouldFail = false
    assert.match((await worker('resume')).stdout, /RESUMED_AND_COMPLETED/)
    assert.ok(requests.length > 3)
    for (const prior of firstTwo) assert.equal(requests.filter((prompt) => prompt === prior).length, 1, 'successful earlier requests are never resent after restart')
    const beforePublish = requests.length
    assert.match((await worker('publish')).stdout, /PUBLISHED_WITHOUT_GENERATION/)
    assert.equal(requests.length, beforePublish)
    const result = JSON.parse(await fs.readFile(path.join(directory, 'published.json'), 'utf8'))
    const questions = result.sections.flatMap((section) => section.questions.map((question) => question.question))
    assert.ok(questions.length >= 25 && questions.length <= 40)
    assert.equal(new Set(questions).size, questions.length)
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_API_KEY'))
    assert.deepEqual(await fs.readdir(path.join(directory, 'generation-drafts')), [], 'completed draft and backup were cleaned')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  }
})
