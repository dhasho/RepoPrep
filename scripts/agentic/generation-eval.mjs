import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 as dataSha256 } from './dataset-contract.mjs'
import {
  GENERATION_PER_RUN,
  GENERATION_PURPOSE,
  GENERATION_REVIEW_PENDING,
  GENERATION_REQUESTS_PER_RUN,
  createGenerationMatrix,
  deriveGenerationBudgets,
  loadGenerationEvaluationBundle,
  validateGenerationAuthorization,
  validateGenerationExecutionReport
} from './generation-eval-contract.mjs'
import { scanProject } from '../../electron/services/scanner.ts'
import { generateInterview } from '../../electron/services/generator.ts'
import { createWorkflowSnapshot } from '../../electron/services/workflow/snapshot-adapter.ts'
import { createEvidenceStore } from '../../electron/services/workflow/evidence-store.ts'
import { createBudgetLedger } from '../../electron/services/workflow/budget-ledger.ts'
import { createRunSpec } from '../../electron/services/workflow/run-spec.ts'
import { createEvidenceGenerationAdapter, EVIDENCE_GENERATION_WRITER_VARIANTS } from '../../electron/services/workflow/evidence-generation.ts'
import { normalizeBaseUrl } from '../../electron/services/llm.ts'
import { createGlobalBudgetCollector, createGuardedTransport, sanitizeModelFailure } from './retrieval-eval.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CODE_ROOT = path.resolve(HERE, '../..')
const STARTUP_HELPER = path.resolve(HERE, '../evaluation/run-agentic-profile-startup.cjs')
const require = createRequire(import.meta.url)
const HASH = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_CELL_WALL_CLOCK_MS = 600_000
const FAILURE_CODES = new Set([
  'authorization-invalid', 'authorization-binding-mismatch', 'authorization-required', 'authorization-claim-required',
  'authorization-claim-invalid', 'authorization-claim-used', 'execution-root-mismatch', 'output-path-invalid',
  'scratch-path-invalid', 'profile-binding-mismatch', 'profile-unavailable', 'dataset-invalid', 'dataset-unavailable',
  'stale-snapshot', 'evidence-invalid', 'unknown-evidence', 'budget-exhausted', 'capacity-exhausted', 'configuration-changed',
  'cancelled', 'timeout', 'model-failed', 'result-invalid', 'source-binding-invalid', 'lineage-invalid', 'execution-failed'
])

