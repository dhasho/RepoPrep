import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashEvidenceRange, sha256, canonicalJson } from './dataset-contract.mjs'
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
const RETRIEVAL_TAGS = ['Python', 'JavaScript', 'TypeScript', 'cross-file', 'inheritance-callback', 'conditions-exceptions', 'config-vs-behavior', 'index-failure']
const HASH = /^[a-f0-9]{64}$/u
const safe = (condition, code = 'authorization-invalid') => { if (!condition) throw new Error(code) }
const endpointHash = (baseUrl) => createHash('sha256').update(normalizeBaseUrl(baseUrl)).digest('hex')

export async function hashRetrievalData(directory = DATA_DIR) {
  const hashes = {}
  for (const name of DATA_NAMES) hashes[name] = sha256(await readFile(path.join(directory, name)))
  return sha256(Buffer.from(canonicalJson(hashes)))
}

export async function loadRetrievalBundle(directory = DATA_DIR) {
  const root = await realpath(directory)
  const rootStat = await lstat(directory)
  safe(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'dataset-unavailable')
  const documents = {}
  for (const [key, name] of [['projects', DATA_NAMES[0]], ['retrievalTasks', DATA_NAMES[1]], ['retrievalLabels', DATA_NAMES[2]]]) {
    const filename = path.join(root, name)
    const stat = await lstat(filename)
    safe(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, 'dataset-unavailable')
    documents[key] = JSON.parse(await readFile(filename, 'utf8'))
  }
  return documents
}

export function validateRetrievalBundle(bundle) {
  const issues = []
  const add = (condition, message) => { if (condition) issues.push(message) }
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
  const hashPattern = /^[a-f0-9]{64}$/u
  const projects = bundle?.projects?.projects, tasks = bundle?.retrievalTasks?.tasks, labels = bundle?.retrievalLabels?.labels
  add(!exact(bundle?.projects, ['schemaVersion', 'split', 'projects']) || bundle.projects.schemaVersion !== 1 || bundle.projects.split !== 'development-synthetic' || !Array.isArray(projects), 'projects-document-invalid')
  add(!exact(bundle?.retrievalTasks, ['schemaVersion', 'tasks']) || bundle.retrievalTasks.schemaVersion !== 1 || !Array.isArray(tasks), 'retrieval-tasks-document-invalid')
  add(!exact(bundle?.retrievalLabels, ['schemaVersion', 'labels']) || bundle.retrievalLabels.schemaVersion !== 1 || !Array.isArray(labels), 'retrieval-labels-document-invalid')
  if (!Array.isArray(projects) || !Array.isArray(tasks) || !Array.isArray(labels)) return { valid: false, issues }
  add(tasks.length !== 20 || labels.length !== 20 || projects.length === 0, 'retrieval-dataset-count-invalid')
  const projectMap = new Map()
  const languages = new Set(['Python', 'JavaScript', 'TypeScript'])
  for (const project of projects) {
    if (!exact(project, ['id', 'language', 'sourceKind', 'files', 'contentSha256']) || typeof project.id !== 'string' || !project.id || !languages.has(project.language) || project.sourceKind !== 'authored-fixture' || !Array.isArray(project.files) || !project.files.length) { issues.push('project-invalid'); continue }
    if (projectMap.has(project.id)) issues.push('project-id-duplicate')
    projectMap.set(project.id, project)
    const seenPaths = new Set()
    for (const file of project.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) { issues.push('project-file-invalid'); continue }
      const safePath = typeof file?.path === 'string' && file.path.length > 0 && !file.path.includes('\\') && !file.path.includes('\0') && !file.path.includes(':') && !file.path.startsWith('/') && file.path.split('/').every(part => part && part !== '.' && part !== '..')
      if (!exact(file, ['path', 'content', 'sha256']) || !safePath || typeof file.content !== 'string' || file.content.includes('\r') || !hashPattern.test(file.sha256 ?? '') || sha256(Buffer.from(file.content, 'utf8')) !== file.sha256 || seenPaths.has(file.path)) issues.push('project-file-invalid')
      seenPaths.add(file.path)
    }
    if (project.files.every(file => file && typeof file.path === 'string' && typeof file.sha256 === 'string')) {
      const summary = { id: project.id, language: project.language, files: project.files.map(({ path: filePath, sha256: fileHash }) => ({ path: filePath, sha256: fileHash })) }
      if (!hashPattern.test(project.contentSha256 ?? '') || sha256(Buffer.from(canonicalJson(summary), 'utf8')) !== project.contentSha256) issues.push('project-content-hash-invalid')
    } else issues.push('project-content-hash-invalid')
  }
  const taskMap = new Map(), objectives = new Set(), coverage = Object.fromEntries(RETRIEVAL_TAGS.map(tag => [tag, 0]))
  for (const task of tasks) {
    if (!exact(task, ['id', 'projectId', 'objective', 'roleFocus', 'granularity', 'tags', 'indexMode']) || typeof task.id !== 'string' || !task.id || !projectMap.has(task.projectId) || typeof task.objective !== 'string' || !task.objective.trim() || !['general', 'frontend', 'backend', 'algorithm'].includes(task.roleFocus) || !['coarse', 'medium', 'fine'].includes(task.granularity) || !Array.isArray(task.tags) || !['normal', 'unavailable'].includes(task.indexMode)) { issues.push('retrieval-task-invalid'); continue }
    if (taskMap.has(task.id) || objectives.has(task.objective)) issues.push('retrieval-task-duplicate')
    taskMap.set(task.id, task); objectives.add(task.objective)
    for (const tag of RETRIEVAL_TAGS) if (task.tags.includes(tag)) coverage[tag]++
    if (new Set(task.tags).size !== task.tags.length || task.tags.some(tag => typeof tag !== 'string')) issues.push('retrieval-task-tags-invalid')
    if (task.tags.includes('index-failure') !== (task.indexMode === 'unavailable')) issues.push('retrieval-index-condition-invalid')
  }
  for (const tag of RETRIEVAL_TAGS) if (coverage[tag] < 2) issues.push('retrieval-tag-coverage-invalid')
  const labelMap = new Map()
  for (const label of labels) {
    if (!exact(label, ['taskId', 'requiredEvidenceGroups', 'notes']) || !taskMap.has(label.taskId) || !Array.isArray(label.requiredEvidenceGroups) || label.requiredEvidenceGroups.length === 0 || typeof label.notes !== 'string') { issues.push('retrieval-label-invalid'); continue }
    if (labelMap.has(label.taskId)) issues.push('retrieval-label-duplicate')
    labelMap.set(label.taskId, label)
    const task = taskMap.get(label.taskId), project = projectMap.get(task.projectId), groupIds = new Set()
    for (const group of label.requiredEvidenceGroups) {
      if (!exact(group, ['id', 'allOf']) || typeof group.id !== 'string' || !group.id || groupIds.has(group.id) || !Array.isArray(group.allOf) || group.allOf.length === 0) { issues.push('retrieval-evidence-group-invalid'); continue }
      groupIds.add(group.id)
      const rangeIds = new Set()
      for (const ref of group.allOf) {
        const file = project.files.find(item => item.path === ref?.path)
        const rangeKey = `${ref?.path}:${ref?.startLine}-${ref?.endLine}`
        if (!exact(ref, ['path', 'startLine', 'endLine', 'sha256']) || !file || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine || ref.endLine > file.content.split('\n').length || !hashPattern.test(ref.sha256 ?? '') || hashEvidenceRange(file.content, ref.startLine, ref.endLine) !== ref.sha256 || rangeIds.has(rangeKey)) issues.push('retrieval-evidence-ref-invalid')
        rangeIds.add(rangeKey)
      }
    }
  }
  if (labelMap.size !== taskMap.size || [...taskMap.keys()].some(id => !labelMap.has(id))) issues.push('retrieval-labels-not-bijective')
  return { valid: issues.length === 0, issues }
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
  return { sourceCommit, retrievalDataHash, reference: authorization.reference, authorization }
}

