import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, hashEvidenceRange, sha256 } from './dataset-contract.mjs'

export const GENERATION_PURPOSE = 'm08-generation-v1'
export const GENERATION_STRATEGIES = Object.freeze(['static-control', 'agentic'])
export const GENERATION_REPEATS = Object.freeze([1, 2])
export const GENERATION_OUTPUT_CAPS = Object.freeze([16_384, 32_768])
export const GENERATION_PER_RUN = Object.freeze({
  inputTokens: 128_000,
  outputTokens: 65_536,
  wallClockMs: 600_000,
  maxOutputTokensPerRequest: 32_768
})
export const GENERATION_REQUESTS_PER_RUN = Object.freeze({ medium: 5, fine: 14 })

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = path.join(HERE, 'datasets', 'v1')
const SOURCE_FILES = Object.freeze(['projects.json', 'generation-tasks.json', 'generation-labels.json'])
const HASH = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const LANGUAGES = new Set(['Python', 'JavaScript', 'TypeScript'])
const GRANULARITIES = new Set(['medium', 'fine'])
const TASK_KEYS = ['id', 'projectId', 'objective', 'roleFocus', 'granularity', 'topic']
const PROJECT_FILE_KEYS = ['path', 'content', 'sha256']
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_PROJECTS = 32
const MAX_PROJECT_FILES = 128
const MAX_TOTAL_PROJECT_FILES = 1024

const exactKeys = (value, keys) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)))
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const safePath = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
  !value.includes('\0') && !value.includes(':') && !value.startsWith('/') &&
  value.split('/').every((part) => part && part !== '.' && part !== '..')
const isUtf8Text = (value) => Buffer.from(value, 'utf8').toString('utf8') === value
const fail = (code) => { throw new Error(code) }
const add = (issues, condition, code) => { if (condition) issues.push(code) }

function safeJsonParse(buffer) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) } catch { fail('dataset-unavailable') }
}

async function readDatasetFile(root, filename) {
  const absolute = path.join(root, filename)
  const relative = path.relative(root, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('dataset-unavailable')
  let cursor = root
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    let stat
    try { stat = await lstat(cursor) } catch { fail('dataset-unavailable') }
    if (stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) fail('dataset-unavailable')
  }
  const stat = await lstat(absolute)
  if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) fail('dataset-unavailable')
  const bytes = await readFile(absolute)
  return { bytes, document: safeJsonParse(bytes) }
}

function sourceHashesFor(hashes) {
  return Object.fromEntries(SOURCE_FILES.map((name) => [name, hashes[name]]))
}