function fail(code) { throw new Error(FAILURE_CODES.has(code) ? code : 'execution-failed') }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function sha(value) { return createHash('sha256').update(value).digest('hex') }
function endpointFingerprint(baseUrl) {
  try { return sha(normalizeBaseUrl(baseUrl)) } catch { fail('profile-binding-mismatch') }
}
function within(parent, target, { allowEqual = false } = {}) {
  const relative = path.relative(path.resolve(parent), path.resolve(target))
  return (allowEqual && relative === '') || (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function staticErrorCode(error) {
  if (typeof error?.code === 'string' && FAILURE_CODES.has(error.code)) return error.code
  if (error instanceof Error && FAILURE_CODES.has(error.message)) return error.message
  return 'execution-failed'
}
function startupApi() {
  try { return require(STARTUP_HELPER) } catch { fail('authorization-invalid') }
}
function bindingFromAuthorization(authorization) {
  return Object.freeze({
    purpose: GENERATION_PURPOSE,
    reference: authorization.reference,
    sourceCommit: authorization.sourceCommit,
    generationDataHash: authorization.generationDataHash
  })
}
function checkMethod(api, name) {
  if (!api || typeof api[name] !== 'function') fail('authorization-invalid')
  return api[name].bind(api)
}

function getSyntheticTestHooks(mode, hooks) {
  if (mode === 'real' && hooks !== undefined) fail('authorization-invalid')
  if (hooks === undefined) return undefined
  const allowed = ['clock', 'setTimeout', 'clearTimeout', 'onCellStep']
  if (mode !== 'synthetic' || !isRecord(hooks) || Object.keys(hooks).some((key) => !allowed.includes(key)) ||
    hooks.clock !== undefined && typeof hooks.clock !== 'function' ||
    hooks.setTimeout !== undefined && typeof hooks.setTimeout !== 'function' ||
    hooks.clearTimeout !== undefined && typeof hooks.clearTimeout !== 'function' ||
    hooks.onCellStep !== undefined && typeof hooks.onCellStep !== 'function') fail('authorization-invalid')
  return hooks
}

export async function checkGenerationAuthorizationArtifact({ repoRoot, authorizationPath } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot || typeof authorizationPath !== 'string' || !path.isAbsolute(authorizationPath)) fail('authorization-required')
  let root
  try {
    root = await realpath(repoRoot)
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('execution-root-mismatch')
  } catch { fail('execution-root-mismatch') }
  let authStat
  try { authStat = await lstat(authorizationPath) } catch { fail('authorization-required') }
  if (!authStat.isFile() || authStat.isSymbolicLink() || ((authStat.attributes ?? 0) & 0x400) !== 0 || authStat.size > 16 * 1024) fail('authorization-invalid')

  let bundle
  try { bundle = await loadGenerationEvaluationBundle(path.join(root, 'scripts/agentic/datasets/v1')) }
  catch (error) { fail(staticErrorCode(error)) }
  let binding
  try {
    const checked = checkMethod(startupApi(), 'checkAuthorizationSync')({ repoRoot: root, authorizationPath, purpose: GENERATION_PURPOSE })
    binding = checked
  } catch (error) { fail(staticErrorCode(error)) }
  if (!binding || binding.purpose !== GENERATION_PURPOSE || binding.generationDataHash !== bundle.generationDataHash || binding.dataHash !== bundle.generationDataHash) fail('authorization-binding-mismatch')
  try {
    const authorization = validateGenerationAuthorization(binding.authorization, {
      sourceCommit: binding.sourceCommit,
      generationDataHash: bundle.generationDataHash,
      bundle
    })
    return Object.freeze({
      sourceCommit: binding.sourceCommit,
      generationDataHash: bundle.generationDataHash,
      purpose: GENERATION_PURPOSE,
      reference: authorization.reference,
      authorization,
      bundle
    })
  } catch (error) { fail(staticErrorCode(error)) }
}

export function createGenerationClaim({ repoRoot, authorization } = {}) {
  if (!isRecord(authorization)) fail('authorization-invalid')
  const binding = bindingFromAuthorization(authorization)
  try { return checkMethod(startupApi(), 'createClaimSync')(repoRoot, binding, GENERATION_PURPOSE) }
  catch (error) { fail(staticErrorCode(error)) }
}

export function verifyGenerationClaim({ repoRoot, authorization, claimPath } = {}) {
  if (!isRecord(authorization) || typeof claimPath !== 'string' || !claimPath) fail('authorization-claim-required')
  const binding = bindingFromAuthorization(authorization)
  try { return checkMethod(startupApi(), 'verifyClaimSync')(repoRoot, binding, claimPath, GENERATION_PURPOSE) }
  catch (error) { fail(staticErrorCode(error)) }
}

export function beginGenerationClaimOnce({ repoRoot, authorization, claimPath } = {}) {
  if (!isRecord(authorization) || typeof claimPath !== 'string' || !claimPath) fail('authorization-claim-required')
  const binding = bindingFromAuthorization(authorization)
  try { return checkMethod(startupApi(), 'beginClaimOnceSync')(repoRoot, binding, claimPath, GENERATION_PURPOSE) }
  catch (error) { fail(staticErrorCode(error)) }
}

export function verifyGenerationProfileBinding(profile, authorization) {
  if (!isRecord(profile) || !isRecord(authorization) || typeof profile.apiKey !== 'string' || !profile.apiKey || profile.apiKey.length > 512) fail('profile-unavailable')
  const profileProtocol = profile.protocol ?? 'openai'
  const profileTemperature = profile.temperature ?? 0.4
  const profileReasoning = profile.reasoningEffort ?? null
  if (endpointFingerprint(profile.baseUrl) !== authorization.endpointFingerprint || profile.model !== authorization.model ||
    profileProtocol !== authorization.protocol || profileTemperature !== authorization.temperature ||
    profileReasoning !== authorization.reasoningEffort || profile.contextWindowTokens !== authorization.contextWindowTokens ||
    authorization.contextWindowTokens <= authorization.maxOutputTokens || !Number.isSafeInteger(authorization.maxOutputTokens)) fail('profile-binding-mismatch')
  return Object.freeze({
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: authorization.maxOutputTokens
  })
}

function validateProfileShape(profile, maxOutputTokens) {
  if (!isRecord(profile) || typeof profile.id !== 'string' || typeof profile.name !== 'string' || typeof profile.baseUrl !== 'string' ||
    typeof profile.apiKey !== 'string' || !profile.apiKey || typeof profile.model !== 'string' || !Number.isSafeInteger(profile.contextWindowTokens) ||
    profile.contextWindowTokens <= maxOutputTokens || ![16_384, 32_768].includes(maxOutputTokens)) fail('profile-unavailable')
  return Object.freeze({ ...profile, maxOutputTokens })
}

function publicModel(profile) {
  return Object.freeze({
    endpointFingerprint: endpointFingerprint(profile.baseUrl),
    model: profile.model,
    protocol: profile.protocol ?? 'openai',
    temperature: profile.temperature ?? 0.4,
    reasoningEffort: profile.reasoningEffort ?? null,
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens
  })
}

function makeRunSpec(task, profile, snapshotId, cell, maxRequests) {
  const strategy = cell.strategy === 'static-control' ? 'static' : 'agentic'
  return createRunSpec({
    version: 1,
    runId: `m08-case-${String(cell.caseNumber).padStart(4, '0')}`,
    projectId: task.projectId,
    snapshotId,
    strategy,
    strategyVersion: strategy === 'static' ? 'static-v1' : 'agentic-v1',
    roleFocus: task.roleFocus,
    granularity: task.granularity,
    model: {
      profileId: profile.id,
      endpointFingerprint: profile.endpointFingerprint ?? endpointFingerprint(profile.baseUrl),
      model: profile.model,
      protocol: profile.protocol ?? 'openai',
      reasoningEffort: profile.reasoningEffort ?? undefined,
      temperature: profile.temperature ?? 0.4,
      contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens
    },
    promptVersion: 'm08-generation-prompt-v1',
    toolVersion: 'm08-generation-tools-v1',
    policyVersion: 'm08-generation-policy-v1',
    budget: {
      maxModelRequests: maxRequests,
      inputTokens: GENERATION_PER_RUN.inputTokens,
      outputTokens: GENERATION_PER_RUN.outputTokens,
      wallClockMs: GENERATION_PER_RUN.wallClockMs
    }
  })
}

function prevalidateRunSpecs(bundle, authorization, profileModel) {
  const matrix = createGenerationMatrix(bundle)
  for (let index = 0; index < matrix.length; index++) {
    const cell = { ...matrix[index], caseNumber: index + 1 }
    const task = bundle.tasks.find((entry) => entry.id === cell.taskId)
    if (!task) fail('dataset-invalid')
    const spec = makeRunSpec(task, profileModel, 'm08-preflight-snapshot', cell, GENERATION_REQUESTS_PER_RUN[task.granularity])
    if (spec.budget.total.inputTokens !== GENERATION_PER_RUN.inputTokens || spec.budget.total.outputTokens !== GENERATION_PER_RUN.outputTokens ||
      spec.budget.total.wallClockMs !== GENERATION_PER_RUN.wallClockMs || spec.budget.total.maxModelRequests !== GENERATION_REQUESTS_PER_RUN[task.granularity] ||
      spec.generationOutputTokens < 1 || spec.generationOutputTokens > authorization.maxOutputTokens) fail('authorization-invalid')
  }
  return matrix
}

function assertSafeSourcePath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\\') || relPath.includes(':') || relPath.includes('\0') || relPath.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(relPath)) fail('dataset-invalid')
  const segments = relPath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[. ]$/u.test(segment) || /^\.git$/iu.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment))) fail('dataset-invalid')
  return segments
}