export async function claimAuthorizationArtifact({ repoRoot, authorizationPath }) {
  const binding = await checkAuthorizationArtifact({ repoRoot, authorizationPath })
  const root = await realpath(repoRoot)
  const claimsDir = path.join(root, '.validation', 'agentic', 'claims')
  let cursor = root
  for (const component of path.relative(root, claimsDir).split(path.sep)) {
    cursor = path.join(cursor, component)
    try {
      const stat = await lstat(cursor)
      safe(stat.isDirectory() && !stat.isSymbolicLink(), 'claim-path-invalid')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      try { await mkdir(cursor) } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError
        const stat = await lstat(cursor)
        safe(stat.isDirectory() && !stat.isSymbolicLink(), 'claim-path-invalid')
      }
    }
  }
  return createOneShotAuthorizationClaim(claimsDir, binding)
}

export async function createOneShotAuthorizationClaim(claimsDir, binding) {
  safe(binding?.reference && /^[A-Za-z0-9._:/-]{1,160}$/u.test(binding.reference) && /^[a-f0-9]{40}$/u.test(binding.sourceCommit ?? '') && HASH.test(binding.retrievalDataHash ?? ''), 'authorization-binding-invalid')
  const directoryStat = await lstat(claimsDir)
  safe(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'claim-path-invalid')
  const claimId = sha256(Buffer.from(`${binding.sourceCommit}\0${RETRIEVAL_PURPOSE}\0${binding.reference}`))
  const claimPath = path.join(claimsDir, `${claimId}.json`)
  const handle = await open(claimPath, 'wx')
  const record = { schemaVersion: 1, claimId, purpose: RETRIEVAL_PURPOSE, reference: binding.reference, sourceCommit: binding.sourceCommit, retrievalDataHash: binding.retrievalDataHash }
  try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync() } finally { await handle.close() }
  return { ...record, claimPath }
}

async function verifyClaimFile(claimPath, auth, root) {
  safe(typeof claimPath === 'string' && claimPath.length > 0, 'authorization-claim-required')
  const expectedClaimId = sha256(Buffer.from(`${auth.sourceCommit}\0${RETRIEVAL_PURPOSE}\0${auth.reference}`))
  const expectedPath = path.join(root, '.validation', 'agentic', 'claims', `${expectedClaimId}.json`)
  safe(path.resolve(claimPath) === path.resolve(expectedPath), 'authorization-claim-invalid')
  const stat = await lstat(claimPath)
  safe(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096, 'authorization-claim-invalid')
  const claim = JSON.parse(await readFile(claimPath, 'utf8'))
  safe(claim?.schemaVersion === 1 && claim.claimId === expectedClaimId && claim.purpose === RETRIEVAL_PURPOSE && claim.reference === auth.reference && claim.sourceCommit === auth.sourceCommit && claim.retrievalDataHash === auth.retrievalDataHash, 'authorization-claim-invalid')
  return claim
}

export async function verifyAuthorizationClaim({ claimPath, authorization, repoRoot }) {
  const root = await realpath(repoRoot)
  const claim = await verifyClaimFile(claimPath, authorization, root)
  const startedPath = path.join(path.dirname(claimPath), `${claim.claimId}.started`)
  const stat = await lstat(startedPath)
  safe(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024, 'authorization-claim-invalid')
  const started = JSON.parse(await readFile(startedPath, 'utf8'))
  safe(started?.claimId === claim.claimId && started.state === 'started', 'authorization-claim-invalid')
  return claim
}

async function beginClaimOnce(claimPath, claim) {
  const markerPath = path.join(path.dirname(claimPath), `${claim.claimId}.started`)
  const handle = await open(markerPath, 'wx')
  try { await handle.writeFile(JSON.stringify({ claimId: claim.claimId, state: 'started' }), 'utf8'); await handle.sync() } finally { await handle.close() }
}