/** Project only tasks, source files, and fixed evidence references; never return label prose. */
export function projectGenerationData({ projectsDocument, generationTasksDocument, generationLabelsDocument, sourceHashes }) {
  if (!exactKeys(projectsDocument, ['schemaVersion', 'split', 'projects']) || projectsDocument.schemaVersion !== 1 || projectsDocument.split !== 'development-synthetic' || !Array.isArray(projectsDocument.projects)) fail('dataset-invalid')
  if (!exactKeys(generationTasksDocument, ['schemaVersion', 'tasks']) || generationTasksDocument.schemaVersion !== 1 || !Array.isArray(generationTasksDocument.tasks)) fail('dataset-invalid')
  if (!exactKeys(generationLabelsDocument, ['schemaVersion', 'labels']) || generationLabelsDocument.schemaVersion !== 1 || !Array.isArray(generationLabelsDocument.labels)) fail('dataset-invalid')

  const projects = projectsDocument.projects.map((project) => {
    if (!exactKeys(project, ['id', 'language', 'sourceKind', 'files', 'contentSha256']) ||
      typeof project.id !== 'string' || !project.id || !LANGUAGES.has(project.language) ||
      project.sourceKind !== 'authored-fixture' || !Array.isArray(project.files)) fail('dataset-invalid')
    const files = project.files.map((file) => {
      if (!exactKeys(file, PROJECT_FILE_KEYS) || !safePath(file.path) || typeof file.content !== 'string' ||
        !isUtf8Text(file.content) || file.content.includes('\r') || Buffer.byteLength(file.content, 'utf8') > MAX_DOCUMENT_BYTES ||
        !HASH.test(file.sha256 ?? '') || sha256(Buffer.from(file.content, 'utf8')) !== file.sha256) fail('dataset-invalid')
      return { path: file.path, content: file.content, sha256: file.sha256 }
    })
    const summary = { id: project.id, language: project.language, files: files.map(({ path: relPath, sha256: hash }) => ({ path: relPath, sha256: hash })) }
    if (!HASH.test(project.contentSha256 ?? '') || sha256(Buffer.from(canonicalJson(summary), 'utf8')) !== project.contentSha256) fail('dataset-invalid')
    return { id: project.id, language: project.language, files, contentSha256: project.contentSha256 }
  })
  const tasks = generationTasksDocument.tasks.map((task) => {
    if (!exactKeys(task, TASK_KEYS) || typeof task.id !== 'string' || !task.id || typeof task.projectId !== 'string' ||
      typeof task.objective !== 'string' || !task.objective.trim() || !['general', 'frontend', 'backend', 'algorithm'].includes(task.roleFocus) ||
      !GRANULARITIES.has(task.granularity) || typeof task.topic !== 'string' || !task.topic.trim()) fail('dataset-invalid')
    return { id: task.id, projectId: task.projectId, objective: task.objective, roleFocus: task.roleFocus, granularity: task.granularity, topic: task.topic }
  })

  // Read only taskId/evidence from labels. Expected-fact and pitfall values are never accessed or copied.
  const fixedEvidenceInputs = generationLabelsDocument.labels.map((label) => {
    if (!exactKeys(label, ['taskId', 'evidence', 'expectedFacts', 'pitfalls']) || typeof label.taskId !== 'string' || !Array.isArray(label.evidence)) fail('dataset-invalid')
    return {
      taskId: label.taskId,
      evidence: label.evidence.map((ref) => {
        if (!exactKeys(ref, ['path', 'startLine', 'endLine', 'sha256'])) fail('dataset-invalid')
        return { path: ref.path, startLine: ref.startLine, endLine: ref.endLine, sha256: ref.sha256 }
      })
    }
  })
  const hashes = sourceHashesFor(sourceHashes ?? {})
  if (SOURCE_FILES.some((name) => !HASH.test(hashes[name] ?? ''))) fail('dataset-invalid')
  const projection = {
    schemaVersion: 1,
    split: 'development-synthetic',
    projects,
    tasks,
    fixedEvidenceInputs,
    sourceHashes: hashes,
    generationDataHash: sha256(Buffer.from(canonicalJson(hashes), 'utf8'))
  }
  const validation = validateGenerationProjection(projection)
  if (!validation.valid) fail('dataset-invalid')
  return projection
}

export async function loadGenerationEvaluationBundle(directory = DEFAULT_DATA_DIR) {
  let root
  try {
    const originalStat = await lstat(directory)
    if (!originalStat.isDirectory() || originalStat.isSymbolicLink()) fail('dataset-unavailable')
    root = await realpath(directory)
    const realStat = await lstat(root)
    if (!realStat.isDirectory() || realStat.isSymbolicLink()) fail('dataset-unavailable')
  } catch { fail('dataset-unavailable') }

  const documents = {}
  const fileHashes = {}
  let totalBytes = 0
  for (const name of SOURCE_FILES) {
    const file = await readDatasetFile(root, name)
    totalBytes += file.bytes.byteLength
    if (totalBytes > MAX_TOTAL_BYTES) fail('dataset-unavailable')
    documents[name] = file.document
    fileHashes[name] = sha256(file.bytes)
  }
  return projectGenerationData({
    projectsDocument: documents['projects.json'],
    generationTasksDocument: documents['generation-tasks.json'],
    generationLabelsDocument: documents['generation-labels.json'],
    sourceHashes: fileHashes
  })
}

