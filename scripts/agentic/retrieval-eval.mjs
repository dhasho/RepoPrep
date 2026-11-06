import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDatasetBundle, validateDatasetBundle, hashEvidenceRange, sha256, canonicalJson } from './dataset-contract.mjs'
import { scanProject } from '../../electron/services/scanner.ts'
import { createWorkflowSnapshot } from '../../electron/services/workflow/snapshot-adapter.ts'
import { createEvidenceStore } from '../../electron/services/workflow/evidence-store.ts'
import { createToolGateway } from '../../electron/services/workflow/tool-gateway.ts'
import { createBudgetLedger } from '../../electron/services/workflow/budget-ledger.ts'
import { createModelGateway } from '../../electron/services/workflow/model-gateway.ts'
import { createRunSpec } from '../../electron/services/workflow/run-spec.ts'
import { runInvestigation } from '../../electron/services/workflow/investigation-controller.ts'
import { normalizeBaseUrl } from '../../electron/services/llm.ts'

export const RETRIEVAL_PURPOSE = 'm06-retrieval-v1'
export const RETRIEVAL_LIMITS = Object.freeze({ runs: 40, requests: 120, inputTokens: 720_000, outputTokens: 240_000, perRequestOutputTokens: 2000, repeats: 0.2, completeRate: 0.9 })
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(HERE, 'datasets', 'v1')
const DATA_NAMES = ['projects.json', 'retrieval-tasks.json', 'retrieval-labels.json']
const HASH = /^[a-f0-9]{64}$/u
const safe = (condition, code = 'authorization-invalid') => { if (!condition) throw new Error(code) }
const endpointHash = (baseUrl) => createHash('sha256').update(normalizeBaseUrl(baseUrl)).digest('hex')

export async function hashRetrievalData(directory = DATA_DIR) {
  const hashes = {}
  for (const name of DATA_NAMES) hashes[name] = sha256(await readFile(path.join(directory, name)))
  return sha256(Buffer.from(canonicalJson(hashes)))
}

function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
export function getCleanSourceBinding(root) {
  const commit = git(root, ['rev-parse', 'HEAD'])
  safe(/^[a-f0-9]{40}$/u.test(commit), 'source-binding-invalid')
  safe(git(root, ['status', '--porcelain', '--untracked-files=all']) === '', 'source-tree-dirty')
  return commit
}

function validateAuthorization(auth, { sourceCommit, dataHash }) {
  safe(auth && typeof auth === 'object' && !Array.isArray(auth), 'authorization-invalid')
  const keys = ['purpose', 'reference', 'sourceCommit', 'retrievalDataHash', 'endpointFingerprint', 'model', 'protocol', 'temperature', 'reasoningEffort', 'contextWindowTokens', 'maxOutputTokens', 'maxRuns', 'maxRequests', 'maxInputTokens', 'maxOutputTokensTotal']
  safe(Object.keys(auth).length === keys.length && Object.keys(auth).every(key => keys.includes(key)), 'authorization-invalid')
  safe(auth.purpose === RETRIEVAL_PURPOSE && typeof auth.reference === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/u.test(auth.reference), 'authorization-invalid')
  safe(auth.sourceCommit === sourceCommit && auth.retrievalDataHash === dataHash, 'authorization-binding-mismatch')
  safe(HASH.test(auth.endpointFingerprint ?? ''), 'authorization-invalid')
  safe(typeof auth.model === 'string' && auth.model.length > 0 && auth.model.length <= 160, 'authorization-invalid')
  safe(['openai', 'anthropic'].includes(auth.protocol), 'authorization-invalid')
  safe(auth.temperature === 0.4 && (auth.reasoningEffort === null || ['low', 'high'].includes(auth.reasoningEffort)), 'authorization-invalid')
  safe(Number.isSafeInteger(auth.contextWindowTokens) && auth.contextWindowTokens >= 4096, 'authorization-invalid')
  safe(auth.maxOutputTokens === RETRIEVAL_LIMITS.perRequestOutputTokens, 'authorization-invalid')
  safe(auth.maxRuns === RETRIEVAL_LIMITS.runs && Number.isSafeInteger(auth.maxRequests) && auth.maxRequests > 0 && auth.maxRequests <= RETRIEVAL_LIMITS.requests, 'authorization-invalid')
  safe(Number.isSafeInteger(auth.maxInputTokens) && auth.maxInputTokens > 0 && auth.maxInputTokens <= RETRIEVAL_LIMITS.inputTokens, 'authorization-invalid')
  safe(Number.isSafeInteger(auth.maxOutputTokensTotal) && auth.maxOutputTokensTotal > 0 && auth.maxOutputTokensTotal <= RETRIEVAL_LIMITS.outputTokens, 'authorization-invalid')
  return auth
}

