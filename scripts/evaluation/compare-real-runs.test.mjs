import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { calculateReportDigest } from './review.mjs'
import { compareRealRuns, comparisonMarkdown } from './compare-real-runs.mjs'

function run({ runId, questions, sourceHash, contextWindowTokens = null, fixtureHash = 'a'.repeat(64), budget = { min: 1, max: 1 } }) {
  const outputQuestions = questions.map(question => ({ question, answer: 'A', followUps: [] }))
  const output = { projectSummary: `result-${runId}`, sections: [{ title: 'Example', questions: outputQuestions }] }
  const diagnostics = runId === 'old' ? undefined : { estimatedInputTokens: 12, usageComplete: false, actualUsage: null, repairRequestCount: 0, compensationRequestCount: 0 }
  const record = {
    status: 'complete',
    questions: outputQuestions,
    requests: [{ attempt: 'initial' }],
    requestCount: 1,
    elapsedMs: 100,
    tokens: null,
    ...(diagnostics ? { diagnostics, output: { ...output, evaluationDiagnostics: diagnostics } } : {}),
    scored: { knownFactCoverage: { covered: 1, total: 1 } }
  }
  const report = {
    schemaVersion: 'repoprep-eval-report-v2',
    runId,
    corpusVersion: 'corpus-v1',
    mode: 'real-model-public-repositories',
    model: 'model-v1',
    protocol: 'openai',
    config: {
      variants: runId === 'old' ? ['generation', 'baseline'] : ['generation'],
      granularity: 'medium', budget, temperature: 0.4,
      contextWindowTokens, maxOutputTokens: null,
      applicationInputTokenBudget: contextWindowTokens ?? 32000,
      contextStrategy: runId === 'old' ? null : 'structure-v1',
      maxOutputTokensPolicy: 'provider-default',
      reservedOutputPolicy: 'application-default-reserve-16384'
    },
    configHash: `config-${runId}`,
    sourceHashes: { 'electron/services/generator.ts': sourceHash },
    fixtureHashes: { 'case/README.md': fixtureHash },
    reportDigest: '',
    generatedAt: '2026-10-23T00:00:00.000Z',
    cases: [{ id: 'case', repository: 'example/case', commit: 'a'.repeat(40), granularity: 'medium', budget, output: diagnostics ? { ...record.output } : output, generation: record }],
    questions: questions.map(question => ({ caseId: 'case', variant: 'generation', question, answer: 'A', followUps: [] })),
    status: 'complete'
  }
  if (diagnostics) {
    report.configHashInputs = {
      baseUrlOriginSha256: createHash('sha256').update('https://model.example.test').digest('hex'),
      model: report.model,
      protocol: report.protocol
    }
    report.configHash = createHash('sha256').update(JSON.stringify({ config: report.config, ...report.configHashInputs })).digest('hex')
  }
  report.reportDigest = calculateReportDigest(report)
  return report
}

test('compares complete same-fixture generation runs while recording source and token-policy differences', () => {
  const baseline = run({ runId: 'old', questions: ['Q1'], sourceHash: 'source-old' })
  const candidate = run({ runId: 'new', questions: ['Q1', 'Q2'], sourceHash: 'source-new', contextWindowTokens: 40_000 })
  const comparison = compareRealRuns(baseline, candidate)
  assert.equal(compareRealRuns(baseline, baseline).sourceHashChanges.length, 0, 'a frozen legacy report remains comparable with itself')
  assert.deepEqual(comparison.candidate.summary.actualUsage, null)
  assert.equal(comparison.candidate.summary.estimatedInputTokens, 12)
  assert.deepEqual(comparison.candidate.summary.keywordCoverage, { covered: 1, total: 1 })
  assert.equal(comparison.sourceHashChanges.length, 1)
  assert.equal(comparison.conditions.baseline.contextWindowTokens, null)
  assert.equal(comparison.conditions.candidate.contextWindowTokens, 40_000)
  assert.match(comparisonMarkdown(comparison), /structure-v1/u)
  assert.match(comparisonMarkdown(comparison), /provider-default/u)
  assert.match(comparisonMarkdown(comparison), /Baseline report SHA-256/u)
  assert.match(comparisonMarkdown(comparison), /not factual accuracy/u)
  assert.match(comparisonMarkdown(comparison), /Actual provider token totals are null/u)
})

