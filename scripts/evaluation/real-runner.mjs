import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scanProject } from '../../electron/services/scanner.ts'
import { generateInterview } from '../../electron/services/generator.ts'
import { GRANULARITY_QUESTION_BUDGET } from '../../shared/types.ts'
import { DEFAULT_OUTPUT_RESERVE, DEEPSEEK_THINKING_RESERVE, INPUT_TOKEN_TARGETS, resolveGenerationBudget, TOKEN_ESTIMATE_METHOD } from '../../shared/token-budget.ts'
import { scoreCase, flattenQuestions, fingerprintQuestion } from './scorer.mjs'
import { makeReviewTemplate, calculateReportDigest } from './review.mjs'
import variantArguments from './variant-arguments.cjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const execFileAsync = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const { DEFAULT_VARIANTS, appendVariant, resolveVariants } = variantArguments
const ALLOWED_VARIANTS = new Set(DEFAULT_VARIANTS)
const MAX_USAGE_BYTES = 1024 * 1024
const MAX_USAGE_TOKENS = 10_000_000
const MAX_DIAGNOSTIC_VALUE = 1_000_000_000

export function parseRunnerArgs(args) {
  const options = { caseIds: [], variants: [], variantSpecified: false, help: false }
  const repeatable = new Set(['--case'])
  const accepted = new Set(['--repos-root', '--output', '--manifest', '--case', '--max-requests', '--variant'])
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--help') { options.help = true; continue }
    if (!accepted.has(key)) throw new Error('unknown evaluation argument')
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error('missing evaluation argument value')
    if (key === '--variant') {
      options.variantSpecified = true
      appendVariant(options.variants, value, 'invalid evaluation variant')
      options.variants.push(value)
    } else if (repeatable.has(key)) {
      options.caseIds.push(value)
    } else {
      if (Object.hasOwn(options, key)) throw new Error('duplicate evaluation argument')
      options[key] = value
    }
  }
  options.variants = resolveVariants(options.variants, 'invalid evaluation variant')
  return options
}

export function hashEvidenceBytes(bytes, mode) {
  if (mode === undefined || mode === 'raw') return hash(bytes)
  if (mode !== 'utf8-lf') throw new Error('unsupported evidence hash mode')
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return hash(decoded.replace(/\r\n/gu, '\n'))
}

function safeErrorType(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'RequestTimeout'
  if (error?.name === 'TypeError') return 'NetworkError'
  if (error?.name === 'Error' || error?.name === 'LlmRequestError') return 'ModelRequestError'
  return 'UnknownError'
}

const DIAGNOSTIC_STAGES = new Set(['context', 'model', 'merge', 'validation'])
const TOKEN_LIMIT = 2_097_152

function safeTokenSetting(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= TOKEN_LIMIT ? value : undefined
}

function safeDiagnosticNumber(value, integer = true) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_DIAGNOSTIC_VALUE) return null
  return integer ? Math.floor(value) : Math.round(value * 10) / 10
}

