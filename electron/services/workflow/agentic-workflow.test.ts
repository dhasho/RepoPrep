import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import type { LlmProfile } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createAgenticWorkflowRunner } from './agentic-workflow.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createWorkflowSnapshot } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import type { ModelTransport } from './model-gateway.ts'

const source = `export function add(a: number, b: number): number {
  const total = a + b
  return total
}
`

interface Fixture {
  readonly root: string
  readonly scan: Awaited<ReturnType<typeof scanProject>>
  readonly snapshot: Awaited<ReturnType<typeof createWorkflowSnapshot>>
  readonly profile: LlmProfile
  makeSpec(runId: string): ReturnType<typeof createRunSpec>
  cleanup(): Promise<void>
}

async function fixture(projectId = 'agentic-project'): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-agentic-runner-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'math.ts'), source, 'utf8')
  const scan = await scanProject(root)
  const snapshot = await createWorkflowSnapshot(scan, { projectId })
  const profile: LlmProfile = {
    id: 'synthetic-profile', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'SYNTHETIC_KEY_ONLY',
    model: 'synthetic-model', protocol: 'openai', temperature: 0.4, contextWindowTokens: 49_152, maxOutputTokens: 2000
  }
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  return {
    root, scan, snapshot, profile,
    makeSpec(runId) {
      return createRunSpec({
        version: 1, runId, projectId, snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1',
        roleFocus: 'backend', granularity: 'coarse',
        model: { profileId: profile.id, endpointFingerprint, model: profile.model, protocol: profile.protocol, temperature: profile.temperature, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens },
        promptVersion: 'workflow-prompt-v2', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1',
        budget: { maxModelRequests: 5, wallClockMs: 600_000 }
      })
    },
    async cleanup() { await fs.rm(root, { recursive: true, force: true }) }
  }
}

interface TransportState {
  calls: number
  investigationCalls: number
  generationCalls: number
  currentIntent: string
  omitGenerationUsage: boolean
  invalidFirstCitation: boolean
  insufficientInvestigation: boolean
}

function syntheticTransport(state: TransportState): ModelTransport {
  return async (_profile, messages, onDelta, options) => {
    state.calls++
    const isInvestigation = messages[0]?.content.includes('bounded local code investigator') ?? false
    options.beforeRequest?.()
    let content: string
    let outputTokens = 80
    if (isInvestigation) {
      const user = JSON.parse(messages.find(message => message.role === 'user')!.content) as { intent: string; evidenceIds: string[]; files: Array<{ fileId: string }> }
      state.currentIntent = user.intent
      state.investigationCalls++
      if (state.insufficientInvestigation) {
        content = JSON.stringify({ actions: [{ type: 'finish_investigation', unresolved: ['No usable source evidence was selected.'] }] })
      } else if (state.investigationCalls === 1) {
        content = JSON.stringify({ actions: [{ type: 'request_tools', tools: [{ actionId: 'read-source', tool: 'read_region', args: { fileId: user.files[0].fileId, startLine: 1, endLine: 4 } }] }] })
      } else {
        const evidenceId = user.evidenceIds[0]
        assert.ok(evidenceId)
        const topic = { id: 'math-topic', title: 'Addition implementation', mechanism: 'Trace the addition operation.', valueRationale: 'It follows the selected source range.', difficulty: 'basic', evidenceIds: [evidenceId], evidenceNeeds: [], unconfirmed: [] }
        content = JSON.stringify({ actions: [
          { type: 'propose_topics', topics: [topic] },
          { type: 'select_evidence', selection: { selectedIds: [evidenceId], requiredBundles: [], unresolved: [] } },
          { type: 'finish_investigation', unresolved: [] }
        ] })
      }
    } else {
      state.generationCalls++
      const userText = messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
      const quota = Number(userText.match(/题量硬性约束：(?:严格|约)\s+(\d+)\s*题/u)?.[1] ?? 0)
      const evidenceIds = [...new Set(userText.match(/ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu) ?? [])]
      assert.ok(evidenceIds.length > 0, 'synthetic generation must use a packed evidence ID')
      const invalidCitation = state.invalidFirstCitation && state.generationCalls === 1
      const evidenceId = invalidCitation ? 'ev_00000000-0000-4000-8000-000000000000' : evidenceIds[0]
      const questions = Array.from({ length: quota }, (_, index) => ({
        title: `Addition question ${state.generationCalls}-${index + 1}`,
        question: `How does this implementation produce value ${state.generationCalls}-${index + 1}?`,
        answer: `The selected source range shows an explicit addition followed by returning the calculated total. This answer uses only that observed behavior and keeps the explanation bounded for a synthetic integration test.`,
        followUps: [{ question: 'What input boundary would you check?', answer: 'Check that callers provide numeric inputs and handle the result consistently.', followUps: [] }],
        evidenceIds: [evidenceId]
      }))
      content = JSON.stringify({
        projectSummary: 'This synthetic project contains a small TypeScript module used only to validate the guarded workflow assembly.',
        sections: quota ? [{ title: 'Addition flow', summary: 'Trace the addition implementation.', questions }] : [],
        glossary: {}
      })
      outputTokens = Math.min(120, options.maxOutputTokens ?? 120)
    }

    await onDelta(content)
    if (!(state.omitGenerationUsage && !isInvestigation)) {
      const inputTokens = 180
      options.onUsage?.({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })
    }
    return content
  }
}

