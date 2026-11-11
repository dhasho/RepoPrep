// Plan-only V2 integrity DATA codec. No storage/source/model/plan authority.
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { OriginalPlanMetadata } from './original-plan-metadata.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { validateOriginalPlanMetadata, hashOriginalPlanMetadata } from './original-plan-metadata.ts'
import type { RunSpec } from './run-spec.ts'
import type { ModelStage } from './budget-ledger.ts'
import type { DurableModelEvent } from './model-journal.ts'
import type { LedgerJournalPosition, LedgerStateV1 } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { fingerprintRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { validateLedgerState, validateLedgerUsage, hashSemanticModelOperation } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { validateSavedRunSpec, decodeSavedRunSpec, SAVED_RUN_SPEC_HASH_DOMAIN, SAVED_RUN_SPEC_MAX_BYTES } from './saved-run-spec.ts'

export const LEDGER_CRITICAL_V2_FORMAT = 'workflow-ledger-critical/v2'
export const LEDGER_CRITICAL_V2_SCHEMA_ID = 'workflow-ledger-critical-v2'
export const LEDGER_WORKFLOW_SCHEMA_VERSION = 'workflow-v1'
export const LEDGER_CRITICAL_V2_MAX_LINEAGE_BYTES = 4 * 1024 * 1024
export interface CriticalLineageV2 { readonly plan: OriginalPlanMetadata | null }
export const LEDGER_CRITICAL_V2_MAX_BYTES = 64 * 1024 * 1024
export const LEDGER_CRITICAL_V2_MAX_DEPTH = 32
export const LEDGER_CRITICAL_V2_MAX_NODES = 250_000
// W store's MAX_CHAIN bounds physical attempt ordinals, MAX_LOCAL_RECORDS bounds
// global journal sequences/references. These DATA bounds do not prove W acceptance.
const MAX_OWNER = 512, MAX_ATTEMPT = 4096, MAX_JOURNAL = 8192
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const STAGES: readonly string[] = ['investigation']

/** Independent W data descriptions, never WorkflowAttempt or writer capabilities. */
export interface CriticalWorkflowBinding {
  readonly version: 1; readonly logicalRunId: string; readonly projectId: string; readonly snapshotId: string
  readonly runSpecHash: string; readonly configHash: string; readonly schemaVersion: 'workflow-v1'; readonly policyVersion: string
}
export interface CriticalProducingEpoch { readonly owner: number; readonly attempt: number; readonly attemptId: string }
export interface CriticalRecordReference { readonly id: string; readonly producingEpoch: CriticalProducingEpoch; readonly byteLength: number; readonly sha256: string }
export interface CriticalProvenance {
  readonly binding: CriticalWorkflowBinding; readonly producingEpoch: CriticalProducingEpoch
  readonly sequence: number; readonly previous: CriticalRecordReference | null
}
export type LedgerCriticalOutcomeV2 = 'cancelled' | 'failed'
export type LedgerCriticalEventV2 =
  | Readonly<{ kind: 'created'; genesis: LedgerJournalPosition }>
  | Readonly<{ kind: 'model'; model: DurableModelEvent }>
  | Readonly<{ kind: 'read-reservation'; id: string; reservedBytes: number }>
  | Readonly<{ kind: 'read-receipt'; id: string; actualBytes: number }>
  | Readonly<{ kind: 'tool-charge'; id: string; stage: ModelStage }>
  | Readonly<{ kind: 'recovery'; from: LedgerJournalPosition }>
  | Readonly<{ kind: 'seal'; outcome: LedgerCriticalOutcomeV2 }>
  | Readonly<{ kind: 'plan'; planHash: string }>
export interface LedgerCriticalEnvelopeV2 {
  readonly format: 'workflow-ledger-critical/v2'; readonly originalSpecJson: string
  readonly provenance: CriticalProvenance; readonly event: LedgerCriticalEventV2
  readonly logicalPosition: LedgerJournalPosition; readonly state: LedgerStateV1; readonly lineage: CriticalLineageV2
}
export type LedgerCriticalV2ErrorCode = 'LEDGER_CRITICAL_V2_INVALID' | 'LEDGER_CRITICAL_V2_BYTES_INVALID' | 'LEDGER_CRITICAL_V2_TOO_LARGE' | 'LEDGER_CRITICAL_V2_TRANSITION_INVALID' | 'LEDGER_CRITICAL_V2_TOKEN_INVALID'
export class LedgerCriticalV2Error extends Error {
  readonly code: LedgerCriticalV2ErrorCode
  constructor(code: LedgerCriticalV2ErrorCode) { super(code); this.name = 'LedgerCriticalV2Error'; this.code = code }
}
function fail(code: LedgerCriticalV2ErrorCode = 'LEDGER_CRITICAL_V2_INVALID'): never { throw new LedgerCriticalV2Error(code) }
function guarded<T>(operation: () => T, code: LedgerCriticalV2ErrorCode = 'LEDGER_CRITICAL_V2_INVALID'): T {
  try { return operation() } catch (error) { if (error instanceof LedgerCriticalV2Error) throw error; return fail(code) }
}
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function exact(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value)) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value') || !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) fail()
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail()
  return value === 0 ? 0 : value
}
function text(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) fail(); return value }
function stage(value: unknown): ModelStage { if (typeof value !== 'string' || !STAGES.includes(value)) fail(); return value as ModelStage }
function canonical(value: unknown, signedZero = false): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, signedZero)).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key], signedZero)).join(',') + '}'
  }
  if (signedZero && typeof value === 'number' && Object.is(value, -0)) return '-0'
  return JSON.stringify(value)
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex') }
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b) }