export async function checkAuthorizationArtifact({ repoRoot, authorizationPath }) {
  safe(typeof authorizationPath === 'string' && authorizationPath.length > 0, 'authorization-required')
  const root = await realpath(repoRoot)
  const sourceCommit = getCleanSourceBinding(root)
  const retrievalDataHash = await hashRetrievalData(path.join(root, 'scripts/agentic/datasets/v1'))
  const stat = await lstat(authorizationPath)
  safe(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024, 'authorization-invalid')
  const authorization = validateAuthorization(JSON.parse(await readFile(authorizationPath, 'utf8')), { sourceCommit, dataHash: retrievalDataHash })
  return { sourceCommit, retrievalDataHash, reference: authorization.reference }
}

export function verifyProfileBinding(profile, auth) {
  safe(profile && typeof profile === 'object' && typeof profile.apiKey === 'string' && profile.apiKey.length > 0, 'profile-unavailable')
  const clone = { ...profile, maxOutputTokens: RETRIEVAL_LIMITS.perRequestOutputTokens }
  safe(endpointHash(clone.baseUrl) === auth.endpointFingerprint && clone.model === auth.model, 'profile-binding-mismatch')
  safe((clone.protocol ?? 'openai') === auth.protocol && (clone.temperature ?? 0.4) === auth.temperature, 'profile-binding-mismatch')
  safe((clone.reasoningEffort ?? null) === auth.reasoningEffort && clone.contextWindowTokens === auth.contextWindowTokens, 'profile-binding-mismatch')
  safe(clone.protocol !== 'anthropic', 'profile-binding-mismatch')
  return clone
}

function filesOnlyProject(project) {
  return { id: project.id, language: project.language, files: project.files.map(({ path: relPath, content, sha256: fileHash }) => ({ path: relPath, content, sha256: fileHash })) }
}

async function materializeProject(project, parent) {
  const root = path.join(parent, `fixture-${project.id}`)
  await mkdir(root, { recursive: false })
  const rootReal = await realpath(root)
  for (const file of project.files) {
    const absolute = path.resolve(root, ...file.path.split('/'))
    const rel = path.relative(rootReal, absolute)
    safe(rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), 'fixture-path-invalid')
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, file.content, { flag: 'wx' })
    safe(sha256(await readFile(absolute)) === file.sha256, 'fixture-hash-mismatch')
  }
  return root
}

function runSpec(task, profile, snapshot, runId) {
  const model = {
    profileId: profile.id,
    endpointFingerprint: endpointHash(profile.baseUrl),
    model: profile.model,
    protocol: profile.protocol ?? 'openai',
    temperature: profile.temperature ?? 0.4,
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: RETRIEVAL_LIMITS.perRequestOutputTokens,
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {})
  }
  return createRunSpec({
    version: 1, runId, projectId: snapshot.projectId, snapshotId: snapshot.snapshotId,
    strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: task.roleFocus, granularity: task.granularity,
    model, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1',
    budget: { maxModelRequests: task.granularity === 'fine' ? 14 : 5, inputTokens: 18_000, outputTokens: 6_000, readBytes: 2 * 1024 * 1024, wallClockMs: 180_000 }
  })
}

function rangeMetadata(record) {
  return { id: record.id, path: record.relPath, startLine: record.originalRange?.startLine ?? null, endLine: record.originalRange?.endLine ?? null, contentHash: record.contentHash, sourceKind: record.sourceKind, readStatus: record.readStatus, omission: record.omission }
}