test('compares the retained frozen baseline report with itself using its legacy schema', async () => {
  const reportPath = new URL('../../reports/real-generation-eval/2026-10-23-deepseek-v4-flash/report.json', import.meta.url)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const comparison = compareRealRuns(report, report)
  assert.equal(comparison.cases.length, 4)
  assert.equal(comparison.baseline.summary.questions, 80)
  assert.deepEqual(comparison.baseline.summary.actualUsage, comparison.candidate.summary.actualUsage)
  assert.equal(comparison.sourceHashChanges.length, 0)
})

test('rejects corrupt, partial, fixture-mismatched, case-mismatched, and budget-mismatched reports', () => {
  const baseline = run({ runId: 'old', questions: ['Q1'], sourceHash: 'old' })
  const candidate = run({ runId: 'new', questions: ['Q1'], sourceHash: 'new' })
  const corrupt = structuredClone(candidate)
  corrupt.cases[0].output.projectSummary = 'tampered'
  assert.throws(() => compareRealRuns(baseline, corrupt), /digest does not match/u)

  const partial = structuredClone(candidate)
  partial.status = 'partial'
  assert.throws(() => compareRealRuns(baseline, partial), /partial/u)

  const invalidConfigHash = structuredClone(candidate)
  invalidConfigHash.config.temperature = 0.2
  invalidConfigHash.reportDigest = calculateReportDigest(invalidConfigHash)
  assert.throws(() => compareRealRuns(baseline, invalidConfigHash), /config hash/u)

  const fixtureMismatch = run({ runId: 'new', questions: ['Q1'], sourceHash: 'new', fixtureHash: 'b'.repeat(64) })
  assert.throws(() => compareRealRuns(baseline, fixtureMismatch), /fixture hashes differ/u)

  const caseMismatch = structuredClone(candidate)
  caseMismatch.cases[0].commit = 'b'.repeat(40)
  caseMismatch.reportDigest = calculateReportDigest(caseMismatch)
  assert.throws(() => compareRealRuns(baseline, caseMismatch), /case revision differs/u)

  const caseBudgetMismatch = structuredClone(candidate)
  caseBudgetMismatch.cases[0].budget = { min: 2, max: 2 }
  caseBudgetMismatch.reportDigest = calculateReportDigest(caseBudgetMismatch)
  assert.throws(() => compareRealRuns(baseline, caseBudgetMismatch), /case budget differs/u)

  const outputMismatch = structuredClone(candidate)
  outputMismatch.cases[0].generation.output.projectSummary = 'different canonical output'
  outputMismatch.reportDigest = calculateReportDigest(outputMismatch)
  assert.throws(() => compareRealRuns(baseline, outputMismatch), /canonical generation output differs/u)

  const questionMismatch = structuredClone(candidate)
  questionMismatch.cases[0].generation.questions[0].answer = 'different answer'
  questionMismatch.reportDigest = calculateReportDigest(questionMismatch)
  assert.throws(() => compareRealRuns(baseline, questionMismatch), /questions are not bound consistently/u)

  const budgetMismatch = run({ runId: 'new', questions: ['Q1'], sourceHash: 'new', budget: { min: 2, max: 2 } })
  assert.throws(() => compareRealRuns(baseline, budgetMismatch), /settings differ/u)

  const noGeneration = structuredClone(candidate)
  noGeneration.config.variants = ['baseline']
  noGeneration.reportDigest = calculateReportDigest(noGeneration)
  assert.throws(() => compareRealRuns(baseline, noGeneration), /no generation variant/u)
})
