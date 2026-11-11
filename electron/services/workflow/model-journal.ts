import { createHash } from 'node:crypto'
import type { ChatMessage } from '../llm.ts'
import type { BudgetLedger, LedgerProjection, ModelStage, ModelUsage } from './budget-ledger.ts'
import type { RunSpec } from './run-spec.ts'
import type { LedgerBinding, LedgerJournalPosition, LedgerStateV1 } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { exportBudgetLedgerState, enableBudgetLedgerDurability } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { hashSemanticModelOperation, validateLedgerBinding, validateLedgerPosition } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'

export interface DurableOperationInput { readonly semanticHash: string; readonly manifestHash: string }
export interface DurableModelContext {
  readonly runId: string; readonly projectId: string; readonly snapshotId: string
  readonly attemptId: string; readonly fence: number; readonly id: string; readonly stage: ModelStage
  readonly semanticHash: string; readonly semanticOperationHash: string; readonly requestHash: string; readonly manifestHash: string
  readonly inputTokens: number; readonly outputTokens: number; readonly contextChars: number
}
export type DurableModelEvent = Readonly<{
  version: 1; kind: 'reservation' | 'intent' | 'receipt' | 'unknown'; context: DurableModelContext
  usage: ModelUsage | null
  /** Receipt alone never establishes stored output. The later manifest transaction owns it. */
  outputStatus: 'uncommitted' | 'missing'
  failureCode: 'none' | 'transport-protocol' | 'unavailable' | 'receipt-unavailable'
}>
/** Main-process, program-owned critical journal. It is deliberately separate from observational trace.
 * The caller supplies current authorization and cross-process writer ownership, and serializes its
 * fence check, position allocation, state build, append and durable flush. Resolution promises the
 * complete event+state is recoverable; rejection makes durability uncertain. This interface does
 * not implement store authority, a checkpoint manifest, stale-lock theft or cross-process atomicity. */
export interface DurableModelJournal {
  readonly binding: LedgerBinding
  readonly attemptId: string
  readonly fence: number
  assertCurrent(context: DurableModelContext): void
  appendAndFlush(event: DurableModelEvent, buildState: (position: LedgerJournalPosition) => LedgerStateV1): Promise<LedgerJournalPosition>
}
// This local sequencing keeps projected full-ledger snapshots consistent. It supplies no writer authority.
const ledgerWrites = new WeakMap<BudgetLedger, Promise<void>>()
const HASH = /^[a-f0-9]{64}$/
export function hashModelMessages(messages: readonly ChatMessage[]): string { return createHash('sha256').update(JSON.stringify(messages.map(message => ({ role: message.role, content: message.content })))).digest('hex') }
export function createDurableModelAdmission(spec: RunSpec, ledger: BudgetLedger, journal: DurableModelJournal) {
  let binding = validateLedgerBinding(spec, journal.binding)
  if (typeof journal.attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(journal.attemptId) || !Number.isSafeInteger(journal.fence) || journal.fence < 1 || typeof journal.assertCurrent !== 'function' || typeof journal.appendAndFlush !== 'function') throw new WorkflowError('invalid-argument')
  const attemptId = journal.attemptId; const fence = journal.fence
  enableBudgetLedgerDurability(ledger)
  return Object.freeze({
    context(id: string, stage: ModelStage, messages: readonly ChatMessage[], operation: DurableOperationInput | undefined, inputTokens: number, outputTokens: number): DurableModelContext {
      if (!operation || ![Object.prototype, null].includes(Object.getPrototypeOf(operation)) || Reflect.ownKeys(operation).length !== 2 || !['semanticHash', 'manifestHash'].every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(operation, key) ?? {}, 'value')) || typeof operation.semanticHash !== 'string' || typeof operation.manifestHash !== 'string' || !HASH.test(operation.semanticHash) || !HASH.test(operation.manifestHash)) throw new WorkflowError('invalid-argument')
      const requestHash = hashModelMessages(messages)
      const semanticOperationHash = hashSemanticModelOperation(spec, stage, operation.semanticHash)
      return Object.freeze({ runId: spec.runId, projectId: spec.projectId, snapshotId: spec.snapshotId, attemptId, fence, id, stage, semanticHash: operation.semanticHash, semanticOperationHash, requestHash, manifestHash: operation.manifestHash, inputTokens, outputTokens, contextChars: messages.reduce((sum, message) => sum + message.content.length, 0) })
    },
    assertCurrent(context: DurableModelContext, messages: readonly ChatMessage[]): void {
      if (journal.attemptId !== attemptId || journal.fence !== fence || hashModelMessages(messages) !== context.requestHash) throw new WorkflowError('configuration-changed')
      let result: void
      try { result = journal.assertCurrent(context) } catch (error) { if (error instanceof WorkflowError) throw error; throw new WorkflowError('configuration-changed') }
      // An asynchronous authorization check must never masquerade as the synchronous fence check.
      if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new WorkflowError('invalid-argument') }
    },
    async flush(event: DurableModelEvent, projection?: LedgerProjection, afterFlush?: () => void): Promise<void> {
      const prior = ledgerWrites.get(ledger) ?? Promise.resolve()
      const write = prior.then(async () => {
      let proposed: LedgerJournalPosition | null = null
      const committed = validateLedgerPosition(await journal.appendAndFlush(event, position => {
        if (proposed !== null) throw new WorkflowError('invalid-argument')
        proposed = validateLedgerPosition(position)
        if (proposed.sequence <= binding.journal.sequence) throw new WorkflowError('invalid-argument')
        return exportBudgetLedgerState(ledger, { ...binding, journal: proposed }, projection)
      }))
      if (proposed === null || committed.sequence !== (proposed as LedgerJournalPosition).sequence || committed.hash !== (proposed as LedgerJournalPosition).hash) throw new WorkflowError('invalid-argument')
      binding = Object.freeze({ ...binding, journal: committed })
      afterFlush?.()
      })
      ledgerWrites.set(ledger, write.catch(() => {}))
      await write
    }
  })
}
export function durableModelEvent(kind: DurableModelEvent['kind'], context: DurableModelContext, usage: ModelUsage | null = null, outputStatus: DurableModelEvent['outputStatus'] = 'uncommitted', failureCode: DurableModelEvent['failureCode'] = 'none'): DurableModelEvent {
  return Object.freeze({ version: 1, kind, context, usage, outputStatus, failureCode })
}
