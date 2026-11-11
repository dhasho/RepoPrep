import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { RunSpec } from './run-spec.ts'
import type { BudgetLedger } from './budget-ledger.ts'
import type { DurableModelContext, DurableModelEvent, DurableModelJournal } from './model-journal.ts'
import type { LedgerBinding, LedgerJournalPosition, LedgerStateV1 } from './ledger-state.ts'
import type { LedgerCriticalCursor, LedgerCriticalStep } from './ledger-critical-transitions.ts'
import type { PreparedCriticalSpec, LedgerCriticalEvent, LedgerCriticalEnvelopeV1, LedgerCriticalOutcome } from './ledger-critical-envelope.ts'
import type { WorkflowStore, WorkflowStoreOptions, WorkflowStoreLimits, WorkflowProducingEpoch, WorkflowRecordReference, WorkflowRunBinding } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { openWorkflowStore, readWorkflowStore } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createBudgetLedger, blockBudgetLedger, exportBudgetLedgerState } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerBinding, validateLedgerState } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LEDGER_CRITICAL_FORMAT, LEDGER_CRITICAL_SCHEMA_ID, prepareLedgerCriticalSpec, ledgerCriticalPosition, validateLedgerCriticalEnvelope, createLedgerCriticalPayloadValidator } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerCriticalCursor, checkLedgerCriticalTransition, acceptLedgerCriticalStep, foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'

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
function captureOptions(input: WorkflowLedgerJournalOptions, write: boolean) {
  const data = fields(input, write ? ['storageDirectory', 'spec', 'limits', 'onDurableStep'] : ['storageDirectory', 'spec'], ['storageDirectory', 'spec'])
  if (typeof data.storageDirectory !== 'string' || !data.storageDirectory.length) invalid()
  // A0 canonicalization happens once, before acquiring an asynchronous W owner.
  const prepared = prepareLedgerCriticalSpec({ spec: data.spec })
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
    storageDirectory: data.storageDirectory, validators: validators(prepared),
    ...(limits === undefined ? {} : { limits }),
    ...(data.onDurableStep === undefined ? {} : { onDurableStep: data.onDurableStep as WorkflowStoreOptions['onDurableStep'] })
  }
  return { prepared, options }
}
function validators(prepared: PreparedCriticalSpec): WorkflowStoreOptions['validators'] {
  return Object.freeze({
    'critical-journal': createLedgerCriticalPayloadValidator(),
    ledger: Object.freeze({ schemaId: WORKFLOW_LEDGER_STATE_SCHEMA_ID, validate(payload: unknown): boolean {
      try { validateLedgerState(prepared.spec, payload); return true } catch { return false }
    } })
  })
}

