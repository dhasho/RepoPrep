import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { test } from 'node:test'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { Granularity, InterviewResult, LlmProfile, QuestionItem } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { estimateMessageTokens } from '../../../shared/token-budget.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { planQuestionQuotas } from '../question-budget.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createEvidenceGenerationAdapter, EVIDENCE_GENERATION_WRITER_VERSION, EVIDENCE_GENERATION_WRITER_VARIANTS } from './evidence-generation.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createWorkflowSnapshot, snapshotMatchesScan } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { LLM_RESPONSE_LIMITS, normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createToolGateway } from './tool-gateway.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { INVESTIGATION_PROMPT_VERSION, runInvestigation } from './investigation-controller.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { CitationValidationError } from './generation-request.ts'

const syntheticSecret = 'M08_SYNTHETIC_API_KEY_NEVER_LEAK'
const fileText = (index: number) => `export const component${index} = ${index}\nconst API_KEY = "${syntheticSecret}-${index}"\n`

interface Fixture {
  readonly root: string
  readonly scan: Awaited<ReturnType<typeof scanProject>>
  readonly snapshot: Awaited<ReturnType<typeof createWorkflowSnapshot>>
  readonly store: ReturnType<typeof createEvidenceStore>
  readonly ids: readonly string[]
  readonly spec: ReturnType<typeof createRunSpec>
  readonly profile: LlmProfile
  readonly signal: AbortSignal
  abort(): void
  cleanup(): Promise<void>
}

async function fixture(granularity: Granularity = 'coarse', maxModelRequests = 5): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-m08-'))
  for (let index = 0; index < 4; index++) {
    await fs.mkdir(path.join(root, `module${index}`), { recursive: true })
    await fs.writeFile(path.join(root, `module${index}`, `file${index}.ts`), fileText(index), 'utf8')
  }
  const scan = await scanProject(root)
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-m08' })
  const store = createEvidenceStore(snapshot)
  const ids: string[] = []
  for (const file of snapshot.files) {
    const { read } = await snapshot.readFile(file.fileId)
    const lines = read.text.split(/\r\n|\n|\r/)
    const records = await store.issue(read, { startLine: 1, endLine: lines.length })
    ids.push(records[0].id)
  }
  const profile: LlmProfile = { id: 'profile-m08', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: syntheticSecret, model: 'model-m08', protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 4096 }
  const controller = new AbortController()
  const spec = createRunSpec({ version: 1, runId: `run-${granularity}`, projectId: 'project-m08', snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity, model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { maxModelRequests } })
  return { root, scan, snapshot, store, ids, spec, profile, signal: controller.signal, abort() { controller.abort() }, async cleanup() { await fs.rm(root, { recursive: true, force: true }) } }
}