async function assertNoSymlinkPath(absolutePath, { allowMissing = false } = {}) {
  const resolved = path.resolve(absolutePath)
  const parsed = path.parse(resolved)
  let cursor = parsed.root
  let missing = false
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    if (missing) continue
    let stat
    try { stat = await lstat(cursor) } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') { missing = true; continue }
      fail('output-path-invalid')
    }
    if (stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) fail('output-path-invalid')
    if (cursor !== resolved && !stat.isDirectory()) fail('output-path-invalid')
  }
  return { resolved, missing }
}

async function validateOutputPath(repoRoot, outputDir, mode) {
  if (typeof outputDir !== 'string' || !outputDir || !path.isAbsolute(outputDir)) fail('output-path-invalid')
  const resolved = path.resolve(outputDir)
  const validationRoot = path.join(repoRoot, '.validation', 'agentic')
  let boundaryRoot = repoRoot
  if (mode === 'real') {
    if (!within(validationRoot, resolved)) fail('output-path-invalid')
  } else if (within(validationRoot, resolved)) {
    boundaryRoot = repoRoot
  } else {
    const tempRoot = path.resolve(os.tmpdir())
    if (!within(tempRoot, resolved)) fail('output-path-invalid')
    boundaryRoot = tempRoot
  }
  const checked = await assertNoSymlinkPath(resolved, { allowMissing: true })
  if (!checked.missing) fail('output-path-invalid')
  return Object.freeze({ root: resolved, boundaryRoot })
}

async function validateScratchParent(scratchRoot) {
  if (typeof scratchRoot !== 'string' || !scratchRoot || !path.isAbsolute(scratchRoot)) fail('scratch-path-invalid')
  const tempRoot = path.resolve(os.tmpdir())
  const resolved = path.resolve(scratchRoot)
  if (!within(tempRoot, resolved)) fail('scratch-path-invalid')
  try {
    const checked = await assertNoSymlinkPath(resolved)
    const stat = await lstat(checked.resolved)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('scratch-path-invalid')
  } catch { fail('scratch-path-invalid') }
  return resolved
}

async function ensureDirectoryChain(root, target) {
  const rootPath = path.resolve(root)
  const targetPath = path.resolve(target)
  if (!within(rootPath, targetPath, { allowEqual: true })) fail('output-path-invalid')
  const relative = path.relative(rootPath, targetPath)
  let cursor = rootPath
  const rootStat = await lstat(rootPath)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('output-path-invalid')
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    try {
      const stat = await lstat(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) fail('output-path-invalid')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(cursor, { mode: 0o700 })
      const stat = await lstat(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('output-path-invalid')
    }
  }
}

async function createPrivateScratch(parent) {
  const root = await realpath(parent)
  if (!within(path.resolve(os.tmpdir()), root)) fail('scratch-path-invalid')
  const directory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(root, 'm08-generation-')))
  try { await (await import('node:fs/promises')).chmod(directory, 0o700) } catch { /* ACLs may replace POSIX mode bits on Windows. */ }
  const stat = await lstat(directory)
  const canonical = await realpath(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !within(root, canonical)) fail('scratch-path-invalid')
  return canonical
}

async function materializeProject(project, caseRoot, checkDeadline = () => undefined) {
  const projectRoot = path.join(caseRoot, 'source')
  checkDeadline()
  await mkdir(projectRoot, { mode: 0o700 })
  checkDeadline()
  const canonicalProjectRoot = await realpath(projectRoot)
  checkDeadline()
  if (!within(caseRoot, canonicalProjectRoot)) fail('scratch-path-invalid')
  for (const file of project.files) {
    const segments = assertSafeSourcePath(file.path)
    let parent = canonicalProjectRoot
    for (const component of segments.slice(0, -1)) {
      const next = path.join(parent, component)
      try {
        const stat = await lstat(next)
        if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) fail('scratch-path-invalid')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        checkDeadline()
        await mkdir(next, { mode: 0o700 })
        checkDeadline()
      }
      parent = next
    }
    const target = path.resolve(parent, segments.at(-1))
    if (!within(canonicalProjectRoot, target)) fail('scratch-path-invalid')
    checkDeadline()
    const handle = await open(target, 'wx', 0o600)
    try {
      checkDeadline()
      await handle.writeFile(Buffer.from(file.content, 'utf8'))
      checkDeadline()
      await handle.sync()
      checkDeadline()
    } finally { await handle.close() }
    checkDeadline()
    const stat = await lstat(target)
    checkDeadline()
    if (!stat.isFile() || stat.isSymbolicLink() || sha(await readFile(target)) !== file.sha256) fail('dataset-invalid')
  }
  return canonicalProjectRoot
}