export function verifyPublicProfileBinding(profileMetadata, auth) {
  safe(profileMetadata && typeof profileMetadata === 'object', 'profile-binding-mismatch')
  safe(endpointHash(profileMetadata.baseUrl) === auth.endpointFingerprint && profileMetadata.model === auth.model, 'profile-binding-mismatch')
  safe((profileMetadata.protocol ?? 'openai') === auth.protocol && (profileMetadata.temperature ?? 0.4) === auth.temperature, 'profile-binding-mismatch')
  safe((profileMetadata.reasoningEffort ?? null) === auth.reasoningEffort && profileMetadata.contextWindowTokens === auth.contextWindowTokens, 'profile-binding-mismatch')
  safe((profileMetadata.protocol ?? 'openai') === 'openai', 'profile-binding-mismatch')
  return true
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

export function createRetrievalRunSpec(task, profile, snapshot, runId) {
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
  })
}

function rangeMetadata(record) {
  return { id: record.id, path: record.relPath, startLine: record.originalRange?.startLine ?? null, endLine: record.originalRange?.endLine ?? null, contentHash: record.contentHash, sourceKind: record.sourceKind, readStatus: record.readStatus, parseStatus: record.parseStatus, omission: record.omission }
}

function coversRequirement(requirement, selected, project) {
  const source = project.files.find(file => file.path === requirement.path)?.content
  if (typeof source !== 'string' || hashEvidenceRange(source, requirement.startLine, requirement.endLine) !== requirement.sha256) return false
  const ranges = selected.filter(record => record && record.path === requirement.path && Number.isInteger(record.startLine) && Number.isInteger(record.endLine) && record.readStatus === 'complete' && record.omission === 'none' && record.contentHash === hashEvidenceRange(source, record.startLine, record.endLine))
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
  if (!item || !/^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.id ?? '') || !['code', 'documentation', 'configuration', 'other'].includes(item.sourceKind) || !['parsed', 'unavailable'].includes(item.parseStatus) || item.readStatus !== 'complete' || item.omission !== 'none') return false
  const source = project.files.find(file => file.path === item.path)?.content
  return typeof source === 'string' && Number.isSafeInteger(item.startLine) && Number.isSafeInteger(item.endLine) && item.startLine >= 1 && item.endLine >= item.startLine && item.endLine <= source.split('\n').length && HASH.test(item.contentHash ?? '') && item.contentHash === hashEvidenceRange(source, item.startLine, item.endLine)
}

