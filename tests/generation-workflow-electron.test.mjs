import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePrefix = 'repoprep-generation-workflow-'
const hardTimeoutMs = 150_000
const evidenceDirectory = path.join(root, '.validation', 'generation-workflow-electron')
const childScript = path.join(root, 'tests', 'fixtures', 'generation-workflow-electron', 'child.cjs')
const electronPath = require('electron')
const syntheticQuestionPrefix = 'SYNTHETIC_WORKFLOW_QUESTION_'

const sha256 = (content) => createHash('sha256').update(content).digest('hex')
async function hashPath(relativePath) {
  const content = await fs.readFile(path.join(root, relativePath))
  return sha256(content)
}

async function createProject(projectPath, marker) {
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: path.basename(projectPath), private: true }, null, 2))
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${path.basename(projectPath)}\n\n${marker} project fixture for native workflow verification.\n`)
  await fs.writeFile(path.join(projectPath, 'src', 'index.ts'), `export function ${marker.replace(/[^A-Za-z0-9]/g, '_')}() { return '${marker}' }\n`)
}

function syntheticResult() {
  return {
    projectSummary: 'Synthetic local response for the isolated Electron workflow.',
    sections: [{
      title: 'Synthetic workflow checks',
      summary: 'Returned only by the loopback fixture service.',
      questions: Array.from({ length: 20 }, (_, index) => ({
        question: `${syntheticQuestionPrefix}${String(index + 1).padStart(2, '0')}: how does request ${index + 1} behave?`,
        answer: `Synthetic answer ${index + 1} describes one distinct behavior from the local project fixture.`,
        followUps: []
      }))
    }],
    glossary: {}
  }
}

function jsonResponse(response, result) {
  response.writeHead(200, { 'content-type': 'application/json' })
  jsonBody(response, result)
}

function jsonBody(response, result) {
  response.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(result) } }],
    usage: { prompt_tokens: 37, completion_tokens: 19, total_tokens: 56 }
  }))
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

async function startSyntheticServer() {
  const state = { requests: [], completed: 0, aborted: [], held: new Map() }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/__workflow/state') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ requests: state.requests, completed: state.completed, aborted: state.aborted }))
      return
    }
    if (request.method === 'POST' && url.pathname.startsWith('/__workflow/release/')) {
      const index = Number(url.pathname.split('/').at(-1))
      const held = state.held.get(index)
      if (!held) {
        response.writeHead(409, { 'content-type': 'text/plain' })
        response.end('request-not-held')
        return
      }
      state.held.delete(index)
      jsonBody(held, syntheticResult())
      state.completed++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ released: index }))
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      response.writeHead(404)
      response.end()
      return
    }

    let body
    try {
      body = await readRequestBody(request)
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    const joinedPrompt = Array.isArray(body.messages)
      ? body.messages.map((message) => typeof message?.content === 'string' ? message.content : '').join('\n')
      : ''
    const index = state.requests.length + 1
    state.requests.push({
      index,
      model: typeof body.model === 'string' ? body.model : '',
      stream: body.stream === true,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      containsProjectA: joinedPrompt.includes('WORKFLOW_PROJECT_A_SOURCE_MARKER'),
      containsProjectB: joinedPrompt.includes('WORKFLOW_PROJECT_B_SOURCE_MARKER')
    })
    response.on('close', () => {
      if (!response.writableEnded) {
        state.aborted.push(index)
        state.held.delete(index)
      }
    })
    if (index === 1 || index === 3) {
      response.writeHead(200, body.stream === true
        ? { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
        : { 'content-type': 'application/json' })
      state.held.set(index, response)
      return
    }
    jsonResponse(response, syntheticResult())
    state.completed++
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    server,
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const response of state.held.values()) response.destroy()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

function assertSafeFixturePath(target) {
  const absolute = path.resolve(target)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, absolute)
  assert.ok(path.basename(absolute).startsWith(fixturePrefix), 'fixture path has the owned prefix')
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture path is inside OS temp')
  return absolute
}

async function cleanFixtureAfterChildExit(target) {
  const absolute = assertSafeFixturePath(target)
  const stat = await fs.lstat(absolute)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'fixture root is a plain test-owned directory')
  assert.equal(await fs.realpath(absolute), absolute, 'fixture root has no link redirection')
  await fs.rm(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  await assert.rejects(fs.lstat(absolute), (error) => error?.code === 'ENOENT')
}

async function run() {
  const startedAt = new Date().toISOString()
  if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('ELECTRON_RUN_AS_NODE is set; native Electron cannot run in Node mode')
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), fixturePrefix))
  assertSafeFixturePath(fixtureRoot)
  const projectA = path.join(fixtureRoot, 'workflow-project-a')
  const projectB = path.join(fixtureRoot, 'workflow-project-b')
  const exportPath = path.join(fixtureRoot, 'exported-workflow-a.md')
  await createProject(projectA, 'WORKFLOW_PROJECT_A_SOURCE_MARKER')
  await createProject(projectB, 'WORKFLOW_PROJECT_B_SOURCE_MARKER')
  const syntheticServer = await startSyntheticServer()
  let output = ''
  let exitCode = 1
  let childClosed = false
  let spawnError = null
  let timedOut = false
  const publicAssetPaths = await fs.readdir(path.join(root, 'out', 'renderer', 'assets'))
  const sourcePaths = ['electron/main.ts', 'electron/preload.ts', 'src/App.tsx', 'src/pages/ResultPage.tsx', 'electron/services/exporter.ts', 'electron/services/generator.ts', 'electron/services/context-builder.ts', 'electron/services/llm.ts', 'shared/types.ts', 'shared/token-budget.ts', 'shared/result-contract.ts', 'tests/generation-workflow-electron.test.mjs', 'tests/fixtures/generation-workflow-electron/child.cjs']
  const builtPaths = [
    'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html',
    ...publicAssetPaths.filter((file) => /\.(js|css)$/.test(file)).map((file) => path.join('out/renderer/assets', file))
  ]
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (file) => [file, await hashPath(file)])))
  const builtHashes = Object.fromEntries(await Promise.all(builtPaths.map(async (file) => [file.replaceAll('\\', '/'), await hashPath(file)])))
  const sourceBuiltBinding = sha256(JSON.stringify({ sourceHashes, builtHashes }))
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  env.REPOPREP_WORKFLOW_FIXTURE = fixtureRoot
  env.REPOPREP_WORKFLOW_PROJECT_A = projectA
  env.REPOPREP_WORKFLOW_PROJECT_B = projectB
  env.REPOPREP_WORKFLOW_EXPORT = exportPath
  env.REPOPREP_WORKFLOW_MODEL_URL = `${syntheticServer.baseUrl}/v1`
  env.REPOPREP_WORKFLOW_CONTROL_URL = syntheticServer.baseUrl
  await fs.mkdir(evidenceDirectory, { recursive: true })
  env.REPOPREP_WORKFLOW_SCREENSHOT = path.join(evidenceDirectory, 'scope-latest.png')
  const child = spawn(electronPath, [childScript], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text) })
  child.stderr.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text) })
  const closePromise = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; childClosed = true; resolve({ code: 1 }) })
    child.once('close', (code) => { childClosed = true; resolve({ code: typeof code === 'number' ? code : 1 }) })
  })
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, hardTimeoutMs)

  let fixtureCleaned = false
  let verdict = 'WORKFLOW-FAIL'
  let childEvidence = null
  let errorMessage = ''
  try {
    const close = await closePromise
    clearTimeout(timeout)
    exitCode = close.code
    if (spawnError) throw spawnError
    const evidenceLine = output.split(/\r?\n/).findLast((line) => line.startsWith('EVIDENCE '))
    if (evidenceLine) childEvidence = JSON.parse(evidenceLine.slice('EVIDENCE '.length))
    if (timedOut) throw new Error(`WORKFLOW-HARD-TIMEOUT after ${hardTimeoutMs}ms`)
    if (!output.includes('VERDICT WORKFLOW-OK') || output.includes('VERDICT WORKFLOW-FAIL')) throw new Error('Electron child did not emit a successful workflow verdict')
    if (exitCode !== 0) throw new Error(`Electron child exited with ${exitCode}`)
    if (!childEvidence || childEvidence.status !== 'passed') throw new Error('Electron child evidence was missing or not passed')
    verdict = 'WORKFLOW-OK'
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timeout)
    if (!childClosed) {
      child.kill()
      await closePromise
    }
    await syntheticServer.close()
    try {
      await cleanFixtureAfterChildExit(fixtureRoot)
      fixtureCleaned = true
    } catch (error) {
      verdict = 'WORKFLOW-FAIL'
      errorMessage = [errorMessage, `fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ')
    }
  }

  const report = {
    verdict,
    startedAt,
    deadlineMs: hardTimeoutMs,
    electronExitCode: exitCode,
    childClosedBeforeCleanup: childClosed,
    fixtureCleaned,
    sourceBuiltBinding,
    sourceHashes,
    builtHashes,
    syntheticServer: {
      requests: syntheticServer.state.requests,
      completed: syntheticServer.state.completed,
      aborted: syntheticServer.state.aborted
    },
    childEvidence,
    error: errorMessage || undefined,
    log: output
  }
  await fs.mkdir(evidenceDirectory, { recursive: true })
  const receiptName = startedAt.replaceAll(':', '-')
  await fs.writeFile(path.join(evidenceDirectory, `${receiptName}.json`), `${JSON.stringify(report, null, 2)}\n`)
  await fs.writeFile(path.join(evidenceDirectory, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  await fs.writeFile(path.join(evidenceDirectory, 'latest.log'), output || errorMessage || '(no child output)')
  if (verdict !== 'WORKFLOW-OK') {
    console.error(`[workflow-runner] ${errorMessage || 'native workflow failed'}`)
    console.error(`Evidence: ${path.join(evidenceDirectory, 'latest.json')}`)
    console.log('VERDICT WORKFLOW-FAIL')
    process.exitCode = 1
    return
  }
  console.log(`[workflow-runner] fixture cleaned after Electron exit; evidence ${path.join(evidenceDirectory, 'latest.json')}`)
  console.log('VERDICT WORKFLOW-OK')
}

run().catch((error) => {
  console.error(`[workflow-runner] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  console.log('VERDICT WORKFLOW-FAIL')
  process.exitCode = 1
})
