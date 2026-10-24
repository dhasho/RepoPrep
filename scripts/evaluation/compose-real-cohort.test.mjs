import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, access, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { calculateReportDigest } from './review.mjs'
import { composeRealCohort, cohortMarkdown } from './compose-real-cohort.mjs'

const execFile = promisify(execFileCallback)
const CASE_IDS = ['alpha', 'beta', 'gamma', 'delta']
const BUDGET = { min: 2, target: 2, max: 4 }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const TOKEN_CONFIG = { contextWindowTokens: null, profileMaxOutputTokens: null }

function buildGeneration({ runId, caseId, withDiagnostics, usageReceipts = true, requestCount = 1 }) {
  const questions = Array.from({ length: 2 }, (_, index) => ({
    question: `How does ${caseId} behave in scenario ${index}?`,
    answer: `Answer ${index} for ${caseId}.`,
    followUps: []
  }))
  const requests = Array.from({ length: requestCount }, (_, index) => ({
    attempt: 'initial',
    inputChars: 1000 + index,
    promptHash: sha256(JSON.stringify([runId, caseId, index])),
    elapsedMs: 1000,
    status: 200,
    errorType: null,
    usage: usageReceipts ? { inputTokens: 100, outputTokens: 200, totalTokens: 300 } : null
  }))
  const tokens = requests.every(request => request.usage)
    ? requests.reduce((total, request) => ({
      inputTokens: total.inputTokens + request.usage.inputTokens,
      outputTokens: total.outputTokens + request.usage.outputTokens,
      totalTokens: total.totalTokens + request.usage.totalTokens
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    : null
  const diagnostics = withDiagnostics ? {
    version: 1,
    status: 'succeeded',
    contextStrategy: 'structure-v1',
    tokenEstimateMethod: 'mixed-text-v1',
    estimatedInputTokens: 1000,
    inputTokenBudget: 64000,
    reservedOutputTokens: 65536,
    actualUsage: usageReceipts ? { ...tokens } : null,
    usageComplete: usageReceipts,
    requestCount,
    repairRequestCount: 0,
    compensationRequestCount: 0,
    contextBuildMs: 10,
    modelMs: 990,
    totalMs: 1000,
    selectedFiles: 3,
    selectedRegions: 4,
    omittedFiles: 0
  } : undefined
  const output = {
    projectSummary: `summary-${runId}-${caseId}`,
    sections: [{ title: 'Overview', questions: questions.map(question => ({ ...question })) }],
    ...(diagnostics ? { evaluationDiagnostics: diagnostics } : {})
  }
  const generation = {
    status: 'complete',
    elapsedMs: 1000,
    requestCount,
    requests,
    inputChars: requests.reduce((sum, request) => sum + request.inputChars, 0),
    tokens,
    questions: questions.map(question => ({ ...question, section: 'Overview' })),
    output,
    ...(diagnostics ? { diagnostics } : {}),
    scored: { knownFactCoverage: { covered: 1, total: 2 } }
  }
  return { generation, output }
}

function buildReport({ runId, status = 'complete', caseIds, stubCaseIds = [], withDiagnostics, withConfigHashInputs = false, configExtras = {}, perCase = {} }) {
  const cases = []
  const questions = []
  for (const caseId of caseIds) {
    if (stubCaseIds.includes(caseId)) {
      cases.push({ id: caseId, repository: `example/${caseId}`, commit: 'a'.repeat(40), granularity: 'medium', budget: BUDGET })
      continue
    }
    const { generation, output } = buildGeneration({ runId, caseId, withDiagnostics, ...(perCase[caseId] ?? {}) })
    cases.push({ id: caseId, repository: `example/${caseId}`, commit: 'a'.repeat(40), granularity: 'medium', budget: BUDGET, output, generation })
    for (const question of generation.questions) {
      questions.push({ caseId, variant: 'generation', question: question.question, answer: question.answer, followUps: question.followUps })
    }
  }
  const config = { mode: 'real-model-public-repositories', variants: ['generation'], granularity: 'medium', budget: BUDGET, temperature: 0.4, ...configExtras }
  const report = {
    schemaVersion: 'repoprep-eval-report-v2',
    runId,
    corpusVersion: 'repoprep-real-corpus-v1',
    mode: 'real-model-public-repositories',
    model: 'test-model-v1',
    protocol: 'openai',
    runtime: { node: process.version },
    config,
    configHash: `config-${runId}`,
    sourceHashes: { 'electron/services/generator.ts': sha256(`source-${runId}`) },
    fixtureHashes: Object.fromEntries(caseIds.map(caseId => [`${caseId}/README.md`, sha256(`fixture-${caseId}`)])),
    reportDigest: '',
    generatedAt: '2026-10-24T00:00:00.000Z',
    cases,
    questions,
    status
  }
  if (withConfigHashInputs) {
    report.configHashInputs = {
      baseUrlOriginSha256: sha256('https://model.example.test'),
      model: report.model,
      protocol: report.protocol
    }
    report.configHash = sha256(JSON.stringify({ config: report.config, ...report.configHashInputs }))
  }
  report.reportDigest = calculateReportDigest(report)
  return report
}

function recomputeHashes(report) {
  if (report.configHashInputs) report.configHash = sha256(JSON.stringify({ config: report.config, ...report.configHashInputs }))
  report.reportDigest = calculateReportDigest(report)
  return report
}

function buildProof({ current, reuse, reusedCaseIds = ['gamma', 'delta'], entryOverrides = {}, overrides = {} }) {
  const cases = {}
  for (const caseId of reusedCaseIds) {
    const item = reuse.cases.find(caseItem => caseItem.id === caseId)
    cases[caseId] = {
      identical: true,
      originalPromptHash: item.generation.requests[0].promptHash,
      currentPromptHash: item.generation.requests[0].promptHash,
      ...(entryOverrides[caseId] ?? {})
    }
  }
  return {
    schemaVersion: 'repoprep-real-eval-reuse-proof-v1',
    cases,
    currentSourceHashes: structuredClone(current.sourceHashes),
    configuration: {
      model: current.model,
      protocol: current.protocol,
      temperature: current.config.temperature,
      contextWindowTokens: current.config.contextWindowTokens ?? null,
      profileMaxOutputTokens: current.config.profileMaxOutputTokens ?? null,
      ...overrides
    }
  }
}

function buildScenario() {
  const baseline = buildReport({ runId: 'baseline-run', caseIds: CASE_IDS, withDiagnostics: false })
  const current = buildReport({
    runId: 'current-run',
    caseIds: ['alpha', 'beta'],
    withDiagnostics: true,
    withConfigHashInputs: true,
    configExtras: { ...TOKEN_CONFIG }
  })
  const reuse = buildReport({
    runId: 'reuse-run',
    caseIds: CASE_IDS,
    withDiagnostics: true,
    withConfigHashInputs: true,
    configExtras: { ...TOKEN_CONFIG }
  })
  return { baseline, current, reuse, reuseProof: buildProof({ current, reuse }) }
}

const REFERENCES = { baseline: '../reports/baseline.json', current: '../reports/current.json', reuse: '../reports/reuse.json' }

test('composes a 2-fresh 2-reuse cohort with provenance, measured totals, and markdown', () => {
  const { baseline, current, reuse, reuseProof } = buildScenario()
  const cohort = composeRealCohort({ baseline, current, reuse, reuseProof, references: REFERENCES })

  assert.equal(cohort.schemaVersion, 'repoprep-real-eval-cohort-v1')
  assert.deepEqual(cohort.measurement, {
    caseCount: 4,
    freshCases: ['alpha', 'beta'],
    reusedCases: ['delta', 'gamma'],
    selectedMeasurementsRequests: 4,
    freshNetworkRequests: 2,
    reusedMeasurements: 2
  })
  assert.deepEqual(cohort.summary.actualUsage, { inputTokens: 400, outputTokens: 800, totalTokens: 1200 })
  assert.equal(cohort.summary.questions, 8)
  assert.deepEqual(cohort.config, { granularity: 'medium', budget: BUDGET, temperature: 0.4 })
  assert.ok(/^\d{4}-\d{2}-\d{2}T/u.test(cohort.composedAt))
  for (const item of cohort.cases) {
    const expectedRole = item.source === 'fresh' ? 'current' : 'reuse'
    assert.equal(item.sourceReportRole, expectedRole)
    assert.equal(item.originRunId, expectedRole === 'current' ? 'current-run' : 'reuse-run')
    assert.equal(item.sourceReportReference, REFERENCES[expectedRole])
    assert.equal(item.questionFingerprints.length, 2)
    assert.ok(item.questionFingerprints.every(fingerprint => /^[a-f0-9]{64}$/u.test(fingerprint)))
    assert.ok(/^[a-f0-9]{64}$/u.test(item.firstRequestPromptHash))
  }
  assert.ok(cohort.caveats.some(caveat => /not factual accuracy/u.test(caveat)))
  assert.ok(cohort.caveats.some(caveat => /never filled with zero/u.test(caveat)))

  const markdown = cohortMarkdown(cohort)
  assert.match(markdown, /Fresh measurements from the current run: 2 \(alpha, beta\)/u)
  assert.match(markdown, /Reused measurements from the prior run: 2 \(delta, gamma\)/u)
  assert.match(markdown, /Selected measurement requests \(raw request count across the selected cases\): 4/u)
  assert.match(markdown, /Fresh network requests \(all calls in the current source run, including controls\): 2/u)
  assert.match(markdown, /Reused measurements \(filled case count\): 2/u)
  assert.match(markdown, /\| Actual total tokens \| 1200 \|/u)
  assert.match(markdown, /\| alpha \| fresh \|/u)
  assert.match(markdown, /\| gamma \| reused \|/u)
  assert.match(markdown, /not itself a repoprep-eval-report-v2 run/u)
  assert.match(markdown, /not factual accuracy/u)
})

test('fresh network totals include README controls outside selected generation measurements', () => {
  const scenario = buildScenario()
  scenario.current.config.variants.push('baseline')
  scenario.current.network = { requests: scenario.current.cases.flatMap(item => item.generation.requests) }
  for (const item of scenario.current.cases) {
    const control = buildGeneration({ runId: 'readme-control', caseId: item.id, withDiagnostics: false })
    item.baseline = control.generation
    scenario.current.network.requests.push(...control.generation.requests)
    scenario.current.questions.push(...control.generation.questions.map(question => ({ ...question, caseId: item.id, variant: 'baseline' })))
  }
  recomputeHashes(scenario.current)
  const cohort = composeRealCohort(scenario)
  assert.equal(cohort.measurement.selectedMeasurementsRequests, 4)
  assert.equal(cohort.measurement.freshNetworkRequests, 4)
  assert.equal(cohort.summary.questions, 8, 'controls do not enter the selected generation cohort')
  assert.match(cohortMarkdown(cohort), /including controls\): 4/u)

  delete scenario.current.network
  const unknown = composeRealCohort(scenario)
  assert.equal(unknown.measurement.freshNetworkRequests, null)
  assert.match(cohortMarkdown(unknown), /including controls\): unknown/u)

  scenario.current.network = { requests: [] }
  assert.throws(() => composeRealCohort(scenario), /network receipt omits selected generation requests/u)
})

test('keeps missing usage unknown and falls back to recorded request receipts', () => {
  const baseline = buildReport({ runId: 'baseline-run', caseIds: CASE_IDS, withDiagnostics: false })
  const current = buildReport({
    runId: 'current-run', caseIds: ['alpha', 'beta'],
    withDiagnostics: true, withConfigHashInputs: true, configExtras: { ...TOKEN_CONFIG },
    perCase: { alpha: { usageReceipts: false } }
  })
  const reuse = buildReport({
    runId: 'reuse-run', caseIds: CASE_IDS, withDiagnostics: false,
    perCase: { delta: { usageReceipts: false } }
  })
  const cohort = composeRealCohort({ baseline, current, reuse, reuseProof: buildProof({ current, reuse }) })

  const alpha = cohort.cases.find(item => item.id === 'alpha')
  const beta = cohort.cases.find(item => item.id === 'beta')
  const gamma = cohort.cases.find(item => item.id === 'gamma')
  const delta = cohort.cases.find(item => item.id === 'delta')
  assert.deepEqual(beta.metrics.actualUsage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 })
  assert.deepEqual(gamma.metrics.actualUsage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 }, 'legacy report usage falls back to recorded request receipts')
  assert.equal(alpha.metrics.actualUsage, null)
  assert.equal(delta.metrics.actualUsage, null)
  assert.equal(cohort.summary.actualUsage, null)
  assert.equal(cohort.summary.requests, 4)

  const markdown = cohortMarkdown(cohort)
  assert.match(markdown, /\| Actual total tokens \| unknown \|/u)
  assert.match(markdown, /\| alpha \| fresh \|[^\n]*\| unknown \|/u)
  assert.doesNotMatch(markdown, /\| Actual (input|output|total) tokens \| 0 \|/u)
})

