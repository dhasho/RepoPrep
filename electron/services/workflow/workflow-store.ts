import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript sources.
import { acquireWorkflowWriter, assertWorkflowWriterOwner, closeWorkflowWriter, fenceWorkflowWriter, fenceWorkflowAttempt, finishWorkflowAttempt, queueWorkflowWriter, readWorkflowFile, resolveWorkflowRoot, validateWorkflowRoot, workflowAttemptInfo, workflowDirectory, workflowDiskUsage, workflowFail, workflowFilePath, workflowFsError, workflowHash, WorkflowStoreError } from './workflow-writer.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript sources.
import type { WorkflowAttempt, WorkflowProducingEpoch, WorkflowRoot, WorkflowRunBinding, WorkflowWriterGuard, WorkflowAttemptInfo } from './workflow-writer.ts'
export type { WorkflowAttempt, WorkflowProducingEpoch, WorkflowRunBinding, WorkflowAttemptInfo } from './workflow-writer'
export { WorkflowStoreError } from './workflow-writer'

export const WORKFLOW_COMPONENT_KINDS = Object.freeze(['ledger', 'critical-journal', 'result', 'question', 'review', 'revision', 'snapshot-metadata', 'recorded-visible-response'] as const)
export type WorkflowComponentKind = typeof WORKFLOW_COMPONENT_KINDS[number]
const MiB = 1024 * 1024
export const WORKFLOW_STORE_MAXIMA = Object.freeze({
  aggregateBytes: 1024 * MiB, runBytes: 256 * MiB, controlBytes: MiB, maxEntries: 32768,
  componentBytes: Object.freeze({ ledger: 64 * MiB, 'critical-journal': 64 * MiB, result: 8 * MiB, question: 4 * MiB, review: 4 * MiB, revision: 4 * MiB, 'snapshot-metadata': 8 * MiB, 'recorded-visible-response': 32 * MiB })
})
const MAX_OWNERS = 512, MAX_RUNS = 128, MAX_CHAIN = 4096, MAX_LOCAL_RECORDS = 8192
const HASH = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STAGES = ['created', 'scanning', 'investigating', 'tool', 'packing', 'generating', 'validating', 'reviewing', 'revising', 'persisting', 'completed', 'cancelled', 'failed'] as const
export type WorkflowStoreStage = typeof STAGES[number]
export interface WorkflowComponentValidator { readonly schemaId: string; readonly validate: (payload: unknown) => boolean }
export type WorkflowComponentValidators = Readonly<Partial<Record<WorkflowComponentKind, WorkflowComponentValidator>>>
declare const payloadBrand: unique symbol
export interface WorkflowVisiblePayloadPolicy { readonly [payloadBrand]: true }
const payloadPolicies = new WeakMap<object, (payload: unknown) => boolean>()
/** Explicit main-program policy. JSON/copying the returned token cannot authorize capture. */
export function createWorkflowVisiblePayloadPolicy(validateVisiblePayload: (payload: unknown) => boolean): WorkflowVisiblePayloadPolicy {
  if (typeof validateVisiblePayload !== 'function') workflowFail('invalid-input')
  const token = Object.freeze({}) as WorkflowVisiblePayloadPolicy
  payloadPolicies.set(token, validateVisiblePayload)
  return token
}
export interface WorkflowStoreLimits {
  readonly aggregateBytes?: number
  readonly runBytes?: number
  readonly controlBytes?: number
  readonly maxEntries?: number
  readonly componentBytes?: Readonly<Partial<Record<WorkflowComponentKind, number>>>
}
export type WorkflowStoreStep = 'owner-marker-opened' | 'owner-marker-flushed' | 'attempt-marker-opened' | 'attempt-marker-flushed' | 'component-opened' | 'component-flushed' | 'journal-opened' | 'journal-flushed' | 'manifest-opened' | 'manifest-flushed'
export interface WorkflowStoreOptions {
  readonly storageDirectory: string
  readonly validators: WorkflowComponentValidators
  readonly limits?: WorkflowStoreLimits
  readonly visiblePayloadPolicy?: WorkflowVisiblePayloadPolicy
  /** Main-program instrumentation/fault seam; no paths, payloads, or raw errors. */
  readonly onDurableStep?: (step: WorkflowStoreStep) => void | Promise<void>
}
export interface WorkflowComponentInput { readonly kind: Exclude<WorkflowComponentKind, 'critical-journal'>; readonly payload: unknown }
export interface WorkflowRecordReference { readonly id: string; readonly producingEpoch: WorkflowProducingEpoch; readonly byteLength: number; readonly sha256: string }
export interface WorkflowComponentReference extends WorkflowRecordReference { readonly kind: WorkflowComponentKind; readonly schemaId: string }
interface AttemptReference { readonly producingEpoch: WorkflowProducingEpoch; readonly markerHash: string }
interface Prefix { readonly binding: WorkflowRunBinding; readonly attempt: AttemptReference; readonly manifest: WorkflowRecordReference | null; readonly journal: WorkflowRecordReference | null }
interface OwnerMarker { readonly format: 'workflow-owner/v1'; readonly epoch: number; readonly previous: Readonly<{ epoch: number; sha256: string }> | null; readonly carry: readonly Prefix[] }
interface AttemptMarker { readonly format: 'workflow-attempt/v1'; readonly binding: WorkflowRunBinding; readonly producingEpoch: WorkflowProducingEpoch; readonly parent: Prefix | null }
interface ComponentRecord { readonly format: 'workflow-component/v1'; readonly binding: WorkflowRunBinding; readonly producingEpoch: WorkflowProducingEpoch; readonly kind: WorkflowComponentKind; readonly schemaId: string; readonly payload: unknown }
interface JournalRecord extends Omit<ComponentRecord, 'format'> { readonly format: 'workflow-journal/v1'; readonly sequence: number; readonly previous: WorkflowRecordReference | null }
export interface WorkflowCommitManifest {
  readonly format: 'workflow-manifest/v1'
  readonly binding: WorkflowRunBinding
  readonly producingEpoch: WorkflowProducingEpoch
  readonly sequence: number
  readonly stage: WorkflowStoreStage
  readonly parent: WorkflowRecordReference | null
  readonly journalPosition: WorkflowRecordReference | null
  readonly components: readonly WorkflowComponentReference[]
}
export interface WorkflowVerifiedComponent { readonly reference: WorkflowComponentReference; readonly payload: unknown }
export interface WorkflowVerifiedJournal { readonly reference: WorkflowRecordReference; readonly schemaId: string; readonly sequence: number; readonly payload: unknown }
export type WorkflowStoreRead =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unavailable'; code: string }>
  | Readonly<{ status: 'verified'; binding: WorkflowRunBinding; currentEpoch: WorkflowProducingEpoch; manifest: WorkflowCommitManifest | null; manifestReference: WorkflowRecordReference | null; components: readonly WorkflowVerifiedComponent[]; journal: readonly WorkflowVerifiedJournal[] }>