export function sanitizeGenerationDiagnostics(value) {
  if (!value || typeof value !== 'object') return null
  const status = ['succeeded', 'failed', 'cancelled'].includes(value.status) ? value.status : null
  if (!status) return null
  const usage = value.usageComplete === true && value.actualUsage &&
    ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(value.actualUsage[key]) && value.actualUsage[key] >= 0 && value.actualUsage[key] <= MAX_DIAGNOSTIC_VALUE)
    ? {
      inputTokens: value.actualUsage.inputTokens,
      outputTokens: value.actualUsage.outputTokens,
      totalTokens: value.actualUsage.totalTokens
    }
    : null
  return {
    version: 1,
    status,
    ...(DIAGNOSTIC_STAGES.has(value.failedStage) ? { failedStage: value.failedStage } : {}),
    contextStrategy: value.contextStrategy === 'structure-v1' ? value.contextStrategy : 'unknown',
    tokenEstimateMethod: value.tokenEstimateMethod === 'mixed-text-v1' ? value.tokenEstimateMethod : 'unknown',
    estimatedInputTokens: safeDiagnosticNumber(value.estimatedInputTokens),
    inputTokenBudget: safeDiagnosticNumber(value.inputTokenBudget),
    reservedOutputTokens: safeDiagnosticNumber(value.reservedOutputTokens),
    actualUsage: usage,
    usageComplete: usage !== null,
    requestCount: safeDiagnosticNumber(value.requestCount) ?? 0,
    repairRequestCount: safeDiagnosticNumber(value.repairRequestCount) ?? 0,
    compensationRequestCount: safeDiagnosticNumber(value.compensationRequestCount) ?? 0,
    contextBuildMs: safeDiagnosticNumber(value.contextBuildMs, false),
    modelMs: safeDiagnosticNumber(value.modelMs, false),
    totalMs: safeDiagnosticNumber(value.totalMs, false),
    selectedFiles: safeDiagnosticNumber(value.selectedFiles),
    selectedRegions: safeDiagnosticNumber(value.selectedRegions),
    omittedFiles: safeDiagnosticNumber(value.omittedFiles)
  }
}

