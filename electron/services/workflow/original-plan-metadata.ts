// Hashes-only, bounded plan descriptions. Validation never grants live authority.
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { RunSpec } from './run-spec.ts'
import type { CriticalWorkflowBinding } from './ledger-critical-envelope.ts'
export const ORIGINAL_PLAN_METADATA_VERSION = 1
export const ORIGINAL_PLAN_MAX_SLOTS = 8192
// Closed descriptors for the current shared policies. Grouping labels the
// existing evidence-generation makeGroups/legacyContext algorithm; no runtime
// generation module is imported by this data codec.
export const ORIGINAL_PLAN_VERSION_TAGS = Object.freeze({
  planner: 'question-quota-policy-v1', grouping: 'evidence-source-grouping-v1',
  output: 'generation-output-policy-v1', merge: 'generation-merge-policy-v1',
  writer: 'm08-evidence-writer-v5'
} as const)
export const ORIGINAL_PLAN_VERSION_COMMITMENTS = Object.freeze(Object.fromEntries(
  Object.entries(ORIGINAL_PLAN_VERSION_TAGS).map(([component, tag]) =>
    [component, digest(['repoprep.workflow.original-plan-policy-version.v1', component, tag])])
) as { [K in keyof typeof ORIGINAL_PLAN_VERSION_TAGS]: string })
export const ORIGINAL_PLAN_RETRY_POLICY = Object.freeze({
  maxFormatRetriesPerChain: 1, maxCompensationRounds: 2, maxCompensationAsk: 8
} as const)
export interface OriginalPlanSlot {
  readonly ordinal: number; readonly kind: 'global' | 'module'; readonly weight: number
  readonly quota: number; readonly sourceGroupHash: string
}
export interface OriginalPlanMetadata {
  readonly version: 1
  readonly bindingHash: string; readonly runSpecHash: string; readonly configHash: string
  readonly objectiveHash: string; readonly snapshotHash: string; readonly evidenceHash: string
  readonly investigationHash: string; readonly contextHash: string
  readonly versions: Readonly<{ planner: string; grouping: string; output: string; merge: string; writer: string }>
  readonly writerVariant: 'topic-cards' | 'static-control'
  readonly questionBudget: Readonly<{ min: number; target: number; max: number }>
  readonly remainingModelRequests: number; readonly plannedTotal: number
  readonly slots: readonly OriginalPlanSlot[]
  readonly retry: typeof ORIGINAL_PLAN_RETRY_POLICY
}
function fail(): never { throw new Error('ORIGINAL_PLAN_METADATA_INVALID') }
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== names.length || keys.some(k => typeof k !== 'string' || !names.includes(k))) fail()
  const result: Record<string, unknown> = Object.create(null)
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(value, name)
    if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) fail()
    result[name] = property.value
  }
  return result
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail()
  return value === 0 ? 0 : value
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
export function hashOriginalPlanBinding(binding: CriticalWorkflowBinding): string {
  // Callers of the metadata codec pass their separately verified binding.
  return digest(['repoprep.workflow.original-plan-binding.v1', binding])
}
/** Spec and binding are the independently verified original data of the codec.
 * Hash/version commitments are descriptors only; a host must compute its actual
 * plan privately. No content or reconstructed capability is accepted here. */
