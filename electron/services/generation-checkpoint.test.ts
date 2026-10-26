// End-to-end checkpoint coverage through the production generator and a synthetic HTTP model.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { type TestContext } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
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
import type { LlmProfile } from '../../shared/types.ts'

const profile: LlmProfile = { id: 'checkpoint-profile', name: 'Synthetic', baseUrl: 'https://mock.example/v1', apiKey: 'secret-a', model: 'mock-model' }
const countQuestions = (result: { sections: Array<{ questions: unknown[] }> }) => result.sections.reduce((n, section) => n + section.questions.length, 0)

async function project(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-checkpoint-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\nA small stable project.\n')
  for (let i = 0; i < 3; i++) {
    const dir = path.join(root, `module${i}`)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'index.ts'), `export const moduleValue${i} = ${i + 1}\n`)
  }
  return root
}

function response(prompt: string): string {
  const wanted = Number(prompt.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1] ?? 2)
  const topic = prompt.match(/模块「([^」]+)」/)?.[1] ?? 'global'
  const questions = Array.from({ length: wanted }, (_, i) => ({
    title: `${topic} topic ${i + 1}`,
    question: `${topic} question ${i + 1}: explain the implementation`,
    answer: `The implementation uses [[${topic}Term]] to organize behavior.`,
    followUps: [{ question: `Why ${i + 1}?`, answer: 'Because this is the selected implementation.', followUps: [] }]
  }))
  return JSON.stringify({ projectSummary: 'A synthetic project.', sections: [{ title: `${topic} section`, summary: 'Implementation', questions }], glossary: { [`${topic}Term`]: 'A term used by the implementation.' } })
}

async function withFetch<T>(impl: (prompt: string, call: number) => Response | Promise<Response>, run: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const prompt = body.messages.map((message: { content: string }) => message.content).join('\n')
    calls.push(prompt)
    return impl(prompt, calls.length)
  }) as typeof fetch
  try { return await run(calls) } finally { globalThis.fetch = original }
}

function params(scan: Awaited<ReturnType<typeof scanProject>>, profileOverride = profile, state?: GenerationCheckpoint | null, save = (_value: GenerationCheckpoint) => undefined) {
  return {
    scan, granularity: 'fine' as const, roleFocus: 'backend' as const, profile: profileOverride,
    signal: new AbortController().signal, onProgress: () => undefined,
    checkpoint: { state, save }
  }
}

test('replays completed production batches after a later batch fails, then finishes without refetching them', async (t) => {
  const root = await project(t)
  const scan = await scanProject(root)
  let checkpoint: GenerationCheckpoint | undefined
  await withFetch((_prompt, call) => call <= 2
    ? new Response(JSON.stringify({ choices: [{ message: { content: response(_prompt) } }] }), { status: 200 })
    : new Response('temporary upstream failure', { status: 503 }), async (calls) => {
    await assert.rejects(generateInterview(params(scan, profile, null, (value) => { checkpoint = value })), /503|failed|error/i)
    assert.equal(checkpoint?.entries.length, 2)
    const resumeFetchCalls: string[] = []
    const prior = checkpoint as GenerationCheckpoint
    const resumed = { ...params(scan, { ...profile, apiKey: 'secret-b' }, prior), save: (value: GenerationCheckpoint) => {
      assert.deepEqual(value.entries.slice(0, prior.entries.length), prior.entries, 'existing checkpoint entries must remain byte-for-byte stable')
      assert.equal(new Set(value.entries.map((entry) => entry.key)).size, value.entries.length, 'checkpoint call keys must be unique')
      checkpoint = value
    } }
    const result = await withFetch((prompt) => new Response(JSON.stringify({ choices: [{ message: { content: response(prompt) } }] }), { status: 200 }), async (replayCalls) => {
      const value = await generateInterview(resumed)
      resumeFetchCalls.push(...replayCalls)
      return value
    })
    assert.ok(resumeFetchCalls.length >= 1)
    assert.equal(result.generationDiagnostics?.requestCount, resumeFetchCalls.length)
    assert.ok(resumeFetchCalls.every((prompt) => !calls.slice(0, 2).includes(prompt)), 'completed primary prompts must not be fetched again')
    assert.ok(countQuestions(result) >= 25)
    const completedTitles = new Map(prior.entries.flatMap(entry => entry.batch.sections.flatMap(section =>
      section.questions.map(question => [question.question, question.title] as const))))
    const replayedQuestions = result.sections.flatMap(section => section.questions)
      .filter(question => completedTitles.has(question.question))
    assert.ok(replayedQuestions.length > 0, 'completed batches remain in the resumed report')
    replayedQuestions.forEach(question => assert.equal(question.title, completedTitles.get(question.question), 'resumed batches retain their short titles'))
    assert.ok(Object.keys(result.glossary).length > 0)
    assert.equal(calls.length, 3, 'the third batch failed once after two completed batches')
  })
})