function transportState(overrides: Partial<TransportState> = {}): TransportState {
  return { calls: 0, investigationCalls: 0, generationCalls: 0, currentIntent: '', omitGenerationUsage: false, invalidFirstCitation: false, insufficientInvestigation: false, ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('runs the real scanner/snapshot/investigator/generator seam with settled synthetic receipts and an aligned sidecar', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const state = transportState({ invalidFirstCitation: true })
  const progress: number[] = []
  const runner = createAgenticWorkflowRunner({ transport: syntheticTransport(state) })
  const output = await runner.run({
    spec: f.makeSpec('integrated-run'), scan: f.scan, snapshot: f.snapshot, profile: f.profile,
    objective: 'Inspect the addition implementation using issued source evidence.',
    onProgress: (_step, _detail, percent) => { progress.push(percent) }
  })

  const questions = output.result.sections.flatMap(section => section.questions)
  assert.ok(questions.length >= f.makeSpec('other').questionBudget.min)
  assert.equal(output.evidenceSidecar.runId, 'integrated-run')
  assert.deepEqual(output.evidenceSidecar.questions.map(entry => entry.questionId), questions.map(question => question.id))
  assert.equal(output.diagnostics.investigation.status, 'completed')
  assert.ok(output.diagnostics.investigation.selectedEvidenceCount > 0)
  assert.ok(output.diagnostics.investigation.events.some(event => event.type === 'tool'))
  assert.ok(output.diagnostics.budget.usageComplete)
  assert.ok(output.diagnostics.budget.reservations.every(entry => entry.state === 'settled'))
  assert.equal(output.diagnostics.generationDispatches.some(entry => entry.stage === 'repair'), true)
  assert.ok(output.diagnostics.generationDispatches.every(entry => entry.completion === 'completed' && entry.manifest.packedIds.length > 0))
  assert.equal(output.diagnostics.lifecycle.terminalStatus, 'succeeded')
  assert.ok(progress.length > 0)
  const serialized = JSON.stringify(output)
  assert.equal(serialized.includes(f.profile.apiKey), false)
  assert.equal(serialized.includes(source), false)
  assert.equal(serialized.includes('messages'), false)
  assert.equal(state.calls, output.diagnostics.budget.total.dispatchedRequests)
  assert.ok(state.calls <= f.makeSpec('other').budget.total.maxModelRequests)
})

test('rejects a forged scan before dispatching a provider request', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const state = transportState()
  const runner = createAgenticWorkflowRunner({ transport: syntheticTransport(state) })
  await assert.rejects(runner.run({ spec: f.makeSpec('forged-scan'), scan: { ...f.scan }, snapshot: f.snapshot, profile: f.profile }), (error: unknown) => error instanceof WorkflowError && error.code === 'stale-snapshot')
  assert.equal(state.calls, 0)
})

test('insufficient investigation evidence cannot start answer generation', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const state = transportState({ insufficientInvestigation: true })
  const runner = createAgenticWorkflowRunner({ transport: syntheticTransport(state) })
  await assert.rejects(runner.run({ spec: f.makeSpec('insufficient-evidence'), scan: f.scan, snapshot: f.snapshot, profile: f.profile }), (error: unknown) => error instanceof WorkflowError && error.code === 'unknown-evidence')
  assert.equal(state.investigationCalls, 1)
  assert.equal(state.generationCalls, 0)
})

