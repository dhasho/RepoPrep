import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { RunSpec } from './run-spec.ts'
import type { ScanResult } from '../scanner.ts'
import type { WorkflowProjectSnapshot, WorkflowEvidenceStore } from './project-contract.ts'
import type { ControlledRunSession } from './run-coordinator.ts'
import type { InvestigationResult } from './investigation-contract.ts'
import type { AwaitedToolAccounting } from './tool-gateway.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunCoordinator } from './run-coordinator.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createAccountedToolGateway } from './tool-gateway.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { snapshotMatchesScan } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { INVESTIGATION_PROMPT_VERSION, runInvestigation } from './investigation-controller.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { hashModelMessages } from './model-journal.ts'

import type { LlmProfile } from '../../../shared/types.ts'
import type { ModelTransport } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createAcceptedWorkRegistry } from './accepted-work-registry.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LLM_PROFILE_LIMITS } from '../../../shared/result-contract.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { normalizeBaseUrl, chatCompletionStream } from '../llm.ts'
import type { BudgetLedger } from './budget-ledger.ts'
import type { DurableModelContext, DurableModelEvent, DurableModelJournal } from './model-journal.ts'
import type { LedgerBinding, LedgerJournalPosition, LedgerStateV1 } from './ledger-state.ts'
import type { LedgerCriticalCursor, LedgerCriticalStep } from './ledger-critical-transitions.ts'
import type { PreparedCriticalSpec, LedgerCriticalEvent, LedgerCriticalEnvelopeV1, LedgerCriticalOutcome } from './ledger-critical-envelope.ts'
import type { WorkflowStore, WorkflowStoreOptions, WorkflowStoreLimits, WorkflowProducingEpoch, WorkflowRecordReference, WorkflowRunBinding, WorkflowVerifiedJournal, WorkflowAttempt, WorkflowAttemptInfo } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { openWorkflowStore, readWorkflowStore } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createBudgetLedger, blockBudgetLedger, sealBudgetLedger, exportBudgetLedgerState } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerBinding, validateLedgerState } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LEDGER_CRITICAL_FORMAT, LEDGER_CRITICAL_SCHEMA_ID, prepareLedgerCriticalSpec, ledgerCriticalPosition, validateLedgerCriticalEnvelope, createLedgerCriticalPayloadValidator } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerCriticalCursor, checkLedgerCriticalTransition, acceptLedgerCriticalStep, foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'

// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { validateArchivedWorkflowLedger } from './workflow-ledger-archive.ts'

import type { LedgerCriticalV2Cursor, LedgerCriticalV2Step } from './ledger-critical-v2-transitions.ts'
import type { LedgerCriticalEnvelopeV2, LedgerCriticalEventV2, CriticalLineageV2 } from './ledger-critical-v2-envelope.ts'
import type { OriginalPlanMetadata } from './original-plan-metadata.ts'
import type { GenerationGroup } from './evidence-generation-context.ts'
import type { BuiltContext } from '../context-builder.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LEDGER_CRITICAL_V2_FORMAT, LEDGER_CRITICAL_V2_SCHEMA_ID, prepareLedgerCriticalV2Spec, ledgerCriticalV2Position, validateLedgerCriticalV2Envelope, createLedgerCriticalV2PayloadValidator } from './ledger-critical-v2-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerCriticalV2Cursor, checkLedgerCriticalV2Transition, acceptLedgerCriticalV2Step, foldLedgerCriticalV2Prefix } from './ledger-critical-v2-transitions.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { makeEvidenceGenerationGroups, buildLegacyEvidenceContext } from './evidence-generation-context.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { planQuestionQuotas } from '../question-budget.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { hashOriginalPlanBinding, hashOriginalPlanMetadata, ORIGINAL_PLAN_RETRY_POLICY, ORIGINAL_PLAN_VERSION_COMMITMENTS } from './original-plan-metadata.ts'

export const WORKFLOW_LEDGER_STATE_SCHEMA_ID = 'workflow-ledger-state-v1'
export interface WorkflowLedgerJournalOptions {
  readonly storageDirectory: string
  readonly spec: unknown
  /** W accepts tightened quotas only. No store, attempt, validator or ack can be supplied. */
  readonly limits?: WorkflowStoreLimits
  readonly onDurableStep?: WorkflowStoreOptions['onDurableStep']
}
export interface WorkflowLedgerJournalSession {
  readonly spec: RunSpec
  readonly ledger: BudgetLedger
  readonly journal: DurableModelJournal
  /** Synchronous issuance revocation, not a durable terminal event. */
  finish(): boolean
  close(): Promise<void>
}
const contextKeys = ['runId', 'projectId', 'snapshotId', 'attemptId', 'fence', 'id', 'stage', 'semanticHash', 'semanticOperationHash', 'requestHash', 'manifestHash', 'inputTokens', 'outputTokens', 'contextChars'] as const
function invalid(): never { throw new WorkflowError('invalid-argument') }
function unavailable(): never { throw new WorkflowError('unreadable') }
function fields(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !keys.includes(key))) invalid()
  const copy: Record<string, unknown> = {}
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
    copy[key] = descriptor.value
  }
  return copy
}
function scalars(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const copy = fields(value, keys)
  if (Object.values(copy).some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) invalid()
  return Object.freeze(copy)
}
function captureModel(value: DurableModelEvent): DurableModelEvent {
  const copy = fields(value, ['version', 'kind', 'context', 'usage', 'outputStatus', 'failureCode'])
  const context = scalars(copy.context, contextKeys)
  const usage = copy.usage === null ? null : scalars(copy.usage, ['inputTokens', 'outputTokens', 'totalTokens'])
  for (const key of ['version', 'kind', 'outputStatus', 'failureCode']) if (!['string', 'number'].includes(typeof copy[key])) invalid()
  return Object.freeze({ ...copy, context, usage }) as unknown as DurableModelEvent
}
function same(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
    return JSON.stringify(value)
  }
  return canonical(a) === canonical(b)
}
// Fixed module-private version choice. No caller codec/validator or continuing
// session can change this selection after genesis. Tokens stay version-native.
type HostCursor = LedgerCriticalCursor | LedgerCriticalV2Cursor
type HostStep = LedgerCriticalStep | LedgerCriticalV2Step
type HostEnvelope = LedgerCriticalEnvelopeV1 | LedgerCriticalEnvelopeV2
type HostEvent = LedgerCriticalEvent | LedgerCriticalEventV2
function criticalCodec(version: 'v1' | 'v2', source: { spec: unknown }) {
  if (version === 'v2') {
    const prepared = prepareLedgerCriticalV2Spec(source)
    return Object.freeze({ version, prepared, schemaId: LEDGER_CRITICAL_V2_SCHEMA_ID,
      validator: createLedgerCriticalV2PayloadValidator(), historical: createLedgerCriticalPayloadValidator(),
      create: (): HostCursor => createLedgerCriticalV2Cursor(prepared),
      nextLineage: (cursor: HostCursor | null, event: LedgerCriticalEventV2, plan?: OriginalPlanMetadata): CriticalLineageV2 => Object.freeze({ plan: event.kind === 'plan' ? plan ?? null : (cursor as LedgerCriticalV2Cursor | null)?.lineage.plan ?? null }),
      position: (context: unknown, event: LedgerCriticalEventV2, lineage?: unknown) => ledgerCriticalV2Position(prepared, context, event, lineage),
      envelope: (provenance: unknown, event: LedgerCriticalEventV2, logicalPosition: LedgerJournalPosition, state: LedgerStateV1, lineage?: unknown): HostEnvelope => validateLedgerCriticalV2Envelope({ format: LEDGER_CRITICAL_V2_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, state, lineage }, prepared),
      validate: (payload: unknown): HostEnvelope => validateLedgerCriticalV2Envelope(payload, prepared),
      check: (cursor: HostCursor, envelope: HostEnvelope): HostStep => checkLedgerCriticalV2Transition(cursor as LedgerCriticalV2Cursor, envelope as LedgerCriticalEnvelopeV2),
      accept: (step: HostStep, reference: WorkflowRecordReference): HostCursor => acceptLedgerCriticalV2Step(step as LedgerCriticalV2Step, reference),
      fold: (records: readonly { payload: unknown; reference: WorkflowRecordReference }[]): HostCursor => foldLedgerCriticalV2Prefix(records),
      plan: (cursor: HostCursor): OriginalPlanMetadata | null => (cursor as LedgerCriticalV2Cursor).lineage.plan,
      sameLineage: (left: HostCursor, right: HostCursor): boolean => same((left as LedgerCriticalV2Cursor).lineage, (right as LedgerCriticalV2Cursor).lineage)
    })
  }
  const prepared = prepareLedgerCriticalSpec(source)
  return Object.freeze({ version, prepared, schemaId: LEDGER_CRITICAL_SCHEMA_ID,
    validator: createLedgerCriticalPayloadValidator(), historical: createLedgerCriticalV2PayloadValidator(),
    create: (): HostCursor => createLedgerCriticalCursor(prepared),
    nextLineage: (_cursor: HostCursor | null, _event: LedgerCriticalEvent): null => null,
    position: (context: unknown, event: LedgerCriticalEvent, _lineage?: unknown) => ledgerCriticalPosition(prepared, context, event),
    envelope: (provenance: unknown, event: LedgerCriticalEvent, logicalPosition: LedgerJournalPosition, state: LedgerStateV1, _lineage?: unknown): HostEnvelope => validateLedgerCriticalEnvelope({ format: LEDGER_CRITICAL_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, state }, prepared),
    validate: (payload: unknown): HostEnvelope => validateLedgerCriticalEnvelope(payload, prepared),
    check: (cursor: HostCursor, envelope: HostEnvelope): HostStep => checkLedgerCriticalTransition(cursor as LedgerCriticalCursor, envelope as LedgerCriticalEnvelopeV1),
    accept: (step: HostStep, reference: WorkflowRecordReference): HostCursor => acceptLedgerCriticalStep(step as LedgerCriticalStep, reference),
    fold: (records: readonly { payload: unknown; reference: WorkflowRecordReference }[]): HostCursor => foldLedgerCriticalPrefix(records),
    plan: (_cursor: HostCursor): null => null,
    sameLineage: (_left: HostCursor, _right: HostCursor): boolean => true
  })
}
type CriticalCodec = ReturnType<typeof criticalCodec>
function codecForSchema(schemaId: string, spec: RunSpec): CriticalCodec {
  if (schemaId === LEDGER_CRITICAL_SCHEMA_ID) return criticalCodec('v1', { spec })
  if (schemaId === LEDGER_CRITICAL_V2_SCHEMA_ID) return criticalCodec('v2', { spec })
  return unavailable()
}