export function recomputeRetrievalMetrics(report, bundle) {
  const labels = new Map((bundle?.retrievalLabels?.labels ?? []).map(label => [label.taskId, label]))
  const tasks = new Map((bundle?.retrievalTasks?.tasks ?? []).map(task => [task.id, task]))
  const projects = new Map((bundle?.projects?.projects ?? []).map(project => [project.id, project]))
  const cells = Array.isArray(report?.runs) ? report.runs : []
  const unique = new Set(cells.filter(Boolean).map(cell => `${cell.taskId}:${cell.repeat}`))
  const taskList = bundle?.retrievalTasks?.tasks ?? []
  const expectedCells = new Set(taskList.flatMap(task => [1, 2].map(repeat => `${task.id}:${repeat}`)))
  let complete = 0, readRequests = 0, repeatedReads = 0, invalidEvidence = 0, invalidToolExecutions = 0, limitViolations = 0, totalRequests = 0, knownInputTokens = 0, knownOutputTokens = 0, chargedInputTokens = 0, chargedOutputTokens = 0, unknownRequests = 0
  let chargedUsageComplete = true
  let usageComplete = true
  let diagnosticsComplete = true
  let readStatsComplete = true
  let limitsComplete = true
  let runConfigurationComplete = true
  let invalidEvidenceComplete = true
  const matrixComplete = cells.length === expectedCells.size && unique.size === expectedCells.size && ![...expectedCells].some(key => !unique.has(key)) && ![...unique].some(key => !expectedCells.has(key))
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') { usageComplete = false; chargedUsageComplete = false; diagnosticsComplete = false; limitsComplete = false; continue }
    const task = tasks.get(cell.taskId), project = task && projects.get(task.projectId), label = labels.get(cell.taskId)
    const receipt = cell.receipt && typeof cell.receipt === 'object' ? cell.receipt : null
    if (!task || !project || !label || !receipt || typeof receipt.usageComplete !== 'boolean') { usageComplete = false; chargedUsageComplete = false; diagnosticsComplete = false; limitsComplete = false; continue }
    if (!receipt.usageComplete) usageComplete = false
    if (!report?.provider || typeof report.provider !== 'object' || cell.runConfigFingerprint !== evaluationRunConfigFingerprint(task, report.provider)) runConfigurationComplete = false
    const reservations = Array.isArray(receipt.reservations) ? receipt.reservations : []
    const reservationIds = new Set(reservations.map(item => item?.id))
    const validReceipts = reservationIds.size === reservations.length && reservations.length === receipt.requests && reservations.every(item => item && /^inv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.id) && item.stage === 'investigation' && item.state === 'settled' && validUsage(item.usage) && Number.isSafeInteger(item.reservedInputTokens) && item.reservedInputTokens >= 0 && Number.isSafeInteger(item.reservedOutputTokens) && item.reservedOutputTokens >= 0 && Number.isSafeInteger(item.contextChars) && item.contextChars >= 0)
    const receiptInput = reservations.reduce((sum, item) => sum + (item?.state === 'settled' && validUsage(item.usage) ? item.usage.inputTokens : 0), 0)
    const receiptOutput = reservations.reduce((sum, item) => sum + (item?.state === 'settled' && validUsage(item.usage) ? item.usage.outputTokens : 0), 0)
    knownInputTokens += receiptInput
    knownOutputTokens += receiptOutput
    unknownRequests += reservations.filter(item => item?.state !== 'settled' || !validUsage(item.usage)).length + Math.max(0, (Number.isSafeInteger(receipt.requests) ? receipt.requests : reservations.length) - reservations.length)
    const known = receipt.knownProviderUsage
    const charged = receipt.chargedTokens
    if (!validReceipts || !known || known.inputTokens !== receiptInput || known.outputTokens !== receiptOutput || known.totalTokens !== receiptInput + receiptOutput || !charged || !Number.isSafeInteger(charged.inputTokens) || !Number.isSafeInteger(charged.outputTokens) || charged.inputTokens < receiptInput || charged.outputTokens < receiptOutput) usageComplete = false
    if ((receipt.usageComplete && (!validUsage(receipt.providerUsage) || receipt.providerUsage.inputTokens !== receiptInput || receipt.providerUsage.outputTokens !== receiptOutput)) || (!receipt.usageComplete && receipt.providerUsage !== null)) usageComplete = false
    const overspend = receipt.overspend && typeof receipt.overspend === 'object' && !Array.isArray(receipt.overspend) ? Object.values(receipt.overspend) : null
    const readStatsAvailable = Number.isSafeInteger(receipt.readRequests) && receipt.readRequests >= 0 && Number.isSafeInteger(receipt.repeatedReads) && receipt.repeatedReads >= 0
    const readStatsValid = readStatsAvailable && receipt.repeatedReads <= receipt.readRequests
    const executionStatsValid = Number.isSafeInteger(receipt.invalidToolExecutions) && receipt.invalidToolExecutions >= 0
    const overspendValid = receipt.overspend && typeof receipt.overspend === 'object' && !Array.isArray(receipt.overspend) && Object.keys(receipt.overspend).sort().join(',') === 'inputTokens,outputTokens,readBytes' && overspend?.every(value => Number.isSafeInteger(value) && value >= 0)
    const capDiagnosticsValid = Number.isFinite(receipt.readBytes) && receipt.readBytes >= 0 && Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0 && overspendValid && typeof receipt.blocked === 'boolean'
    if (!readStatsValid || !executionStatsValid || !capDiagnosticsValid) diagnosticsComplete = false
    if (!readStatsAvailable) readStatsComplete = false
    if (!executionStatsValid) invalidToolExecutions = null
    else if (invalidToolExecutions !== null) invalidToolExecutions += receipt.invalidToolExecutions
    if (!capDiagnosticsValid) limitsComplete = false
    const selectedEvidence = Array.isArray(cell.selectedEvidence) ? cell.selectedEvidence : []
    const retrievedEvidence = Array.isArray(cell.retrievedEvidence) ? cell.retrievedEvidence : []
    const evidenceAvailable = Array.isArray(cell.selectedEvidence) && Array.isArray(cell.retrievedEvidence)
    if (!evidenceAvailable) {
      invalidEvidenceComplete = false
      diagnosticsComplete = false
    }
    const selectedIds = new Set(selectedEvidence.map(item => item?.id))
    const retrievedIds = new Set(retrievedEvidence.map(item => item?.id))
    const metadataById = new Map(retrievedEvidence.filter(item => item && typeof item.id === 'string').map(item => [item.id, item]))
    const observedIndexStatus = retrievedEvidence.some(item => item?.parseStatus === 'parsed') ? 'available' : 'unavailable'
    const conditionValid = cell.condition && cell.condition.indexMode === task.indexMode && cell.condition.indexStatus === observedIndexStatus && (task.indexMode !== 'unavailable' || cell.condition.indexStatus === 'unavailable')
    const allRetrievedValid = Array.isArray(cell.retrievedEvidence) && conditionValid && retrievedIds.size === retrievedEvidence.length && retrievedEvidence.every(item => validEvidenceMetadata(item, project) && (task.indexMode !== 'unavailable' || item.parseStatus === 'unavailable'))
    const allSelectedValid = Array.isArray(cell.selectedEvidence) && conditionValid && selectedIds.size === selectedEvidence.length && selectedEvidence.every(item => validEvidenceMetadata(item, project) && metadataById.has(item.id) && canonicalJson(item) === canonicalJson(metadataById.get(item.id)))
    if (evidenceAvailable && (!allRetrievedValid || !allSelectedValid)) invalidEvidence++
    if (readStatsAvailable) {
      readRequests += receipt.readRequests
      repeatedReads += receipt.repeatedReads
    }
    const requestCount = receipt.requests
    totalRequests += Number.isSafeInteger(requestCount) ? requestCount : 0
    if (charged && Number.isSafeInteger(charged.inputTokens) && charged.inputTokens >= 0 && Number.isSafeInteger(charged.outputTokens) && charged.outputTokens >= 0) {
      chargedInputTokens += charged.inputTokens
      chargedOutputTokens += charged.outputTokens
    } else chargedUsageComplete = false
    if (!Number.isSafeInteger(requestCount) || requestCount < 1 || requestCount > 3 || (receipt.usageComplete && (!validUsage(receipt.providerUsage) || receipt.providerUsage.inputTokens > 18_000 || receipt.providerUsage.outputTokens > 6_000)) || (Number.isFinite(receipt.readBytes) && (receipt.readBytes > 2 * 1024 * 1024)) || (Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs > 180_000) || (readStatsAvailable && receipt.repeatedReads > receipt.readRequests) || reservations.some(item => validUsage(item?.usage) && (item.usage.outputTokens > RETRIEVAL_LIMITS.perRequestOutputTokens || item.usage.inputTokens > item.reservedInputTokens || item.usage.outputTokens > item.reservedOutputTokens)) || overspend?.some(value => Number.isSafeInteger(value) && value > 0) || receipt.blocked === true) limitViolations++
    const completeTask = label.requiredEvidenceGroups.every(group => group.allOf.every(ref => coversRequirement(ref, selectedEvidence, project)))
    if (allSelectedValid && cell.status === 'completed' && cell.stopReason === 'finished' && completeTask) complete++
  }
  const completeRate = complete / RETRIEVAL_LIMITS.runs
  const repeatedReadRate = readStatsComplete ? (readRequests ? repeatedReads / readRequests : (repeatedReads ? 1 : 0)) : null
  if (!chargedUsageComplete) limitsComplete = false
  if (chargedUsageComplete && (chargedInputTokens > RETRIEVAL_LIMITS.inputTokens || chargedOutputTokens > RETRIEVAL_LIMITS.outputTokens) || knownInputTokens > RETRIEVAL_LIMITS.inputTokens || knownOutputTokens > RETRIEVAL_LIMITS.outputTokens) limitViolations++
  return {
    runCount: cells.length, uniqueCells: unique.size, matrixComplete, completeEvidenceTaskRate: completeRate, invalidToolExecution: invalidToolExecutions, invalidEvidence: invalidEvidenceComplete ? invalidEvidence : null, repeatedReadRate, diagnosticsComplete, limitViolations, limitsComplete, runConfigurationComplete, usageComplete,
    requests: totalRequests, unknownRequests, inputTokens: usageComplete ? knownInputTokens : null, outputTokens: usageComplete ? knownOutputTokens : null,
    knownInputTokens, knownOutputTokens,
    chargedInputTokens: chargedUsageComplete ? chargedInputTokens : null, chargedOutputTokens: chargedUsageComplete ? chargedOutputTokens : null
  }
}

