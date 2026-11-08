import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatCompletionStream, LLM_RESPONSE_LIMITS, LlmRequestError } from '../../electron/services/llm.ts'
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
    if (options.failureModel) throw new LlmRequestError('http', 'SYNTHETIC_PRIVATE_PROVIDER_BODY', { httpStatus: 503, finishReason: 'length' })
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
  const fixture = options.transport
    ? { transport: options.transport, requestCount: () => options.requestCount?.() ?? 0, messagesSeen: [] }
    : syntheticTransport(options)
  const report = await runGenerationEvaluation({
    mode: 'synthetic',
    repoRoot: codeRoot,
    outputDir,
    scratchRoot: scratchParent,
    profile: syntheticProfile,
    transport: fixture.transport,
    ...(options.testHooks ? { testHooks: options.testHooks } : {})
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
  assert.ok(report.matrix.every((cell) => Number.isSafeInteger(cell.execution.elapsedMs) && cell.execution.elapsedMs >= 0 && cell.execution.elapsedMs < 600_000))
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

test('failed cells preserve only the sanitized model failure classification', { timeout: 90_000 }, async (t) => {
  const { report } = await runSynthetic(t, { failureModel: true })
  assert.equal(report.matrix.length, 1)
  assert.equal(report.matrix[0].execution.errorCode, 'model-failed')
  assert.deepEqual(report.matrix[0].execution.modelFailure, { kind: 'http', httpStatus: 503, finishReason: 'length' })
  const publicReport = JSON.stringify(report)
  assert.equal(publicReport.includes('SYNTHETIC_PRIVATE_PROVIDER_BODY'), false)
  assert.equal(publicReport.includes(syntheticProfile.apiKey), false)
})

function deadlineHarness(expireAtStep) {
  let now = 0
  let timerCallback
  return {
    hooks: {
      clock: () => now,
      setTimeout(callback, delay) { assert.equal(delay, 600_000); timerCallback = callback; return 'cell-timer' },
      clearTimeout(handle) { assert.equal(handle, 'cell-timer') },
      onCellStep({ step, caseNumber }) {
        if (caseNumber === 1 && step === expireAtStep) now = 600_001
      }
    },
    expireTimer() {
      now = 600_001
      timerCallback?.()
    }
  }
}

test('synthetic cell deadline covers setup, finalization, and final artifact writes', { timeout: 90_000 }, async (t) => {
  for (const step of ['before-materialize', 'after-finalize', 'after-metadata-write']) {
    const harness = deadlineHarness(step)
    const { report, fixture, outputDir } = await runSynthetic(t, { testHooks: harness.hooks })
    assert.equal(report.executionComplete, false, `${step} cannot publish a successful matrix cell`)
    assert.equal(report.matrix.length, 1)
    const cell = report.matrix[0]
    assert.equal(cell.execution.status, 'failed')
    assert.equal(cell.execution.errorCode, 'timeout')
    assert.equal(cell.execution.deadlineReason, 'per-run-wall-clock')
    assert.equal(cell.execution.elapsedMs, 600_001)
    if (step === 'before-materialize') assert.equal(fixture.requestCount(), 0, 'expired setup stops before source reads and dispatch')
    if (step === 'after-finalize') assert.equal(cell.resultFile, null, 'expired finalization does not write a successful result')
    if (step === 'after-metadata-write') {
      assert.equal(cell.resultFile, null, 'completed bytes written after the deadline are not marked as a successful cell')
      assert.equal(cell.metadataFile, 'case-0001.failure.json', 'failure accounting never overwrites the earlier exclusive metadata artifact')
      await readFile(path.join(outputDir, cell.metadataFile), 'utf8')
    }
  }
})

test('synthetic streaming deadline aborts only the active cell and retains its unknown reservation', { timeout: 90_000 }, async (t) => {
  const harness = deadlineHarness(undefined)
  let requestCount = 0
  const transport = async (_profile, _messages, _onDelta, options) => {
    requestCount++
    options.beforeRequest?.()
    await new Promise((resolve, reject) => {
      const rejectCancelled = () => reject(new LlmRequestError('cancelled'))
      if (options.signal.aborted) { rejectCancelled(); return }
      options.signal.addEventListener('abort', rejectCancelled, { once: true })
      harness.expireTimer()
    })
    return 'never-completes'
  }
  const { report } = await runSynthetic(t, { transport, requestCount: () => requestCount, testHooks: harness.hooks })
  assert.equal(requestCount, 1)
  assert.equal(report.executionComplete, false)
  assert.equal(report.matrix.length, 1)
  const cell = report.matrix[0]
  assert.equal(cell.execution.errorCode, 'timeout', 'deadline cancellation is classified as the run budget, not user cancellation')
  assert.equal(cell.execution.deadlineReason, 'per-run-wall-clock')
  assert.equal(cell.execution.elapsedMs, 600_001)
  assert.equal(cell.execution.unknownReservations.length, 1)
  assert.ok(cell.execution.conservativeCharged.inputTokens > 0)
})

test('synthetic ignored reasoning can exhaust the raw SSE byte cap before the usage tail', async () => {
  const encoder = new TextEncoder()
  const sse = (value) => `data: ${JSON.stringify(value)}\n\n`
  const content = '{"synthetic":"answer"}'
  const first = encoder.encode(sse({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }))
  const makeBody = (reasoningLength) => {
    const reasoning = 'r'.repeat(reasoningLength)
    const tail = encoder.encode(
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) +
      'data: [DONE]\n\n'
    )
    const reasoningChunks = []
    for (let offset = 0; offset < reasoning.length; offset += 400_000) {
      const fragment = reasoning.slice(offset, offset + 400_000)
      reasoningChunks.push(encoder.encode(sse({ choices: [{ index: 0, delta: { reasoning_content: fragment }, finish_reason: null }] })))
    }
    reasoningChunks.push(encoder.encode(sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })))
    let next = 0
    let pulls = 0
    let cancelled = false
    const chunks = [first, ...reasoningChunks, tail]
    const body = new ReadableStream({
      pull(controller) {
        pulls++
        if (next < chunks.length) controller.enqueue(chunks[next++])
        else controller.close()
      },
      cancel() { cancelled = true }
    })
    return { body, pulls: () => pulls, chunkCount: chunks.length, wasCancelled: () => cancelled, totalBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) }
  }
  const originalFetch = globalThis.fetch
  const run = async (fixture) => {
    globalThis.fetch = async () => new Response(fixture.body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const deltas = []
    const usages = []
    try {
      const result = await chatCompletionStream(syntheticProfile, [{ role: 'user', content: 'synthetic only' }], (delta) => deltas.push(delta), { onUsage: (usage) => usages.push(usage) })
      return { result, deltas, usages }
    } catch (error) {
      error.syntheticObservations = { deltas, usages }
      throw error
    } finally { globalThis.fetch = originalFetch }
  }

  const overCap = makeBody(LLM_RESPONSE_LIMITS.chatBodyBytes + 256)
  assert.ok(overCap.totalBytes > LLM_RESPONSE_LIMITS.chatBodyBytes)
  let failure
  try { await run(overCap) } catch (error) { failure = error }
  assert.ok(failure instanceof LlmRequestError)
  assert.equal(failure.kind, 'response')
  assert.ok(overCap.pulls() < overCap.chunkCount, 'usage tail chunks are never pulled after the byte cap is reached')
  assert.deepEqual(failure.syntheticObservations, { deltas: [], usages: [] }, 'neither answer text nor the tail receipt was processed')
  assert.equal(overCap.wasCancelled(), true)

  const withinCap = makeBody(LLM_RESPONSE_LIMITS.chatBodyBytes - 4096)
  assert.ok(withinCap.totalBytes <= LLM_RESPONSE_LIMITS.chatBodyBytes)
  const accepted = await run(withinCap)
  assert.equal(accepted.result, content)
  assert.deepEqual(accepted.deltas, [content])
  assert.deepEqual(accepted.usages, [{ inputTokens: 5, outputTokens: 2, totalTokens: 7 }])
})
