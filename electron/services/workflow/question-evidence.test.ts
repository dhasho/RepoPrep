import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import type { InterviewResult, QuestionItem } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { createQuestionEvidenceRegistry } from './question-evidence.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { packEvidence } from './evidence-packer.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { WorkflowError } from './project-contract.ts'

const sourceText = 'export const answer = 42\n'
const profile = { id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'DO_NOT_COPY_SECRET', model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49152, maxOutputTokens: 4096 }
const makeSpec = (snapshotId = 'snapshot-01', granularity: 'coarse' | 'medium' | 'fine' = 'fine', maxModelRequests?: number) => createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity, model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', ...(maxModelRequests !== undefined ? { budget: { maxModelRequests } } : {}) })
const buildMessages = (contextText: string) => [{ role: 'system' as const, content: 'System.' }, { role: 'user' as const, content: `Quoted source:\n${contextText}` }]

async function packedFixture(snapshotId = 'snapshot-01') {
  const capabilities = new WeakSet<object>()
  const snapshot = {
    projectId: 'project-01', snapshotId, policyVersion: 'fixture-policy',
    files: Object.freeze([{ fileId: 'file-01', relPath: 'src/answer.ts', byteLength: Buffer.byteLength(sourceText), sourceKind: 'code' as const }]),
    summary: Object.freeze({ name: 'fixture', totalFiles: 1, contentFileCount: 1, truncated: false }),
    async assertCurrent() {}, async readFile() { throw new WorkflowError('unreadable') },
    ownsRead(value: unknown): value is never { return typeof value === 'object' && value !== null && capabilities.has(value) }
  }
  const store = createEvidenceStore(snapshot)
  const read = Object.freeze({ snapshotId, fileId: 'file-01', relPath: 'src/answer.ts', sourceKind: 'code' as const, text: sourceText, contentHash: createHash('sha256').update(sourceText).digest('hex'), readBytes: Buffer.byteLength(sourceText), lineMapping: 'preserved' as const, redactionVersion: 'fixture-redaction-v1', parserVersion: 'fixture-parser-v1', analysis: null, indexStatus: 'unavailable' as const })
  capabilities.add(read)
  const evidence = await store.issue(read, { startLine: 1, endLine: 1 })
  const evidenceId = evidence[0].id
  const result = await packEvidence({ spec: makeSpec(snapshotId), store, selection: { selectedIds: [evidenceId], requiredBundles: [], unresolved: [] }, buildMessages })
  assert.equal(result.status, 'packed')
  if (result.status !== 'packed') throw new Error('fixture packing failed')
  return { evidenceId, context: result.context }
}

function question(id: string, overrides: Partial<QuestionItem> = {}): QuestionItem {
  return { id, question: 'Why does [[value]] work?', answer: 'It returns the result.', followUps: [{ question: 'What if null?', answer: 'Handle it.' }], ...overrides }
}
function result(questions: QuestionItem[]): InterviewResult {
  return { version: 2, createdAt: '2026-11-07T00:00:00.000Z', projectName: 'fixture', projectPath: 'C:\\fixture', granularity: 'fine', roleFocus: 'backend', profileId: 'profile-01', modelUsed: 'synthetic', projectSummary: '', sections: [{ id: 'section-01', title: 'Runtime', questions }], glossary: {} }
}
function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof WorkflowError && error.code === code && error.message === 'Workflow operation rejected.')
}
function resignManifest(manifest: Awaited<ReturnType<typeof packedFixture>>['context']['manifest'], overrides: Record<string, unknown>) {
  const unsigned = { ...manifest, ...overrides } as typeof manifest
  const { manifestHash: _ignored, ...payload } = unsigned
  return { ...unsigned, manifestHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
}

test('registry binds exact packed IDs and emits only immutable source-bound metadata', async () => {
  const { context, evidenceId } = await packedFixture()
  const registry = createQuestionEvidenceRegistry(makeSpec())
  registry.registerRequest('generation-1', context)
  const accepted = question('program-id-1')
  const raw = { id: 'model-controlled-id', evidenceIds: [evidenceId], answer: 'NEVER COPY RAW ANSWER' }
  registry.capture({ requestId: 'generation-1', rawQuestion: raw, question: accepted })
  const sidecar = registry.finalize(result([accepted]))
  assert.deepEqual(sidecar.questions.map(item => ({ ...item })), [{ questionId: 'program-id-1', questionFingerprint: sidecar.questions[0].questionFingerprint, requestId: 'generation-1', manifestHash: context.manifest.manifestHash, evidenceIds: [evidenceId], verification: 'source-bound-unverified' }])
  assert.equal(sidecar.runId, 'run-01')
  assert.equal(Object.isFrozen(sidecar) && Object.isFrozen(sidecar.questions) && Object.isFrozen(sidecar.questions[0]) && Object.isFrozen(sidecar.questions[0].evidenceIds), true)
  const serialized = JSON.stringify(sidecar)
  assert.ok(!serialized.includes(sourceText) && !serialized.includes('src/answer.ts') && !serialized.includes('NEVER COPY RAW ANSWER') && !serialized.includes('DO_NOT_COPY_SECRET') && !serialized.includes('model-controlled-id'))
  ;(raw.evidenceIds as string[]).push('later-mutation')
  assert.deepEqual(sidecar.questions[0].evidenceIds, [evidenceId])
  assert.throws(() => { (sidecar.questions[0].evidenceIds as string[]).push('mutate') })
})

test('rejects unregistered requests, wrong snapshot manifests, forged, stale and unpacked references', async () => {
  const { context, evidenceId } = await packedFixture()
  const registry = createQuestionEvidenceRegistry(makeSpec())
  expectCode(() => registry.registerRequest('request-1', awaitableManifest(context)), 'unknown-evidence')
  registry.registerRequest('request-1', context)
  expectCode(() => registry.capture({ requestId: 'request-2', rawQuestion: { evidenceIds: [evidenceId] }, question: question('q1') }), 'unknown-evidence')
  expectCode(() => registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: ['forged-evidence-id'] }, question: question('q1') }), 'unknown-evidence')
  expectCode(() => registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: [evidenceId, evidenceId] }, question: question('q1') }), 'unknown-evidence')
  expectCode(() => registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: Array.from({ length: 17 }, () => evidenceId) }, question: question('q1') }), 'unknown-evidence')

  const other = await packedFixture('snapshot-other')
  expectCode(() => createQuestionEvidenceRegistry(makeSpec()).registerRequest('request-1', other.context), 'unknown-evidence')
})

