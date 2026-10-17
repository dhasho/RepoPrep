import test from 'node:test'
import assert from 'node:assert/strict'
import { fingerprintQuestion, scoreCase } from './scorer.mjs'
import { makeReviewTemplate, validateReview, calculateReportDigest } from './review.mjs'

const fixture = { budget: { min: 2, target: 2, max: 3 }, knownFacts: [{ id: 'fact', keywords: ['useState'] }], forbiddenAssertions: [{ id: 'redux', patterns: ['\\bRedux\\b'] }] }
const valid = (questions) => ({ version: 1, createdAt: new Date().toISOString(), projectName: 'fixture', projectPath: '/fixtures/x', granularity: 'medium', roleFocus: 'general', profileId: 'synthetic', modelUsed: 'offline', projectSummary: '', sections: [{ id: 's', title: 's', questions: questions.map((question, i) => ({ id: `q${i}`, question, answer: 'useState is shown in the fixture.', followUps: [] })) }], glossary: {}, security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} } })

test('scorer alarms on invalid contract, repeated wording, forbidden assertion, quota and missing facts', () => {
  const report = scoreCase({ ...valid(['same question', 'same question']), projectPath: 'fixture://not-absolute', sections: [{ id: 'x', title: 'x', questions: [{ id: 'q', question: 'Redux is configured?', answer: '', followUps: [] }] }] }, fixture)
  assert.ok(report.alerts.includes('invalid_result_contract'))
  assert.ok(report.alerts.includes('question_quota_out_of_range'))
  assert.ok(report.alerts.includes('forbidden_assertion_present'))
  assert.ok(report.alerts.includes('known_fact_keyword_missing'))
  const duplicate = scoreCase(valid(['same question?', 'same   question?']), fixture)
  assert.ok(duplicate.alerts.includes('duplicate_questions'))
})

test('positive result with portable fixture identity passes contract and quota', () => {
  const report = scoreCase(valid(['How does useState work?', 'Where is the filter applied?']), fixture)
  assert.equal(report.contract.pass, true)
  assert.equal(report.quota.pass, true)
  assert.deepEqual(report.alerts, [])
})

test('old results without evidence remain scoreable and external evidence is marked contract-only', () => {
  const oldResult = valid(['How does useState work?', 'Where is the filter applied?'])
  const report = scoreCase(oldResult, fixture)
  assert.equal(report.contract.pass, true)
  assert.deepEqual(report.sourceEvidence.questionCoverage, { questionsWithRetainedEvidence: 0, reportedEvidenceBearingQuestions: 0, totalQuestions: 2, rate: 0 })
  assert.equal(report.sourceEvidence.declaredStats, null)
  assert.equal(report.sourceEvidence.verification, 'external-result-contract-only')
  const evidence = { sourceId: 'declared-source', snapshotHash: 'b'.repeat(64), path: 'src/App.jsx', startLine: 1, endLine: 1, excerpt: 'useState(0)' }
  const externalResult = valid(['How does useState work?', 'Where is the filter applied?'])
  externalResult.sections[0].questions[0].sourceEvidence = [{ ...evidence }]
  externalResult.sections[0].questions[1].sourceEvidence = [{ ...evidence }]
  externalResult.sourceEvidenceSummary = { asked: 2, accepted: 2, rejected: 0, retained: 2 }
  const externalWithDeclaredCounts = scoreCase(externalResult, fixture)
  assert.equal(externalWithDeclaredCounts.contract.pass, true)
  assert.equal(externalWithDeclaredCounts.sourceEvidence.verification, 'external-result-contract-only')
  assert.match(externalWithDeclaredCounts.sourceEvidence.scopeNote, /does not prove any reference was sent to a model/)
})

test('production-resolved canonical evidence and summary counts agree; clone refs satisfy contract', () => {
  const evidence = { sourceId: 'source-1', snapshotHash: 'a'.repeat(64), path: 'src/App.jsx', startLine: 1, endLine: 1, excerpt: 'const state = useState(0)' }
  const result = valid(['How does useState work?', 'Where is the filter applied?'])
  result.sections[0].questions[0].sourceEvidence = [{ ...evidence }]
  result.sections[0].questions[1].sourceEvidence = [{ ...evidence }]
  result.sourceEvidenceSummary = { asked: 3, accepted: 2, rejected: 1, retained: 2 }
  const report = scoreCase(result, fixture, { evidenceVerification: 'production-request-resolved' })
  assert.equal(report.contract.pass, true)
  assert.equal(report.sourceEvidence.sourceEvidenceContract.pass, true)
  assert.equal(report.sourceEvidence.questionCoverage.questionsWithRetainedEvidence, 2)
  assert.equal(report.sourceEvidence.retainedCanonicalRefs.length, 2)
  assert.deepEqual(report.sourceEvidence.declaredStats, { asked: 3, accepted: 2, rejected: 1, retained: 2, actualRetained: 2, retainedCountMatchesActual: true })
})