export function validateGenerationProjection(bundle) {
  const issues = []
  if (!exactKeys(bundle, ['schemaVersion', 'split', 'projects', 'tasks', 'fixedEvidenceInputs', 'sourceHashes', 'generationDataHash']) ||
    bundle.schemaVersion !== 1 || bundle.split !== 'development-synthetic' || !Array.isArray(bundle.projects) ||
    !Array.isArray(bundle.tasks) || !Array.isArray(bundle.fixedEvidenceInputs)) return { valid: false, issues: ['projection-invalid'] }
  add(issues, bundle.projects.length === 0 || bundle.projects.length > MAX_PROJECTS, 'project-count-invalid')
  add(issues, bundle.tasks.length !== 12, 'generation-task-count-invalid')
  add(issues, bundle.fixedEvidenceInputs.length !== bundle.tasks.length, 'fixed-evidence-count-invalid')
  const sourceHashes = bundle.sourceHashes
  add(issues, !exactKeys(sourceHashes, SOURCE_FILES) || SOURCE_FILES.some((name) => !HASH.test(sourceHashes?.[name] ?? '')), 'source-hashes-invalid')
  if (exactKeys(sourceHashes, SOURCE_FILES) && SOURCE_FILES.every((name) => HASH.test(sourceHashes[name] ?? ''))) {
    add(issues, bundle.generationDataHash !== sha256(Buffer.from(canonicalJson(sourceHashes), 'utf8')), 'generation-data-hash-invalid')
  } else add(issues, true, 'generation-data-hash-invalid')

  const projectMap = new Map()
  const projectIds = new Set()
  let totalFiles = 0
  for (const project of bundle.projects) {
    if (!exactKeys(project, ['id', 'language', 'files', 'contentSha256']) || typeof project.id !== 'string' || !project.id ||
      !LANGUAGES.has(project.language) || !Array.isArray(project.files)) { issues.push('project-invalid'); continue }
    add(issues, projectIds.has(project.id), 'project-id-duplicate')
    projectIds.add(project.id)
    add(issues, project.files.length === 0 || project.files.length > MAX_PROJECT_FILES, 'project-file-count-invalid')
    totalFiles += project.files.length
    const paths = new Set()
    for (const file of project.files) {
      if (!exactKeys(file, PROJECT_FILE_KEYS) || !safePath(file.path) || typeof file.content !== 'string') { issues.push('project-file-invalid'); continue }
      add(issues, paths.has(file.path), 'project-file-duplicate')
      paths.add(file.path)
      add(issues, !isUtf8Text(file.content) || file.content.includes('\r') || Buffer.byteLength(file.content, 'utf8') > MAX_DOCUMENT_BYTES, 'project-file-content-invalid')
      add(issues, !HASH.test(file.sha256 ?? '') || sha256(Buffer.from(file.content, 'utf8')) !== file.sha256, 'project-file-hash-invalid')
    }
    const summary = { id: project.id, language: project.language, files: project.files.filter((file) => isObject(file)).map(({ path: relPath, sha256: hash }) => ({ path: relPath, sha256: hash })) }
    add(issues, !HASH.test(project.contentSha256 ?? '') || sha256(Buffer.from(canonicalJson(summary), 'utf8')) !== project.contentSha256, 'project-content-hash-invalid')
    projectMap.set(project.id, project)
  }
  add(issues, totalFiles > MAX_TOTAL_PROJECT_FILES, 'project-file-total-invalid')

  const taskMap = new Map()
  const objectiveSet = new Set()
  const languageCounts = { Python: 0, JavaScript: 0, TypeScript: 0 }
  const granularityCounts = { medium: 0, fine: 0 }
  for (const task of bundle.tasks) {
    if (!exactKeys(task, TASK_KEYS) || typeof task.id !== 'string' || !task.id || typeof task.projectId !== 'string' ||
      !projectMap.has(task.projectId) || typeof task.objective !== 'string' || !task.objective.trim() ||
      !['general', 'frontend', 'backend', 'algorithm'].includes(task.roleFocus) || !GRANULARITIES.has(task.granularity) ||
      typeof task.topic !== 'string' || !task.topic.trim()) { issues.push('generation-task-invalid'); continue }
    add(issues, taskMap.has(task.id), 'generation-task-id-duplicate')
    add(issues, objectiveSet.has(task.objective), 'generation-task-objective-duplicate')
    taskMap.set(task.id, task)
    objectiveSet.add(task.objective)
    languageCounts[projectMap.get(task.projectId).language]++
    granularityCounts[task.granularity]++
  }
  for (const language of LANGUAGES) add(issues, languageCounts[language] !== 4, 'generation-language-coverage-invalid')
  add(issues, granularityCounts.medium !== 7 || granularityCounts.fine !== 5, 'generation-granularity-coverage-invalid')

  const evidenceMap = new Map()
  for (const entry of bundle.fixedEvidenceInputs) {
    if (!exactKeys(entry, ['taskId', 'evidence']) || typeof entry.taskId !== 'string' || !Array.isArray(entry.evidence)) { issues.push('fixed-evidence-invalid'); continue }
    add(issues, evidenceMap.has(entry.taskId), 'fixed-evidence-task-duplicate')
    evidenceMap.set(entry.taskId, entry.evidence)
  }
  add(issues, evidenceMap.size !== taskMap.size || [...taskMap.keys()].some((id) => !evidenceMap.has(id)), 'fixed-evidence-not-bijective')
  for (const [taskId, refs] of evidenceMap) {
    const task = taskMap.get(taskId)
    if (!task) continue
    const project = projectMap.get(task.projectId)
    const seen = new Set()
    add(issues, refs.length === 0, 'fixed-evidence-empty')
    for (const ref of refs) {
      if (!exactKeys(ref, ['path', 'startLine', 'endLine', 'sha256'])) { issues.push('fixed-evidence-ref-invalid'); continue }
      const file = project.files.find((candidate) => candidate.path === ref.path)
      if (!safePath(ref.path) || !file || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) ||
        ref.startLine < 1 || ref.endLine < ref.startLine || !HASH.test(ref.sha256 ?? '')) { issues.push('fixed-evidence-ref-invalid'); continue }
      const rangeId = `${ref.path}:${ref.startLine}-${ref.endLine}`
      add(issues, seen.has(rangeId), 'fixed-evidence-ref-duplicate')
      seen.add(rangeId)
      const lines = file.content.split('\n')
      add(issues, ref.endLine > lines.length, 'fixed-evidence-range-invalid')
      if (ref.endLine <= lines.length) add(issues, hashEvidenceRange(file.content, ref.startLine, ref.endLine) !== ref.sha256, 'fixed-evidence-hash-invalid')
    }
  }
  return { valid: issues.length === 0, issues }
}

