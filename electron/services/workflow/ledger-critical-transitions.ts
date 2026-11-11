import { types } from 'node:util'
import type { DurableModelContext } from './model-journal.ts'
import type { LedgerJournalPosition, LedgerStateV1, LedgerModelRecord, LedgerDiagnostics } from './ledger-state.ts'
import type { PreparedCriticalSpec, CriticalWorkflowBinding, CriticalProducingEpoch, CriticalRecordReference, LedgerCriticalEnvelopeV1, LedgerCriticalOutcome } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LedgerCriticalError, LEDGER_CRITICAL_MAX_BYTES, ledgerCriticalPosition, prepareLedgerCriticalSpec, validateLedgerCriticalEnvelope } from './ledger-critical-envelope.ts'

function fail(): never { throw new LedgerCriticalError('LEDGER_CRITICAL_TRANSITION_INVALID') }
function tokenFail(): never { throw new LedgerCriticalError('LEDGER_CRITICAL_TOKEN_INVALID') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b) }
function safeSum(a: number, b: number): number { const sum = a + b; if (!Number.isSafeInteger(sum) || sum < 0) fail(); return sum }
function dataRecord(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) fail()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
    result[key] = descriptor.value
  }
  return result
}
function positive(value: unknown, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) fail(); return value }
function acceptedReference(value: unknown, envelope: LedgerCriticalEnvelopeV1): CriticalRecordReference {
  const r = dataRecord(value, ['id', 'producingEpoch', 'byteLength', 'sha256'])
  const e = dataRecord(r.producingEpoch, ['owner', 'attempt', 'attemptId'])
  // MAX_CHAIN=4096 is W's attempt bound; MAX_LOCAL_RECORDS=8192 is
  // independently enforced by the envelope's global journal sequence parser.
  if (typeof e.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(e.attemptId)) fail()
  const producingEpoch = Object.freeze({ owner: positive(e.owner, 512), attempt: positive(e.attempt, 4096), attemptId: e.attemptId })
  if (!same(producingEpoch, envelope.provenance.producingEpoch) || r.id !== 'j-' + String(envelope.provenance.sequence).padStart(12, '0') || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256)) fail()
  return Object.freeze({ id: r.id as string, producingEpoch, byteLength: positive(r.byteLength, LEDGER_CRITICAL_MAX_BYTES), sha256: r.sha256 })
}