export interface WorkflowJournalBuildContext {
  readonly binding: WorkflowRunBinding
  readonly producingEpoch: WorkflowProducingEpoch
  readonly sequence: number
  readonly previous: WorkflowRecordReference | null
}
/** Pure synchronous program builder, invoked after allocating the next position inside the writer queue. */
export type WorkflowJournalPayload = unknown | ((context: WorkflowJournalBuildContext) => unknown)
export interface WorkflowStore {
  assertCurrent(attempt: WorkflowAttempt): WorkflowAttemptInfo
  beginAttempt(binding: WorkflowRunBinding, options?: Readonly<{ signal?: AbortSignal }>): Promise<WorkflowAttempt>
  publish(attempt: WorkflowAttempt, checkpoint: Readonly<{ stage: WorkflowStoreStage; components: readonly WorkflowComponentInput[] }>): Promise<WorkflowCommitManifest>
  appendJournal(attempt: WorkflowAttempt, buildPayload: (context: WorkflowJournalBuildContext) => unknown): Promise<WorkflowVerifiedJournal>
  appendJournal(attempt: WorkflowAttempt, payload: unknown): Promise<WorkflowVerifiedJournal>
  finishAttempt(attempt: WorkflowAttempt): boolean
  read(binding: WorkflowRunBinding): WorkflowStoreRead
  /** Full read fenced by the genuine owner on both sides; NOT a queue barrier or drain. */
  readOwned(binding: WorkflowRunBinding): WorkflowStoreRead
  close(): Promise<void>
}
interface Settings {
  validators: WorkflowComponentValidators
  limits: { aggregateBytes: number; runBytes: number; controlBytes: number; maxEntries: number; componentBytes: Record<WorkflowComponentKind, number> }
  visible?: (payload: unknown) => boolean
  step?: WorkflowStoreOptions['onDurableStep']
}
interface OwnerHead { marker: OwnerMarker; hash: string }
interface View { prefix: Prefix; marker: AttemptMarker; lineage: Map<string, AttemptMarker>; manifest: WorkflowCommitManifest | null; components: WorkflowVerifiedComponent[]; journal: WorkflowVerifiedJournal[] }

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function keys(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).length !== names.length || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !names.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) workflowFail('unavailable')
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) workflowFail('unavailable') }
function label(value: unknown): asserts value is string { if (typeof value !== 'string' || !LABEL.test(value)) workflowFail('unavailable') }
function hash(value: unknown): asserts value is string { if (typeof value !== 'string' || !HASH.test(value)) workflowFail('unavailable') }
function canonical(value: unknown, maxBytes: number): Buffer {
  const seen = new Set<object>()
  let nodes = 0, estimate = 0
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 250000 || depth > 64) workflowFail('capacity-exhausted')
    if (typeof item === 'string') estimate += Buffer.byteLength(item, 'utf8') + 2
    else if (item === null || typeof item === 'boolean') estimate += 5
    else if (typeof item === 'number') { if (!Number.isFinite(item)) workflowFail('invalid-input'); estimate += 24 }
    else if (typeof item === 'object') {
      if (seen.has(item!)) workflowFail('invalid-input')
      seen.add(item!)
      if (!Array.isArray(item) && !plain(item)) workflowFail('invalid-input')
      const own = Reflect.ownKeys(item!)
      for (const key of own) {
        if (Array.isArray(item) && key === 'length') continue
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable || (Array.isArray(item) && !/^(0|[1-9][0-9]*)$/.test(key))) workflowFail('invalid-input')
        estimate += Buffer.byteLength(key) + 4
        walk(descriptor.value, depth + 1)
      }
      if (Array.isArray(item) && own.length !== item.length + 1) workflowFail('invalid-input')
      seen.delete(item!)
    } else workflowFail('invalid-input')
    if (!Number.isSafeInteger(estimate) || estimate > maxBytes * 6 + 1024) workflowFail('capacity-exhausted')
  }
  walk(value, 0)
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length === 0 || bytes.length > maxBytes) workflowFail('capacity-exhausted')
  return bytes
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
function parse(bytes: Buffer): unknown {
  try { const result: unknown = JSON.parse(bytes.toString('utf8')); if (!canonical(result, bytes.length).equals(bytes)) workflowFail('unavailable'); return result } catch (error) { if (error instanceof WorkflowStoreError) throw error; workflowFail('unavailable') }
}
function binding(value: unknown): WorkflowRunBinding {
  keys(value, ['version', 'logicalRunId', 'projectId', 'snapshotId', 'runSpecHash', 'configHash', 'schemaVersion', 'policyVersion'])
  if (value.version !== 1) workflowFail('unavailable')
  for (const name of ['logicalRunId', 'projectId', 'snapshotId', 'schemaVersion', 'policyVersion']) label(value[name])
  hash(value.runSpecHash); hash(value.configHash)
  return freeze(value as unknown as WorkflowRunBinding)
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function bindingEqual(a: WorkflowRunBinding, b: WorkflowRunBinding): boolean { return ['version', 'logicalRunId', 'projectId', 'snapshotId', 'runSpecHash', 'configHash', 'schemaVersion', 'policyVersion'].every(key => a[key as keyof WorkflowRunBinding] === b[key as keyof WorkflowRunBinding]) }
function copyBinding(value: WorkflowRunBinding): WorkflowRunBinding { return binding(parse(canonical(value, 4096))) }
function epoch(value: unknown): WorkflowProducingEpoch {
  keys(value, ['owner', 'attempt', 'attemptId']); positive(value.owner, MAX_OWNERS); positive(value.attempt, MAX_CHAIN)
  if (typeof value.attemptId !== 'string' || !UUID.test(value.attemptId)) workflowFail('unavailable')
  return value as unknown as WorkflowProducingEpoch
}
function epochKey(value: WorkflowProducingEpoch): string { return `${numberName(value.owner)}-${numberName(value.attempt)}` }
function numberName(value: number): string { positive(value); return String(value).padStart(12, '0') }
function runKey(value: WorkflowRunBinding): string { return workflowHash(value.logicalRunId) }
function ownerPath(value: number): string[] { return ['epochs', `o-${numberName(value)}.json`] }
function attemptPath(key: string, value: WorkflowProducingEpoch): string[] { return ['runs', key, 'epochs', `e-${epochKey(value)}.json`] }
function dataPath(key: string, value: WorkflowProducingEpoch, id: string): string[] { return ['runs', key, 'data', epochKey(value), `${id}.json`] }
function reference(value: unknown, category: 'm' | 'j' | 'c', maxBytes: number): WorkflowRecordReference {
  keys(value, category === 'c' ? ['id', 'producingEpoch', 'byteLength', 'sha256', 'kind', 'schemaId'] : ['id', 'producingEpoch', 'byteLength', 'sha256'])
  const pattern = category === 'c' ? /^c-[0-9a-f-]{36}$/ : new RegExp(`^${category}-[0-9]{12}$`)
  if (typeof value.id !== 'string' || !pattern.test(value.id)) workflowFail('unavailable')
  if (category === 'c' && !UUID.test(value.id.slice(2))) workflowFail('unavailable')
  if (category !== 'c') positive(Number(value.id.slice(2)), MAX_LOCAL_RECORDS)
  epoch(value.producingEpoch); positive(value.byteLength, maxBytes); hash(value.sha256)
  return value as unknown as WorkflowRecordReference
}
function nullableReference(value: unknown, category: 'm' | 'j', maxBytes: number): WorkflowRecordReference | null { return value === null ? null : reference(value, category, maxBytes) }
function prefix(value: unknown, controlBytes: number): Prefix {
  keys(value, ['binding', 'attempt', 'manifest', 'journal'])
  const bound = binding(value.binding)
  keys(value.attempt, ['producingEpoch', 'markerHash']); const producingEpoch = epoch(value.attempt.producingEpoch); hash(value.attempt.markerHash)
  const result = { binding: bound, attempt: value.attempt as unknown as AttemptReference, manifest: nullableReference(value.manifest, 'm', controlBytes), journal: nullableReference(value.journal, 'j', WORKFLOW_STORE_MAXIMA.componentBytes['critical-journal']) }
  for (const ref of [result.manifest, result.journal]) if (ref && (ref.producingEpoch.owner > producingEpoch.owner || ref.producingEpoch.attempt > producingEpoch.attempt)) workflowFail('unavailable')
  return result
}
function settings(options: WorkflowStoreOptions): Settings {
  if (!plain(options.validators)) workflowFail('invalid-input')
  const validators: Partial<Record<WorkflowComponentKind, WorkflowComponentValidator>> = {}
  for (const [kind, validator] of Object.entries(options.validators)) {
    if (!WORKFLOW_COMPONENT_KINDS.includes(kind as WorkflowComponentKind) || !validator || typeof validator.validate !== 'function' || typeof validator.schemaId !== 'string' || !LABEL.test(validator.schemaId)) workflowFail('invalid-input')
    validators[kind as WorkflowComponentKind] = Object.freeze({ schemaId: validator.schemaId, validate: validator.validate })
  }
  const tighten = (value: number | undefined, max: number): number => { if (value === undefined) return max; if (!Number.isSafeInteger(value) || value < 1 || value > max) workflowFail('invalid-input'); return value }
  const input = options.limits
  const componentBytes = { ...WORKFLOW_STORE_MAXIMA.componentBytes }
  for (const [key, value] of Object.entries(input?.componentBytes ?? {})) {
    if (!WORKFLOW_COMPONENT_KINDS.includes(key as WorkflowComponentKind)) workflowFail('invalid-input')
    componentBytes[key as WorkflowComponentKind] = tighten(value, componentBytes[key as WorkflowComponentKind])
  }
  const limits = { aggregateBytes: tighten(input?.aggregateBytes, WORKFLOW_STORE_MAXIMA.aggregateBytes), runBytes: tighten(input?.runBytes, WORKFLOW_STORE_MAXIMA.runBytes), controlBytes: tighten(input?.controlBytes, WORKFLOW_STORE_MAXIMA.controlBytes), maxEntries: tighten(input?.maxEntries, WORKFLOW_STORE_MAXIMA.maxEntries), componentBytes }
  let visible: Settings['visible']
  if (options.visiblePayloadPolicy !== undefined) { visible = payloadPolicies.get(options.visiblePayloadPolicy); if (!visible) workflowFail('invalid-input') }
  if (options.onDurableStep !== undefined && typeof options.onDurableStep !== 'function') workflowFail('invalid-input')
  return { validators: Object.freeze(validators), limits, visible, step: options.onDurableStep }
}
function validatePayload(config: Settings, kind: WorkflowComponentKind, schemaId: string, payload: unknown): void {
  const validator = config.validators[kind]
  if (!validator || validator.schemaId !== schemaId) workflowFail('unavailable')
  const accepted = (value: unknown): boolean => {
    if (value instanceof Promise) void value.catch(() => {})
    return value === true
  }
  try { freeze(payload); if (!accepted(validator.validate(payload)) || (kind === 'recorded-visible-response' && (!config.visible || !accepted(config.visible(payload))))) workflowFail('unavailable') } catch { workflowFail('unavailable') }
}
function names(root: WorkflowRoot, segments: string[], pattern: RegExp, max: number): string[] {
  const directory = workflowDirectory(root, segments)
  const all = fs.readdirSync(directory)
  if (all.length > max) workflowFail('capacity-exhausted')
  const result = all.filter(name => pattern.test(name)).sort()
  for (const name of result) if (!fs.lstatSync(workflowFilePath(root, [...segments, name])).isFile()) workflowFail('unsafe-path')
  return result
}
function optionalDirectory(root: WorkflowRoot, segments: string[]): boolean {
  for (let index = 0; index < segments.length; index++) {
    const parent = workflowDirectory(root, segments.slice(0, index))
    if (!fs.existsSync(`${parent}/${segments[index]}`)) return false
    workflowDirectory(root, segments.slice(0, index + 1))
  }
  return true
}
function ownerNames(root: WorkflowRoot): string[] { return optionalDirectory(root, ['epochs']) ? names(root, ['epochs'], /^o-[0-9]{12}\.json$/, MAX_OWNERS) : [] }
function readOwner(root: WorkflowRoot, config: Settings): OwnerHead | null {
  const files = ownerNames(root)
  if (!files.length) return null
  let previous: OwnerHead | null = null
  for (let index = 0; index < files.length; index++) {
    const expected = index + 1
    if (files[index] !== ownerPath(expected)[1]) workflowFail('unavailable')
    const bytes = readWorkflowFile(root, ownerPath(expected), config.limits.controlBytes)
    const raw = parse(bytes)
    keys(raw, ['format', 'epoch', 'previous', 'carry'])
    if (raw.format !== 'workflow-owner/v1' || raw.epoch !== expected || !Array.isArray(raw.carry) || raw.carry.length > MAX_RUNS) workflowFail('unavailable')
    if (!equal(raw.previous, previous ? { epoch: previous.marker.epoch, sha256: previous.hash } : null)) workflowFail('unavailable')
    const carry = raw.carry.map(item => prefix(item, config.limits.controlBytes))
    if (new Set(carry.map(item => item.binding.logicalRunId)).size !== carry.length || carry.some(item => item.attempt.producingEpoch.owner >= expected)) workflowFail('unavailable')
    previous = { marker: { format: 'workflow-owner/v1', epoch: expected, previous: raw.previous as OwnerMarker['previous'], carry }, hash: workflowHash(bytes) }
  }
  return previous
}
function readReferenced(root: WorkflowRoot, key: string, ref: WorkflowRecordReference, maxBytes: number): unknown {
  const bytes = readWorkflowFile(root, dataPath(key, ref.producingEpoch, ref.id), maxBytes)
  if (bytes.length !== ref.byteLength || workflowHash(bytes) !== ref.sha256) workflowFail('unavailable')
  return parse(bytes)
}
function recordReference(id: string, producingEpoch: WorkflowProducingEpoch, bytes: Buffer): WorkflowRecordReference { return freeze({ id, producingEpoch, byteLength: bytes.length, sha256: workflowHash(bytes) }) }
function latestReference(root: WorkflowRoot, key: string, producingEpoch: WorkflowProducingEpoch, category: 'm' | 'j', maxBytes: number): WorkflowRecordReference | null {
  const segments = dataPath(key, producingEpoch, 'unused').slice(0, -1)
  if (!optionalDirectory(root, segments)) return null
  const files = names(root, segments, new RegExp(`^${category}-[0-9]{12}\\.json$`), MAX_LOCAL_RECORDS)
  if (!files.length) return null
  const id = files.at(-1)!.slice(0, -5)
  positive(Number(id.slice(2)), MAX_LOCAL_RECORDS)
  return recordReference(id, producingEpoch, readWorkflowFile(root, dataPath(key, producingEpoch, id), maxBytes))
}
function attemptMarker(root: WorkflowRoot, bound: WorkflowRunBinding, ref: AttemptReference, config: Settings): AttemptMarker {
  const bytes = readWorkflowFile(root, attemptPath(runKey(bound), ref.producingEpoch), config.limits.controlBytes)
  if (workflowHash(bytes) !== ref.markerHash) workflowFail('unavailable')
  const raw = parse(bytes)
  keys(raw, ['format', 'binding', 'producingEpoch', 'parent'])
  if (raw.format !== 'workflow-attempt/v1' || !bindingEqual(binding(raw.binding), bound) || !equal(epoch(raw.producingEpoch), ref.producingEpoch)) workflowFail('unavailable')
  const parent = raw.parent === null ? null : prefix(raw.parent, config.limits.controlBytes)
  if (parent && (!bindingEqual(parent.binding, bound) || parent.attempt.producingEpoch.owner > ref.producingEpoch.owner || parent.attempt.producingEpoch.attempt + 1 !== ref.producingEpoch.attempt)) workflowFail('unavailable')
  if (!parent && ref.producingEpoch.attempt !== 1) workflowFail('unavailable')
  return { format: 'workflow-attempt/v1', binding: bound, producingEpoch: ref.producingEpoch, parent }
}
function derivePrefix(root: WorkflowRoot, owner: OwnerHead, key: string, config: Settings): Prefix | null {
  const carried = owner.marker.carry.find(item => runKey(item.binding) === key) ?? null
  const segments = ['runs', key, 'epochs']
  if (!optionalDirectory(root, ['runs', key])) return carried
  if (!optionalDirectory(root, segments)) workflowFail('unavailable')
  const files = names(root, segments, new RegExp(`^e-${numberName(owner.marker.epoch)}-[0-9]{12}\\.json$`), MAX_CHAIN)
  if (!files.length) { if (!carried) workflowFail('unavailable'); return carried }
  const last = files.at(-1)!
  const bytes = readWorkflowFile(root, [...segments, last], config.limits.controlBytes)
  const raw = parse(bytes)
  keys(raw, ['format', 'binding', 'producingEpoch', 'parent'])
  const bound = binding(raw.binding), producingEpoch = epoch(raw.producingEpoch)
  if (runKey(bound) !== key || last !== attemptPath(key, producingEpoch).at(-1) || producingEpoch.owner !== owner.marker.epoch) workflowFail('unavailable')
  const attempt = { producingEpoch, markerHash: workflowHash(bytes) }
  const marker = attemptMarker(root, bound, attempt, config)
  const parent = marker.parent
  if (parent && parent.attempt.producingEpoch.owner < owner.marker.epoch && !equal(parent, carried)) workflowFail('unavailable')
  if (!parent && carried) workflowFail('unavailable')
  return { binding: bound, attempt, manifest: latestReference(root, key, producingEpoch, 'm', config.limits.controlBytes) ?? parent?.manifest ?? null, journal: latestReference(root, key, producingEpoch, 'j', config.limits.componentBytes['critical-journal']) ?? parent?.journal ?? null }
}
function verifyView(root: WorkflowRoot, current: Prefix, owner: OwnerHead, config: Settings): View {
  const bound = current.binding, key = runKey(bound), lineage = new Map<string, AttemptMarker>()
  let cursor: Prefix | null = current
  while (cursor) {
    if (lineage.size >= MAX_CHAIN || cursor.attempt.producingEpoch.owner > owner.marker.epoch) workflowFail('unavailable')
    const marker = attemptMarker(root, bound, cursor.attempt, config)
    const markerKey = epochKey(marker.producingEpoch)
    if (lineage.has(markerKey)) workflowFail('unavailable')
    lineage.set(markerKey, marker)
    cursor = marker.parent
  }
  const allowed = (ref: WorkflowRecordReference): void => {
    const marker = lineage.get(epochKey(ref.producingEpoch))
    if (!marker || !equal(marker.producingEpoch, ref.producingEpoch)) workflowFail('unavailable')
  }
  const journal: WorkflowVerifiedJournal[] = []
  let journalRef = current.journal
  const journalIds = new Set<string>()
  while (journalRef) {
    if (journal.length >= MAX_LOCAL_RECORDS) workflowFail('capacity-exhausted')
    allowed(journalRef)
    const id = `${epochKey(journalRef.producingEpoch)}:${journalRef.id}`
    if (journalIds.has(id)) workflowFail('unavailable')
    journalIds.add(id)
    const raw = readReferenced(root, key, journalRef, config.limits.componentBytes['critical-journal'])
    keys(raw, ['format', 'binding', 'producingEpoch', 'kind', 'schemaId', 'payload', 'sequence', 'previous'])
    if (raw.format !== 'workflow-journal/v1' || raw.kind !== 'critical-journal' || !bindingEqual(binding(raw.binding), bound) || !equal(epoch(raw.producingEpoch), journalRef.producingEpoch)) workflowFail('unavailable')
    positive(raw.sequence, MAX_LOCAL_RECORDS); label(raw.schemaId)
    if (journalRef.id !== `j-${numberName(raw.sequence)}`) workflowFail('unavailable')
    const previous = nullableReference(raw.previous, 'j', config.limits.componentBytes['critical-journal'])
    if (raw.sequence !== (previous ? Number(previous.id.slice(2)) + 1 : 1)) workflowFail('unavailable')
    validatePayload(config, 'critical-journal', raw.schemaId, raw.payload)
    journal.push(freeze({ reference: journalRef, schemaId: raw.schemaId, sequence: raw.sequence, payload: raw.payload }))
    journalRef = previous
  }
  journal.reverse()
  let manifest: WorkflowCommitManifest | null = null
  let selectedComponents: WorkflowVerifiedComponent[] = []
  let manifestRef = current.manifest
  const manifestIds = new Set<string>()
  while (manifestRef) {
    if (manifestIds.size >= MAX_LOCAL_RECORDS) workflowFail('capacity-exhausted')
    allowed(manifestRef)
    const identity = `${epochKey(manifestRef.producingEpoch)}:${manifestRef.id}`
    if (manifestIds.has(identity)) workflowFail('unavailable')
    manifestIds.add(identity)
    const raw = readReferenced(root, key, manifestRef, config.limits.controlBytes)
    keys(raw, ['format', 'binding', 'producingEpoch', 'sequence', 'stage', 'parent', 'journalPosition', 'components'])
    if (raw.format !== 'workflow-manifest/v1' || !bindingEqual(binding(raw.binding), bound) || !equal(epoch(raw.producingEpoch), manifestRef.producingEpoch) || !STAGES.includes(raw.stage as WorkflowStoreStage)) workflowFail('unavailable')
    positive(raw.sequence, MAX_LOCAL_RECORDS)
    if (manifestRef.id !== `m-${numberName(raw.sequence)}`) workflowFail('unavailable')
    const parent = nullableReference(raw.parent, 'm', config.limits.controlBytes)
    if (raw.sequence !== (parent ? Number(parent.id.slice(2)) + 1 : 1)) workflowFail('unavailable')
    const position = nullableReference(raw.journalPosition, 'j', config.limits.componentBytes['critical-journal'])
    if (position && !journal.some(item => equal(item.reference, position))) workflowFail('unavailable')
    if (!Array.isArray(raw.components) || raw.components.length < 1 || raw.components.length >= WORKFLOW_COMPONENT_KINDS.length) workflowFail('unavailable')
    const components = raw.components.map(item => {
      const ref = reference(item, 'c', Math.max(...Object.values(config.limits.componentBytes))) as WorkflowComponentReference
      if (!WORKFLOW_COMPONENT_KINDS.includes(ref.kind) || ref.kind === 'critical-journal') workflowFail('unavailable')
      label(ref.schemaId); allowed(ref)
      if (ref.byteLength > config.limits.componentBytes[ref.kind]) workflowFail('unavailable')
      return ref
    })
    if (new Set(components.map(item => item.kind)).size !== components.length) workflowFail('unavailable')
    const verifiedComponents = components.map(ref => {
      const component = readReferenced(root, key, ref, config.limits.componentBytes[ref.kind])
      keys(component, ['format', 'binding', 'producingEpoch', 'kind', 'schemaId', 'payload'])
      if (component.format !== 'workflow-component/v1' || !bindingEqual(binding(component.binding), bound) || !equal(epoch(component.producingEpoch), ref.producingEpoch) || component.kind !== ref.kind || component.schemaId !== ref.schemaId) workflowFail('unavailable')
      validatePayload(config, ref.kind, ref.schemaId, component.payload)
      return freeze({ reference: ref, payload: component.payload })
    })
    if (!manifest) {
      manifest = freeze({ format: 'workflow-manifest/v1', binding: bound, producingEpoch: manifestRef.producingEpoch, sequence: raw.sequence, stage: raw.stage as WorkflowStoreStage, parent, journalPosition: position, components })
      selectedComponents = verifiedComponents
    }
    manifestRef = parent
  }
  validateWorkflowRoot(root)
  return { prefix: current, marker: lineage.get(epochKey(current.attempt.producingEpoch))!, lineage, manifest, components: selectedComponents, journal }
}
function runKeys(root: WorkflowRoot): string[] {
  if (!optionalDirectory(root, ['runs'])) return []
  const entries = fs.readdirSync(workflowDirectory(root, ['runs']))
  if (entries.length > MAX_RUNS) workflowFail('capacity-exhausted')
  if (entries.some(entry => !HASH.test(entry))) workflowFail('unavailable')
  for (const key of entries) workflowDirectory(root, ['runs', key])
  return entries
}
function lookup(root: WorkflowRoot, owner: OwnerHead, bound: WorkflowRunBinding, config: Settings): View | null {
  if (!optionalDirectory(root, ['runs'])) { if (owner.marker.carry.length) workflowFail('unavailable'); return null }
  const current = derivePrefix(root, owner, runKey(bound), config)
  if (!current) return null
  if (!bindingEqual(current.binding, bound)) workflowFail('unavailable')
  return verifyView(root, current, owner, config)
}
function reservation(root: WorkflowRoot, key: string | undefined, bytes: number, entries: number, config: Settings): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(entries) || entries < 0) workflowFail('capacity-exhausted')
  const used = workflowDiskUsage(root, key, config.limits.maxEntries)
  if (!Number.isSafeInteger(used.bytes + bytes) || used.bytes + bytes > config.limits.aggregateBytes || (key !== undefined && used.runBytes + bytes > config.limits.runBytes) || used.entries + entries > config.limits.maxEntries) workflowFail('capacity-exhausted')
}
async function immutable(guard: WorkflowWriterGuard, segments: string[], bytes: Buffer, kind: 'owner-marker' | 'attempt-marker' | 'component' | 'journal' | 'manifest', config: Settings, extraCheck: () => void = () => {}): Promise<void> {
  let descriptor: number | undefined
  const check = (): void => { guard.check(); extraCheck() }
  try {
    check()
    const filename = workflowFilePath(guard.root, segments, true)
    check()
    descriptor = fs.openSync(filename, 'wx', 0o600)
    if (config.step) { await config.step(`${kind}-opened`); check() }
    let offset = 0
    while (offset < bytes.length) { check(); const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count < 1) workflowFail('disk-failure'); offset += count }
    check(); fs.fsyncSync(descriptor)
    fs.closeSync(descriptor); descriptor = undefined
    check()
    if (config.step) { await config.step(`${kind}-flushed`); check() }
  } catch (error) { workflowFsError(error) } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}
