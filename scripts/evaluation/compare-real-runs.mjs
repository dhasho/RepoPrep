import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { calculateReportDigest } from './review.mjs'
import { flattenQuestions, fingerprintQuestion } from './scorer.mjs'

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function questionFingerprints(questions, caseId) {
  if (!Array.isArray(questions)) return null
  return questions.map(question => fingerprintQuestion(question.question, {
    caseId,
    variant: 'generation',
    answer: question.answer ?? '',
    followUps: question.followUps ?? [],
    sourceEvidence: question.sourceEvidence ?? []
  })).sort()
}

function verifyGenerationBinding(run, item, label) {
  if (item.generation.output !== undefined && canonical(item.generation.output) !== canonical(item.output)) {
    throw new Error(`${label} canonical generation output differs for ${item.id}`)
  }
  if (item.generation.diagnostics !== undefined && canonical(item.generation.diagnostics) !== canonical(item.output.evaluationDiagnostics)) {
    throw new Error(`${label} generation diagnostics differ from the canonical output for ${item.id}`)
  }
  const outputQuestions = questionFingerprints(flattenQuestions(item.output), item.id)
  const generationQuestions = questionFingerprints(item.generation.questions, item.id)
  const reportQuestions = questionFingerprints(run.questions.filter(question => question.caseId === item.id && question.variant === 'generation'), item.id)
  if (!outputQuestions || canonical(outputQuestions) !== canonical(generationQuestions) || canonical(generationQuestions) !== canonical(reportQuestions)) {
    throw new Error(`${label} generation questions are not bound consistently for ${item.id}`)
  }
}

function assertComparable(run, label) {
  if (run?.schemaVersion !== 'repoprep-eval-report-v2' || run.status !== 'complete') throw new Error(`${label} report is missing or partial`)
  if (calculateReportDigest(run) !== run.reportDigest) throw new Error(`${label} report digest does not match`)
  if (!Array.isArray(run.cases) || !run.cases.length || !Array.isArray(run.questions) || !run.config || !run.config.variants?.includes('generation')) throw new Error(`${label} report has no generation variant`)
  if (!run.fixtureHashes || typeof run.fixtureHashes !== 'object' || Array.isArray(run.fixtureHashes)) throw new Error(`${label} report has no fixture hashes`)
  if (run.configHashInputs) {
    const expectedConfigHash = hash(JSON.stringify({ config: run.config, ...run.configHashInputs }))
    if (expectedConfigHash !== run.configHash) throw new Error(`${label} config hash does not match its configuration`)
  }
  const cases = new Map()
  for (const item of run.cases) {
    if (!item?.id || cases.has(item.id) || !/^[a-f0-9]{40}$/iu.test(item.commit ?? '') || !item.generation || (item.generation.status && item.generation.status !== 'complete') || !item.output) throw new Error(`${label} report has an incomplete generation case`)
    if (!Array.isArray(item.generation.questions)) throw new Error(`${label} report is missing generation questions`)
    const fixtureEntries = Object.entries(run.fixtureHashes).filter(([key]) => key.startsWith(`${item.id}/`))
    if (!fixtureEntries.length || fixtureEntries.some(([, digest]) => !/^[a-f0-9]{64}$/iu.test(digest ?? ''))) throw new Error(`${label} report has incomplete fixture hashes for ${item.id}`)
    verifyGenerationBinding(run, item, label)
    cases.set(item.id, item)
  }
  return cases
}

function comparableSettings(run) {
  return {
    model: run.model,
    protocol: run.protocol,
    granularity: run.config.granularity,
    budget: run.config.budget,
    temperature: run.config.temperature
  }
}

