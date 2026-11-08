import { execFileSync } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { GRANULARITY_QUESTION_BUDGET } from '../../../shared/types.ts'
import { assertInterviewResultContract } from '../../../shared/result-contract.ts'
import { canonicalJson, sha256 } from '../dataset-contract.mjs'
import {
  GENERATION_PER_RUN, GENERATION_PURPOSE, GENERATION_REVIEW_PENDING,
  GENERATION_REQUESTS_PER_RUN,
  createGenerationMatrix, loadGenerationEvaluationBundle, validateGenerationExecutionReport
} from '../generation-eval-contract.mjs'
import { checkGenerationAuthorizationArtifact, verifyGenerationClaim } from '../generation-eval.mjs'
import {
  GENERATION_REVIEW_FILES, validateGenerationReviewBundle, verifyBlindedReviewPackets,
  fingerprintGenerationQuestion
} from '../generation-review.mjs'
import { unknownCheck } from '../gate-runner.mjs'

const HASH = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const LIMIT = Object.freeze({ report: 8 << 20, result: 8 << 20, sidecar: 2 << 20, metadata: 4 << 20, journal: 32 << 20, review: 64 << 20 })
const fail = code => { throw new Error(code) }
const isRecord = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const digest = bytes => sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'))
const add = (a, b) => { const n = a + b; return Number.isSafeInteger(n) ? n : fail('M08_OVERFLOW') }

function mergeRanges(values) {
  const sorted = [...values].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine)
  const merged = []
  for (const row of sorted) {
    const last = merged.at(-1)
    if (last && last.path === row.path && row.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, row.endLine)
    else merged.push({ path: row.path, startLine: row.startLine, endLine: row.endLine })
  }
  return merged
}

function validateFixedEvidence(cell, task, bundle) {
  const input = bundle.fixedEvidenceInputs.find(row => row.taskId === task.id)
  if (!input || !Array.isArray(input.evidence) || !input.evidence.length) fail('M08_FIXED_EVIDENCE_INVALID')
  const expected = mergeRanges(input.evidence.map(row => ({ path: row.path, startLine: row.startLine, endLine: row.endLine })))
  for (const request of cell.requests) {
    const sources = request.manifest?.sources
    if (!Array.isArray(sources) || request.manifest.projectId !== task.projectId || request.manifest.packedIds.length !== request.manifest.selectedIds.length ||
      request.manifest.requiredIds.length !== request.manifest.selectedIds.length || request.manifest.omitted.length !== 0) fail('M08_FIXED_EVIDENCE_MISMATCH')
    const actual = mergeRanges(sources.map(source => {
      const range = source?.originalRange
      if (!range || !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine)) fail('M08_FIXED_EVIDENCE_MISMATCH')
      return { path: source.relPath, startLine: range.startLine, endLine: range.endLine }
    }))
    if (!same(actual, expected)) fail('M08_FIXED_EVIDENCE_MISMATCH')
  }
}

function cleanCommit(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim()
  if (!COMMIT.test(commit) || status) fail('M08_SOURCE_NOT_FROZEN')
  return commit
}

async function safeRead(root, relative, maxBytes) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) fail('M08_PATH_INVALID')
  const base = await realpath(root), target = path.resolve(base, relative)
  const rel = path.relative(base, target)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) fail('M08_PATH_INVALID')
  let current = base
  for (const [index, part] of rel.split(path.sep).entries()) {
    current = path.join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0 ||
      (index < rel.split(path.sep).length - 1 && !stat.isDirectory()) ||
      (index === rel.split(path.sep).length - 1 && (!stat.isFile() || stat.size > maxBytes))) fail('M08_ARTIFACT_INVALID')
  }
  return readFile(target)
}

function parse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('M08_JSON_INVALID') }
}
function cellIdentity(cell) {
  return { id: cell.id, taskId: cell.taskId, strategy: cell.strategy, repeat: cell.repeat, actualOrder: cell.actualOrder, granularity: cell.granularity }
}
function safeOutputRoot(reportPath, report) {
  if (report.executionDir !== '.') fail('M08_EXECUTION_DIR_INVALID')
  return path.dirname(reportPath)
}