function captureOptions(input: WorkflowLedgerJournalOptions, write: boolean, version: 'v1' | 'v2' = 'v1') {
  const data = fields(input, write ? ['storageDirectory', 'spec', 'limits', 'onDurableStep'] : ['storageDirectory', 'spec'], ['storageDirectory', 'spec'])
  if (typeof data.storageDirectory !== 'string' || !data.storageDirectory.length) invalid()
  // A0 canonicalization happens once, before acquiring an asynchronous W owner.
  const codec = criticalCodec(version, { spec: data.spec })
  const prepared = codec.prepared
  let limits: WorkflowStoreLimits | undefined
  if (data.limits !== undefined) {
    const copy = fields(data.limits, ['aggregateBytes', 'runBytes', 'controlBytes', 'maxEntries', 'componentBytes'], [])
    for (const [key, value] of Object.entries(copy)) if (key !== 'componentBytes' && typeof value !== 'number') invalid()
    if (copy.componentBytes !== undefined) {
      const components = fields(copy.componentBytes, ['ledger', 'critical-journal', 'result', 'question', 'review', 'revision', 'snapshot-metadata', 'recorded-visible-response'], [])
      if (Object.values(components).some(value => typeof value !== 'number')) invalid()
      copy.componentBytes = Object.freeze(components)
    }
    limits = Object.freeze(copy) as WorkflowStoreLimits
  }
  if (data.onDurableStep !== undefined && typeof data.onDurableStep !== 'function') invalid()
  const options: WorkflowStoreOptions = {
    storageDirectory: data.storageDirectory, validators: validators(codec, write), historicalValidators: Object.freeze({ 'critical-journal': Object.freeze([codec.historical]) }),
    ...(limits === undefined ? {} : { limits }),
    ...(data.onDurableStep === undefined ? {} : { onDurableStep: data.onDurableStep as WorkflowStoreOptions['onDurableStep'] })
  }
  return { prepared, options, codec }
}
function validators(codec: CriticalCodec, archivedReads: boolean): WorkflowStoreOptions['validators'] {
  return Object.freeze({
    'critical-journal': codec.validator,
    ledger: Object.freeze({ schemaId: WORKFLOW_LEDGER_STATE_SCHEMA_ID, ...(archivedReads ? { validateRead: validateArchivedWorkflowLedger } : {}), validate(payload: unknown): boolean {
      try { validateLedgerState(codec.prepared.spec, payload); return true } catch { return false }
    } })
  })
}

/** New logical runs only. This component grants storage/accounting, not project or provider permission. */
export function createWorkflowLedgerJournal(input: WorkflowLedgerJournalOptions): Promise<WorkflowLedgerJournalSession> {
  const { prepared, options, codec } = captureOptions(input, true)
  const ledger = createBudgetLedger(prepared.spec, { durable: true })
  return initialize(codec, options, ledger, false).then(value => value.session)
}

declare const cancellationBrand: unique symbol
/** An empty frozen, single-consumer token. It contains no storage or business handles. */
export interface WorkflowCancellationControl { readonly [cancellationBrand]: true }
export type WorkflowCancellationOutcome = 'cancelled' | 'failed'
export type WorkflowCancellationResolution =
  | Readonly<{ status: 'accepted'; outcome: WorkflowCancellationOutcome }>
  | Readonly<{ status: 'pending' }>