function requestUsage(requests) {
  if (!requests.length || !requests.every(request => request.usage)) return null
  return requests.reduce((total, request) => ({
    inputTokens: total.inputTokens + request.usage.inputTokens,
    outputTokens: total.outputTokens + request.usage.outputTokens,
    totalTokens: total.totalTokens + request.usage.totalTokens
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
}

function evaluatorTokenPolicy(profile, protocol) {
  const budget = resolveGenerationBudget(profile, 'medium')
  const contextWindowTokens = budget.contextWindowTokens
  const profileOutputTokens = safeTokenSetting(profile.maxOutputTokens)
  const reservedOutputTokens = budget.reservedOutputTokens
  const inputTokenTarget = INPUT_TOKEN_TARGETS.medium
  return {
    contextWindowTokens,
    profileOutputTokens: profileOutputTokens ?? null,
    maxOutputTokens: profileOutputTokens ?? (protocol === 'anthropic' ? reservedOutputTokens : null),
    maxOutputTokensPolicy: profileOutputTokens ? 'profile-explicit' : protocol === 'anthropic' ? 'llm-anthropic-default' : 'provider-default',
    inputTokenTarget,
    inputTokenBudget: budget.inputTokens,
    reservedOutputTokens,
    reservedOutputPolicy: profileOutputTokens
      ? 'profile-maxOutputTokens'
      : protocol === 'anthropic'
        ? 'anthropic-default-16384'
        : reservedOutputTokens === DEEPSEEK_THINKING_RESERVE
          ? 'deepseek-reasoning-reserve-65536'
          : reservedOutputTokens === DEFAULT_OUTPUT_RESERVE
            ? 'application-default-reserve-16384'
          : 'application-output-reserve',
    tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
    contextStrategy: 'structure-v1'
  }
}

function repositoryId(remote) {
  const https = remote.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/iu)
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu)
  return (https?.[1] ?? ssh?.[1] ?? '').toLowerCase()
}

async function manifestAt(manifestPath) {
  return JSON.parse(await readFile(manifestPath ?? path.join(here, 'real-corpus/corpus.json'), 'utf8'))
}

async function git(directory, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd: directory, windowsHide: true, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

async function rejectSymlinkPath(root, relative) {
  const absolute = path.resolve(root, relative)
  const rel = path.relative(root, absolute)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('corpus case path escapes repos root')
  let current = root
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error('corpus case path contains a symbolic link')
  }
  if (await realpath(absolute) !== absolute) throw new Error('corpus case path is not canonical')
  return absolute
}

export async function verifyRealCorpus({ reposRoot, manifestPath } = {}) {
  if (!reposRoot) throw new Error('reposRoot is required')
  const root = await realpath(path.resolve(reposRoot))
  const manifest = await manifestAt(manifestPath)
  if (manifest.schemaVersion !== 'repoprep-real-corpus-v1' || !Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error('invalid or empty real corpus manifest')
  if (manifest.evidenceHashMode !== undefined && !['raw', 'utf8-lf'].includes(manifest.evidenceHashMode)) throw new Error('unsupported evidence hash mode')
  const seen = new Set()
  const verified = []
  for (const item of manifest.cases) {
    if (!item?.id || seen.has(item.id) || !/^[a-f0-9]{40}$/i.test(item.commit ?? '') || !Array.isArray(item.evidenceFiles) || item.evidenceFiles.length === 0 || !Array.isArray(item.knownFacts) || item.knownFacts.length === 0) throw new Error('invalid or duplicate corpus case')
    seen.add(item.id)
    const directory = await rejectSymlinkPath(root, item.directory)
    const remote = await git(directory, 'remote', 'get-url', 'origin')
    const head = await git(directory, 'rev-parse', 'HEAD')
    const status = await git(directory, 'status', '--porcelain')
    const expectedRepository = String(item.repository ?? '').toLowerCase()
    let urlRepository = ''
    try {
      const parsed = new URL(item.url)
      if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com' && !parsed.port && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) urlRepository = parsed.pathname.replace(/^\//u, '').replace(/\.git\/?$/u, '').replace(/\/$/u, '').toLowerCase()
    } catch { /* invalid URL remains a failed match */ }
    if (head.toLowerCase() !== item.commit.toLowerCase() || status !== '' || repositoryId(remote) !== expectedRepository || urlRepository !== expectedRepository) throw new Error(`corpus repository verification failed: ${item.id}`)
    const fileHashes = {}
    for (const evidence of item.evidenceFiles) {
      const filePath = await rejectSymlinkPath(directory, evidence.path)
      const digest = hashEvidenceBytes(await readFile(filePath), manifest.evidenceHashMode)
      if (digest !== evidence.sha256) throw new Error(`evidence hash mismatch: ${item.id}/${evidence.path}`)
      fileHashes[evidence.path] = digest
    }
    for (const fact of item.knownFacts) {
      if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) throw new Error(`known fact has no evidence: ${item.id}/${fact.id}`)
      for (const ref of fact.evidence) {
        if (!Object.hasOwn(fileHashes, ref.path) || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine) throw new Error(`invalid evidence reference: ${item.id}/${fact.id}`)
        const lines = (await readFile(path.join(directory, ref.path), 'utf8')).split(/\r?\n/u)
        if (ref.endLine > lines.length) throw new Error(`evidence line range missing: ${item.id}/${fact.id}`)
      }
    }
    verified.push({ id: item.id, repository: item.repository, commit: head, sourceHashes: fileHashes })
  }
  return { schemaVersion: manifest.schemaVersion, version: manifest.version, cases: verified }
}

async function hashSources(manifestPath) {
  const sourceHashes = {}
  const roots = ['electron/services', 'shared', 'scripts/evaluation']
  async function walk(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const abs = path.join(directory, entry.name)
      const rel = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) await walk(abs, rel)
      else if (entry.isFile() && /\.(?:ts|mjs|cjs)$/u.test(entry.name) && rel !== 'scripts/evaluation/real-corpus/corpus.json') sourceHashes[rel] = hash(await readFile(abs))
    }
  }
  for (const root of roots) await walk(path.join(repo, root), root)
  for (const name of ['package.json', 'package-lock.json']) sourceHashes[name] = hash(await readFile(path.join(repo, name)))
  sourceHashes['realCorpusManifest'] = hash(await readFile(manifestPath ?? path.join(here, 'real-corpus/corpus.json')))
  return Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)))
}