async function readCell(outputRoot, cell, task, authorization, complete, bundle) {
  const prefix = `case-${String(cell.actualOrder).padStart(4, '0')}`
  const identity = cellIdentity(cell)
  const metadataFile = cell.metadataFile
  if (metadataFile !== `${prefix}.metadata.json` && metadataFile !== `${prefix}.failure.json`) fail('M08_METADATA_PATH_INVALID')
  const metadataBytes = await safeRead(outputRoot, metadataFile, LIMIT.metadata)
  const metadata = parse(metadataBytes)
  if (!isRecord(cell.artifactHashes) || digest(metadataBytes) !== cell.artifactHashes.metadata) fail('M08_METADATA_HASH_INVALID')
  if (!complete && cell.execution?.status === 'failed') {
    if (cell.resultFile !== null || cell.sidecarFile !== null || Object.keys(cell.artifactHashes).join(',') !== 'metadata') fail('M08_PARTIAL_ARTIFACT_INVALID')
    if (!isRecord(metadata) || metadata.schemaVersion !== 1 || !same(metadata.cell, identity) || !same(metadata.execution, cell.execution) || !same(metadata.requests, cell.requests)) fail('M08_PARTIAL_METADATA_INVALID')
    const elapsed = cell.execution.elapsedMs
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || (elapsed >= GENERATION_PER_RUN.wallClockMs && (cell.execution.deadlineReason !== 'per-run-wall-clock' || cell.execution.errorCode !== 'timeout')) ||
      (cell.execution.deadlineReason !== undefined && cell.execution.deadlineReason !== 'per-run-wall-clock')) fail('M08_PARTIAL_WALL_CLOCK_INVALID')
    return { cell, requests: cell.requests }
  }
  if (cell.execution?.status !== 'succeeded' || cell.resultFile !== `${prefix}.result.json` || cell.sidecarFile !== `${prefix}.sidecar.json` ||
    metadataFile !== `${prefix}.metadata.json` ||
    Object.keys(cell.artifactHashes).sort().join(',') !== 'metadata,result,sidecar') fail('M08_CELL_ARTIFACT_INVALID')
  const [resultBytes, sidecarBytes] = await Promise.all([
    safeRead(outputRoot, cell.resultFile, LIMIT.result), safeRead(outputRoot, cell.sidecarFile, LIMIT.sidecar)
  ])
  if (digest(resultBytes) !== cell.artifactHashes.result || digest(sidecarBytes) !== cell.artifactHashes.sidecar) fail('M08_CELL_HASH_INVALID')
  const wrapper = parse(resultBytes), sidecar = parse(sidecarBytes)
  if (!isRecord(wrapper) || wrapper.schemaVersion !== 1 || !same(wrapper.cell, identity) || !isRecord(wrapper.result) || wrapper.result.projectPath !== 'source-fixture' ||
    !isRecord(metadata) || metadata.schemaVersion !== 1 || !same(metadata.cell, identity) || !same(metadata.requests, cell.requests) ||
    !same(metadata.usage, { usageComplete: cell.execution.usageComplete, knownActual: cell.execution.knownActual, unknownReservations: cell.execution.unknownReservations, conservativeCharged: cell.execution.conservativeCharged }) ||
    !isRecord(sidecar) || sidecar.version !== 1 || !Array.isArray(sidecar.questions)) fail('M08_CELL_WRAPPER_INVALID')
  try { assertInterviewResultContract(wrapper.result, () => true) } catch { fail('M08_RESULT_INVALID') }
  const result = wrapper.result
  if (result.granularity !== task.granularity || result.roleFocus !== task.roleFocus || result.sourceEvidenceSummary !== undefined ||
    result.sections.some(section => section.questions.some(question => question.sourceEvidence !== undefined))) fail('M08_RESULT_BINDING_INVALID')
  const questions = result.sections.flatMap(section => section.questions)
  const questionBudget = GRANULARITY_QUESTION_BUDGET[task.granularity]
  if (!questionBudget || questions.length < questionBudget.min || questions.length > questionBudget.max ||
    questions.length !== sidecar.questions.length || questions.length !== cell.execution.acceptedQuestionCount) fail('M08_QUESTION_COVERAGE_INVALID')
  const evidence = new Map(sidecar.questions.map(item => [item.questionId, item]))
  const requests = new Map(cell.requests.map(item => [item.requestId, item]))
  if (evidence.size !== sidecar.questions.length || !cell.requests.length || sidecar.runId !== cell.requests[0].manifest.runId ||
    sidecar.projectId !== task.projectId || sidecar.projectId !== cell.requests[0].manifest.projectId || sidecar.snapshotId !== cell.requests[0].manifest.snapshotId) fail('M08_SIDECAR_INVALID')
  for (const question of questions) {
    const binding = evidence.get(question.id), request = binding && requests.get(binding.requestId)
    if (!binding || !request || request.completion !== 'completed' || binding.manifestHash !== request.manifest.manifestHash ||
      binding.verification !== 'source-bound-unverified' || binding.questionFingerprint !== fingerprintGenerationQuestion(question) ||
      !Array.isArray(binding.evidenceIds) || !binding.evidenceIds.length || binding.evidenceIds.some(id => !request.manifest.packedIds.includes(id))) fail('M08_SIDECAR_LINEAGE_INVALID')
  }
  if (cell.execution.elapsedMs >= GENERATION_PER_RUN.wallClockMs || !Number.isSafeInteger(cell.execution.elapsedMs) || cell.execution.elapsedMs < 0) fail('M08_WALL_CLOCK_INVALID')
  const requestCap = GENERATION_REQUESTS_PER_RUN[task.granularity]
  if (!requestCap || cell.requests.length < 1 || cell.requests.length > requestCap) fail('M08_REQUEST_COUNT_INVALID')
  const known = { requests: 0, inputTokens: 0, outputTokens: 0 }
  let generationCount = 0, repairCount = 0, compensationCount = 0
  for (const request of cell.requests) {
    if (request.reservation?.state !== 'settled' || !isRecord(request.usage) || request.completion !== 'completed' ||
      !Number.isSafeInteger(request.usage.inputTokens) || !Number.isSafeInteger(request.usage.outputTokens) ||
      request.usage.totalTokens !== request.usage.inputTokens + request.usage.outputTokens ||
      request.usage.inputTokens > request.reservation.inputTokens || request.usage.outputTokens > request.reservation.outputTokens ||
      request.reservation.outputTokens > authorization.maxOutputTokens) fail('M08_USAGE_INVALID')
    known.requests++
    known.inputTokens = add(known.inputTokens, request.usage.inputTokens)
    known.outputTokens = add(known.outputTokens, request.usage.outputTokens)
    if (request.stage === 'generation') generationCount++
    else if (request.stage === 'repair') repairCount++
    else if (request.stage === 'compensation') compensationCount++
    else fail('M08_REQUEST_STAGE_INVALID')
  }
  if (known.inputTokens > GENERATION_PER_RUN.inputTokens || known.outputTokens > GENERATION_PER_RUN.outputTokens ||
    cell.execution.usageComplete !== true || cell.execution.lineageValid !== true || !same(cell.execution.knownActual, known) ||
    !same(cell.execution.conservativeCharged, known) || cell.execution.unknownReservations.length !== 0) fail('M08_CELL_USAGE_INVALID')
  const diagnostics = result.generationDiagnostics
  if (!isRecord(diagnostics) || diagnostics.status !== 'succeeded' || diagnostics.usageComplete !== true ||
    diagnostics.requestCount !== cell.requests.length || diagnostics.repairRequestCount !== repairCount ||
    diagnostics.compensationRequestCount !== compensationCount || !same(diagnostics.actualUsage, {
      inputTokens: known.inputTokens, outputTokens: known.outputTokens, totalTokens: known.inputTokens + known.outputTokens
    }) || !Number.isSafeInteger(diagnostics.totalMs) || diagnostics.totalMs < 0 || diagnostics.totalMs > GENERATION_PER_RUN.wallClockMs) fail('M08_DIAGNOSTICS_INVALID')
  validateFixedEvidence(cell, task, bundle)
  return { cell, result, sidecar, requests: cell.requests }
}

