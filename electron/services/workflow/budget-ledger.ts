import type { RunSpec } from './run-spec.ts'
import { performance } from 'node:perf_hooks'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { CONTEXT_CHAR_BUDGETS } from '../../../shared/context-budget.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'

export type ModelStage = 'investigation' | 'generation' | 'review' | 'repair' | 'compensation'
export interface ModelReservation { readonly id: string; readonly stage: ModelStage; readonly inputTokens: number; readonly outputTokens: number; readonly contextChars?: number }
export interface ModelUsage { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }
export interface BudgetLedgerOptions { readonly clock?: () => number }

interface ModelEntry extends Omit<ModelReservation, 'contextChars'> { readonly contextChars: number | null; state: 'reserved' | 'unknown-unsent' | 'dispatched' | 'settled' | 'unknown'; usage: ModelUsage | null }
interface ReadEntry { readonly id: string; readonly reservedBytes: number; state: 'reserved' | 'settled'; actualBytes: number | null }
interface ToolEntry { readonly id: string; readonly stage: ModelStage }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STAGES: readonly ModelStage[] = ['investigation', 'generation', 'review', 'repair', 'compensation']
const MAX_ENTRIES = 100_000

function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new WorkflowError('invalid-argument')
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new WorkflowError('invalid-argument')
}
function validStage(value: unknown): asserts value is ModelStage {
  if (typeof value !== 'string' || !STAGES.includes(value as ModelStage)) throw new WorkflowError('invalid-argument')
}
function add(a: number, b: number): number { const value = a + b; return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER }
function usageReceipt(value: unknown): ModelUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  const input = r.inputTokens; const output = r.outputTokens; const total = r.totalTokens
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || !Number.isSafeInteger(total) || Number(input) < 0 || Number(output) < 0 || Number(total) < 0 || Number(total) !== Number(input) + Number(output)) return null
  return Object.freeze({ inputTokens: Number(input), outputTokens: Number(output), totalTokens: Number(total) })
}

export interface BudgetLedgerSnapshot {
  readonly elapsedMs: number
  readonly blocked: boolean
  readonly usageComplete: boolean
  readonly overspend: Readonly<{ inputTokens: number; outputTokens: number; readBytes: number }>
  readonly metrics: Readonly<{ overspendAdmissions: number; doubleSettlements: number; unknownUsageTreatedAsZero: number; generationReserveProtected: boolean }>
  /** inputTokens/outputTokens are conservative charged totals (actual receipt or retained reservation). */
  readonly total: Readonly<{ dispatchedRequests: number; reservedRequests: number; inputTokens: number; outputTokens: number; estimatedInputTokens: number; actualProviderUsage: Readonly<ModelUsage> | null; readBytes: number; toolCalls: number }>
  readonly remaining: Readonly<{ modelRequests: number; inputTokens: number; outputTokens: number; readBytes: number; toolCalls: number; investigationRequests: number; investigationInputTokens: number; investigationOutputTokens: number; investigationReadBytes: number; investigationToolCalls: number; investigationWallClockMs: number }>
  readonly byStage: Readonly<Record<ModelStage, Readonly<{ dispatchedRequests: number; reservedRequests: number; inputTokens: number; outputTokens: number; estimatedInputTokens: number }>>>
  readonly reservations: readonly (Readonly<ModelEntry> & Readonly<{ estimatedInputTokens: number }>)[]
}

export interface BudgetLedger {
  reserveModel(value: ModelReservation): void
  markDispatched(id: string): void
  /** Keep a reserved slot when a transport violates the pre-request guard protocol. */
  markUnknownUnsent(id: string): void
  releaseUnsent(id: string): void
  settleModel(id: string, usage: unknown | null): void
  reserveRead(id: string, bytes: number): void
  settleRead(id: string, actualBytes: number): void
  /** Release only when the caller can prove no project I/O was attempted. */
  releaseRead(id: string): void
  chargeRead(id: string, bytes: number): void
  chargeTool(id: string, stage?: ModelStage): void
  assertCanContinue(stage?: ModelStage): void
  markUnknownRecovery(value: ModelReservation): void
  snapshot(): BudgetLedgerSnapshot
}