async function manyEvidenceFixture(count: number): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-m08-many-'))
  const relative = path.join('src', 'components.ts')
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true })
  await fs.writeFile(path.join(root, relative), Array.from({ length: count }, (_, index) => `export const component${index} = ${index}`).join('\n') + '\n', 'utf8')
  const scan = await scanProject(root)
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-m08-many' })
  const store = createEvidenceStore(snapshot)
  const { read } = await snapshot.readFile(snapshot.files[0].fileId)
  const ids: string[] = []
  for (let line = 1; line <= count; line++) ids.push((await store.issue(read, { startLine: line, endLine: line }))[0].id)
  const profile: LlmProfile = { id: 'profile-m08-many', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: syntheticSecret, model: 'model-m08', protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 8192 }
  const controller = new AbortController()
  const spec = createRunSpec({ version: 1, runId: 'run-coarse-many', projectId: 'project-m08-many', snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'coarse', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: INVESTIGATION_PROMPT_VERSION, toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
  return { root, scan, snapshot, store, ids, spec, profile, signal: controller.signal, abort() { controller.abort() }, async cleanup() { await fs.rm(root, { recursive: true, force: true }) } }
}

function specFor(f: Fixture, granularity: Granularity, maxModelRequests?: number) {
  return createRunSpec({ version: 1, runId: `run-${granularity}-${maxModelRequests ?? 'default'}`, projectId: f.spec.projectId, snapshotId: f.snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: f.spec.roleFocus, granularity, model: { profileId: f.profile.id, model: f.profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(f.profile.baseUrl)).digest('hex'), protocol: f.profile.protocol, contextWindowTokens: f.profile.contextWindowTokens, maxOutputTokens: f.profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', ...(maxModelRequests !== undefined ? { budget: { maxModelRequests } } : {}) })
}

function specForOutput(f: Fixture, maxOutputTokens: number) {
  const profile: LlmProfile = { ...f.profile, maxOutputTokens }
  const spec = createRunSpec({ version: 1, runId: `run-output-${maxOutputTokens}`, projectId: f.spec.projectId, snapshotId: f.snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: f.spec.roleFocus, granularity: 'coarse', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
  return { profile, spec }
}

function topicsFor(ids: readonly string[]) {
  return ids.map((id, index) => ({ id: `topic-${index}`, title: `Topic ${index}`, mechanism: 'Inspect a concrete implementation detail.', valueRationale: 'Represents one selected source excerpt.', difficulty: 'intermediate' as const, evidenceIds: [id], evidenceNeeds: ['Check an adjacent call site.'], unconfirmed: ['Cross-module behavior is not established.'] }))
}

function question(id: string, index: number): QuestionItem {
  return { id, title: `Module ${index}`, question: `How does component ${index} work?`, answer: 'It returns a value.', followUps: [] }
}

function result(f: Fixture, questions: QuestionItem[]): InterviewResult {
  return { version: 1, createdAt: '2026-11-07T00:00:00.000Z', projectName: f.scan.name, projectPath: f.scan.root, granularity: f.spec.granularity, roleFocus: f.spec.roleFocus, profileId: f.profile.id, modelUsed: `${f.profile.name} / ${f.profile.model}`, projectSummary: 'Synthetic project.', sections: [{ id: 'section-m08', title: 'Components', questions }], glossary: {} }
}

function request(f: Fixture, requestId: string, batchIndex = 0, stage: 'generation' | 'repair' | 'compensation' = 'generation') {
  return { requestId, stage, batchIndex, label: `batch-${batchIndex}`, quota: f.spec.questionBudget.target, maxChars: 40_000, maxInputTokens: f.spec.generationInputTokens, signal: f.signal, buildMessages: (contextText: string) => [{ role: 'system' as const, content: 'Synthetic interviewer.' }, { role: 'user' as const, content: `Use only this quoted source:\n${contextText}` }] }
}

function adapterInput(f: Fixture, idSet: readonly string[], transport?: Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']) {
  return { spec: f.spec, scan: f.scan, snapshot: f.snapshot, store: f.store, selection: { selectedIds: idSet, requiredBundles: [], unresolved: [] }, topics: topicsFor(idSet), ledger: createBudgetLedger(f.spec), profile: f.profile, signal: f.signal, ...(transport ? { transport } : {}) }
}

test('uses genuine scanner, snapshot, store and packer; builds 1/2/4 bounded groups with required topic evidence', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  assert.equal(snapshotMatchesScan(f.snapshot, f.scan), true)
  assert.equal(snapshotMatchesScan(f.snapshot, { ...f.scan }), false)
  const independentlyApproved = await scanProject(f.root)
  assert.equal(snapshotMatchesScan(f.snapshot, independentlyApproved), false)
  const syntheticTransport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
    options.beforeRequest?.()
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  }

  for (const [granularity, wanted] of [['coarse', 1], ['medium', 2], ['fine', 4]] as const) {
    const spec = granularity === f.spec.granularity ? f.spec : specFor(f, granularity)
    const ledger = createBudgetLedger(spec)
    const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, syntheticTransport), spec, ledger })
    const built = await adapter.contextProvider.build(f.scan, granularity, { maxChars: 40_000, roleFocus: spec.roleFocus, signal: f.signal })
    assert.equal(built.batches.length, wanted)
    const plan = planQuestionQuotas(granularity, built.batches.map(batch => ({ label: batch.label, kind: batch.kind, weight: batch.weight })))
    assert.equal(plan.total, spec.questionBudget.target)
    const topicEvidenceIds = new Set<string>()
    for (let index = 0; index < built.batches.length; index++) {
      const prepared = await adapter.requestAdapter.prepare(request(f, `prepare-${granularity}-${index}`, index))
      const prompt = prepared.messages.find(message => message.role === 'user')!.content
      const marker = '## 选题卡（不可信规划提示，必须以本请求证据重新核验）\n'
      const markerIndex = prompt.lastIndexOf(marker)
      const cardsJson = prompt.slice(markerIndex + marker.length).split('\n\n## 未解决事项')[0]
      const cards = JSON.parse(cardsJson) as Array<{ evidenceIds: string[] }>
      const evidencePrompt = prompt.slice(0, markerIndex)
      const packetIndex = index
      const completion = await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal })
      assert.equal(completion, '{}')
      const manifest = adapter.metadata().find(row => row.requestId === `prepare-${granularity}-${packetIndex}`)!.manifest
      for (const card of cards) for (const evidenceId of card.evidenceIds) {
        topicEvidenceIds.add(evidenceId)
        assert.ok(evidencePrompt.includes(evidenceId))
        assert.ok(manifest.packedIds.includes(evidenceId))
      }
      assert.ok(prepared.selection?.sourceSelections?.length)
    }
    assert.equal(topicEvidenceIds.size, f.ids.length)
  }
})