/** Fixed coordinator operations over the original owner's one business lifetime. */
interface OriginalRunWork {
  readonly signal: AbortSignal
  runStage<T>(start: () => T | PromiseLike<T>): Promise<T>
  runObserver<T>(start: () => T | PromiseLike<T>): Promise<T>
  seal(): void
  drain(): Promise<void>
  /** Observation of the original ledger deadline; cannot extend or reset it. */
  remainingMs(): number
}
interface CancellationStorage {
  readonly work?: OriginalRunWork
  assertAvailable(): void
  sealAdmission(): boolean
  resolve(outcome: WorkflowCancellationOutcome): Promise<WorkflowCancellationResolution>
  close(): Promise<void>
}
interface CancellationOwner {
  readonly originalSpecJson: string
  readonly codecVersion: 'v1' | 'v2'
  // Retain the original A2a session too; none of its raw references leave this module.
  readonly session: WorkflowLedgerJournalSession
  readonly storage: CancellationStorage
  /** Dormant business objects never leave this original-owner entry. */
  readonly originalBusiness?: Readonly<{
    profile: LlmProfile
    investigation: ReturnType<typeof createModelGateway>
    generation: ReturnType<typeof createModelGateway>
  }>
  claimed: boolean
  closing: boolean
}
const cancellationOwners = new WeakMap<object, CancellationOwner>()
const pendingResolution: WorkflowCancellationResolution = Object.freeze({ status: 'pending' })

/** Creates its own genuine A2a run before exposing the opaque cancellation-only token. */
export function createWorkflowCancellationControl(input: WorkflowLedgerJournalOptions): Promise<WorkflowCancellationControl> {
  const { prepared, options, codec } = captureOptions(input, true)
  const ledger = createBudgetLedger(prepared.spec, { durable: true })
  return initialize(codec, options, ledger, true).then(created => {
    const token = Object.freeze({}) as WorkflowCancellationControl
    cancellationOwners.set(token, { originalSpecJson: prepared.originalSpecJson, codecVersion: codec.version, session: created.session, storage: created.storage, claimed: false, closing: false })
    return token
  })
}
export interface OriginalWorkflowRunOptions extends WorkflowLedgerJournalOptions {
  readonly profile: LlmProfile
  /** Existing raw transport seam; no gateway, storage or receipt can be supplied. */
  readonly transport?: ModelTransport
}
export interface OriginalRunObservation {
  readonly mode: 'dormant-original-run-v1'
  readonly durable: true
  readonly generationAdmission: 'unavailable'
  readonly terminalSupport: 'cancellation-only'
}
export interface OriginalWorkflowRun {
  readonly cancellationControl: WorkflowCancellationControl
  observe(): Readonly<OriginalRunObservation>
  closeUnclaimed(): Promise<void>
}
const originalRunObservation: Readonly<OriginalRunObservation> = Object.freeze({
  mode: 'dormant-original-run-v1', durable: true,
  generationAdmission: 'unavailable', terminalSupport: 'cancellation-only'
})
function captureOriginalProfile(value: unknown, spec: RunSpec): LlmProfile {
  const copy = fields(value, ['id', 'name', 'baseUrl', 'apiKey', 'model', 'protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens'], ['id', 'name', 'baseUrl', 'apiKey', 'model'])
  for (const key of ['id', 'name', 'baseUrl', 'apiKey', 'model'] as const) {
    const text = copy[key]
    if (typeof text !== 'string' || text.length > LLM_PROFILE_LIMITS[key] || key !== 'apiKey' && !text.length) invalid()
  }
  if (copy.protocol !== undefined && !['openai', 'anthropic'].includes(copy.protocol as string)) invalid()
  if (copy.reasoningEffort !== undefined && !['low', 'high'].includes(copy.reasoningEffort as string)) invalid()
  if (copy.temperature !== undefined && (typeof copy.temperature !== 'number' || !Number.isFinite(copy.temperature))) invalid()
  for (const key of ['contextWindowTokens', 'maxOutputTokens']) if (copy[key] !== undefined && (typeof copy[key] !== 'number' || !Number.isSafeInteger(copy[key]) || (copy[key] as number) < 1)) invalid()
  const profile = Object.freeze(copy) as unknown as LlmProfile
  const endpointFingerprint = createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex')
  if (profile.id !== spec.model.profileId || profile.model !== spec.model.model || endpointFingerprint !== spec.model.endpointFingerprint || (profile.protocol ?? 'openai') !== (spec.model.protocol ?? 'openai') || profile.reasoningEffort !== spec.model.reasoningEffort || (profile.temperature ?? 0.4) !== (spec.model.temperature ?? 0.4) || profile.contextWindowTokens !== spec.model.contextWindowTokens || profile.maxOutputTokens !== spec.model.maxOutputTokens) throw new WorkflowError('configuration-changed')
  return profile
}
function originalRunWork(ledger: BudgetLedger, spec: RunSpec) {
  const registry = createAcceptedWorkRegistry()
  const stages = registry.createIssuer('original-coordinator-stage')
  const observers = registry.createIssuer('original-coordinator-observer')
  const model = registry.createIssuer('original-model')
  const tool = registry.createIssuer('original-tool')
  const source = registry.createIssuer('original-source')
  const controller = new AbortController()
  const control: OriginalRunWork = Object.freeze({
    signal: controller.signal,
    runStage<T>(start: () => T | PromiseLike<T>): Promise<T> { return stages.run(start) },
    runObserver<T>(start: () => T | PromiseLike<T>): Promise<T> { return observers.run(start) },
    seal() { registry.seal(); if (!controller.signal.aborted) controller.abort() },
    drain() { return registry.drain() },
    remainingMs() {
      // A broken original clock closes the deadline rather than granting a new one.
      try { return Math.max(0, spec.budget.total.wallClockMs - ledger.snapshot().elapsedMs) } catch { return 0 }
    }
  })
  return Object.freeze({ control, model, tool, source })
}

/**
 * New original logical run, before investigation expenditure. Captures real storage,
 * durable accounting and private gateways together. This wrapper stays dormant;
 * the explicit investigation factory composes its own private original owner.
 */
