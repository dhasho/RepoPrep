import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { buildMultiRunCohort, cohortMarkdown } from './aggregate-multirun.mjs'

const root = path.resolve(process.env.REPOPREP_COHORT_ROOT ?? process.cwd())
const baselineReference = 'reports/real-generation-eval/2026-11-01-scoped-v1-deepseek-v4-flash/report.json'
const sha256 = value => createHash('sha256').update(value).digest('hex')

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function fixtureTools() {
  const review = await import(pathToFileURL(path.join(root, 'scripts/evaluation/review.mjs')))
  return review
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }

async function baselineRecord() {
  const bytes = await readFile(path.join(root, baselineReference))
  const run = JSON.parse(bytes.toString('utf8'))
  return { run, reference: baselineReference, rawHash: sha256(bytes), canonicalHash: sha256(canonical(run)) }
}

async function deriveSubset(base, caseIds, suffix, mutate) {
  const { calculateReportDigest } = await fixtureTools()
  const run = clone(base.run)
  const ids = new Set(caseIds)
  run.runId = `${run.runId}-${suffix}`
  run.cases = run.cases.filter(item => ids.has(item.id))
  run.questions = run.questions.filter(question => ids.has(question.caseId))
  run.fixtureHashes = Object.fromEntries(Object.entries(run.fixtureHashes).filter(([key]) => [...ids].some(id => key.startsWith(`${id}/`))))
  const requestReceipts = run.cases.flatMap(item => item.generation.requests ?? [])
  run.network = { ...run.network, requests: requestReceipts }
  mutate?.(run)
  if (run.configHashInputs) run.configHash = sha256(JSON.stringify({ config: run.config, ...run.configHashInputs }))
  run.reportDigest = calculateReportDigest(run)
  const bytes = Buffer.from(JSON.stringify(run))
  return { run, reference: `.validation/test-fixture/${suffix}.json`, rawHash: sha256(bytes), canonicalHash: sha256(canonical(run)) }
}

test('derives a strict four-case union with separate campaign and selected request counts', async () => {
  const baseline = await baselineRecord()
  const cases = ['mitt', 'p-limit', 'schedule', 'requests']
  const candidates = []
  for (const id of cases) candidates.push(await deriveSubset(baseline, [id], `candidate-${id}`))
  const campaign = await deriveSubset(baseline, ['requests'], 'campaign-314d', run => {
    run.network.requests = [{ attempt: 'initial' }, { attempt: 'repair' }]
  })
  const cohort = await buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates, campaignRecords: [campaign] })
  assert.equal(cohort.schemaVersion, 'repoprep-real-eval-multirun-cohort-v1')
  assert.equal(cohort.status, 'complete')
  assert.deepEqual(cohort.caseUnion, ['mitt', 'p-limit', 'requests', 'schedule'])
  assert.equal(cohort.cases.length, 4)
  assert.ok(cohort.cases.every(item => item.questionCount === 20 && item.questionFingerprints.length === 20))
  assert.equal(cohort.measurement.selectedMeasurementRequests, 4)
  assert.equal(cohort.measurement.campaignRequests, 6)
  assert.equal(cohort.measurement.campaignOnlyReports, 1)
  assert.equal(cohort.cases.find(item => item.id === 'requests').providerUsage.totalTokens, 78193)
  assert.equal(cohort.cases[0].sourceReportReference.startsWith('.validation/'), true)
  assert.match(cohortMarkdown(cohort), /not one fresh four-case run/u)
  assert.match(cohortMarkdown(cohort), /Proxy review is not human review/u)
})

test('rejects a missing case in the selected candidate union', async () => {
  const baseline = await baselineRecord()
  const candidates = []
  for (const id of ['mitt', 'p-limit', 'schedule']) candidates.push(await deriveSubset(baseline, [id], `missing-${id}`))
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates }), /missing cases: requests/u)
})

test('rejects duplicate selected cases even when each source run is complete', async () => {
  const baseline = await baselineRecord()
  const candidates = [
    await deriveSubset(baseline, ['mitt', 'p-limit', 'schedule'], 'duplicate-left'),
    await deriveSubset(baseline, ['requests'], 'duplicate-right'),
    await deriveSubset(baseline, ['requests'], 'duplicate-again')
  ]
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates }), /duplicate candidate case/u)
})

