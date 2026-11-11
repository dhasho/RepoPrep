import { unknownCheck } from '../gate-runner.mjs'
import { captureM09CheckerSession } from '../m09-quality-host.mjs'
import { M09_LIMITS } from '../m09-manifest.mjs'
import { semanticCanonicalJson } from '../semantic-review.mjs'

const fail = code => { throw new Error(code) }
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max

/** Pure measurement for boundary tests. This function grants no host authority. */
export function measureM09Quality(quality, budget, limits = M09_LIMITS) {
  if (semanticCanonicalJson(limits) !== semanticCanonicalJson(M09_LIMITS)) fail('M09_LIMITS_CHANGED')
  const review = quality?.review; const repair = quality?.repair
  if (quality?.schemaVersion !== 1 || quality.kind !== 'semantic-quality-only' || review?.denominator !== 80 || review.bad !== 40 || review.good !== 40 || repair?.denominator !== 20 || !integer(review.detectedBad, 40) || !integer(review.flaggedGood, 40) || !integer(repair.correct, 20) || !integer(repair.introducedIssues, 1280) || review.recall !== review.detectedBad / 40 || review.falsePositiveRate !== review.flaggedGood / 40 || repair.correctRate !== repair.correct / 20 || repair.failed !== 20 - repair.correct) fail('M09_QUALITY_DENOMINATOR_INVALID')
  const metrics = Object.freeze({ errorRecall: review.recall, falsePositiveRate: review.falsePositiveRate, correctRepairs: repair.correct, introducedMaterialErrors: repair.introducedIssues, budgetCompliant: budget?.compliant === true && budget.cases === 100 && budget.reviews === 80 && budget.repairs === 20 && budget.accounting?.unknownRequests === 0 })
  const complete = quality.completeness?.complete === true && Array.isArray(quality.completeness.issues) && quality.completeness.issues.length === 0 && review.uncertain === 0 && review.incomplete === 0 && repair.incomplete === 0 && repair.notRun === 0
  const thresholdsMet = complete && metrics.budgetCompliant && metrics.errorRecall >= limits.errorRecallMin && metrics.falsePositiveRate <= limits.falsePositiveRateMax && metrics.correctRepairs >= limits.correctRepairsMin && metrics.introducedMaterialErrors <= limits.introducedMaterialErrorsMax
  return Object.freeze({ metrics, complete, thresholdsMet })
}

/** An opaque live same-host session is the only accepted input, never a report. */
export function createChecks({ qualitySession } = {}) {
  return new Map([['m09:frozen-review-and-repair-set', async ctx => {
    if (ctx.mode !== 'real') return unknownCheck('m09-real-same-host-required')
    let captured
    try { captured = await captureM09CheckerSession(qualitySession) }
    catch { return unknownCheck('m09-live-same-host-session-unavailable') }
    if (captured.mode !== 'real' || captured.execution?.mode !== 'real' || captured.execution.nativeProvenance !== 'parent-observed-native-close' || captured.execution.executionComplete !== true || captured.execution.cases !== 100 || captured.execution.executionHash !== captured.quality?.executionHash || captured.execution.publicDataHash !== captured.quality?.publicDataHash) fail('M09_LIVE_EXECUTION_INVALID')
    const measured = measureM09Quality(captured.quality, captured.budget, ctx.definition?.limits)
    for (const [id, value] of Object.entries(measured.metrics)) ctx.recordMetric(id, value, `m09-same-host:${captured.quality.executionHash}:${captured.quality.judgmentsHash}`)
    if (!measured.thresholdsMet) fail('M09_QUALITY_OR_BUDGET_THRESHOLD_FAILED')
    return Object.freeze({ executionHash: captured.quality.executionHash, judgmentsHash: captured.quality.judgmentsHash, reviews: 80, repairs: 20, qualityComplete: measured.complete, nativeBoundary: 'trusted-root-native-observations' })
  }]])
}
export const checks = createChecks()