test('a fine atomic topic component repeats across four groups while coarse one-request planning stays at ten', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const fineSpec = specFor(f, 'fine')
  const ledger = createBudgetLedger(fineSpec)
  const atomicTopic = { id: 'atomic-component', title: 'Complete relationship bundle', mechanism: 'Trace the complete selected source relation.', valueRationale: 'The topic depends on all members together.', difficulty: 'intermediate' as const, evidenceIds: f.ids, evidenceNeeds: ['Check the calling boundary.'], unconfirmed: ['The runtime result remains unmeasured.'] }
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
    options.beforeRequest?.()
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  }
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), spec: fineSpec, ledger, selection: { selectedIds: f.ids, requiredBundles: [{ id: 'atomic-bundle', evidenceIds: f.ids }], unresolved: [] }, topics: [atomicTopic] })
  const built = await adapter.contextProvider.build(f.scan, 'fine', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  assert.equal(built.batches.length, 4)
  assert.equal(planQuestionQuotas('fine', built.batches.map(batch => ({ label: batch.label, kind: batch.kind, weight: batch.weight }))).total, 32)
  for (let index = 0; index < 4; index++) {
    const requestId = `fine-repeat-${index}`
    const prepared = await adapter.requestAdapter.prepare({ ...request(f, requestId, index), quota: 8 })
    const prompt = prepared.messages.find(message => message.role === 'user')!.content
    assert.ok(prompt.includes(`本次证据批次为 ${index + 1}/4`))
    await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal })
    const dispatched = adapter.metadata().find(row => row.requestId === requestId)!
    assert.equal(dispatched.manifest.requiredIds.length, f.ids.length)
    assert.ok(f.ids.every(id => dispatched.manifest.packedIds.includes(id)))
    assert.ok(f.ids.every(id => dispatched.manifest.requiredIds.includes(id)))
  }
  const firstManifest = adapter.metadata()[0].manifest.manifestHash
  adapter.requestAdapter.acceptQuestion({ requestId: 'fine-repeat-0', rawQuestion: { evidenceIds: [f.ids[0]] }, question: { id: 'prior-question', question: 'How does the selected component behave?', answer: 'PRIOR_ANSWER_MUST_NEVER_BE_COPIED', followUps: [] } })
  const secondPrepared = await adapter.requestAdapter.prepare({ ...request(f, 'fine-repeat-prior', 1), quota: 8 })
  const secondPrompt = secondPrepared.messages.find(message => message.role === 'user')!.content
  assert.ok(secondPrompt.includes('How does the selected component behave?'))
  assert.ok(!secondPrompt.includes('PRIOR_ANSWER_MUST_NEVER_BE_COPIED'))
  const metadataJson = JSON.stringify(adapter.metadata())
  assert.ok(!metadataJson.includes('How does the selected component behave?') && !metadataJson.includes('PRIOR_ANSWER_MUST_NEVER_BE_COPIED'))
  await adapter.requestAdapter.complete(secondPrepared, () => undefined, { signal: f.signal })
  assert.notEqual(adapter.metadata().at(-1)?.manifest.manifestHash, firstManifest)

  const coarseSpec = specFor(f, 'coarse', 1)
  const coarse = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), spec: coarseSpec, ledger: createBudgetLedger(coarseSpec) })
  const coarseBuilt = await coarse.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  assert.equal(coarseBuilt.batches.length, 1)
  assert.equal(planQuestionQuotas('coarse', coarseBuilt.batches.map(batch => ({ label: batch.label, kind: batch.kind, weight: batch.weight }))).total, 10)
})

