import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const REPORT_SCHEMA = 'repoprep-eval-report-v2'
const COHORT_SCHEMA = 'repoprep-real-eval-multirun-cohort-v1'
const REASONING = new Set(['provider-default', 'low', 'high'])

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizedEffort(run) {
  const configured = run.config.reasoningEffort
  const hashed = run.configHashInputs?.reasoningEffort
  const effort = configured ?? hashed ?? 'provider-default'
  if (!REASONING.has(effort) || (configured !== undefined && hashed !== undefined && configured !== hashed)) {
    throw new Error('report reasoning effort metadata is invalid')
  }
  return effort
}

function configIdentity(run) {
  const config = run.config
  return {
    model: run.model,
    protocol: run.protocol,
    temperature: config.temperature ?? null,
    reasoningEffort: normalizedEffort(run),
    contextWindowTokens: config.contextWindowTokens ?? null,
    profileMaxOutputTokens: config.profileMaxOutputTokens ?? null,
    maxOutputTokens: config.maxOutputTokens ?? null,
    maxOutputTokensPolicy: config.maxOutputTokensPolicy ?? null,
    applicationInputTokenTarget: config.applicationInputTokenTarget ?? null,
    applicationInputTokenBudget: config.applicationInputTokenBudget ?? null,
    reservedOutputTokens: config.reservedOutputTokens ?? null,
    reservedOutputPolicy: config.reservedOutputPolicy ?? null,
    inputTokenBudgetPolicy: config.inputTokenBudgetPolicy ?? null,
    contextStrategy: config.contextStrategy ?? null,
    tokenEstimateMethod: config.tokenEstimateMethod ?? null,
    corpusVersion: run.corpusVersion,
    granularity: config.granularity ?? null,
    questionBudget: config.budget ?? null,
    endpointOriginSha256: run.configHashInputs?.baseUrlOriginSha256 ?? null
  }
}

function coreWithoutEffort(identity) {
  const { reasoningEffort: _effort, ...core } = identity
  return core
}

function caseFixtureHashes(run, caseId) {
  return Object.fromEntries(Object.entries(run.fixtureHashes).filter(([key]) => key.startsWith(`${caseId}/`)))
}

function verifySourceHashes(run, label) {
  if (!isObject(run.sourceHashes) || Object.keys(run.sourceHashes).length === 0) throw new Error(`${label} report has no complete source hash map`)
  for (const [name, digest] of Object.entries(run.sourceHashes)) {
    if (!name || path.posix.isAbsolute(name) || name.split('/').includes('..') || !/^[a-f0-9]{64}$/iu.test(digest ?? '')) {
      throw new Error(`${label} report has an invalid source hash entry`)
    }
  }
}

async function loadValidationTools(root) {
  const comparisonUrl = pathToFileURL(path.join(root, 'scripts/evaluation/compare-real-runs.mjs'))
  const reviewUrl = pathToFileURL(path.join(root, 'scripts/evaluation/review.mjs'))
  const scorerUrl = pathToFileURL(path.join(root, 'scripts/evaluation/scorer.mjs'))
  const [comparison, review, scorer] = await Promise.all([import(comparisonUrl), import(reviewUrl), import(scorerUrl)])
  return {
    compareRealRuns: comparison.compareRealRuns,
    calculateReportDigest: review.calculateReportDigest,
    fingerprintQuestion: scorer.fingerprintQuestion
  }
}