declare const cursorBrand: unique symbol, stepBrand: unique symbol
export interface LedgerCriticalCursor {
  readonly binding: CriticalWorkflowBinding; readonly logicalPosition: LedgerJournalPosition
  readonly reference: CriticalRecordReference | null; readonly state: LedgerStateV1 | null
  readonly terminalOutcome: LedgerCriticalOutcome | null; readonly [cursorBrand]: true
}
export interface LedgerCriticalStep {
  readonly envelope: LedgerCriticalEnvelopeV1; readonly logicalPosition: LedgerJournalPosition; readonly [stepBrand]: true
}
interface ModelEvents { readonly context: DurableModelContext; readonly epoch: CriticalProducingEpoch; readonly intent: boolean; readonly final: 'receipt' | 'unknown' | null }
interface ReadEvents { readonly epoch: CriticalProducingEpoch; readonly received: boolean }
interface CursorData {
  readonly prepared: PreparedCriticalSpec; readonly envelope: LedgerCriticalEnvelopeV1 | null
  readonly models: ReadonlyMap<string, ModelEvents>; readonly reads: ReadonlyMap<string, ReadEvents>; readonly tools: ReadonlySet<string>
  readonly observedEpochs: ReadonlyMap<string, CriticalProducingEpoch>; spent: boolean
}
interface StepData { readonly base: LedgerCriticalCursor; readonly next: CursorData; readonly terminalOutcome: LedgerCriticalOutcome | null; consumed: boolean }
const cursors = new WeakMap<object, CursorData>(), steps = new WeakMap<object, StepData>()
function cursorData(cursor: LedgerCriticalCursor): CursorData {
  const data = cursor && typeof cursor === 'object' ? cursors.get(cursor) : undefined
  if (!data || data.spent) tokenFail()
  return data
}
function makeCursor(data: CursorData, reference: CriticalRecordReference | null, terminalOutcome: LedgerCriticalOutcome | null): LedgerCriticalCursor {
  const token = Object.freeze({ binding: data.prepared.binding, logicalPosition: data.envelope?.logicalPosition ?? data.prepared.genesis,
    reference, state: data.envelope?.state ?? null, terminalOutcome }) as LedgerCriticalCursor
  cursors.set(token, data); return token
}
/** Cache bookkeeping only. It does not mint a genuine bootstrap or recovery basis. */
export function createLedgerCriticalCursor(prepared: PreparedCriticalSpec): LedgerCriticalCursor {
  // ledgerCriticalPosition verifies the private Prepared token before it examines
  // these data arguments. Read descriptors so even a fake token invokes no getter.
  let description: Record<string, unknown>
  try { description = dataRecord(prepared, ['spec', 'originalSpecJson', 'binding', 'genesis']) } catch { return tokenFail() }
  ledgerCriticalPosition(prepared, { binding: description.binding, producingEpoch: { owner: 1, attempt: 1, attemptId: '11111111-1111-4111-8111-111111111111' }, sequence: 1, previous: null }, { kind: 'created', genesis: description.genesis })
  return makeCursor({ prepared, envelope: null, models: new Map(), reads: new Map(), tools: new Set(), observedEpochs: new Map(), spent: false }, null, null)
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
function checkCapacity(state: LedgerStateV1, prepared: PreparedCriticalSpec): void {
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
  const total = prepared.spec.budget.total, inv = prepared.spec.budget.investigation
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

export function checkLedgerCriticalTransition(cursor: LedgerCriticalCursor, next: LedgerCriticalEnvelopeV1): LedgerCriticalStep {
  const data = cursorData(cursor), envelope = validateLedgerCriticalEnvelope(next, data.prepared)
  const p = envelope.provenance, e = envelope.event, s = envelope.state
  if (p.sequence !== cursor.logicalPosition.sequence + 1 || !same(p.previous, cursor.reference)) fail()
  const old = data.envelope
  const modelEvents = new Map(data.models), readEvents = new Map(data.reads), toolEvents = new Set(data.tools), observedEpochs = new Map(data.observedEpochs)
  let terminalOutcome = cursor.terminalOutcome
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
  checkCapacity(s, data.prepared)
  const preparedStep = Object.freeze({ envelope, logicalPosition: envelope.logicalPosition }) as LedgerCriticalStep
  steps.set(preparedStep, { base: cursor, next: { prepared: data.prepared, envelope, models: modelEvents, reads: readEvents, tools: toolEvents, observedEpochs, spent: false }, terminalOutcome, consumed: false })
  return preparedStep
}
/** A supplied reference remains untrusted DATA; the future host must compare the
 * genuine W ack/verified outer record before accepting this bookkeeping step. */
export function acceptLedgerCriticalStep(step: LedgerCriticalStep, reference: CriticalRecordReference): LedgerCriticalCursor {
  const data = step && typeof step === 'object' ? steps.get(step) : undefined
  if (!data || data.consumed) tokenFail()
  const base = cursorData(data.base), ref = acceptedReference(reference, step.envelope)
  data.consumed = true; base.spent = true
  return makeCursor(data.next, ref, data.terminalOutcome)
}
/** Fold a complete nonempty prefix. No trusted latest-tail anchor is accepted by
 * this pure API, so it cannot detect a self-consistent truncated suffix. */
export function foldLedgerCriticalPrefix(records: readonly { payload: unknown; reference: CriticalRecordReference }[]): LedgerCriticalCursor {
  if (!records || typeof records !== 'object' || types.isProxy(records) || !Array.isArray(records) || Object.getPrototypeOf(records) !== Array.prototype || records.length < 1 || records.length > 8192 || Reflect.ownKeys(records).length !== records.length + 1) fail()
  let cursor: LedgerCriticalCursor | undefined
  for (let index = 0; index < records.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(records, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
    const record = dataRecord(descriptor.value, ['payload', 'reference'])
    if (!cursor) {
      // Descriptor inspection reads only the original JSON string; no getter or
      // ambient spec is used. check() owns/validates the full envelope below.
      const first = dataRecord(record.payload, ['format', 'originalSpecJson', 'provenance', 'event', 'logicalPosition', 'state'])
      if (typeof first.originalSpecJson !== 'string') fail()
      cursor = createLedgerCriticalCursor(prepareLedgerCriticalSpec({ json: first.originalSpecJson }))
    }
    cursor = acceptLedgerCriticalStep(checkLedgerCriticalTransition(cursor, record.payload as LedgerCriticalEnvelopeV1), record.reference as CriticalRecordReference)
  }
  return cursor!
}