export function verifyRetrievalReport(report, bundle, expected = {}) {
  const issues = []
  if (!report || report.schemaVersion !== 1 || report.mode !== 'real' || typeof report.authorizationReference !== 'string' || !HASH.test(report.authorizationClaimId ?? '')) issues.push('report-not-real')
  if (!bundle || validateRetrievalBundle(bundle).valid !== true) issues.push('dataset-invalid')
  if (!Array.isArray(report?.runs) || report.runs.length !== 40) issues.push('run-matrix-incomplete')
  const metrics = bundle ? recomputeRetrievalMetrics(report, bundle) : null
  if (metrics && !metrics.matrixComplete && !issues.includes('run-matrix-incomplete')) issues.push('run-matrix-incomplete')
  if (metrics && metrics.uniqueCells < metrics.runCount) issues.push('run-matrix-duplicate')
  if (metrics && metrics.completeEvidenceTaskRate < RETRIEVAL_LIMITS.completeRate) issues.push('evidence-coverage-below-threshold')
  if (metrics && metrics.invalidToolExecution !== null && metrics.invalidToolExecution !== 0) issues.push('invalid-tool-execution')
  if (metrics && (metrics.invalidEvidence !== null && metrics.invalidEvidence !== 0 || !metrics.diagnosticsComplete)) issues.push('diagnostics-incomplete-or-evidence-invalid')
  if (metrics && !metrics.runConfigurationComplete) issues.push('run-configuration-invalid')
  if (metrics && metrics.repeatedReadRate !== null && metrics.repeatedReadRate > RETRIEVAL_LIMITS.repeats) issues.push('repeated-read-rate-above-threshold')
  if (metrics && (!metrics.limitsComplete || metrics.limitViolations !== 0 || !metrics.usageComplete)) issues.push('receipt-or-limit-invalid')
  if (!report?.provider || !HASH.test(report.provider.endpointFingerprint ?? '') || typeof report.provider.model !== 'string' || report.provider.protocol !== 'openai' || report.provider.temperature !== 0.4 || ![null, 'low', 'high'].includes(report.provider.reasoningEffort) || !Number.isSafeInteger(report.provider.contextWindowTokens) || report.provider.contextWindowTokens < 4096 || report.provider.maxOutputTokensPerRequest !== RETRIEVAL_LIMITS.perRequestOutputTokens) issues.push('provider-binding-invalid')
  else if (report.configurationFingerprint !== evaluationConfigFingerprint(report.provider)) issues.push('configuration-binding-invalid')
  if (expected.provider && report?.provider && ['endpointFingerprint', 'model', 'protocol', 'temperature', 'reasoningEffort', 'contextWindowTokens'].some(key => report.provider[key] !== expected.provider[key])) issues.push('provider-authorization-mismatch')
  if (expected.sourceCommit && report?.sourceCommit !== expected.sourceCommit) issues.push('source-binding-mismatch')
  if (expected.retrievalDataHash && report?.retrievalDataHash !== expected.retrievalDataHash) issues.push('dataset-binding-mismatch')
  if (expected.configurationFingerprint && report?.configurationFingerprint !== expected.configurationFingerprint) issues.push('configuration-binding-mismatch')
  if (report?.sourceCommit && report?.authorizationReference && report.authorizationClaimId !== sha256(Buffer.from(`${report.sourceCommit}\0${RETRIEVAL_PURPOSE}\0${report.authorizationReference}`))) issues.push('authorization-claim-mismatch')
  if (metrics && (metrics.requests > (expected.maxRequests ?? RETRIEVAL_LIMITS.requests) || metrics.knownInputTokens > (expected.maxInputTokens ?? RETRIEVAL_LIMITS.inputTokens) || metrics.knownOutputTokens > (expected.maxOutputTokens ?? RETRIEVAL_LIMITS.outputTokens) || (metrics.chargedInputTokens !== null && metrics.chargedInputTokens > (expected.maxInputTokens ?? RETRIEVAL_LIMITS.inputTokens)) || (metrics.chargedOutputTokens !== null && metrics.chargedOutputTokens > (expected.maxOutputTokens ?? RETRIEVAL_LIMITS.outputTokens)))) issues.push('authorization-budget-exceeded')
  if (report?.sourceStable !== true) issues.push('source-changed-during-run')
  return { valid: issues.length === 0, issues, metrics }
}

export function evaluationConfigFingerprint(provider) {
  return sha256(Buffer.from(canonicalJson({ purpose: RETRIEVAL_PURPOSE, provider: { endpointFingerprint: provider.endpointFingerprint, model: provider.model, protocol: provider.protocol, temperature: provider.temperature, reasoningEffort: provider.reasoningEffort, contextWindowTokens: provider.contextWindowTokens, maxOutputTokensPerRequest: provider.maxOutputTokensPerRequest }, limits: RETRIEVAL_LIMITS, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })))
}