test('rejects missing, incomplete, or mismatched reuse proofs', () => {
  const scenario = buildScenario()
  assert.throws(() => composeRealCohort({ ...scenario, reuseProof: undefined }), /reuse proof is missing or malformed/u)

  const missingCase = structuredClone(scenario.reuseProof)
  delete missingCase.cases.delta
  assert.throws(() => composeRealCohort({ ...scenario, reuseProof: missingCase }), /reuse proof is missing case delta/u)

  const notIdentical = structuredClone(scenario.reuseProof)
  notIdentical.cases.gamma.identical = false
  assert.throws(() => composeRealCohort({ ...scenario, reuseProof: notIdentical }), /not marked identical/u)

  const wrongOriginal = buildProof({ current: scenario.current, reuse: scenario.reuse, entryOverrides: { gamma: { originalPromptHash: 'f'.repeat(64) } } })
  assert.throws(() => composeRealCohort({ ...scenario, reuseProof: wrongOriginal }), /prompt hashes do not match/u)

  const wrongDerived = buildProof({ current: scenario.current, reuse: scenario.reuse, entryOverrides: { delta: { currentPromptHash: 'e'.repeat(64) } } })
  assert.throws(() => composeRealCohort({ ...scenario, reuseProof: wrongDerived }), /prompt hashes do not match/u)

  const wrongSourceHashes = structuredClone(scenario.reuseProof)
  wrongSourceHashes.currentSourceHashes = { 'electron/services/generator.ts': 'mismatched' }
  assert.throws(() => composeRealCohort({ ...scenario, reuseProof: wrongSourceHashes }), /currentSourceHashes does not match/u)

  const wrongConfiguration = buildProof({ current: scenario.current, reuse: scenario.reuse, overrides: { temperature: 0.7 } })
  assert.throws(() => composeRealCohort({ ...scenario, reuseProof: wrongConfiguration }), /reuse proof configuration/u)
})