export function createGenerationMatrix(bundle) {
  const validation = validateGenerationProjection(bundle)
  if (!validation.valid) fail('dataset-invalid')
  const cells = []
  const schedule = [
    { repeat: 1, strategy: 'static-control' },
    { repeat: 1, strategy: 'agentic' },
    { repeat: 2, strategy: 'agentic' },
    { repeat: 2, strategy: 'static-control' }
  ]
  for (const task of bundle.tasks) {
    for (const { strategy, repeat } of schedule) {
      cells.push({ id: `${task.id}:${strategy}:repeat-${repeat}`, taskId: task.id, strategy, repeat, granularity: task.granularity })
    }
  }
  return cells
}

export function deriveGenerationBudgets(bundle) {
  const validation = validateGenerationProjection(bundle)
  if (!validation.valid) fail('dataset-invalid')
  const granularityCounts = { medium: 0, fine: 0 }
  for (const task of bundle.tasks) granularityCounts[task.granularity]++
  const matrixRuns = bundle.tasks.length * GENERATION_STRATEGIES.length * GENERATION_REPEATS.length
  const perRunMaxRequests = Object.fromEntries(Object.entries(GENERATION_REQUESTS_PER_RUN).map(([key, requests]) => [key, requests]))
  const matrixMaxRequests = GENERATION_STRATEGIES.length * GENERATION_REPEATS.length *
    Object.entries(granularityCounts).reduce((sum, [granularity, count]) => sum + count * perRunMaxRequests[granularity], 0)
  return {
    taskCounts: { ...granularityCounts },
    matrix: {
      runs: matrixRuns,
      maxRequests: matrixMaxRequests,
      maxInputTokens: matrixRuns * GENERATION_PER_RUN.inputTokens,
      maxOutputTokensTotal: matrixRuns * GENERATION_PER_RUN.outputTokens,
      maxWallClockMsTotal: matrixRuns * GENERATION_PER_RUN.wallClockMs
    },
    perRun: { ...GENERATION_PER_RUN, maxRequestsByGranularity: perRunMaxRequests }
  }
}

