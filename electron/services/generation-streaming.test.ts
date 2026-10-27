// Production generator streaming and recovery boundaries use only synthetic fetch responses.
// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import test, { type TestContext } from 'node:test'
// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { generateInterview } from './generator.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { GenerationCheckpoint } from '../../shared/generation-checkpoint.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { InterviewResult, LlmProfile } from '../../shared/types.ts'

const profile: LlmProfile = {
  id: 'stream-boundary-profile', name: 'Synthetic', baseUrl: 'https://mock.invalid/v1',
  apiKey: 'SYNTHETIC_STREAM_KEY', model: 'synthetic-model'
}
const encoder = new TextEncoder()
const decoder = new TextDecoder()
type Question = { id: string; title?: string; question: string; answer: string; followUps: Array<{ question: string; answer: string; followUps: unknown[] }> }
type RequestRecord = { payload: Record<string, unknown>; prompt: string; response?: Response; cancelled?: () => boolean }

async function makeProject(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-streaming-'))
  const resolvedRoot = path.resolve(root)
  const tmpRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tmpRoot, resolvedRoot)
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  assert.match(path.basename(resolvedRoot), /^generation-streaming-/)
  await fs.writeFile(path.join(root, 'README.md'), '# Synthetic streaming fixture\nOne small project for medium-granularity generation.\n')
  await fs.writeFile(path.join(root, 'index.ts'), 'export function run(value: string) { return { value, ready: true } }\n')
  t.after(async () => {
    const info = await fs.lstat(resolvedRoot)
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'cleanup is limited to this test-created temporary project')
    await fs.rm(resolvedRoot, { recursive: true, force: true })
  })
  return root
}

function makeQuestion(index: number, term = 'PersistedTerm') {
  const number = String(index).padStart(2, '0')
  return {
    title: `流式持久化考察${number}`,
    question: `合成题目${number}：流式生成中如何维护项目状态？`,
    answer: `使用 [[${term}]] 说明完整对象通过校验后才会成为可恢复状态；题目 ${number} 的回答保留中文、转义引号「继续」与对象示例 { ready: true }。`,
    followUps: [{ question: `题目${number}追问：失败后如何继续？`, answer: `答案${number}说明只重用已保存的问题对象和标识。`, followUps: [] }]
  }
}

function questionCount(batch: { sections: Array<{ questions: unknown[] }> }): number {
  return batch.sections.reduce((count, section) => count + section.questions.length, 0)
}

function rootPrefix(): string {
  return '{"projectSummary":"合成项目说明。","sections":[{"title":"流式恢复","summary":"保存完整题目","questions":['
}

function fullRoot(questions: ReturnType<typeof makeQuestion>[], glossary: Record<string, string> = {}): string {
  return JSON.stringify({
    projectSummary: '合成项目说明。',
    sections: [{ title: '流式恢复', summary: '保存完整题目', questions }],
    glossary
  })
}

function deltaFrame(content: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
}