test('rejects configuration, source hash, corpus, and case-set mismatches', () => {
  const scenario = buildScenario()

  const reuseTokenConfig = buildReport({
    runId: 'reuse-run', caseIds: CASE_IDS, withDiagnostics: true, withConfigHashInputs: true,
    configExtras: { contextWindowTokens: 4096, profileMaxOutputTokens: null }
  })
  assert.throws(() => composeRealCohort({ ...scenario, reuse: reuseTokenConfig, reuseProof: buildProof({ current: scenario.current, reuse: reuseTokenConfig }) }), /reuse configuration/u)

  const reuseTemperature = buildReport({ runId: 'reuse-run', caseIds: CASE_IDS, withDiagnostics: true, withConfigHashInputs: true, configExtras: { ...TOKEN_CONFIG, temperature: 0.7 } })
  assert.throws(() => composeRealCohort({ ...scenario, reuse: reuseTemperature, reuseProof: buildProof({ current: scenario.current, reuse: reuseTemperature }) }), /settings differ/u)

  const changedOrigin = structuredClone(scenario.reuse)
  changedOrigin.configHashInputs.baseUrlOriginSha256 = sha256('https://different.example.test')
  recomputeHashes(changedOrigin)
  assert.throws(() => composeRealCohort({ ...scenario, reuse: changedOrigin }), /endpoint origins differ/u)

  const baselineTemperature = recomputeHashes(structuredClone(scenario.baseline))
  baselineTemperature.config.temperature = 0.7
  recomputeHashes(baselineTemperature)
  assert.throws(() => composeRealCohort({ ...scenario, baseline: baselineTemperature }), /baseline temperature differs/u)

  const baselineNoModel = structuredClone(scenario.baseline)
  delete baselineNoModel.model
  recomputeHashes(baselineNoModel)
  assert.throws(() => composeRealCohort({ ...scenario, baseline: baselineNoModel }), /missing required model configuration fields/u)

  const reuseCorpus = buildReport({ runId: 'reuse-run', caseIds: CASE_IDS, withDiagnostics: true, withConfigHashInputs: true, configExtras: { ...TOKEN_CONFIG } })
  reuseCorpus.corpusVersion = 'repoprep-real-corpus-v0'
  recomputeHashes(reuseCorpus)
  assert.throws(() => composeRealCohort({ ...scenario, reuse: reuseCorpus, reuseProof: buildProof({ current: scenario.current, reuse: reuseCorpus }) }), /corpus versions differ/u)

  const reuseCommit = structuredClone(scenario.reuse)
  reuseCommit.cases[2].commit = 'b'.repeat(40)
  recomputeHashes(reuseCommit)
  assert.throws(() => composeRealCohort({ ...scenario, reuse: reuseCommit, reuseProof: scenario.reuseProof }), /case gamma commit differs across input reports/u)

  const reuseFixture = structuredClone(scenario.reuse)
  reuseFixture.fixtureHashes['gamma/README.md'] = 'c'.repeat(64)
  recomputeHashes(reuseFixture)
  assert.throws(() => composeRealCohort({ ...scenario, reuse: reuseFixture, reuseProof: scenario.reuseProof }), /case gamma fixture hashes differ across input reports/u)

  const reuseMissingCase = buildReport({ runId: 'reuse-run', caseIds: ['alpha', 'beta', 'gamma'], withDiagnostics: true, withConfigHashInputs: true, configExtras: { ...TOKEN_CONFIG } })
  assert.throws(() => composeRealCohort({ ...scenario, reuse: reuseMissingCase, reuseProof: scenario.reuseProof }), /cohort case delta has no complete measurement/u)

  const currentExtraCase = buildReport({
    runId: 'current-run', caseIds: ['alpha', 'beta', 'epsilon'],
    withDiagnostics: true, withConfigHashInputs: true, configExtras: { ...TOKEN_CONFIG }
  })
  assert.throws(() => composeRealCohort({ ...scenario, current: currentExtraCase }), /case epsilon is outside the baseline case set/u)
})

