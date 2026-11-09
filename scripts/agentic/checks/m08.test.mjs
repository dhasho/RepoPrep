import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, lstat, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChecks, validateFrozenM08QualityLimits, validateM08SyntheticRawArtifactsForTest } from './m08.mjs'
import { runGenerationEvaluation } from '../generation-eval.mjs'
import { loadGenerationEvaluationBundle } from '../generation-eval-contract.mjs'
import { sha256 } from '../dataset-contract.mjs'
import { prepareSyntheticGenerationReviewForTest } from '../prepare-generation-review.mjs'
import { deriveReviewDisagreements } from '../generation-review.mjs'

test('M08 verifier cannot certify synthetic runs or missing execution artifacts', async () => {
  const check = createChecks().get('m08:frozen-sufficient-evidence-tasks')
  const context = { mode: 'synthetic', recordMetric() { assert.fail('synthetic verification must not emit metrics') } }
  const synthetic = await check(context)
  assert.equal(synthetic.reason, 'real-report-required')

  const realWithoutArtifacts = await check({ ...context, mode: 'real' })
  assert.match(realWithoutArtifacts.reason, /^m08_/u)
})

test('M08 review threshold is pinned to the frozen topic-value delta', () => {
  const limits = { tasks: 12, repeatsPerStrategy: 2, unpackedEvidenceCitedMax: 0, materialErrorRateAtMostStatic: true, topicValueDeltaMin: -0.2 }
  assert.equal(validateFrozenM08QualityLimits(limits), limits)
  assert.throws(() => validateFrozenM08QualityLimits({ ...limits, topicValueDeltaMin: -1 }), /M08_QUALITY_LIMITS_INVALID/u)
})