test('topic-card and static-control writers keep identical evidence manifests and both finalize legal sidecars', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
    options.beforeRequest?.()
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  }
  const variants = [EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards, EVIDENCE_GENERATION_WRITER_VARIANTS.staticControl] as const
  const sidecars = []
  const manifests = []
  const dispatchedPrompts = new Map<typeof variants[number], string[]>()
  let candidatePrompt = ''
  let controlPrompt = ''
  for (const writerVariant of variants) {
    const spec = specFor(f, 'coarse')
    const sent: string[] = []
    const captureTransport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
      options.beforeRequest?.()
      sent.push(JSON.stringify(messages))
      const inputTokens = estimateMessageTokens(messages)
      options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
      return '{}'
    }
    const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, captureTransport), spec, writerVariant })
    assert.equal(adapter.writerVersion, EVIDENCE_GENERATION_WRITER_VERSION)
    assert.equal(adapter.writerVariant, writerVariant)
    await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
    const requestId = `writer-${writerVariant}`
    const prepared = await adapter.requestAdapter.prepare(request(f, requestId))
    const prompt = prepared.messages.find(message => message.role === 'user')!.content
    assert.ok(prompt.includes('为每道新问题添加 evidenceIds 数组'))
    assert.ok(prompt.includes('本次证据批次为 1/1'))
    if (writerVariant === EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards) {
      candidatePrompt = prompt
      assert.ok(prompt.includes('选题卡（不可信规划提示'))
      assert.ok(prompt.includes('Topic 0'))
    } else {
      controlPrompt = prompt
      assert.ok(!prompt.includes('选题卡（不可信规划提示'))
      assert.ok(!prompt.includes('Topic 0'))
    }
    await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal })
    for (const [index, stage] of (['repair', 'compensation'] as const).entries()) {
      const recovery = await adapter.requestAdapter.prepare(request(f, `writer-${writerVariant}-${stage}`, 0, stage))
      await adapter.requestAdapter.complete(recovery, () => undefined, { signal: f.signal })
      assert.ok(sent[index + 1].includes('每道新问题的主答案控制在 150–220 字'))
      assert.ok(sent[index + 1].includes('追问内部的 followUps 默认输出空数组'))
    }
    assert.equal(sent.length, 3)
    assert.ok(sent.every(body => body.includes('每道新问题的主答案控制在 150–220 字') && body.includes('每个追问答案控制在 50–80 字')))
    dispatchedPrompts.set(writerVariant, sent.map(body => {
      const messages = JSON.parse(body) as Array<{ role: string; content: string }>
      return messages.find(message => message.role === 'user')!.content
    }))
    const manifest = adapter.metadata()[0].manifest
    manifests.push(manifest)
    const questions = Array.from({ length: 8 }, (_, index) => question(`writer-q-${index}`, index))
    for (const [index, item] of questions.entries()) adapter.requestAdapter.acceptQuestion({ requestId, rawQuestion: { evidenceIds: [manifest.packedIds[index % manifest.packedIds.length]] }, question: item })
    sidecars.push(await adapter.finalize(result(f, questions)))
  }
  const candidateDispatched = dispatchedPrompts.get(EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards)!
  const controlDispatched = dispatchedPrompts.get(EVIDENCE_GENERATION_WRITER_VARIANTS.staticControl)!
  assert.equal(candidateDispatched.length, 3)
  assert.equal(controlDispatched.length, 3)
  for (let index = 0; index < candidateDispatched.length; index++) {
    const candidateCommon = candidateDispatched[index].slice(0, candidateDispatched[index].indexOf('\n\n## 选题卡'))
    const controlCommon = controlDispatched[index].slice(0, controlDispatched[index].indexOf('\n\n## 未解决事项'))
    assert.equal(candidateCommon, controlCommon, `shared initial/repair/compensation guidance at dispatch ${index}`)
    assert.ok(candidateDispatched[index].includes('## 选题卡（不可信规划提示'))
  }
  assert.ok(candidatePrompt.includes('为每道新问题添加 evidenceIds 数组') && controlPrompt.includes('为每道新问题添加 evidenceIds 数组'))
  for (const key of ['selectedIds', 'requiredIds', 'packedIds', 'omitted', 'sources'] as const) assert.deepEqual(manifests[0][key], manifests[1][key])
  assert.deepEqual(sidecars[0].questions.map(item => item.evidenceIds), sidecars[1].questions.map(item => item.evidenceIds))
  assert.ok(sidecars.every(sidecar => sidecar.questions.length === 8 && sidecar.questions.every(item => item.verification === 'source-bound-unverified')))

  for (const invalidVariant of ['third-writer', null]) {
    let resolved = 0
    const countedStore = { ...f.store, async resolve(...args: Parameters<typeof f.store.resolve>) { resolved++; return f.store.resolve(...args) } }
    await assert.rejects(createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), store: countedStore, writerVariant: invalidVariant as never }), (error: unknown) => error instanceof WorkflowError && error.code === 'invalid-argument')
    assert.equal(resolved, 0)
  }
})