async function writeExclusive(directory, filename, value) {
  const target = path.join(directory, filename)
  const handle = await open(target, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
  return filename
}

function appendDurableJournal(filename, value) {
  const fd = openSync(filename, 'a')
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
}

function stageFailure(error) {
  const code = staticErrorCode(error)
  return code === 'execution-failed' ? 'execution-failed' : code
}

function makePublicTaskPrompt(messages, task) {
  const suffix = `\n\n## M08 public task\nGoal: ${task.objective}\nTopic: ${task.topic}\nUse only the fixed evidence identifiers and source ranges provided in this request.`
  return messages.map((message, index) => index === messages.length - 1 && message.role === 'user'
    ? { ...message, content: `${message.content}${suffix}` }
    : { ...message })
}

function makeTopicCard(task, evidenceIds) {
  return Object.freeze({
    id: `topic-${task.id}`,
    title: task.topic,
    mechanism: task.objective,
    valueRationale: task.objective,
    difficulty: task.granularity === 'fine' ? 'advanced' : 'intermediate',
    evidenceIds: Object.freeze([...evidenceIds]),
    evidenceNeeds: Object.freeze([task.objective]),
    unconfirmed: Object.freeze([])
  })
}

async function issueFrozenEvidence({ project, task, evidenceInput, snapshot, store, ledger, signal, caseNumber, checkDeadline = () => undefined }) {
  const fileByPath = new Map(snapshot.files.map((file) => [file.relPath, file]))
  const ids = []
  const readCache = new Map()
  for (let index = 0; index < evidenceInput.evidence.length; index++) {
    checkDeadline()
    const ref = evidenceInput.evidence[index]
    const file = fileByPath.get(ref.path)
    if (!file) fail('evidence-invalid')
    let read = readCache.get(file.fileId)
    if (!read) {
      const reservationId = `read-${String(caseNumber).padStart(4, '0')}-${String(index + 1).padStart(3, '0')}`
      ledger.reserveRead(reservationId, file.byteLength)
      let attempted = false
      try {
        attempted = true
        const response = await snapshot.readFile(file.fileId, signal)
        checkDeadline()
        ledger.settleRead(reservationId, response.consumedBytes)
        read = response.read
        readCache.set(file.fileId, read)
      } catch (error) {
        const reservation = ledger.snapshot().reservations.find((item) => item.id === reservationId)
        if (reservation?.state === 'reserved') {
          try { attempted ? ledger.settleRead(reservationId, file.byteLength) : ledger.releaseRead(reservationId) } catch { /* Preserve the source failure. */ }
        }
        throw error
      }
    }
    if (read.lineMapping !== 'preserved') fail('evidence-invalid')
    const sourceLines = read.text.split('\n')
    if (ref.endLine > sourceLines.length || dataSha256(Buffer.from(sourceLines.slice(ref.startLine - 1, ref.endLine).join('\n'), 'utf8')) !== ref.sha256) fail('evidence-invalid')
    const records = await store.issue(read, { startLine: ref.startLine, endLine: ref.endLine }, signal)
    checkDeadline()
    const exact = records.filter((record) => record.originalRange?.startLine === ref.startLine && record.originalRange?.endLine === ref.endLine && record.contentHash === ref.sha256)
    if (exact.length !== 1 || exact[0].relPath !== ref.path || exact[0].snapshotId !== snapshot.snapshotId) fail('evidence-invalid')
    ids.push(exact[0].id)
  }
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !/^ev_[0-9a-f-]{36}$/u.test(id))) fail('evidence-invalid')
  return Object.freeze(ids)
}

function outputUsageFromLedger(ledger, adapterMetadata, cellId) {
  const meter = ledger.snapshot()
  const requestMetadata = new Map(adapterMetadata.map((item) => [item.requestId, item]))
  const requests = []
  const unknownReservations = []
  let knownInputTokens = 0, knownOutputTokens = 0, conservativeInputTokens = 0, conservativeOutputTokens = 0
  for (const reservation of meter.reservations) {
    if (!['dispatched', 'settled', 'unknown', 'unknown-unsent'].includes(reservation.state)) continue
    const metadata = requestMetadata.get(reservation.id)
    if (!metadata) fail('lineage-invalid')
    const usage = reservation.usage ? { inputTokens: reservation.usage.inputTokens, outputTokens: reservation.usage.outputTokens, totalTokens: reservation.usage.totalTokens } : null
    const request = {
      requestId: reservation.id,
      stage: reservation.stage,
      completion: metadata.completion,
      usage,
      reservation: { state: reservation.state, inputTokens: reservation.estimatedInputTokens, outputTokens: reservation.outputTokens },
      manifest: metadata.manifest
    }
    requests.push(request)
    if (usage) {
      knownInputTokens += usage.inputTokens
      knownOutputTokens += usage.outputTokens
      conservativeInputTokens += usage.inputTokens
      conservativeOutputTokens += usage.outputTokens
    } else if (reservation.state === 'unknown' || reservation.state === 'unknown-unsent' || reservation.state === 'dispatched' || reservation.state === 'reserved') {
      const unknown = { requestId: reservation.id, stage: reservation.stage, inputTokens: reservation.estimatedInputTokens, outputTokens: reservation.outputTokens }
      unknownReservations.push(unknown)
      conservativeInputTokens += unknown.inputTokens
      conservativeOutputTokens += unknown.outputTokens
    }
  }
  requests.sort((a, b) => a.requestId.localeCompare(b.requestId))
  unknownReservations.sort((a, b) => a.requestId.localeCompare(b.requestId))
  const usageComplete = meter.usageComplete && requests.every((item) => item.reservation.state === 'settled' && item.usage) && !meter.blocked &&
    meter.overspend.inputTokens === 0 && meter.overspend.outputTokens === 0 && meter.overspend.readBytes === 0
  return {
    requests,
    usageComplete,
    knownActual: { requests: requests.filter((item) => item.usage).length, inputTokens: knownInputTokens, outputTokens: knownOutputTokens },
    unknownReservations,
    conservativeCharged: { requests: requests.length, inputTokens: conservativeInputTokens, outputTokens: conservativeOutputTokens }
  }
}

function addSourceBindings(target, requests) {
  for (const request of requests) {
    for (const source of request.manifest.sources) {
      for (const evidenceId of source.ids) {
        const binding = {
          path: source.relPath,
          displayRange: source.displayRange,
          originalRange: source.originalRange,
          hash: source.hash,
          sourceKind: source.sourceKind
        }
        const prior = target[evidenceId]
        if (prior && JSON.stringify(prior) !== JSON.stringify(binding)) fail('lineage-invalid')
        target[evidenceId] = binding
      }
    }
  }
}

