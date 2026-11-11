// Internal accounting policy shared by independently validated V1/V2 frames.
// This module creates no storage, source, model, recovery or plan authority.
import type { RunSpec } from './run-spec.ts'
import type { DurableModelContext } from './model-journal.ts'
import type { LedgerJournalPosition, LedgerStateV1, LedgerModelRecord, LedgerDiagnostics } from './ledger-state.ts'
import type { LedgerCriticalEvent, LedgerCriticalOutcome, CriticalProvenance, CriticalProducingEpoch } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LedgerCriticalError } from './ledger-critical-envelope.ts'
function fail(): never { throw new LedgerCriticalError('LEDGER_CRITICAL_TRANSITION_INVALID') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b) }
function safeSum(a: number, b: number): number { const sum = a + b; if (!Number.isSafeInteger(sum) || sum < 0) fail(); return sum }
interface ModelEvents { readonly context: DurableModelContext; readonly epoch: CriticalProducingEpoch; readonly intent: boolean; readonly final: 'receipt' | 'unknown' | null }
interface ReadEvents { readonly epoch: CriticalProducingEpoch; readonly received: boolean }
export interface CriticalAccountingFacts {
  readonly models: ReadonlyMap<string, ModelEvents>; readonly reads: ReadonlyMap<string, ReadEvents>; readonly tools: ReadonlySet<string>
  readonly observedEpochs: ReadonlyMap<string, CriticalProducingEpoch>
}
export interface CriticalAccountingFrame {
  readonly provenance: CriticalProvenance
  readonly event: LedgerCriticalEvent | Readonly<{ kind: 'plan' }>
  readonly logicalPosition: LedgerJournalPosition
  readonly state: LedgerStateV1
}
export function createCriticalAccountingFacts(): CriticalAccountingFacts {
  return { models: new Map(), reads: new Map(), tools: new Set(), observedEpochs: new Map() }
}
function immutableModel(a: LedgerModelRecord, b: LedgerModelRecord): boolean {
  return a.id === b.id && a.stage === b.stage && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.contextChars === b.contextChars && a.semanticHash === b.semanticHash && a.semanticOperationHash === b.semanticOperationHash && a.requestHash === b.requestHash && a.manifestHash === b.manifestHash
}
function hasCommitment(row: LedgerModelRecord): boolean {
  return row.contextChars !== null && row.semanticHash !== null && row.semanticOperationHash !== null && row.requestHash !== null && row.manifestHash !== null
}
function modelMap(state: LedgerStateV1): Map<string, LedgerModelRecord> { return new Map(state.models.map(row => [row.id, row])) }
function rows(state: LedgerStateV1): Set<string> { return new Set([...state.models, ...state.reads, ...state.tools].map(row => row.id)) }
function checkTime(prior: LedgerStateV1, next: LedgerStateV1, kind: string): void {
  const a = prior.time, b = next.time
  if (a.startedUtcMs !== b.startedUtcMs || a.expiresUtcMs !== b.expiresUtcMs || b.utcHighWaterMs < a.utcHighWaterMs || b.elapsedHighWaterMs < a.elapsedHighWaterMs || prior.blocked && !next.blocked) fail()
  if (a.terminalElapsedMs !== null) { if (!same(a, b)) fail() }
  else if (kind !== 'seal' && b.terminalElapsedMs !== null) fail()
}
/** Compare to original admission ceilings after subtracting ONLY proven receipt
 * overspend for this consistency check. Stored costs/diagnostics never shrink. */
