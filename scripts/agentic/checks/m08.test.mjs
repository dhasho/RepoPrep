import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChecks, validateM08SyntheticRawArtifactsForTest } from './m08.mjs'
import { runGenerationEvaluation } from '../generation-eval.mjs'
import { loadGenerationEvaluationBundle } from '../generation-eval-contract.mjs'

test('M08 verifier cannot certify synthetic runs or missing execution artifacts', async () => {
  const check = createChecks().get('m08:frozen-sufficient-evidence-tasks')
  const context = { mode: 'synthetic', recordMetric() { assert.fail('synthetic verification must not emit metrics') } }
  const synthetic = await check(context)
  assert.equal(synthetic.reason, 'real-report-required')

  const realWithoutArtifacts = await check({ ...context, mode: 'real' })
  assert.match(realWithoutArtifacts.reason, /^m08_/u)
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
  const bundle = await loadGenerationEvaluationBundle()
  const baseCaps = { maxRuns: 48, maxRequests: 419, maxInputTokens: 6_144_000, maxOutputTokensTotal: 3_145_728, maxOutputTokens: 32_768 }
  for (const maxRequests of [405, 407, 419]) {
    const verified = await validateM08SyntheticRawArtifactsForTest({
      report, outputRoot: path.join(temp, 'execution'), bundle, authorization: { ...baseCaps, maxRequests }
    })
    assert.equal(verified.cells, 48)
    assert.equal(verified.requests, requestNumber)
    assert.ok(verified.requests <= maxRequests)
  }
  const actual = report.usage.knownActual
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