test('rejects consistently hashed manifests with non-evidence IDs or packed IDs outside selection', async () => {
  const { context } = await packedFixture()
  const fabricatedId = resignManifest(context.manifest, { selectedIds: ['fabricated'], packedIds: ['fabricated'], requiredIds: [] })
  expectCode(() => createQuestionEvidenceRegistry(makeSpec()).registerRequest('request-1', fabricatedId), 'unknown-evidence')

  const unselectedPackedId = resignManifest(context.manifest, { selectedIds: [], requiredIds: [] })
  expectCode(() => createQuestionEvidenceRegistry(makeSpec()).registerRequest('request-1', unselectedPackedId), 'unknown-evidence')
})

function awaitableManifest(context: Awaited<ReturnType<typeof packedFixture>>['context']) {
  return { ...context.manifest, snapshotId: 'snapshot-other' }
}

test('finalization retains only surviving accepted IDs and fingerprints final normalized content', async () => {
  const { context, evidenceId } = await packedFixture()
  const registry = createQuestionEvidenceRegistry(makeSpec())
  registry.registerRequest('request-1', context)
  registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: [evidenceId] }, question: question('kept') })
  registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: [evidenceId] }, question: question('dedup-dropped') })
  const finalQuestion = question('kept', { question: 'Why does value work?' })
  const sidecar = registry.finalize(result([finalQuestion]))
  assert.deepEqual(sidecar.questions.map(item => item.questionId), ['kept'])
  const recomputed = createQuestionEvidenceRegistry(makeSpec())
  recomputed.registerRequest('request-1', context)
  recomputed.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: [evidenceId] }, question: finalQuestion })
  assert.equal(sidecar.questions[0].questionFingerprint, recomputed.finalize(result([finalQuestion])).questions[0].questionFingerprint)
  assert.equal(sidecar.questions.length, 1)
})

test('rejects duplicate and conflicting bindings, duplicate final IDs and surviving questions without bindings', async () => {
  const { context, evidenceId } = await packedFixture()
  const registry = createQuestionEvidenceRegistry(makeSpec())
  registry.registerRequest('request-1', context)
  registry.registerRequest('request-2', context)
  registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: [evidenceId] }, question: question('q1') })
  expectCode(() => registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: [evidenceId] }, question: question('q1') }), 'invalid-argument')
  expectCode(() => registry.capture({ requestId: 'request-2', rawQuestion: { evidenceIds: [evidenceId] }, question: question('q1') }), 'invalid-argument')
  expectCode(() => registry.finalize(result([question('q1'), question('q1')])), 'invalid-argument')

  const missing = createQuestionEvidenceRegistry(makeSpec())
  expectCode(() => missing.finalize(result([question('q2')])), 'unknown-evidence')
})

test('request registrations are bounded by the immutable RunSpec budget', async () => {
  const { context } = await packedFixture()
  const tinySpec = createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { maxModelRequests: 1 } })
  const registry = createQuestionEvidenceRegistry(tinySpec)
  registry.registerRequest('request-1', context)
  expectCode(() => registry.registerRequest('request-2', context), 'invalid-argument')
})

test('one coarse model request can bind ten accepted questions within its question budget', async () => {
  const { context, evidenceId } = await packedFixture()
  const registry = createQuestionEvidenceRegistry(makeSpec('snapshot-01', 'coarse', 1))
  registry.registerRequest('request-1', context)
  const questions = Array.from({ length: 10 }, (_, index) => question(`coarse-${index + 1}`, { question: `Question number ${index + 1}?` }))
  for (const item of questions) registry.capture({ requestId: 'request-1', rawQuestion: { evidenceIds: [evidenceId] }, question: item })
  assert.equal(registry.finalize(result(questions)).questions.length, 10)
})
