// Production generation preview uses synthetic SSE only; no model credentials or network.
// @ts-ignore Node direct TypeScript tests require runtime .ts suffix.
import test from 'node:test'
// @ts-ignore Node direct TypeScript tests require runtime .ts suffix.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- direct Node tests require runtime .ts suffix.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- direct Node tests require runtime .ts suffix.
import { generateInterview } from './generator.ts'
// @ts-ignore TS5097 -- direct Node tests require runtime .ts suffix.
import type { GenerationPreview } from '../../shared/types.ts'

const profile = { id: 'preview-profile', name: 'Synthetic', baseUrl: 'https://preview.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'preview-model' }
const encoder = new TextEncoder()

function frame(content: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
}

function terminal(): Uint8Array[] {
  return [encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`), encoder.encode('data: [DONE]\n\n')]
}

function response(chunks: Uint8Array[], delayAfterFirstMs = 0): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (chunks.length) controller.enqueue(chunks[0])
      if (delayAfterFirstMs) await new Promise(resolve => setTimeout(resolve, delayAfterFirstMs))
      for (const chunk of chunks.slice(1)) controller.enqueue(chunk)
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('first question answer streams before checkpoint completion, then moves to durable sections', { timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-preview-'))
  await fs.writeFile(path.join(root, 'README.md'), '# Preview fixture\nSynthetic project for a report preview.\n')
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const scan = await scanProject(root)
  const full = JSON.stringify({
    projectSummary: '合成项目概述：中文内容。',
    sections: [{ title: '架构主题', summary: '检查架构边界。', questions: [{
      title: '状态流转', question: '状态如何流转？', answer: `完整答案含 "引号" 与 \n 换行。${'扩展内容'.repeat(2_000)}`,
      followUps: [{ question: '追问', answer: '追问答案', followUps: [] }]
    }] }],
    glossary: {}
  })
  const answerStart = full.indexOf('"answer":') + '"answer":'.length
  const answerBoundary = full.indexOf(',"followUps"', answerStart)
  const unfinished = full.slice(0, answerBoundary - 1)
  const remaining = full.slice(answerBoundary - 1)
  const quoteMarker = '\\"引号\\"'
  const phraseEnd = unfinished.indexOf(quoteMarker) + quoteMarker.length
  const contentFrames = [
    frame(unfinished.slice(0, phraseEnd)),
    ...Array.from({ length: Math.ceil((unfinished.length - phraseEnd) / 32) }, (_, index) => frame(unfinished.slice(phraseEnd + index * 32, phraseEnd + (index + 1) * 32)))
  ]
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => response([...contentFrames, frame(remaining), ...terminal()], fetches++ === 0 ? 140 : 0)) as typeof fetch
  const observed: GenerationPreview[] = []
  let checkpointQuestionsAtFirstAnswer = -1
  let activePreviewUpdates = 0
  try {
    await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: (_step, _detail, _percent, preview) => {
        if (!preview) return
        observed.push(structuredClone(preview))
        if (preview.activeQuestion) activePreviewUpdates++
        if (checkpointQuestionsAtFirstAnswer < 0 && preview.activeQuestion?.answer.includes('完整答案')) checkpointQuestionsAtFirstAnswer = preview.completedQuestions
      },
      checkpoint: {
        state: null,
        save: () => undefined
      }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const first = observed.find(preview => preview.activeQuestion?.answer.includes('完整答案'))
  assert.ok(first, `a partial answer is visible while the question object remains open: ${JSON.stringify(observed.map(preview => ({ completed: preview.completedQuestions, active: preview.activeQuestion?.answer.slice(0, 25) })))}`)
  assert.ok(observed[0].targetQuestions >= 1)
  assert.equal(checkpointQuestionsAtFirstAnswer, 0)
  assert.equal(first.completedQuestions, 0)
  assert.equal(first.projectSummary, '合成项目概述：中文内容。')
  assert.equal(first.activeQuestion?.sectionTitle, '架构主题')
  assert.match(first.activeQuestion?.answer ?? '', /"引号"/)
  assert.equal(first.sections.length, 0)
  assert.ok(activePreviewUpdates < contentFrames.length / 4, `preview throttling emitted ${activePreviewUpdates} active snapshots for ${contentFrames.length} tiny deltas`)
  assert.ok(observed.every(preview => JSON.stringify(preview).length < 800_000), 'serialized previews remain within the bounded text budget plus structure overhead')
  assert.equal(observed.at(-1)?.activeQuestion, undefined)
  assert.equal(observed.at(-1)?.completedQuestions, 1, JSON.stringify(observed.map(({ completedQuestions, activeQuestion }) => ({ completedQuestions, active: Boolean(activeQuestion) }))))
})
 