export function validateGenerationAuthorization(authorization, expected) {
  const codes = []
  const keys = ['purpose', 'reference', 'sourceCommit', 'generationDataHash', 'endpointFingerprint', 'model', 'protocol', 'temperature', 'reasoningEffort', 'contextWindowTokens', 'maxOutputTokens', 'maxRuns', 'maxRequests', 'maxInputTokens', 'maxOutputTokensTotal']
  if (!exactKeys(authorization, keys)) fail('authorization-invalid')
  const budgets = deriveGenerationBudgets(expected?.bundle)
  if (authorization.purpose !== GENERATION_PURPOSE || typeof authorization.reference !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/u.test(authorization.reference)) codes.push('authorization-invalid')
  if (!COMMIT.test(authorization.sourceCommit ?? '') || authorization.sourceCommit !== expected?.sourceCommit ||
    !HASH.test(authorization.generationDataHash ?? '') || authorization.generationDataHash !== expected?.generationDataHash) codes.push('authorization-binding-mismatch')
  if (!HASH.test(authorization.endpointFingerprint ?? '') || typeof authorization.model !== 'string' || !authorization.model || authorization.model.length > 160 ||
    !['openai', 'anthropic'].includes(authorization.protocol) || authorization.temperature !== 0.4 ||
    !(authorization.reasoningEffort === null || ['low', 'high'].includes(authorization.reasoningEffort)) ||
    !Number.isSafeInteger(authorization.contextWindowTokens) || authorization.contextWindowTokens <= authorization.maxOutputTokens) codes.push('authorization-invalid')
  if (!GENERATION_OUTPUT_CAPS.includes(authorization.maxOutputTokens) || authorization.maxRuns !== budgets.matrix.runs ||
    !Number.isSafeInteger(authorization.maxRequests) || authorization.maxRequests < 1 || authorization.maxRequests > budgets.matrix.maxRequests ||
    !Number.isSafeInteger(authorization.maxInputTokens) || authorization.maxInputTokens < 1 || authorization.maxInputTokens > budgets.matrix.maxInputTokens ||
    !Number.isSafeInteger(authorization.maxOutputTokensTotal) || authorization.maxOutputTokensTotal < 1 || authorization.maxOutputTokensTotal > budgets.matrix.maxOutputTokensTotal) codes.push('authorization-invalid')
  if (codes.length) fail([...new Set(codes)].includes('authorization-binding-mismatch') ? 'authorization-binding-mismatch' : 'authorization-invalid')
  return authorization
}