async function verifyJournal(outputRoot, report, cells) {
  if (!isRecord(report.journal) || report.journal.file !== 'progress.ndjson' || !HASH.test(report.journal.sha256 ?? '') || !Number.isSafeInteger(report.journal.entries)) fail('M08_JOURNAL_BINDING_INVALID')
  const bytes = await safeRead(outputRoot, 'progress.ndjson', LIMIT.journal)
  if (digest(bytes) !== report.journal.sha256) fail('M08_JOURNAL_HASH_INVALID')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text && !text.endsWith('\n')) fail('M08_JOURNAL_TRUNCATED')
  const events = text.split('\n').filter(Boolean).map(line => parse(Buffer.from(line)))
  if (events.length !== report.journal.entries) fail('M08_JOURNAL_COUNT_INVALID')
  const requests = new Map(cells.flatMap(item => item.requests.map(request => [request.requestId, { cell: item.cell, request }])))
  const admitted = new Map(), usage = new Map(), unknown = new Map(), starts = new Map(), terminals = new Map()
  const cellByOrder = new Map(cells.map(item => [item.cell.actualOrder, item.cell]))
  for (const event of events) {
    if (!isRecord(event)) fail('M08_JOURNAL_EVENT_INVALID')
    if (event.type === 'request-admitted') {
      if (Object.keys(event).sort().join(',') !== ['atCell','contextChars','estimatedInputTokens','estimatedOutputTokens','requestId','runId','type'].sort().join(',') ||
        admitted.has(event.requestId) || !requests.has(event.requestId)) fail('M08_JOURNAL_ADMISSION_INVALID')
      admitted.set(event.requestId, event)
    } else if (event.type === 'provider-usage') {
      if (Object.keys(event).sort().join(',') !== ['atCell','requestId','runId','type','usage'].sort().join(',') || usage.has(event.requestId) || !requests.has(event.requestId)) fail('M08_JOURNAL_USAGE_INVALID')
      usage.set(event.requestId, event)
    } else if (event.type === 'usage-unknown') {
      if (Object.keys(event).sort().join(',') !== ['atCell','reason','requestId','runId','type'].sort().join(',') || unknown.has(event.requestId) || !requests.has(event.requestId)) fail('M08_JOURNAL_UNKNOWN_INVALID')
      unknown.set(event.requestId, event)
    } else if (event.type === 'cell-started') {
      const order = event.cell?.actualOrder, expected = cellByOrder.get(order)
      if (!expected || starts.has(order) || Object.keys(event).sort().join(',') !== ['cell','evidenceCount','type'].sort().join(',') ||
        !same(event.cell, cellIdentity(expected)) || !Number.isSafeInteger(event.evidenceCount) || event.evidenceCount < 1) fail('M08_JOURNAL_CELL_INVALID')
      starts.set(order, event)
    } else if (event.type === 'cell-completed' || event.type === 'cell-failed') {
      const order = event.case, expected = cellByOrder.get(order), prior = terminals.get(order)
      const success = event.type === 'cell-completed'
      const wantedKeys = success
        ? ['type','case','requestCount','acceptedQuestionCount','usageComplete','lineageValid','elapsedMs']
        : ['type','case','errorCode','acceptedQuestionCount','usageComplete','elapsedMs', ...(event.deadlineReason !== undefined ? ['deadlineReason'] : [])]
      if (!expected || !starts.has(order) || Object.keys(event).sort().join(',') !== wantedKeys.sort().join(',') ||
        (prior && !(prior.type === 'cell-completed' && !success))) fail('M08_JOURNAL_TERMINAL_INVALID')
      if (!Number.isSafeInteger(event.elapsedMs) || event.elapsedMs < 0 || (success && event.elapsedMs >= GENERATION_PER_RUN.wallClockMs) ||
        (!success && event.deadlineReason !== undefined && (event.deadlineReason !== 'per-run-wall-clock' || event.errorCode !== 'timeout' || event.elapsedMs < GENERATION_PER_RUN.wallClockMs)) ||
        (!success && event.elapsedMs >= GENERATION_PER_RUN.wallClockMs && event.deadlineReason !== 'per-run-wall-clock')) fail('M08_JOURNAL_DEADLINE_INVALID')
      terminals.set(order, event)
    } else if (event.type === 'generation-progress') {
      if (Object.keys(event).sort().join(',') !== ['case','percent','type'].sort().join(',') || !starts.has(event.case) ||
        !Number.isSafeInteger(event.percent) || event.percent < 0 || event.percent > 100) fail('M08_JOURNAL_PROGRESS_INVALID')
    } else fail('M08_JOURNAL_EVENT_UNKNOWN')
  }
  if (admitted.size !== requests.size) fail('M08_JOURNAL_ADMISSION_COVERAGE_INVALID')
  for (const [id, row] of requests) {
    const a = admitted.get(id), u = usage.get(id), unk = unknown.get(id), req = row.request
    if (!a || a.atCell !== row.cell.actualOrder || a.runId !== req.manifest.runId || a.estimatedInputTokens !== req.reservation.inputTokens ||
      a.estimatedOutputTokens !== req.reservation.outputTokens || a.contextChars !== req.manifest.contextChars) fail('M08_JOURNAL_ADMISSION_MISMATCH')
    if (req.reservation.state === 'settled') {
      if (!u || unk || u.atCell !== row.cell.actualOrder || u.runId !== req.manifest.runId || !same(u.usage, req.usage)) fail('M08_JOURNAL_USAGE_MISMATCH')
    } else if (req.reservation.state === 'unknown') {
      if (!unk || u || unk.atCell !== row.cell.actualOrder || unk.runId !== req.manifest.runId) fail('M08_JOURNAL_UNKNOWN_MISMATCH')
    } else fail('M08_JOURNAL_STATE_INVALID')
  }
  for (const item of cells) {
    const order = item.cell.actualOrder, start = starts.get(order), terminal = terminals.get(order)
    if (!start || !terminal || terminal.elapsedMs !== item.cell.execution.elapsedMs ||
      (terminal.type === 'cell-completed') !== (item.cell.execution.status === 'succeeded') ||
      terminal.acceptedQuestionCount !== item.cell.execution.acceptedQuestionCount ||
      (terminal.type === 'cell-completed' && (terminal.requestCount !== item.requests.length || terminal.usageComplete !== true || terminal.lineageValid !== true)) ||
      (terminal.type === 'cell-failed' && (terminal.errorCode !== item.cell.execution.errorCode || terminal.usageComplete !== item.cell.execution.usageComplete ||
        terminal.deadlineReason !== item.cell.execution.deadlineReason))) fail('M08_JOURNAL_CELL_EXECUTION_MISMATCH')
  }
  if (report.executionComplete && (starts.size !== cells.length || terminals.size !== cells.length || unknown.size)) fail('M08_JOURNAL_COVERAGE_INVALID')
  return events
}