export function evaluationRunConfigFingerprint(task, provider) {
  const spec = createRetrievalRunSpec(task, {
    id: 'evaluation-profile', model: provider.model, baseUrl: 'https://fingerprint.invalid/v1',
    protocol: provider.protocol, temperature: provider.temperature, reasoningEffort: provider.reasoningEffort ?? undefined,
    contextWindowTokens: provider.contextWindowTokens, maxOutputTokens: RETRIEVAL_LIMITS.perRequestOutputTokens,
    endpointFingerprint: provider.endpointFingerprint
  }, { projectId: task.projectId, snapshotId: 'evaluation-snapshot' }, 'evaluation-run')
  return sha256(Buffer.from(canonicalJson({
    globalConfiguration: evaluationConfigFingerprint(provider), task: { id: task.id, projectId: task.projectId, objective: task.objective, roleFocus: task.roleFocus, granularity: task.granularity, indexMode: task.indexMode },
    budget: { global: spec.budget.total, investigation: spec.budget.investigation, generationReserve: spec.budget.generationReserve, generationInputTokens: spec.generationInputTokens, generationOutputTokens: spec.generationOutputTokens }
  })))
}

function nonSecretError(error) {
  const code = typeof error?.code === 'string' && /^[a-z-]{1,48}$/u.test(error.code) ? error.code : 'run-failed'
  return { code }
}

export function sanitizeModelFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const kinds = new Set(['timeout', 'cancelled', 'network', 'http', 'response'])
  const finishReasons = new Set(['length', 'content_filter', 'tool_calls', 'function_call', 'stop', 'other'])
  if (!kinds.has(value.kind)) return null
  const result = { kind: value.kind }
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus
  if (finishReasons.has(value.finishReason)) result.finishReason = value.finishReason
  return result
}

function validUsage(value) {
  return !!value && Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0 && Number.isSafeInteger(value.totalTokens) && value.totalTokens === value.inputTokens + value.outputTokens
}

export function createGlobalBudgetCollector({ maxRequests, maxInputTokens, maxOutputTokens }) {
  const active = new Map()
  const entries = []
  let admittedRequests = 0, actualInputTokens = 0, actualOutputTokens = 0, blocked = false
  const collector = {
    admit(runId, reservation) {
      if (blocked || admittedRequests + 1 > maxRequests) throw new Error('global-budget-exhausted')
      const estimatedInputTokens = reservation?.estimatedInputTokens ?? reservation?.inputTokens
      const estimatedOutputTokens = reservation?.outputTokens
      if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0 || !Number.isSafeInteger(estimatedOutputTokens) || estimatedOutputTokens < 0 || actualInputTokens + [...active.values()].reduce((sum, value) => sum + value.estimatedInputTokens, 0) + estimatedInputTokens > maxInputTokens || actualOutputTokens + [...active.values()].reduce((sum, value) => sum + value.estimatedOutputTokens, 0) + estimatedOutputTokens > maxOutputTokens) throw new Error('global-budget-exhausted')
      const entry = { runId, requestId: reservation.id, estimatedInputTokens, estimatedOutputTokens, contextChars: reservation.contextChars ?? null, state: 'admitted', usage: null }
      admittedRequests++
      active.set(entry.requestId, entry)
      entries.push(entry)
      return entry
    },
    failBeforeDispatch(entry) {
      if (active.get(entry.requestId) !== entry || entry.state !== 'admitted') return
      active.delete(entry.requestId); admittedRequests--; entry.state = 'not-dispatched'
    },
    settle(entry, usage) {
      if (active.get(entry.requestId) !== entry || entry.state !== 'admitted' || !validUsage(usage)) { blocked = true; throw new Error('usage-invalid') }
      entry.state = 'settled'; entry.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
      active.delete(entry.requestId)
      actualInputTokens += usage.inputTokens; actualOutputTokens += usage.outputTokens
      if (usage.inputTokens > entry.estimatedInputTokens || usage.outputTokens > entry.estimatedOutputTokens || actualInputTokens > maxInputTokens || actualOutputTokens > maxOutputTokens) blocked = true
    },
    markUnknown(entry) {
      if (active.get(entry.requestId) === entry && entry.state === 'admitted') entry.state = 'unknown'
      blocked = true
    },
    snapshot() {
      return Object.freeze({ admittedRequests, actualInputTokens, actualOutputTokens, reservedInputTokens: [...active.values()].reduce((sum, value) => sum + value.estimatedInputTokens, 0), reservedOutputTokens: [...active.values()].reduce((sum, value) => sum + value.estimatedOutputTokens, 0), blocked, entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry, usage: entry.usage ? Object.freeze({ ...entry.usage }) : null }))) })
    },
    runEntries(runId) { return entries.filter(entry => entry.runId === runId && entry.state !== 'not-dispatched').map(entry => ({ ...entry, usage: entry.usage ? { ...entry.usage } : null })) }
  }
  return Object.freeze(collector)
}

export function createGuardedTransport({ collector, runId, getReservation, appendJournal, transport }) {
  const delegate = transport ?? (async (profile, messages, onDelta, options) => {
    const { chatCompletionStream } = await import('../../electron/services/llm.ts')
    return chatCompletionStream(profile, messages, onDelta, options)
  })
  return async (profile, messages, onDelta, options) => {
    if (collector.snapshot().blocked) throw new Error('global-budget-exhausted')
    let admission = null, usageSeen = null, journalError = null, dispatchFailed = false
    const markUnknown = reason => {
      if (!admission || usageSeen) return
      collector.markUnknown(admission)
      try { appendJournal({ type: 'usage-unknown', runId, requestId: admission.requestId, reason }) } catch { journalError = new Error('journal-failed') }
    }
    const wrapped = {
      ...options,
      beforeRequest: () => {
        const reservation = getReservation()
        admission = collector.admit(runId, reservation)
        try {
          options.beforeRequest?.()
          appendJournal({ type: 'request-admitted', runId, requestId: admission.requestId, estimatedInputTokens: admission.estimatedInputTokens, estimatedOutputTokens: admission.estimatedOutputTokens, contextChars: admission.contextChars })
        } catch (error) {
          dispatchFailed = true
          if (journalError) collector.markUnknown(admission)
          else collector.failBeforeDispatch(admission)
          throw error
        }
      },
      onUsage: usage => {
        if (usageSeen) { journalError = new Error('duplicate-usage'); collector.markUnknown(admission); return }
        usageSeen = validUsage(usage) ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } : null
        if (!usageSeen) { journalError = new Error('usage-invalid'); collector.markUnknown(admission); return }
        try { collector.settle(admission, usageSeen) } catch { journalError = new Error('usage-invalid') }
        options.onUsage?.(usage)
        try { appendJournal({ type: 'provider-usage', runId, requestId: admission.requestId, usage: usageSeen }) } catch { journalError = new Error('journal-failed') }
      }
    }
    try {
      const content = await delegate(profile, messages, onDelta, wrapped)
      if (journalError) throw new Error('journal-failed')
      if (collector.snapshot().blocked) throw new Error('global-budget-exhausted')
      if (!admission || dispatchFailed || !usageSeen) {
        markUnknown('usage-missing')
        throw new Error('usage-incomplete')
      }
      return content
    } catch (error) {
      if (admission && !usageSeen) markUnknown('transport-failed')
      throw error
    }
  }
}

