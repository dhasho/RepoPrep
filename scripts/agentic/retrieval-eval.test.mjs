import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { loadDatasetBundle } from './dataset-contract.mjs'
import { recomputeRetrievalMetrics, verifyRetrievalReport, runRetrievalEvaluation, verifyProfileBinding, evaluationConfigFingerprint, evaluationRunConfigFingerprint, RETRIEVAL_LIMITS } from './retrieval-eval.mjs'
import { normalizeBaseUrl } from '../../electron/services/llm.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await loadDatasetBundle(path.join(root, 'scripts/agentic/datasets/v1'))
const projects = new Map(bundle.projects.projects.map(project => [project.id, project]))

function evaluatorOnlyEvidence(taskId) {
  const task = bundle.retrievalTasks.tasks.find(item => item.id === taskId)
  const project = projects.get(task.projectId)
  const label = bundle.retrievalLabels.labels.find(item => item.taskId === taskId)
  const refs = label.requiredEvidenceGroups.flatMap(group => group.allOf)
  return refs.map((ref, index) => {
    const source = project.files.find(file => file.path === ref.path).content
    const content = source.split('\n').slice(ref.startLine - 1, ref.endLine).join('\n')
    const hex = createHash('sha256').update(`${taskId}-${index}`).digest('hex')
    const id = `ev_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    return { id, path: ref.path, startLine: ref.startLine, endLine: ref.endLine, contentHash: createHash('sha256').update(content).digest('hex'), sourceKind: 'code', readStatus: 'complete', omission: 'none' }
  })
}

function completeReceipt() {
  return { requests: 1, inputTokens: 10, outputTokens: 10, usageComplete: true, readBytes: 100, elapsedMs: 100, readRequests: 4, repeatedReads: 0, invalidToolExecutions: 0, overspend: { inputTokens: 0, outputTokens: 0, readBytes: 0 }, blocked: false, reservations: [{ id: 'decision-1', stage: 'investigation', state: 'settled', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } }] }
}

function syntheticReport() {
  const provider = { endpointFingerprint: 'a'.repeat(64), model: 'synthetic-model', protocol: 'openai', temperature: 0.4, reasoningEffort: null, contextWindowTokens: 49152, maxOutputTokensPerRequest: 2000 }
  return { schemaVersion: 1, mode: 'synthetic', purpose: 'm06-retrieval-v1', provider, configurationFingerprint: evaluationConfigFingerprint(provider), runs: bundle.retrievalTasks.tasks.flatMap(task => [1, 2].map(repeat => { const evidence = evaluatorOnlyEvidence(task.id); return { taskId: task.id, repeat, status: 'completed', retrievedEvidence: evidence, selectedEvidence: evidence, runConfigFingerprint: evaluationRunConfigFingerprint(task, provider), receipt: completeReceipt() } })) }
}

test('recomputes coverage from selected source ranges and rejects synthetic mode as a real gate report', () => {
  const report = syntheticReport()
  const metrics = recomputeRetrievalMetrics(report, bundle)
  assert.equal(metrics.runCount, 40)
  assert.equal(metrics.uniqueCells, 40)
  assert.equal(metrics.completeEvidenceTaskRate, 1)
  assert.equal(metrics.usageComplete, true)
  const verified = verifyRetrievalReport(report, bundle)
  assert.equal(verified.valid, false)
  assert.ok(verified.issues.includes('report-not-real'))
})

test('partial, duplicated, malformed, or over-budget receipts cannot pass the frozen matrix', () => {
  const report = syntheticReport()
  report.runs.pop()
  report.runs.push({ ...report.runs[0], selectedEvidence: [] })
  report.runs[1] = { ...report.runs[1], receipt: { ...completeReceipt(), requests: 4, repeatedReads: 40 } }
  const metrics = recomputeRetrievalMetrics(report, bundle)
  assert.equal(metrics.runCount, 40)
  assert.ok(metrics.uniqueCells < 40)
  assert.ok(metrics.completeEvidenceTaskRate < 1)
  assert.equal(metrics.usageComplete, false)
  assert.ok(metrics.limitViolations > 0)
  assert.ok(metrics.repeatedReadRate > RETRIEVAL_LIMITS.repeats)
})

test('real runner blocks missing authorization before reading or invoking a profile', async () => {
  let touched = false
  const profile = new Proxy({}, { get() { touched = true; throw new Error('must-not-touch-profile') } })
  await assert.rejects(runRetrievalEvaluation({ repoRoot: root, outputDir: path.join(root, '.validation/agentic/unused'), profile }), /authorization-required/)
  assert.equal(touched, false)
})

test('profile binding uses synthetic metadata and limits only an in-memory clone', () => {
  const profile = { id: 'synthetic-profile', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-model', protocol: 'openai', temperature: 0.4, contextWindowTokens: 49152 }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  const auth = { endpointFingerprint, model: profile.model, protocol: profile.protocol, temperature: 0.4, reasoningEffort: null, contextWindowTokens: profile.contextWindowTokens }
  const clone = verifyProfileBinding(profile, auth)
  assert.equal(clone.maxOutputTokens, RETRIEVAL_LIMITS.perRequestOutputTokens)
  assert.equal(profile.maxOutputTokens, undefined)
  assert.throws(() => verifyProfileBinding({ ...profile, baseUrl: 'https://other.invalid/v1' }, auth), /profile-binding-mismatch/)
})

test('controller input path is objective-only and never includes evaluator labels', async () => {
  const runner = await readFile(path.join(root, 'scripts/agentic/retrieval-eval.mjs'), 'utf8')
  const callStart = runner.indexOf('result = await runInvestigation(')
  const call = runner.slice(callStart, callStart + 500)
  assert.match(call, /objective: task\.objective/u)
  assert.doesNotMatch(call, /requiredEvidenceGroups|expectedFacts|retrievalLabels/u)
  assert.match(runner, /selectedEvidence/u)
})