function currentAttempt(view: View | null, producingEpoch: WorkflowProducingEpoch): asserts view is View {
  if (!view || !equal(view.prefix.attempt.producingEpoch, producingEpoch)) workflowFail('attempt-inactive')
  if (view.manifest && ['completed', 'cancelled', 'failed'].includes(view.manifest.stage) && equal(view.manifest.producingEpoch, producingEpoch)) workflowFail('attempt-inactive')
}
function verified(view: View): WorkflowStoreRead { return freeze({ status: 'verified' as const, binding: view.prefix.binding, currentEpoch: view.prefix.attempt.producingEpoch, manifest: view.manifest, manifestReference: view.prefix.manifest, components: view.components, journal: view.journal }) }

/** Integrity-only read. A verified store is not a restored ledger or a source/project authorization. */
export function readWorkflowStore(options: WorkflowStoreOptions, requestedBinding: WorkflowRunBinding): WorkflowStoreRead {
  try { return readConfigured(options.storageDirectory, settings(options), requestedBinding) }
  catch (error) { return Object.freeze({ status: 'unavailable', code: error instanceof WorkflowStoreError ? error.code : 'disk-failure' }) }
}
function readConfigured(storageDirectory: string, config: Settings, requestedBinding: WorkflowRunBinding): WorkflowStoreRead {
  try {
    const bound = copyBinding(requestedBinding), root = resolveWorkflowRoot(storageDirectory, false)
    workflowDiskUsage(root, runKey(bound), config.limits.maxEntries)
    const owner = readOwner(root, config)
    if (!owner) { if (runKeys(root).length) workflowFail('unavailable'); return freeze({ status: 'absent' as const }) }
    const view = lookup(root, owner, bound, config)
    return view ? verified(view) : freeze({ status: 'absent' as const })
  } catch (error) { return Object.freeze({ status: 'unavailable', code: error instanceof WorkflowStoreError ? error.code : 'disk-failure' }) }
}
export async function openWorkflowStore(options: WorkflowStoreOptions): Promise<WorkflowStore> {
  const config = settings(options), storageDirectory = options.storageDirectory
  const owner = await acquireWorkflowWriter(storageDirectory)
  let head: OwnerHead
  let rootForFence: WorkflowRoot
  try {
    head = await queueWorkflowWriter(owner, async guard => {
      rootForFence = guard.root
      const previous = readOwner(guard.root, config)
      const keys = runKeys(guard.root)
      if (!previous && keys.length) workflowFail('unavailable')
      const allKeys = new Set([...keys, ...(previous?.marker.carry.map(item => runKey(item.binding)) ?? [])])
      if (allKeys.size > MAX_RUNS) workflowFail('capacity-exhausted')
      const carry = [...allKeys].sort().map(key => {
        const current = previous ? derivePrefix(guard.root, previous, key, config) : null
        if (!current || !previous) workflowFail('unavailable')
        return verifyView(guard.root, current, previous, config).prefix
      })
      const next = (previous?.marker.epoch ?? 0) + 1
      positive(next, MAX_OWNERS)
      const marker: OwnerMarker = { format: 'workflow-owner/v1', epoch: next, previous: previous ? { epoch: previous.marker.epoch, sha256: previous.hash } : null, carry }
      const bytes = canonical(marker, config.limits.controlBytes)
      reservation(guard.root, undefined, bytes.length, 2, config)
      await immutable(guard, ownerPath(next), bytes, 'owner-marker', config)
      guard.check()
      return { marker: freeze(marker), hash: workflowHash(bytes) }
    })
    fenceWorkflowWriter(owner, () => {
      const files = ownerNames(rootForFence)
      if (files.at(-1) !== ownerPath(head.marker.epoch)[1] || workflowHash(readWorkflowFile(rootForFence, ownerPath(head.marker.epoch), config.limits.controlBytes)) !== head.hash) workflowFail('revoked')
    })
  } catch (error) { await closeWorkflowWriter(owner); throw error }
  const assertCurrent = (attempt: WorkflowAttempt): WorkflowAttemptInfo => {
    const info = workflowAttemptInfo(owner, attempt)
    currentAttempt(lookup(rootForFence, head, info.binding, config), info.epoch)
    workflowAttemptInfo(owner, attempt)
    return info
  }
  return Object.freeze({
    assertCurrent,
    async beginAttempt(requested: WorkflowRunBinding, attemptOptions: Readonly<{ signal?: AbortSignal }> = {}): Promise<WorkflowAttempt> {
      const bound = copyBinding(requested)
      return queueWorkflowWriter(owner, async guard => {
        const view = lookup(guard.root, head, bound, config)
        if (!view && runKeys(guard.root).length >= MAX_RUNS) workflowFail('capacity-exhausted')
        const attemptNumber = (view?.prefix.attempt.producingEpoch.attempt ?? 0) + 1
        positive(attemptNumber, MAX_CHAIN)
        const attempt = guard.issueAttempt(bound, { owner: head.marker.epoch, attempt: attemptNumber }, attemptOptions.signal)
        const info = workflowAttemptInfo(owner, attempt)
        const marker: AttemptMarker = { format: 'workflow-attempt/v1', binding: bound, producingEpoch: info.epoch, parent: view?.prefix ?? null }
        const bytes = canonical(marker, config.limits.controlBytes)
        try {
          reservation(guard.root, runKey(bound), bytes.length, 5, config)
          await immutable(guard, attemptPath(runKey(bound), info.epoch), bytes, 'attempt-marker', config, () => { workflowAttemptInfo(owner, attempt) })
          guard.check(); workflowAttemptInfo(owner, attempt)
          const markerHash = workflowHash(bytes)
          fenceWorkflowAttempt(owner, attempt, () => {
            const segments = ['runs', runKey(bound), 'epochs']
            const issued = names(guard.root, segments, new RegExp(`^e-${numberName(head.marker.epoch)}-[0-9]{12}\\.json$`), MAX_CHAIN)
            if (issued.at(-1) !== attemptPath(runKey(bound), info.epoch).at(-1) || workflowHash(readWorkflowFile(guard.root, attemptPath(runKey(bound), info.epoch), config.limits.controlBytes)) !== markerHash) workflowFail('attempt-inactive')
          })
          return attempt
        } catch (error) { finishWorkflowAttempt(owner, attempt); throw error }
      })
    },
    async publish(attempt: WorkflowAttempt, checkpoint: Readonly<{ stage: WorkflowStoreStage; components: readonly WorkflowComponentInput[] }>): Promise<WorkflowCommitManifest> {
      const captured = parse(canonical(checkpoint, WORKFLOW_STORE_MAXIMA.runBytes)) as unknown as { stage: WorkflowStoreStage; components: WorkflowComponentInput[] }
      keys(captured, ['stage', 'components'])
      if (!STAGES.includes(captured.stage) || !Array.isArray(captured.components) || captured.components.length < 1 || captured.components.length >= WORKFLOW_COMPONENT_KINDS.length) workflowFail('invalid-input')
      return queueWorkflowWriter(owner, async guard => {
        const info = workflowAttemptInfo(owner, attempt), key = runKey(info.binding)
        const view = lookup(guard.root, head, info.binding, config)
        currentAttempt(view, info.epoch)
        const items = captured.components.map(input => {
          keys(input, ['kind', 'payload'])
          if (!WORKFLOW_COMPONENT_KINDS.includes(input.kind) || (input.kind as string) === 'critical-journal') workflowFail('invalid-input')
          const schema = config.validators[input.kind]
          if (!schema) workflowFail('invalid-input')
          validatePayload(config, input.kind, schema.schemaId, input.payload)
          const record: ComponentRecord = { format: 'workflow-component/v1', binding: info.binding, producingEpoch: info.epoch, kind: input.kind, schemaId: schema.schemaId, payload: input.payload }
          const bytes = canonical(record, config.limits.componentBytes[input.kind])
          const ref = freeze({ ...recordReference(`c-${randomUUID()}`, info.epoch, bytes), kind: input.kind, schemaId: schema.schemaId })
          return { bytes, ref }
        })
        if (new Set(items.map(item => item.ref.kind)).size !== items.length) workflowFail('invalid-input')
        const sequence = (view.manifest?.sequence ?? 0) + 1
        positive(sequence, MAX_LOCAL_RECORDS)
        const manifest: WorkflowCommitManifest = freeze({ format: 'workflow-manifest/v1', binding: info.binding, producingEpoch: info.epoch, sequence, stage: captured.stage, parent: view.prefix.manifest, journalPosition: view.prefix.journal, components: items.map(item => item.ref) })
        const bytes = canonical(manifest, config.limits.controlBytes)
        reservation(guard.root, key, items.reduce((total, item) => total + item.bytes.length, bytes.length), items.length + 4, config)
        for (const item of items) { await immutable(guard, dataPath(key, info.epoch, item.ref.id), item.bytes, 'component', config); guard.check() }
        guard.check()
        for (const item of items) { const raw = readReferenced(guard.root, key, item.ref, config.limits.componentBytes[item.ref.kind]) as ComponentRecord; validatePayload(config, item.ref.kind, item.ref.schemaId, raw.payload) }
        guard.check()
        await immutable(guard, dataPath(key, info.epoch, `m-${numberName(sequence)}`), bytes, 'manifest', config)
        guard.check()
        return manifest
      }, attempt)
    },
    async appendJournal(attempt: WorkflowAttempt, payload: WorkflowJournalPayload): Promise<WorkflowVerifiedJournal> {
      const captured = typeof payload === 'function' ? payload as (context: WorkflowJournalBuildContext) => unknown : parse(canonical(payload, config.limits.componentBytes['critical-journal']))
      return queueWorkflowWriter(owner, async guard => {
        const info = workflowAttemptInfo(owner, attempt), key = runKey(info.binding)
        const view = lookup(guard.root, head, info.binding, config)
        currentAttempt(view, info.epoch)
        const schema = config.validators['critical-journal']
        if (!schema) workflowFail('invalid-input')
        const sequence = (view.journal.at(-1)?.sequence ?? 0) + 1
        positive(sequence, MAX_LOCAL_RECORDS)
        const built = typeof captured === 'function' ? captured(freeze({ binding: info.binding, producingEpoch: info.epoch, sequence, previous: view.prefix.journal })) : captured
        guard.check()
        const journalPayload = parse(canonical(built, config.limits.componentBytes['critical-journal']))
        validatePayload(config, 'critical-journal', schema.schemaId, journalPayload)
        guard.check()
        const record: JournalRecord = { format: 'workflow-journal/v1', binding: info.binding, producingEpoch: info.epoch, kind: 'critical-journal', schemaId: schema.schemaId, payload: journalPayload, sequence, previous: view.prefix.journal }
        const bytes = canonical(record, config.limits.componentBytes['critical-journal'])
        const ref = recordReference(`j-${numberName(sequence)}`, info.epoch, bytes)
        reservation(guard.root, key, bytes.length, 4, config)
        await immutable(guard, dataPath(key, info.epoch, ref.id), bytes, 'journal', config)
        guard.check()
        return freeze({ reference: ref, schemaId: schema.schemaId, sequence, payload: journalPayload })
      }, attempt)
    },
    finishAttempt(attempt: WorkflowAttempt): boolean { return finishWorkflowAttempt(owner, attempt) },
    read(requested: WorkflowRunBinding): WorkflowStoreRead { return readConfigured(storageDirectory, config, requested) },
    readOwned(requested: WorkflowRunBinding): WorkflowStoreRead {
      assertWorkflowWriterOwner(owner)
      const view = readConfigured(storageDirectory, config, requested)
      assertWorkflowWriterOwner(owner)
      return view
    },
    close(): Promise<void> { return closeWorkflowWriter(owner) }
  })
}