function followupFingerprint(value, depth, counter) {
  if (depth > 8 || counter.count >= 64 || !isRecord(value) || typeof value.question !== 'string' || typeof value.answer !== 'string') fail('lineage-invalid')
  counter.count++
  counter.chars += value.question.length + value.answer.length
  if (counter.chars > 256_000) fail('lineage-invalid')
  let children = []
  if (value.followUps !== undefined) {
    if (!Array.isArray(value.followUps) || value.followUps.length > 32) fail('lineage-invalid')
    children = value.followUps.map((child) => followupFingerprint(child, depth + 1, counter))
  }
  return { question: value.question, answer: value.answer, followUps: children }
}

function fingerprintQuestion(question) {
  if (!isRecord(question) || typeof question.question !== 'string' || typeof question.answer !== 'string' || !Array.isArray(question.followUps) || question.followUps.length > 32) fail('lineage-invalid')
  const counter = { count: 0, chars: question.question.length + question.answer.length + (typeof question.title === 'string' ? question.title.length : 0) }
  if (counter.chars > 256_000) fail('lineage-invalid')
  const content = {
    title: typeof question.title === 'string' ? question.title : null,
    question: question.question,
    answer: question.answer,
    followUps: question.followUps.map((item) => followupFingerprint(item, 0, counter))
  }
  return sha(Buffer.from(canonicalJson(content), 'utf8'))
}

function validateSidecarLineage(result, sidecar, requests) {
  if (!result || !sidecar || sidecar.version !== 1 || !Array.isArray(sidecar.questions) || !result.sections) return false
  const questions = result.sections.flatMap((section) => section.questions)
  if (questions.length !== sidecar.questions.length) return false
  const byQuestion = new Map(sidecar.questions.map((item) => [item.questionId, item]))
  if (byQuestion.size !== sidecar.questions.length) return false
  const requestMap = new Map(requests.map((item) => [item.requestId, item]))
  const firstManifest = requests[0]?.manifest
  if (!firstManifest || sidecar.runId !== firstManifest.runId || sidecar.projectId !== firstManifest.projectId || sidecar.snapshotId !== firstManifest.snapshotId) return false
  return questions.every((question) => {
    const evidence = byQuestion.get(question.id)
    const request = evidence && requestMap.get(evidence.requestId)
    if (!evidence || !request || evidence.manifestHash !== request.manifest.manifestHash || evidence.verification !== 'source-bound-unverified' || evidence.questionFingerprint !== fingerprintQuestion(question) || request.completion !== 'completed') return false
    const sourcedIds = new Set(request.manifest.sources.flatMap((source) => source.ids))
    return Array.isArray(evidence.evidenceIds) && evidence.evidenceIds.length > 0 && evidence.evidenceIds.every((id) => request.manifest.packedIds.includes(id) && sourcedIds.has(id))
  })
}

function failedCellRecord(cell, caseNumber, errorCode, acceptedQuestionCount, usage, modelFailure, elapsedMs, deadlineReason) {
  return {
    ...cell,
    caseNumber,
    actualOrder: caseNumber,
    execution: {
      status: 'failed',
      ...(errorCode ? { errorCode } : {}),
      ...(modelFailure ? { modelFailure } : {}),
      elapsedMs,
      ...(deadlineReason ? { deadlineReason } : {}),
      acceptedQuestionCount,
      usageComplete: usage?.usageComplete ?? false,
      lineageValid: false,
      knownActual: usage?.knownActual ?? { requests: 0, inputTokens: 0, outputTokens: 0 },
      unknownReservations: usage?.unknownReservations ?? [],
      conservativeCharged: usage?.conservativeCharged ?? { requests: 0, inputTokens: 0, outputTokens: 0 }
    },
    requests: usage?.requests ?? [],
    resultFile: null,
    sidecarFile: null
  }
}