/** Own exact enumerable data before calling the existing, intentionally narrower L parsers. */
function ownData(value: unknown): unknown {
  let nodes = 0, bytes = 0
  const ancestors = new Set<object>()
  const charge = (count: number): void => { bytes += count; if (bytes > LEDGER_CRITICAL_V2_MAX_BYTES) fail('LEDGER_CRITICAL_V2_TOO_LARGE') }
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > LEDGER_CRITICAL_V2_MAX_NODES || depth > LEDGER_CRITICAL_V2_MAX_DEPTH) fail('LEDGER_CRITICAL_V2_TOO_LARGE')
    if (item === null || typeof item === 'boolean') { charge(item === null ? 4 : item ? 4 : 5); return item }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); const result = item === 0 ? 0 : item; charge(JSON.stringify(result).length); return result }
    if (typeof item === 'string') { if (item.length > LEDGER_CRITICAL_V2_MAX_BYTES) fail('LEDGER_CRITICAL_V2_TOO_LARGE'); charge(Buffer.byteLength(JSON.stringify(item), 'utf8')); return item }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) fail()
    ancestors.add(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) fail()
      const length = Object.getOwnPropertyDescriptor(item, 'length')?.value as unknown
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > LEDGER_CRITICAL_V2_MAX_NODES) fail('LEDGER_CRITICAL_V2_TOO_LARGE')
      const keys = Reflect.ownKeys(item)
      if (keys.length !== length + 1) fail()
      charge(2 + Math.max(0, length - 1))
      const result: unknown[] = []
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
        result.push(visit(descriptor.value, depth + 1))
      }
      ancestors.delete(item); return Object.freeze(result)
    }
    if (!plain(item)) fail()
    const keys = Reflect.ownKeys(item)
    if (keys.length > 128) fail()
    charge(2 + Math.max(0, keys.length - 1))
    const result: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || key.length > 128 || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
      charge(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
      result[key] = visit(descriptor.value, depth + 1)
    }
    ancestors.delete(item); return Object.freeze(result)
  }
  return visit(value, 0)
}