function tokenConditions(run) {
  return {
    contextWindowTokens: run.config.contextWindowTokens ?? null,
    profileMaxOutputTokens: run.config.profileMaxOutputTokens ?? null,
    maxOutputTokens: run.config.maxOutputTokens ?? null,
    maxOutputTokensPolicy: run.config.maxOutputTokensPolicy ?? null,
    applicationInputTokenTarget: run.config.applicationInputTokenTarget ?? null,
    applicationInputTokenBudget: run.config.applicationInputTokenBudget ?? null,
    reservedOutputTokens: run.config.reservedOutputTokens ?? null,
    reservedOutputPolicy: run.config.reservedOutputPolicy ?? null,
    inputTokenBudgetPolicy: run.config.inputTokenBudgetPolicy ?? null,
    contextStrategy: run.config.contextStrategy ?? null,
    tokenEstimateMethod: run.config.tokenEstimateMethod ?? null
  }
}

function metricValue(record, diagnostics, key) {
  const value = diagnostics?.[key] ?? record?.[key]
  return Number.isFinite(value) && value >= 0 ? value : null
}

function caseMetrics(item) {
  const generation = item.generation
  const diagnostics = generation.diagnostics ?? null
  const requests = Array.isArray(generation.requests) ? generation.requests : []
  const requestCount = Number.isFinite(generation.requestCount) ? generation.requestCount : requests.length
  const actualUsage = diagnostics?.usageComplete === true && diagnostics.actualUsage &&
    ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isFinite(diagnostics.actualUsage[key]) && diagnostics.actualUsage[key] >= 0)
    ? diagnostics.actualUsage
    : generation.tokens && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isFinite(generation.tokens[key]) && generation.tokens[key] >= 0)
      ? generation.tokens
      : null
  const repairRequests = diagnostics && Number.isFinite(diagnostics.repairRequestCount)
    ? diagnostics.repairRequestCount
    : requests.filter(request => request.attempt === 'repair').length
  const facts = generation.scored?.knownFactCoverage
  return {
    questions: generation.questions.length,
    requestCount,
    elapsedMs: metricValue(generation, null, 'elapsedMs'),
    generationMs: metricValue(diagnostics, null, 'totalMs'),
    actualUsage,
    estimatedInputTokens: metricValue(diagnostics, null, 'estimatedInputTokens'),
    repairRequests,
    compensationRequests: metricValue(diagnostics, null, 'compensationRequestCount'),
    formatRepairs: repairRequests,
    contextBuildMs: metricValue(diagnostics, null, 'contextBuildMs'),
    modelMs: metricValue(diagnostics, null, 'modelMs'),
    selection: diagnostics ? {
      selectedFiles: metricValue(diagnostics, null, 'selectedFiles'),
      selectedRegions: metricValue(diagnostics, null, 'selectedRegions'),
      omittedFiles: metricValue(diagnostics, null, 'omittedFiles')
    } : null,
    keywordCoverage: facts && Number.isFinite(facts.covered) && Number.isFinite(facts.total)
      ? { covered: facts.covered, total: facts.total }
      : null
  }
}

function aggregate(records, key) {
  const values = records.map(record => record[key])
  return values.every(value => Number.isFinite(value)) ? values.reduce((sum, value) => sum + value, 0) : null
}

function aggregateUsage(records) {
  const values = records.map(record => record.actualUsage)
  if (!values.every(Boolean)) return null
  return Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].map(key => [key, values.reduce((sum, item) => sum + item[key], 0)]))
}

function runSummary(records) {
  const facts = records.map(record => record.keywordCoverage)
  const covered = facts.every(Boolean) ? facts.reduce((sum, item) => sum + item.covered, 0) : null
  const total = facts.every(Boolean) ? facts.reduce((sum, item) => sum + item.total, 0) : null
  return {
    questions: aggregate(records, 'questions'),
    requests: aggregate(records, 'requestCount'),
    elapsedMs: aggregate(records, 'elapsedMs'),
    generationMs: aggregate(records, 'generationMs'),
    actualUsage: aggregateUsage(records),
    estimatedInputTokens: aggregate(records, 'estimatedInputTokens'),
    repairRequests: aggregate(records, 'repairRequests'),
    compensationRequests: aggregate(records, 'compensationRequests'),
    formatRepairs: aggregate(records, 'formatRepairs'),
    contextBuildMs: aggregate(records, 'contextBuildMs'),
    modelMs: aggregate(records, 'modelMs'),
    keywordCoverage: covered === null ? null : { covered, total }
  }
}