function validateGlobalCollector(report, cells, authorization) {
  const collector = report.globalCollector
  if (!isRecord(collector) || !Array.isArray(collector.entries)) fail('M08_GLOBAL_COLLECTOR_INVALID')
  const requests = cells.flatMap(item => item.requests)
  const entries = new Map(collector.entries.map(item => [item.requestId, item]))
  if (entries.size !== requests.length || collector.entries.length !== requests.length || collector.admittedRequests !== requests.length) fail('M08_GLOBAL_COLLECTOR_COVERAGE_INVALID')
  let input = 0, output = 0
  for (const request of requests) {
    const row = entries.get(request.requestId)
    if (!row || row.runId !== request.manifest.runId || row.state !== 'settled' || row.estimatedInputTokens !== request.reservation.inputTokens ||
      row.estimatedOutputTokens !== request.reservation.outputTokens || row.contextChars !== request.manifest.contextChars || !same(row.usage, request.usage)) fail('M08_GLOBAL_COLLECTOR_ENTRY_INVALID')
    input = add(input, request.usage.inputTokens)
    output = add(output, request.usage.outputTokens)
  }
  if (collector.blocked !== false || collector.reservedInputTokens !== 0 || collector.reservedOutputTokens !== 0 ||
    collector.actualInputTokens !== input || collector.actualOutputTokens !== output ||
    requests.length > authorization.maxRequests || input > authorization.maxInputTokens || output > authorization.maxOutputTokensTotal) fail('M08_GLOBAL_COLLECTOR_TOTAL_INVALID')
  const reportUsage = report.usage
  const expected = { knownActual: { requests: requests.length, inputTokens: input, outputTokens: output }, unknownReservations: [], conservativeCharged: { requests: requests.length, inputTokens: input, outputTokens: output } }
  if (!same(reportUsage, expected)) fail('M08_AGGREGATE_USAGE_INVALID')
}

