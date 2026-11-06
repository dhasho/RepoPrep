import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadDatasetBundle } from '../dataset-contract.mjs'
import { checkAuthorizationArtifact, hashRetrievalData, getCleanSourceBinding, recomputeRetrievalMetrics, verifyRetrievalReport } from '../retrieval-eval.mjs'
import { unknownCheck } from '../gate-runner.mjs'

const METRICS = ['completeEvidenceTaskRate', 'invalidToolExecution', 'repeatedReadRate', 'limitViolations', 'usageComplete']
const MISSING = (reason) => unknownCheck(reason)

export function createChecks(options = {}) {
  return new Map([['m06:frozen-retrieval-tasks', async ctx => {
    if (ctx.mode !== 'real') return MISSING('real-report-required')
    if (typeof options.reportPath !== 'string' || typeof options.authorizationPath !== 'string') return MISSING('report-and-authorization-path-required')
    try {
      const sourceRoot = path.resolve(options.sourceRoot ?? process.cwd())
      const [authStat, reportStat] = await Promise.all([lstat(options.authorizationPath), lstat(options.reportPath)])
      if (!authStat.isFile() || authStat.isSymbolicLink() || authStat.size > 16 * 1024 || !reportStat.isFile() || reportStat.isSymbolicLink() || reportStat.size > 8 * 1024 * 1024) return MISSING('artifact-unavailable')
      const [binding, bundle, report] = await Promise.all([
        checkAuthorizationArtifact({ repoRoot: sourceRoot, authorizationPath: options.authorizationPath }),
        loadDatasetBundle(path.join(sourceRoot, 'scripts/agentic/datasets/v1')),
        readFile(options.reportPath, 'utf8').then(JSON.parse)
      ])
      const auth = JSON.parse(await readFile(options.authorizationPath, 'utf8'))
      if (report.authorizationReference !== auth.reference || report.purpose !== 'm06-retrieval-v1') throw new Error('authorization-reference-mismatch')
      const sourceCommit = getCleanSourceBinding(sourceRoot)
      const retrievalDataHash = await hashRetrievalData(path.join(sourceRoot, 'scripts/agentic/datasets/v1'))
      const verified = verifyRetrievalReport(report, bundle, { sourceCommit, retrievalDataHash, maxRequests: auth.maxRequests, maxInputTokens: auth.maxInputTokens, maxOutputTokens: auth.maxOutputTokensTotal, provider: auth })
      const measured = recomputeRetrievalMetrics(report, bundle)
      if (!verified.valid || binding.sourceCommit !== sourceCommit || binding.retrievalDataHash !== retrievalDataHash) throw new Error('report-verification-failed')
      for (const id of METRICS) ctx.recordMetric(id, measured[id], `report-metric:${id}`)
      ctx.addRawReference(`report-binding:${report.sourceCommit}:${report.retrievalDataHash}`)
      return { completeEvidenceTaskRate: measured.completeEvidenceTaskRate, invalidToolExecution: measured.invalidToolExecution, repeatedReadRate: measured.repeatedReadRate, limitViolations: measured.limitViolations, usageComplete: measured.usageComplete }
    } catch {
      return MISSING('report-verification-failed')
    }
  }]])
}

export const checks = createChecks()