test('rejects candidate inference configuration or source hash drift', async () => {
  const baseline = await baselineRecord()
  const candidates = []
  for (const id of ['mitt', 'p-limit', 'schedule']) candidates.push(await deriveSubset(baseline, [id], `config-${id}`))
  candidates.push(await deriveSubset(baseline, ['requests'], 'config-drift', run => { run.config.temperature = 0.5 }))
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates }), /identical inference and generation configuration/u)

  const sourceDrift = await deriveSubset(baseline, ['requests'], 'source-drift', run => {
    const key = Object.keys(run.sourceHashes)[0]
    run.sourceHashes[key] = 'a'.repeat(64)
  })
  const compatible = []
  for (const id of ['mitt', 'p-limit', 'schedule']) compatible.push(await deriveSubset(baseline, [id], `source-${id}`))
  compatible.push(sourceDrift)
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: compatible }), /different complete source hash maps/u)
})

test('rejects a candidate source revision or fixed fixture that differs from baseline', async () => {
  const baseline = await baselineRecord()
  const candidates = []
  for (const id of ['mitt', 'p-limit', 'schedule']) candidates.push(await deriveSubset(baseline, [id], `fixture-${id}`))
  candidates.push(await deriveSubset(baseline, ['requests'], 'fixture-drift', run => {
    run.fixtureHashes['requests/src/requests/models.py'] = 'a'.repeat(64)
  }))
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates }), /fixture hashes differ from baseline/u)
  const revision = await deriveSubset(baseline, ['requests'], 'revision-drift', run => { run.cases[0].commit = 'a'.repeat(40) })
  const revisionCandidates = [...candidates.slice(0, 3), revision]
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: revisionCandidates }), /revision differs from baseline/u)
})

test('preserves unknown provider usage as null instead of treating estimates as actual tokens', async () => {
  const baseline = await baselineRecord()
  const candidates = []
  for (const id of ['mitt', 'p-limit', 'schedule']) candidates.push(await deriveSubset(baseline, [id], `unknown-usage-${id}`))
  candidates.push(await deriveSubset(baseline, ['requests'], 'unknown-usage-requests', run => {
    const item = run.cases[0]
    item.generation.diagnostics.usageComplete = false
    item.generation.diagnostics.actualUsage = null
    item.output.evaluationDiagnostics = clone(item.generation.diagnostics)
    if (item.generation.output) item.generation.output.evaluationDiagnostics = clone(item.generation.diagnostics)
  }))
  const cohort = await buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates })
  const requests = cohort.cases.find(item => item.id === 'requests')
  assert.equal(requests.providerUsage, null)
  assert.equal(requests.inputEstimate, 63947)
})

test('rejects broken metadata binding and permits only an explicit baseline reasoning change', async () => {
  const baseline = await baselineRecord()
  const broken = await deriveSubset(baseline, ['requests'], 'binding-broken', run => {
    run.cases[0].generation.questions[0].answer = 'tampered answer'
  })
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: [broken] }), /canonical generation output differs|questions are not bound/u)

  const lowEffortReports = []
  for (const id of ['mitt', 'p-limit', 'schedule', 'requests']) {
    lowEffortReports.push(await deriveSubset(baseline, [id], `low-${id}`, run => {
      run.config.reasoningEffort = 'low'
      if (run.configHashInputs) run.configHashInputs.reasoningEffort = 'low'
    }))
  }
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: lowEffortReports }), /candidate core configuration differs from baseline/u)
  const allowed = await buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: lowEffortReports, allowReasoningChange: true })
  assert.deepEqual(allowed.reasoningEffortChange, { baseline: 'provider-default', candidate: 'low' })

  const coreDrift = [...lowEffortReports.slice(0, 3), await deriveSubset(baseline, ['requests'], 'low-core-drift', run => {
    run.config.reasoningEffort = 'low'
    run.config.temperature = 0.5
    if (run.configHashInputs) run.configHashInputs.reasoningEffort = 'low'
  })]
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: coreDrift, allowReasoningChange: true }), /identical inference and generation configuration/u)
})

test('refuses stale report digests before attempting a cohort', async () => {
  const baseline = await baselineRecord()
  const candidate = await deriveSubset(baseline, ['requests'], 'stale-digest')
  candidate.run.questions[0].answer = 'tampered'
  const candidates = [candidate]
  await assert.rejects(buildMultiRunCohort({ root, baselineRecord: baseline, candidateRecords: candidates }), /report digest does not match/u)
})