test('context changes reject before HTTP; API key rotation is accepted; initial save failure blocks HTTP', async (t) => {
  const root = await project(t)
  const scan = await scanProject(root)
  let state: GenerationCheckpoint | null = null
  await withFetch((prompt) => new Response(JSON.stringify({ choices: [{ message: { content: response(prompt) } }] }), { status: 200 }), async () => {
    await generateInterview(params(scan, profile, null, (value) => { state = value }))
  })
  assert.ok(state)
  const completedState = state as GenerationCheckpoint
  await withFetch(() => { throw new Error('fully completed checkpoint must not call the model') }, async () => {
    const value = await generateInterview(params(scan, profile, completedState))
    assert.ok(countQuestions(value) >= 25)
  })
  await withFetch(() => { throw new Error('model mismatch must be rejected before HTTP') }, async () => {
    await assert.rejects(generateInterview(params(scan, { ...profile, model: 'changed-model' }, completedState)), /项目上下文或模型配置已变化/)
  })
  const changedFile = path.join(root, 'module0', 'index.ts')
  await fs.appendFile(changedFile, '\nexport const changed = true\n')
  const changedScan = await scanProject(root)
  await withFetch(() => { throw new Error('network must not be called') }, async () => {
    await assert.rejects(generateInterview(params(changedScan, profile, completedState)), /项目上下文或模型配置已变化/)
  })

  const fresh = await scanProject(root)
  await withFetch((prompt) => new Response(JSON.stringify({ choices: [{ message: { content: response(prompt) } }] }), { status: 200 }), async () => {
    await assert.rejects(generateInterview(params(fresh, profile, null, () => { throw new Error('disk full') })), /无法保存生成检查点/)
  })
})

test('cancellation after an HTTP reply does not persist the current batch as complete', async (t) => {
  const root = await project(t)
  const scan = await scanProject(root)
  const controller = new AbortController()
  let lastSaved: GenerationCheckpoint | undefined
  await withFetch((prompt) => {
    controller.abort()
    return new Response(JSON.stringify({ choices: [{ message: { content: response(prompt) } }] }), { status: 200 })
  }, async (calls) => {
    await assert.rejects(generateInterview({
      ...params(scan), signal: controller.signal,
      checkpoint: { state: null, save: (value) => { lastSaved = value } }
    }), /取消/)
    assert.equal(calls.length, 1)
    assert.equal(lastSaved?.entries.length, 0)
  })
})

test('a failed second compensation resumes by replaying the first compensation with stable journal prefix', async (t) => {
  const root = await project(t)
  const scan = await scanProject(root)
  let state: GenerationCheckpoint | null = null
  let firstRunCompensationCalls = 0
  await withFetch((prompt) => {
    if (prompt.includes('- 补充说明：')) {
      firstRunCompensationCalls++
      if (firstRunCompensationCalls === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          projectSummary: '', sections: [{ title: 'duplicate', questions: [{
            question: 'global question 1: explain the implementation', answer: 'duplicate answer', followUps: []
          }] }], glossary: {}
        }) } }] }), { status: 200 })
      }
      return new Response('compensation outage', { status: 503 })
    }
    const topic = prompt.match(/模块「([^」]+)」/)?.[1] ?? 'global'
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      projectSummary: 'A synthetic project.', sections: [{ title: topic, questions: [{
        question: `${topic} question 1: explain the implementation`, answer: `Uses [[${topic}Term]].`, followUps: []
      }] }], glossary: { [`${topic}Term`]: 'A term.' }
    }) } }] }), { status: 200 })
  }, async () => {
    await assert.rejects(generateInterview(params(scan, profile, null, (value) => { state = value })), /503|error/i)
  })
  assert.ok(state)
  const previous = state as GenerationCheckpoint
  assert.equal(firstRunCompensationCalls, 2)
  assert.ok(previous.entries.length > 3, 'the successful duplicate compensation should be journaled')
  let resumeCalls = 0
  const result = await withFetch((prompt) => {
    resumeCalls++
    assert.ok(prompt.includes('- 补充说明：'), 'only the unfinished compensation request may be sent')
    const questions = Array.from({ length: 8 }, (_, i) => ({ question: `new compensation ${i}`, answer: 'unique answer', followUps: [] }))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ projectSummary: '', sections: [{ title: 'new', questions }], glossary: {} }) } }] }), { status: 200 })
  }, async () => generateInterview({
    ...params(scan, { ...profile, apiKey: 'rotated' }, previous),
    checkpoint: { state: previous, save: (value) => {
      assert.deepEqual(value.entries.slice(0, previous.entries.length), previous.entries)
      assert.equal(new Set(value.entries.map((entry) => entry.key)).size, value.entries.length)
    } }
  }))
  assert.equal(resumeCalls, 1)
  assert.equal(result.generationDiagnostics?.requestCount, 1)
})
