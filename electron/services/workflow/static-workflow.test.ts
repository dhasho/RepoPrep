import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node tests require explicit extensions.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- direct Node tests require explicit extensions.
import { generateInterview } from '../generator.ts'
// @ts-ignore TS5097 -- direct Node tests require explicit extensions.
import { staticContextProvider } from './context-provider.ts'
// @ts-ignore TS5097 -- direct Node tests require explicit extensions.
import { createWorkflowTrace } from './trace.ts'
import type { LlmProfile } from '../../../shared/types'
import type { GenerationCheckpoint } from '../../../shared/generation-checkpoint'

const profile: LlmProfile = {
  id: 'static-comparison', name: 'Synthetic', model: 'synthetic',
  baseUrl: 'https://static-workflow.invalid/v1', apiKey: 'SYNTHETIC_PRIVATE_KEY'
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-static-'))
  await fs.writeFile(path.join(root, 'README.md'), '# Static comparison\nA project for isolated synthetic tests.\n')
  await fs.writeFile(path.join(root, 'index.ts'), 'export function run(value: string) { return value.trim() }\n')
  t.after(async () => {
    const absolute = path.resolve(root)
    const relative = path.relative(os.tmpdir(), absolute)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    assert.match(path.basename(absolute), /^agentic-static-/)
    assert.equal((await fs.lstat(absolute)).isSymbolicLink(), false)
    await fs.rm(absolute, { recursive: true })
  })
  return scanProject(root)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => !['id', 'createdAt', 'generationDiagnostics'].includes(key))
      .map(([key, item]) => [key, canonical(item)])
  )
  return value
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

async function withModel<T>(run: (requests: Array<Record<string, unknown>>) => Promise<T>, usage = true): Promise<T> {
  const original = globalThis.fetch
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://static-workflow.invalid/v1/chat/completions')
    const payload = JSON.parse(String(init?.body))
    requests.push(payload)
    const prompt = payload.messages.map((message: { content: string }) => message.content).join('\n')
    const count = Number(prompt.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1])
    assert.ok(Number.isInteger(count) && count > 0)
    const content = JSON.stringify({
      projectSummary: 'A static synthetic project.',
      sections: [{ title: 'Static project', summary: 'Runtime behavior', questions: Array.from({ length: count }, (_, index) => ({
        question: `Question ${index + 1}: how does this operation work?`,
        answer: `Answer ${index + 1} describes the provided code.`, followUps: []
      })) }], glossary: {}
    })
    return new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage: { prompt_tokens: 100, completion_tokens: 50 } } : {}) }), {
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  try { return await run(requests) } finally { globalThis.fetch = original }
}

function trace(sink?: (event: unknown) => Promise<void>) {
  return createWorkflowTrace({
    runId: 'static-run', projectId: 'static-project', snapshotId: 'static-snapshot', strategy: 'static',
    requiredSpans: ['run', 'context', 'model', 'dispatch', 'validation'], sink
  })
}

test('static provider and opt-in trace preserve exact dispatched messages, result body, quotas and saved checkpoints', async t => {
  const scan = await fixture(t)
  const saves: GenerationCheckpoint[][] = [[], []]
  const results: unknown[] = []
  const payloads: unknown[] = []
  const workflowTrace = trace()
  for (let index = 0; index < 2; index++) await withModel(async requests => {
    results.push(await generateInterview({
      scan, profile, granularity: 'medium', roleFocus: 'general',
      signal: new AbortController().signal, onProgress: () => {},
      checkpoint: { save: state => { saves[index].push(structuredClone(state)) } },
      ...(index ? { contextProvider: staticContextProvider, workflowTrace } : {})
    }))
    payloads.push(requests)
  })
  assert.deepEqual(payloads[0], payloads[1])
  assert.deepEqual(canonical(results[0]), canonical(results[1]))
  assert.deepEqual(canonical(saves[0]), canonical(saves[1]))
  const snapshot = workflowTrace.snapshot()
  const events = snapshot.events
  const dispatch = events.filter(event => event.span === 'dispatch' && event.status === 'succeeded')
  const actual = payloads[1] as Array<{ messages: unknown }>
  assert.equal(dispatch.length, actual.length)
  for (let index = 0; index < actual.length; index++) assert.deepEqual(dispatch[index].inputHashes, [createHash('sha256').update(stableJson(actual[index].messages)).digest('hex')])
  assert.equal(events.at(-1)?.status, 'succeeded')
  assert.ok(events.some(event => event.span === 'validation' && event.status === 'succeeded'))
  assert.doesNotMatch(JSON.stringify(snapshot), /SYNTHETIC_PRIVATE_KEY|value\.trim|Static comparison|baseUrl|apiKey/)
})

test('trace write failure cannot change result persistence or terminal outcome and missing usage stays unknown', async t => {
  const scan = await fixture(t)
  const workflowTrace = trace(async () => { throw new Error('SYNTHETIC_PRIVATE_KEY') })
  let saves = 0
  await withModel(async () => {
    const result = await generateInterview({
      scan, profile, granularity: 'coarse', roleFocus: 'general', workflowTrace,
      signal: new AbortController().signal, onProgress: () => {}, checkpoint: { save: () => { saves++ } }
    })
    assert.equal(result.generationDiagnostics?.usageComplete, false)
    assert.ok(result.sections.flatMap(section => section.questions).length >= 8)
  }, false)
  await workflowTrace.flush()
  assert.ok(saves > 0)
  const snapshot = workflowTrace.snapshot()
  assert.ok(snapshot.events.some(event => event.span === 'model' && event.usage?.complete === false))
  assert.doesNotMatch(JSON.stringify(snapshot), /SYNTHETIC_PRIVATE_KEY/)
})

test('cancellation after context produces terminal trace and never dispatches a model request', async t => {
  const scan = await fixture(t)
  const controller = new AbortController()
  const workflowTrace = trace()
  await withModel(async requests => {
    await assert.rejects(generateInterview({
      scan, profile, granularity: 'coarse', roleFocus: 'general', workflowTrace,
      signal: controller.signal, onProgress: step => { if (step === '上下文就绪') controller.abort() }
    }))
    assert.equal(requests.length, 0)
  })
  assert.equal(workflowTrace.snapshot().events.at(-1)?.status, 'cancelled')
})

test('context provider failures and cancellation close the actual provider span without replacing the original error', async t => {
  const scan = await fixture(t)
  for (const cancelled of [false, true]) {
    const controller = new AbortController()
    const workflowTrace = trace()
    const failure = new Error('Synthetic context error')
    await assert.rejects(generateInterview({
      scan, profile, granularity: 'coarse', roleFocus: 'general', workflowTrace,
      signal: controller.signal, onProgress: () => {}, contextProvider: {
        id: 'scripted-provider-v1', build: async () => {
          if (cancelled) controller.abort()
          throw failure
        }
      }
    }), error => error === failure)
    const snapshot = workflowTrace.snapshot()
    const events = snapshot.events.filter(event => event.span === 'context')
    assert.equal(events.length, 2)
    assert.equal(events[1].status, cancelled ? 'cancelled' : 'failed')
    assert.equal(events[1].componentVersion, 'scripted-provider-v1')
    assert.equal(snapshot.terminalStatus, cancelled ? 'cancelled' : 'failed')
  }
})
