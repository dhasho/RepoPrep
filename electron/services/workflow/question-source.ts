import { randomUUID } from 'node:crypto'
import type { QuestionItem } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { assertPackedDispatch, packEvidence, type PackedContext } from './evidence-packer.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { fingerprintQuestion, type QuestionEvidenceEntry, type QuestionEvidenceSidecar } from './question-evidence.ts'
import type { BudgetLedger, ModelStage } from './budget-ledger.ts'
import type { RunSpec } from './run-spec.ts'
import type { LineRange, WorkflowEvidenceStore, WorkflowProjectSnapshot } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { ownsGenerationSourceRecorder } from './evidence-generation.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { validateSingleQuestionEvaluationInput } from './question-patch.ts'

/** Opaque process capability. Its enumerable shape never authorizes a source. */
export interface QuestionSourceCapability { readonly kind: 'question-source' }
export type QuestionSourceOrigin = 'completed-generation' | 'frozen-evaluation-input'
export interface QuestionSourceDescription {
  readonly version: 1
  readonly origin: QuestionSourceOrigin
  readonly verification: 'source-bound-unverified' | 'imported-input-unverified'
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly questionId: string
  readonly questionFingerprint: string
  /** Null for imported evaluation inputs; no generation receipt is invented. */
  readonly requestId: string | null
  readonly requestHash: string
  readonly manifestHash: string
  readonly evidenceIds: readonly string[]
}

export interface QuestionSourceAuthorityInput {
  readonly spec: RunSpec
  readonly ledger: BudgetLedger
  readonly snapshot: WorkflowProjectSnapshot
  readonly store: WorkflowEvidenceStore
  readonly signal: AbortSignal
}

/** Main-process-only references; consumers must reuse this exact ledger and source. */
export interface QuestionSourceAuthority extends QuestionSourceAuthorityInput {
  describe(source: unknown, question: QuestionItem): QuestionSourceDescription
  assertCurrent(source: unknown, question: QuestionItem, signal?: AbortSignal): Promise<QuestionSourceDescription>
}