test('illegal evidence contract and retained-summary mismatch cannot pass', () => {
  const evidence = { sourceId: 'source-1', snapshotHash: 'a'.repeat(64), path: 'src/App.jsx', startLine: 1, endLine: 1, excerpt: 'useState(0)' }
  const result = valid(['How does useState work?', 'Where is the filter applied?'])
  result.sections[0].questions[0].sourceEvidence = [{ ...evidence }]
  result.sections[0].questions[1].sourceEvidence = [{ ...evidence }]
  result.sourceEvidenceSummary = { asked: 2, accepted: 2, rejected: 0, retained: 1 }
  const report = scoreCase(result, fixture, { evidenceVerification: 'production-request-resolved' })
  assert.equal(report.contract.pass, false)
  assert.equal(report.sourceEvidence.sourceEvidenceContract.pass, false)
  assert.ok(report.alerts.includes('invalid_source_evidence_contract'))
  const malformed = valid(['How does useState work?', 'Where is the filter applied?'])
  malformed.sections[0].questions[0].sourceEvidence = [{ ...evidence, snapshotHash: 'bad' }]
  const malformedScore = scoreCase(malformed, fixture)
  assert.equal(malformedScore.contract.pass, false)
  assert.equal(malformedScore.sourceEvidence.sourceEvidenceContract.pass, false)
  assert.ok(malformedScore.alerts.includes('invalid_source_evidence_contract'))
  const emptyObject = valid(['How does useState work?', 'Where is the filter applied?'])
  emptyObject.sections[0].questions[0].sourceEvidence = [{}]
  const emptyObjectScore = scoreCase(emptyObject, fixture)
  assert.equal(emptyObjectScore.contract.pass, false)
  assert.equal(emptyObjectScore.sourceEvidence.sourceEvidenceContract.pass, false)
  assert.equal(emptyObjectScore.sourceEvidence.questionCoverage.questionsWithRetainedEvidence, 0)
  assert.equal(emptyObjectScore.sourceEvidence.questionCoverage.reportedEvidenceBearingQuestions, 1)
  assert.equal(emptyObjectScore.sourceEvidence.questionCoverage.rate, 0)
  assert.deepEqual(emptyObjectScore.sourceEvidence.retainedCanonicalRefs, [])
  assert.ok(emptyObjectScore.alerts.includes('invalid_source_evidence_contract'))
})

test('malformed arrays and null sections safely report contract failure', () => {
  for (const invalid of [null, {}, { sections: null }, { sections: [null] }, { sections: [{ questions: null }] }]) {
    const report = scoreCase(invalid, fixture)
    assert.equal(report.contract.pass, false)
    assert.ok(Array.isArray(report.alerts))
  }
})

test('human review template binds fingerprints to a run and remains pending until all dimensions are rated', () => {
  const evidence = { sourceId: 'source-a', snapshotHash: 'a'.repeat(64), path: 'src/App.jsx', startLine: 1, endLine: 1, excerpt: 'useState(0)' }
  const run = { runId: 'r1', corpusVersion: 'v1', configHash: 'cfg', sourceHashes: {}, fixtureHashes: {}, cases: [], questions: [{ caseId: 'a', variant: 'generation', question: 'How useState works?', answer: 'Shown', followUps: [{ question: 'Why?', answer: 'Because.' }], sourceEvidence: [evidence] }] }
  run.reportDigest = calculateReportDigest(run)
  const manifest = { ...run }
  const template = makeReviewTemplate(run)
  assert.deepEqual(template.ratings[0].sourceEvidence, [evidence])
  assert.match(template.rubric.factualCorrectness, /does not prove semantic support/)
  assert.equal(validateReview(template, manifest).status, 'pending')
  template.ratings[0].factualCorrectness = 5
  template.ratings[0].projectRelevance = 4
  template.ratings[0].semanticDuplication = 5
  assert.equal(validateReview(template, manifest).coverage, 1)
  assert.throws(() => validateReview({ ...template, runId: 'other' }, manifest), /different or unknown run/)
  assert.throws(() => validateReview({ ...template, reportDigest: 'sha256:other' }, manifest), /different or unknown run/)
  assert.throws(() => validateReview({ ...template, ratings: [...template.ratings, template.ratings[0]] }, manifest), /duplicate/)
  assert.throws(() => validateReview({ ...template, ratings: [{ ...template.ratings[0], fingerprint: 'nope' }] }, manifest), /unknown/)
  assert.throws(() => validateReview({ ...template, ratings: [{ ...template.ratings[0], projectRelevance: 6 }] }, manifest), /out of range/)
  assert.throws(() => validateReview({ ...template, ratings: [{ ...template.ratings[0], question: 'changed text' }] }, manifest), /unknown/)
  assert.throws(() => validateReview(template, { ...manifest, cases: [{ id: 'mutated', output: {}, baseline: {} }] }), /digest/)
  assert.throws(() => validateReview(template, { ...manifest, questions: [{ ...manifest.questions[0], followUps: [] }] }), /digest/)
  assert.throws(() => validateReview(template, { ...manifest, questions: [{ ...manifest.questions[0], sourceEvidence: [] }] }), /digest/)
  assert.throws(() => validateReview({ ...template, ratings: [{ ...template.ratings[0], followUps: [] }] }, manifest), /unknown/)
  assert.throws(() => validateReview({ ...template, ratings: [{ ...template.ratings[0], sourceEvidence: [] }] }, manifest), /unknown/)
})