async function boundedUsage(response, deadline) {
  try {
    const reader = response.clone().body?.getReader()
    if (!reader) return null
    const chunks = []
    let size = 0
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { void reader.cancel().catch(() => {}); return null }
      let timer
      const next = await Promise.race([
        reader.read(),
        new Promise(resolve => { timer = setTimeout(() => resolve({ deadlineExceeded: true }), remaining) })
      ])
      clearTimeout(timer)
      if (next.deadlineExceeded) { void reader.cancel().catch(() => {}); return null }
      const { done, value } = next
      if (done) break
      size += value.byteLength
      if (size > MAX_USAGE_BYTES) { void reader.cancel().catch(() => {}); return null }
      chunks.push(value)
    }
    const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
    const usage = JSON.parse(text).usage
    const input = usage?.prompt_tokens ?? usage?.input_tokens
    const output = usage?.completion_tokens ?? usage?.output_tokens
    const total = usage?.total_tokens ?? input + output
    const validCount = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_USAGE_TOKENS
    return validCount(input) && validCount(output) && validCount(total) && total <= input + output + MAX_USAGE_TOKENS
      ? { inputTokens: input, outputTokens: output, totalTokens: total }
      : null
  } catch { return null }
}

export function installFetchObserver(profile, limit, deadline) {
  const nativeFetch = globalThis.fetch
  const origin = new URL(profile.baseUrl).origin
  const metrics = { requests: [], blockedRequests: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, usageAvailable: true }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== origin || (init.method ?? (typeof input === 'object' && input.method) ?? 'GET').toUpperCase() !== 'POST') {
      metrics.blockedRequests++
      throw new Error('request blocked by evaluation network policy')
    }
    if (Date.now() >= deadline) throw new DOMException('request deadline exceeded', 'TimeoutError')
    if (metrics.requests.length >= limit) throw new Error('request limit reached')
    const bodyText = typeof init.body === 'string' ? init.body : ''
    let messages = []
    try { messages = JSON.parse(bodyText).messages ?? [] } catch { /* metrics remain bounded */ }
    const started = Date.now()
    const request = { attempt: messages.some(message => message.role === 'assistant') ? 'repair' : 'initial', inputChars: messages.reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0), 0), promptHash: hash(bodyText), elapsedMs: null, status: null, errorType: null, usage: null }
    metrics.requests.push(request)
    try {
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => timeoutController.abort(), Math.max(1, deadline - Date.now()))
      let response
      try { response = await nativeFetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeoutController.signal]) : timeoutController.signal }) }
      finally { clearTimeout(timeout) }
      request.status = response.status
      const usage = await boundedUsage(response, deadline)
      request.elapsedMs = Date.now() - started
      request.usage = usage
      if (usage) for (const key of Object.keys(metrics.usage)) metrics.usage[key] += usage[key]
      else metrics.usageAvailable = false
      return response
    } catch (error) {
      request.elapsedMs = Date.now() - started
      request.errorType = safeErrorType(error)
      throw new Error('model request failed')
    }
  }
  return { metrics, restore: () => { globalThis.fetch = nativeFetch } }
}

function sanitizeProfile(profile) {
  return {
    id: 'real-eval',
    name: 'Real corpus evaluation',
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    temperature: profile.temperature,
    protocol: profile.protocol,
    ...(safeTokenSetting(profile.contextWindowTokens) ? { contextWindowTokens: safeTokenSetting(profile.contextWindowTokens) } : {}),
    ...(safeTokenSetting(profile.maxOutputTokens) ? { maxOutputTokens: safeTokenSetting(profile.maxOutputTokens) } : {})
  }
}

function sanitizeResult(result, apiKey) {
  const secret = typeof apiKey === 'string' ? apiKey : ''
  const visit = value => {
    if (typeof value === 'string') return secret ? value.split(secret).join('[redacted]') : value
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
    return value
  }
  return visit(result)
}