export function validateOriginalPlanMetadata(value: unknown, spec: RunSpec, binding: CriticalWorkflowBinding): OriginalPlanMetadata {
  const p = exact(value, ['version', 'bindingHash', 'runSpecHash', 'configHash', 'objectiveHash', 'snapshotHash', 'evidenceHash', 'investigationHash', 'contextHash', 'versions', 'writerVariant', 'questionBudget', 'remainingModelRequests', 'plannedTotal', 'slots', 'retry'])
  if (p.version !== ORIGINAL_PLAN_METADATA_VERSION || p.bindingHash !== hashOriginalPlanBinding(binding) || p.runSpecHash !== binding.runSpecHash || p.configHash !== binding.configHash) fail()
  const versions = exact(p.versions, ['planner', 'grouping', 'output', 'merge', 'writer'])
  for (const component of ['planner', 'grouping', 'output', 'merge', 'writer'] as const) {
    if (versions[component] !== ORIGINAL_PLAN_VERSION_COMMITMENTS[component]) fail()
  }
  const questionBudget = exact(p.questionBudget, ['min', 'target', 'max'])
  if (integer(questionBudget.min) !== spec.questionBudget.min || integer(questionBudget.target) !== spec.questionBudget.target || integer(questionBudget.max) !== spec.questionBudget.max) fail()
  if (p.writerVariant !== 'topic-cards' && p.writerVariant !== 'static-control') fail()
  const remainingModelRequests = integer(p.remainingModelRequests, 1, spec.budget.total.maxModelRequests)
  if (!p.slots || typeof p.slots !== 'object' || types.isProxy(p.slots) || !Array.isArray(p.slots) || Object.getPrototypeOf(p.slots) !== Array.prototype) fail()
  const length = Object.getOwnPropertyDescriptor(p.slots, 'length')?.value
  if (typeof length !== 'number' || length < 1 || length > ORIGINAL_PLAN_MAX_SLOTS || length > remainingModelRequests || Reflect.ownKeys(p.slots).length !== length + 1) fail()
  let total = 0
  const slots: OriginalPlanSlot[] = []
  for (let i = 0; i < length; i++) {
    const property = Object.getOwnPropertyDescriptor(p.slots, String(i))
    if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) fail()
    const s = exact(property.value, ['ordinal', 'kind', 'weight', 'quota', 'sourceGroupHash'])
    if (s.ordinal !== i + 1 || s.kind !== 'global' && s.kind !== 'module' || typeof s.weight !== 'number' || !Number.isFinite(s.weight) || s.weight < 0) fail()
    const quota = integer(s.quota, 0, spec.questionBudget.max)
    total = integer(total + quota)
    slots.push(Object.freeze({ ordinal: i + 1, kind: s.kind, weight: s.weight === 0 ? 0 : s.weight, quota, sourceGroupHash: hash(s.sourceGroupHash) }))
  }
  if (integer(p.plannedTotal) !== total) fail()
  // Do not impose min<=total<=max: the shared planner deliberately represents
  // infeasible batch bounds by boundary values. Persist its actual sum exactly.
  const retry = exact(p.retry, ['maxFormatRetriesPerChain', 'maxCompensationRounds', 'maxCompensationAsk'])
  if (retry.maxFormatRetriesPerChain !== ORIGINAL_PLAN_RETRY_POLICY.maxFormatRetriesPerChain || retry.maxCompensationRounds !== ORIGINAL_PLAN_RETRY_POLICY.maxCompensationRounds || retry.maxCompensationAsk !== ORIGINAL_PLAN_RETRY_POLICY.maxCompensationAsk) fail()
  return Object.freeze({ version: 1, bindingHash: hash(p.bindingHash), runSpecHash: hash(p.runSpecHash), configHash: hash(p.configHash),
    objectiveHash: hash(p.objectiveHash), snapshotHash: hash(p.snapshotHash), evidenceHash: hash(p.evidenceHash), investigationHash: hash(p.investigationHash), contextHash: hash(p.contextHash),
    versions: Object.freeze({ planner: hash(versions.planner), grouping: hash(versions.grouping), output: hash(versions.output), merge: hash(versions.merge), writer: hash(versions.writer) }),
    writerVariant: p.writerVariant, questionBudget: Object.freeze({ min: integer(questionBudget.min), target: integer(questionBudget.target), max: integer(questionBudget.max) }),
    remainingModelRequests, plannedTotal: total, slots: Object.freeze(slots), retry: ORIGINAL_PLAN_RETRY_POLICY })
}
export function hashOriginalPlanMetadata(value: unknown, spec: RunSpec, binding: CriticalWorkflowBinding): string {
  return digest(['repoprep.workflow.original-plan.v1', validateOriginalPlanMetadata(value, spec, binding)])
}
