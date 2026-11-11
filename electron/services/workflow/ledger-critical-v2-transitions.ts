// V2 causal integrity DATA. Its private tokens grant no live capabilities.
import { types } from 'node:util'
import type { CriticalLineageV2 } from './ledger-critical-v2-envelope.ts'
import type { CriticalAccountingFacts } from './critical-accounting-internal.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createCriticalAccountingFacts, checkCriticalAccounting } from './critical-accounting-internal.ts'
import type { LedgerJournalPosition, LedgerStateV1 } from './ledger-state.ts'
import type { PreparedCriticalSpecV2, CriticalWorkflowBinding, CriticalProducingEpoch, CriticalRecordReference, LedgerCriticalEnvelopeV2, LedgerCriticalOutcomeV2 } from './ledger-critical-v2-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LedgerCriticalV2Error, LEDGER_CRITICAL_V2_MAX_BYTES, ledgerCriticalV2Position, prepareLedgerCriticalV2Spec, validateLedgerCriticalV2Envelope } from './ledger-critical-v2-envelope.ts'

function fail(): never { throw new LedgerCriticalV2Error('LEDGER_CRITICAL_V2_TRANSITION_INVALID') }
function tokenFail(): never { throw new LedgerCriticalV2Error('LEDGER_CRITICAL_V2_TOKEN_INVALID') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b) }
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
function acceptedReference(value: unknown, envelope: LedgerCriticalEnvelopeV2): CriticalRecordReference {
  const r = dataRecord(value, ['id', 'producingEpoch', 'byteLength', 'sha256'])
  const e = dataRecord(r.producingEpoch, ['owner', 'attempt', 'attemptId'])
  // MAX_CHAIN=4096 is W's attempt bound; MAX_LOCAL_RECORDS=8192 is
  // independently enforced by the envelope's global journal sequence parser.
  if (typeof e.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(e.attemptId)) fail()
  const producingEpoch = Object.freeze({ owner: positive(e.owner, 512), attempt: positive(e.attempt, 4096), attemptId: e.attemptId })
  if (!same(producingEpoch, envelope.provenance.producingEpoch) || r.id !== 'j-' + String(envelope.provenance.sequence).padStart(12, '0') || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256)) fail()
  return Object.freeze({ id: r.id as string, producingEpoch, byteLength: positive(r.byteLength, LEDGER_CRITICAL_V2_MAX_BYTES), sha256: r.sha256 })
}

