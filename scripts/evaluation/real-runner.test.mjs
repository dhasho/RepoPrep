import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { hashEvidenceBytes, installFetchObserver, parseRunnerArgs, runRealEvaluation, sanitizeGenerationDiagnostics, verifyRealCorpus } from './real-runner.mjs'
import { calculateReportDigest, makeReviewTemplate, validateReview } from './review.mjs'

const exec = promisify(execFile)

async function assertNoSymlinkTree(directory) {
  const dir = await opendir(directory)
  for await (const entry of dir) {
    const entryPath = path.join(directory, entry.name)
    const stat = await lstat(entryPath)
    if (stat.isSymbolicLink()) throw new Error('refusing to clean fixture containing a symbolic link')
    if (stat.isDirectory()) await assertNoSymlinkTree(entryPath)
  }
}

async function removeFixture(base) {
  const tempRoot = path.resolve(process.cwd(), '.tmp')
  const target = path.resolve(base)
  const relative = path.relative(tempRoot, target)
  if (!relative.startsWith('real-runner-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('refusing to clean a path outside the real-runner temporary fixture boundary')
  if (await realpath(tempRoot) !== tempRoot || await realpath(target) !== target) throw new Error('refusing to clean a temporary fixture through a reparse point')
  const rootStat = await lstat(target)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('refusing to clean a non-directory temporary fixture')
  await assertNoSymlinkTree(target)
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function fixture(t) {
  const tempRoot = path.join(process.cwd(), '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const base = await mkdtemp(path.join(tempRoot, 'real-runner-'))
  t.after(async () => removeFixture(base))
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

async function productionFixture(t) {
  const values = await fixture(t)
  const source = 'export const visibleBehavior = "SOURCE_SENTINEL_REAL_RUNNER"\n'
  await mkdir(path.join(values.directory, 'src'), { recursive: true })
  await writeFile(path.join(values.directory, 'src', 'app.ts'), source)
  await exec('git', ['add', '.'], { cwd: values.directory })
  await exec('git', ['commit', '-qm', 'add source'], { cwd: values.directory })
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: values.directory })).stdout.trim()
  const { createHash } = await import('node:crypto')
  const manifestPath = values.manifestPath
  const sourceHash = createHash('sha256').update(source).digest('hex')
  const readmeBytes = await readFile(path.join(values.directory, 'README.md'))
  const readmeHash = createHash('sha256').update(readmeBytes).digest('hex')
  const manifest = {
    schemaVersion: 'repoprep-real-corpus-v1', version: 'repoprep-real-corpus-v1', cases: [{
      id: 'case', repository: 'example/case', url: 'https://github.com/example/case', commit, directory: 'case', license: 'MIT', language: 'TypeScript', split: 'development', granularity: 'medium', roleFocus: 'general', readme: 'README.md', runtimeDependencies: { count: 0, notes: '' },
      evidenceFiles: [{ path: 'README.md', sha256: readmeHash }, { path: 'src/app.ts', sha256: sourceHash }],
      knownFacts: [{ id: 'visible', claim: 'A gold-only claim that must never be sent to the model: GOLD_ONLY_SENTINEL_REAL_RUNNER', keywords: ['GOLD_ONLY_SENTINEL_REAL_RUNNER'], evidence: [{ path: 'src/app.ts', startLine: 1, endLine: 1 }], interview: { question: 'What is shown?', referenceAnswer: 'The source shows a value.', followUps: [] }, pitfalls: [] }], forbiddenAssertions: []
    }]
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { ...values, manifestPath }
}

function syntheticCompletion() {
  const questions = Array.from({ length: 20 }, (_unused, index) => ({ question: `How does implementation choice ${index + 1} affect behavior?`, answer: `The supplied context supports implementation choice ${index + 1}.`, followUps: [] }))
  return JSON.stringify({ projectSummary: 'The project contains a small implementation.', sections: [{ title: 'Implementation', summary: 'Visible behavior.', questions }], glossary: {} })
}

function controlledModel(t, { failOnCall, omitUsage = false } = {}) {
  const originalFetch = globalThis.fetch
  const prompts = []
  let callCount = 0
  globalThis.fetch = async (_url, init) => {
    callCount++
    const request = JSON.parse(init.body)
    prompts.push(request.messages.map(message => message.content).join('\n'))
    if (callCount === failOnCall) throw new Error('UPSTREAM_RAW_SECRET_SENTINEL API_KEY_RAW_SECRET_SENTINEL')
    const body = { choices: [{ message: { content: syntheticCompletion() } }] }
    if (!omitUsage) body.usage = { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  return { prompts, get callCount() { return callCount } }
}

const testProfile = { id: 'secret-profile-id', name: 'Secret private profile', baseUrl: 'https://model.example.test/v1', apiKey: 'API_KEY_RAW_SECRET_SENTINEL', model: 'synthetic-model', protocol: 'openai' }

test('runner variants default to both and reject invalid or duplicate selections during argument parsing', () => {
  assert.deepEqual(parseRunnerArgs([]).variants, ['generation', 'baseline'])
  assert.deepEqual(parseRunnerArgs(['--variant', 'generation']).variants, ['generation'])
  assert.deepEqual(parseRunnerArgs(['--variant', 'baseline', '--variant', 'generation']).variants, ['baseline', 'generation'])
  assert.throws(() => parseRunnerArgs(['--variant', 'unknown']), /invalid evaluation variant/u)
  assert.throws(() => parseRunnerArgs(['--variant', 'generation', '--variant', 'generation']), /invalid evaluation variant/u)
})

test('sanitizes generation receipts to bounded numeric fields and static stages only', () => {
  const receipt = sanitizeGenerationDiagnostics({
    version: 1,
    status: 'failed',
    failedStage: 'model',
    contextStrategy: 'structure-v1',
    tokenEstimateMethod: 'mixed-text-v1',
    estimatedInputTokens: 20,
    inputTokenBudget: 100,
    reservedOutputTokens: 20,
    actualUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    usageComplete: true,
    requestCount: 2,
    repairRequestCount: 1,
    compensationRequestCount: 0,
    contextBuildMs: 3.2,
    modelMs: 4,
    totalMs: 8,
    selectedFiles: 2,
    selectedRegions: 3,
    omittedFiles: 1,
    apiKey: 'SENTINEL_SECRET',
    profileId: 'PRIVATE_PROFILE_ID',
    error: 'RAW_UPSTREAM_ERROR'
  })
  assert.equal(receipt.failedStage, 'model')
  assert.deepEqual(receipt.actualUsage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 })
  assert.equal(receipt.repairRequestCount, 1)
  assert.equal(receipt.compensationRequestCount, 0)
  assert.equal(receipt.contextBuildMs, 3.2)
  assert.equal(Object.hasOwn(receipt, 'apiKey'), false)
  assert.equal(JSON.stringify(receipt).includes('PRIVATE_PROFILE_ID'), false)
  assert.equal(JSON.stringify(receipt).includes('RAW_UPSTREAM_ERROR'), false)
  assert.equal(sanitizeGenerationDiagnostics({ status: 'succeeded', estimatedInputTokens: Number.POSITIVE_INFINITY }).estimatedInputTokens, null)
})

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

test('utf8-lf evidence hashes verify the same clean commit with CRLF checkout bytes', async t => {
  const values = await fixture(t)
  const lf = await readFile(path.join(values.directory, 'README.md'))
  const crlfDirectory = path.join(values.reposRoot, 'case-crlf')
  await exec('git', ['worktree', 'add', '--quiet', '--detach', crlfDirectory, 'HEAD'], { cwd: values.directory })
  try {
    await exec('git', ['config', 'core.autocrlf', 'true'], { cwd: crlfDirectory })
    await exec('git', ['checkout', 'HEAD', '--', 'README.md'], { cwd: crlfDirectory })
    const crlf = await readFile(path.join(crlfDirectory, 'README.md'))
    assert.match(crlf.toString('utf8'), /\r\n/u)
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: crlfDirectory })).stdout.trim(), '')
    assert.notEqual(hashEvidenceBytes(crlf, 'raw'), hashEvidenceBytes(lf, 'raw'))
    assert.equal(hashEvidenceBytes(crlf, 'utf8-lf'), hashEvidenceBytes(lf, 'utf8-lf'))
    const manifest = JSON.parse(await readFile(values.manifestPath, 'utf8'))
    manifest.evidenceHashMode = 'utf8-lf'
    manifest.cases[0].evidenceFiles[0].sha256 = hashEvidenceBytes(lf, 'utf8-lf')
    assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: crlfDirectory })).stdout.trim(), manifest.cases[0].commit)
    await writeFile(values.manifestPath, JSON.stringify(manifest))
    const lfVerification = await verifyRealCorpus(values)
    assert.equal(lfVerification.cases[0].commit, manifest.cases[0].commit)
    manifest.cases[0].directory = 'case-crlf'
    await writeFile(values.manifestPath, JSON.stringify(manifest))
    const result = await verifyRealCorpus(values)
    assert.equal(result.cases[0].commit, manifest.cases[0].commit)
  } finally {
    try { await exec('git', ['worktree', 'remove', crlfDirectory], { cwd: values.directory }) }
    finally { await exec('git', ['worktree', 'prune'], { cwd: values.directory }) }
  }
})