export function createBudgetLedger(spec: RunSpec, options: BudgetLedgerOptions = {}): BudgetLedger {
  const now = options.clock ?? performance.now.bind(performance)
  const started = now()
  if (typeof started !== 'number' || !Number.isFinite(started)) throw new WorkflowError('invalid-argument')
  let lastNow = started
  const models = new Map<string, ModelEntry>()
  const reads = new Map<string, ReadEntry>()
  const tools = new Map<string, ToolEntry>()
  const issuedIds = new Set<string>()
  let dispatchedRequests = 0; let reservedRequests = 0
  let inputTokens = 0; let outputTokens = 0; let readBytes = 0; let toolCalls = 0
  let investigationInput = 0; let investigationOutput = 0; let investigationRequests = 0; let investigationReadBytes = 0; let investigationTools = 0
  let blocked = false; let overspendInputTokens = 0; let overspendOutputTokens = 0; let overspendReadBytes = 0
  let overspendAdmissions = 0; let doubleSettlements = 0; let unknownUsageTreatedAsZero = 0

  const sampleTime = (): number => {
    const value = now()
    if (typeof value !== 'number' || !Number.isFinite(value) || value < lastNow) throw new WorkflowError('invalid-argument')
    lastNow = value
    return value
  }
  const elapsed = (): number => sampleTime() - started
  const ensureTime = (stage?: ModelStage): void => {
    const duration = elapsed()
    if (duration >= spec.budget.total.wallClockMs || (stage === 'investigation' && duration >= spec.budget.investigation.wallClockMs)) throw new WorkflowError('budget-exhausted')
  }
  const budgetExhausted = (): never => { throw new WorkflowError('budget-exhausted') }
  const ensureModelCapacity = (stage: ModelStage, input: number, output: number): void => {
    ensureTime(stage)
    if (blocked) budgetExhausted()
    const total = spec.budget.total
    if (dispatchedRequests + reservedRequests + 1 > total.maxModelRequests || add(inputTokens, input) > total.inputTokens || add(outputTokens, output) > total.outputTokens) budgetExhausted()
    if (stage === 'investigation') {
      const inv = spec.budget.investigation
      if (investigationRequests + 1 > inv.maxModelRequests || add(investigationInput, input) > inv.inputTokens || add(investigationOutput, output) > inv.outputTokens) budgetExhausted()
    }
  }
  const unique = (id: string): void => {
    validId(id)
    if (issuedIds.has(id) || models.has(id) || reads.has(id) || tools.has(id)) throw new WorkflowError('invalid-argument')
    if (issuedIds.size >= MAX_ENTRIES) budgetExhausted()
  }
  const settleUnknown = (entry: ModelEntry): void => {
    entry.state = 'unknown'
    entry.usage = null
    // Keep its full token reservation in the consumed counters. It is neither zero usage nor refundable.
  }
  const ledger: BudgetLedger = {
    reserveModel(value) {
      validId(value?.id); validStage(value?.stage); integer(value?.inputTokens); integer(value?.outputTokens); if (value.contextChars !== undefined) integer(value.contextChars); unique(value.id)
      if (value.contextChars !== undefined && value.contextChars > CONTEXT_CHAR_BUDGETS[spec.granularity]) throw new WorkflowError('budget-exhausted')
      ensureModelCapacity(value.stage, value.inputTokens, value.outputTokens)
      const entry: ModelEntry = { id: value.id, stage: value.stage, inputTokens: value.inputTokens, outputTokens: value.outputTokens, contextChars: value.contextChars ?? null, state: 'reserved', usage: null }
      models.set(value.id, entry)
      issuedIds.add(value.id)
      reservedRequests++; inputTokens += value.inputTokens; outputTokens += value.outputTokens
      if (value.stage === 'investigation') { investigationRequests++; investigationInput += value.inputTokens; investigationOutput += value.outputTokens }
    },
    markDispatched(id) {
      validId(id); const entry = models.get(id)
      if (!entry || entry.state !== 'reserved') throw new WorkflowError('invalid-argument')
      ensureTime(entry.stage); if (blocked || dispatchedRequests + 1 > spec.budget.total.maxModelRequests) budgetExhausted()
      entry.state = 'dispatched'; reservedRequests--; dispatchedRequests++
    },
    markUnknownUnsent(id) {
      validId(id); const entry = models.get(id)
      if (!entry || entry.state !== 'reserved') throw new WorkflowError('invalid-argument')
      entry.state = 'unknown-unsent'
      // Retain both token and request reservations. A broken transport cannot return an unmetered result.
    },
    releaseUnsent(id) {
      validId(id); const entry = models.get(id)
      if (!entry || entry.state !== 'reserved') throw new WorkflowError('invalid-argument')
      models.delete(id); reservedRequests--; inputTokens -= entry.inputTokens; outputTokens -= entry.outputTokens
      if (entry.stage === 'investigation') { investigationRequests--; investigationInput -= entry.inputTokens; investigationOutput -= entry.outputTokens }
    },
    settleModel(id, rawUsage) {
      validId(id); const entry = models.get(id)
      if (!entry || entry.state !== 'dispatched') throw new WorkflowError('invalid-argument')
      const usage = usageReceipt(rawUsage)
      if (!usage) { settleUnknown(entry); return }
      const overInput = Math.max(0, usage.inputTokens - entry.inputTokens)
      const overOutput = Math.max(0, usage.outputTokens - entry.outputTokens)
      inputTokens = Math.max(0, inputTokens - entry.inputTokens + usage.inputTokens)
      outputTokens = Math.max(0, outputTokens - entry.outputTokens + usage.outputTokens)
      if (entry.stage === 'investigation') {
        investigationInput = Math.max(0, investigationInput - entry.inputTokens + usage.inputTokens)
        investigationOutput = Math.max(0, investigationOutput - entry.outputTokens + usage.outputTokens)
      }
      entry.state = 'settled'; entry.usage = usage
      if (overInput || overOutput) {
        overspendInputTokens += overInput; overspendOutputTokens += overOutput; blocked = true
      }
      if (inputTokens > spec.budget.total.inputTokens || outputTokens > spec.budget.total.outputTokens || (entry.stage === 'investigation' && (investigationInput > spec.budget.investigation.inputTokens || investigationOutput > spec.budget.investigation.outputTokens))) blocked = true
    },
    reserveRead(id, bytes) {
      validId(id); integer(bytes); unique(id); ensureTime('investigation')
      if (blocked || add(readBytes, bytes) > spec.budget.total.readBytes || add(investigationReadBytes, bytes) > spec.budget.investigation.readBytes) {
        budgetExhausted()
      }
      reads.set(id, { id, reservedBytes: bytes, state: 'reserved', actualBytes: null }); issuedIds.add(id); readBytes += bytes; investigationReadBytes += bytes
    },
    settleRead(id, actualBytes) {
      validId(id); integer(actualBytes); const entry = reads.get(id)
      if (!entry || entry.state !== 'reserved') throw new WorkflowError('invalid-argument')
      entry.state = 'settled'; entry.actualBytes = actualBytes
      if (actualBytes > entry.reservedBytes) { const over = actualBytes - entry.reservedBytes; overspendReadBytes += over; readBytes += over; investigationReadBytes += over; blocked = true }
      else { readBytes -= entry.reservedBytes - actualBytes; investigationReadBytes -= entry.reservedBytes - actualBytes }
    },
    releaseRead(id) {
      validId(id); const entry = reads.get(id)
      if (!entry || entry.state !== 'reserved') throw new WorkflowError('invalid-argument')
      reads.delete(id); readBytes -= entry.reservedBytes; investigationReadBytes -= entry.reservedBytes
    },
    chargeRead(id, bytes) {
      ledger.reserveRead(id, bytes); ledger.settleRead(id, bytes)
    },
    chargeTool(id, stage = 'investigation') {
      validId(id); validStage(stage); unique(id); ensureTime(stage)
      const totalLimit = spec.budget.total.maxToolCalls
      if (blocked || (totalLimit !== undefined && toolCalls + 1 > totalLimit) || (stage === 'investigation' && investigationTools + 1 > (spec.budget.investigation.maxToolCalls ?? 0))) budgetExhausted()
      tools.set(id, { id, stage }); issuedIds.add(id); toolCalls++
      if (stage === 'investigation') investigationTools++
    },
    assertCanContinue(stage) { ensureTime(stage); if (blocked) budgetExhausted() },
    markUnknownRecovery(value) {
      validId(value?.id); validStage(value?.stage); integer(value?.inputTokens); integer(value?.outputTokens); unique(value.id)
      if (value.contextChars !== undefined) integer(value.contextChars)
      if (value.contextChars !== undefined && value.contextChars > CONTEXT_CHAR_BUDGETS[spec.granularity]) throw new WorkflowError('budget-exhausted')
      // Recovered sent work counts as an actual attempt, and its maximum reservation remains charged.
      const entry: ModelEntry = { id: value.id, stage: value.stage, inputTokens: value.inputTokens, outputTokens: value.outputTokens, contextChars: value.contextChars ?? null, state: 'unknown', usage: null }
      models.set(value.id, entry); issuedIds.add(value.id); dispatchedRequests++
      inputTokens = add(inputTokens, value.inputTokens); outputTokens = add(outputTokens, value.outputTokens)
      if (value.stage === 'investigation') { investigationRequests++; investigationInput = add(investigationInput, value.inputTokens); investigationOutput = add(investigationOutput, value.outputTokens) }
      if (dispatchedRequests > spec.budget.total.maxModelRequests || inputTokens > spec.budget.total.inputTokens || outputTokens > spec.budget.total.outputTokens || (value.stage === 'investigation' && (investigationRequests > spec.budget.investigation.maxModelRequests || investigationInput > spec.budget.investigation.inputTokens || investigationOutput > spec.budget.investigation.outputTokens))) blocked = true
    },
    snapshot() {
      const modelEntries = [...models.values()]
      const usageComplete = modelEntries.every(entry => entry.state === 'settled' || entry.state === 'reserved')
      const actualUsages = modelEntries.filter(entry => entry.state !== 'reserved').map(entry => entry.usage)
      const actualProviderUsage = usageComplete && actualUsages.every((usage): usage is ModelUsage => usage !== null)
        ? Object.freeze(actualUsages.reduce((sum, usage) => ({ inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens, totalTokens: sum.totalTokens + usage.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
        : null
      const byStage = Object.fromEntries(STAGES.map(stage => {
        const entries = [...models.values()].filter(entry => entry.stage === stage)
        return [stage, Object.freeze({ dispatchedRequests: entries.filter(entry => ['dispatched', 'settled', 'unknown'].includes(entry.state)).length, reservedRequests: entries.filter(entry => entry.state === 'reserved' || entry.state === 'unknown-unsent').length, inputTokens: entries.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? entry.inputTokens), 0), outputTokens: entries.reduce((sum, entry) => sum + (entry.usage?.outputTokens ?? entry.outputTokens), 0), estimatedInputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0) })]
      })) as Record<ModelStage, Readonly<{ dispatchedRequests: number; reservedRequests: number; inputTokens: number; outputTokens: number; estimatedInputTokens: number }>>
      return Object.freeze({
        elapsedMs: elapsed(), blocked,
        usageComplete,
        overspend: Object.freeze({ inputTokens: overspendInputTokens, outputTokens: overspendOutputTokens, readBytes: overspendReadBytes }),
        metrics: Object.freeze({ overspendAdmissions, doubleSettlements, unknownUsageTreatedAsZero, generationReserveProtected: investigationRequests <= spec.budget.investigation.maxModelRequests && investigationInput <= spec.budget.investigation.inputTokens && investigationOutput <= spec.budget.investigation.outputTokens && investigationReadBytes <= spec.budget.investigation.readBytes && investigationTools <= (spec.budget.investigation.maxToolCalls ?? 0) }),
        total: Object.freeze({ dispatchedRequests, reservedRequests, inputTokens, outputTokens, estimatedInputTokens: modelEntries.reduce((sum, entry) => sum + entry.inputTokens, 0), actualProviderUsage, readBytes, toolCalls }),
        remaining: Object.freeze({
          modelRequests: Math.max(0, spec.budget.total.maxModelRequests - dispatchedRequests - reservedRequests),
          inputTokens: Math.max(0, spec.budget.total.inputTokens - inputTokens),
          outputTokens: Math.max(0, spec.budget.total.outputTokens - outputTokens),
          readBytes: Math.max(0, spec.budget.total.readBytes - readBytes),
          toolCalls: Math.max(0, (spec.budget.total.maxToolCalls ?? MAX_ENTRIES) - toolCalls),
          investigationRequests: Math.max(0, spec.budget.investigation.maxModelRequests - investigationRequests),
          investigationInputTokens: Math.max(0, spec.budget.investigation.inputTokens - investigationInput),
          investigationOutputTokens: Math.max(0, spec.budget.investigation.outputTokens - investigationOutput),
          investigationReadBytes: Math.max(0, spec.budget.investigation.readBytes - investigationReadBytes),
          investigationToolCalls: Math.max(0, (spec.budget.investigation.maxToolCalls ?? 0) - investigationTools),
          investigationWallClockMs: Math.max(0, spec.budget.investigation.wallClockMs - elapsed())
        }),
        byStage: Object.freeze(byStage),
        reservations: Object.freeze(modelEntries.map(entry => Object.freeze({ ...entry, estimatedInputTokens: entry.inputTokens })))
      })
    }
  }
  return Object.freeze(ledger)
}