declare const cursorBrand: unique symbol, stepBrand: unique symbol
export interface LedgerCriticalV2Cursor {
  readonly binding: CriticalWorkflowBinding; readonly logicalPosition: LedgerJournalPosition
  readonly reference: CriticalRecordReference | null; readonly state: LedgerStateV1 | null
  readonly terminalOutcome: LedgerCriticalOutcomeV2 | null; readonly lineage: CriticalLineageV2; readonly [cursorBrand]: true
}
export interface LedgerCriticalV2Step {
  readonly envelope: LedgerCriticalEnvelopeV2; readonly logicalPosition: LedgerJournalPosition; readonly [stepBrand]: true
}
interface CursorData extends CriticalAccountingFacts {
  readonly prepared: PreparedCriticalSpecV2; readonly envelope: LedgerCriticalEnvelopeV2 | null
  spent: boolean
}
interface StepData { readonly base: LedgerCriticalV2Cursor; readonly next: CursorData; readonly terminalOutcome: LedgerCriticalOutcomeV2 | null; consumed: boolean }
const cursors = new WeakMap<object, CursorData>(), steps = new WeakMap<object, StepData>()
function cursorData(cursor: LedgerCriticalV2Cursor): CursorData {
  const data = cursor && typeof cursor === 'object' ? cursors.get(cursor) : undefined
  if (!data || data.spent) tokenFail()
  return data
}
function makeCursor(data: CursorData, reference: CriticalRecordReference | null, terminalOutcome: LedgerCriticalOutcomeV2 | null): LedgerCriticalV2Cursor {
  const token = Object.freeze({ binding: data.prepared.binding, logicalPosition: data.envelope?.logicalPosition ?? data.prepared.genesis,
    reference, state: data.envelope?.state ?? null, terminalOutcome, lineage: data.envelope?.lineage ?? Object.freeze({ plan: null }) }) as LedgerCriticalV2Cursor
  cursors.set(token, data); return token
}
/** Cache bookkeeping only. It does not mint a genuine bootstrap or recovery basis. */
export function createLedgerCriticalV2Cursor(prepared: PreparedCriticalSpecV2): LedgerCriticalV2Cursor {
  // ledgerCriticalV2Position verifies the private Prepared token before it examines
  // these data arguments. Read descriptors so even a fake token invokes no getter.
  let description: Record<string, unknown>
  try { description = dataRecord(prepared, ['spec', 'originalSpecJson', 'binding', 'genesis']) } catch { return tokenFail() }
  ledgerCriticalV2Position(prepared, { binding: description.binding, producingEpoch: { owner: 1, attempt: 1, attemptId: '11111111-1111-4111-8111-111111111111' }, sequence: 1, previous: null }, { kind: 'created', genesis: description.genesis }, { plan: null })
  return makeCursor({ prepared, envelope: null, ...createCriticalAccountingFacts(), spent: false }, null, null)
}
export function checkLedgerCriticalV2Transition(cursor: LedgerCriticalV2Cursor, next: LedgerCriticalEnvelopeV2): LedgerCriticalV2Step {
  const data = cursorData(cursor), envelope = validateLedgerCriticalV2Envelope(next, data.prepared)
  const p = envelope.provenance
  if (p.sequence !== cursor.logicalPosition.sequence + 1 || !same(p.previous, cursor.reference)) fail()
  const priorPlan = data.envelope?.lineage.plan ?? null
  const nextPlan = envelope.lineage.plan
  if (envelope.event.kind === 'plan') {
    if (!data.envelope || priorPlan !== null || nextPlan === null || cursor.terminalOutcome !== null) fail()
    // A plan descriptor is accepted only over settled investigation accounting.
    // These integrity facts still do not prove a genuine private business result.
    const s = envelope.state
    if (s.time.elapsedHighWaterMs >= data.prepared.spec.budget.total.wallClockMs || s.time.utcHighWaterMs >= s.time.expiresUtcMs) fail()
    if (s.blocked || !s.models.length || s.models.some(row => row.state !== 'settled' || !row.usage) || !s.reads.length || s.reads.some(row => row.state !== 'settled') || Object.values(s.diagnostics).some(value => value !== 0)) fail()
    if (nextPlan.remainingModelRequests !== data.prepared.spec.budget.total.maxModelRequests - s.models.length) fail()
  } else if (!same(priorPlan, nextPlan)) fail()
  let checked: ReturnType<typeof checkCriticalAccounting>
  try { checked = checkCriticalAccounting(data, data.envelope, envelope, data.prepared.spec, cursor.terminalOutcome) }
  catch { fail() }
  const { facts } = checked
  const terminalOutcome = checked.terminalOutcome as LedgerCriticalOutcomeV2 | null
  const preparedStep = Object.freeze({ envelope, logicalPosition: envelope.logicalPosition }) as LedgerCriticalV2Step
  steps.set(preparedStep, { base: cursor, next: { prepared: data.prepared, envelope, ...facts, spent: false }, terminalOutcome, consumed: false })
  return preparedStep
}
/** A supplied reference remains untrusted DATA; the future host must compare the
 * genuine W ack/verified outer record before accepting this bookkeeping step. */
export function acceptLedgerCriticalV2Step(step: LedgerCriticalV2Step, reference: CriticalRecordReference): LedgerCriticalV2Cursor {
  const data = step && typeof step === 'object' ? steps.get(step) : undefined
  if (!data || data.consumed) tokenFail()
  const base = cursorData(data.base), ref = acceptedReference(reference, step.envelope)
  data.consumed = true; base.spent = true
  return makeCursor(data.next, ref, data.terminalOutcome)
}
/** Fold a complete nonempty prefix. No trusted latest-tail anchor is accepted by
 * this pure API, so it cannot detect a self-consistent truncated suffix. */
export function foldLedgerCriticalV2Prefix(records: readonly { payload: unknown; reference: CriticalRecordReference }[]): LedgerCriticalV2Cursor {
  if (!records || typeof records !== 'object' || types.isProxy(records) || !Array.isArray(records) || Object.getPrototypeOf(records) !== Array.prototype || records.length < 1 || records.length > 8192 || Reflect.ownKeys(records).length !== records.length + 1) fail()
  let cursor: LedgerCriticalV2Cursor | undefined
  for (let index = 0; index < records.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(records, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
    const record = dataRecord(descriptor.value, ['payload', 'reference'])
    if (!cursor) {
      // Descriptor inspection reads only the original JSON string; no getter or
      // ambient spec is used. check() owns/validates the full envelope below.
      const first = dataRecord(record.payload, ['format', 'originalSpecJson', 'provenance', 'event', 'logicalPosition', 'state', 'lineage'])
      if (typeof first.originalSpecJson !== 'string') fail()
      cursor = createLedgerCriticalV2Cursor(prepareLedgerCriticalV2Spec({ json: first.originalSpecJson }))
    }
    cursor = acceptLedgerCriticalV2Step(checkLedgerCriticalV2Transition(cursor, record.payload as LedgerCriticalEnvelopeV2), record.reference as CriticalRecordReference)
  }
  return cursor!
}