function coversRequirement(requirement, selected, project) {
  const source = project.files.find(file => file.path === requirement.path)?.content
  if (typeof source !== 'string' || hashEvidenceRange(source, requirement.startLine, requirement.endLine) !== requirement.sha256) return false
  const ranges = selected.filter(record => record.path === requirement.path && Number.isInteger(record.startLine) && Number.isInteger(record.endLine) && record.readStatus === 'complete' && record.omission === 'none' && record.contentHash === hashEvidenceRange(source, record.startLine, record.endLine))
    .map(record => [record.startLine, record.endLine]).sort((a, b) => a[0] - b[0])
  let cursor = requirement.startLine
  for (const [start, end] of ranges) {
    if (end < cursor) continue
    if (start > cursor) return false
    cursor = end + 1
    if (cursor > requirement.endLine) return true
  }
  return false
}

function validEvidenceMetadata(item, project) {
  if (!/^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item?.id ?? '') || !['code', 'documentation', 'configuration', 'other'].includes(item?.sourceKind) || item?.readStatus !== 'complete' || item?.omission !== 'none') return false
  const source = project.files.find(file => file.path === item.path)?.content
  return typeof source === 'string' && Number.isSafeInteger(item.startLine) && Number.isSafeInteger(item.endLine) && item.startLine >= 1 && item.endLine >= item.startLine && item.endLine <= source.split('\n').length && HASH.test(item.contentHash ?? '') && item.contentHash === hashEvidenceRange(source, item.startLine, item.endLine)
}