test('rejects unknown evidence hash modes', async t => {
  const values = await fixture(t)
  const manifest = JSON.parse(await readFile(values.manifestPath, 'utf8'))
  manifest.evidenceHashMode = 'utf16-lf'
  await writeFile(values.manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyRealCorpus(values), /unsupported evidence hash mode/u)
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

test('does not report out-of-range provider token counters as actual usage', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 2 }, choices: [] }), { status: 200 })
  const observer = installFetchObserver({ baseUrl: 'https://api.example.test', apiKey: 'private-key' }, 1, Date.now() + 5000)
  t.after(observer.restore)
  await globalThis.fetch('https://api.example.test/call', { method: 'POST', body: '{}' })
  assert.equal(observer.metrics.requests[0].usage, null)
  assert.equal(observer.metrics.usageAvailable, false)
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

test('runs production generation and README baseline while keeping gold outside both prompts', async t => {
  const values = await productionFixture(t)
  const model = controlledModel(t)
  const run = await runRealEvaluation({ ...values, outputDir: path.join(values.base, 'success-report'), profile: testProfile, caseIds: ['case'], maxRequests: 4 })
  assert.equal(run.status, 'complete')
  assert.equal(model.callCount, 2)
  assert.match(model.prompts[0], /SOURCE_SENTINEL_REAL_RUNNER/u)
  assert.doesNotMatch(model.prompts[1], /SOURCE_SENTINEL_REAL_RUNNER/u)
  assert.ok(model.prompts.every(prompt => !prompt.includes('GOLD_ONLY_SENTINEL_REAL_RUNNER')))
  assert.equal(run.cases[0].generation.scored.quota.actual, 20)
  assert.equal(run.cases[0].generation.diagnostics.status, 'succeeded')
  assert.equal(run.cases[0].generation.diagnostics.usageComplete, true)
  assert.deepEqual(run.cases[0].generation.diagnostics.actualUsage, { inputTokens: 30, outputTokens: 40, totalTokens: 70 })
  assert.equal(run.cases[0].baseline.scored.quota.actual, 20)
  assert.equal(run.cases[0].output.projectPath, '/public-corpus/case')
  assert.equal(run.cases[0].output.profileId, 'real-eval')
  assert.equal(run.config.temperature, 0.4)
  assert.equal(run.config.maxOutputTokensPolicy, 'provider-default')
  assert.match(run.sourceHashes['package.json'], /^[a-f0-9]{64}$/u)
  assert.equal(run.humanReview.status, 'pending')
  const reportPath = path.join(values.base, 'success-report', 'report.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const review = makeReviewTemplate(report)
  assert.equal(validateReview(review, report).status, 'pending')
  assert.doesNotMatch(JSON.stringify(report), /API_KEY_RAW_SECRET_SENTINEL|Secret private profile|UPSTREAM_RAW_SECRET_SENTINEL/u)
})

test('generation-only candidate records real synthetic usage absence and binds canonical output', async t => {
  const values = await productionFixture(t)
  const model = controlledModel(t, { omitUsage: true })
  const outputDir = path.join(values.base, 'generation-only-report')
  const run = await runRealEvaluation({
    ...values,
    outputDir,
    profile: { ...testProfile, contextWindowTokens: 40_000, maxOutputTokens: 4096 },
    caseIds: ['case'],
    variants: ['generation'],
    maxRequests: 4
  })
  assert.equal(run.status, 'complete')
  assert.equal(model.callCount, 1)
  assert.equal(run.config.variants.join(','), 'generation')
  assert.equal(run.config.contextWindowTokens, 40_000)
  assert.equal(run.config.profileMaxOutputTokens, 4096)
  assert.equal(run.config.maxOutputTokens, 4096)
  assert.equal(run.cases[0].baseline, undefined)
  assert.equal(run.cases[0].generation.status, 'complete')
  assert.equal(run.cases[0].generation.diagnostics.status, 'succeeded')
  assert.equal(run.cases[0].generation.diagnostics.usageComplete, false)
  assert.equal(run.cases[0].generation.diagnostics.actualUsage, null)
  assert.ok(Number.isFinite(run.cases[0].generation.diagnostics.estimatedInputTokens))
  assert.equal(run.cases[0].generation.diagnostics.inputTokenBudget, run.config.applicationInputTokenBudget)
  assert.equal(run.cases[0].generation.diagnostics.reservedOutputTokens, run.config.reservedOutputTokens)
  assert.equal(run.cases[0].generation.tokens, null)
  assert.equal(run.network.usage, null)
  assert.equal(run.cases[0].output.projectSummary, 'The project contains a small implementation.')
  assert.equal(run.cases[0].output.evaluationDiagnostics, run.cases[0].generation.diagnostics)
  assert.equal(run.reportDigest, calculateReportDigest(run))
  const changed = structuredClone(run)
  changed.cases[0].output.evaluationDiagnostics.estimatedInputTokens++
  assert.notEqual(calculateReportDigest(changed), run.reportDigest)
})

test('retains generation report as partial when baseline model call fails', async t => {
  const values = await productionFixture(t)
  const model = controlledModel(t, { failOnCall: 2 })
  const outputDir = path.join(values.base, 'partial-report')
  const run = await runRealEvaluation({ ...values, outputDir, profile: testProfile, caseIds: ['case'], maxRequests: 4 })
  assert.equal(model.callCount, 2)
  assert.equal(run.status, 'partial')
  assert.equal(run.cases[0].generation.scored.quota.actual, 20)
  assert.equal(run.cases[0].baseline.status, 'failed')
  assert.equal(run.cases[0].baseline.failureStage, 'model')
  assert.equal(run.cases[0].baseline.diagnostics.status, 'failed')
  assert.equal(run.cases[0].baseline.diagnostics.failedStage, 'model')
  assert.equal(run.failure.type, 'ModelRequestError')
  assert.equal(run.failure.reason, 'evaluation_failed')
  const report = JSON.parse(await readFile(path.join(outputDir, 'report.json'), 'utf8'))
  assert.equal(report.status, 'partial')
  assert.equal(report.cases[0].output.projectSummary, 'The project contains a small implementation.')
  assert.equal(report.humanReview.status, 'pending')
  assert.ok(await readFile(path.join(outputDir, 'report.md'), 'utf8'))
  assert.ok(await readFile(path.join(outputDir, 'review-template.json'), 'utf8'))
  assert.doesNotMatch(JSON.stringify(report), /API_KEY_RAW_SECRET_SENTINEL|UPSTREAM_RAW_SECRET_SENTINEL/u)
})

test('CLI accepts top-level help and missing credentials fail nonzero without echoing secrets', async t => {
  const help = await exec('node', ['--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', 'scripts/evaluation/real-runner.mjs', '--help'], { cwd: process.cwd() })
  assert.match(help.stdout, /verify .* run/u)
  const env = { ...process.env }
  delete env.REPOPREP_EVAL_API_KEY
  await assert.rejects(exec('node', ['--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', 'scripts/evaluation/real-runner.mjs', 'run', '--repos-root', 'unused', '--output', 'unused'], { cwd: process.cwd(), env }), error => {
    assert.notEqual(error.code, 0)
    assert.match(error.stderr, /REPOPREP_EVAL_API_KEY is required/u)
    assert.doesNotMatch(error.stderr, /API_KEY_RAW_SECRET_SENTINEL|UPSTREAM_RAW_SECRET_SENTINEL/u)
    return true
  })
})