function finishFrame(reason: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`)
}

function doneFrame(): Uint8Array { return encoder.encode('data: [DONE]\n\n') }

function streamResponse(chunks: Uint8Array[], options: { close?: boolean; onCancel?: () => void } = {}): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (options.close !== false) controller.close()
    },
    cancel() { cancelled = true; options.onCancel?.() }
  })
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
    wasCancelled: () => cancelled
  }
}

async function withFetch<T>(
  impl: (prompt: string, call: number, payload: Record<string, unknown>) => { response: Response; wasCancelled?: () => boolean } | Promise<{ response: Response; wasCancelled?: () => boolean }>,
  run: (calls: RequestRecord[]) => Promise<T>
): Promise<T> {
  const original = globalThis.fetch
  const calls: RequestRecord[] = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const messages = payload.messages as Array<{ content: string }>
    const prompt = messages.map((message) => message.content).join('\n')
    const record: RequestRecord = { payload, prompt }
    calls.push(record)
    const fetched = await impl(prompt, calls.length, payload)
    record.response = fetched.response
    record.cancelled = fetched.wasCancelled
    return fetched.response
  }) as typeof fetch
  try { return await run(calls) } finally { globalThis.fetch = original }
}

function generationParams(
  scan: Awaited<ReturnType<typeof scanProject>>,
  options: {
    signal?: AbortSignal
    state?: GenerationCheckpoint | null
    save?: (state: GenerationCheckpoint) => void
    onProgress?: (step: string, detail: string | undefined, percent: number) => void
    onDiagnostics?: (value: InterviewResult['generationDiagnostics']) => void
  } = {}
) {
  return {
    scan,
    granularity: 'medium' as const,
    roleFocus: 'backend' as const,
    profile,
    signal: options.signal ?? new AbortController().signal,
    onProgress: options.onProgress ?? (() => undefined),
    ...(options.onDiagnostics ? { onDiagnostics: options.onDiagnostics } : {}),
    checkpoint: { state: options.state ?? null, save: options.save ?? (() => undefined) }
  }
}

function savedQuestions(state: GenerationCheckpoint | undefined): Question[] {
  return state?.pending?.batch.sections.flatMap((section) => section.questions as Question[]) ?? []
}

function questionList(result: InterviewResult): Question[] {
  return result.sections.flatMap((section) => section.questions as Question[])
}

function countQuota(prompt: string): number | null {
  const match = prompt.match(/(?:严格|约)\s*(\d+)\s*题/)
  return match ? Number(match[1]) : null
}

test('cancellation from progress after question two preserves two and cancels the reader before queued questions', { timeout: 60_000 }, async (t) => {
  const root = await makeProject(t)
  const scan = await scanProject(root)
  const controller = new AbortController()
  let checkpoint: GenerationCheckpoint | undefined
  const questions = [makeQuestion(1), makeQuestion(2), makeQuestion(3)]
  let response: Response | undefined
  let wasCancelled: (() => boolean) | undefined

  await withFetch(() => {
    const stream = streamResponse([
      deltaFrame(`${rootPrefix()}${questions.map((question) => JSON.stringify(question)).join(',')}`),
      deltaFrame(',{"question":"late delta must not be saved"')
    ], { close: false })
    response = stream.response
    wasCancelled = stream.wasCancelled
    return stream
  }, async (calls) => {
    await assert.rejects(generateInterview(generationParams(scan, {
      signal: controller.signal,
      save: (value) => { checkpoint = structuredClone(value) },
      onProgress: (_step, detail) => {
        if (detail?.includes('已保存 2/')) controller.abort()
      }
    })), /取消/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].payload.stream, true)
    assert.equal(questionCount(checkpoint?.pending?.batch ?? { sections: [] }), 2)
    assert.deepEqual(savedQuestions(checkpoint).map((question) => question.question), questions.slice(0, 2).map((question) => question.question))
    assert.equal(savedQuestions(checkpoint).some((question) => question.question.includes('late delta')), false)
    assert.equal(wasCancelled?.(), true, 'the underlying stream reader must be canceled')
    assert.equal(response?.body?.locked, false, 'the response reader lock must be released')
  })
})

test('a failed second question save keeps only the first and stops reading without retry', { timeout: 60_000 }, async (t) => {
  const root = await makeProject(t)
  const scan = await scanProject(root)
  let lastSuccessful: GenerationCheckpoint | undefined
  let failedQuestionSave = 0
  const progressDetails: string[] = []
  const questions = [makeQuestion(1), makeQuestion(2), makeQuestion(3)]

  await withFetch(() => streamResponse([
    deltaFrame(`${rootPrefix()}${questions.map((question) => JSON.stringify(question)).join(',')}`),
    deltaFrame(',{"question":"late delta must not be saved"')
  ], { close: false }), async (calls) => {
    await assert.rejects(generateInterview(generationParams(scan, {
      save: (value) => {
        const savedCount = savedQuestions(value).length
        if (savedCount === 2) { failedQuestionSave++; throw new Error('synthetic disk full') }
        lastSuccessful = structuredClone(value)
      },
      onProgress: (_step, detail) => { if (detail) progressDetails.push(detail) }
    })), /无法保存生成检查点/)
    assert.equal(failedQuestionSave, 1)
    assert.equal(calls.length, 1, 'a checkpoint write failure must not trigger a model retry')
    assert.equal(questionCount(lastSuccessful?.pending?.batch ?? { sections: [] }), 1)
    assert.deepEqual(savedQuestions(lastSuccessful).map((question) => question.question), [questions[0].question])
    assert.ok(!progressDetails.some((detail) => /已保存\s*2\//.test(detail)), 'failed question two must not appear as saved progress')
    assert.equal(calls[0].cancelled?.(), true, 'save failure must stop and cancel the response reader')
    assert.equal(calls[0].response?.body?.locked, false)
  })
})

test('twenty streamed questions survive a lost metadata tail and resume with a metadata-only request', { timeout: 60_000 }, async (t) => {
  const root = await makeProject(t)
  const scan = await scanProject(root)
  let checkpoint: GenerationCheckpoint | undefined
  const questions = Array.from({ length: 20 }, (_, index) => makeQuestion(index + 1))
  const truncatedContent = `${rootPrefix()}${questions.map((question) => JSON.stringify(question)).join(',')}`

  await withFetch((_prompt, call) => {
    assert.equal(call, 1)
    return streamResponse([deltaFrame(truncatedContent)]) // EOF before the root close, glossary, and SSE terminal.
  }, async (calls) => {
    await assert.rejects(generateInterview(generationParams(scan, { save: (value) => { checkpoint = structuredClone(value) } })), /格式|请求|失败|error/i)
    assert.equal(calls.length, 1)
    assert.equal(countQuota(calls[0].prompt), 20)
  })

  assert.equal(questionCount(checkpoint?.pending?.batch ?? { sections: [] }), 20)
  const prefix = savedQuestions(checkpoint)
  assert.equal(prefix.length, 20)
  assert.equal(new Set(prefix.map((question) => question.id)).size, 20)
  const resumeState = structuredClone(checkpoint!)

  const result = await withFetch((prompt, call) => {
    assert.equal(call, 1)
    assert.equal(countQuota(prompt), 0)
    assert.match(prompt, /sections 必须为 \[\]/)
    return streamResponse([
      deltaFrame(JSON.stringify({ projectSummary: '恢复后的合成项目概述。', sections: [], glossary: { PersistedTerm: 'PersistedTerm 是合成术语。它说明元数据可在题目恢复后补齐。' } })),
      finishFrame('stop'), doneFrame()
    ])
  }, async (calls) => {
    const result = await generateInterview(generationParams(scan, {
      state: resumeState,
      save: (value) => { checkpoint = structuredClone(value) }
    }))
    assert.equal(calls.length, 1)
    return result
  })

  const finalQuestions = questionList(result)
  assert.equal(finalQuestions.length, 20)
  assert.deepEqual(finalQuestions, prefix, 'metadata-only recovery must preserve every saved id and question field')
  assert.ok(result.glossary.PersistedTerm)
})

for (const mode of ['eof', 'finish-length', 'error-frame'] as const) {
  test(`complete questions stay pending after ${mode}; failed transport does not publish or retry`, { timeout: 60_000 }, async (t) => {
    const root = await makeProject(t)
    const scan = await scanProject(root)
    let checkpoint: GenerationCheckpoint | undefined
    const statuses: string[] = []
    const question = makeQuestion(1)
    const events: Uint8Array[] = [deltaFrame(`${rootPrefix()}${JSON.stringify(question)}`)]
    if (mode === 'finish-length') events.push(finishFrame('length'))
    if (mode === 'error-frame') events.push(encoder.encode('event: error\ndata: {"error":{"message":"synthetic failure"}}\n\n'))
    await withFetch(() => streamResponse(events), async (calls) => {
      await assert.rejects(generateInterview(generationParams(scan, {
        save: (value) => { checkpoint = structuredClone(value) },
        onDiagnostics: (diagnostics) => { if (diagnostics) statuses.push(diagnostics.status) }
      })))
      assert.equal(calls.length, 1, 'truncated or malformed streams are not automatically retried')
      assert.equal(checkpoint?.entries.length, 0)
      assert.equal(questionCount(checkpoint?.pending?.batch ?? { sections: [] }), 1)
      assert.deepEqual(statuses, ['failed'], 'failed generation must not produce a publishable result')
      assert.ok(checkpoint?.pending)
    })
  })
}

test('a streamed format repair asks only for the remaining questions and retains the accepted question', { timeout: 60_000 }, async (t) => {
  const root = await makeProject(t)
  const scan = await scanProject(root)
  const original = makeQuestion(1)
  let checkpoint: GenerationCheckpoint | undefined
  let acceptedOriginal: Question | undefined
  const malformed = `${rootPrefix()}${JSON.stringify(original)},BROKEN JSON`

  const result = await withFetch((_prompt, call) => {
    if (call === 1) return streamResponse([
      deltaFrame(malformed), finishFrame('stop'), doneFrame()
    ])
    return streamResponse([
      deltaFrame(fullRoot(Array.from({ length: 19 }, (_, index) => makeQuestion(index + 2)), { PersistedTerm: 'A recovered synthetic term.' })),
      finishFrame('stop'), doneFrame()
    ])
  }, async (calls) => {
    const value = await generateInterview(generationParams(scan, { save: (state) => {
      const accepted = savedQuestions(state).find((question) => question.question === original.question)
      if (accepted && !acceptedOriginal) acceptedOriginal = structuredClone(accepted)
      checkpoint = structuredClone(state)
    } }))
    assert.equal(calls.length, 2)
    assert.equal(countQuota(calls[0].prompt), 20)
    assert.equal(countQuota(calls[1].prompt), 19)
    assert.ok(calls[1].prompt.includes(original.question), 'repair prompt should include the accepted stem and request only its remainder')
    assert.equal(value.generationDiagnostics?.repairRequestCount, 1)
    return value
  })

  const retained = questionList(result).find((question) => question.question === original.question)
  assert.ok(acceptedOriginal && retained)
  assert.deepEqual(retained, acceptedOriginal)
  assert.equal(questionList(result).length, 20)
})

test('a legacy v1 checkpoint with an old fingerprint is rejected before a request or save', { timeout: 60_000 }, async (t) => {
  const root = await makeProject(t)
  const scan = await scanProject(root)
  const legacy: GenerationCheckpoint = { version: 1, fingerprint: '0'.repeat(64), totalBatches: 1, entries: [] }
  const original = structuredClone(legacy)
  let saves = 0

  await withFetch(() => { throw new Error('legacy state must be rejected before fetch') }, async (calls) => {
    await assert.rejects(generateInterview(generationParams(scan, {
      state: legacy,
      save: () => { saves++ }
    })), /项目上下文或模型配置已变化/)
    assert.equal(calls.length, 0)
  })
  assert.equal(saves, 0)
  assert.deepEqual(legacy, original, 'rejected legacy checkpoint must remain untouched')
})