test('missing generation usage fails closed without an extra provider request', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const state = transportState({ omitGenerationUsage: true })
  const runner = createAgenticWorkflowRunner({ transport: syntheticTransport(state) })
  let failure: unknown
  try { await runner.run({ spec: f.makeSpec('missing-usage'), scan: f.scan, snapshot: f.snapshot, profile: f.profile }) } catch (error) { failure = error }
  assert.ok(failure instanceof WorkflowError)
  assert.equal(failure.message, 'Workflow operation rejected.')
  assert.equal(failure.message.includes(f.profile.apiKey), false)
  assert.equal(failure.message.includes(source), false)
  assert.equal(state.generationCalls, 1)
  assert.equal(state.calls, state.investigationCalls + 1)
})

test('cancellation releases the project lease before late transport completion without disturbing the replacement run', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const state = transportState()
  const defaultTransport = syntheticTransport(state)
  const oldResponse = deferred<string>()
  const newResponse = deferred<string>()
  let oldStarted!: () => void
  let newStarted!: () => void
  const oldStartedPromise = new Promise<void>(resolve => { oldStarted = resolve })
  const newStartedPromise = new Promise<void>(resolve => { newStarted = resolve })
  let oldInvestigationCalls = 0
  let newInvestigationCalls = 0
  const transport: ModelTransport = async (profile, messages, onDelta, options) => {
    const isInvestigation = messages[0]?.content.includes('bounded local code investigator') ?? false
    if (isInvestigation) {
      const user = JSON.parse(messages.find(message => message.role === 'user')!.content) as { intent: string; evidenceIds: string[]; files: Array<{ fileId: string }> }
      if (user.intent === 'old run' && oldInvestigationCalls++ === 0) {
        state.calls++
        options.beforeRequest?.()
        oldStarted()
        const value = await oldResponse.promise
        options.onUsage?.({ inputTokens: 180, outputTokens: 80, totalTokens: 260 })
        return value
      }
      if (user.intent === 'new run' && newInvestigationCalls++ === 0) {
        state.calls++
        state.investigationCalls++
        state.currentIntent = user.intent
        options.beforeRequest?.()
        newStarted()
        const value = await newResponse.promise
        await onDelta(value)
        options.onUsage?.({ inputTokens: 180, outputTokens: 80, totalTokens: 260 })
        return value
      }
    }
    return defaultTransport(profile, messages, onDelta, options)
  }
  const runner = createAgenticWorkflowRunner({ transport })
  const oldRun = runner.run({ spec: f.makeSpec('run-old'), scan: f.scan, snapshot: f.snapshot, profile: f.profile, objective: 'old run' })
  await oldStartedPromise
  assert.equal(runner.getActiveProjectRun(f.snapshot.projectId), 'run-old')
  const requestCountBeforeDuplicate = state.calls
  await assert.rejects(runner.run({ spec: f.makeSpec('run-duplicate'), scan: f.scan, snapshot: f.snapshot, profile: f.profile, objective: 'duplicate run' }), (error: unknown) => error instanceof WorkflowError && error.code === 'configuration-changed')
  assert.equal(state.calls, requestCountBeforeDuplicate, 'duplicate project is rejected before provider dispatch')
  assert.equal(runner.cancel('run-old'), true)

  const newRun = runner.run({ spec: f.makeSpec('run-new'), scan: f.scan, snapshot: f.snapshot, profile: f.profile, objective: 'new run' })
  await newStartedPromise
  assert.equal(runner.getActiveProjectRun(f.snapshot.projectId), 'run-new')
  oldResponse.resolve(JSON.stringify({ actions: [{ type: 'request_tools', tools: [{ actionId: 'too-late', tool: 'read_region', args: { fileId: f.snapshot.files[0].fileId, startLine: 1, endLine: 2 } }] }] }))
  await assert.rejects(oldRun, (error: unknown) => error instanceof WorkflowError && error.code === 'cancelled')
  assert.equal(runner.getActiveProjectRun(f.snapshot.projectId), 'run-new')

  newResponse.resolve(JSON.stringify({ actions: [{ type: 'request_tools', tools: [{ actionId: 'read-source', tool: 'read_region', args: { fileId: f.snapshot.files[0].fileId, startLine: 1, endLine: 4 } }] }] }))
  const output = await newRun
  assert.equal(output.diagnostics.lifecycle.runId, 'run-new')
  assert.equal(runner.getActiveProjectRun(f.snapshot.projectId), null)
})
