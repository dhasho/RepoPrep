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

test('malformed arrays and null sections safely report contract failure', () => {
  for (const invalid of [null, {}, { sections: null }, { sections: [null] }, { sections: [{ questions: null }] }]) {
    const report = scoreCase(invalid, fixture)
    assert.equal(report.contract.pass, false)
    assert.ok(Array.isArray(report.alerts))
  }
})

test('human review template binds fingerprints to a run and remains pending until all dimensions are rated', () => {
  const run = { runId: 'r1', corpusVersion: 'v1', configHash: 'cfg', sourceHashes: {}, fixtureHashes: {}, cases: [], questions: [{ caseId: 'a', variant: 'generation', question: 'How useState works?', answer: 'Shown' }] }
  run.reportDigest = calculateReportDigest(run)
  const manifest = { ...run }
  const template = makeReviewTemplate(run)
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
})
