import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runGenerationEvaluation,
  verifyGenerationProfileBinding
} from './generation-eval.mjs'
import {
  GENERATION_PURPOSE,
  GENERATION_REVIEW_PENDING,
  deriveGenerationBudgets,
  loadGenerationEvaluationBundle,
  validateGenerationExecutionReport
} from './generation-eval-contract.mjs'

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const syntheticProfile = Object.freeze({
  id: 'm08-synthetic-profile', name: 'Synthetic only', baseUrl: 'https://generation.invalid/v1',
  apiKey: 'SYNTHETIC_ONLY', model: 'synthetic-generation-model', protocol: 'openai',
  temperature: 0.4, contextWindowTokens: 131_072, maxOutputTokens: 32_768
})

async function makeTemp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'm08-generation-test-'))
  const resolved = path.resolve(directory)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, resolved)
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  assert.match(path.basename(resolved), /^m08-generation-test-/u)
  t.after(async () => {
    const stat = await lstat(resolved)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'cleanup is restricted to this test-created directory')
    await rm(resolved, { recursive: true, force: true })
  })
  return resolved
}

function syntheticTransport(options = {}) {
  let requestCount = 0
  const messagesSeen = []
  const transport = async (_profile, messages, onDelta, callOptions) => {
    requestCount++
    messagesSeen.push(messages.map((message) => message.content).join('\n'))
    const quotaMatch = messagesSeen.at(-1).match(/(?:严格|约)\s*(\d+)\s*题/u)
    const quota = quotaMatch ? Number(quotaMatch[1]) : 1
    const citations = [...new Set(messagesSeen.at(-1).match(/ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu) ?? [])]
    assert.ok(citations.length > 0, 'the prepared public request contains fixed evidence IDs')
    callOptions.beforeRequest?.()
    const requestIndex = requestCount
    const questions = Array.from({ length: quota }, (_, index) => {
      const serial = `${requestIndex}-${index + 1}`
      const repeatedAnswer = '离线合成传输用这段中性文本验证固定证据请求、题目归一化以及结构保存路径，不表达实验标签中的评审事实。'
      return {
        title: `合成请求结构考察${serial}`,
        question: `离线执行请求${serial}应如何按照给定的固定源码范围组织问题？`,
        answer: repeatedAnswer.repeat(3),
        followUps: [
          { question: `合成追问${serial}如何确认当前边界？`, answer: `合成答案说明仅检查传入记录并沿同一授权范围处理。${repeatedAnswer}`, followUps: [] },
          { question: `合成追问${serial}遇到失败如何恢复？`, answer: `合成答案说明保留已完成前缀并让有界状态决定后续路径。${repeatedAnswer}`, followUps: [] }
        ],
        evidenceIds: [citations[0]]
      }
    })
    const content = JSON.stringify({
      projectSummary: '此处是固定合成源码项目的离线生成摘要。',
      sections: [{ title: '合成输出结构', summary: '离线验证结构与固定证据绑定。', questions }],
      glossary: {}
    })
    await onDelta(content)
    if (!options.unknownUsage) callOptions.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    return content
  }
  return { transport, requestCount: () => requestCount, messagesSeen }
}

async function runSynthetic(t, options = {}) {
  const temp = await makeTemp(t)
  const scratchParent = path.join(temp, 'scratch-parent')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(scratchParent)
  const outputDir = path.join(temp, 'execution')
  const fixture = syntheticTransport(options)
  const report = await runGenerationEvaluation({
    mode: 'synthetic',
    repoRoot: codeRoot,
    outputDir,
    scratchRoot: scratchParent,
    profile: syntheticProfile,
    transport: fixture.transport
  })
  return { report, fixture, outputDir }
}

test('profile binding returns a frozen private clone with only the temporary output override', async () => {
  const authorization = {
    endpointFingerprint: 'placeholder', model: syntheticProfile.model, protocol: 'openai', temperature: 0.4,
    reasoningEffort: null, contextWindowTokens: syntheticProfile.contextWindowTokens, maxOutputTokens: 16_384
  }
  const { createHash } = await import('node:crypto')
  const { normalizeBaseUrl } = await import('../../electron/services/llm.ts')
  authorization.endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(syntheticProfile.baseUrl)).digest('hex')
  const clone = verifyGenerationProfileBinding(syntheticProfile, authorization)
  assert.equal(Object.isFrozen(clone), true)
  assert.equal(clone.apiKey, 'SYNTHETIC_ONLY')
  assert.equal(clone.maxOutputTokens, 16_384)
  assert.equal(syntheticProfile.maxOutputTokens, 32_768, 'the caller profile is not modified')
  assert.throws(() => verifyGenerationProfileBinding(syntheticProfile, { ...authorization, contextWindowTokens: 16_384 }), { message: 'profile-binding-mismatch' })
})

