import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { installFetchObserver, runRealEvaluation, verifyRealCorpus } from './real-runner.mjs'
import { calculateReportDigest, makeReviewTemplate, validateReview } from './review.mjs'

const exec = promisify(execFile)
const temporary = []

async function fixture(t) {
  const tempRoot = path.join(process.cwd(), '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const base = await mkdtemp(path.join(tempRoot, 'real-runner-'))
  temporary.push(base)
  t.after(async () => rm(base, { recursive: true, force: true }))
  const reposRoot = path.join(base, 'repos')
  const directory = path.join(reposRoot, 'case')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'README.md'), '# Example\nA small public project.\n')
  await exec('git', ['init', '-q'], { cwd: directory })
  await exec('git', ['config', 'user.name', 'Fixture'], { cwd: directory })
  await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: directory })
  await exec('git', ['add', '.'], { cwd: directory })
  await exec('git', ['commit', '-qm', 'fixture'], { cwd: directory })
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim()
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/case'], { cwd: directory })
  const bytes = await readFile(path.join(directory, 'README.md'))
  const { createHash } = await import('node:crypto')
  const manifestPath = path.join(base, 'corpus.json')
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 'repoprep-real-corpus-v1', version: 'repoprep-real-corpus-v1', cases: [{ id: 'case', repository: 'example/case', url: 'https://github.com/example/case', commit, directory: 'case', license: 'MIT', language: 'Markdown', split: 'development', granularity: 'medium', roleFocus: 'general', readme: 'README.md', runtimeDependencies: { count: 0, notes: '' }, evidenceFiles: [{ path: 'README.md', sha256: createHash('sha256').update(bytes).digest('hex') }], knownFacts: [{ id: 'readme', claim: 'small project', keywords: ['small'], evidence: [{ path: 'README.md', startLine: 2, endLine: 2 }], interview: { question: 'What?', referenceAnswer: 'A project.', followUps: [] }, pitfalls: [] }], forbiddenAssertions: [] }] }))
  return { base, reposRoot, directory, manifestPath }
}

test('verifies clean repository commit and fixed evidence hashes', async t => {
  const values = await fixture(t)
  const result = await verifyRealCorpus(values)
  assert.equal(result.cases[0].id, 'case')
})

test('rejects a changed evidence file even if the worktree has been recommitted', async t => {
  const values = await fixture(t)
  await writeFile(path.join(values.directory, 'README.md'), '# Changed\n')
  await exec('git', ['add', '.'], { cwd: values.directory })
  await exec('git', ['commit', '-qm', 'change'], { cwd: values.directory })
  await assert.rejects(verifyRealCorpus(values), /repository verification failed/u)
})

test('rejects evidence line ranges outside the pinned file', async t => {
  const values = await fixture(t)
  const manifest = JSON.parse(await readFile(values.manifestPath, 'utf8'))
  manifest.cases[0].knownFacts[0].evidence[0].endLine = 99
  await writeFile(values.manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyRealCorpus(values), /evidence line range missing/u)
})

test('rejects a tampered fixed evidence digest', async t => {
  const values = await fixture(t)
  const manifest = JSON.parse(await readFile(values.manifestPath, 'utf8'))
  manifest.cases[0].evidenceFiles[0].sha256 = '0'.repeat(64)
  await writeFile(values.manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyRealCorpus(values), /evidence hash mismatch/u)
})

test('rejects a remote from another host with the same repository suffix', async t => {
  const values = await fixture(t)
  await exec('git', ['remote', 'set-url', 'origin', 'https://evil.example/not-example/case'], { cwd: values.directory })
  await assert.rejects(verifyRealCorpus(values), /repository verification failed/u)
})

test('rejects empty corpora and facts with missing evidence', async t => {
  const values = await fixture(t)
  const manifest = JSON.parse(await readFile(values.manifestPath, 'utf8'))
  manifest.cases[0].knownFacts[0].evidence = []
  await writeFile(values.manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyRealCorpus(values), /known fact has no evidence/u)
  manifest.cases = []
  await writeFile(values.manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyRealCorpus(values), /empty real corpus/u)
})

test('rejects duplicate variants before any model call', async t => {
  const values = await fixture(t)
  await assert.rejects(runRealEvaluation({ ...values, outputDir: path.join(values.base, 'out'), profile: { baseUrl: 'https://api.example.test', apiKey: 'x', model: 'm' }, variants: ['generation', 'generation'] }), /invalid evaluation limits/u)
})

test('observes bounded request metadata and usage without retaining credentials or prompts', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 2 }, choices: [] }), { status: 200 })
  const observer = installFetchObserver({ baseUrl: 'https://api.example.test/v1', apiKey: 'private-key', model: 'm' }, 1, Date.now() + 5000)
  t.after(observer.restore)
  const response = await globalThis.fetch('https://api.example.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'private prompt' }] }) })
  assert.equal(response.status, 200)
  assert.equal(observer.metrics.requests[0].inputChars, 14)
  assert.deepEqual(observer.metrics.requests[0].usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 })
  assert.equal(JSON.stringify(observer.metrics).includes('private-key'), false)
  assert.equal(JSON.stringify(observer.metrics).includes('private prompt'), false)
  await assert.rejects(globalThis.fetch('https://other.example.test/v1', { method: 'POST' }), /network policy/u)
  assert.equal(observer.metrics.blockedRequests, 1)
  await assert.rejects(globalThis.fetch('https://api.example.test/v1/chat/completions', { method: 'POST' }), /request limit/u)
  observer.restore()
})

test('reports unavailable provider usage as null', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })
  const observer = installFetchObserver({ baseUrl: 'https://api.example.test', apiKey: 'private-key' }, 1, Date.now() + 5000)
  t.after(observer.restore)
  await globalThis.fetch('https://api.example.test/call', { method: 'POST', body: '{}' })
  assert.equal(observer.metrics.usageAvailable, false)
  observer.restore()
})

test('returns promptly when bounded usage reads an oversized streaming body', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) } }), { status: 200 })
  const observer = installFetchObserver({ baseUrl: 'https://api.example.test', apiKey: 'private-key' }, 1, Date.now() + 5000)
  t.after(observer.restore)
  const started = Date.now()
  await globalThis.fetch('https://api.example.test/call', { method: 'POST', body: '{}' })
  assert.ok(Date.now() - started < 1000)
  assert.equal(observer.metrics.usageAvailable, false)
  observer.restore()
})

test('human review digest binds the generation output field', () => {
  const report = { runId: 'r', corpusVersion: 'v', configHash: 'c', sourceHashes: {}, fixtureHashes: {}, cases: [{ id: 'case', output: { projectSummary: 'grounded' }, baseline: { output: { projectSummary: 'baseline' } } }], questions: [] }
  report.reportDigest = calculateReportDigest(report)
  const template = makeReviewTemplate(report)
  assert.equal(validateReview(template, report).status, 'reviewed')
  report.cases[0].output.projectSummary = 'tampered'
  assert.throws(() => validateReview(template, report), /digest/u)
})