function reportMarkdown(run) {
  const variants = ['generation', 'baseline']
  const rows = run.cases.flatMap(item => variants.filter(variant => item[variant]).map(variant => {
    const result = item[variant]
    const questionCount = result.scored?.quota?.actual ?? result.questions?.length ?? 'unknown'
    const tokenTotal = result.tokens?.totalTokens ?? result.diagnostics?.actualUsage?.totalTokens ?? 'unknown'
    const alerts = result.scored?.alerts?.join(', ') || 'none'
    return `| ${item.id} | ${variant} | ${result.status ?? 'complete'} | ${questionCount} | ${result.requestCount ?? result.requests?.length ?? 0} | ${result.elapsedMs ?? 'unknown'} | ${result.diagnostics?.contextBuildMs ?? 'unknown'} | ${result.diagnostics?.modelMs ?? 'unknown'} | ${tokenTotal} | ${result.diagnostics?.estimatedInputTokens ?? 'unknown'} | ${result.diagnostics?.failedStage ?? result.failureStage ?? 'none'} | ${alerts} |`
  }))
  return [
    '# Real model public repository evaluation', '',
    `- Mode: ${run.mode}`, `- Run: ${run.runId}`, `- Corpus: ${run.corpusVersion}`,
    `- Model: ${run.model}`, `- Status: ${run.status}`, '- Human review: pending',
    `- Context window setting: ${run.config.contextWindowTokens ?? 'unknown'}`,
    `- Configured output cap: ${run.config.maxOutputTokens ?? 'provider controlled'}`,
    `- Application input budget: ${run.config.applicationInputTokenBudget ?? 'unknown'} estimated tokens`,
    `- Reserved output: ${run.config.reservedOutputTokens ?? 'unknown'} tokens (${run.config.reservedOutputPolicy ?? 'unknown policy'})`,
    '', '| Case | Variant | Status | Questions | Requests | Elapsed ms | Context ms | Model ms | Actual tokens | Estimated input tokens | Failure stage | Alerts |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows,
    '', 'Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.',
    'Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.'
  ].join('\n') + '\n'
}