/** New logical runs only. This component grants storage/accounting, not project or provider permission. */
export function createWorkflowLedgerJournal(input: WorkflowLedgerJournalOptions): Promise<WorkflowLedgerJournalSession> {
  const { prepared, options } = captureOptions(input, true)
  const ledger = createBudgetLedger(prepared.spec, { durable: true })
  return initialize(prepared, options, ledger)
}
async function initialize(prepared: PreparedCriticalSpec, options: WorkflowStoreOptions, ledger: BudgetLedger): Promise<WorkflowLedgerJournalSession> {
  let store: WorkflowStore | undefined
  let revoke: (() => boolean) | undefined
  try {
    store = await openWorkflowStore(options)
    const owned = store
    // This read is under our genuine exclusive W owner. Every non-absent view is rejected.
    if (owned.read(prepared.binding).status !== 'absent') unavailable()
    const attempt = await owned.beginAttempt(prepared.binding)
    let active = true
    revoke = () => { active = false; blockBudgetLedger(ledger); return owned.finishAttempt(attempt) }
    const info = owned.assertCurrent(attempt)
    if (!same(info.binding, prepared.binding) || info.epoch.attempt !== 1) unavailable()
    let cursor = createLedgerCriticalCursor(prepared)
    let binding: LedgerBinding = createLedgerBinding(prepared.spec, prepared.genesis)
    let queue: Promise<unknown> = Promise.resolve()
    let closing: Promise<void> | undefined
    const poison = (): void => { revoke!() }
    const assertOwned = (): void => {
      if (!active) throw new WorkflowError('configuration-changed')
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
    const enqueue = (event: LedgerCriticalEvent, buildState: (position: LedgerJournalPosition) => LedgerStateV1): Promise<LedgerJournalPosition> => {
      const task = queue.then(async () => {
        try {
          assertOwned()
          let step: LedgerCriticalStep | undefined
          let bytes: Buffer | undefined
          let built = false
          const ack = await owned.appendJournal(attempt, context => {
            assertOwned()
            if (built || !same(context.binding, prepared.binding) || !same(context.producingEpoch, info.epoch) || context.sequence !== cursor.logicalPosition.sequence + 1 || !same(context.previous, cursor.reference)) unavailable()
            built = true
            const position = ledgerCriticalPosition(prepared, context, event)
            const state = buildState(position)
            const envelope = validateLedgerCriticalEnvelope({ format: LEDGER_CRITICAL_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance: context, event, logicalPosition: position, state }, prepared)
            step = checkLedgerCriticalTransition(cursor, envelope)
            // W's exact complete outer encoding, not the logical marker or payload alone.
            bytes = Buffer.from(JSON.stringify({ format: 'workflow-journal/v1', binding: context.binding, producingEpoch: context.producingEpoch, kind: 'critical-journal', schemaId: LEDGER_CRITICAL_SCHEMA_ID, payload: envelope, sequence: context.sequence, previous: context.previous }))
            return envelope
          })
          assertOwned()
          if (!built || !step || !bytes || ack.schemaId !== LEDGER_CRITICAL_SCHEMA_ID || ack.sequence !== step.logicalPosition.sequence || !same(ack.payload, step.envelope) || !same(ack.reference.producingEpoch, info.epoch) || ack.reference.id !== 'j-' + String(ack.sequence).padStart(12, '0') || ack.reference.byteLength !== bytes.length || ack.reference.sha256 !== createHash('sha256').update(bytes).digest('hex')) unavailable()
          cursor = acceptLedgerCriticalStep(step, ack.reference)
          binding = createLedgerBinding(prepared.spec, cursor.logicalPosition)
          return step.logicalPosition
        } catch { poison(); throw new WorkflowError('unreadable') }
      })
      queue = task.catch(() => {})
      return task
    }
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
    return Object.freeze({ spec: prepared.spec, ledger, journal, finish: revoke, close(): Promise<void> {
      if (!closing) {
        revoke!()
        // W close revokes synchronously and waits for the real pending writes/listener.
        const closed = owned.close()
        closing = Promise.all([queue, closed]).then(() => {})
      }
      return closing
    } })
  } catch (error) {
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
    const records: { payload: LedgerCriticalEnvelopeV1; reference: WorkflowRecordReference }[] = []
    for (const item of view.journal) {
      const envelope = validateLedgerCriticalEnvelope(item.payload, prepared)
      if (item.schemaId !== LEDGER_CRITICAL_SCHEMA_ID || item.sequence !== records.length + 1 || item.reference.id !== 'j-' + String(item.sequence).padStart(12, '0') || envelope.provenance.sequence !== item.sequence || !same(envelope.provenance.binding, view.binding) || !same(envelope.provenance.producingEpoch, item.reference.producingEpoch) || !same(envelope.provenance.previous, records.at(-1)?.reference ?? null)) unavailable()
      records.push({ payload: envelope, reference: item.reference })
    }
    // A1 deliberately accepts exact fresh projections, not W views with extra metadata.
    const cursor: LedgerCriticalCursor = foldLedgerCriticalPrefix(records.map(item => ({ payload: item.payload, reference: item.reference })))
    const latest = view.journal.at(-1)!
    if (!cursor.state || !cursor.reference || !same(cursor.reference, latest.reference) || cursor.logicalPosition.sequence !== latest.sequence) unavailable()
    let manifestAnchor: ClassifiedPrefix['manifestAnchor'] = null
    if (view.manifest) {
      const manifest = view.manifest
      const index = records.findIndex(item => same(item.reference, manifest.journalPosition))
      if (index < 0) return Object.freeze({ status: 'manifest-mismatch', reason: 'anchor' })
      const anchored = foldLedgerCriticalPrefix(records.slice(0, index + 1).map(item => ({ payload: item.payload, reference: item.reference })))
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