function appendDurableJournal(filename, value) {
  const fd = openSync(filename, 'a')
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
}

async function writeDurableExclusive(filename, value) {
  const handle = await open(filename, 'wx')
  try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
}

export async function runRetrievalEvaluation({ repoRoot = path.resolve(HERE, '../..'), outputDir, profile, authorizationPath, claimPath, scratchRoot, transport, mode = 'real' } = {}) {
  safe(mode === 'real' && !transport, 'real-mode-transport-forbidden')
  safe(typeof outputDir === 'string' && outputDir.length > 0 && typeof authorizationPath === 'string' && authorizationPath.length > 0, 'authorization-required')
  const root = await realpath(repoRoot)
  const executingRoot = await realpath(path.resolve(HERE, '../..'))
  safe(root === executingRoot, 'execution-root-mismatch')
  const sourceCommit = getCleanSourceBinding(root)
  const retrievalDataHash = await hashRetrievalData(path.join(root, 'scripts/agentic/datasets/v1'))
  const authStat = await lstat(authorizationPath)
  safe(authStat.isFile() && !authStat.isSymbolicLink() && authStat.size <= 16 * 1024, 'authorization-invalid')
  const auth = validateAuthorization(JSON.parse(await readFile(authorizationPath, 'utf8')), { sourceCommit, dataHash: retrievalDataHash })
  const claim = await verifyClaimFile(claimPath, auth, root)
  await beginClaimOnce(claimPath, claim)
  const boundProfile = verifyProfileBinding(profile, auth)
  const bundle = await loadRetrievalBundle(path.join(root, 'scripts/agentic/datasets/v1'))
  safe(validateRetrievalBundle(bundle).valid, 'dataset-invalid')
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
  safe(typeof scratchRoot === 'string' && scratchRoot.length > 0, 'scratch-path-required')
  const scratchParent = path.resolve(scratchRoot)
  const tempParent = path.resolve(os.tmpdir())
  const scratchRelative = path.relative(tempParent, scratchParent)
  safe(scratchRelative !== '' && scratchRelative !== '..' && !scratchRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(scratchRelative), 'scratch-path-invalid')
  const scratchStat = await lstat(scratchParent)
  safe(scratchStat.isDirectory() && !scratchStat.isSymbolicLink(), 'scratch-path-invalid')
  await mkdir(outputRoot, { recursive: false })
  const progressPath = path.join(outputRoot, 'progress.ndjson')
  const globalCollector = createGlobalBudgetCollector({ maxRequests: auth.maxRequests, maxInputTokens: auth.maxInputTokens, maxOutputTokens: auth.maxOutputTokensTotal })
  const temp = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(scratchParent, 'm06-projects-')))
  const runs = []
  let stopped = false
  try {
    const projectRoots = new Map()
    for (const project of bundle.projects.projects) projectRoots.set(project.id, await materializeProject(filesOnlyProject(project), temp))
    for (const task of bundle.retrievalTasks.tasks) {
      for (const repeat of [1, 2]) {
        if (stopped) break
        const project = projectById.get(task.projectId)
        const projectRoot = projectRoots.get(task.projectId)
        let ledger, snapshot, store, result, errorCode = null, failure = null
        const events = []
        try {
          const scan = await scanProject(projectRoot)
          snapshot = await createWorkflowSnapshot(scan, { projectId: task.projectId, ...(task.indexMode === 'unavailable' ? { analyzer: () => null, parserVersion: 'm06-index-disabled-v1' } : {}) })
          store = createEvidenceStore(snapshot)
          const spec = createRetrievalRunSpec(task, boundProfile, snapshot, `${task.id}-r${repeat}`)
          ledger = createBudgetLedger(spec)
          const guardedTransport = createGuardedTransport({
            collector: globalCollector,
            runId: `${task.id}-r${repeat}`,
            getReservation: () => ledger.snapshot().reservations.find(item => item.state === 'reserved' && item.stage === 'investigation'),
            appendJournal: event => appendDurableJournal(progressPath, event)
          })
          const gateway = createModelGateway(spec, boundProfile, ledger, { transport: guardedTransport })
          const toolGateway = createToolGateway(snapshot, store, ledger)
          result = await runInvestigation({ spec, snapshot, store, tools: toolGateway, ledger, model: gateway, objective: task.objective, onEvent: event => events.push({ type: event.type, ...(event.hash ? { hash: event.hash } : {}), ...(event.reason ? { reason: event.reason } : {}) }) })
        } catch (error) {
          errorCode = nonSecretError(error).code
          failure = { code: errorCode }
          const modelFailure = sanitizeModelFailure(error?.modelFailure)
          if (modelFailure) failure.modelFailure = modelFailure
        }
        let selectedEvidence = null
        let retrievedEvidence = null
        if (result && store && snapshot) {
          selectedEvidence = []
          retrievedEvidence = []
          try {
            const retrieved = await store.resolve(store.metadata().ids, snapshot.snapshotId)
            retrievedEvidence.push(...retrieved.map(rangeMetadata))
            const resolved = await store.resolve(result.selection.selectedIds, snapshot.snapshotId)
            selectedEvidence.push(...resolved.map(rangeMetadata))
          } catch { errorCode = errorCode || 'evidence-resolution-failed' }
        }
        const state = ledger?.snapshot()
        const callReceipts = globalCollector.runEntries(`${task.id}-r${repeat}`)
        const knownCalls = callReceipts.filter(item => item.state === 'settled' && item.usage)
        const knownInput = knownCalls.reduce((sum, item) => sum + item.usage.inputTokens, 0)
        const knownOutput = knownCalls.reduce((sum, item) => sum + item.usage.outputTokens, 0)
        const runUsageComplete = callReceipts.length > 0 && callReceipts.every(item => item.state === 'settled' && item.usage) && state?.usageComplete === true
        const receipt = state ? {
          requests: callReceipts.length,
          providerUsage: runUsageComplete ? { inputTokens: knownInput, outputTokens: knownOutput, totalTokens: knownInput + knownOutput } : null,
          knownProviderUsage: { inputTokens: knownInput, outputTokens: knownOutput, totalTokens: knownInput + knownOutput },
          chargedTokens: { inputTokens: state.total.inputTokens, outputTokens: state.total.outputTokens },
          usageComplete: runUsageComplete,
          readBytes: state.total.readBytes,
          elapsedMs: state.elapsedMs,
          readRequests: Number.isSafeInteger(result?.statistics?.readRequests) ? result.statistics.readRequests : null,
          repeatedReads: result?.statistics?.repeatedReads ?? null,
          invalidToolExecutions: result?.statistics?.invalidToolExecutions ?? null,
          overspend: state.overspend,
          blocked: state.blocked,
          reservations: callReceipts.map(({ requestId, estimatedInputTokens, estimatedOutputTokens, contextChars, state: entryState, usage }) => ({ id: requestId, stage: 'investigation', state: entryState, reservedInputTokens: estimatedInputTokens, reservedOutputTokens: estimatedOutputTokens, contextChars, usage }))
        } : { requests: callReceipts.length, providerUsage: null, knownProviderUsage: { inputTokens: knownInput, outputTokens: knownOutput, totalTokens: knownInput + knownOutput }, chargedTokens: null, usageComplete: false, readBytes: null, elapsedMs: null, readRequests: result?.statistics?.readRequests ?? null, repeatedReads: result?.statistics?.repeatedReads ?? null, invalidToolExecutions: result?.statistics?.invalidToolExecutions ?? null, overspend: null, blocked: true, reservations: callReceipts.map(({ requestId, estimatedInputTokens, estimatedOutputTokens, contextChars, state: entryState, usage }) => ({ id: requestId, stage: 'investigation', state: entryState, reservedInputTokens: estimatedInputTokens, reservedOutputTokens: estimatedOutputTokens, contextChars, usage })) }
        const selectionComplete = result?.status === 'completed' && Array.isArray(selectedEvidence) && labels.get(task.id).requiredEvidenceGroups.every(group => group.allOf.every(ref => coversRequirement(ref, selectedEvidence, project)))
        const runRecord = {
          taskId: task.id, repeat, status: errorCode ? 'failed' : (result?.status ?? 'failed'),
          stopReason: result?.stopReason ?? errorCode ?? 'run-incomplete',
          condition: { indexMode: task.indexMode, indexStatus: task.indexMode === 'unavailable' ? 'unavailable' : retrievedEvidence?.some(item => item.parseStatus === 'parsed') ? 'available' : 'unavailable' },
          events,
          retrievedEvidence, retrievedCount: retrievedEvidence?.length ?? null,
          selectedEvidence, selectedCount: selectedEvidence?.length ?? null, completeEvidenceTask: selectionComplete,
          runConfigFingerprint: evaluationRunConfigFingerprint(task, provider),
          ...(failure ? { failure } : {}),
          receipt
        }
        runs.push(runRecord)
        await writeDurableExclusive(path.join(outputRoot, `run-${task.id}-r${repeat}.json`), runRecord)
        const globalState = globalCollector.snapshot()
        if (errorCode || !receipt.usageComplete || receipt.blocked || globalState.blocked || Object.values(receipt.overspend ?? {}).some(value => value !== 0) || receipt.requests > 3 || (receipt.chargedTokens?.inputTokens ?? 0) > 18_000 || (receipt.chargedTokens?.outputTokens ?? 0) > 6_000 || !Number.isFinite(receipt.readBytes) || receipt.readBytes > 2 * 1024 * 1024 || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs > 180_000 || globalState.admittedRequests >= auth.maxRequests || globalState.actualInputTokens + globalState.reservedInputTokens > auth.maxInputTokens || globalState.actualOutputTokens + globalState.reservedOutputTokens > auth.maxOutputTokensTotal) stopped = true
      }
      if (stopped) break
    }
    let sourceStable = false
    try { sourceStable = getCleanSourceBinding(root) === sourceCommit && await hashRetrievalData(path.join(root, 'scripts/agentic/datasets/v1')) === retrievalDataHash } catch { sourceStable = false }
    const report = {
      schemaVersion: 1, mode: 'real', purpose: RETRIEVAL_PURPOSE, authorizationReference: auth.reference, authorizationClaimId: claim.claimId,
      sourceCommit, retrievalDataHash, sourceStable, configurationFingerprint: evaluationConfigFingerprint(provider), provider,
      runs
    }
    report.metrics = recomputeRetrievalMetrics(report, bundle)
    report.verification = verifyRetrievalReport(report, bundle, { sourceCommit, retrievalDataHash, maxRequests: auth.maxRequests, maxInputTokens: auth.maxInputTokens, maxOutputTokens: auth.maxOutputTokensTotal, provider: auth })
    await writeDurableExclusive(path.join(outputRoot, 'retrieval-report.json'), report)
    return report
  } finally { await rm(temp, { recursive: true, force: true }) }
}