/** Test-only raw-artifact path; refuses real reports and never changes production gate authorization. */
export async function validateM08SyntheticRawArtifactsForTest({ report, outputRoot, bundle, authorization }) {
  if (!isRecord(report) || report.mode !== 'synthetic' || report.executionComplete !== true ||
    !isRecord(authorization) || authorization.maxRequests !== 419 || authorization.maxOutputTokens !== 32_768) fail('M08_TEST_FIXTURE_INVALID')
  const structural = validateGenerationExecutionReport(report, bundle)
  if (!structural.valid || !structural.executionComplete || report.matrix.length !== 48) fail('M08_TEST_FIXTURE_INVALID')
  const tasks = new Map(bundle.tasks.map(task => [task.id, task]))
  const cells = []
  for (const cell of report.matrix) cells.push(await readCell(outputRoot, cell, tasks.get(cell.taskId), authorization, true, bundle))
  await verifyJournal(outputRoot, report, cells)
  validateGlobalCollector(report, cells, authorization)
  return Object.freeze({ cells: cells.length, requests: cells.reduce((sum, row) => add(sum, row.requests.length), 0) })
}

function validateRubric(bytes) {
  const rubric = parse(bytes)
  if (rubric.rubricVersion !== 2 || rubric.labels !== null || rubric.blindReview?.independentReviewersRequired !== 2 ||
    rubric.blindReview?.thirdAdjudicatorOnAnyDisagreement !== true || rubric.blindReview?.hideStrategyLabels !== true ||
    rubric.blindReview?.hideAuthorLabels !== true || rubric.blindReview?.reviewAllPrimaryAnswersAndFollowups !== true ||
    rubric.blindReview?.model !== 'gpt-6-luna' || rubric.blindReview?.reviewerKind !== 'independent-subagent') fail('M08_RUBRIC_INVALID')
  return digest(bytes)
}