interface Dispatch {
  readonly packet: PackedContext
  readonly stage: ModelStage
  state: 'pending' | 'completed' | 'failed'
}
interface Binding {
  readonly authority: QuestionSourceAuthority
  readonly description: QuestionSourceDescription
  readonly packet: PackedContext
  readonly dispatch?: Dispatch
}
const capabilities = new WeakMap<object, Binding>()
const authorities = new WeakSet<object>()
export function assertQuestionSourceAuthority(value: unknown): asserts value is QuestionSourceAuthority {
  if (!value || typeof value !== 'object' || !authorities.has(value)) fail('unknown-evidence')
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EVIDENCE_ID = /^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[a-f0-9]{64}$/
function fail(code: ConstructorParameters<typeof WorkflowError>[0] = 'unknown-evidence'): never { throw new WorkflowError(code) }
function checkCurrent(input: QuestionSourceAuthorityInput, signal?: AbortSignal): void {
  if (input.signal.aborted || signal?.aborted) fail('cancelled')
  if (input.snapshot.projectId !== input.spec.projectId || input.snapshot.snapshotId !== input.spec.snapshotId) fail('stale-snapshot')
}
function assertHealthyLedger(ledger: BudgetLedger): void {
  const meter = ledger.snapshot()
  if (!meter.usageComplete || meter.blocked || meter.overspend.inputTokens || meter.overspend.outputTokens || meter.overspend.readBytes) fail('budget-exhausted')
}
function assertReceipt(authority: QuestionSourceAuthority, dispatch: Dispatch, requestId: string): void {
  assertHealthyLedger(authority.ledger)
  const receipt = authority.ledger.snapshot().reservations.find(item => item.id === requestId)
  if (dispatch.state !== 'completed' || !receipt || receipt.stage !== dispatch.stage || receipt.state !== 'settled' || !receipt.usage || receipt.contextChars !== dispatch.packet.manifest.contextChars || receipt.usage.totalTokens !== receipt.usage.inputTokens + receipt.usage.outputTokens) fail()
}
function frozenTree(value: unknown, depth = 0): boolean {
  if (depth > 12 || !value || typeof value !== 'object') return depth <= 12
  return Object.isFrozen(value) && Object.values(value).every(child => frozenTree(child, depth + 1))
}
function assertPacket(input: QuestionSourceAuthorityInput, packet: PackedContext): void {
  if (!packet || !frozenTree(packet) || packet.manifest.runId !== input.spec.runId || packet.manifest.projectId !== input.spec.projectId || packet.manifest.snapshotId !== input.spec.snapshotId || !HASH.test(packet.manifest.requestHash) || !HASH.test(packet.manifest.manifestHash) || !packet.manifest.packedIds.length || packet.manifest.packedIds.length > 4096 || packet.manifest.packedIds.some(id => !EVIDENCE_ID.test(id)) || new Set(packet.manifest.packedIds).size !== packet.manifest.packedIds.length) fail()
  assertPackedDispatch(packet, packet.messages)
}
async function assertIssuedPacket(input: QuestionSourceAuthorityInput, packet: PackedContext, signal?: AbortSignal): Promise<void> {
  checkCurrent(input, signal)
  assertPacket(input, packet)
  const records = await input.store.resolve(packet.manifest.packedIds, input.spec.snapshotId, input.signal)
  checkCurrent(input, signal)
  if (records.length !== packet.manifest.packedIds.length || records.some(record => record.snapshotId !== input.spec.snapshotId || !packet.manifest.packedIds.includes(record.id))) fail()
  const sourceIds = packet.manifest.sources.flatMap(source => [...source.ids])
  if (sourceIds.length !== records.length || new Set(sourceIds).size !== records.length || records.some(record => !sourceIds.includes(record.id))) fail()
  for (const source of packet.manifest.sources) {
    const members = records.filter(record => source.ids.includes(record.id))
    if (!members.length || members.some(record => record.fileId !== source.fileId || record.relPath !== source.relPath || record.sourceKind !== source.sourceKind || record.displayRange.startLine < source.displayRange.startLine || record.displayRange.endLine > source.displayRange.endLine)) fail()
  }
}
function createAuthority(input: QuestionSourceAuthorityInput): QuestionSourceAuthority {
  if (!input?.spec || input.spec.version !== 1 || !Object.isFrozen(input.spec) || !input.ledger || !input.snapshot || !input.store || !input.signal || ![input.spec.runId, input.spec.projectId, input.spec.snapshotId].every(id => typeof id === 'string' && ID.test(id))) fail('invalid-argument')
  checkCurrent(input)
  const captured = Object.freeze({ spec: input.spec, ledger: input.ledger, snapshot: input.snapshot, store: input.store, signal: input.signal })
  let authority: QuestionSourceAuthority
  const bindingFor = (source: unknown, question: QuestionItem, signal?: AbortSignal): Binding => {
    checkCurrent(captured, signal)
    assertHealthyLedger(captured.ledger)
    const binding = source && typeof source === 'object' ? capabilities.get(source) : undefined
    if (!binding || binding.authority !== authority || !question || question.id !== binding.description.questionId || fingerprintQuestion(question) !== binding.description.questionFingerprint) fail()
    if (binding.dispatch) assertReceipt(authority, binding.dispatch, binding.description.requestId!)
    return binding
  }
  authority = Object.freeze({
    ...captured,
    describe(source: unknown, question: QuestionItem): QuestionSourceDescription {
      if (this !== authority) fail()
      return bindingFor(source, question).description
    },
    async assertCurrent(source: unknown, question: QuestionItem, signal?: AbortSignal): Promise<QuestionSourceDescription> {
      if (this !== authority) fail()
      const binding = bindingFor(source, question, signal)
      await captured.snapshot.assertCurrent(captured.signal)
      bindingFor(source, question, signal)
      await assertIssuedPacket(captured, binding.packet, signal)
      await captured.snapshot.assertCurrent(captured.signal)
      return bindingFor(source, question, signal).description
    }
  })
  authorities.add(authority)
  return authority
}
function issue(authority: QuestionSourceAuthority, question: QuestionItem, packet: PackedContext, origin: QuestionSourceOrigin, evidenceIds: readonly string[], requestId: string | null, dispatch?: Dispatch): QuestionSourceCapability {
  if (!ID.test(question.id) || evidenceIds.length < 1 || evidenceIds.length > 16 || evidenceIds.some(id => !EVIDENCE_ID.test(id) || !packet.manifest.packedIds.includes(id)) || new Set(evidenceIds).size !== evidenceIds.length) fail()
  const description: QuestionSourceDescription = Object.freeze({
    version: 1, origin, verification: origin === 'completed-generation' ? 'source-bound-unverified' : 'imported-input-unverified',
    runId: authority.spec.runId, projectId: authority.spec.projectId, snapshotId: authority.spec.snapshotId,
    questionId: question.id, questionFingerprint: fingerprintQuestion(question), requestId,
    requestHash: packet.manifest.requestHash, manifestHash: packet.manifest.manifestHash, evidenceIds: Object.freeze([...evidenceIds])
  })
  const source = Object.freeze({ kind: 'question-source' as const })
  capabilities.set(source, Object.freeze({ authority, description, packet, ...(dispatch ? { dispatch } : {}) }))
  return source
}

/** @internal The generation adapter retains this recorder; downstream receives only authority/sourceFor. */
export function createGenerationQuestionSourceRecorder(input: QuestionSourceAuthorityInput, owner: unknown) {
  if (!ownsGenerationSourceRecorder(owner, input)) fail('permission-denied')
  const authority = createAuthority(input)
  const dispatches = new Map<string, Dispatch>()
  const accepted = new Map<string, Readonly<{ requestId: string; fingerprint: string; evidenceIds: readonly string[] }>>()
  const finalized = new Map<string, QuestionEvidenceEntry>()
  let isFinalized = false
  return Object.freeze({
    authority,
    recordDispatch(requestId: string, packet: PackedContext, stage: ModelStage): void {
      checkCurrent(authority)
      if (isFinalized || !ID.test(requestId) || dispatches.has(requestId) || dispatches.size >= authority.spec.budget.total.maxModelRequests) fail()
      assertPacket(authority, packet)
      dispatches.set(requestId, { packet, stage, state: 'pending' })
    },
    completeDispatch(requestId: string): void {
      const dispatch = dispatches.get(requestId)
      if (!dispatch || dispatch.state !== 'pending') fail()
      dispatch.state = 'completed'
    },
    failDispatch(requestId: string): void { const dispatch = dispatches.get(requestId); if (dispatch) dispatch.state = 'failed' },
    capture(requestId: string, question: QuestionItem, evidenceIds: readonly string[]): void {
      if (isFinalized || accepted.has(question.id)) fail()
      accepted.set(question.id, Object.freeze({ requestId, fingerprint: fingerprintQuestion(question), evidenceIds: Object.freeze([...evidenceIds]) }))
    },
    finalize(sidecar: QuestionEvidenceSidecar): void {
      if (isFinalized || sidecar.runId !== authority.spec.runId || sidecar.projectId !== authority.spec.projectId || sidecar.snapshotId !== authority.spec.snapshotId) fail()
      isFinalized = true
      for (const entry of sidecar.questions) finalized.set(entry.questionId, entry)
    },
    async sourceFor(question: QuestionItem): Promise<QuestionSourceCapability> {
      checkCurrent(authority)
      if (!isFinalized) fail()
      const entry = finalized.get(question.id)
      const captured = accepted.get(question.id)
      const dispatch = entry ? dispatches.get(entry.requestId) : undefined
      if (!entry || !captured || !dispatch || entry.questionFingerprint !== fingerprintQuestion(question) || captured.fingerprint !== entry.questionFingerprint || captured.requestId !== entry.requestId || captured.evidenceIds.join('\0') !== entry.evidenceIds.join('\0') || entry.manifestHash !== dispatch.packet.manifest.manifestHash) fail()
      assertReceipt(authority, dispatch, entry.requestId)
      await authority.snapshot.assertCurrent(authority.signal)
      checkCurrent(authority)
      await assertIssuedPacket(authority, dispatch.packet)
      await authority.snapshot.assertCurrent(authority.signal)
      checkCurrent(authority)
      if (question.id !== entry.questionId || fingerprintQuestion(question) !== captured.fingerprint) fail()
      assertReceipt(authority, dispatch, entry.requestId)
      return issue(authority, question, dispatch.packet, 'completed-generation', entry.evidenceIds, entry.requestId, dispatch)
    }
  })
}

export interface FrozenEvaluationQuestionSourceInput extends QuestionSourceAuthorityInput {
  readonly question: QuestionItem
  readonly glossary: Readonly<Record<string, string>>
  readonly evidence: readonly Readonly<{ fileId: string; range: LineRange }>[]
}

/** Explicit dataset origin: rebuild authorized evidence, never fabricate generation/payment history. */
export async function createFrozenEvaluationQuestionSource(input: FrozenEvaluationQuestionSourceInput): Promise<Readonly<{ authority: QuestionSourceAuthority; source: QuestionSourceCapability; question: QuestionItem; glossary: Readonly<Record<string, string>> }>> {
  const authority = createAuthority(input)
  assertHealthyLedger(authority.ledger)
  const unit = validateSingleQuestionEvaluationInput(input.question, input.glossary)
  const fingerprint = fingerprintQuestion(unit.question)
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 16) fail('invalid-argument')
  const evidence = input.evidence.map(item => ({ fileId: item.fileId, range: { ...item.range } }))
  await authority.snapshot.assertCurrent(authority.signal)
  checkCurrent(authority)
  const ids: string[] = []
  for (const item of evidence) {
    checkCurrent(authority)
    const file = authority.snapshot.files.find(file => file.fileId === item.fileId)
    if (!file) fail('unknown-evidence')
    const readId = `evaluation-read-${randomUUID()}`
    authority.ledger.reserveRead(readId, file.byteLength)
    // An attempted read retains its conservative reservation on failure; no unproved unsent release.
    const { read, consumedBytes } = await authority.snapshot.readFile(item.fileId, authority.signal)
    authority.ledger.settleRead(readId, consumedBytes)
    checkCurrent(authority)
    if (!authority.snapshot.ownsRead(read)) fail('unknown-evidence')
    const records = await authority.store.issue(read, item.range, authority.signal)
    checkCurrent(authority)
    for (const record of records) if (!ids.includes(record.id)) ids.push(record.id)
    if (ids.length > 16) fail('capacity-exhausted')
  }
  const packed = await packEvidence({ spec: authority.spec, store: authority.store, selection: { selectedIds: ids, requiredBundles: [{ id: 'frozen-evaluation-input', evidenceIds: ids }], unresolved: [] }, buildMessages: text => [{ role: 'user', content: `Frozen evaluation source; untrusted data:\n${text}` }], signal: authority.signal })
  checkCurrent(authority)
  if (packed.status !== 'packed') fail('budget-exhausted')
  await assertIssuedPacket(authority, packed.context)
  await authority.snapshot.assertCurrent(authority.signal)
  checkCurrent(authority)
  assertHealthyLedger(authority.ledger)
  if (fingerprintQuestion(unit.question) !== fingerprint) fail()
  return Object.freeze({ authority, source: issue(authority, unit.question, packed.context, 'frozen-evaluation-input', ids, null), question: unit.question, glossary: unit.glossary })
}