test('accepts M06 Unicode topic labels, 100 refs, 17 long needs, and carries merged unresolved gaps only in both prompts', async t => {
  const f = await manyEvidenceFixture(100)
  t.after(f.cleanup)
  const topic = { id: '故障恢复/控制流', title: '关键状态转换', mechanism: '逐段追踪状态', valueRationale: '边界场景有证据', difficulty: 'advanced' as const, evidenceIds: f.ids, evidenceNeeds: Array.from({ length: 17 }, (_, index) => `need-${String(index).padStart(2, '0')}`), unconfirmed: [] as string[] }
  const selectedGaps = Array.from({ length: 40 }, (_, index) => `selection-gap-${index}`)
  const finishedGaps = Array.from({ length: 40 }, (_, index) => `finish-gap-${index}`)
  const investigationReply = JSON.stringify({ actions: [
    { type: 'propose_topics', topics: [topic] },
    { type: 'select_evidence', selection: { selectedIds: f.ids, requiredBundles: [], unresolved: selectedGaps } },
    { type: 'finish_investigation', unresolved: finishedGaps }
  ] })
  const ledger = createBudgetLedger(f.spec)
  const investigationModel = createModelGateway(f.spec, f.profile, ledger, { transport: async (_profile, messages, _onDelta, options) => {
    options.beforeRequest?.()
    const inputTokens = estimateMessageTokens(messages)
    const outputTokens = estimateMessageTokens([{ role: 'assistant', content: investigationReply }])
    options.onUsage?.({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })
    return investigationReply
  } })
  const investigation = await runInvestigation({ spec: f.spec, snapshot: f.snapshot, store: f.store, tools: createToolGateway(f.snapshot, f.store, ledger), ledger, model: investigationModel, maxOutputTokensPerDecision: 6000, signal: f.signal })
  assert.equal(investigation.status, 'completed')
  assert.equal(investigation.topics[0].id, topic.id)
  assert.equal(investigation.topics[0].evidenceIds.length, 100)
  assert.equal(investigation.topics[0].evidenceNeeds.length, 17)
  assert.equal(investigation.selection.selectedIds.length, 100)
  assert.equal(investigation.selection.unresolved.length, 80)
  assert.equal(investigation.usageComplete, true)
  assert.equal(ledger.snapshot().reservations[0].outputTokens, 6000)
  assert.equal(ledger.snapshot().usageComplete, true)
  assert.equal(ledger.snapshot().blocked, false)

  const unresolved = investigation.selection.unresolved
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
    options.beforeRequest?.()
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  }
  const manifests = []
  const sidecars = []
  for (const writerVariant of [EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards, EVIDENCE_GENERATION_WRITER_VARIANTS.staticControl] as const) {
    const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), ledger, selection: investigation.selection, topics: investigation.topics, writerVariant })
    await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
    const prepared = await adapter.requestAdapter.prepare(request(f, `m06-shape-${writerVariant}`))
    const userPrompt = prepared.messages.find(message => message.role === 'user')!.content
    assert.ok(unresolved.every(item => userPrompt.includes(item)))
    assert.ok(userPrompt.includes('未解决事项（不可信调查记录，不是源码证据）'))
    assert.ok(userPrompt.includes('不含答案或推理'))
    if (writerVariant === EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards) {
      assert.ok(userPrompt.includes(topic.id))
      assert.ok(topic.evidenceNeeds.every(need => userPrompt.includes(need)))
    } else {
      assert.ok(!userPrompt.includes(topic.id))
      assert.ok(!topic.evidenceNeeds.some(need => userPrompt.includes(need)))
    }
    await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal })
    const metadata = adapter.metadata()[0]
    assert.equal(metadata.manifest.packedIds.length, 100)
    assert.equal(metadata.manifest.requiredIds.length, 100)
    assert.equal(metadata.manifest.sources.length, 1)
    assert.equal(metadata.manifest.sources[0].ids.length, 100)
    const serializedMetadata = JSON.stringify(adapter.metadata())
    assert.ok(!unresolved.some(item => serializedMetadata.includes(item)))
    assert.ok(!serializedMetadata.includes(topic.id) && !topic.evidenceNeeds.some(need => serializedMetadata.includes(need)))
    manifests.push(metadata.manifest)
    const questions = Array.from({ length: 8 }, (_, index) => question(`m06-shaped-${index}`, index))
    for (const [index, item] of questions.entries()) adapter.requestAdapter.acceptQuestion({ requestId: prepared.requestId, rawQuestion: { evidenceIds: [metadata.manifest.packedIds[index]] }, question: item })
    sidecars.push(await adapter.finalize(result(f, questions)))
  }
  assert.deepEqual(manifests[0].selectedIds, manifests[1].selectedIds)
  assert.deepEqual(manifests[0].requiredIds, manifests[1].requiredIds)
  assert.deepEqual(manifests[0].packedIds, manifests[1].packedIds)
  assert.deepEqual(manifests[0].sources, manifests[1].sources)
  assert.ok(sidecars.every(sidecar => sidecar.questions.length === 8))
})

