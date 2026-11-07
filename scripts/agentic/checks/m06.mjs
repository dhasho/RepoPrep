import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson } from '../dataset-contract.mjs'
import { checkAuthorizationArtifact, verifyAuthorizationClaim, hashRetrievalData, getCleanSourceBinding, loadRetrievalBundle, validateRetrievalBundle, recomputeRetrievalMetrics, verifyRetrievalReport } from '../retrieval-eval.mjs'
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
        loadRetrievalBundle(path.join(sourceRoot, 'scripts/agentic/datasets/v1')),
        readFile(options.reportPath, 'utf8').then(JSON.parse)
      ])
      const auth = JSON.parse(await readFile(options.authorizationPath, 'utf8'))
      if (report.authorizationReference !== auth.reference || report.purpose !== 'm06-retrieval-v1') throw new Error('authorization-reference-mismatch')
      await verifyAuthorizationClaim({ claimPath: path.join(sourceRoot, '.validation/agentic/claims', `${report.authorizationClaimId}.json`), authorization: auth, repoRoot: sourceRoot })
      if (!Array.isArray(report.runs) || report.runs.length !== 40) throw new Error('incomplete-run-matrix')
      const runByKey = new Map(report.runs.map(run => [`${run?.taskId}:${run?.repeat}`, run]))
      for (const task of bundle.retrievalTasks.tasks) {
        for (const repeat of [1, 2]) {
          const key = `${task.id}:${repeat}`
          const reportRun = runByKey.get(key)
          if (!reportRun) throw new Error('missing-raw-run')
          const rawPath = path.join(path.dirname(options.reportPath), `run-${task.id}-r${repeat}.json`)
          const rawStat = await lstat(rawPath)
          if (!rawStat.isFile() || rawStat.isSymbolicLink() || rawStat.size > 2 * 1024 * 1024) throw new Error('raw-run-unavailable')
          const rawRun = JSON.parse(await readFile(rawPath, 'utf8'))
          if (canonicalJson(rawRun) !== canonicalJson(reportRun)) throw new Error('raw-run-mismatch')
        }
      }
      const journalPath = path.join(path.dirname(options.reportPath), 'progress.ndjson')
      const journalStat = await lstat(journalPath)
      if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.size > 2 * 1024 * 1024) throw new Error('request-journal-unavailable')
      const journal = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const admissions = new Map(), usages = new Map()
      for (const event of journal) {
        if (!event || typeof event !== 'object' || typeof event.runId !== 'string' || typeof event.requestId !== 'string') throw new Error('request-journal-invalid')
        const id = `${event.runId}:${event.requestId}`
        if (event.type === 'request-admitted') {
          if (admissions.has(id) || !Number.isSafeInteger(event.estimatedInputTokens) || event.estimatedInputTokens < 0 || !Number.isSafeInteger(event.estimatedOutputTokens) || event.estimatedOutputTokens < 0 || !Number.isSafeInteger(event.contextChars) || event.contextChars < 0) throw new Error('request-journal-invalid')
          admissions.set(id, event)
        } else if (event.type === 'provider-usage') {
          if (usages.has(id) || !event.usage || !Number.isSafeInteger(event.usage.inputTokens) || !Number.isSafeInteger(event.usage.outputTokens) || event.usage.totalTokens !== event.usage.inputTokens + event.usage.outputTokens) throw new Error('request-journal-invalid')
          usages.set(id, event.usage)
        } else if (event.type !== 'usage-unknown') throw new Error('request-journal-invalid')
      }
      for (const run of report.runs) {
        const runId = `${run.taskId}-r${run.repeat}`
        const reservations = run.receipt?.reservations
        if (!Array.isArray(reservations) || reservations.length !== run.receipt.requests) throw new Error('run-receipts-invalid')
        for (const reservation of reservations) {
          const id = `${runId}:${reservation.id}`
          const admission = admissions.get(id), usage = usages.get(id)
          if (!admission || !usage || admission.estimatedInputTokens !== reservation.reservedInputTokens || admission.estimatedOutputTokens !== reservation.reservedOutputTokens || admission.contextChars !== reservation.contextChars || canonicalJson(usage) !== canonicalJson(reservation.usage)) throw new Error('run-receipt-journal-mismatch')
        }
      }
      const admittedCount = report.runs.reduce((sum, run) => sum + (Number.isSafeInteger(run?.receipt?.requests) ? run.receipt.requests : 0), 0)
      if (admissions.size !== admittedCount || usages.size !== admittedCount) throw new Error('journal-count-mismatch')
      const sourceCommit = getCleanSourceBinding(sourceRoot)
      const retrievalDataHash = await hashRetrievalData(path.join(sourceRoot, 'scripts/agentic/datasets/v1'))
      if (!validateRetrievalBundle(bundle).valid) throw new Error('retrieval-bundle-invalid')
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