function verifyRun(run, label, tools, { requireComplete }) {
  if (!isObject(run) || run.schemaVersion !== REPORT_SCHEMA || !isObject(run.config)) throw new Error(`${label} is not a valid ${REPORT_SCHEMA} report`)
  if (typeof run.runId !== 'string' || !run.runId) throw new Error(`${label} report has no run ID`)
  if (requireComplete && run.status !== 'complete') throw new Error(`${label} report is not complete`)
  if (!['complete', 'partial'].includes(run.status)) throw new Error(`${label} report has an unsupported status`)
  if (!Array.isArray(run.cases) || !Array.isArray(run.questions) || !Array.isArray(run.config.variants) || !run.config.variants.includes('generation')) {
    throw new Error(`${label} report has no generation cases`)
  }
  if (!isObject(run.fixtureHashes) || !isObject(run.configHashInputs) || typeof run.configHash !== 'string') throw new Error(`${label} report metadata is incomplete`)
  if (typeof run.reportDigest !== 'string' || tools.calculateReportDigest(run) !== run.reportDigest) throw new Error(`${label} report digest does not match its content`)
  const expectedConfigHash = sha256(JSON.stringify({ config: run.config, ...run.configHashInputs }))
  if (expectedConfigHash !== run.configHash) throw new Error(`${label} config hash does not match its configuration`)
  normalizedEffort(run)
  verifySourceHashes(run, label)
  if (!requireComplete) return
  // Existing comparator validation binds report digest, config hash, canonical output,
  // and generation questions without treating subset reports as one report.
  tools.compareRealRuns(run, run)
  for (const item of run.cases) {
    if (!item.generation || item.generation.status !== 'complete') throw new Error(`${label} case ${item.id} has no complete generation measurement`)
    const requestCount = selectedRequestCount(item)
    if (!Number.isSafeInteger(requestCount) || requestCount < 1) throw new Error(`${label} case ${item.id} has no recorded generation request count`)
    const fingerprints = item.generation.questions.map(question => tools.fingerprintQuestion(question.question, {
      caseId: item.id,
      variant: 'generation',
      answer: question.answer ?? '',
      followUps: question.followUps ?? [],
      sourceEvidence: question.sourceEvidence ?? []
    })).sort()
    if (fingerprints.length !== 20) throw new Error(`${label} case ${item.id} does not contain 20 bound question fingerprints`)
  }
}

function runRawRequestCount(run) {
  if (!isObject(run.network) || !Array.isArray(run.network.requests)) return null
  return run.network.requests.length
}

function selectedRequestCount(item) {
  if (Number.isSafeInteger(item.generation.requestCount) && item.generation.requestCount >= 0) return item.generation.requestCount
  if (Array.isArray(item.generation.requests)) return item.generation.requests.length
  return null
}