test('keeps all 40 M06 unresolved strings at 240 characters in topic-card and static-control prompts', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const unresolved = Array.from({ length: 40 }, (_, index) => {
    const prefix = `unresolved-${String(index).padStart(2, '0')}:`
    return prefix + 'x'.repeat(240 - prefix.length)
  })
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
    options.beforeRequest?.()
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
    return '{}'
  }
  for (const writerVariant of [EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards, EVIDENCE_GENERATION_WRITER_VARIANTS.staticControl] as const) {
    const spec = specFor(f, 'coarse')
    const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), spec, ledger: createBudgetLedger(spec), selection: { selectedIds: f.ids, requiredBundles: [], unresolved } })
    await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
    const prepared = await adapter.requestAdapter.prepare(request(f, `forty-gaps-${writerVariant}`))
    const prompt = prepared.messages.find(message => message.role === 'user')!.content
    assert.ok(unresolved.every(item => prompt.includes(item)))
    await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal })
    assert.ok(!JSON.stringify(adapter.metadata()).includes(unresolved[0]))
  }
})

test('caps effective output reservation and wire limit by remaining global ledger output', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  for (const configuredMax of [32_768, 16_384]) {
    const { profile, spec } = specForOutput(f, configuredMax)
    const ledger = createBudgetLedger(spec)
    for (let index = 0; index < 4; index++) {
      const id = `prior-${configuredMax}-${index}`
      ledger.reserveModel({ id, stage: 'generation', inputTokens: 1, outputTokens: 10_000 })
      ledger.markDispatched(id)
      ledger.settleModel(id, { inputTokens: 1, outputTokens: 10_000, totalTokens: 10_001 })
    }
    assert.equal(ledger.snapshot().total.outputTokens, 40_000)
    const wireLimits: number[] = []
    const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
      wireLimits.push(options.maxOutputTokens!)
      options.beforeRequest?.()
      const inputTokens = estimateMessageTokens(messages)
      options.onUsage?.({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 })
      return '{}'
    }
    const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), profile, spec, ledger })
    await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
    const prepared = await adapter.requestAdapter.prepare(request(f, `remaining-output-${configuredMax}`))
    await adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal, maxOutputTokens: configuredMax })
    const expected = Math.min(configuredMax, spec.generationOutputTokens, profile.maxOutputTokens!, 65_536 - 40_000)
    assert.equal(wireLimits[0], expected)
    assert.equal(ledger.snapshot().reservations.find(item => item.id === prepared.requestId)?.outputTokens, expected)
  }
})

test('zero remaining output tokens reject before fetch without inventing a reservation', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const { profile, spec } = specForOutput(f, 32_768)
  const ledger = createBudgetLedger(spec)
  for (let index = 0; index < 4; index++) {
    const id = `exhaust-${index}`
    ledger.reserveModel({ id, stage: 'generation', inputTokens: 1, outputTokens: 16_384 })
    ledger.markDispatched(id)
    ledger.settleModel(id, { inputTokens: 1, outputTokens: 16_384, totalTokens: 16_385 })
  }
  assert.equal(ledger.snapshot().remaining.outputTokens, 0)
  let fetches = 0
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, _messages, _onDelta, options) => { fetches++; options.beforeRequest?.(); return '{}' }
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), profile, spec, ledger })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare(request(f, 'empty-output-budget'))
  await assert.rejects(adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal, maxOutputTokens: profile.maxOutputTokens }), (error: unknown) => error instanceof WorkflowError && error.code === 'budget-exhausted')
  assert.equal(fetches, 0)
  assert.deepEqual(adapter.metadata(), [])
})