export function recomputeRetrievalMetrics(report, bundle) {
  const labels = new Map(bundle.retrievalLabels.labels.map(label => [label.taskId, label]))
  const tasks = new Map(bundle.retrievalTasks.tasks.map(task => [task.id, task]))
  const projects = new Map(bundle.projects.projects.map(project => [project.id, project]))
  const cells = Array.isArray(report?.runs) ? report.runs : []
  const unique = new Set(cells.map(cell => `${cell.taskId}:${cell.repeat}`))
  const expectedCells = new Set(bundle.retrievalTasks.tasks.flatMap(task => [1, 2].map(repeat => `${task.id}:${repeat}`)))
  let complete = 0, readRequests = 0, repeatedReads = 0, invalid = 0, limitViolations = 0, totalRequests = 0, totalInputTokens = 0, totalOutputTokens = 0
  let usageComplete = true
  if (cells.length !== expectedCells.size || unique.size !== expectedCells.size || [...expectedCells].some(key => !unique.has(key)) || [...unique].some(key => !expectedCells.has(key))) limitViolations++
  for (const cell of cells) {
    const task = tasks.get(cell.taskId), project = task && projects.get(task.projectId), label = labels.get(cell.taskId)
    if (!task || !project || !label || !Array.isArray(cell.selectedEvidence) || !Array.isArray(cell.retrievedEvidence) || !cell.receipt || !cell.receipt.usageComplete) { usageComplete = false; continue }
    if (!report?.provider || cell.runConfigFingerprint !== evaluationRunConfigFingerprint(task, report.provider)) limitViolations++
    const reservations = cell.receipt.reservations
    const validReceipts = Array.isArray(reservations) && reservations.length === cell.receipt.requests && reservations.every(item => item.stage === 'investigation' && item.state === 'settled' && item.usage && Number.isSafeInteger(item.usage.inputTokens) && item.usage.inputTokens >= 0 && Number.isSafeInteger(item.usage.outputTokens) && item.usage.outputTokens >= 0 && item.usage.totalTokens === item.usage.inputTokens + item.usage.outputTokens)
    if (!validReceipts || reservations.reduce((sum, item) => sum + item.usage.inputTokens, 0) !== cell.receipt.inputTokens || reservations.reduce((sum, item) => sum + item.usage.outputTokens, 0) !== cell.receipt.outputTokens) usageComplete = false
    if (!Number.isSafeInteger(cell.receipt.readRequests) || cell.receipt.readRequests < 0 || !cell.receipt.overspend || Object.values(cell.receipt.overspend).some(value => value !== 0) || cell.receipt.blocked === true) usageComplete = false
    const selectedIds = new Set(cell.selectedEvidence.map(item => item.id))
    const retrievedIds = new Set(cell.retrievedEvidence.map(item => item.id))
    const allRetrievedValid = retrievedIds.size === cell.retrievedEvidence.length && cell.retrievedEvidence.every(item => validEvidenceMetadata(item, project))
    const allSelectedValid = selectedIds.size === cell.selectedEvidence.length && cell.selectedEvidence.every(item => validEvidenceMetadata(item, project) && retrievedIds.has(item.id))
    if (!allRetrievedValid || !allSelectedValid) invalid++
    if (!Number.isSafeInteger(cell.receipt.invalidToolExecutions) || cell.receipt.invalidToolExecutions < 0) invalid++
    else invalid += cell.receipt.invalidToolExecutions
    if (!Number.isSafeInteger(cell.receipt.readRequests) || cell.receipt.readRequests < 0 || !Number.isSafeInteger(cell.receipt.repeatedReads) || cell.receipt.repeatedReads < 0) limitViolations++
    readRequests += Number.isSafeInteger(cell.receipt.readRequests) && cell.receipt.readRequests >= 0 ? cell.receipt.readRequests : 0
    repeatedReads += Number.isSafeInteger(cell.receipt.repeatedReads) && cell.receipt.repeatedReads >= 0 ? cell.receipt.repeatedReads : 0
    const requestCount = cell.receipt.requests
    totalRequests += Number.isSafeInteger(requestCount) ? requestCount : 0
    totalInputTokens += Number.isSafeInteger(cell.receipt.inputTokens) ? cell.receipt.inputTokens : 0
    totalOutputTokens += Number.isSafeInteger(cell.receipt.outputTokens) ? cell.receipt.outputTokens : 0
    if (!Number.isSafeInteger(requestCount) || requestCount > 3 || cell.receipt.inputTokens > 18_000 || cell.receipt.outputTokens > 6_000 || cell.receipt.readBytes > 2 * 1024 * 1024 || cell.receipt.elapsedMs > 180_000 || reservations.some(item => item.usage.outputTokens > RETRIEVAL_LIMITS.perRequestOutputTokens)) limitViolations++
    const completeTask = label.requiredEvidenceGroups.every(group => group.allOf.every(ref => coversRequirement(ref, cell.selectedEvidence, project)))
    if (allSelectedValid && completeTask) complete++
  }
  const completeRate = cells.length ? complete / cells.length : 0
  const repeatedReadRate = readRequests ? repeatedReads / readRequests : (repeatedReads ? 1 : 0)
  if (totalRequests > RETRIEVAL_LIMITS.requests || totalInputTokens > RETRIEVAL_LIMITS.inputTokens || totalOutputTokens > RETRIEVAL_LIMITS.outputTokens) limitViolations++
  return { runCount: cells.length, uniqueCells: unique.size, completeEvidenceTaskRate: completeRate, invalidToolExecution: invalid, repeatedReadRate, limitViolations, usageComplete, requests: totalRequests, inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
}

export function verifyRetrievalReport(report, bundle, expected = {}) {
  const issues = []
  if (!report || report.schemaVersion !== 1 || report.mode !== 'real') issues.push('report-not-real')
  if (!bundle || validateDatasetBundle(bundle).valid !== true) issues.push('dataset-invalid')
  if (!Array.isArray(report?.runs) || report.runs.length !== 40) issues.push('run-matrix-incomplete')
  const metrics = bundle ? recomputeRetrievalMetrics(report, bundle) : null
  if (metrics && (metrics.uniqueCells !== 40 || metrics.runCount !== 40)) issues.push('run-matrix-duplicate')
  if (metrics && metrics.completeEvidenceTaskRate < RETRIEVAL_LIMITS.completeRate) issues.push('evidence-coverage-below-threshold')
  if (metrics && metrics.invalidToolExecution !== 0) issues.push('invalid-tool-execution')
  if (metrics && metrics.repeatedReadRate > RETRIEVAL_LIMITS.repeats) issues.push('repeated-read-rate-above-threshold')
  if (metrics && (metrics.limitViolations !== 0 || !metrics.usageComplete)) issues.push('receipt-or-limit-invalid')
  if (!report?.provider || !HASH.test(report.provider.endpointFingerprint ?? '') || typeof report.provider.model !== 'string' || report.provider.protocol !== 'openai' || report.provider.temperature !== 0.4 || ![null, 'low', 'high'].includes(report.provider.reasoningEffort) || !Number.isSafeInteger(report.provider.contextWindowTokens) || report.provider.contextWindowTokens < 4096 || report.provider.maxOutputTokensPerRequest !== RETRIEVAL_LIMITS.perRequestOutputTokens) issues.push('provider-binding-invalid')
  else if (report.configurationFingerprint !== evaluationConfigFingerprint(report.provider)) issues.push('configuration-binding-invalid')
  if (expected.provider && report?.provider && ['endpointFingerprint', 'model', 'protocol', 'temperature', 'reasoningEffort', 'contextWindowTokens'].some(key => report.provider[key] !== expected.provider[key])) issues.push('provider-authorization-mismatch')
  if (expected.sourceCommit && report?.sourceCommit !== expected.sourceCommit) issues.push('source-binding-mismatch')
  if (expected.retrievalDataHash && report?.retrievalDataHash !== expected.retrievalDataHash) issues.push('dataset-binding-mismatch')
  if (expected.configurationFingerprint && report?.configurationFingerprint !== expected.configurationFingerprint) issues.push('configuration-binding-mismatch')
  if (metrics && (metrics.requests > (expected.maxRequests ?? RETRIEVAL_LIMITS.requests) || metrics.inputTokens > (expected.maxInputTokens ?? RETRIEVAL_LIMITS.inputTokens) || metrics.outputTokens > (expected.maxOutputTokens ?? RETRIEVAL_LIMITS.outputTokens))) issues.push('authorization-budget-exceeded')
  if (report?.sourceStable !== true) issues.push('source-changed-during-run')
  return { valid: issues.length === 0, issues, metrics }
}

export function evaluationConfigFingerprint(provider) {
  return sha256(Buffer.from(canonicalJson({ purpose: RETRIEVAL_PURPOSE, provider: { endpointFingerprint: provider.endpointFingerprint, model: provider.model, protocol: provider.protocol, temperature: provider.temperature, reasoningEffort: provider.reasoningEffort, contextWindowTokens: provider.contextWindowTokens, maxOutputTokensPerRequest: provider.maxOutputTokensPerRequest }, limits: RETRIEVAL_LIMITS, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })))
}

export function evaluationRunConfigFingerprint(task, provider) {
  return sha256(Buffer.from(canonicalJson({
    globalConfiguration: evaluationConfigFingerprint(provider), task: { roleFocus: task.roleFocus, granularity: task.granularity },
    budget: { maxModelRequests: task.granularity === 'fine' ? 14 : 5, inputTokens: 18_000, outputTokens: 6_000, readBytes: 2 * 1024 * 1024, wallClockMs: 180_000 }
  })))
}

function nonSecretError(error) {
  const code = typeof error?.code === 'string' && /^[a-z-]{1,48}$/u.test(error.code) ? error.code : 'run-failed'
  return { code }
}

export async function runRetrievalEvaluation({ repoRoot = path.resolve(HERE, '../..'), outputDir, profile, authorizationPath, transport, mode = 'real' } = {}) {
  safe(mode === 'real' && !transport, 'real-mode-transport-forbidden')
  safe(typeof outputDir === 'string' && outputDir.length > 0 && typeof authorizationPath === 'string' && authorizationPath.length > 0, 'authorization-required')
  const root = await realpath(repoRoot)
  const sourceCommit = getCleanSourceBinding(root)
  const retrievalDataHash = await hashRetrievalData(path.join(root, 'scripts/agentic/datasets/v1'))
  const authStat = await lstat(authorizationPath)
  safe(authStat.isFile() && !authStat.isSymbolicLink() && authStat.size <= 16 * 1024, 'authorization-invalid')
  const auth = validateAuthorization(JSON.parse(await readFile(authorizationPath, 'utf8')), { sourceCommit, dataHash: retrievalDataHash })
  const boundProfile = verifyProfileBinding(profile, auth)
  const bundle = await loadDatasetBundle(path.join(root, 'scripts/agentic/datasets/v1'))
  safe(validateDatasetBundle(bundle).valid, 'dataset-invalid')
  const projectById = new Map(bundle.projects.projects.map(project => [project.id, project]))
  const labels = new Map(bundle.retrievalLabels.labels.map(label => [label.taskId, label]))
  const provider = { endpointFingerprint: auth.endpointFingerprint, model: auth.model, protocol: auth.protocol, temperature: auth.temperature, reasoningEffort: auth.reasoningEffort, contextWindowTokens: auth.contextWindowTokens, maxOutputTokensPerRequest: RETRIEVAL_LIMITS.perRequestOutputTokens }
  const outputRoot = path.resolve(outputDir)
  const localOutputRoot = path.resolve(root, '.validation', 'agentic')
  const relativeOutput = path.relative(localOutputRoot, outputRoot)
  safe(relativeOutput !== '' && relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput), 'output-path-invalid')
  let outputCursor = root
  for (const component of path.relative(root, path.dirname(outputRoot)).split(path.sep).filter(Boolean)) {
    outputCursor = path.join(outputCursor, component)
    const componentStat = await lstat(outputCursor)
    safe(componentStat.isDirectory() && !componentStat.isSymbolicLink(), 'output-path-invalid')
  }
  const outStat = await lstat(path.dirname(outputRoot))
  safe(outStat.isDirectory() && !outStat.isSymbolicLink(), 'output-parent-invalid')
  await mkdir(outputRoot, { recursive: false })
  const temp = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'repoprep-m06-projects-')))
  const runs = []
  let admittedRequests = 0, admittedInput = 0, admittedOutput = 0, actualInput = 0, actualOutput = 0, stopped = false
  try {
    const projectRoots = new Map()
    for (const project of bundle.projects.projects) projectRoots.set(project.id, await materializeProject(filesOnlyProject(project), temp))
    for (const task of bundle.retrievalTasks.tasks) {
      for (const repeat of [1, 2]) {
        if (stopped) break
        const project = projectById.get(task.projectId)
        const projectRoot = projectRoots.get(task.projectId)
        let ledger, snapshot, store, result, errorCode = null
        const events = []
        try {
          const scan = await scanProject(projectRoot)
          snapshot = await createWorkflowSnapshot(scan, { projectId: task.projectId })
          store = createEvidenceStore(snapshot)
          const spec = runSpec(task, boundProfile, snapshot, `${task.id}-r${repeat}`)
          ledger = createBudgetLedger(spec)
          const gateway = createModelGateway(spec, boundProfile, ledger, { transport: async (selectedProfile, messages, onDelta, options) => {
            const reservation = ledger.snapshot().reservations.find(item => item.state === 'reserved' && item.stage === 'investigation')
            if (admittedRequests + 1 > auth.maxRequests || Math.max(admittedInput, actualInput) + (reservation?.inputTokens ?? 0) > auth.maxInputTokens || Math.max(admittedOutput, actualOutput) + (reservation?.outputTokens ?? 0) > auth.maxOutputTokensTotal) throw new Error('global-budget-exhausted')
            options.beforeRequest()
            admittedRequests++
            admittedInput += reservation?.inputTokens ?? 0
            admittedOutput += reservation?.outputTokens ?? 0
            const { chatCompletionStream } = await import('../../electron/services/llm.ts')
            return chatCompletionStream(selectedProfile, messages, onDelta, options)
          } })
          const toolGateway = createToolGateway(snapshot, store, ledger)
          result = await runInvestigation({ spec, snapshot, store, tools: toolGateway, ledger, model: gateway, objective: task.objective, onEvent: event => events.push({ type: event.type, ...(event.hash ? { hash: event.hash } : {}), ...(event.reason ? { reason: event.reason } : {}) }) })
        } catch (error) { errorCode = nonSecretError(error).code }
        const selectedEvidence = []
        const retrievedEvidence = []
        if (result && store && snapshot) {
          try {
            const retrieved = await store.resolve(store.metadata().ids, snapshot.snapshotId)
            retrievedEvidence.push(...retrieved.map(rangeMetadata))
            const resolved = await store.resolve(result.selection.selectedIds, snapshot.snapshotId)
            selectedEvidence.push(...resolved.map(rangeMetadata))
          } catch { errorCode = errorCode || 'evidence-resolution-failed' }
        }
        const state = ledger?.snapshot()
        actualInput += state?.total.actualProviderUsage?.inputTokens ?? 0
        actualOutput += state?.total.actualProviderUsage?.outputTokens ?? 0
        const receipt = state ? {
          requests: state.total.dispatchedRequests,
          inputTokens: state.total.actualProviderUsage?.inputTokens ?? state.total.inputTokens,
          outputTokens: state.total.actualProviderUsage?.outputTokens ?? state.total.outputTokens,
          usageComplete: state.usageComplete && state.total.actualProviderUsage !== null,
          readBytes: state.total.readBytes,
          elapsedMs: state.elapsedMs,
          readRequests: Number.isSafeInteger(result?.statistics?.readRequests) ? result.statistics.readRequests : null,
          repeatedReads: result?.statistics?.repeatedReads ?? 0,
          invalidToolExecutions: result?.statistics?.invalidToolExecutions ?? 0,
          overspend: state.overspend,
          blocked: state.blocked,
          reservations: state.reservations.map(({ id, stage, state: entryState, usage }) => ({ id, stage, state: entryState, usage }))
        } : { requests: 0, inputTokens: 0, outputTokens: 0, usageComplete: false, readBytes: 0, elapsedMs: 0, readRequests: null, repeatedReads: 0, invalidToolExecutions: 0, overspend: null, blocked: true, reservations: [] }
        const selectionComplete = result?.status === 'completed' && labels.get(task.id).requiredEvidenceGroups.every(group => group.allOf.every(ref => coversRequirement(ref, selectedEvidence, project)))
        const runRecord = {
          taskId: task.id, repeat, status: errorCode ? 'failed' : (result?.status ?? 'failed'),
          stopReason: result?.stopReason ?? errorCode ?? 'run-incomplete',
          events,
          retrievedEvidence, retrievedCount: retrievedEvidence.length,
          selectedEvidence, selectedCount: selectedEvidence.length, completeEvidenceTask: selectionComplete,
          runConfigFingerprint: evaluationRunConfigFingerprint(task, provider),
          receipt
        }
        runs.push(runRecord)
        if (errorCode || !receipt.usageComplete || receipt.blocked || Object.values(receipt.overspend ?? {}).some(value => value !== 0) || receipt.requests > 3 || receipt.inputTokens > 18_000 || receipt.outputTokens > 6_000 || receipt.readBytes > 2 * 1024 * 1024 || receipt.elapsedMs > 180_000 || admittedRequests >= auth.maxRequests || admittedInput > auth.maxInputTokens || admittedOutput > auth.maxOutputTokensTotal || actualInput > auth.maxInputTokens || actualOutput > auth.maxOutputTokensTotal) stopped = true
      }
      if (stopped) break
    }
    let sourceStable = false
    try { sourceStable = getCleanSourceBinding(root) === sourceCommit && await hashRetrievalData(path.join(root, 'scripts/agentic/datasets/v1')) === retrievalDataHash } catch { sourceStable = false }
    const report = {
      schemaVersion: 1, mode: 'real', purpose: RETRIEVAL_PURPOSE, authorizationReference: auth.reference,
      sourceCommit, retrievalDataHash, sourceStable, configurationFingerprint: evaluationConfigFingerprint(provider), provider,
      runs
    }
    report.metrics = recomputeRetrievalMetrics(report, bundle)
    report.verification = verifyRetrievalReport(report, bundle, { sourceCommit, retrievalDataHash, maxRequests: auth.maxRequests, maxInputTokens: auth.maxInputTokens, maxOutputTokens: auth.maxOutputTokensTotal, provider: auth })
    await writeFile(path.join(outputRoot, 'retrieval-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    return report
  } finally { await rm(temp, { recursive: true, force: true }) }
}