function checkCapacity(state: LedgerStateV1, spec: RunSpec): void {
  let input = 0, output = 0, invInput = 0, invOutput = 0, invCount = 0, read = 0, invTools = 0
  let overInput = 0, overOutput = 0, overRead = 0
  for (const row of state.models) {
    const actualInput = row.usage?.inputTokens ?? row.inputTokens, actualOutput = row.usage?.outputTokens ?? row.outputTokens
    const oi = Math.max(0, actualInput - row.inputTokens), oo = Math.max(0, actualOutput - row.outputTokens)
    overInput = safeSum(overInput, oi); overOutput = safeSum(overOutput, oo)
    input = safeSum(input, actualInput - oi); output = safeSum(output, actualOutput - oo)
    if (row.stage === 'investigation') { invCount++; invInput = safeSum(invInput, actualInput - oi); invOutput = safeSum(invOutput, actualOutput - oo) }
    if (['unknown', 'unknown-unsent'].includes(row.state) && !state.blocked) fail()
  }
  for (const row of state.reads) {
    const actual = row.actualBytes ?? row.reservedBytes, over = Math.max(0, actual - row.reservedBytes)
    overRead = safeSum(overRead, over); read = safeSum(read, actual - over)
  }
  for (const row of state.tools) if (row.stage === 'investigation') invTools++
  const total = spec.budget.total, inv = spec.budget.investigation
  if (state.models.length > total.maxModelRequests || input > total.inputTokens || output > total.outputTokens || read > total.readBytes || invCount > inv.maxModelRequests || invInput > inv.inputTokens || invOutput > inv.outputTokens || read > inv.readBytes || invTools > (inv.maxToolCalls ?? 0) || (total.maxToolCalls !== undefined && state.tools.length > total.maxToolCalls)) fail()
  const d = state.diagnostics
  if (d.overspendInputTokens !== overInput || d.overspendOutputTokens !== overOutput || d.overspendReadBytes !== overRead || d.overspendAdmissions !== 0 || d.doubleSettlements !== 0 || d.unknownUsageTreatedAsZero !== 0 || (overInput > 0 || overOutput > 0 || overRead > 0 || state.time.terminalElapsedMs !== null) && !state.blocked) fail()
}
function checkDiagnostics(a: LedgerDiagnostics, b: LedgerDiagnostics, input: number, output: number, read: number): void {
  if (b.overspendInputTokens !== safeSum(a.overspendInputTokens, input) || b.overspendOutputTokens !== safeSum(a.overspendOutputTokens, output) || b.overspendReadBytes !== safeSum(a.overspendReadBytes, read) || b.overspendAdmissions !== a.overspendAdmissions || b.doubleSettlements !== a.doubleSettlements || b.unknownUsageTreatedAsZero !== a.unknownUsageTreatedAsZero) fail()
}
function unchangedAccounting(a: LedgerStateV1, b: LedgerStateV1): void {
  if (!same(a.models, b.models) || !same(a.reads, b.reads) || !same(a.tools, b.tools) || !same(a.issuedIds, b.issuedIds) || !same(a.diagnostics, b.diagnostics)) fail()
}
function checkRecovery(a: LedgerStateV1, b: LedgerStateV1): void {
  const models = a.models.map(row => row.state === 'reserved' ? { ...row, state: 'unknown-unsent' } : row.state === 'dispatched' ? { ...row, state: 'unknown' } : row)
  if (!same(models, b.models) || !same(a.reads, b.reads) || !same(a.tools, b.tools) || !same(a.issuedIds, b.issuedIds) || !same(a.diagnostics, b.diagnostics)) fail()
  const blocked = a.blocked || models.some(row => ['unknown', 'unknown-unsent'].includes(row.state)) || b.time.terminalElapsedMs !== null || Object.values(b.diagnostics).some(value => value > 0)
  if (b.blocked !== blocked) fail()
}
function observedChange(a: LedgerModelRecord, b: LedgerModelRecord): boolean {
  if (same(a, b)) return true
  // Failure paths may retain conservative unknowns before their own flush is queued.
  // Observing this does not accept reservation/intent/final for that operation.
  return a.usage === null && b.usage === null && (a.state === 'reserved' && ['unknown-unsent', 'unknown'].includes(b.state) || a.state === 'dispatched' && b.state === 'unknown')
}

/** Inputs have already passed their own version's closed structural codec.
 * Neither version rewrites its hashes, positions or frames into the other. */
