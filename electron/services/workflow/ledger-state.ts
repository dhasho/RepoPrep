import { createHash } from 'node:crypto'
import type { RunSpec } from './run-spec.ts'
import type { ModelStage, ModelUsage } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { fingerprintRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { CONTEXT_CHAR_BUDGETS } from '../../../shared/context-budget.ts'

export const LEDGER_STATE_MAX_BYTES = 64 * 1024 * 1024
export const LEDGER_MAX_ISSUED_IDS = 100_000
export interface LedgerJournalPosition { readonly sequence: number; readonly hash: string }
export interface LedgerBinding {
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly configurationHash: string
  readonly schemaVersion: 1
  readonly policyVersion: string
  readonly journal: LedgerJournalPosition
}
export type LedgerModelState = 'reserved' | 'unknown-unsent' | 'dispatched' | 'settled' | 'unknown'
export interface LedgerModelRecord {
  readonly id: string; readonly stage: ModelStage; readonly inputTokens: number; readonly outputTokens: number
  readonly contextChars: number | null; readonly state: LedgerModelState; readonly usage: ModelUsage | null
  readonly semanticHash: string | null; readonly semanticOperationHash: string | null
  readonly requestHash: string | null; readonly manifestHash: string | null
}
export interface LedgerReadRecord { readonly id: string; readonly reservedBytes: number; readonly state: 'reserved' | 'settled'; readonly actualBytes: number | null }
export interface LedgerToolRecord { readonly id: string; readonly stage: ModelStage }
export interface LedgerDiagnostics {
  readonly overspendInputTokens: number; readonly overspendOutputTokens: number; readonly overspendReadBytes: number
  readonly overspendAdmissions: number; readonly doubleSettlements: number; readonly unknownUsageTreatedAsZero: number
}
export interface LedgerStateV1 {
  readonly version: 1
  readonly binding: LedgerBinding
  readonly time: Readonly<{ startedUtcMs: number; expiresUtcMs: number; utcHighWaterMs: number; elapsedHighWaterMs: number; terminalElapsedMs: number | null }>
  readonly blocked: boolean
  readonly diagnostics: LedgerDiagnostics
  readonly models: readonly LedgerModelRecord[]
  readonly reads: readonly LedgerReadRecord[]
  readonly tools: readonly LedgerToolRecord[]
  readonly issuedIds: readonly string[]
}
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STAGES = ['investigation', 'generation', 'review', 'repair', 'compensation']
const STATES = ['reserved', 'unknown-unsent', 'dispatched', 'settled', 'unknown']
function invalid(): never { throw new WorkflowError('invalid-argument') }
export function ledgerInteger(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(); return value }
function text(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value }
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length) invalid()
  for (const key of own) if (typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')) invalid()
  return value as Record<string, unknown>
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > LEDGER_MAX_ISSUED_IDS || Reflect.ownKeys(value).length !== value.length + 1) invalid()
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, 'value')) invalid()
  return value
}
function sum(a: number, b: number): number { return ledgerInteger(a + b) }
function stage(value: unknown): ModelStage { if (typeof value !== 'string' || !STAGES.includes(value)) invalid(); return value as ModelStage }
function sort<T extends { readonly id: string }>(values: T[]): readonly T[] { return Object.freeze(values.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
/** Stable logical identity. Rendered inputs and output cap are separate immutable commitments. */
export function hashSemanticModelOperation(spec: RunSpec, modelStage: ModelStage, semanticHash: string): string {
  return createHash('sha256').update(JSON.stringify(['repoprep.workflow.model-operation.v1', spec.runId, spec.projectId, spec.snapshotId, fingerprintRunSpec(spec), stage(modelStage), text(semanticHash, HASH)])).digest('hex')
}
export function validateLedgerPosition(value: unknown): LedgerJournalPosition {
  const r = shape(value, ['sequence', 'hash'])
  return Object.freeze({ sequence: ledgerInteger(r.sequence), hash: text(r.hash, HASH) })
}
export function validateLedgerBinding(spec: RunSpec, value: unknown): LedgerBinding {
  const b = shape(value, ['runId', 'projectId', 'snapshotId', 'configurationHash', 'schemaVersion', 'policyVersion', 'journal'])
  if (b.runId !== spec.runId || b.projectId !== spec.projectId || b.snapshotId !== spec.snapshotId || b.configurationHash !== fingerprintRunSpec(spec) || b.schemaVersion !== 1 || b.policyVersion !== spec.policyVersion) throw new WorkflowError('configuration-changed')
  return Object.freeze({ runId: text(b.runId, ID), projectId: text(b.projectId, ID), snapshotId: text(b.snapshotId, ID), configurationHash: text(b.configurationHash, HASH), schemaVersion: 1, policyVersion: text(b.policyVersion, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}-v[1-9][0-9]{0,3}$/), journal: validateLedgerPosition(b.journal) })
}
export function createLedgerBinding(spec: RunSpec, journal: LedgerJournalPosition): LedgerBinding {
  return validateLedgerBinding(spec, { runId: spec.runId, projectId: spec.projectId, snapshotId: spec.snapshotId, configurationHash: fingerprintRunSpec(spec), schemaVersion: 1, policyVersion: spec.policyVersion, journal })
}
export function validateLedgerUsage(value: unknown): ModelUsage {
  const u = shape(value, ['inputTokens', 'outputTokens', 'totalTokens'])
  const inputTokens = ledgerInteger(u.inputTokens); const outputTokens = ledgerInteger(u.outputTokens); const totalTokens = ledgerInteger(u.totalTokens)
  if (sum(inputTokens, outputTokens) !== totalTokens) invalid()
  return Object.freeze({ inputTokens, outputTokens, totalTokens })
}
/** JSON never grants project/store authority. The caller verifies committed hashes and authorization separately. */
export function validateLedgerState(spec: RunSpec, value: unknown): LedgerStateV1 {
  try { return parseLedgerState(spec, value) } catch (error) { if (error instanceof WorkflowError) throw error; return invalid() }
}
function parseLedgerState(spec: RunSpec, value: unknown): LedgerStateV1 {
  const r = shape(value, ['version', 'binding', 'time', 'blocked', 'diagnostics', 'models', 'reads', 'tools', 'issuedIds'])
  if (r.version !== 1 || typeof r.blocked !== 'boolean') invalid()
  const binding = validateLedgerBinding(spec, r.binding)
  const t = shape(r.time, ['startedUtcMs', 'expiresUtcMs', 'utcHighWaterMs', 'elapsedHighWaterMs', 'terminalElapsedMs'])
  const time = Object.freeze({ startedUtcMs: ledgerInteger(t.startedUtcMs), expiresUtcMs: ledgerInteger(t.expiresUtcMs), utcHighWaterMs: ledgerInteger(t.utcHighWaterMs), elapsedHighWaterMs: ledgerInteger(t.elapsedHighWaterMs), terminalElapsedMs: t.terminalElapsedMs === null ? null : ledgerInteger(t.terminalElapsedMs) })
  if (time.terminalElapsedMs !== null && time.terminalElapsedMs !== time.elapsedHighWaterMs) invalid()
  if (time.expiresUtcMs !== sum(time.startedUtcMs, spec.budget.total.wallClockMs) || spec.budget.total.wallClockMs > 600_000 || time.utcHighWaterMs < time.startedUtcMs || time.elapsedHighWaterMs < time.utcHighWaterMs - time.startedUtcMs) invalid()
  const ids = list(r.issuedIds).map(v => text(v, ID))
  const issued = new Set(ids); const live = new Set<string>(); const operations = new Set<string>()
  if (issued.size !== ids.length) invalid()
  const claim = (id: string): void => { if (!issued.has(id) || live.has(id)) invalid(); live.add(id) }
  let input = 0; let output = 0; let read = 0; let estimated = 0; let usageTotal = 0
  let overInput = 0; let overOutput = 0; let overRead = 0
  const models = sort(list(r.models).map(value => {
    const m = shape(value, ['id', 'stage', 'inputTokens', 'outputTokens', 'contextChars', 'state', 'usage', 'semanticHash', 'semanticOperationHash', 'requestHash', 'manifestHash'])
    const id = text(m.id, ID); claim(id)
    const inputTokens = ledgerInteger(m.inputTokens); const outputTokens = ledgerInteger(m.outputTokens)
    const contextChars = m.contextChars === null ? null : ledgerInteger(m.contextChars)
    if (contextChars !== null && contextChars > CONTEXT_CHAR_BUDGETS[spec.granularity] || typeof m.state !== 'string' || !STATES.includes(m.state)) invalid()
    const state = m.state as LedgerModelState
    const usage = m.usage === null ? null : validateLedgerUsage(m.usage)
    if ((state === 'settled') !== (usage !== null)) invalid()
    const modelStage = stage(m.stage)
    const semanticHash = m.semanticHash === null ? null : text(m.semanticHash, HASH)
    const semanticOperationHash = m.semanticOperationHash === null ? null : text(m.semanticOperationHash, HASH)
    const requestHash = m.requestHash === null ? null : text(m.requestHash, HASH)
    const manifestHash = m.manifestHash === null ? null : text(m.manifestHash, HASH)
    if ([semanticOperationHash, requestHash, manifestHash].some(hash => (hash === null) !== (semanticHash === null))) invalid()
    if (semanticOperationHash !== null) {
      if (contextChars === null || semanticOperationHash !== hashSemanticModelOperation(spec, modelStage, semanticHash!) || operations.has(semanticOperationHash)) invalid()
      operations.add(semanticOperationHash)
    }
    input = sum(input, usage?.inputTokens ?? inputTokens); output = sum(output, usage?.outputTokens ?? outputTokens); estimated = sum(estimated, inputTokens); usageTotal = sum(usageTotal, usage?.totalTokens ?? 0)
    overInput = sum(overInput, Math.max(0, (usage?.inputTokens ?? 0) - inputTokens)); overOutput = sum(overOutput, Math.max(0, (usage?.outputTokens ?? 0) - outputTokens))
    return Object.freeze({ id, stage: modelStage, inputTokens, outputTokens, contextChars, state, usage, semanticHash, semanticOperationHash, requestHash, manifestHash })
  }))
  const reads = sort(list(r.reads).map(value => {
    const v = shape(value, ['id', 'reservedBytes', 'state', 'actualBytes']); const id = text(v.id, ID); claim(id)
    const reservedBytes = ledgerInteger(v.reservedBytes); const actualBytes = v.actualBytes === null ? null : ledgerInteger(v.actualBytes)
    if ((typeof v.state !== 'string' || !['reserved', 'settled'].includes(v.state)) || (v.state === 'settled') !== (actualBytes !== null)) invalid()
    read = sum(read, actualBytes ?? reservedBytes); overRead = sum(overRead, Math.max(0, (actualBytes ?? 0) - reservedBytes))
    return Object.freeze({ id, reservedBytes, state: v.state as 'reserved' | 'settled', actualBytes })
  }))
  const tools = sort(list(r.tools).map(value => { const v = shape(value, ['id', 'stage']); const id = text(v.id, ID); claim(id); return Object.freeze({ id, stage: stage(v.stage) }) }))
  const d = shape(r.diagnostics, ['overspendInputTokens', 'overspendOutputTokens', 'overspendReadBytes', 'overspendAdmissions', 'doubleSettlements', 'unknownUsageTreatedAsZero'])
  const diagnostics = Object.freeze({ overspendInputTokens: ledgerInteger(d.overspendInputTokens), overspendOutputTokens: ledgerInteger(d.overspendOutputTokens), overspendReadBytes: ledgerInteger(d.overspendReadBytes), overspendAdmissions: ledgerInteger(d.overspendAdmissions), doubleSettlements: ledgerInteger(d.doubleSettlements), unknownUsageTreatedAsZero: ledgerInteger(d.unknownUsageTreatedAsZero) })
  if (diagnostics.overspendInputTokens < overInput || diagnostics.overspendOutputTokens < overOutput || diagnostics.overspendReadBytes < overRead) invalid()
  const result = Object.freeze({ version: 1 as const, binding, time, blocked: r.blocked, diagnostics, models, reads, tools, issuedIds: Object.freeze(ids.sort()) })
  if (worstCaseLedgerBytes(result) > LEDGER_STATE_MAX_BYTES) invalid()
  return result
}
/** Reserve space for every record's largest possible future state, including a complete receipt.
 * All strings are bounded ASCII; JSON byte length is exact here. The metadata envelope is calculated from the same bounded fields. */
const MAX_NUMBER = Number.MAX_SAFE_INTEGER
const MAX_METADATA_BYTES = Buffer.byteLength(JSON.stringify({
  version: 1,
  binding: { runId: 'a'.repeat(128), projectId: 'a'.repeat(128), snapshotId: 'a'.repeat(128), configurationHash: 'a'.repeat(64), schemaVersion: 1, policyVersion: 'a'.repeat(64) + '-v1234', journal: { sequence: MAX_NUMBER, hash: 'a'.repeat(64) } },
  time: { startedUtcMs: MAX_NUMBER, expiresUtcMs: MAX_NUMBER, utcHighWaterMs: MAX_NUMBER, elapsedHighWaterMs: MAX_NUMBER, terminalElapsedMs: MAX_NUMBER },
  blocked: false,
  diagnostics: { overspendInputTokens: MAX_NUMBER, overspendOutputTokens: MAX_NUMBER, overspendReadBytes: MAX_NUMBER, overspendAdmissions: MAX_NUMBER, doubleSettlements: MAX_NUMBER, unknownUsageTreatedAsZero: MAX_NUMBER },
  models: [], reads: [], tools: [], issuedIds: []
}))
const MAX_MODEL_BYTES = Buffer.byteLength(JSON.stringify({ id: 'a'.repeat(128), stage: 'investigation', inputTokens: MAX_NUMBER, outputTokens: MAX_NUMBER, contextChars: MAX_NUMBER, state: 'unknown-unsent', usage: { inputTokens: MAX_NUMBER, outputTokens: MAX_NUMBER, totalTokens: MAX_NUMBER }, semanticHash: 'a'.repeat(64), semanticOperationHash: 'a'.repeat(64), requestHash: 'a'.repeat(64), manifestHash: 'a'.repeat(64) })) + 1
const MAX_READ_BYTES = Buffer.byteLength(JSON.stringify({ id: 'a'.repeat(128), reservedBytes: MAX_NUMBER, state: 'reserved', actualBytes: MAX_NUMBER })) + 1
const MAX_TOOL_BYTES = Buffer.byteLength(JSON.stringify({ id: 'a'.repeat(128), stage: 'investigation' })) + 1
export function worstCaseLedgerBytes(counts: { readonly models: { readonly length: number }; readonly reads: { readonly length: number }; readonly tools: { readonly length: number }; readonly issuedIds: { readonly length: number } }): number {
  return MAX_METADATA_BYTES + counts.models.length * MAX_MODEL_BYTES + counts.reads.length * MAX_READ_BYTES + counts.tools.length * MAX_TOOL_BYTES + counts.issuedIds.length * 131
}
export function encodeLedgerState(spec: RunSpec, value: unknown): string { const state = validateLedgerState(spec, value); const json = JSON.stringify(state); if (Buffer.byteLength(json) > LEDGER_STATE_MAX_BYTES) invalid(); return json }
export function decodeLedgerState(spec: RunSpec, bytes: string | Uint8Array): LedgerStateV1 {
  if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) invalid()
  if ((typeof bytes === 'string' ? bytes.length : bytes.byteLength) > LEDGER_STATE_MAX_BYTES) invalid()
  if (typeof bytes === 'string' && Buffer.byteLength(bytes) > LEDGER_STATE_MAX_BYTES) invalid()
  let value: unknown
  try { value = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { invalid() }
  return validateLedgerState(spec, value)
}