export function compareRealRuns(baselineRun, candidateRun) {
  const baselineCases = assertComparable(baselineRun, 'baseline')
  const candidateCases = assertComparable(candidateRun, 'candidate')
  if (baselineRun.corpusVersion !== candidateRun.corpusVersion) throw new Error('corpus versions differ')
  if (canonical(comparableSettings(baselineRun)) !== canonical(comparableSettings(candidateRun))) throw new Error('generation settings differ')
  if (canonical(baselineRun.fixtureHashes) !== canonical(candidateRun.fixtureHashes)) throw new Error('fixture hashes differ')
  if (baselineCases.size !== candidateCases.size || [...baselineCases.keys()].some(id => !candidateCases.has(id))) throw new Error('case sets differ')
  const cases = [...baselineCases.keys()].sort().map(id => {
    const baseline = baselineCases.get(id)
    const candidate = candidateCases.get(id)
    if (baseline.commit !== candidate.commit || baseline.repository !== candidate.repository) throw new Error(`case revision differs: ${id}`)
    if (baseline.granularity !== candidate.granularity || canonical(baseline.budget) !== canonical(candidate.budget)) throw new Error(`case budget differs: ${id}`)
    if (canonical(baselineRun.fixtureHashes?.[id] ?? null) !== canonical(candidateRun.fixtureHashes?.[id] ?? null)) throw new Error(`case fixture differs: ${id}`)
    return { id, baseline: caseMetrics(baseline), candidate: caseMetrics(candidate) }
  })
  const sourceHashPaths = new Set([...Object.keys(baselineRun.sourceHashes ?? {}), ...Object.keys(candidateRun.sourceHashes ?? {})])
  const sourceHashChanges = [...sourceHashPaths].sort().flatMap(file => {
    const before = baselineRun.sourceHashes?.[file] ?? null
    const after = candidateRun.sourceHashes?.[file] ?? null
    return before === after ? [] : [{ file, baseline: before, candidate: after }]
  })
  return {
    schemaVersion: 'repoprep-real-run-comparison-v1',
    corpusVersion: baselineRun.corpusVersion,
    model: baselineRun.model,
    protocol: baselineRun.protocol,
    config: comparableSettings(candidateRun),
    inputReportHashes: {
      baseline: hash(canonical(baselineRun)),
      candidate: hash(canonical(candidateRun))
    },
    conditions: { baseline: tokenConditions(baselineRun), candidate: tokenConditions(candidateRun) },
    sourceHashChanges,
    baseline: { runId: baselineRun.runId, generatedAt: baselineRun.generatedAt, summary: runSummary(cases.map(item => item.baseline)) },
    candidate: { runId: candidateRun.runId, generatedAt: candidateRun.generatedAt, summary: runSummary(cases.map(item => item.candidate)) },
    cases,
    caveats: [
      'Actual provider token totals are null when complete usage receipts are unavailable.',
      'Estimated input tokens are application estimates and are reported separately from provider usage.',
      'Keyword fact coverage counts configured keyword matches; it is not factual accuracy.',
      'This comparison does not treat assistant review as human review.',
      'The legacy report digest does not bind generation metadata; the comparator checks canonical output and question cross-links and records hashes of both complete input reports.'
    ]
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : 'unknown'
}

function formatScalar(value) {
  if (typeof value === 'string' && value.length) return value
  if (typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') return canonical(value)
  return formatNumber(value)
}

export function comparisonMarkdown(comparison) {
  const rows = [
    ['Questions', 'questions'], ['Requests', 'requests'], ['Elapsed ms (scan + generation)', 'elapsedMs'], ['Generator phase ms', 'generationMs'],
    ['Actual input tokens', ['actualUsage', 'inputTokens']], ['Actual output tokens', ['actualUsage', 'outputTokens']],
    ['Estimated input tokens', 'estimatedInputTokens'], ['Format repair requests', 'formatRepairs'],
    ['Compensation requests', 'compensationRequests'], ['Context build ms', 'contextBuildMs'],
    ['Model ms', 'modelMs'], ['Keyword coverage (hits / facts)', ['keywordCoverage', 'covered']]
  ]
  const valueFor = (summary, key) => Array.isArray(key) ? summary[key[0]]?.[key[1]] : summary[key]
  const conditionRows = Object.keys(comparison.conditions.candidate).map(key =>
    `| ${key} | ${formatScalar(comparison.conditions.baseline[key])} | ${formatScalar(comparison.conditions.candidate[key])} |`
  )
  const sourceRows = comparison.sourceHashChanges.length
    ? comparison.sourceHashChanges.map(item => `| ${item.file} | ${item.baseline ?? 'absent'} | ${item.candidate ?? 'absent'} |`)
    : ['| none | unchanged | unchanged |']
  const lines = [
    '# Real evaluation comparison', '',
    `- Corpus: ${comparison.corpusVersion}`,
    `- Model: ${comparison.model} (${comparison.protocol})`,
    `- Baseline run: ${comparison.baseline.runId}`,
    `- Candidate run: ${comparison.candidate.runId}`,
    `- Source hash changes: ${comparison.sourceHashChanges.length}`,
    `- Baseline report SHA-256: ${comparison.inputReportHashes.baseline}`,
    `- Candidate report SHA-256: ${comparison.inputReportHashes.candidate}`,
    '', '| Metric | Baseline | Candidate |', '|---|---:|---:|',
    ...rows.map(([label, key]) => `| ${label} | ${formatNumber(valueFor(comparison.baseline.summary, key))} | ${formatNumber(valueFor(comparison.candidate.summary, key))} |`),
    '', '## Cases', '',
    '| Case | Baseline questions / requests / ms | Candidate questions / requests / ms | Baseline keyword hits | Candidate keyword hits |',
    '|---|---:|---:|---:|---:|',
    ...comparison.cases.map(item => `| ${item.id} | ${formatNumber(item.baseline.questions)} / ${formatNumber(item.baseline.requestCount)} / ${formatNumber(item.baseline.elapsedMs)} | ${formatNumber(item.candidate.questions)} / ${formatNumber(item.candidate.requestCount)} / ${formatNumber(item.candidate.elapsedMs)} | ${item.baseline.keywordCoverage ? `${item.baseline.keywordCoverage.covered}/${item.baseline.keywordCoverage.total}` : 'unknown'} | ${item.candidate.keywordCoverage ? `${item.candidate.keywordCoverage.covered}/${item.candidate.keywordCoverage.total}` : 'unknown'} |`),
    '', '## Token and context conditions', '',
    '| Setting | Baseline | Candidate |', '|---|---:|---:|', ...conditionRows,
    '', '## Source hash changes', '',
    '| File | Baseline SHA-256 | Candidate SHA-256 |', '|---|---|---|', ...sourceRows,
    '', '## Limitations', '', ...comparison.caveats.map(item => `- ${item}`)
  ]
  return `${lines.join('\n')}\n`
}

async function main() {
  const [baselinePath, candidatePath, ...rest] = process.argv.slice(2)
  if (!baselinePath || !candidatePath || rest.length) throw new Error('usage: compare-real-runs.mjs <baseline-report.json> <candidate-report.json>')
  const baseline = JSON.parse(await readFile(path.resolve(baselinePath), 'utf8'))
  const candidate = JSON.parse(await readFile(path.resolve(candidatePath), 'utf8'))
  process.stdout.write(comparisonMarkdown(compareRealRuns(baseline, candidate)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message ?? 'comparison failed'); process.exitCode = 1 })
}