export function validateGenerationExecutionReport(report, bundle) {
  const issues = []
  const matrix = createGenerationMatrix(bundle)
  if (!isObject(report) || !Array.isArray(report.matrix) || report.purpose !== GENERATION_PURPOSE || report.qualityGate !== 'not-evaluated') {
    return { valid: false, executionComplete: false, issues: ['execution-report-invalid'] }
  }
  add(issues, report.matrix.length > matrix.length, 'execution-matrix-oversized')
  const expected = new Map(matrix.map((cell) => [cell.id, cell]))
  const seen = new Set()
  const sourceBindings = Object.create(null)
  const aggregate = { knownActual: { requests: 0, inputTokens: 0, outputTokens: 0 }, unknownReservations: [], conservativeCharged: { requests: 0, inputTokens: 0, outputTokens: 0 } }
  for (const cell of report.matrix) {
    const wanted = expected.get(cell?.id)
    if (!wanted || seen.has(cell.id)) { issues.push('execution-cell-invalid'); continue }
    seen.add(cell.id)
    add(issues, cell.taskId !== wanted.taskId || cell.strategy !== wanted.strategy || cell.repeat !== wanted.repeat || cell.granularity !== wanted.granularity, 'execution-cell-binding-invalid')
    const execution = cell.execution
    if (!isObject(execution) || !Array.isArray(cell.requests)) { issues.push('execution-cell-invalid'); continue }
    add(issues, !['succeeded', 'failed'].includes(execution.status) || !Number.isSafeInteger(execution.acceptedQuestionCount) || execution.acceptedQuestionCount < 0, 'execution-cell-status-invalid')
    const known = { requests: 0, inputTokens: 0, outputTokens: 0 }
    const unknown = []
    const charged = { requests: 0, inputTokens: 0, outputTokens: 0 }
    const requestIds = new Set()
    const manifested = new Map()
    for (const request of cell.requests) {
      if (!isObject(request) || typeof request.requestId !== 'string' || requestIds.has(request.requestId) || !isObject(request.reservation) || !isObject(request.manifest)) { issues.push('execution-request-invalid'); continue }
      requestIds.add(request.requestId)
      const reservation = request.reservation
      if (!Number.isSafeInteger(reservation.inputTokens) || reservation.inputTokens < 0 || !Number.isSafeInteger(reservation.outputTokens) || reservation.outputTokens < 0 || !['settled', 'unknown', 'unknown-unsent', 'dispatched', 'reserved'].includes(reservation.state)) { issues.push('execution-reservation-invalid'); continue }
      const hasUsage = isObject(request.usage) && Number.isSafeInteger(request.usage.inputTokens) && request.usage.inputTokens >= 0 &&
        Number.isSafeInteger(request.usage.outputTokens) && request.usage.outputTokens >= 0 && Number.isSafeInteger(request.usage.totalTokens) &&
        request.usage.totalTokens >= 0 && request.usage.totalTokens === request.usage.inputTokens + request.usage.outputTokens
      if (hasUsage && reservation.state !== 'settled' || !hasUsage && reservation.state === 'settled') issues.push('execution-usage-state-invalid')
      if (hasUsage) add(issues, request.usage.inputTokens > reservation.inputTokens || request.usage.outputTokens > reservation.outputTokens, 'execution-usage-over-reservation')
      if (hasUsage) {
        known.requests++
        known.inputTokens += request.usage.inputTokens
        known.outputTokens += request.usage.outputTokens
        charged.inputTokens += request.usage.inputTokens
        charged.outputTokens += request.usage.outputTokens
      } else if (['unknown', 'unknown-unsent', 'dispatched', 'reserved'].includes(reservation.state)) {
        unknown.push({ requestId: request.requestId, stage: request.stage, inputTokens: reservation.inputTokens, outputTokens: reservation.outputTokens })
        charged.inputTokens += reservation.inputTokens
        charged.outputTokens += reservation.outputTokens
      }
      charged.requests++

      const manifest = request.manifest
      const requiredArrays = ['selectedIds', 'requiredIds', 'packedIds', 'omitted', 'sources']
      if (manifest.version !== 1 || !HASH.test(manifest.manifestHash ?? '') || requiredArrays.some((key) => !Array.isArray(manifest[key]))) { issues.push('execution-manifest-invalid'); continue }
      const payload = { version: manifest.version, runId: manifest.runId, projectId: manifest.projectId, snapshotId: manifest.snapshotId, selectedIds: manifest.selectedIds, requiredIds: manifest.requiredIds, packedIds: manifest.packedIds, omitted: manifest.omitted, sources: manifest.sources, requestHash: manifest.requestHash, estimatedInputTokens: manifest.estimatedInputTokens, serializedChars: manifest.serializedChars, contextChars: manifest.contextChars, serializationOverheadTokens: manifest.serializationOverheadTokens, maxInputTokens: manifest.maxInputTokens, maxChars: manifest.maxChars }
      add(issues, sha256(Buffer.from(JSON.stringify(payload), 'utf8')) !== manifest.manifestHash, 'execution-manifest-hash-invalid')
      add(issues, manifest.packedIds.some((id) => !manifest.selectedIds.includes(id)) || manifest.requiredIds.some((id) => !manifest.packedIds.includes(id)), 'execution-manifest-membership-invalid')
      const sourceIds = new Set()
      for (const source of manifest.sources) {
        if (!isObject(source) || !Array.isArray(source.ids) || !safePath(source.relPath) || !isObject(source.displayRange) || !HASH.test(source.hash ?? '')) { issues.push('execution-source-invalid'); continue }
        for (const id of source.ids) {
          sourceIds.add(id)
          const binding = { path: source.relPath, displayRange: source.displayRange, originalRange: source.originalRange, hash: source.hash, sourceKind: source.sourceKind }
          const prior = sourceBindings[id]
          add(issues, prior && canonicalJson(prior) !== canonicalJson(binding), 'execution-source-binding-conflict')
          sourceBindings[id] = binding
        }
      }
      add(issues, manifest.packedIds.some((id) => !sourceIds.has(id)), 'execution-source-missing')
      manifested.set(request.requestId, manifest)
    }
    unknown.sort((a, b) => a.requestId.localeCompare(b.requestId))
    const usageComplete = cell.requests.length > 0 && cell.requests.every((request) => request.reservation?.state === 'settled' && request.usage)
    add(issues, execution.usageComplete !== usageComplete, 'execution-usage-complete-mismatch')
    for (const key of ['knownActual', 'conservativeCharged']) {
      const actual = execution[key]
      const expectedUsage = key === 'knownActual' ? known : charged
      add(issues, !isObject(actual) || ['requests', 'inputTokens', 'outputTokens'].some((name) => actual[name] !== expectedUsage[name]), 'execution-cost-mismatch')
    }
    add(issues, !Array.isArray(execution.unknownReservations) || canonicalJson(execution.unknownReservations) !== canonicalJson(unknown), 'execution-unknown-cost-mismatch')
    if (execution.status === 'succeeded') {
      add(issues, !execution.usageComplete || execution.lineageValid !== true || execution.acceptedQuestionCount < 1, 'execution-success-invalid')
      add(issues, typeof cell.resultFile !== 'string' || !/^case-\d{4}\.result\.json$/u.test(cell.resultFile) || typeof cell.sidecarFile !== 'string' || !/^case-\d{4}\.sidecar\.json$/u.test(cell.sidecarFile) || typeof cell.metadataFile !== 'string' || !/^case-\d{4}\.metadata\.json$/u.test(cell.metadataFile), 'execution-artifact-path-invalid')
      add(issues, !isObject(cell.artifactHashes) || ['result', 'sidecar', 'metadata'].some((key) => !HASH.test(cell.artifactHashes?.[key] ?? '')), 'execution-artifact-hash-invalid')
    }
    aggregate.knownActual.requests += known.requests
    aggregate.knownActual.inputTokens += known.inputTokens
    aggregate.knownActual.outputTokens += known.outputTokens
    aggregate.conservativeCharged.requests += charged.requests
    aggregate.conservativeCharged.inputTokens += charged.inputTokens
    aggregate.conservativeCharged.outputTokens += charged.outputTokens
    aggregate.unknownReservations.push(...unknown.map((item) => ({ cellId: cell.id, ...item })))
  }
  const expectedIds = new Set(matrix.map((cell) => cell.id))
  add(issues, seen.size !== expectedIds.size || [...expectedIds].some((id) => !seen.has(id)), 'execution-matrix-incomplete')
  add(issues, canonicalJson(report.sourceBindings) !== canonicalJson(sourceBindings), 'execution-source-bindings-mismatch')
  add(issues, !isObject(report.usage) || canonicalJson(report.usage) !== canonicalJson(aggregate), 'execution-total-cost-mismatch')
  add(issues, report.sourceStable !== true, 'execution-source-unstable')
  const complete = issues.length === 0 && report.matrix.length === matrix.length && report.matrix.every((cell) => cell.execution.status === 'succeeded') && aggregate.unknownReservations.length === 0
  add(issues, report.executionComplete !== complete, 'execution-complete-mismatch')
  add(issues, report.status !== (complete ? 'awaiting-review' : 'incomplete'), 'execution-status-mismatch')
  return { valid: issues.length === 0, executionComplete: complete && report.executionComplete === true, issues: [...new Set(issues)] }
}