export async function runGenerationEvaluation({
  repoRoot = CODE_ROOT,
  authorizationPath,
  outputDir,
  claimPath,
  scratchRoot,
  profile,
  readProfile,
  mode = 'real',
  transport,
  testHooks: suppliedTestHooks
} = {}) {
  const realMode = mode === 'real'
  if (!realMode && mode !== 'synthetic') fail('execution-failed')
  const testHooks = getSyntheticTestHooks(mode, suppliedTestHooks)
  if (realMode && (transport !== undefined || profile !== undefined || typeof readProfile !== 'function')) fail('authorization-invalid')
  if (mode === 'synthetic' && (!transport || !isRecord(profile) || readProfile !== undefined || authorizationPath !== undefined || claimPath !== undefined)) fail('authorization-invalid')
  if (mode === 'real' && (typeof authorizationPath !== 'string' || !authorizationPath || typeof claimPath !== 'string' || !claimPath)) fail('authorization-required')

  const root = await realpath(repoRoot)
  if (realMode) {
    const executingRoot = await realpath(CODE_ROOT)
    if (root !== executingRoot) fail('execution-root-mismatch')
  }
  let authorizationRecord
  const bundle = realMode
    ? (authorizationRecord = await checkGenerationAuthorizationArtifact({ repoRoot: root, authorizationPath })).bundle
    : await loadGenerationEvaluationBundle()
  const budgets = deriveGenerationBudgets(bundle)
  const outputPath = await validateOutputPath(root, outputDir, mode)
  const outputRoot = outputPath.root
  const scratchParent = await validateScratchParent(scratchRoot)

  let authorization, binding, startup
  let configuredProfile
  if (realMode) {
    authorization = authorizationRecord.authorization
    binding = bindingFromAuthorization(authorization)
    startup = startupApi()
    try { checkMethod(startup, 'verifyClaimSync')(root, binding, claimPath, GENERATION_PURPOSE) }
    catch (error) { fail(staticErrorCode(error)) }
    configuredProfile = Object.freeze({
      id: 'm08-preflight-profile',
      name: 'M08 preflight profile',
      baseUrl: 'https://authorization.invalid/v1',
      endpointFingerprint: authorization.endpointFingerprint,
      model: authorization.model,
      protocol: authorization.protocol,
      temperature: authorization.temperature,
      ...(authorization.reasoningEffort ? { reasoningEffort: authorization.reasoningEffort } : {}),
      contextWindowTokens: authorization.contextWindowTokens,
      maxOutputTokens: authorization.maxOutputTokens
    })
  } else {
    configuredProfile = validateProfileShape(profile, profile.maxOutputTokens)
  }

  const matrix = prevalidateRunSpecs(bundle, authorization ?? { maxOutputTokens: configuredProfile.maxOutputTokens }, configuredProfile)
  if (realMode) {
    try { checkMethod(startup, 'beginClaimOnceSync')(root, binding, claimPath, GENERATION_PURPOSE) }
    catch (error) { fail(staticErrorCode(error)) }
    let actualProfile
    try { actualProfile = await readProfile() } catch { fail('profile-unavailable') }
    configuredProfile = verifyGenerationProfileBinding(actualProfile, authorization)
  }

  await ensureDirectoryChain(outputPath.boundaryRoot, path.dirname(outputRoot))
  await mkdir(outputRoot, { mode: 0o700 })
  const outputStat = await lstat(outputRoot)
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) fail('output-path-invalid')
  const journalPath = path.join(outputRoot, 'progress.ndjson')
  const journalFd = openSync(journalPath, 'wx', 0o600)
  fsyncSync(journalFd); closeSync(journalFd)
  const scratchRootReal = await createPrivateScratch(scratchParent)
  const controller = new AbortController()
  let lastClock = -Infinity
  const monotonicNow = () => {
    const value = testHooks?.clock ? testHooks.clock() : performance.now()
    if (typeof value !== 'number' || !Number.isFinite(value) || value < lastClock) fail('execution-failed')
    lastClock = value
    return value
  }
  const scheduleTimer = testHooks?.setTimeout ?? setTimeout
  const cancelTimer = testHooks?.clearTimeout ?? clearTimeout
  const globalCollector = realMode
    ? createGlobalBudgetCollector({ maxRequests: authorization.maxRequests, maxInputTokens: authorization.maxInputTokens, maxOutputTokens: authorization.maxOutputTokensTotal })
    : createGlobalBudgetCollector({ maxRequests: budgets.matrix.maxRequests, maxInputTokens: budgets.matrix.maxInputTokens, maxOutputTokens: budgets.matrix.maxOutputTokensTotal })
  const results = []
  const sourceBindings = Object.create(null)
  const taskMap = new Map(bundle.tasks.map((task) => [task.id, task]))
  const projectMap = new Map(bundle.projects.map((project) => [project.id, project]))
  const evidenceMap = new Map(bundle.fixedEvidenceInputs.map((entry) => [entry.taskId, entry]))
  let stopped = false
  let cellOrder = 0
  let sourceStable = false

  try {
    for (let index = 0; index < matrix.length; index++) {
      const cell = { ...matrix[index], caseNumber: index + 1 }
      const task = taskMap.get(cell.taskId)
      const project = task && projectMap.get(task.projectId)
      const evidenceInput = evidenceMap.get(cell.taskId)
      if (!task || !project || !evidenceInput) { stopped = true; break }
      cellOrder++
      const cellStartedAt = monotonicNow()
      const cellDeadlineAt = cellStartedAt + MAX_CELL_WALL_CLOCK_MS
      let deadlineExpired = false
      const cellController = new AbortController()
      const abortCellFromRun = () => cellController.abort()
      controller.signal.addEventListener('abort', abortCellFromRun, { once: true })
      const cellTimer = scheduleTimer(() => {
        deadlineExpired = true
        cellController.abort()
      }, MAX_CELL_WALL_CLOCK_MS)
      const checkCellDeadline = () => {
        const elapsed = monotonicNow() - cellStartedAt
        if (deadlineExpired || elapsed >= MAX_CELL_WALL_CLOCK_MS) {
          deadlineExpired = true
          cellController.abort()
          throw new Error('timeout')
        }
        if (controller.signal.aborted) {
          cellController.abort()
          throw new Error('cancelled')
        }
        if (cellController.signal.aborted) throw new Error('cancelled')
        return Math.max(0, Math.floor(elapsed))
      }
      const cellStep = async (step) => {
        checkCellDeadline()
        await testHooks?.onCellStep?.({ caseNumber: cellOrder, step })
        return checkCellDeadline()
      }
      const caseDirectory = path.join(scratchRootReal, `case-${String(cellOrder).padStart(4, '0')}`)
      let scan, snapshot, store, ledger, adapter, acceptedQuestionCount = 0, usage
      const caseMeta = { id: cell.id, taskId: cell.taskId, strategy: cell.strategy, repeat: cell.repeat, actualOrder: cellOrder, granularity: cell.granularity }
      try {
        await cellStep('before-materialize')
        await mkdir(caseDirectory, { mode: 0o700 })
        const projectRoot = await materializeProject(project, caseDirectory, checkCellDeadline)
        await cellStep('after-materialize')
        scan = await scanProject(projectRoot)
        await cellStep('after-scan')
        snapshot = await createWorkflowSnapshot(scan, { projectId: task.projectId })
        await cellStep('after-snapshot')
        store = createEvidenceStore(snapshot)
        const spec = makeRunSpec(task, configuredProfile, snapshot.snapshotId, cell, GENERATION_REQUESTS_PER_RUN[task.granularity])
        ledger = createBudgetLedger(spec)
        const ids = await issueFrozenEvidence({ project, task, evidenceInput, snapshot, store, ledger, signal: cellController.signal, caseNumber: cellOrder, checkDeadline: checkCellDeadline })
        await cellStep('after-evidence')
        if (ids.length !== evidenceInput.evidence.length) fail('evidence-invalid')
        const topics = cell.strategy === 'agentic' ? [makeTopicCard(task, ids)] : []
        const writerVariant = cell.strategy === 'static-control' ? EVIDENCE_GENERATION_WRITER_VARIANTS.staticControl : EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards
        const cellRunId = `m08-case-${String(cellOrder).padStart(4, '0')}`
        const guardedTransport = createGuardedTransport({
          collector: globalCollector,
          runId: cellRunId,
          getReservation: () => ledger.snapshot().reservations.find((item) => item.state === 'reserved'),
          appendJournal: (event) => appendDurableJournal(journalPath, { atCell: cellOrder, ...event }),
          transport
        })
        adapter = await createEvidenceGenerationAdapter({
          spec,
          scan,
          snapshot,
          store,
          selection: { selectedIds: ids, requiredBundles: [{ id: `fixed-${String(cellOrder).padStart(4, '0')}`, evidenceIds: ids }], unresolved: [] },
          topics,
          ledger,
          profile: configuredProfile,
          signal: cellController.signal,
          transport: guardedTransport,
          writerVariant
        })
        await cellStep('after-adapter-prepare')
        const baseAdapter = adapter.requestAdapter
        const wrappedAdapter = Object.freeze({
          id: `${baseAdapter.id}-m08-public-goal-v1`,
          prepare: async (request) => {
            checkCellDeadline()
            const prepared = await baseAdapter.prepare({ ...request, buildMessages: (contextText) => makePublicTaskPrompt(request.buildMessages(contextText), task) })
            checkCellDeadline()
            return prepared
          },
          complete: async (prepared, onDelta, options) => {
            checkCellDeadline()
            const completion = await baseAdapter.complete(prepared, onDelta, options)
            checkCellDeadline()
            return completion
          },
          acceptQuestion: async (input) => {
            checkCellDeadline()
            await baseAdapter.acceptQuestion(input)
            checkCellDeadline()
            acceptedQuestionCount++
          }
        })
        await cellStep('before-generation')
        appendDurableJournal(journalPath, { type: 'cell-started', cell: caseMeta, evidenceCount: ids.length })
        const result = await generateInterview({
          scan,
          granularity: task.granularity,
          roleFocus: task.roleFocus,
          profile: configuredProfile,
          signal: cellController.signal,
          onProgress: (_step, _detail, percent) => {
            checkCellDeadline()
            appendDurableJournal(journalPath, { type: 'generation-progress', case: cellOrder, percent: Math.max(0, Math.min(100, Math.floor(percent))) })
          },
          contextProvider: adapter.contextProvider,
          requestAdapter: wrappedAdapter
        })
        await cellStep('after-generation')
        const sidecar = await adapter.finalize(result)
        await cellStep('after-finalize')
        const adapterMetadata = adapter.metadata()
        usage = outputUsageFromLedger(ledger, adapterMetadata, cell.id)
        const lineageValid = validateSidecarLineage(result, sidecar, usage.requests)
        if (!lineageValid || !usage.usageComplete || usage.requests.length < 1 || result.sections.flatMap((section) => section.questions).length !== sidecar.questions.length) fail(lineageValid ? 'budget-exhausted' : 'lineage-invalid')
        addSourceBindings(sourceBindings, usage.requests)
        const resultFile = `case-${String(cellOrder).padStart(4, '0')}.result.json`
        const sidecarFile = `case-${String(cellOrder).padStart(4, '0')}.sidecar.json`
        const metadataFile = `case-${String(cellOrder).padStart(4, '0')}.metadata.json`
        const sanitizedResult = { ...result, projectPath: 'source-fixture' }
        await writeExclusive(outputRoot, resultFile, { schemaVersion: 1, cell: caseMeta, result: sanitizedResult })
        await cellStep('after-result-write')
        await writeExclusive(outputRoot, sidecarFile, sidecar)
        await cellStep('after-sidecar-write')
        const metadata = { schemaVersion: 1, cell: caseMeta, requests: usage.requests, usage: { usageComplete: usage.usageComplete, knownActual: usage.knownActual, unknownReservations: usage.unknownReservations, conservativeCharged: usage.conservativeCharged } }
        await writeExclusive(outputRoot, metadataFile, metadata)
        await cellStep('after-metadata-write')
        const resultBytes = await readFile(path.join(outputRoot, resultFile))
        await cellStep('after-result-hash-read')
        const sidecarBytes = await readFile(path.join(outputRoot, sidecarFile))
        await cellStep('after-sidecar-hash-read')
        const metadataBytes = await readFile(path.join(outputRoot, metadataFile))
        await cellStep('after-metadata-hash-read')
        const artifactHashes = {
          result: sha(resultBytes),
          sidecar: sha(sidecarBytes),
          metadata: sha(metadataBytes)
        }
        await cellStep('after-artifact-hashes')
        const elapsedMs = checkCellDeadline()
        appendDurableJournal(journalPath, { type: 'cell-completed', case: cellOrder, requestCount: usage.requests.length, acceptedQuestionCount, elapsedMs, usageComplete: true, lineageValid: true })
        checkCellDeadline()
        results.push({
          ...cell,
          actualOrder: cellOrder,
          execution: {
            status: 'succeeded', acceptedQuestionCount, elapsedMs, usageComplete: usage.usageComplete, lineageValid,
            knownActual: usage.knownActual, unknownReservations: usage.unknownReservations, conservativeCharged: usage.conservativeCharged
          },
          requests: usage.requests,
          resultFile,
          sidecarFile,
          metadataFile,
          artifactHashes
        })
      } catch (error) {
        const elapsedMs = Math.max(0, Math.floor(monotonicNow() - cellStartedAt))
        const errorCode = deadlineExpired ? 'timeout' : stageFailure(error)
        const deadlineReason = deadlineExpired ? 'per-run-wall-clock' : undefined
        const modelFailure = sanitizeModelFailure(error?.modelFailure) ?? undefined
        try { usage = ledger ? outputUsageFromLedger(ledger, adapter?.metadata?.() ?? [], cell.id) : undefined } catch { usage = undefined }
        const failed = failedCellRecord(cell, cellOrder, errorCode, acceptedQuestionCount, usage, modelFailure, elapsedMs, deadlineReason)
        if (usage) {
          try { addSourceBindings(sourceBindings, usage.requests) } catch { failed.execution.lineageValid = false }
        }
        results.push(failed)
        appendDurableJournal(journalPath, { type: 'cell-failed', case: cellOrder, errorCode, acceptedQuestionCount, elapsedMs, ...(deadlineReason ? { deadlineReason } : {}), usageComplete: usage?.usageComplete ?? false })
        const metadataFile = `case-${String(cellOrder).padStart(4, '0')}.metadata.json`
        let failureMetadataFile = metadataFile
        try {
          await lstat(path.join(outputRoot, metadataFile))
          failureMetadataFile = `case-${String(cellOrder).padStart(4, '0')}.failure.json`
        } catch (error) { if (error?.code !== 'ENOENT') throw error }
        await writeExclusive(outputRoot, failureMetadataFile, { schemaVersion: 1, cell: caseMeta, execution: failed.execution, requests: failed.requests })
        failed.metadataFile = failureMetadataFile
        failed.artifactHashes = { metadata: sha(await readFile(path.join(outputRoot, failureMetadataFile))) }
        stopped = true
        controller.abort()
        break
      } finally {
        cancelTimer(cellTimer)
        controller.signal.removeEventListener('abort', abortCellFromRun)
      }
    }

    if (realMode) {
      try {
        const last = await checkGenerationAuthorizationArtifact({ repoRoot: root, authorizationPath })
        sourceStable = last.sourceCommit === authorizationRecord.sourceCommit && last.generationDataHash === bundle.generationDataHash
      } catch { sourceStable = false }
    } else {
      try { sourceStable = (await loadGenerationEvaluationBundle()).generationDataHash === bundle.generationDataHash } catch { sourceStable = false }
    }
    const usage = aggregateCellUsage(results)
    const allCells = results.length === matrix.length && results.every((cell) => cell.execution.status === 'succeeded' && cell.execution.usageComplete && cell.execution.lineageValid)
    const executionComplete = !stopped && allCells && sourceStable && !globalCollector.snapshot().blocked &&
      usage.unknownReservations.length === 0 && usage.conservativeCharged.requests <= (authorization?.maxRequests ?? budgets.matrix.maxRequests) &&
      usage.conservativeCharged.inputTokens <= (authorization?.maxInputTokens ?? budgets.matrix.maxInputTokens) &&
      usage.conservativeCharged.outputTokens <= (authorization?.maxOutputTokensTotal ?? budgets.matrix.maxOutputTokensTotal)
    const publicConfiguration = publicModel(configuredProfile)
    const journalBytes = await readFile(journalPath)
    const report = {
      schemaVersion: 1,
      mode,
      purpose: GENERATION_PURPOSE,
      status: executionComplete ? 'awaiting-review' : 'incomplete',
      reviewState: executionComplete ? GENERATION_REVIEW_PENDING : 'blocked',
      executionDir: '.',
      executionComplete,
      qualityGate: 'not-evaluated',
      sourceStable,
      sourceBinding: {
        sourceCommit: authorizationRecord?.sourceCommit ?? null,
        generationDataHash: bundle.generationDataHash,
        sourceHashes: bundle.sourceHashes
      },
      authorizationBinding: authorization ? {
        reference: authorization.reference,
        claimId: sha(Buffer.from(`${authorization.sourceCommit}\0${GENERATION_PURPOSE}\0${authorization.reference}`, 'utf8'))
      } : null,
      configurationBinding: publicConfiguration,
      configurationHash: sha(Buffer.from(canonicalJson(publicConfiguration), 'utf8')),
      budgets: authorization ? {
        maxRuns: authorization.maxRuns, maxRequests: authorization.maxRequests,
        maxInputTokens: authorization.maxInputTokens, maxOutputTokensTotal: authorization.maxOutputTokensTotal,
        maxOutputTokensPerRequest: authorization.maxOutputTokens
      } : budgets.matrix,
      matrix: results,
      sourceBindings,
      usage,
      journal: { file: 'progress.ndjson', sha256: sha(journalBytes), entries: journalBytes.toString('utf8').split('\n').filter(Boolean).length },
      globalCollector: globalCollector.snapshot()
    }
    if (executionComplete) {
      const validation = validateGenerationExecutionReport(report, bundle)
      if (!validation.valid || !validation.executionComplete) fail('lineage-invalid')
    }
    await writeExclusive(outputRoot, 'generation-evaluation.json', report)
    return report
  } finally {
    controller.abort()
    try {
      const stat = await lstat(scratchRootReal)
      const canonical = await realpath(scratchRootReal)
      if (stat.isDirectory() && !stat.isSymbolicLink() && within(path.resolve(os.tmpdir()), canonical) && path.basename(canonical).startsWith('m08-generation-')) {
        await rm(canonical, { recursive: true, force: true })
      }
    } catch { /* Keep cleanup failure separate from the execution result. */ }
  }
}

function aggregateCellUsage(cells) {
  const knownActual = { requests: 0, inputTokens: 0, outputTokens: 0 }
  const unknownReservations = []
  const conservativeCharged = { requests: 0, inputTokens: 0, outputTokens: 0 }
  for (const cell of cells) {
    const execution = cell.execution
    knownActual.requests += execution.knownActual.requests
    knownActual.inputTokens += execution.knownActual.inputTokens
    knownActual.outputTokens += execution.knownActual.outputTokens
    conservativeCharged.requests += execution.conservativeCharged.requests
    conservativeCharged.inputTokens += execution.conservativeCharged.inputTokens
    conservativeCharged.outputTokens += execution.conservativeCharged.outputTokens
    for (const reservation of execution.unknownReservations) unknownReservations.push({ cellId: cell.id, ...reservation })
  }
  return { knownActual, unknownReservations, conservativeCharged }
}