test('synthetic runtime artifacts use the shared verifier for current request caps and reject below-usage caps', { timeout: 180_000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm08-gate-raw-test-'))
  t.after(async () => {
    const stat = await lstat(temp)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink())
    await rm(temp, { recursive: true, force: true })
  })
  const scratchRoot = path.join(temp, 'scratch')
  await mkdir(scratchRoot)
  let requestNumber = 0
  const profile = Object.freeze({
    id: 'm08-gate-synthetic', name: 'Synthetic only', baseUrl: 'https://gate.invalid/v1',
    apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-gate-model', protocol: 'openai', temperature: 0.4,
    contextWindowTokens: 131_072, maxOutputTokens: 32_768
  })
  const transport = async (_profile, messages, onDelta, options) => {
    requestNumber++
    const body = messages.map(message => message.content).join('\n')
    const quota = Number(body.match(/(?:严格|约)\s*(\d+)\s*题/u)?.[1] ?? 1)
    const citations = [...new Set(body.match(/ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu) ?? [])]
    assert.ok(citations.length)
    const questions = Array.from({ length: quota }, (_, index) => ({
      title: `合成题目${requestNumber}-${index}`, question: `依据本地测试范围解释合成机制${requestNumber}-${index}？`,
      answer: '这是只用于验证门禁原始工件的合成回答，不包含评审标签或答案键。'.repeat(4),
      followUps: [], evidenceIds: [citations[0]]
    }))
    const output = JSON.stringify({
      projectSummary: '本地合成项目摘要。',
      sections: [{ title: '合成问题', summary: '验证结构和证据引用。', questions }], glossary: {}
    })
    options.beforeRequest?.()
    await onDelta(output)
    options.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    return output
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const report = await runGenerationEvaluation({
    mode: 'synthetic', repoRoot, outputDir: path.join(temp, 'execution'), scratchRoot, profile, transport
  })
  assert.equal(report.executionComplete, true, `synthetic setup failed: ${report.matrix.at(-1)?.execution?.errorCode ?? 'no-cell'}`)
  const bundle = await loadGenerationEvaluationBundle()
  const baseCaps = { maxRuns: 48, maxRequests: 419, maxInputTokens: 6_144_000, maxOutputTokensTotal: 3_145_728, maxOutputTokens: 32_768 }
  let metricWrites = 0
  const realModeCheck = createChecks({
    sourceRoot: repoRoot, reportPath: path.join(temp, 'execution', 'generation-evaluation.json')
  }).get('m08:frozen-sufficient-evidence-tasks')
  const syntheticReport = await realModeCheck({ mode: 'real', recordMetric() { metricWrites++ } })
  assert.equal(syntheticReport.reason, 'm08_report_mode_invalid')
  assert.equal(metricWrites, 0, 'a synthetic report cannot produce real gate metrics')

  const journalPath = path.join(temp, 'execution', 'progress.ndjson')
  const originalJournal = await readFile(journalPath)
  const journalEvents = originalJournal.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  const usageIndex = journalEvents.findIndex(event => event.type === 'provider-usage')
  const usageEvent = journalEvents[usageIndex]
  const admissionIndex = journalEvents.findIndex(event => event.type === 'request-admitted' && event.requestId === usageEvent.requestId)
  assert.ok(admissionIndex >= 0 && usageIndex > admissionIndex)
  ;[journalEvents[admissionIndex], journalEvents[usageIndex]] = [journalEvents[usageIndex], journalEvents[admissionIndex]]
  const reorderedBytes = Buffer.from(journalEvents.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  await writeFile(journalPath, reorderedBytes)
  const reorderedReport = structuredClone(report)
  reorderedReport.journal.sha256 = sha256(reorderedBytes)
  await assert.rejects(validateM08SyntheticRawArtifactsForTest({
    report: reorderedReport, outputRoot: path.join(temp, 'execution'), bundle, authorization: baseCaps
  }), /M08_JOURNAL_RECEIPT_ORDER_INVALID/u)
  await writeFile(journalPath, originalJournal)

  for (const maxRequests of [405, 407, 419]) {
    const verified = await validateM08SyntheticRawArtifactsForTest({
      report, outputRoot: path.join(temp, 'execution'), bundle, authorization: { ...baseCaps, maxRequests }
    })
    assert.equal(verified.cells, 48)
    assert.equal(verified.requests, requestNumber)
    assert.ok(verified.requests <= maxRequests)
  }
  const actual = report.usage.knownActual
  const prepared = await prepareSyntheticGenerationReviewForTest({
    report, outputRoot: path.join(temp, 'execution'), bundle, authorization: baseCaps
  })
  assert.equal(prepared.packets, 48)
  assert.equal(prepared.status, 'quality-pending')
  assert.equal(prepared.providerRequests, 0)
  const packetSet = JSON.parse(await readFile(path.join(temp, 'execution', 'review', 'packets.json'), 'utf8'))
  const privateMap = JSON.parse(await readFile(path.join(temp, 'execution', 'review', 'private-map.json'), 'utf8'))
  const reviewerA = JSON.parse(await readFile(path.join(temp, 'execution', 'review', 'templates', 'reviewer-a.json'), 'utf8'))
  const reviewerB = JSON.parse(await readFile(path.join(temp, 'execution', 'review', 'templates', 'reviewer-b.json'), 'utf8'))
  assert.equal(packetSet.packets.length, 48)
  assert.ok(reviewerA.packets.every((packet, index) => packet.packetId === reviewerB.packets[index].packetId))
  assert.throws(() => deriveReviewDisagreements({ packetSet, privateMap, reviewerA, reviewerB }), /review-answer-grade-invalid/u)
  await assert.rejects(prepareSyntheticGenerationReviewForTest({
    report, outputRoot: path.join(temp, 'execution'), bundle, authorization: baseCaps
  }), /EEXIST/u)
  await assert.rejects(validateM08SyntheticRawArtifactsForTest({
    report, outputRoot: path.join(temp, 'execution'), bundle,
    authorization: { ...baseCaps, maxRequests: actual.requests - 1 }
  }), /M08_GLOBAL_COLLECTOR_TOTAL_INVALID/u)
  await assert.rejects(validateM08SyntheticRawArtifactsForTest({
    report, outputRoot: path.join(temp, 'execution'), bundle,
    authorization: { ...baseCaps, maxInputTokens: actual.inputTokens - 1 }
  }), /M08_GLOBAL_COLLECTOR_TOTAL_INVALID/u)
  await assert.rejects(validateM08SyntheticRawArtifactsForTest({
    report, outputRoot: path.join(temp, 'execution'), bundle,
    authorization: { ...baseCaps, maxOutputTokensTotal: actual.outputTokens - 1 }
  }), /M08_GLOBAL_COLLECTOR_TOTAL_INVALID/u)
})