test('dispatch uses captured profile, settles a repair against the same ledger and finalizes a secret-free sidecar', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const sent: string[] = []
  let calls = 0
  let requestNotifications = 0
  const usageNotifications: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = []
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (profile, messages, onDelta, options) => {
    assert.equal(options.maxStreamBodyBytes, Math.max(LLM_RESPONSE_LIMITS.chatBodyBytes, Math.min(LLM_RESPONSE_LIMITS.maxStreamBodyBytes, options.maxOutputTokens! * 1024)))
    options.beforeRequest?.()
    calls++
    sent.push(JSON.stringify(messages))
    const content = '{"synthetic":true}'
    onDelta(content)
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 })
    assert.equal(profile.apiKey, syntheticSecret)
    return content
  }
  const ledger = createBudgetLedger(f.spec)
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), ledger })
  f.profile.apiKey = 'MUTATED_AFTER_FACTORY'
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const generation = await adapter.requestAdapter.prepare(request(f, 'generation-1'))
  await adapter.requestAdapter.complete(generation, () => undefined, { signal: f.signal, onRequest: () => { requestNotifications++ }, onUsage: usage => usageNotifications.push(usage) })
  assert.throws(() => adapter.requestAdapter.acceptQuestion({ requestId: 'generation-1', rawQuestion: { evidenceIds: ['ev_00000000-0000-4000-8000-000000000000'] }, question: question('forged', 0) }), error => error instanceof CitationValidationError)
  const repair = await adapter.requestAdapter.prepare(request(f, 'repair-1', 0, 'repair'))
  await adapter.requestAdapter.complete(repair, () => undefined, { signal: f.signal, onRequest: () => { requestNotifications++ }, onUsage: usage => usageNotifications.push(usage) })
  for (let index = 0; index < 8; index++) adapter.requestAdapter.acceptQuestion({ requestId: 'repair-1', rawQuestion: { evidenceIds: [f.ids[index % f.ids.length]] }, question: question(`q-${index}`, index) })
  const finalized = await adapter.finalize(result(f, Array.from({ length: 8 }, (_, index) => question(`q-${index}`, index))))
  assert.equal(finalized.questions.length, 8)
  assert.equal(ledger.snapshot().byStage.generation.dispatchedRequests, 1)
  assert.equal(ledger.snapshot().byStage.repair.dispatchedRequests, 1)
  assert.equal(calls, 2)
  assert.equal(requestNotifications, 2)
  assert.equal(usageNotifications.length, 2)
  assert.ok(usageNotifications.every(usage => Number.isSafeInteger(usage.inputTokens) && usage.outputTokens === 10 && usage.totalTokens === usage.inputTokens + usage.outputTokens))
  assert.ok(sent.every(body => !body.includes(syntheticSecret)))
  const sidecar = JSON.stringify(finalized)
  assert.ok(!sidecar.includes(syntheticSecret) && !sidecar.includes('module0/file0.ts') && !sidecar.includes('export const component'))
  assert.equal(finalized.questions[0].verification, 'source-bound-unverified')
  assert.ok(finalized.questions.every(item => f.ids.includes(item.evidenceIds[0])))
  const metadata = adapter.metadata()
  assert.equal(metadata.length, 2)
  assert.ok(Object.isFrozen(metadata) && metadata.every(item => Object.isFrozen(item) && Object.isFrozen(item.manifest) && item.usage && item.completion === 'completed'))
  const repairMetadata = metadata.find(item => item.requestId === 'repair-1')!
  assert.equal(repairMetadata.stage, 'repair')
  assert.equal(repairMetadata.manifest.manifestHash, finalized.questions[0].manifestHash)
  assert.ok(finalized.questions.every(item => repairMetadata.manifest.packedIds.includes(item.evidenceIds[0])))
  const metadataJson = JSON.stringify(metadata)
  assert.ok(!metadataJson.includes(syntheticSecret) && !metadataJson.includes('export const component') && !metadataJson.includes('Use only this quoted source'))
})

test('missing usage receipt blocks subsequent requests and no unmetered result escapes', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  let calls = 0
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, _messages, _onDelta, options) => {
    options.beforeRequest?.()
    calls++
    return '{}'
  }
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), ledger: createBudgetLedger(f.spec) })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare(request(f, 'missing-usage-1'))
  await assert.rejects(adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal }), (error: unknown) => error instanceof WorkflowError && error.code === 'budget-exhausted')
  await assert.rejects(Promise.resolve(adapter.requestAdapter.prepare(request(f, 'missing-usage-2'))), (error: unknown) => error instanceof WorkflowError && error.code === 'budget-exhausted')
  assert.equal(calls, 1)
})

test('foreign or stale scan identity and blocking beforeRequest failure prevent transport calls', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  let calls = 0
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, _messages, _onDelta, options) => { options.beforeRequest?.(); calls++; return '{}' }
  await assert.rejects(createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), scan: { ...f.scan } }), (error: unknown) => error instanceof WorkflowError)
  const independentlyApproved = await scanProject(f.root)
  await assert.rejects(createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport), scan: independentlyApproved }), (error: unknown) => error instanceof WorkflowError)
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport) })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare(request(f, 'blocked-1'))
  const clonedPrepared = { ...prepared, messages: [...prepared.messages] }
  await assert.rejects(adapter.requestAdapter.complete(clonedPrepared, () => undefined, { signal: f.signal }), (error: unknown) => error instanceof WorkflowError)
  assert.throws(() => { (prepared.messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>)[1].content += ' tampered' })
  await assert.rejects(adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal, beforeRequest: () => { throw new WorkflowError('permission-denied') } }), (error: unknown) => error instanceof WorkflowError && error.code === 'permission-denied')
  assert.equal(calls, 0)
  assert.deepEqual(adapter.metadata(), [])

  await fs.writeFile(path.join(f.root, 'module0', 'file0.ts'), 'changed after snapshot\n', 'utf8')
  await assert.rejects(Promise.resolve(adapter.requestAdapter.prepare(request(f, 'stale-prepare-1'))), (error: unknown) => error instanceof WorkflowError && error.code === 'stale-snapshot')
  assert.equal(calls, 0)

  const other = await fixture('coarse')
  t.after(other.cleanup)
  const identityAdapter = await createEvidenceGenerationAdapter({ ...adapterInput(other, other.ids, transport) })
  other.scan.root = `${other.root}-mutated`
  await assert.rejects(identityAdapter.contextProvider.build(other.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: other.signal }), (error: unknown) => error instanceof WorkflowError)
  assert.equal(calls, 0)
})

