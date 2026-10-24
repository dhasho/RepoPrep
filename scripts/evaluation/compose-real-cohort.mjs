import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { calculateReportDigest } from './review.mjs'
import { flattenQuestions, fingerprintQuestion } from './scorer.mjs'

const REPORT_SCHEMA_VERSION = 'repoprep-eval-report-v2'
const COHORT_SCHEMA_VERSION = 'repoprep-real-eval-cohort-v1'

const COHORT_CAVEATS = [
  'Actual provider token totals are null when complete usage receipts are unavailable; missing usage is never filled with zero.',
  'Estimated input tokens are application estimates and are reported separately from provider usage.',
  'Keyword fact coverage counts configured keyword matches; it is not factual accuracy.',
  'No monetary cost, model accuracy, or human review score is claimed anywhere in this cohort; human review in the source reports remains pending.',
  'Reused measurements are the original recorded production HTTP requests from the prior run, accepted only when the reuse proof attests identical request bodies; they are not new requests and never relabeled as fresh.',
  'This cohort is an aggregation of existing reports with explicit per-case provenance; it is not itself a repoprep-eval-report-v2 run and must not be presented as one fresh generation run.',
  'The legacy report digest does not bind generation metadata; the composer checks canonical output and question cross-links and records canonical hashes of all inputs.',
  'Endpoint origin hashes must match when both reports record them; older reports may omit that field.'
]

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashCanonical(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function assertCompleteGenerationCase(run, item, label) {
  if (!/^[a-f0-9]{40}$/iu.test(item.commit ?? '')) throw new Error(`${label} report case ${item.id} has an invalid or missing commit`)
  if (item.generation.status && item.generation.status !== 'complete') throw new Error(`${label} report case ${item.id} has an incomplete generation measurement (status ${item.generation.status})`)
  if (!isPlainObject(item.output)) throw new Error(`${label} report case ${item.id} has no generation output`)
  if (item.generation.output !== undefined && !isPlainObject(item.generation.output)) throw new Error(`${label} report case ${item.id} has a malformed generation output`)
  if (!Array.isArray(item.generation.questions)) throw new Error(`${label} report case ${item.id} has no generation questions`)
  verifyGenerationBinding(run, item, label)
  const fixtureEntries = Object.entries(run.fixtureHashes).filter(([key]) => key.startsWith(`${item.id}/`))
  if (!fixtureEntries.length || fixtureEntries.some(([, digest]) => !/^[a-f0-9]{64}$/iu.test(digest ?? ''))) throw new Error(`${label} report has incomplete fixture hashes for ${item.id}`)
}

function assertReport(run, label, { statuses, allowStubs }) {
  if (!isPlainObject(run) || run.schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error(`${label} report is missing or not ${REPORT_SCHEMA_VERSION}`)
  if (!statuses.includes(run.status)) throw new Error(`${label} report status ${run.status ?? 'unknown'} is not acceptable (expected ${statuses.join(' or ')})`)
  if (typeof run.corpusVersion !== 'string' || !run.corpusVersion) throw new Error(`${label} report has no corpus version`)
  if (!Array.isArray(run.cases) || !run.cases.length) throw new Error(`${label} report has no cases`)
  if (!Array.isArray(run.questions)) throw new Error(`${label} report has no questions array`)
  if (!isPlainObject(run.config) || !Array.isArray(run.config.variants) || !run.config.variants.includes('generation')) throw new Error(`${label} report has no generation variant`)
  if (!isPlainObject(run.fixtureHashes)) throw new Error(`${label} report has no fixture hashes`)
  if (!isPlainObject(run.sourceHashes)) throw new Error(`${label} report has no source hashes`)
  if (typeof run.reportDigest !== 'string' || calculateReportDigest(run) !== run.reportDigest) throw new Error(`${label} report digest does not match its content`)
  if (run.configHashInputs != null) {
    if (!isPlainObject(run.configHashInputs)) throw new Error(`${label} report has malformed config hash inputs`)
    const expectedConfigHash = createHash('sha256').update(JSON.stringify({ config: run.config, ...run.configHashInputs })).digest('hex')
    if (expectedConfigHash !== run.configHash) throw new Error(`${label} report config hash does not match its configuration`)
  }
  const cases = new Map()
  for (const item of run.cases) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id) throw new Error(`${label} report has a case without an id`)
    if (cases.has(item.id)) throw new Error(`${label} report has duplicate case ${item.id}`)
    if (item.generation) assertCompleteGenerationCase(run, item, label)
    else if (!allowStubs) throw new Error(`${label} report case ${item.id} has no complete generation measurement`)
    else if (!/^[a-f0-9]{40}$/iu.test(item.commit ?? '')) throw new Error(`${label} report case ${item.id} has an invalid or missing commit`)
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

function normalizedReuseConfiguration(configuration) {
  return {
    model: configuration.model ?? null,
    protocol: configuration.protocol ?? null,
    temperature: configuration.temperature ?? null,
    contextWindowTokens: configuration.contextWindowTokens ?? null,
    profileMaxOutputTokens: configuration.profileMaxOutputTokens ?? null
  }
}

function reuseConfiguration(run) {
  return normalizedReuseConfiguration({
    model: run.model,
    protocol: run.protocol,
    temperature: run.config.temperature,
    contextWindowTokens: run.config.contextWindowTokens,
    profileMaxOutputTokens: run.config.profileMaxOutputTokens
  })
}

function assertBaselineComparable(baseline, current) {
  if (typeof baseline.model !== 'string' || !baseline.model || typeof baseline.protocol !== 'string' || !baseline.protocol) {
    throw new Error('baseline report is missing required model configuration fields (model and protocol)')
  }
  if (baseline.model !== current.model || baseline.protocol !== current.protocol) throw new Error('baseline model or protocol differs from the current report')
  for (const key of ['granularity', 'budget', 'temperature']) {
    if (canonical(baseline.config[key]) !== canonical(current.config[key])) throw new Error(`baseline ${key} differs from the current report`)
  }
}

function assertCurrentReuseComparable(current, reuse) {
  if (canonical(comparableSettings(current)) !== canonical(comparableSettings(reuse))) throw new Error('generation settings differ between the current and reuse reports')
  if (canonical(reuseConfiguration(current)) !== canonical(reuseConfiguration(reuse))) throw new Error('reuse configuration (model, protocol, temperature, contextWindowTokens, profileMaxOutputTokens) differs between the current and reuse reports')
  const currentOrigin = current.configHashInputs?.baseUrlOriginSha256
  const reuseOrigin = reuse.configHashInputs?.baseUrlOriginSha256
  if (currentOrigin !== undefined && reuseOrigin !== undefined && currentOrigin !== reuseOrigin) throw new Error('current and reuse model endpoint origins differ')
}

function caseFixtureHashes(run, caseId) {
  return Object.fromEntries(Object.entries(run.fixtureHashes).filter(([key]) => key.startsWith(`${caseId}/`)))
}

function assertCaseSetConsistent(caseSet, reports) {
  for (const id of caseSet) {
    const present = reports.filter(({ cases }) => cases.has(id))
    const [first, ...others] = present
    for (const other of others) {
      const a = first.cases.get(id)
      const b = other.cases.get(id)
      if ((a.commit ?? '').toLowerCase() !== (b.commit ?? '').toLowerCase()) throw new Error(`case ${id} commit differs across input reports`)
      if (a.repository !== b.repository) throw new Error(`case ${id} repository differs across input reports`)
      if (a.granularity !== b.granularity || canonical(a.budget ?? null) !== canonical(b.budget ?? null)) throw new Error(`case ${id} granularity or question budget differs across input reports`)
      if (canonical(caseFixtureHashes(first.run, id)) !== canonical(caseFixtureHashes(other.run, id))) throw new Error(`case ${id} fixture hashes differ across input reports`)
    }
  }
}

function validateReuseProof(proof, { current, reuseCases, reusedIds }) {
  if (!isPlainObject(proof)) throw new Error('reuse proof is missing or malformed')
  if (!isPlainObject(proof.cases)) throw new Error('reuse proof has no cases map')
  for (const id of reusedIds) {
    const entry = proof.cases[id]
    if (!isPlainObject(entry)) throw new Error(`reuse proof is missing case ${id}`)
    if (entry.identical !== true) throw new Error(`reuse proof for case ${id} is not marked identical`)
    if (!/^[a-f0-9]{64}$/iu.test(entry.originalPromptHash ?? '') || !/^[a-f0-9]{64}$/iu.test(entry.currentPromptHash ?? '')) throw new Error(`reuse proof for case ${id} has invalid prompt hashes`)
    const request = reuseCases.get(id)?.generation?.requests?.[0]
    if (typeof request?.promptHash !== 'string') throw new Error(`reuse report case ${id} has no recorded initial request prompt hash`)
    if (entry.originalPromptHash !== entry.currentPromptHash || entry.currentPromptHash !== request.promptHash) {
      throw new Error(`reuse proof prompt hashes do not match the recorded original request for case ${id}`)
    }
  }
  if (!isPlainObject(proof.currentSourceHashes) || canonical(proof.currentSourceHashes) !== canonical(current.sourceHashes)) {
    throw new Error('reuse proof currentSourceHashes does not match the current report source hashes')
  }
  if (!isPlainObject(proof.configuration) || canonical(normalizedReuseConfiguration(proof.configuration)) !== canonical(reuseConfiguration(current))) {
    throw new Error('reuse proof configuration is missing or does not match the current and reuse reports')
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
    contextBuildMs: metricValue(diagnostics, null, 'contextBuildMs'),
    modelMs: metricValue(diagnostics, null, 'modelMs'),
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

function cohortSummary(records) {
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
    contextBuildMs: aggregate(records, 'contextBuildMs'),
    modelMs: aggregate(records, 'modelMs'),
    keywordCoverage: covered === null ? null : { covered, total }
  }
}

function reportProvenance(role, run, reference) {
  return {
    role,
    status: run.status,
    runId: run.runId,
    generatedAt: run.generatedAt ?? null,
    reference: typeof reference === 'string' && reference ? reference : null,
    canonicalHash: hashCanonical(run)
  }
}

export function composeRealCohort({ baseline, current, reuse, reuseProof, references } = {}) {
  if (!isPlainObject(baseline) || !isPlainObject(current) || !isPlainObject(reuse)) throw new Error('baseline, current, reuse, and reuseProof inputs are required')
  const baselineCases = assertReport(baseline, 'baseline', { statuses: ['complete'], allowStubs: false })
  const reuseCases = assertReport(reuse, 'reuse', { statuses: ['complete'], allowStubs: false })
  // A completed run of a selected subset is valid. An interrupted run is not:
  // silently filling its uncompleted cases would hide attempted network calls.
  const currentCases = assertReport(current, 'current', { statuses: ['complete'], allowStubs: false })
  if (baseline.corpusVersion !== current.corpusVersion || baseline.corpusVersion !== reuse.corpusVersion) throw new Error('corpus versions differ across input reports')
  assertBaselineComparable(baseline, current)
  assertCurrentReuseComparable(current, reuse)

  const caseSet = [...baselineCases.keys()].sort()
  const caseSetLookup = new Set(caseSet)
  for (const id of currentCases.keys()) {
    if (!caseSetLookup.has(id)) throw new Error(`current report case ${id} is outside the baseline case set`)
  }
  assertCaseSetConsistent(caseSet, [
    { run: baseline, cases: baselineCases },
    { run: current, cases: currentCases },
    { run: reuse, cases: reuseCases }
  ])

  const fresh = []
  const reused = []
  for (const id of caseSet) {
    const currentItem = currentCases.get(id)
    if (currentItem?.generation) { fresh.push([id, currentItem, current, 'current']); continue }
    const reuseItem = reuseCases.get(id)
    if (!reuseItem) throw new Error(`cohort case ${id} has no complete measurement in the current or reuse reports`)
    reused.push([id, reuseItem, reuse, 'reuse'])
  }
  validateReuseProof(reuseProof, { current, reuseCases, reusedIds: reused.map(([id]) => id) })

  const referenceFor = role => (isPlainObject(references) && typeof references[role] === 'string' && references[role]) || null
  const inputReports = {
    baseline: reportProvenance('baseline', baseline, referenceFor('baseline')),
    current: reportProvenance('current', current, referenceFor('current')),
    reuse: reportProvenance('reuse', reuse, referenceFor('reuse'))
  }
  const cases = [...fresh, ...reused].map(([id, item, run, role]) => ({
    id,
    repository: item.repository ?? null,
    commit: item.commit ?? null,
    source: role === 'current' ? 'fresh' : 'reused',
    originRunId: run.runId,
    sourceReportRole: role,
    sourceReportReference: inputReports[role].reference,
    sourceReportHash: inputReports[role].canonicalHash,
    firstRequestPromptHash: item.generation.requests?.[0]?.promptHash ?? null,
    questionFingerprints: questionFingerprints(item.generation.questions, id) ?? [],
    requests: Array.isArray(item.generation.requests) ? item.generation.requests : [],
    metrics: caseMetrics(item)
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const measurement = {
    caseCount: cases.length,
    freshCases: cases.filter(item => item.source === 'fresh').map(item => item.id),
    reusedCases: cases.filter(item => item.source === 'reused').map(item => item.id),
    selectedMeasurementsRequests: cases.reduce((sum, item) => sum + item.metrics.requestCount, 0),
    freshNetworkRequests: cases.filter(item => item.source === 'fresh').reduce((sum, item) => sum + item.metrics.requestCount, 0),
    reusedMeasurements: cases.filter(item => item.source === 'reused').length
  }
  return {
    schemaVersion: COHORT_SCHEMA_VERSION,
    composedAt: new Date().toISOString(),
    corpusVersion: current.corpusVersion,
    model: current.model,
    protocol: current.protocol,
    config: { granularity: current.config.granularity, budget: current.config.budget, temperature: current.config.temperature },
    inputReports,
    reuseProof: { canonicalHash: hashCanonical(reuseProof) },
    measurement,
    cases,
    summary: cohortSummary(cases.map(item => item.metrics)),
    caveats: COHORT_CAVEATS
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : 'unknown'
}

function keywordCoverageText(coverage) {
  return coverage ? `${coverage.covered}/${coverage.total}` : 'unknown'
}

export function cohortMarkdown(cohort) {
  const summary = cohort.summary
  const lines = [
    '# Real evaluation cohort', '',
    `- Corpus: ${cohort.corpusVersion}`,
    `- Model: ${cohort.model} (${cohort.protocol})`,
    `- Composed at: ${cohort.composedAt}`,
    `- Schema: ${cohort.schemaVersion} (aggregated measurements with per-case provenance; not itself a repoprep-eval-report-v2 run)`,
    `- Reuse proof canonical SHA-256: ${cohort.reuseProof.canonicalHash}`,
    '', '## Source reports', '',
    '| Role | Status | Run | Generated at | Reference | Canonical SHA-256 |', '|---|---|---|---|---|---|',
    ...['baseline', 'current', 'reuse'].map(role => {
      const report = cohort.inputReports[role]
      return `| ${report.role} | ${report.status} | ${report.runId} | ${report.generatedAt ?? 'unknown'} | ${report.reference ?? 'unknown'} | ${report.canonicalHash} |`
    }),
    '', '## Selection', '',
    `- Cohort cases: ${cohort.measurement.caseCount}`,
    `- Fresh measurements from the current run: ${cohort.measurement.freshCases.length} (${cohort.measurement.freshCases.join(', ') || 'none'})`,
    `- Reused measurements from the prior run: ${cohort.measurement.reusedCases.length} (${cohort.measurement.reusedCases.join(', ') || 'none'})`,
    `- Selected measurement requests (raw request count across the selected cases): ${cohort.measurement.selectedMeasurementsRequests}`,
    `- Fresh network requests (selected current-run requests): ${cohort.measurement.freshNetworkRequests}`,
    `- Reused measurements (filled case count): ${cohort.measurement.reusedMeasurements}`,
    '', '## Aggregated measured totals', '',
    '| Metric | Cohort |', '|---|---:|',
    `| Questions | ${formatNumber(summary.questions)} |`,
    `| Requests | ${formatNumber(summary.requests)} |`,
    `| Elapsed ms (scan + generation) | ${formatNumber(summary.elapsedMs)} |`,
    `| Generator phase ms | ${formatNumber(summary.generationMs)} |`,
    `| Actual input tokens | ${formatNumber(summary.actualUsage?.inputTokens)} |`,
    `| Actual output tokens | ${formatNumber(summary.actualUsage?.outputTokens)} |`,
    `| Actual total tokens | ${formatNumber(summary.actualUsage?.totalTokens)} |`,
    `| Estimated input tokens | ${formatNumber(summary.estimatedInputTokens)} |`,
    `| Repair requests | ${formatNumber(summary.repairRequests)} |`,
    `| Compensation requests | ${formatNumber(summary.compensationRequests)} |`,
    `| Context build ms | ${formatNumber(summary.contextBuildMs)} |`,
    `| Model ms | ${formatNumber(summary.modelMs)} |`,
    `| Keyword coverage (hits / facts) | ${keywordCoverageText(summary.keywordCoverage)} |`,
    '', '## Cases', '',
    '| Case | Source | Origin run | Requests | Questions | Elapsed ms | Actual tokens | Repairs / compensations | Keyword hits |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...cohort.cases.map(item => `| ${item.id} | ${item.source} | ${item.originRunId} | ${formatNumber(item.metrics.requestCount)} | ${formatNumber(item.metrics.questions)} | ${formatNumber(item.metrics.elapsedMs)} | ${formatNumber(item.metrics.actualUsage?.totalTokens)} | ${formatNumber(item.metrics.repairRequests)} / ${formatNumber(item.metrics.compensationRequests)} | ${keywordCoverageText(item.metrics.keywordCoverage)} |`),
    '', '## Case provenance', '',
    '| Case | Source | Origin report role | Origin run | Reference | First request prompt SHA-256 | Question fingerprints |',
    '|---|---|---|---|---|---|---:|',
    ...cohort.cases.map(item => `| ${item.id} | ${item.source} | ${item.sourceReportRole} | ${item.originRunId} | ${item.sourceReportReference ?? 'unknown'} | ${item.firstRequestPromptHash ?? 'unknown'} | ${item.questionFingerprints.length} |`),
    '', 'Full sorted per-question fingerprints are recorded in cohort.json under cases[].questionFingerprints.', '',
    '## Limitations', '', ...cohort.caveats.map(item => `- ${item}`)
  ]
  return `${lines.join('\n')}\n`
}

async function prepareOutputDirectory(outputDir, inputPaths) {
  const output = path.resolve(outputDir)
  for (const input of inputPaths) {
    const rel = path.relative(output, input)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('output directory must not contain or overwrite evaluation source inputs')
  }
  let existing = null
  try { existing = await lstat(output) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (existing) {
    if (!existing.isDirectory()) throw new Error('output path exists and is not a directory')
    if ((await readdir(output)).length) throw new Error('output directory must be new or empty')
  }
  return output
}

async function main() {
  const [baselinePath, currentPath, reusePath, proofPath, outputDir, ...rest] = process.argv.slice(2)
  if (!baselinePath || !currentPath || !reusePath || !proofPath || !outputDir || rest.length) {
    throw new Error('usage: compose-real-cohort.mjs <baseline-report.json> <current-report.json> <reuse-report.json> <reuse-proof.json> <new-output-directory>')
  }
  const inputs = [
    ['baseline', baselinePath],
    ['current', currentPath],
    ['reuse', reusePath],
    ['reuseProof', proofPath]
  ].map(([role, value]) => ({ role, absolute: path.resolve(value) }))
  const parsed = {}
  for (const input of inputs) parsed[input.role] = JSON.parse(await readFile(input.absolute, 'utf8'))
  const output = await prepareOutputDirectory(outputDir, inputs.map(input => input.absolute))
  const references = Object.fromEntries(inputs.filter(input => input.role !== 'reuseProof').map(input => [input.role, path.relative(output, input.absolute).split(path.sep).join('/')]))
  const cohort = composeRealCohort({ ...parsed, references })
  await mkdir(output, { recursive: true })
  const cohortPath = path.join(output, 'cohort.json')
  const reportPath = path.join(output, 'report.md')
  await writeFile(cohortPath, `${JSON.stringify(cohort, null, 2)}\n`)
  await writeFile(reportPath, cohortMarkdown(cohort))
  process.stdout.write(`${JSON.stringify({
    cohort: cohortPath,
    report: reportPath,
    freshCases: cohort.measurement.freshCases,
    reusedCases: cohort.measurement.reusedCases,
    selectedMeasurementsRequests: cohort.measurement.selectedMeasurementsRequests,
    freshNetworkRequests: cohort.measurement.freshNetworkRequests,
    reusedMeasurements: cohort.measurement.reusedMeasurements
  })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message ?? 'cohort composition failed'); process.exitCode = 1 })
}