export function checkCriticalAccounting(data: CriticalAccountingFacts, old: CriticalAccountingFrame | null, envelope: CriticalAccountingFrame, spec: RunSpec, previousOutcome: LedgerCriticalOutcome | null) {
  const p = envelope.provenance, e = envelope.event, s = envelope.state
  const modelEvents = new Map(data.models), readEvents = new Map(data.reads), toolEvents = new Set(data.tools), observedEpochs = new Map(data.observedEpochs)
  let terminalOutcome = previousOutcome
  if (!old) {
    if (e.kind !== 'created' || p.sequence !== 1 || p.previous !== null) fail()
  } else {
    if (e.kind === 'created') fail()
    const changedEpoch = !same(old.provenance.producingEpoch, p.producingEpoch)
    if (changedEpoch) {
      const a = old.provenance.producingEpoch, b = p.producingEpoch
      if (e.kind !== 'recovery' || b.owner < a.owner || b.attempt <= a.attempt || b.attemptId === a.attemptId) fail()
    } else if (e.kind === 'recovery') fail()
    if (terminalOutcome !== null && e.kind !== 'recovery') fail()
    const a = old.state
    checkTime(a, s, e.kind)
    if (e.kind === 'recovery') {
      if (!same(e.from, old.logicalPosition)) fail()
      if (terminalOutcome !== null) {
        unchangedAccounting(a, s)
        if (!s.blocked) fail()
      } else checkRecovery(a, s)
    } else if (e.kind === 'plan') {
      unchangedAccounting(a, s)
      if (a.blocked !== s.blocked) fail()
    } else if (e.kind === 'seal') {
      if (s.time.terminalElapsedMs === null || !s.blocked) fail()
      unchangedAccounting(a, s); terminalOutcome = e.outcome
    } else {
      const oldIds = new Set(a.issuedIds), newIds = new Set(s.issuedIds), oldRows = rows(a), newRows = rows(s)
      if (a.issuedIds.some(id => !newIds.has(id)) || [...oldRows].some(id => !newRows.has(id))) fail()
      for (const id of newRows) if (!oldRows.has(id)) {
        if (oldIds.has(id)) fail() // An earlier orphan issued ID can never acquire a new row.
        observedEpochs.set(id, p.producingEpoch)
      }
      const beforeModels = modelMap(a), afterModels = modelMap(s)
      const targetModelId = e.kind === 'model' ? e.model.context.id : null
      for (const row of a.models) {
        const after = afterModels.get(row.id)
        if (!after || !immutableModel(row, after)) fail()
        if (row.id !== targetModelId && !observedChange(row, after)) fail()
      }
      for (const row of s.models) if (!beforeModels.has(row.id) && (row.state !== 'reserved' || !hasCommitment(row))) fail()
      let overInput = 0, overOutput = 0, overRead = 0
      if (e.kind === 'model') {
        const c = e.model.context, before = beforeModels.get(c.id), after = afterModels.get(c.id)!, flags = modelEvents.get(c.id)
        if (!hasCommitment(after)) fail()
        if (e.model.kind === 'reservation') {
          if (flags || before && before.state !== 'reserved' || after.state !== 'reserved' || !same(observedEpochs.get(c.id), p.producingEpoch)) fail()
          modelEvents.set(c.id, { context: c, epoch: p.producingEpoch, intent: false, final: null })
        } else {
          if (!flags || !same(flags.context, c) || !same(flags.epoch, p.producingEpoch) || flags.final !== null || !before) fail()
          if (e.model.kind === 'intent') {
            if (flags.intent || before.state !== 'reserved' || after.state !== 'dispatched') fail()
            modelEvents.set(c.id, { ...flags, intent: true })
          } else if (e.model.kind === 'receipt') {
            if (!flags.intent || before.state !== 'dispatched' || after.state !== 'settled') fail()
            overInput = Math.max(0, e.model.usage!.inputTokens - after.inputTokens)
            overOutput = Math.max(0, e.model.usage!.outputTokens - after.outputTokens)
            modelEvents.set(c.id, { ...flags, final: 'receipt' })
          } else {
            const expected = flags.intent || before.state === 'unknown' ? 'unknown' : 'unknown-unsent'
            if (!['reserved', 'dispatched', 'unknown', 'unknown-unsent'].includes(before.state) || after.state !== expected) fail()
            modelEvents.set(c.id, { ...flags, final: 'unknown' })
          }
        }
      }
      const beforeReads = new Map(a.reads.map(row => [row.id, row])), afterReads = new Map(s.reads.map(row => [row.id, row]))
      for (const row of a.reads) {
        const after = afterReads.get(row.id)
        if (!after || after.reservedBytes !== row.reservedBytes) fail()
        if (e.kind !== 'read-receipt' || e.id !== row.id) { if (!same(row, after)) fail() }
      }
      for (const row of s.reads) if (!beforeReads.has(row.id) && row.state !== 'reserved') fail()
      if (e.kind === 'read-reservation') {
        if (readEvents.has(e.id) || !same(observedEpochs.get(e.id), p.producingEpoch)) fail()
        readEvents.set(e.id, { epoch: p.producingEpoch, received: false })
      } else if (e.kind === 'read-receipt') {
        const flags = readEvents.get(e.id), before = beforeReads.get(e.id), after = afterReads.get(e.id)!
        if (!flags || flags.received || !same(flags.epoch, p.producingEpoch) || !before || before.state !== 'reserved' || after.state !== 'settled') fail()
        overRead = Math.max(0, e.actualBytes - before.reservedBytes)
        readEvents.set(e.id, { ...flags, received: true })
      }
      const beforeTools = new Map(a.tools.map(row => [row.id, row])), afterTools = new Map(s.tools.map(row => [row.id, row]))
      for (const row of a.tools) if (!same(row, afterTools.get(row.id))) fail()
      if (e.kind === 'tool-charge') {
        if (toolEvents.has(e.id) || !same(observedEpochs.get(e.id), p.producingEpoch)) fail()
        toolEvents.add(e.id)
      }
      checkDiagnostics(a.diagnostics, s.diagnostics, overInput, overOutput, overRead)
    }
  }
  checkCapacity(s, spec)
  return { facts: { models: modelEvents, reads: readEvents, tools: toolEvents, observedEpochs }, terminalOutcome }
}