test('rejects partial, tampered, and unbound reports', () => {
  const scenario = buildScenario()

  const partialCurrent = recomputeHashes({ ...structuredClone(scenario.current), status: 'partial' })
  assert.throws(() => composeRealCohort({ ...scenario, current: partialCurrent }), /current report status partial/u)

  const stubCurrent = buildReport({ runId: 'current-run', caseIds: ['alpha', 'beta'], stubCaseIds: ['beta'], withDiagnostics: true, withConfigHashInputs: true, configExtras: { ...TOKEN_CONFIG } })
  assert.throws(() => composeRealCohort({ ...scenario, current: stubCurrent }), /case beta has no complete generation measurement/u)

  const partialReuse = buildReport({ runId: 'reuse-run', status: 'partial', caseIds: CASE_IDS, withDiagnostics: true, withConfigHashInputs: true, configExtras: { ...TOKEN_CONFIG } })
  assert.throws(() => composeRealCohort({ ...scenario, reuse: partialReuse, reuseProof: scenario.reuseProof }), /reuse report status partial/u)

  const failedCurrentCase = structuredClone(scenario.current)
  failedCurrentCase.cases[1].generation = { status: 'failed', failureStage: 'generation' }
  recomputeHashes(failedCurrentCase)
  assert.throws(() => composeRealCohort({ ...scenario, current: failedCurrentCase }), /case beta has an incomplete generation measurement/u)

  const tamperedOutput = structuredClone(scenario.current)
  tamperedOutput.cases[0].output.projectSummary = 'tampered'
  assert.throws(() => composeRealCohort({ ...scenario, current: tamperedOutput }), /current report digest does not match/u)

  const tamperedQuestions = structuredClone(scenario.current)
  tamperedQuestions.cases[0].generation.questions[0].answer = 'changed answer'
  tamperedQuestions.reportDigest = calculateReportDigest(tamperedQuestions)
  assert.throws(() => composeRealCohort({ ...scenario, current: tamperedQuestions }), /not bound consistently/u)
})