export function createChecks(options = {}) {
  return new Map([['m08:frozen-sufficient-evidence-tasks', async ctx => {
    if (ctx.mode !== 'real') return unknownCheck('real-report-required')
    try {
      const sourceRoot = await realpath(path.resolve(options.sourceRoot ?? process.cwd()))
      if (typeof options.reportPath !== 'string' || !options.reportPath) fail('M08_REPORT_PATH_REQUIRED')
      const reportPath = path.resolve(options.reportPath)
      const report = parse(await safeRead(path.dirname(reportPath), path.basename(reportPath), LIMIT.report))
      const [binding, bundle] = await Promise.all([
        checkGenerationAuthorizationArtifact({ repoRoot: sourceRoot, authorizationPath: path.resolve(options.authorizationPath ?? '') }),
        loadGenerationEvaluationBundle(path.join(sourceRoot, 'scripts/agentic/datasets/v1'))
      ])
      const commit = cleanCommit(sourceRoot)
      if (commit !== binding.sourceCommit || !isRecord(report) || report.purpose !== GENERATION_PURPOSE || report.qualityGate !== 'not-evaluated' ||
        report.sourceBinding?.sourceCommit !== commit || report.sourceBinding?.generationDataHash !== bundle.generationDataHash ||
        !same(report.sourceBinding?.sourceHashes, bundle.sourceHashes) || report.configurationBinding?.maxOutputTokens !== binding.authorization.maxOutputTokens) fail('M08_SOURCE_BINDING_INVALID')
      const claimId = digest(Buffer.from(commit + '\0' + GENERATION_PURPOSE + '\0' + binding.reference, 'utf8'))
      if (report.authorizationBinding?.reference !== binding.reference || report.authorizationBinding?.claimId !== claimId) fail('M08_CLAIM_BINDING_INVALID')
      await verifyGenerationClaim({ repoRoot: sourceRoot, authorization: binding.authorization, claimPath: path.join(sourceRoot, '.validation/agentic/claims', `${claimId}.json`) })
      const marker = parse(await safeRead(sourceRoot, `.validation/agentic/claims/${claimId}.started`, 1024))
      if (marker.claimId !== claimId || marker.state !== 'started') fail('M08_CLAIM_NOT_STARTED')
      const expectedBudgets = {
        maxRuns: binding.authorization.maxRuns, maxRequests: binding.authorization.maxRequests,
        maxInputTokens: binding.authorization.maxInputTokens, maxOutputTokensTotal: binding.authorization.maxOutputTokensTotal,
        maxOutputTokensPerRequest: binding.authorization.maxOutputTokens
      }
      if (!same(report.budgets, expectedBudgets) || !same(report.configurationBinding, {
        endpointFingerprint: binding.authorization.endpointFingerprint, model: binding.authorization.model, protocol: binding.authorization.protocol,
        temperature: binding.authorization.temperature, reasoningEffort: binding.authorization.reasoningEffort,
        contextWindowTokens: binding.authorization.contextWindowTokens, maxOutputTokens: binding.authorization.maxOutputTokens
      }) || report.configurationHash !== digest(canonicalJson(report.configurationBinding))) fail('M08_CONFIGURATION_OR_BUDGET_INVALID')
      const checked = validateGenerationExecutionReport(report, bundle)
      const complete = checked.executionComplete && report.executionComplete === true && report.status === 'awaiting-review' && report.reviewState === GENERATION_REVIEW_PENDING
      if (complete && !checked.valid) fail('M08_EXECUTION_REPORT_INVALID')
      if (!Array.isArray(report.matrix) || report.matrix.length > 48 || (complete && report.matrix.length !== 48)) fail('M08_MATRIX_INCOMPLETE')
      const expectedMatrix = createGenerationMatrix(bundle)
      if (report.matrix.some((cell, index) => !same(
        { id: cell.id, taskId: cell.taskId, strategy: cell.strategy, repeat: cell.repeat, granularity: cell.granularity },
        expectedMatrix[index]
      ) || cell.actualOrder !== index + 1 || cell.caseNumber !== index + 1)) fail('M08_MATRIX_ORDER_INVALID')
      if (!complete && (report.executionComplete !== false || report.status !== 'incomplete' || report.reviewState !== 'blocked')) fail('M08_EXECUTION_STATUS_INVALID')
      const taskById = new Map(bundle.tasks.map(task => [task.id, task]))
      const outputRoot = safeOutputRoot(reportPath, report)
      const cells = []
      for (const cell of report.matrix) cells.push(await readCell(outputRoot, cell, taskById.get(cell.taskId), binding.authorization, complete, bundle))
      await verifyJournal(outputRoot, report, cells)
      if (!complete) return unknownCheck('m08-execution-incomplete')
      validateGlobalCollector(report, cells, binding.authorization)
      const rubricBytes = await safeRead(sourceRoot, 'scripts/agentic/assets/review-rubric.v2.json', 128 * 1024)
      const rubricSha256 = validateRubric(rubricBytes)
      const readReview = async name => parse(await safeRead(outputRoot, path.join('review', name), LIMIT.review))
      const [packetSet, privateMap, reviewerA, reviewerB, adjudication, invocations] = await Promise.all([
        readReview(GENERATION_REVIEW_FILES.packets), readReview(GENERATION_REVIEW_FILES.privateMap),
        readReview(GENERATION_REVIEW_FILES.reviewerA), readReview(GENERATION_REVIEW_FILES.reviewerB),
        readReview(GENERATION_REVIEW_FILES.adjudication), readReview(GENERATION_REVIEW_FILES.invocations)
      ])
      const packetCheck = verifyBlindedReviewPackets({ bundle, cells, sourceBindings: report.sourceBindings, rubricSha256, packetSet, privateMap })
      if (!packetCheck) fail('M08_BLIND_PACKET_INVALID')
      const hashes = {}
      for (const [key, file] of [['reviewerA', GENERATION_REVIEW_FILES.reviewerA], ['reviewerB', GENERATION_REVIEW_FILES.reviewerB], ['adjudication', GENERATION_REVIEW_FILES.adjudication]]) {
        hashes[key] = digest(await safeRead(outputRoot, path.join('review', file), LIMIT.review))
      }
      const reviewed = validateGenerationReviewBundle({ packetSet, privateMap, reviewerA, reviewerB, adjudication, invocations, outputHashes: hashes, usageComplete: true })
      const metrics = reviewed.metrics
      for (const [id, value] of Object.entries(metrics)) ctx.recordMetric(id, value, `m08-review:${reviewed.packetSetSha256}`)
      ctx.addRawReference(`m08-review-bundle:${reviewed.packetSetSha256}`)
      const limits = ctx.definition?.limits
      if (!isRecord(limits) || limits.tasks !== 12 || limits.repeatsPerStrategy !== 2 || limits.unpackedEvidenceCitedMax !== 0 ||
        limits.materialErrorRateAtMostStatic !== true || !Number.isFinite(limits.topicValueDeltaMin) ||
        metrics.unpackedEvidenceCited > limits.unpackedEvidenceCitedMax || metrics.materialErrorRate > metrics.staticControlMaterialErrorRate ||
        metrics.topicValueMean < metrics.staticControlTopicValueMean + limits.topicValueDeltaMin || metrics.usageComplete !== true) {
        const error = new Error('M08_QUALITY_THRESHOLD_FAILED')
        error.gateFailure = true
        throw error
      }
      return metrics
    } catch (error) {
      if (error?.gateFailure === true) throw error
      return unknownCheck(typeof error?.message === 'string' && /^M08_[A-Z0-9_]+$/u.test(error.message) ? error.message.toLowerCase() : 'm08-verification-failed')
    }
  }]])
}

export const checks = createChecks()