test('redaction summaries are copied from actual M02 reads, once per file', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids) })
  const built = await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  assert.equal(built.contentSecurity.redactedFiles, f.ids.length)
  assert.equal(built.contentSecurity.redactionMatches, f.ids.length)
  assert.equal(built.contentSecurity.matchesByCategory['secret-assignment'], f.ids.length)
})

test('forwards only normalized settled usage before a post-response stale-snapshot failure', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const observed: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = []
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, messages, _onDelta, options) => {
    options.beforeRequest?.()
    const inputTokens = estimateMessageTokens(messages)
    options.onUsage?.({ inputTokens, outputTokens: 7, totalTokens: inputTokens + 7 })
    await fs.writeFile(path.join(f.root, 'module0', 'file0.ts'), 'changed while request was active\n', 'utf8')
    return '{}'
  }
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport) })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare(request(f, 'stale-after-response'))
  await assert.rejects(adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal, onUsage: usage => observed.push(usage) }), (error: unknown) => error instanceof WorkflowError && error.code === 'stale-snapshot')
  assert.equal(observed.length, 1)
  assert.ok(Number.isSafeInteger(observed[0].inputTokens) && observed[0].outputTokens === 7 && observed[0].totalTokens === observed[0].inputTokens + 7)
  assert.equal(adapter.metadata()[0].completion, 'completed')
  assert.deepEqual(adapter.metadata()[0].usage, observed[0])
})

test('malformed usage and a failed transport never escape through onUsage or the error message', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  const observed: unknown[] = []
  let calls = 0
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, _messages, _onDelta, options) => {
    options.beforeRequest?.()
    calls++
    options.onUsage?.({ inputTokens: Number.NaN, outputTokens: 12, totalTokens: 12 })
    throw new Error(`upstream included ${syntheticSecret}`)
  }
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport) })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare(request(f, 'malformed-usage'))
  await assert.rejects(adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal, onUsage: usage => observed.push(usage) }), (error: unknown) => error instanceof WorkflowError && error.message === 'Workflow operation rejected.' && !error.message.includes(syntheticSecret))
  assert.deepEqual(observed, [])
  assert.equal(calls, 1)
  assert.equal(adapter.metadata()[0].usage, null)
  assert.equal(adapter.metadata()[0].completion, 'failed')
})

test('dispatch guard rechecks cancellation and scan binding after the supplied blocking callback', async t => {
  const f = await fixture('coarse')
  t.after(f.cleanup)
  let calls = 0
  const transport: NonNullable<Parameters<typeof createEvidenceGenerationAdapter>[0]['transport']> = async (_profile, _messages, _onDelta, options) => { options.beforeRequest?.(); calls++; return '{}' }
  const adapter = await createEvidenceGenerationAdapter({ ...adapterInput(f, f.ids, transport) })
  await adapter.contextProvider.build(f.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: f.signal })
  const prepared = await adapter.requestAdapter.prepare(request(f, 'guard-mutation'))
  await assert.rejects(adapter.requestAdapter.complete(prepared, () => undefined, { signal: f.signal, beforeRequest: () => { f.scan.name = 'mutated-after-admission' } }), (error: unknown) => error instanceof WorkflowError && error.code === 'stale-snapshot')
  assert.equal(calls, 0)
  assert.deepEqual(adapter.metadata(), [])

  const aborted = await fixture('coarse')
  t.after(aborted.cleanup)
  const abortAdapter = await createEvidenceGenerationAdapter({ ...adapterInput(aborted, aborted.ids, transport) })
  await abortAdapter.contextProvider.build(aborted.scan, 'coarse', { maxChars: 40_000, roleFocus: 'backend', signal: aborted.signal })
  const abortPrepared = await abortAdapter.requestAdapter.prepare(request(aborted, 'guard-abort'))
  await assert.rejects(abortAdapter.requestAdapter.complete(abortPrepared, () => undefined, { signal: aborted.signal, beforeRequest: aborted.abort }), (error: unknown) => error instanceof WorkflowError && error.code === 'cancelled')
  assert.equal(calls, 0)
})