function providerUsage(item) {
  const diagnostics = item.generation.diagnostics
  const usage = diagnostics?.usageComplete === true ? diagnostics.actualUsage : null
  if (!isObject(usage) || !['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
}

function requestEstimate(item) {
  const value = item.generation.diagnostics?.estimatedInputTokens
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function caseQuestionFingerprints(item, caseId, fingerprintQuestion) {
  return item.generation.questions.map(question => fingerprintQuestion(question.question, {
    caseId,
    variant: 'generation',
    answer: question.answer ?? '',
    followUps: question.followUps ?? [],
    sourceEvidence: question.sourceEvidence ?? []
  })).sort()
}

function provenance(record) {
  const { run, reference, rawHash } = record
  return {
    reference,
    runId: run.runId,
    reportDigest: run.reportDigest,
    rawReportSha256: rawHash,
    canonicalReportSha256: sha256(canonical(run)),
    status: run.status,
    generatedAt: run.generatedAt ?? null,
    reasoningEffort: normalizedEffort(run),
    rawNetworkRequests: runRawRequestCount(run)
  }
}

function validateRunSources(baselineRecord, candidateRecords, campaignRecords, { allowReasoningChange }) {
  const baseline = baselineRecord.run
  const baselineCases = new Map(baseline.cases.map(item => [item.id, item]))
  if (baselineCases.size !== 4) throw new Error('baseline must contain the complete four-case corpus')
  if (candidateRecords.length === 0) throw new Error('at least one candidate report is required')
  const baselineConfig = configIdentity(baseline)
  const firstCandidate = configIdentity(candidateRecords[0].run)
  const expectedCandidateCases = new Set(baselineCases.keys())
  const seen = new Set()
  const runIds = new Set([baseline.runId])
  const sources = new Set([baselineRecord.canonicalHash])

  for (const record of candidateRecords) {
    const run = record.run
    if (runIds.has(run.runId) || sources.has(record.canonicalHash)) throw new Error('duplicate run or source report in candidate inputs')
    runIds.add(run.runId)
    sources.add(record.canonicalHash)
    const identity = configIdentity(run)
    if (canonical(identity) !== canonical(firstCandidate)) throw new Error('candidate reports do not share identical inference and generation configuration')
    const baseCompare = allowReasoningChange ? canonical(coreWithoutEffort(baselineConfig)) === canonical(coreWithoutEffort(identity)) : canonical(baselineConfig) === canonical(identity)
    if (!baseCompare) throw new Error('candidate core configuration differs from baseline')
    if (canonical(run.sourceHashes) !== canonical(candidateRecords[0].run.sourceHashes)) throw new Error('candidate reports have different complete source hash maps')
    for (const item of run.cases) {
      const id = item.id
      if (!expectedCandidateCases.has(id)) throw new Error(`candidate report contains case outside baseline: ${id}`)
      if (seen.has(id)) throw new Error(`duplicate candidate case across reports: ${id}`)
      seen.add(id)
      const baselineItem = baselineCases.get(id)
      if (item.commit !== baselineItem.commit || item.repository !== baselineItem.repository) throw new Error(`candidate case revision differs from baseline: ${id}`)
      if (item.granularity !== baselineItem.granularity || canonical(item.budget ?? null) !== canonical(baselineItem.budget ?? null)) throw new Error(`candidate case question budget differs from baseline: ${id}`)
      if (canonical(caseFixtureHashes(run, id)) !== canonical(caseFixtureHashes(baseline, id))) throw new Error(`candidate case fixture hashes differ from baseline: ${id}`)
    }
  }
  const missing = [...expectedCandidateCases].filter(id => !seen.has(id))
  if (missing.length) throw new Error(`candidate union is incomplete; missing cases: ${missing.sort().join(', ')}`)

  for (const record of campaignRecords) {
    const { run } = record
    if (runIds.has(run.runId) || sources.has(record.canonicalHash)) throw new Error('duplicate run or source report across candidate/campaign inputs')
    runIds.add(run.runId)
    sources.add(record.canonicalHash)
  }
  const candidateEffort = normalizedEffort(candidateRecords[0].run)
  const baselineEffort = normalizedEffort(baseline)
  if (baselineEffort !== candidateEffort && !allowReasoningChange) throw new Error('baseline reasoning effort differs; explicitly allow reasoning condition change')
  return {
    caseIds: [...expectedCandidateCases].sort(),
    candidateIdentity: firstCandidate,
    baselineReasoningEffort: baselineEffort,
    candidateReasoningEffort: candidateEffort,
    reasoningEffortChange: baselineEffort === candidateEffort ? null : { baseline: baselineEffort, candidate: candidateEffort }
  }
}

function sumKnown(values) {
  return values.every(Number.isSafeInteger) ? values.reduce((sum, value) => sum + value, 0) : null
}

export async function buildMultiRunCohort({ root, baselineRecord, candidateRecords, campaignRecords = [], allowReasoningChange = false } = {}) {
  if (!path.isAbsolute(root ?? '') || !isObject(baselineRecord?.run) || !Array.isArray(candidateRecords)) throw new Error('root, baseline report, and candidate reports are required')
  if (typeof allowReasoningChange !== 'boolean') throw new Error('allowReasoningChange must be boolean')
  const canonicalRoot = await realpath(path.resolve(root))
  if (canonicalRoot !== path.resolve(root)) throw new Error('root must be canonical and absolute')
  const corpusManifest = JSON.parse(await readFile(path.join(canonicalRoot, 'scripts/evaluation/real-corpus/corpus.json'), 'utf8'))
  const expectedCorpus = new Map(corpusManifest.cases.map(item => [item.id, item]))
  if (baselineRecord.run.corpusVersion !== corpusManifest.version) throw new Error('baseline corpus version differs from the fixed corpus')
  const baselineCaseMap = new Map(baselineRecord.run.cases.map(item => [item.id, item]))
  if (baselineCaseMap.size !== 4 || canonical([...baselineCaseMap.keys()].sort()) !== canonical([...expectedCorpus.keys()].sort())) throw new Error('baseline must contain the fixed complete four-case corpus')
  for (const [id, item] of baselineCaseMap) {
    const expected = expectedCorpus.get(id)
    if (item.commit?.toLowerCase() !== expected.commit.toLowerCase() || item.repository !== expected.repository) throw new Error(`baseline revision differs from the fixed corpus: ${id}`)
    const expectedFixtures = Object.fromEntries(expected.evidenceFiles.map(file => [`${id}/${file.path}`, file.sha256]))
    if (canonical(caseFixtureHashes(baselineRecord.run, id)) !== canonical(expectedFixtures)) throw new Error(`baseline fixture hashes differ from the fixed corpus: ${id}`)
  }
  const tools = await loadValidationTools(canonicalRoot)
  verifyRun(baselineRecord.run, 'baseline', tools, { requireComplete: true })
  for (let index = 0; index < candidateRecords.length; index++) verifyRun(candidateRecords[index].run, `candidate ${index + 1}`, tools, { requireComplete: true })
  for (let index = 0; index < campaignRecords.length; index++) verifyRun(campaignRecords[index].run, `campaign ${index + 1}`, tools, { requireComplete: false })
  const validation = validateRunSources(baselineRecord, candidateRecords, campaignRecords, { allowReasoningChange })
  const baselineCaseIds = new Set(baselineRecord.run.cases.map(item => item.id))
  const selectedCases = []
  for (const record of candidateRecords) {
    for (const item of record.run.cases) {
      if (!baselineCaseIds.has(item.id)) throw new Error(`selected candidate case is outside baseline: ${item.id}`)
      const requestCount = selectedRequestCount(item)
      selectedCases.push({
        id: item.id,
        repository: item.repository ?? null,
        commit: item.commit,
        originRunId: record.run.runId,
        sourceReportDigest: record.run.reportDigest,
        sourceReportRawSha256: record.rawHash,
        sourceReportCanonicalSha256: record.canonicalHash,
        sourceReportReference: record.reference,
        questionCount: item.generation.questions.length,
        questionFingerprints: caseQuestionFingerprints(item, item.id, tools.fingerprintQuestion),
        providerUsage: providerUsage(item),
        requests: requestCount,
        inputEstimate: requestEstimate(item)
      })
    }
  }
  selectedCases.sort((a, b) => a.id.localeCompare(b.id))
  const selectedMeasurementRequests = sumKnown(selectedCases.map(item => item.requests))
  const campaignRequestSources = [...candidateRecords, ...campaignRecords].map(record => ({
    reference: record.reference,
    runId: record.run.runId,
    reportDigest: record.run.reportDigest,
    rawRequests: runRawRequestCount(record.run)
  }))
  const campaignRequests = sumKnown(campaignRequestSources.map(item => item.rawRequests))
  const baselineEffort = validation.baselineReasoningEffort
  const candidateEffort = validation.candidateReasoningEffort
  const sourceHashMap = {
    entryCount: Object.keys(candidateRecords[0].run.sourceHashes).length,
    sha256: sha256(canonical(candidateRecords[0].run.sourceHashes))
  }
  const caveats = [
    'This is a multi-run aggregation with per-case run provenance, not one fresh four-case run.',
    'Each case retains its original source run, report digest, raw and canonical report hashes, relative report reference, and 20 sorted question fingerprints.',
    'Campaign requests include all candidate source-run network receipts plus explicitly supplied campaign-only reports; the baseline is a comparison reference and is not counted unless separately supplied as campaign-only.',
    'Selected measurement requests sum only the four selected generation case request counts; campaign-only attempts are excluded.',
    'Provider usage remains null unless the source case contains a complete provider usage receipt; estimated input tokens remain separate.',
    'The legacy source report digest may not bind generation metadata; each input is additionally checked with the production comparator and its full canonical report hash is recorded.',
    'Proxy review is not human review. This artifact does not score factual accuracy or infer monetary cost.',
    ...(validation.reasoningEffortChange ? ['Baseline and candidate reasoning efforts differ under explicit authorization; treat them as different inference conditions.'] : [])
  ]
  return {
    schemaVersion: COHORT_SCHEMA,
    status: 'complete',
    createdAt: new Date().toISOString(),
    corpusVersion: baselineRecord.run.corpusVersion,
    model: validation.candidateIdentity.model,
    protocol: validation.candidateIdentity.protocol,
    selectedConfiguration: validation.candidateIdentity,
    reasoningEffortChange: validation.reasoningEffortChange,
    baseline: provenance(baselineRecord),
    candidateReports: candidateRecords.map(provenance),
    campaignOnlyReports: campaignRecords.map(provenance),
    candidateSourceHashMap: sourceHashMap,
    caseUnion: validation.caseIds,
    cases: selectedCases,
    measurement: {
      selectedMeasurementRequests,
      campaignRequests,
      campaignRequestSources,
      selectedCases: selectedCases.length,
      campaignOnlyReports: campaignRecords.length
    },
    caveats
  }
}

export function cohortMarkdown(cohort) {
  const lines = [
    '# Multi-run real evaluation cohort', '',
    `- Schema: ${cohort.schemaVersion}`,
    `- Corpus: ${cohort.corpusVersion}`,
    `- Model/protocol: ${cohort.model} / ${cohort.protocol}`,
    `- Selected cases: ${cohort.measurement.selectedCases}`,
    `- Selected measurement requests: ${cohort.measurement.selectedMeasurementRequests ?? 'unknown'}`,
    `- Campaign requests: ${cohort.measurement.campaignRequests ?? 'unknown'}`,
    `- Reasoning-effort change: ${cohort.reasoningEffortChange ? `${cohort.reasoningEffortChange.baseline} → ${cohort.reasoningEffortChange.candidate}` : 'none'}`,
    '', 'This is a multi-run aggregation, not one fresh four-case run. Proxy review is not human review. No monetary cost or factual accuracy is inferred.',
    '', '## Selected cases', '',
    '| Case | Origin run | Requests | Questions | Provider usage | Estimated input | Question fingerprints | Source report |',
    '|---|---|---:|---:|---|---:|---:|---|',
    ...cohort.cases.map(item => `| ${item.id} | ${item.originRunId} | ${item.requests ?? 'unknown'} | ${item.questionCount} | ${item.providerUsage?.totalTokens ?? 'unknown'} | ${item.inputEstimate ?? 'unknown'} | ${item.questionFingerprints.length} | ${item.sourceReportReference} |`),
    '', '## Reports', '',
    `- Baseline: ${cohort.baseline.reference} (run ${cohort.baseline.runId}; SHA-256 ${cohort.baseline.rawReportSha256})`,
    ...cohort.candidateReports.map(record => `- Candidate: ${record.reference} (run ${record.runId}; SHA-256 ${record.rawReportSha256})`),
    ...cohort.campaignOnlyReports.map(record => `- Campaign-only: ${record.reference} (run ${record.runId}; SHA-256 ${record.rawReportSha256})`),
    '', '## Limitations', '', ...cohort.caveats.map(item => `- ${item}`)
  ]
  return `${lines.join('\n')}\n`
}

function resolveInputReference(root, reference) {
  const absolute = path.resolve(root, reference)
  const relative = path.relative(root, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('report reference escapes or aliases root')
  return { absolute, reference: relative.split(path.sep).join('/') }
}

async function verifyPathNoSymlinks(root, target) {
  const relative = path.relative(root, target)
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const stats = await lstat(current)
    if (stats.isSymbolicLink()) throw new Error('report input path contains a symbolic link')
  }
  const stats = await lstat(target)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('report input is not a regular file')
  if (await realpath(target) !== target) throw new Error('report input path is not canonical')
}

async function readReport(root, reference, label) {
  const resolved = resolveInputReference(root, reference)
  await verifyPathNoSymlinks(root, resolved.absolute)
  const bytes = await readFile(resolved.absolute)
  let run
  try { run = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${label} report JSON is invalid`) }
  const rawHash = sha256(bytes)
  const canonicalHash = sha256(canonical(run))
  return { run, rawHash, canonicalHash, reference: resolved.reference }
}

async function prepareOutput(outputDir, inputPaths) {
  if (!path.isAbsolute(outputDir)) throw new Error('output directory must be absolute')
  const output = path.resolve(outputDir)
  for (const input of inputPaths) {
    const relative = path.relative(output, input)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('output directory must not contain input reports')
  }
  const parent = path.dirname(output)
  if (await realpath(parent) !== parent) throw new Error('output parent must be canonical')
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('output parent must be a real directory')
  let exists = false
  try { await lstat(output); exists = true } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (exists) throw new Error('output directory already exists')
  return output
}

export function parseArgs(args) {
  const result = { candidates: [], campaignReports: [], allowReasoningChange: false }
  const repeatable = new Set(['--candidate', '--campaign-report'])
  const valued = new Set(['--root', '--baseline', '--candidate', '--campaign-report', '--output'])
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--allow-reasoning-change') {
      if (result.allowReasoningChange) throw new Error('duplicate reasoning flag')
      result.allowReasoningChange = true
      continue
    }
    if (!valued.has(key)) throw new Error('unknown multirun cohort option')
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error('missing multirun cohort option value')
    if (repeatable.has(key)) result[key === '--candidate' ? 'candidates' : 'campaignReports'].push(value)
    else {
      const name = key.slice(2)
      if (result[name] !== undefined) throw new Error('duplicate multirun cohort option')
      result[name] = value
    }
  }
  if (!result.root || !path.isAbsolute(result.root) || !result.baseline || result.candidates.length === 0 || !result.output) {
    throw new Error('usage: aggregate-multirun.mjs --root <absolute-root> --baseline <relative-report.json> --candidate <relative-report.json> [--candidate <relative-report.json> ...] [--campaign-report <relative-report.json> ...] --output <absolute-new-directory> [--allow-reasoning-change]')
  }
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = path.resolve(options.root)
  if (await realpath(root) !== root) throw new Error('root must be a canonical path')
  const baseline = await readReport(root, options.baseline, 'baseline')
  const candidates = []
  for (const reference of options.candidates) candidates.push(await readReport(root, reference, 'candidate'))
  const campaignReports = []
  for (const reference of options.campaignReports) campaignReports.push(await readReport(root, reference, 'campaign-only'))
  const output = await prepareOutput(options.output, [baseline, ...candidates, ...campaignReports].map(record => path.join(root, record.reference)))
  const cohort = await buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates, campaignRecords: campaignReports, allowReasoningChange: options.allowReasoningChange })
  await mkdir(output)
  await writeFile(path.join(output, 'cohort.json'), `${JSON.stringify(cohort, null, 2)}\n`)
  await writeFile(path.join(output, 'report.md'), cohortMarkdown(cohort))
  process.stdout.write(`${JSON.stringify({ output, schemaVersion: cohort.schemaVersion, cases: cohort.caseUnion, selectedMeasurementRequests: cohort.measurement.selectedMeasurementRequests, campaignRequests: cohort.measurement.campaignRequests })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('multi-run cohort validation failed; no output was written'); process.exitCode = 1 })
}