test('cli writes a new cohort directory without modifying input report bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'repoprep-cohort-cli-'))
  try {
    const reportsDir = path.join(root, 'reports')
    const outputDir = path.join(root, 'cohort-out')
    await mkdir(reportsDir, { recursive: true })
    const { baseline, current, reuse, reuseProof } = buildScenario()
    const paths = {
      baseline: path.join(reportsDir, 'baseline.json'),
      current: path.join(reportsDir, 'current.json'),
      reuse: path.join(reportsDir, 'reuse.json'),
      reuseProof: path.join(reportsDir, 'proof.json')
    }
    for (const [role, report] of [['baseline', baseline], ['current', current], ['reuse', reuse], ['reuseProof', reuseProof]]) {
      await writeFile(paths[role], `${JSON.stringify(report, null, 2)}\n`)
    }
    const before = Object.fromEntries(await Promise.all(Object.values(paths).map(async value => [value, await readFile(value)])))

    const toolPath = fileURLToPath(new URL('./compose-real-cohort.mjs', import.meta.url))
    const { stdout } = await execFile(process.execPath, [toolPath, paths.baseline, paths.current, paths.reuse, paths.reuseProof, outputDir])
    const summary = JSON.parse(stdout)
    assert.deepEqual(summary.freshCases, ['alpha', 'beta'])
    assert.deepEqual(summary.reusedCases, ['delta', 'gamma'])
    assert.equal(summary.selectedMeasurementsRequests, 4)
    assert.equal(summary.freshNetworkRequests, 2)
    assert.equal(summary.reusedMeasurements, 2)

    const cohort = JSON.parse(await readFile(path.join(outputDir, 'cohort.json'), 'utf8'))
    const reportText = await readFile(path.join(outputDir, 'report.md'), 'utf8')
    assert.equal(cohort.schemaVersion, 'repoprep-real-eval-cohort-v1')
    assert.match(reportText, /Fresh measurements from the current run: 2/u)
    for (const role of ['baseline', 'current', 'reuse']) {
      assert.equal(path.resolve(outputDir, cohort.inputReports[role].reference), path.resolve(paths[role]))
    }
    for (const [value, bytes] of Object.entries(before)) {
      assert.ok(bytes.equals(await readFile(value)), `input report bytes must stay unchanged: ${value}`)
    }

    await assert.rejects(
      execFile(process.execPath, [toolPath, paths.baseline, paths.current, paths.reuse, paths.reuseProof, outputDir]),
      error => /must be new or empty/u.test(error.stderr)
    )
    await assert.rejects(
      execFile(process.execPath, [toolPath, paths.baseline, paths.current, paths.reuse, paths.reuseProof, reportsDir]),
      error => /must not contain or overwrite evaluation source inputs/u.test(error.stderr)
    )

    const tamperedProofPath = path.join(root, 'tampered-proof.json')
    const tamperedProof = structuredClone(reuseProof)
    tamperedProof.cases.gamma.originalPromptHash = 'f'.repeat(64)
    await writeFile(tamperedProofPath, `${JSON.stringify(tamperedProof, null, 2)}\n`)
    const rejectedOutputDir = path.join(root, 'rejected-out')
    await assert.rejects(
      execFile(process.execPath, [toolPath, paths.baseline, paths.current, paths.reuse, tamperedProofPath, rejectedOutputDir]),
      error => /prompt hashes do not match/u.test(error.stderr)
    )
    await assert.rejects(access(rejectedOutputDir), { code: 'ENOENT' }, 'failed composition must not create the output directory')
    assert.equal((await readdir(reportsDir)).sort().join(','), ['baseline.json', 'current.json', 'proof.json', 'reuse.json'].join(','))
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('repoprep-cohort-cli-'))
    assert.equal((await lstat(root)).isSymbolicLink(), false)
    await rm(root, { recursive: true, force: true })
  }
})