declare const preparedBrand: unique symbol
export interface PreparedCriticalSpecV2 {
  readonly spec: RunSpec; readonly originalSpecJson: string; readonly binding: CriticalWorkflowBinding
  readonly genesis: LedgerJournalPosition; readonly [preparedBrand]: true
}
const preparedSpecs = new WeakMap<object, PreparedCriticalSpecV2>()
function checkedPrepared(value: PreparedCriticalSpecV2): PreparedCriticalSpecV2 {
  if (!value || typeof value !== 'object' || !preparedSpecs.has(value)) fail('LEDGER_CRITICAL_V2_TOKEN_INVALID')
  return preparedSpecs.get(value)!
}
/** This private data-cache token has no project, recovery, source, W or paid authority. */
export function prepareLedgerCriticalV2Spec(source: { spec: unknown } | { json: string }): PreparedCriticalSpecV2 {
  return guarded(() => {
    if (!plain(source)) fail()
    const fields = Reflect.ownKeys(source)
    const key = fields[0]
    if (fields.length !== 1 || (key !== 'spec' && key !== 'json')) fail()
    exact(source, [key])
    const input = source as Record<string, unknown>
    let spec: RunSpec
    if (key === 'spec') spec = validateSavedRunSpec(input.spec)
    else {
      if (typeof input.json !== 'string') fail()
      if (Buffer.byteLength(input.json, 'utf8') > SAVED_RUN_SPEC_MAX_BYTES) fail('LEDGER_CRITICAL_V2_TOO_LARGE')
      spec = decodeSavedRunSpec(Buffer.from(input.json, 'utf8'))
    }
    const originalSpecJson = canonical(spec, true)
    if (key === 'json' && originalSpecJson !== input.json) fail()
    const binding: CriticalWorkflowBinding = Object.freeze({ version: 1, logicalRunId: spec.runId, projectId: spec.projectId, snapshotId: spec.snapshotId,
      runSpecHash: createHash('sha256').update(SAVED_RUN_SPEC_HASH_DOMAIN, 'utf8').update(originalSpecJson, 'utf8').digest('hex'),
      configHash: fingerprintRunSpec(spec), schemaVersion: LEDGER_WORKFLOW_SCHEMA_VERSION, policyVersion: spec.policyVersion })
    const genesis = Object.freeze({ sequence: 0, hash: digest(['repoprep.workflow.ledger-genesis.v2', binding]) })
    const token = Object.freeze({ spec, originalSpecJson, binding, genesis }) as PreparedCriticalSpecV2
    preparedSpecs.set(token, token)
    return token
  })
}
function position(value: unknown): LedgerJournalPosition {
  exact(value, ['sequence', 'hash'])
  return Object.freeze({ sequence: integer(value.sequence, 0, MAX_JOURNAL), hash: text(value.hash, HASH) })
}
function epoch(value: unknown): CriticalProducingEpoch {
  exact(value, ['owner', 'attempt', 'attemptId'])
  return Object.freeze({ owner: integer(value.owner, 1, MAX_OWNER), attempt: integer(value.attempt, 1, MAX_ATTEMPT), attemptId: text(value.attemptId, UUID) })
}
function reference(value: unknown, sequence: number): CriticalRecordReference {
  exact(value, ['id', 'producingEpoch', 'byteLength', 'sha256'])
  if (value.id !== 'j-' + String(sequence).padStart(12, '0')) fail()
  return Object.freeze({ id: value.id as string, producingEpoch: epoch(value.producingEpoch), byteLength: integer(value.byteLength, 1, LEDGER_CRITICAL_V2_MAX_BYTES), sha256: text(value.sha256, HASH) })
}
function provenance(value: unknown, prepared: PreparedCriticalSpecV2): CriticalProvenance {
  exact(value, ['binding', 'producingEpoch', 'sequence', 'previous'])
  exact(value.binding, ['version', 'logicalRunId', 'projectId', 'snapshotId', 'runSpecHash', 'configHash', 'schemaVersion', 'policyVersion'])
  if (!same(value.binding, prepared.binding)) fail()
  const sequence = integer(value.sequence, 1, MAX_JOURNAL)
  const producingEpoch = epoch(value.producingEpoch)
  const previous = value.previous === null ? null : reference(value.previous, sequence - 1)
  if ((sequence === 1) !== (previous === null)) fail()
  if (previous && (previous.producingEpoch.owner > producingEpoch.owner || previous.producingEpoch.attempt > producingEpoch.attempt)) fail()
  return Object.freeze({ binding: prepared.binding, producingEpoch, sequence, previous })
}
function event(value: unknown, prepared: PreparedCriticalSpecV2, p: CriticalProvenance): LedgerCriticalEventV2 {
  if (!plain(value) || typeof value.kind !== 'string') fail()
  switch (value.kind) {
    case 'created': {
      exact(value, ['kind', 'genesis']); const genesis = position(value.genesis)
      if (!same(genesis, prepared.genesis)) fail()
      return Object.freeze({ kind: 'created', genesis })
    }
    case 'model': {
      exact(value, ['kind', 'model']); const model = value.model
      exact(model, ['version', 'kind', 'context', 'usage', 'outputStatus', 'failureCode'])
      if (model.version !== 1 || typeof model.kind !== 'string' || !['reservation', 'intent', 'receipt', 'unknown'].includes(model.kind) || !['missing', 'uncommitted'].includes(model.outputStatus as string) || !['none', 'transport-protocol', 'unavailable', 'receipt-unavailable'].includes(model.failureCode as string)) fail()
      const c = model.context
      exact(c, ['runId', 'projectId', 'snapshotId', 'attemptId', 'fence', 'id', 'stage', 'semanticHash', 'semanticOperationHash', 'requestHash', 'manifestHash', 'inputTokens', 'outputTokens', 'contextChars'])
      if (c.runId !== prepared.spec.runId || c.projectId !== prepared.spec.projectId || c.snapshotId !== prepared.spec.snapshotId || c.attemptId !== p.producingEpoch.attemptId || integer(c.fence, 1, MAX_OWNER) !== p.producingEpoch.owner) fail()
      const checkedStage = stage(c.stage), semanticHash = text(c.semanticHash, HASH)
      const context = Object.freeze({ runId: prepared.spec.runId, projectId: prepared.spec.projectId, snapshotId: prepared.spec.snapshotId,
        attemptId: p.producingEpoch.attemptId, fence: p.producingEpoch.owner, id: text(c.id, ID), stage: checkedStage,
        semanticHash, semanticOperationHash: text(c.semanticOperationHash, HASH), requestHash: text(c.requestHash, HASH), manifestHash: text(c.manifestHash, HASH),
        inputTokens: integer(c.inputTokens), outputTokens: integer(c.outputTokens), contextChars: integer(c.contextChars) })
      if (context.semanticOperationHash !== hashSemanticModelOperation(prepared.spec, checkedStage, semanticHash)) fail()
      const usage = model.usage === null ? null : validateLedgerUsage(model.usage)
      if ((model.kind === 'receipt') !== (usage !== null)) fail()
      return Object.freeze({ kind: 'model', model: Object.freeze({ version: 1, kind: model.kind as DurableModelEvent['kind'], context, usage,
        outputStatus: model.outputStatus as DurableModelEvent['outputStatus'], failureCode: model.failureCode as DurableModelEvent['failureCode'] }) })
    }
    case 'read-reservation':
      exact(value, ['kind', 'id', 'reservedBytes']); return Object.freeze({ kind: 'read-reservation', id: text(value.id, ID), reservedBytes: integer(value.reservedBytes) })
    case 'read-receipt':
      exact(value, ['kind', 'id', 'actualBytes']); return Object.freeze({ kind: 'read-receipt', id: text(value.id, ID), actualBytes: integer(value.actualBytes) })
    case 'tool-charge':
      exact(value, ['kind', 'id', 'stage']); return Object.freeze({ kind: 'tool-charge', id: text(value.id, ID), stage: stage(value.stage) })
    case 'recovery':
      exact(value, ['kind', 'from']); return Object.freeze({ kind: 'recovery', from: position(value.from) })
    case 'seal':
      exact(value, ['kind', 'outcome']); if (!['cancelled', 'failed'].includes(value.outcome as string)) fail()
      return Object.freeze({ kind: 'seal', outcome: value.outcome as LedgerCriticalOutcomeV2 })
    case 'plan':
      exact(value, ['kind', 'planHash']); return Object.freeze({ kind: 'plan', planHash: text(value.planHash, HASH) })
    default: return fail()
  }
}
function lineage(value: unknown, prepared: PreparedCriticalSpecV2): CriticalLineageV2 {
  exact(value, ['plan'])
  if (Buffer.byteLength(canonical(value), 'utf8') > LEDGER_CRITICAL_V2_MAX_LINEAGE_BYTES) fail('LEDGER_CRITICAL_V2_TOO_LARGE')
  return Object.freeze({ plan: value.plan === null ? null : validateOriginalPlanMetadata(value.plan, prepared.spec, prepared.binding) })
}
function logical(p: CriticalProvenance, e: LedgerCriticalEventV2, l: CriticalLineageV2): LedgerJournalPosition {
  return Object.freeze({ sequence: p.sequence, hash: digest(['repoprep.workflow.ledger-position.v2', p.binding, p.producingEpoch, p.sequence, p.previous, e, l]) })
}
export function ledgerCriticalV2Position(prepared: PreparedCriticalSpecV2, inputProvenance: unknown, inputEvent: unknown, inputLineage: unknown): LedgerJournalPosition {
  return guarded(() => {
    const spec = checkedPrepared(prepared)
    const data = ownData({ provenance: inputProvenance, event: inputEvent, lineage: inputLineage }) as { provenance: unknown; event: unknown; lineage: unknown }
    const p = provenance(data.provenance, spec)
    return logical(p, event(data.event, spec, p), lineage(data.lineage, spec))
  })
}
function coherent(e: LedgerCriticalEventV2, s: LedgerStateV1): void {
  if (e.kind === 'created') {
    if (s.models.length || s.reads.length || s.tools.length || s.issuedIds.length || s.blocked || s.time.terminalElapsedMs !== null || Object.values(s.diagnostics).some(value => value !== 0)) fail()
  } else if (e.kind === 'model') {
    const row = s.models.find(row => row.id === e.model.context.id), c = e.model.context
    if (!row || row.stage !== c.stage || row.inputTokens !== c.inputTokens || row.outputTokens !== c.outputTokens || row.contextChars !== c.contextChars || row.semanticHash !== c.semanticHash || row.semanticOperationHash !== c.semanticOperationHash || row.requestHash !== c.requestHash || row.manifestHash !== c.manifestHash) fail()
    const kind = e.model.kind
    if (kind === 'reservation' && row.state !== 'reserved' || kind === 'intent' && row.state !== 'dispatched' || kind === 'receipt' && (row.state !== 'settled' || !same(row.usage, e.model.usage)) || kind === 'unknown' && (!['unknown', 'unknown-unsent'].includes(row.state) || !s.blocked)) fail()
  } else if (e.kind === 'read-reservation') {
    const row = s.reads.find(row => row.id === e.id)
    if (!row || row.state !== 'reserved' || row.reservedBytes !== e.reservedBytes) fail()
  } else if (e.kind === 'read-receipt') {
    const row = s.reads.find(row => row.id === e.id)
    if (!row || row.state !== 'settled' || row.actualBytes !== e.actualBytes) fail()
  } else if (e.kind === 'tool-charge') {
    if (!s.tools.some(row => row.id === e.id && row.stage === e.stage)) fail()
  } else if (e.kind === 'seal' && (s.time.terminalElapsedMs === null || !s.blocked)) fail()
}
export function validateLedgerCriticalV2Envelope(value: unknown, prepared?: PreparedCriticalSpecV2): LedgerCriticalEnvelopeV2 {
  return guarded(() => {
    const data = ownData(value)
    exact(data, ['format', 'originalSpecJson', 'provenance', 'event', 'logicalPosition', 'state', 'lineage'])
    if (data.format !== LEDGER_CRITICAL_V2_FORMAT || typeof data.originalSpecJson !== 'string') fail()
    const original = prepared === undefined ? prepareLedgerCriticalV2Spec({ json: data.originalSpecJson }) : checkedPrepared(prepared)
    if (data.originalSpecJson !== original.originalSpecJson) fail()
    const p = provenance(data.provenance, original), e = event(data.event, original, p), l = lineage(data.lineage, original), expected = logical(p, e, l)
    if (e.kind === 'created' && l.plan !== null || e.kind === 'plan' && (!l.plan || e.planHash !== hashOriginalPlanMetadata(l.plan, original.spec, original.binding))) fail()
    if (!same(position(data.logicalPosition), expected)) fail()
    const state = validateLedgerState(original.spec, data.state)
    if (!same(state.binding.journal, expected)) fail()
    coherent(e, state)
    if (state.models.some(row => row.stage !== 'investigation') || state.tools.some(row => row.stage !== 'investigation')) fail()
    return Object.freeze({ format: LEDGER_CRITICAL_V2_FORMAT, originalSpecJson: original.originalSpecJson, provenance: p, event: e, logicalPosition: expected, state, lineage: l })
  })
}
export function encodeLedgerCriticalV2Envelope(value: unknown, prepared?: PreparedCriticalSpecV2): Uint8Array {
  return Buffer.from(canonical(validateLedgerCriticalV2Envelope(value, prepared)), 'utf8')
}
const byteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
const typedArraySet = Uint8Array.prototype.set
function ownedBytes(value: unknown): Buffer {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !types.isUint8Array(value) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value)) || !byteLengthGetter) fail('LEDGER_CRITICAL_V2_BYTES_INVALID')
  const length = Reflect.apply(byteLengthGetter, value, []) as number
  if (length > LEDGER_CRITICAL_V2_MAX_BYTES) fail('LEDGER_CRITICAL_V2_TOO_LARGE')
  if (!length) fail('LEDGER_CRITICAL_V2_BYTES_INVALID')
  // Bytes are storage, not decoded format data. Copy by captured typed-array
  // intrinsics; ignore decorations without reading length/iterator/constructor.
  // Enumerating 64MiB of integer own keys would allocate millions of strings.
  const result = Buffer.alloc(length)
  Reflect.apply(typedArraySet, result, [value])
  return result
}
function strictParse(source: string): unknown {
  let cursor = 0, nodes = 0
  const bad = (): never => fail('LEDGER_CRITICAL_V2_BYTES_INVALID')
  const whitespace = (): void => { while (cursor < source.length && /[ \t\r\n]/.test(source[cursor])) cursor++ }
  const stringToken = (): string => {
    if (source[cursor] !== '"') return bad()
    const start = cursor++
    while (cursor < source.length) {
      const character = source[cursor++]
      if (character === '\\') cursor++
      else if (character === '"') return JSON.parse(source.slice(start, cursor)) as string
    }
    return bad()
  }
  const walk = (depth: number): void => {
    if (++nodes > LEDGER_CRITICAL_V2_MAX_NODES || depth > LEDGER_CRITICAL_V2_MAX_DEPTH) fail('LEDGER_CRITICAL_V2_TOO_LARGE')
    whitespace()
    if (source[cursor] === '{') {
      cursor++; whitespace(); const keys = new Set<string>()
      if (source[cursor] === '}') { cursor++; return }
      while (true) {
        whitespace(); const key = stringToken(); if (keys.has(key)) bad(); keys.add(key)
        whitespace(); if (source[cursor++] !== ':') bad()
        walk(depth + 1); whitespace(); const end = source[cursor++]
        if (end === '}') return
        if (end !== ',') bad()
      }
    }
    if (source[cursor] === '[') {
      cursor++; whitespace(); if (source[cursor] === ']') { cursor++; return }
      while (true) { walk(depth + 1); whitespace(); const end = source[cursor++]; if (end === ']') return; if (end !== ',') bad() }
    }
    if (source[cursor] === '"') { stringToken(); return }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor))
    if (!match) bad()
    cursor += match![0].length
  }
  walk(0); whitespace(); if (cursor !== source.length) bad()
  return JSON.parse(source)
}
export function decodeLedgerCriticalV2Envelope(bytes: Uint8Array, prepared?: PreparedCriticalSpecV2): LedgerCriticalEnvelopeV2 {
  return guarded(() => {
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(ownedBytes(bytes))
    return validateLedgerCriticalV2Envelope(strictParse(source), prepared)
  }, 'LEDGER_CRITICAL_V2_BYTES_INVALID')
}
/** Synchronous payload-only validation across carried runs. No ambient current run. */
export function createLedgerCriticalV2PayloadValidator(): Readonly<{ schemaId: typeof LEDGER_CRITICAL_V2_SCHEMA_ID; validate(payload: unknown): boolean }> {
  const cache = new Map<string, PreparedCriticalSpecV2>()
  let retainedBytes = 0
  return Object.freeze({ schemaId: LEDGER_CRITICAL_V2_SCHEMA_ID, validate(payload: unknown): boolean {
    try {
      // Inspect descriptors only; an untrusted property getter is never invoked for caching.
      if (!plain(payload)) return false
      const descriptor = Object.getOwnPropertyDescriptor(payload, 'originalSpecJson')
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return false
      const json: string = descriptor.value
      let prepared = cache.get(json)
      if (!prepared) {
        prepared = prepareLedgerCriticalV2Spec({ json })
        const size = Buffer.byteLength(json, 'utf8')
        while (cache.size >= 16 || retainedBytes + size > 256 * 1024) {
          const oldest = cache.keys().next().value as string
          retainedBytes -= Buffer.byteLength(oldest, 'utf8'); cache.delete(oldest)
        }
        cache.set(json, prepared); retainedBytes += size
      }
      validateLedgerCriticalV2Envelope(payload, prepared)
      return true
    } catch { return false }
  } })
}