test('real execution blocks missing authorization before profile access or transport', { timeout: 60_000 }, async (t) => {
  const temp = await makeTemp(t)
  let profileReads = 0, transportCalls = 0
  const profile = async () => { profileReads++; return syntheticProfile }
  const transport = async () => { transportCalls++; return '{}' }
  await assert.rejects(runGenerationEvaluation({
    mode: 'real', repoRoot: codeRoot, outputDir: path.join(codeRoot, '.validation', 'agentic', 'missing-auth-test-output'),
    authorizationPath: path.join(temp, 'not-created-auth.json'), claimPath: path.join(temp, 'not-created-claim.json'),
    scratchRoot: temp, readProfile: profile, transport
  }), { message: 'authorization-invalid' })
  assert.equal(profileReads, 0)
  assert.equal(transportCalls, 0)
})

test('real execution rejects the wrong application source root before reading a profile', { timeout: 60_000 }, async (t) => {
  const temp = await makeTemp(t)
  let profileReads = 0
  await assert.rejects(runGenerationEvaluation({
    mode: 'real', repoRoot: temp, outputDir: path.join(temp, 'output'),
    authorizationPath: path.join(temp, 'auth.json'), claimPath: path.join(temp, 'claim.json'), scratchRoot: temp,
    readProfile: async () => { profileReads++; return syntheticProfile }
  }), { message: 'execution-root-mismatch' })
  assert.equal(profileReads, 0)
})

test('synthetic runtime executes all 48 balanced fixed-evidence cells and preserves budget/source lineage', { timeout: 180_000 }, async (t) => {
  const { report, fixture, outputDir } = await runSynthetic(t)
  const bundle = await loadGenerationEvaluationBundle()
  const budget = deriveGenerationBudgets(bundle)
  assert.equal(report.mode, 'synthetic')
  assert.equal(report.executionComplete, true)
  assert.equal(report.status, 'awaiting-review')
  assert.equal(report.reviewState, GENERATION_REVIEW_PENDING)
  assert.equal(report.qualityGate, 'not-evaluated')
  assert.equal(report.matrix.length, 48)
  assert.equal(fixture.requestCount(), 136, 'the matched task quotas use 2 calls for each medium run and 4 for each fine run')
  assert.equal(report.budgets.maxRequests, 420, 'authorization retains the full distribution-derived request ceiling')
  assert.equal(report.usage.conservativeCharged.requests, 136)
  assert.ok(report.usage.conservativeCharged.requests <= budget.matrix.maxRequests)
  assert.ok(report.usage.conservativeCharged.inputTokens <= budget.matrix.maxInputTokens)
  assert.ok(report.usage.conservativeCharged.outputTokens <= budget.matrix.maxOutputTokensTotal)
  assert.ok(report.matrix.every((cell) => cell.execution.usageComplete && cell.execution.lineageValid && cell.artifactHashes.result && cell.artifactHashes.sidecar))
  for (let index = 0; index < bundle.tasks.length; index++) {
    const rows = report.matrix.filter((cell) => cell.taskId === bundle.tasks[index].id)
    assert.deepEqual(rows.map((cell) => `${cell.repeat}:${cell.strategy}`), ['1:static-control', '1:agentic', '2:agentic', '2:static-control'])
  }
  assert.doesNotMatch(fixture.messagesSeen.join('\n'), /expectedFacts|pitfalls|PRIVATE_ORACLE_SENTINEL/iu)
  const check = validateGenerationExecutionReport(report, bundle)
  assert.equal(check.valid, true, check.issues.join(','))
  assert.equal(check.executionComplete, true)

  const tamperedLineage = structuredClone(report)
  const evidenceId = Object.keys(tamperedLineage.sourceBindings)[0]
  tamperedLineage.sourceBindings[evidenceId].hash = 'f'.repeat(64)
  const lineageCheck = validateGenerationExecutionReport(tamperedLineage, bundle)
  assert.equal(lineageCheck.valid, false)
  assert.ok(lineageCheck.issues.includes('execution-source-bindings-mismatch'))

  const tamperedCost = structuredClone(report)
  tamperedCost.matrix[0].execution.conservativeCharged.inputTokens++
  const costCheck = validateGenerationExecutionReport(tamperedCost, bundle)
  assert.equal(costCheck.valid, false)
  assert.ok(costCheck.issues.includes('execution-cost-mismatch'))

  const firstCell = report.matrix[0]
  const sidecar = JSON.parse(await readFile(path.join(outputDir, firstCell.sidecarFile), 'utf8'))
  assert.equal(sidecar.questions.length, firstCell.execution.acceptedQuestionCount)
  assert.equal(sidecar.questions.every((question) => question.evidenceIds.every((id) => Object.hasOwn(report.sourceBindings, id))), true)
})

test('unknown usage stops after one dispatched request and remains a charged reservation', { timeout: 90_000 }, async (t) => {
  const { report, fixture } = await runSynthetic(t, { unknownUsage: true })
  assert.equal(fixture.requestCount(), 1)
  assert.equal(report.executionComplete, false)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.reviewState, 'blocked')
  assert.equal(report.matrix.length, 1)
  assert.equal(report.matrix[0].execution.usageComplete, false)
  assert.equal(report.matrix[0].execution.knownActual.requests, 0)
  assert.equal(report.matrix[0].execution.unknownReservations.length, 1)
  assert.ok(report.matrix[0].execution.conservativeCharged.inputTokens > 0)
  assert.equal(report.usage.knownActual.requests, 0)
  assert.equal(report.usage.unknownReservations.length, 1)
})
