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
      output.push({ question: typeof q.question === 'string' ? q.question : '', answer: typeof q.answer === 'string' ? q.answer : '', section: typeof section.title === 'string' ? section.title : '', followUps: Array.isArray(q.followUps) ? q.followUps : [], sourceEvidence: Array.isArray(q.sourceEvidence) ? q.sourceEvidence : [] })
    }
  }
  return output
}

export function scoreCase(result, fixture, { evidenceVerification = 'external-result-contract-only' } = {}) {
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
  const reportedEvidenceRefs = questions.flatMap((question, questionIndex) => question.sourceEvidence.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return { questionIndex, invalidShape: true }
    const textOrNull = value => typeof value === 'string' ? value : null
    const intOrNull = value => Number.isSafeInteger(value) ? value : null
    return { questionIndex, sourceId: textOrNull(ref.sourceId), snapshotHash: textOrNull(ref.snapshotHash), path: textOrNull(ref.path), startLine: intOrNull(ref.startLine), endLine: intOrNull(ref.endLine), excerpt: textOrNull(ref.excerpt) }
  }))
  const reportedEvidenceBearingQuestions = questions.filter(question => question.sourceEvidence.length > 0).length
  const summary = result && typeof result === 'object' && result.sourceEvidenceSummary && typeof result.sourceEvidenceSummary === 'object'
    ? result.sourceEvidenceSummary
    : null
  const retainedCountMatches = summary && Number.isInteger(summary.retained) ? summary.retained === reportedEvidenceRefs.length : null
  const hasEvidenceField = Array.isArray(result?.sections) && result.sections.some(section => Array.isArray(section?.questions) && section.questions.some(question => question && typeof question === 'object' && Object.hasOwn(question, 'sourceEvidence')))
  const evidencePresent = reportedEvidenceRefs.length > 0 || summary !== null || hasEvidenceField
  const sourceEvidenceContractPass = !evidencePresent || (contractValid && (retainedCountMatches === null || retainedCountMatches))
  const evidenceMetrics = {
    verification: evidenceVerification,
    scopeNote: evidenceVerification === 'production-request-resolved'
      ? 'Production generateInterview resolved returned IDs and line ranges against the request manifest; this does not establish semantic support.'
      : evidenceVerification === 'baseline-no-source-manifest'
        ? 'Baseline provided no code source manifest; source references were unavailable.'
        : 'External result evidence can be checked against result contract and declared counts only; this does not prove any reference was sent to a model or semantically supports an answer.',
    questionCoverage: {
      questionsWithRetainedEvidence: sourceEvidenceContractPass ? reportedEvidenceBearingQuestions : 0,
      reportedEvidenceBearingQuestions,
      totalQuestions: questions.length,
      rate: questions.length && sourceEvidenceContractPass ? reportedEvidenceBearingQuestions / questions.length : 0
    },
    retainedCanonicalRefs: sourceEvidenceContractPass ? reportedEvidenceRefs : [],
    declaredStats: summary ? {
      asked: Number.isSafeInteger(summary.asked) ? summary.asked : null,
      accepted: Number.isSafeInteger(summary.accepted) ? summary.accepted : null,
      rejected: Number.isSafeInteger(summary.rejected) ? summary.rejected : null,
      retained: Number.isSafeInteger(summary.retained) ? summary.retained : null,
      actualRetained: reportedEvidenceRefs.length,
      retainedCountMatchesActual: retainedCountMatches
    } : null,
    sourceEvidenceContract: { pass: sourceEvidenceContractPass }
  }
  return {
    contract: { pass: contractValid },
    quota: { pass: quotaPass, actual: questions.length, ...budget },
    duplicateRate: { count: duplicateCount, denominator: questions.length, rate: questions.length ? duplicateCount / questions.length : 0 },
    knownFactCoverage: { covered: Object.values(coverage).filter(x => x.covered).length, total: Object.keys(coverage).length, facts: coverage },
    sourceEvidence: evidenceMetrics,
    forbiddenAssertionHits: forbiddenHits,
    alerts: [
      ...(!contractValid ? ['invalid_result_contract'] : []), ...(!quotaPass ? ['question_quota_out_of_range'] : []),
      ...(duplicateCount ? ['duplicate_questions'] : []), ...(forbiddenHits.length ? ['forbidden_assertion_present'] : []),
      ...(Object.values(coverage).some(x => !x.covered) ? ['known_fact_keyword_missing'] : []),
      ...(!sourceEvidenceContractPass ? ['invalid_source_evidence_contract'] : [])
    ]
  }
}

export function fingerprintQuestion(question, { caseId = '', variant = 'generation', answer = '', followUps = [], sourceEvidence = [] } = {}) {
  return createHash('sha256').update(JSON.stringify([caseId, variant, normalizeQuestionKey(question), answer, followUps, sourceEvidence])).digest('hex')
}
