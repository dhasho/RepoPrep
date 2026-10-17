import { createHash } from 'node:crypto'
import { normalizeQuestionKey } from '../../electron/services/question-dedupe.ts'
import { assertInterviewResultContract } from '../../shared/result-contract.ts'

export const CORPUS_VERSION = 'repoprep-eval-corpus-v1'
export const SCHEMA_VERSION = 'repoprep-eval-report-v2'

export function flattenQuestions(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.sections)) return []
  const output = []
  for (const section of result.sections) {
    if (!section || typeof section !== 'object' || !Array.isArray(section.questions)) continue
    for (const q of section.questions) {
      if (!q || typeof q !== 'object') continue
      output.push({ question: typeof q.question === 'string' ? q.question : '', answer: typeof q.answer === 'string' ? q.answer : '', section: typeof section.title === 'string' ? section.title : '', followUps: Array.isArray(q.followUps) ? q.followUps : [] })
    }
  }
  return output
}

export function scoreCase(result, fixture) {
  let contractValid = true
  try { assertInterviewResultContract(result) } catch { contractValid = false }
  const questions = flattenQuestions(result)
  const keys = questions.map(item => normalizeQuestionKey(item.question))
  const unique = new Set(keys)
  const duplicateCount = keys.length - unique.size
  const allText = questions.map(q => `${q.question}\n${q.answer}\n${JSON.stringify(q.followUps)}`).join('\n')
  const coverage = Object.fromEntries(fixture.knownFacts.map(fact => [fact.id, {
    covered: fact.keywords.some(keyword => allText.toLowerCase().includes(keyword.toLowerCase())), keywords: fact.keywords
  }]))
  const forbiddenHits = fixture.forbiddenAssertions.filter(assertion => assertion.patterns.some(pattern => new RegExp(pattern, 'i').test(allText))).map(assertion => assertion.id)
  const budget = fixture.budget
  const quotaPass = questions.length >= budget.min && questions.length <= budget.max
  return {
    contract: { pass: contractValid },
    quota: { pass: quotaPass, actual: questions.length, ...budget },
    duplicateRate: { count: duplicateCount, denominator: questions.length, rate: questions.length ? duplicateCount / questions.length : 0 },
    knownFactCoverage: { covered: Object.values(coverage).filter(x => x.covered).length, total: Object.keys(coverage).length, facts: coverage },
    forbiddenAssertionHits: forbiddenHits,
    alerts: [
      ...(!contractValid ? ['invalid_result_contract'] : []), ...(!quotaPass ? ['question_quota_out_of_range'] : []),
      ...(duplicateCount ? ['duplicate_questions'] : []), ...(forbiddenHits.length ? ['forbidden_assertion_present'] : []),
      ...(Object.values(coverage).some(x => !x.covered) ? ['known_fact_keyword_missing'] : [])
    ]
  }
}

export function fingerprintQuestion(question, { caseId = '', variant = 'generation', answer = '', followUps = [], sourceEvidence = [] } = {}) {
  return createHash('sha256').update(JSON.stringify([caseId, variant, normalizeQuestionKey(question), answer, followUps, sourceEvidence])).digest('hex')
}