export async function runRealEvaluation({ reposRoot, outputDir, profile, manifestPath, caseIds, variants = DEFAULT_VARIANTS, maxRequests = 16, maxDurationMs = 20 * 60 * 1000 } = {}) {
  if (!reposRoot || !outputDir || !profile?.apiKey || !profile?.baseUrl || !profile?.model) throw new Error('reposRoot, outputDir, and a complete profile are required')
  if (!Array.isArray(variants) || variants.length === 0 || new Set(variants).size !== variants.length || variants.some(value => !ALLOWED_VARIANTS.has(value)) || !Number.isInteger(maxRequests) || maxRequests < 1 || !Number.isFinite(maxDurationMs) || maxDurationMs < 1) throw new Error('invalid evaluation limits or variants')
  const absoluteOutput = path.resolve(outputDir)
  try { if ((await readdir(absoluteOutput)).length) throw new Error('output directory must be empty') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const verification = await verifyRealCorpus({ reposRoot, manifestPath })
  const manifest = await manifestAt(manifestPath)
  const selected = manifest.cases.filter(item => !caseIds || caseIds.includes(item.id))
  if (!selected.length || (caseIds && selected.length !== new Set(caseIds).size)) throw new Error('requested corpus cases were not found')
  const safeProfile = sanitizeProfile(profile)
  new URL(safeProfile.baseUrl)
  const protocol = profile.protocol ?? 'openai'
  const tokenPolicy = evaluatorTokenPolicy(safeProfile, protocol)
  const config = {
    mode: 'real-model-public-repositories',
    variants,
    granularity: 'medium',
    budget: GRANULARITY_QUESTION_BUDGET.medium,
    temperature: profile.temperature ?? 0.4,
    contextWindowTokens: tokenPolicy.contextWindowTokens,
    profileMaxOutputTokens: tokenPolicy.profileOutputTokens,
    maxOutputTokens: tokenPolicy.maxOutputTokens,
    maxOutputTokensPolicy: tokenPolicy.maxOutputTokensPolicy,
    applicationInputTokenTarget: tokenPolicy.inputTokenTarget,
    applicationInputTokenBudget: tokenPolicy.inputTokenBudget,
    reservedOutputTokens: tokenPolicy.reservedOutputTokens,
    reservedOutputPolicy: tokenPolicy.reservedOutputPolicy,
    tokenEstimateMethod: tokenPolicy.tokenEstimateMethod,
    contextStrategy: tokenPolicy.contextStrategy,
    inputTokenBudgetPolicy: 'min(application target, max(0, configured context window - output reserve)); unknown window uses application target',
    maxRequests,
    maxDurationMs,
    baseline: 'production scan and generation with README candidate only; repository tree and scan metadata remain available'
  }
  const configHashInputs = {
    baseUrlOriginSha256: hash(new URL(profile.baseUrl).origin),
    model: profile.model,
    protocol
  }
  const configHash = hash(JSON.stringify({ config, ...configHashInputs }))
  const sourceHashes = await hashSources(manifestPath)
  const runId = randomUUID()
  const run = { schemaVersion: 'repoprep-eval-report-v2', runId, corpusVersion: manifest.version, mode: config.mode, model: profile.model, protocol, runtime: { node: process.version }, config, configHash, configHashInputs, sourceHashes, fixtureHashes: Object.fromEntries(selected.flatMap(item => item.evidenceFiles.map(file => [`${item.id}/${file.path}`, file.sha256]))), reportDigest: '', generatedAt: new Date().toISOString(), cases: [], questions: [], status: 'running', humanReview: { status: 'pending', reviewedCount: 0, coverage: 0, templatePath: 'review-template.json' }, limitations: ['Keyword coverage is not factual correctness.', 'Real token usage is null when the provider omits bounded usage metadata.', 'Human review has not been completed; pending is not a passing result.'] }
  const deadline = Date.now() + maxDurationMs
  const observer = installFetchObserver(safeProfile, maxRequests, deadline)
  let failure = null
  async function persist() {
    run.reportDigest = calculateReportDigest(run)
    run.questions = run.cases.flatMap(item => ['generation', 'baseline']
      .filter(variant => Array.isArray(item[variant]?.questions))
      .flatMap(variant => item[variant].questions.map(question => ({ caseId: item.id, variant, question: question.question, answer: question.answer, followUps: question.followUps }))))
    run.reportDigest = calculateReportDigest(run)
    await import('node:fs/promises').then(fs => fs.mkdir(absoluteOutput, { recursive: true }))
    await writeFile(path.join(absoluteOutput, 'report.json'), `${JSON.stringify(run, null, 2)}\n`)
    await writeFile(path.join(absoluteOutput, 'review-template.json'), `${JSON.stringify(makeReviewTemplate(run), null, 2)}\n`)
    await writeFile(path.join(absoluteOutput, 'report.md'), reportMarkdown(run))
  }
  try {
    for (const definition of selected) {
      const directory = path.join(path.resolve(reposRoot), definition.directory)
      const item = { id: definition.id, repository: definition.repository, commit: definition.commit, projectPath: `/public-corpus/${definition.id}`, granularity: 'medium', budget: GRANULARITY_QUESTION_BUDGET.medium }
      run.cases.push(item)
      for (const variant of variants) {
        if (Date.now() >= deadline) throw new Error('duration limit reached')
        const start = observer.metrics.requests.length
        const started = Date.now()
        let diagnostics = null
        let stage = 'scan'
        try {
          const scan = await scanProject(directory)
          if (variant === 'baseline') for (const file of scan.files) file.isContentCandidate = file.relPath === definition.readme
          stage = 'generation'
          const result = await generateInterview({
            scan,
            granularity: 'medium',
            roleFocus: definition.roleFocus ?? 'general',
            profile: safeProfile,
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            onProgress: () => {},
            onDiagnostics: value => { diagnostics = sanitizeGenerationDiagnostics(value) }
          })
          if (Date.now() >= deadline) throw new Error('duration limit reached')
          stage = 'scoring'
          const requests = observer.metrics.requests.slice(start)
          const questions = flattenQuestions(result)
          const scored = scoreCase(result, { ...definition, budget: GRANULARITY_QUESTION_BUDGET.medium })
          const output = {
            ...sanitizeResult(result, profile.apiKey),
            projectPath: item.projectPath,
            profileId: 'real-eval',
            modelUsed: profile.model,
            evaluationDiagnostics: diagnostics
          }
          item[variant] = {
            status: 'complete',
            elapsedMs: Date.now() - started,
            requestCount: requests.length,
            requests,
            inputChars: requests.reduce((sum, request) => sum + request.inputChars, 0),
            tokens: requestUsage(requests),
            diagnostics,
            output,
            questions: sanitizeResult(questions, profile.apiKey),
            scored: sanitizeResult(scored, profile.apiKey)
          }
          if (variant === 'generation') item.output = item.generation.output
          await persist()
        } catch (error) {
          const requests = observer.metrics.requests.slice(start)
          item[variant] = {
            status: 'failed',
            failureStage: diagnostics?.failedStage ?? stage,
            elapsedMs: Date.now() - started,
            requestCount: requests.length,
            requests,
            inputChars: requests.reduce((sum, request) => sum + request.inputChars, 0),
            tokens: requestUsage(requests),
            diagnostics
          }
          await persist()
          throw error
        }
      }
    }
  } catch (error) {
    failure = safeErrorType(error)
    run.failure = { type: failure, reason: error?.message === 'request limit reached' ? 'request_limit' : error?.message === 'duration limit reached' ? 'duration_limit' : 'evaluation_failed' }
  } finally {
    observer.restore()
    run.network = { blockedRequests: observer.metrics.blockedRequests, requests: observer.metrics.requests, usage: observer.metrics.usageAvailable ? observer.metrics.usage : null }
    run.status = failure ? 'partial' : 'complete'
    await persist()
  }
  return run
}

async function main() {
  const args = process.argv.slice(2)
  const command = args.shift()
  const usage = 'real-runner.mjs verify --repos-root <dir> [--manifest <file>] | run --repos-root <dir> --output <dir> [--case <id>] [--variant <generation|baseline>] [--max-requests <n>]'
  if (command === '--help') { console.log(usage); return }
  const options = parseRunnerArgs(args)
  if (options.help) { console.log(usage); return }
  if (command === 'verify') {
    if (options.variantSpecified) throw new Error('--variant is only supported by run')
    console.log(JSON.stringify(await verifyRealCorpus({ reposRoot: options['--repos-root'], manifestPath: options['--manifest'] }), null, 2))
  }
  else if (command === 'run') {
    const caseIds = options.caseIds.flatMap(value => value.split(','))
    const profile = { id: 'real-eval', baseUrl: process.env.REPOPREP_EVAL_BASE_URL, apiKey: process.env.REPOPREP_EVAL_API_KEY, model: process.env.REPOPREP_EVAL_MODEL, protocol: process.env.REPOPREP_EVAL_PROTOCOL }
    if (!profile.apiKey) throw new Error('REPOPREP_EVAL_API_KEY is required for real model evaluation')
    const result = await runRealEvaluation({
      reposRoot: options['--repos-root'],
      outputDir: options['--output'],
      profile,
      manifestPath: options['--manifest'],
      caseIds: caseIds.length ? caseIds : undefined,
      variants: options.variants,
      maxRequests: options['--max-requests'] ? Number(options['--max-requests']) : undefined
    })
    console.log(JSON.stringify({ runId: result.runId, status: result.status, report: path.join(path.resolve(options['--output']), 'report.json') }))
    if (result.status !== 'complete') process.exitCode = 1
  } else throw new Error('use verify, run, or --help')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message ?? 'evaluation failed'); process.exitCode = 1 })
}