export async function createWorkflowOriginalRun(input: OriginalWorkflowRunOptions): Promise<OriginalWorkflowRun> {
  const data = fields(input, ['storageDirectory', 'spec', 'limits', 'onDurableStep', 'profile', 'transport'], ['storageDirectory', 'spec', 'profile'])
  const { token } = await createOriginalOwner(data)
  return Object.freeze({ cancellationControl: token, observe() { return originalRunObservation }, closeUnclaimed() { return closeWorkflowCancellationControl(token) } })
}
async function createOriginalOwner(data: Record<string, unknown>, version: 'v1' | 'v2' = 'v1') {
  if (data.transport !== undefined && typeof data.transport !== 'function') invalid()
  const { prepared, options, codec } = captureOptions({
    storageDirectory: data.storageDirectory as string, spec: data.spec,
    ...(data.limits === undefined ? {} : { limits: data.limits as WorkflowStoreLimits }),
    ...(data.onDurableStep === undefined ? {} : { onDurableStep: data.onDurableStep as WorkflowStoreOptions['onDurableStep'] })
  }, true, version)
  const profile = captureOriginalProfile(data.profile, prepared.spec)
  const ledger = createBudgetLedger(prepared.spec, { durable: true })
  const work = originalRunWork(ledger, prepared.spec)
  const created = await initialize(codec, options, ledger, true, work.control)
  try {
    // Gateway construction performs its own original configuration/durability guard.
    const gatewayOptions = { durability: created.session.journal, ...(data.transport === undefined ? {} : { transport: data.transport as ModelTransport }) }
    const originalBusiness = Object.freeze({
      profile,
      investigation: createModelGateway(prepared.spec, profile, ledger, gatewayOptions),
      generation: createModelGateway(prepared.spec, profile, ledger, gatewayOptions)
    })
    // Storage initialization consumes the original allowance too; never restart it.
    ledger.assertCanContinue()
    const token = Object.freeze({}) as WorkflowCancellationControl
    cancellationOwners.set(token, { originalSpecJson: prepared.originalSpecJson, codecVersion: codec.version, session: created.session, storage: created.storage, originalBusiness, claimed: false, closing: false })
    return { token, prepared, ledger, work, originalBusiness, created }

  } catch (error) {
    created.storage.sealAdmission()
    await created.storage.close()
    if (error instanceof WorkflowError) throw error
    throw new WorkflowError('unreadable')
  }
}
export interface OriginalInvestigationRunOptions extends OriginalWorkflowRunOptions {
  readonly scan: ScanResult
  readonly snapshot: WorkflowProjectSnapshot
  readonly objective?: string
}
export interface OriginalInvestigationObservation {
  readonly phase: 'ready' | 'running' | 'completed' | 'closed'
  readonly generationAdmission: 'unavailable'
  readonly terminalSupport: 'cancellation-only'
  readonly terminalStatus: WorkflowCancellationOutcome | null
  readonly decisions: number
  readonly toolRequests: number
  readonly selectedEvidenceCount: number
  readonly topicCount: number
}
export interface OriginalInvestigationRun {
  run(): Promise<Readonly<OriginalInvestigationObservation>>
  observe(): Readonly<OriginalInvestigationObservation>
  cancel(): boolean
  close(): Promise<void>
}
// All opt-in original investigation services share actual project/run exclusion.
const originalInvestigationCoordinator = createRunCoordinator()
// Private investigation material only; it conveys no generation or terminal proof.
const completedInvestigations = new WeakMap<object, Readonly<{
  result: InvestigationResult
  store: WorkflowEvidenceStore
  tail: WorkflowRecordReference
  plan: OriginalPlanMetadata
  groups: readonly GenerationGroup[]
  context: BuiltContext
  quotas: ReturnType<typeof planQuestionQuotas>
}>>()
function commitment(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function planCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(planCanonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + planCanonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
function planDigest(domain: string, value: unknown): string { return createHash('sha256').update(planCanonical([domain, value]), 'utf8').digest('hex') }

/** Explicit opt-in main-program entry. No ordinary run or default caller is changed. */
export async function createOriginalInvestigationRun(input: OriginalInvestigationRunOptions): Promise<OriginalInvestigationRun> {
  const data = fields(input, ['storageDirectory', 'spec', 'limits', 'onDurableStep', 'profile', 'transport', 'scan', 'snapshot', 'objective'], ['storageDirectory', 'spec', 'profile', 'scan', 'snapshot'])
  const scan = data.scan as ScanResult, snapshot = data.snapshot as WorkflowProjectSnapshot
  if (!snapshotMatchesScan(snapshot, scan)) throw new WorkflowError('stale-snapshot')
  const preflight = prepareLedgerCriticalV2Spec({ spec: data.spec }).spec
  if (preflight.strategy !== 'agentic' || preflight.strategyVersion !== 'agentic-v1' || preflight.promptVersion !== INVESTIGATION_PROMPT_VERSION || preflight.toolVersion !== 'read-tools-v1' || preflight.policyVersion !== snapshot.policyVersion || preflight.projectId !== snapshot.projectId || preflight.snapshotId !== snapshot.snapshotId) throw new WorkflowError('configuration-changed')
  const objective = data.objective === undefined ? `Explore ${preflight.roleFocus} mechanisms at ${preflight.granularity} depth for interview preparation.` : data.objective
  if (typeof objective !== 'string' || !objective.length || objective.length > 800 || objective.includes('\0')) invalid()
  const store = createEvidenceStore(snapshot)
  if (data.transport !== undefined && typeof data.transport !== 'function') invalid()
  const actualTransport = (data.transport as ModelTransport | undefined) ?? chatCompletionStream
  // The genuine gateway awaits reservation and intent flushes. Recheck the
  // captured source after those waits, before the raw transport may send bytes.
  const transport: ModelTransport = async (profile, messages, emit, options) => {
    let active = true, started = false, admitted = false, violation = false
    let admission: Promise<void> | undefined
    const assertActive = (): void => {
      if (!active || violation) throw new WorkflowError('model-failed')
      if (options.signal?.aborted) throw new WorkflowError('cancelled')
      if (!snapshotMatchesScan(snapshot, scan)) throw new WorkflowError('stale-snapshot')
    }
    const beforeFetch = (): void => {
      assertActive()
      if (!admitted) { violation = true; throw new WorkflowError('model-failed') }
      options.beforeFetch?.()
      assertActive()
    }
    try {
      return await actualTransport(profile, messages, emit, {
        ...options,
        beforeRequest() {
          assertActive()
          if (started) { violation = true; throw new WorkflowError('model-failed') }
          started = true
          admission = (async () => {
            await options.beforeRequest?.()
            assertActive()
            await snapshot.assertCurrent(options.signal)
            assertActive()
            admitted = true
            beforeFetch()
          })()
          void admission.catch(() => {})
          return admission
        },
        beforeFetch,
        onRequest() { beforeFetch(); options.onRequest?.(); beforeFetch() }
      })
    } finally {
      active = false
      // A broken injected transport cannot detach the post-intent source fence.
      await admission?.catch(() => {})
    }
  }
  // Calling the owner captures spec, profile and options synchronously before its
  // first await. Snapshot currentness is then checked before claiming any work.
  const original = await createOriginalOwner({ ...data, transport }, 'v2')
  const { prepared, ledger, work, created, originalBusiness, token } = original
  let session: ControlledRunSession | null = null
  try {
    await snapshot.assertCurrent(work.control.signal)
    session = originalInvestigationCoordinator.begin(prepared.spec, { cancellationControl: token })
    if (!session) throw new WorkflowError('configuration-changed')
  } catch (error) { await closeWorkflowCancellationControl(token); throw error }
  const controlled = session
  let phase: OriginalInvestigationObservation['phase'] = 'ready'
  let invoked = false, decisionOrdinal = 0
  let completedResult: InvestigationResult | undefined
  let completedRecords: readonly import('./project-contract.ts').EvidenceRecord[] | undefined
  let operationQueue: Promise<unknown> = Promise.resolve()
  let statistics = { decisions: 0, toolRequests: 0, selectedEvidenceCount: 0, topicCount: 0 }
  const observe = (): Readonly<OriginalInvestigationObservation> => Object.freeze({ phase, generationAdmission: 'unavailable', terminalSupport: 'cancellation-only', terminalStatus: controlled.terminalStatus as WorkflowCancellationOutcome | null, ...statistics })
  const assertCurrent = async (): Promise<void> => {
    controlled.assertActive()
    if (!snapshotMatchesScan(snapshot, scan)) throw new WorkflowError('stale-snapshot')
    await snapshot.assertCurrent(controlled.signal)
    controlled.assertActive()
  }
  // A single private sequence covers each model finally and each entire tool action.
  // The critical writer queue then serializes every individual full-ledger event.
  const sequential = <T>(start: () => Promise<T>): Promise<T> => {
    const task = operationQueue.then(async () => { await assertCurrent(); return start() })
    operationQueue = task.catch(() => {})
    return task
  }
  const source: AwaitedToolAccounting = Object.freeze({
    chargeTool: () => work.source.run(async () => { await assertCurrent(); await created.source.chargeTool(); controlled.assertActive() }),
    reserveRead: (bytes: number) => work.source.run(async () => { await assertCurrent(); const id = await created.source.reserveRead(bytes); controlled.assertActive(); return id }),
    settleRead: (id: string, bytes: number) => work.source.run(async () => { controlled.assertActive(); await created.source.settleRead(id, bytes); controlled.assertActive() })
  })
  let engine: ReturnType<typeof createAccountedToolGateway>
  try { engine = createAccountedToolGateway(snapshot, store, ledger, source, { signal: controlled.signal }) }
  catch (error) {
    // Original expiry can close the signal at the synchronous claim boundary.
    // Construction failure must still dispose the now-claimed W owner.
    await controlled.close()
    throw error instanceof WorkflowError ? error : new WorkflowError('unreadable')
  }
  const tools: ReturnType<typeof createAccountedToolGateway> = Object.freeze({ execute: (action, signal) => work.tool.run(() => sequential(async () => {
    if (signal !== controlled.signal) invalid()
    const value = await engine.execute(action, signal)
    await assertCurrent()
    if (value.status !== 'ok') throw new WorkflowError('unreadable')
    statistics = { ...statistics, toolRequests: statistics.toolRequests + 1 }
    return value
  })) })
  const model: Parameters<typeof runInvestigation>[0]['model'] = Object.freeze({ complete: input => work.model.run(() => sequential(async () => {
    if (input.stage !== 'investigation' || input.signal !== controlled.signal || decisionOrdinal >= 3) invalid()
    const ordinal = ++decisionOrdinal
    statistics = { ...statistics, decisions: ordinal }
    const semanticHash = commitment({ domain: 'original-investigation-decision-v1', binding: prepared.binding, ordinal })
    const manifestHash = commitment({ domain: 'original-investigation-manifest-v1', originalSpec: prepared.originalSpecJson, objective, snapshot: { id: snapshot.snapshotId, policy: snapshot.policyVersion, files: snapshot.files }, messages: hashModelMessages(input.messages) })
    const value = await originalBusiness.investigation.complete({ ...input, id: `original-decision:${ordinal}`, durableOperation: { semanticHash, manifestHash } })
    await assertCurrent()
    return value
  })) })
  return Object.freeze({
    observe,
    cancel() { return controlled.cancel() },
    async close() { phase = 'closed'; await controlled.close() },
    async run() {
      if (invoked || phase !== 'ready') invalid()
      invoked = true; phase = 'running'
      try {
        await controlled.execute('scanning', assertCurrent)
        await controlled.execute('investigating', async () => {
          const result = await runInvestigation({ spec: prepared.spec, snapshot, store, ledger, tools, model, objective, signal: controlled.signal })
          await assertCurrent()
          if (result.status !== 'completed' || !result.usageComplete || !result.selection.selectedIds.length || !result.topics.length) throw new WorkflowError('unknown-evidence')
          const records = await store.resolve(result.selection.selectedIds, prepared.spec.snapshotId, controlled.signal)
          await assertCurrent()
          if (records.length !== result.selection.selectedIds.length || !created.tail()) throw new WorkflowError('unknown-evidence')
          const meter = ledger.snapshot()
          if (!meter.usageComplete || meter.blocked || meter.reservations.some(row => row.state !== 'settled')) throw new WorkflowError('budget-exhausted')
          completedResult = result
          completedRecords = Object.freeze([...records])
          statistics = { ...statistics, selectedEvidenceCount: records.length, topicCount: result.topics.length }
        })
        await controlled.execute('packing', async () => {
          await assertCurrent()
          const result = completedResult, records = completedRecords
          if (!result || !records) throw new WorkflowError('unknown-evidence')
          ledger.assertCanContinue()
          const remainingModelRequests = ledger.snapshot().remaining.modelRequests
          if (remainingModelRequests < 1) throw new WorkflowError('budget-exhausted')
          const desired = prepared.spec.granularity === 'coarse' ? 1 : prepared.spec.granularity === 'medium' ? 2 : 4
          const groups = makeEvidenceGenerationGroups(result.selection.selectedIds, records, result.selection.requiredBundles, result.topics, Math.min(desired, remainingModelRequests), prepared.spec.granularity === 'fine')
          if (!groups.length) throw new WorkflowError('budget-exhausted')
          const context = buildLegacyEvidenceContext(scan, snapshot.files.map(file => file.relPath), records, groups)
          await assertCurrent()
          const quotas = planQuestionQuotas(prepared.spec.granularity, context.batches.map(batch => ({ label: batch.label, weight: batch.weight, kind: batch.kind })))
          if (quotas.quotas.length !== groups.length) throw new WorkflowError('unknown-evidence')
          const snapshotDescription = {
            scan,
            snapshot: { projectId: snapshot.projectId, snapshotId: snapshot.snapshotId, policyVersion: snapshot.policyVersion, files: snapshot.files, summary: snapshot.summary }
          }
          const evidenceDescription = records.map(record => ({
            id: record.id, snapshotId: record.snapshotId, fileId: record.fileId, relPath: record.relPath,
            originalRange: record.originalRange, displayRange: record.displayRange, contentHash: record.contentHash,
            text: record.text, sourceKind: record.sourceKind, readStatus: record.readStatus, parseStatus: record.parseStatus,
            omission: record.omission, transformationVersion: record.transformationVersion, redactionSummary: record.redactionSummary ?? null
          }))
          const slots = quotas.quotas.map((quota, index) => Object.freeze({
            ordinal: index + 1, kind: quota.kind, weight: quota.weight, quota: quota.quota,
            sourceGroupHash: planDigest('repoprep.workflow.original-plan-source-group.v1', {
              ordinal: index + 1, ids: groups[index].ids,
              evidence: groups[index].files.map(record => ({
                id: record.id, snapshotId: record.snapshotId, fileId: record.fileId, relPath: record.relPath,
                originalRange: record.originalRange, displayRange: record.displayRange, contentHash: record.contentHash,
                text: record.text, sourceKind: record.sourceKind, readStatus: record.readStatus, parseStatus: record.parseStatus,
                omission: record.omission, transformationVersion: record.transformationVersion
              })),
              topics: groups[index].topics, requiredBundles: groups[index].bundles
            })
          }))
          const plan: OriginalPlanMetadata = {
            version: 1,
            bindingHash: hashOriginalPlanBinding(prepared.binding),
            runSpecHash: prepared.binding.runSpecHash,
            configHash: prepared.binding.configHash,
            objectiveHash: planDigest('repoprep.workflow.original-plan-objective.v1', objective),
            snapshotHash: planDigest('repoprep.workflow.original-plan-snapshot.v1', snapshotDescription),
            evidenceHash: planDigest('repoprep.workflow.original-plan-evidence.v1', evidenceDescription),
            investigationHash: planDigest('repoprep.workflow.original-plan-investigation.v1', result),
            contextHash: planDigest('repoprep.workflow.original-plan-context.v1', context),
            versions: ORIGINAL_PLAN_VERSION_COMMITMENTS,
            writerVariant: 'topic-cards',
            questionBudget: prepared.spec.questionBudget,
            remainingModelRequests,
            plannedTotal: quotas.total,
            slots,
            retry: ORIGINAL_PLAN_RETRY_POLICY
          }
          const persisted = await created.persistPlan(plan)
          await assertCurrent()
          if (!same(created.tail(), persisted.tail) || !same(persisted.plan, plan)) throw new WorkflowError('unreadable')
          completedInvestigations.set(token, Object.freeze({ result, store, tail: persisted.tail, plan: persisted.plan, groups: Object.freeze(groups), context, quotas }))
        })
        controlled.assertActive()
        phase = 'completed'
        return observe()
      } catch (error) {
        phase = 'closed'
        controlled.fail()
        // Stage/child leases have settled before an outer caller can close/drain.
        throw error instanceof WorkflowError ? error : new WorkflowError(controlled.signal.aborted ? 'cancelled' : 'unreadable')
      }
    }
  })
}

/** Dispose only an unclaimed factory token. Claimed runs close through their real coordinator. */
export function closeWorkflowCancellationControl(token: WorkflowCancellationControl): Promise<void> {
  const owner = token && typeof token === 'object' ? cancellationOwners.get(token) : undefined
  if (!owner || owner.claimed) return Promise.reject(new WorkflowError('invalid-argument'))
  owner.closing = true
  owner.storage.sealAdmission()
  return owner.storage.close()
}
/** @internal Real coordinator consumer; no raw ledger, journal, W owner or attempt is returned. */
export function claimWorkflowCancellationControl(token: WorkflowCancellationControl, spec: RunSpec): CancellationStorage {
  const owner = token && typeof token === 'object' ? cancellationOwners.get(token) : undefined
  if (!owner || owner.claimed || owner.closing || criticalCodec(owner.codecVersion, { spec }).prepared.originalSpecJson !== owner.originalSpecJson) invalid()
  owner.storage.assertAvailable()
  owner.claimed = true
  return owner.storage
}

async function initialize(codec: CriticalCodec, options: WorkflowStoreOptions, ledger: BudgetLedger, controlled: boolean, work?: OriginalRunWork): Promise<{ session: WorkflowLedgerJournalSession; storage: CancellationStorage; source: AwaitedToolAccounting; tail(): WorkflowRecordReference | null; persistPlan(plan: OriginalPlanMetadata): Promise<Readonly<{ plan: OriginalPlanMetadata; tail: WorkflowRecordReference }>> }> {
  const prepared = codec.prepared
  let store: WorkflowStore | undefined
  let revoke: (() => boolean) | undefined
  try {
    store = await openWorkflowStore(options)
    const owned = store
    if (owned.readOwned(prepared.binding).status !== 'absent') unavailable()
    let attempt: WorkflowAttempt = await owned.beginAttempt(prepared.binding)
    let active = true
    // Legacy A2a finish/poison remains unchanged. A2b admission closure never calls it.
    revoke = () => { work?.seal(); active = false; blockBudgetLedger(ledger); return owned.finishAttempt(attempt) }
    let info: WorkflowAttemptInfo = owned.assertCurrent(attempt)
    if (!same(info.binding, prepared.binding) || info.epoch.attempt !== 1) unavailable()
    let cursor = codec.create()
    let binding: LedgerBinding = createLedgerBinding(prepared.spec, prepared.genesis)
    let queue: Promise<unknown> = Promise.resolve()
    let closing: Promise<void> | undefined
    let metadataActive = false
    let fixedOutcome: WorkflowCancellationOutcome | null = null
    let accepted: WorkflowCancellationResolution | null = null
    let unresolved: { step: HostStep; bytes: Buffer } | null = null
    let planIssued = false
    const poison = (): void => {
      work?.seal()
      if (!controlled) revoke!()
      else { active = false; metadataActive = false; owned.finishAttempt(attempt) }
    }
    const assertOwned = (metadata = false): void => {
      if (closing || (metadata ? !metadataActive : !active)) throw new WorkflowError('configuration-changed')
      try {
        const current = owned.assertCurrent(attempt)
        if (!same(current.binding, prepared.binding) || !same(current.epoch, info.epoch)) unavailable()
      } catch { poison(); throw new WorkflowError('configuration-changed') }
    }
    const assertCurrent = (context: DurableModelContext): void => {
      assertOwned()
      const c = scalars(context, contextKeys)
      if (c.runId !== prepared.spec.runId || c.projectId !== prepared.spec.projectId || c.snapshotId !== prepared.spec.snapshotId || c.attemptId !== info.epoch.attemptId || c.fence !== info.epoch.owner) throw new WorkflowError('configuration-changed')
    }
    const enqueue = (event: HostEvent, buildState: (position: LedgerJournalPosition) => LedgerStateV1, metadata = false, plan?: OriginalPlanMetadata): Promise<LedgerJournalPosition> => {
      const task = queue.then(async () => {
        try {
          assertOwned(metadata)
          let step: HostStep | undefined
          let bytes: Buffer | undefined
          let built = false
          const ack = await owned.appendJournal(attempt, context => {
            assertOwned(metadata)
            if (built || unresolved || !same(context.binding, prepared.binding) || !same(context.producingEpoch, info.epoch) || context.sequence !== cursor.logicalPosition.sequence + 1 || !same(context.previous, cursor.reference)) unavailable()
            built = true
            let lineage: unknown
            let position: LedgerJournalPosition
            let envelope: HostEnvelope
            if (codec.version === 'v1') {
              if (event.kind === 'plan') invalid()
              const versionedEvent = event as LedgerCriticalEvent
              lineage = codec.nextLineage(cursor, versionedEvent)
              position = codec.position(context, versionedEvent, lineage)
            } else {
              const versionedEvent = event as LedgerCriticalEventV2
              lineage = codec.nextLineage(cursor, versionedEvent, plan)
              position = codec.position(context, versionedEvent, lineage)
            }
            const state = buildState(position)
            if (codec.version === 'v1') {
              envelope = codec.envelope(context, event as LedgerCriticalEvent, position, state, lineage)
            } else {
              const versionedEvent = event as LedgerCriticalEventV2
              envelope = codec.envelope(context, versionedEvent, position, state, lineage)
            }
            step = codec.check(cursor, envelope)
            // W's complete outer encoding, never just its logical marker or payload.
            bytes = Buffer.from(JSON.stringify({ format: 'workflow-journal/v1', binding: context.binding, producingEpoch: context.producingEpoch, kind: 'critical-journal', schemaId: codec.schemaId, payload: envelope, sequence: context.sequence, previous: context.previous }))
            unresolved = { step, bytes }
            return envelope
          })
          assertOwned(metadata)
          if (!built || !step || !bytes || !ackMatches(ack, step, bytes)) unavailable()
          cursor = codec.accept(step, ack.reference)
          unresolved = null
          binding = createLedgerBinding(prepared.spec, cursor.logicalPosition)
          return step.logicalPosition
        } catch { poison(); throw new WorkflowError('unreadable') }
      })
      queue = task.catch(() => {})
      return task
    }
    const ackMatches = (ack: WorkflowVerifiedJournal, step: HostStep, bytes: Buffer): boolean => ack.schemaId === codec.schemaId && ack.sequence === step.logicalPosition.sequence && same(ack.payload, step.envelope) && same(ack.reference.producingEpoch, step.envelope.provenance.producingEpoch) && ack.reference.id === 'j-' + String(ack.sequence).padStart(12, '0') && ack.reference.byteLength === bytes.length && ack.reference.sha256 === createHash('sha256').update(bytes).digest('hex')
    await enqueue({ kind: 'created', genesis: prepared.genesis }, position => exportBudgetLedgerState(ledger, createLedgerBinding(prepared.spec, position)))
    const journal: DurableModelJournal = Object.freeze({
      get binding() { return binding }, attemptId: info.epoch.attemptId, fence: info.epoch.owner, assertCurrent,
      appendAndFlush(event: DurableModelEvent, buildState: (position: LedgerJournalPosition) => LedgerStateV1): Promise<LedgerJournalPosition> {
        try {
          assertOwned()
          if (typeof buildState !== 'function') invalid()
          const captured = captureModel(event)
          assertCurrent(captured.context)
          return enqueue(Object.freeze({ kind: 'model', model: captured }), buildState)
        } catch { poison(); return Promise.reject(new WorkflowError('unreadable')) }
      }
    })
    const closeStorage = (): Promise<void> => {
      if (!closing) {
        work?.seal()
        active = false; metadataActive = false
        owned.finishAttempt(attempt)
        if (work) closing = (async () => { await work.drain(); await Promise.all([queue, owned.close()]) })()
        else {
          const closed = owned.close()
          closing = Promise.all([queue, closed]).then(() => {})
        }
      }
      return closing
    }
    const session: WorkflowLedgerJournalSession = Object.freeze({ spec: prepared.spec, ledger, journal, finish: revoke, close(): Promise<void> {
      revoke!()
      return closeStorage()
    } })

    // Only this factory owns W. There are no other-project or business entrances.
    const readReconciled = () => {
      if (closing) unavailable()
      const view = owned.readOwned(prepared.binding)
      if (view.status !== 'verified' || !same(view.binding, prepared.binding) || !view.journal.length) unavailable()
      const records: { payload: HostEnvelope; reference: WorkflowRecordReference }[] = []
      for (const item of view.journal) {
        const envelope = codec.validate(item.payload)
        if (item.schemaId !== codec.schemaId || item.sequence !== records.length + 1 || item.reference.id !== 'j-' + String(item.sequence).padStart(12, '0') || envelope.provenance.sequence !== item.sequence || !same(envelope.provenance.binding, prepared.binding) || !same(envelope.provenance.producingEpoch, item.reference.producingEpoch) || !same(envelope.provenance.previous, records.at(-1)?.reference ?? null)) unavailable()
        records.push({ payload: envelope, reference: item.reference })
      }
      const folded = codec.fold(records.map(item => ({ payload: item.payload, reference: item.reference })))
      const latest = view.journal.at(-1)!
      if (!folded.state || !folded.reference || !same(folded.reference, latest.reference)) unavailable()
      if (unresolved) {
        if (!ackMatches(latest, unresolved.step, unresolved.bytes)) unavailable()
        cursor = codec.accept(unresolved.step, latest.reference)
        unresolved = null
        binding = createLedgerBinding(prepared.spec, cursor.logicalPosition)
      }
      if (!same(cursor.reference, folded.reference) || !same(cursor.logicalPosition, folded.logicalPosition) || !same(cursor.state, folded.state) || cursor.terminalOutcome !== folded.terminalOutcome || !codec.sameLineage(cursor, folded)) unavailable()
      // This original live ledger must still agree. A fresh/restored ledger is never substituted.
      const live = exportBudgetLedgerState(ledger, binding), disk = folded.state
      const accounting = (state: LedgerStateV1) => ({ models: state.models, reads: state.reads, tools: state.tools, issuedIds: state.issuedIds, diagnostics: state.diagnostics, blocked: state.blocked, startedUtcMs: state.time.startedUtcMs, expiresUtcMs: state.time.expiresUtcMs, terminalElapsedMs: state.time.terminalElapsedMs })
      if (!same(accounting(live), accounting(disk)) || live.time.utcHighWaterMs < disk.time.utcHighWaterMs || live.time.elapsedHighWaterMs < disk.time.elapsedHighWaterMs || disk.time.terminalElapsedMs !== null && !same(live.time, disk.time)) unavailable()
      if (folded.terminalOutcome !== null && folded.terminalOutcome !== fixedOutcome) unavailable()
      return { view, folded }
    }
    const persistPlan = async (plan: OriginalPlanMetadata): Promise<Readonly<{ plan: OriginalPlanMetadata; tail: WorkflowRecordReference }>> => {
      if (!controlled || !work || codec.version !== 'v2' || planIssued) invalid()
      planIssued = true
      await enqueue({ kind: 'plan', planHash: hashOriginalPlanMetadata(plan, prepared.spec, prepared.binding) }, position => exportBudgetLedgerState(ledger, createLedgerBinding(prepared.spec, position)), false, plan)
      const current = readReconciled()
      const latest = current.view.journal.at(-1)
      const persistedPlan = codec.plan(current.folded)
      if (!latest || current.folded.terminalOutcome !== null || (latest.payload as HostEnvelope).event.kind !== 'plan' || !persistedPlan || !same(persistedPlan, plan) || !current.folded.reference) unavailable()
      return Object.freeze({ plan: persistedPlan, tail: current.folded.reference })
    }
    const acceptTerminal = (current: ReturnType<typeof readReconciled>): WorkflowCancellationResolution | null => {
      const { view, folded } = current, manifest = view.manifest
      if (!manifest) return null
      // Terminal acceptance requires the latest full prefix, exact sole ledger component and real manifest.
      if (folded.terminalOutcome !== 'cancelled' && folded.terminalOutcome !== 'failed') unavailable()
      if (manifest.stage !== folded.terminalOutcome || !same(manifest.binding, prepared.binding) || !same(manifest.producingEpoch, view.currentEpoch) || !same(manifest.journalPosition, folded.reference) || view.components.length !== 1 || manifest.components.length !== 1 || view.components[0].reference.kind !== 'ledger' || view.components[0].reference.schemaId !== WORKFLOW_LEDGER_STATE_SCHEMA_ID || !same(manifest.components[0], view.components[0].reference) || !same(view.components[0].payload, folded.state)) unavailable()
      accepted = Object.freeze({ status: 'accepted', outcome: folded.terminalOutcome })
      metadataActive = false
      owned.finishAttempt(attempt)
      return accepted
    }
    const metadataTask = <T>(operation: () => Promise<T>): Promise<T> => {
      const task = queue.then(operation)
      queue = task.catch(() => {})
      return task
    }
    const storage: CancellationStorage = Object.freeze({
      ...(work ? { work } : {}),
      assertAvailable() { if (!controlled || !active || closing) invalid(); assertOwned(); if (work) ledger.assertCanContinue() },
      sealAdmission() {
        work?.seal()
        if (!active) return false
        active = false
        // Revoke W synchronously without blocking or otherwise changing L accounting.
        owned.finishAttempt(attempt)
        return true
      },
      async resolve(outcome: WorkflowCancellationOutcome): Promise<WorkflowCancellationResolution> {
        if (accepted) return accepted
        if (!controlled || active || closing || !['cancelled', 'failed'].includes(outcome)) return pendingResolution
        if (work) await work.drain()
        await queue
        try {
          let current = readReconciled()
          const persisted = acceptTerminal(current)
          if (persisted) return persisted
          owned.finishAttempt(attempt)
          metadataActive = false
          await metadataTask(async () => {
            attempt = await owned.beginAttempt(prepared.binding)
            info = owned.assertCurrent(attempt)
            if (!same(info.binding, prepared.binding)) unavailable()
            metadataActive = true
          })
          await enqueue({ kind: 'recovery', from: cursor.logicalPosition }, position => exportBudgetLedgerState(ledger, createLedgerBinding(prepared.spec, position)), true)
          if (cursor.terminalOutcome === null) {
            fixedOutcome ??= outcome
            await enqueue({ kind: 'seal', outcome: fixedOutcome }, position => {
              sealBudgetLedger(ledger)
              return exportBudgetLedgerState(ledger, createLedgerBinding(prepared.spec, position))
            }, true)
          }
          if (cursor.terminalOutcome !== fixedOutcome || !cursor.state) unavailable()
          const state = cursor.state, terminalOutcome = fixedOutcome!
          await metadataTask(() => owned.publish(attempt, { stage: terminalOutcome, components: [{ kind: 'ledger', payload: state }] }))
          await queue
          current = readReconciled()
          return acceptTerminal(current) ?? pendingResolution
        } catch {
          metadataActive = false
          owned.finishAttempt(attempt)
          await queue
          // A fully persisted terminal wins over a lost/rejected append or publish ack.
          try { return acceptTerminal(readReconciled()) ?? pendingResolution } catch { return pendingResolution }
        }
      },
      close: closeStorage
    })
    let toolOrdinal = 0, readOrdinal = 0
    const readIds = new Set<string>()
    const source: AwaitedToolAccounting = Object.freeze({
      async chargeTool() {
        if (!work || ++toolOrdinal > 8) invalid()
        const id = `original-tool:${toolOrdinal}`
        await enqueue({ kind: 'tool-charge', id, stage: 'investigation' }, position => {
          ledger.chargeTool(id, 'investigation')
          return exportBudgetLedgerState(ledger, createLedgerBinding(prepared.spec, position))
        })
      },
      async reserveRead(bytes: number) {
        if (!work || ++readOrdinal > 1024) invalid()
        const id = `original-read:${readOrdinal}`
        await enqueue({ kind: 'read-reservation', id, reservedBytes: bytes }, position => {
          ledger.reserveRead(id, bytes)
          return exportBudgetLedgerState(ledger, createLedgerBinding(prepared.spec, position))
        })
        readIds.add(id)
        return id
      },
      async settleRead(id: string, actualBytes: number) {
        if (!work || !readIds.has(id)) invalid()
        readIds.delete(id)
        await enqueue({ kind: 'read-receipt', id, actualBytes }, position => {
          ledger.settleRead(id, actualBytes)
          return exportBudgetLedgerState(ledger, createLedgerBinding(prepared.spec, position))
        })
      }
    })
    return { session, storage, source, tail: () => cursor.reference, persistPlan }
  } catch (error) {
    work?.seal()
    revoke?.()
    blockBudgetLedger(ledger)
    if (store) await store.close()
    if (error instanceof WorkflowError) throw error
    throw new WorkflowError('unreadable')
  }
}

interface ClassifiedPrefix {
  readonly binding: WorkflowRunBinding
  readonly currentEpoch: WorkflowProducingEpoch
  readonly reference: WorkflowRecordReference
  readonly position: LedgerJournalPosition
  readonly state: LedgerStateV1
  readonly manifestAnchor: Readonly<{ reference: WorkflowRecordReference; position: LedgerJournalPosition }> | null
}
export type WorkflowLedgerClassification =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unavailable'; code: string }>
  | Readonly<{ status: 'initialized-without-created'; binding: WorkflowRunBinding; currentEpoch: WorkflowProducingEpoch }>
  | (Readonly<{ status: 'verified-nonterminal' }> & ClassifiedPrefix)
  | (Readonly<{ status: 'terminal'; outcome: LedgerCriticalOutcome }> & ClassifiedPrefix)
  | Readonly<{ status: 'manifest-mismatch'; reason: 'anchor' | 'ledger' | 'terminal' }>

/** Genuine disk classification only: no restore, recovery authority or continuation is returned. */
export function classifyWorkflowLedger(input: Pick<WorkflowLedgerJournalOptions, 'storageDirectory' | 'spec'>): WorkflowLedgerClassification {
  const { prepared, options } = captureOptions(input, false)
  const view = readWorkflowStore(options, prepared.binding)
  if (view.status !== 'verified') return view
  try {
    if (!same(view.binding, prepared.binding)) unavailable()
    if (!view.journal.length) {
      if (view.manifest) return Object.freeze({ status: 'manifest-mismatch', reason: 'anchor' })
      return Object.freeze({ status: 'initialized-without-created', binding: view.binding, currentEpoch: view.currentEpoch })
    }
    const codec = codecForSchema(view.journal[0].schemaId, prepared.spec)
    const records: { payload: HostEnvelope; reference: WorkflowRecordReference }[] = []
    for (const item of view.journal) {
      const envelope = codec.validate(item.payload)
      if (item.schemaId !== codec.schemaId || item.sequence !== records.length + 1 || item.reference.id !== 'j-' + String(item.sequence).padStart(12, '0') || envelope.provenance.sequence !== item.sequence || !same(envelope.provenance.binding, view.binding) || !same(envelope.provenance.producingEpoch, item.reference.producingEpoch) || !same(envelope.provenance.previous, records.at(-1)?.reference ?? null)) unavailable()
      records.push({ payload: envelope, reference: item.reference })
    }
    // A1 deliberately accepts exact fresh projections, not W views with extra metadata.
    const cursor = codec.fold(records.map(item => ({ payload: item.payload, reference: item.reference })))
    const latest = view.journal.at(-1)!
    if (!cursor.state || !cursor.reference || !same(cursor.reference, latest.reference) || cursor.logicalPosition.sequence !== latest.sequence) unavailable()
    let manifestAnchor: ClassifiedPrefix['manifestAnchor'] = null
    if (view.manifest) {
      const manifest = view.manifest
      const index = records.findIndex(item => same(item.reference, manifest.journalPosition))
      if (index < 0) return Object.freeze({ status: 'manifest-mismatch', reason: 'anchor' })
      const anchored = codec.fold(records.slice(0, index + 1).map(item => ({ payload: item.payload, reference: item.reference })))
      const ledger = view.components.filter(item => item.reference.kind === 'ledger')
      if (ledger.length !== 1 || ledger[0].reference.schemaId !== WORKFLOW_LEDGER_STATE_SCHEMA_ID || !same(ledger[0].payload, anchored.state)) return Object.freeze({ status: 'manifest-mismatch', reason: 'ledger' })
      const terminal = ['completed', 'cancelled', 'failed'].includes(manifest.stage)
      if (terminal ? anchored.terminalOutcome !== manifest.stage : anchored.terminalOutcome !== null) return Object.freeze({ status: 'manifest-mismatch', reason: 'terminal' })
      manifestAnchor = Object.freeze({ reference: records[index].reference, position: anchored.logicalPosition })
    }
    const prefix: ClassifiedPrefix = { binding: view.binding, currentEpoch: view.currentEpoch, reference: latest.reference, position: cursor.logicalPosition, state: cursor.state, manifestAnchor }
    return cursor.terminalOutcome === null ? Object.freeze({ status: 'verified-nonterminal', ...prefix }) : Object.freeze({ status: 'terminal', outcome: cursor.terminalOutcome, ...prefix })
  } catch { return Object.freeze({ status: 'unavailable', code: 'ledger-prefix-invalid' }) }
}
