import { createHash } from 'node:crypto'
import { types } from 'node:util'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { createRunSpec, fingerprintRunSpec, type RunSpec } from './run-spec.ts'

/** Complete resolved v1 specs are currently below4KiB even at constructor string limits. */
export const SAVED_RUN_SPEC_MAX_BYTES = 16 * 1024
export const SAVED_RUN_SPEC_MAX_DEPTH = 8
/** This is deliberately not the identity-omitting configuration fingerprint domain. */
export const SAVED_RUN_SPEC_HASH_DOMAIN = 'repoprep:saved-original-run-spec:v1\0'
export type SavedRunSpecErrorCode = 'SAVED_RUN_SPEC_INVALID' | 'SAVED_RUN_SPEC_BYTES_INVALID' | 'SAVED_RUN_SPEC_TOO_LARGE'
export class SavedRunSpecError extends Error {
  readonly code: SavedRunSpecErrorCode
  constructor(code: SavedRunSpecErrorCode) { super(code); this.name = 'SavedRunSpecError'; this.code = code }
}
function fail(code: SavedRunSpecErrorCode = 'SAVED_RUN_SPEC_INVALID'): never { throw new SavedRunSpecError(code) }
const ROOT_FIELDS = ['version', 'runId', 'projectId', 'snapshotId', 'strategy', 'strategyVersion', 'roleFocus', 'granularity', 'questionBudget', 'model', 'promptVersion', 'toolVersion', 'policyVersion', 'budget', 'generationInputTokens', 'generationOutputTokens'] as const
const MODEL_REQUIRED = ['profileId', 'endpointFingerprint', 'model'] as const
const MODEL_OPTIONAL = ['protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens'] as const
const BUDGET_FIELDS = ['maxModelRequests', 'inputTokens', 'outputTokens', 'readBytes', 'wallClockMs'] as const
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!plain(value)) fail()
  const names = Object.keys(value)
  if (!required.every((key) => Object.hasOwn(value, key)) || !names.every((key) => [...required, ...optional].includes(key))) fail()
}

/** Own a bounded data-only copy before reading any constructor field. Arrays are not part of RunSpec. */
function ownData(value: unknown): unknown {
  let nodes = 0
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > SAVED_RUN_SPEC_MAX_DEPTH) fail()
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'string') { if (item.length > SAVED_RUN_SPEC_MAX_BYTES) fail('SAVED_RUN_SPEC_TOO_LARGE'); return item }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return item }
    if (!plain(item) || ancestors.has(item)) fail()
    ancestors.add(item)
    const names = Reflect.ownKeys(item)
    if (names.length > 64) fail()
    const result: Record<string, unknown> = Object.create(null)
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || key.length > 128 || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true })
    }
    ancestors.delete(item)
    return result
  }
  return visit(value, 0)
}
function canonical(value: unknown): string {
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  // Preserve the constructor's supported signed-zero temperature through JSON roundtrips.
  if (typeof value === 'number' && Object.is(value, -0)) return '-0'
  return JSON.stringify(value)
}
function checkedResolved(value: unknown): RunSpec {
  const saved = ownData(value)
  exact(saved, ROOT_FIELDS)
  exact(saved.model, MODEL_REQUIRED, MODEL_OPTIONAL)
  exact(saved.questionBudget, ['min', 'target', 'max'])
  exact(saved.budget, ['total', 'investigation', 'generationReserve'])
  const budget = saved.budget
  exact(budget.total, BUDGET_FIELDS)
  exact(budget.investigation, [...BUDGET_FIELDS, 'maxToolCalls'])
  exact(budget.generationReserve, BUDGET_FIELDS)
  if (Buffer.byteLength(canonical(saved), 'utf8') > SAVED_RUN_SPEC_MAX_BYTES) fail('SAVED_RUN_SPEC_TOO_LARGE')
  // Feed only approved constructor inputs. The saved resolved object contains
  // derived fields and three budget groups, and must never be constructor input.
  const reconstructed = createRunSpec({
    version: saved.version,
    runId: saved.runId,
    projectId: saved.projectId,
    snapshotId: saved.snapshotId,
    strategy: saved.strategy,
    strategyVersion: saved.strategyVersion,
    roleFocus: saved.roleFocus,
    granularity: saved.granularity,
    model: saved.model,
    promptVersion: saved.promptVersion,
    toolVersion: saved.toolVersion,
    policyVersion: saved.policyVersion,
    budget: {
      maxModelRequests: budget.total.maxModelRequests,
      inputTokens: budget.total.inputTokens,
      outputTokens: budget.total.outputTokens,
      readBytes: budget.total.readBytes,
      wallClockMs: budget.total.wallClockMs
    }
  })
  // Actual policy re-derives question budget, strategy version, generation
  // admission/output and every stage allocation. Do not trust saved claims.
  if (canonical(reconstructed) !== canonical(saved)) fail()
  return reconstructed
}

/** Validate COMPLETE original resolved data, rederive it with current policy and return an owned immutable spec. */
export function validateSavedRunSpec(value: unknown): RunSpec {
  try { return checkedResolved(value) } catch (error) {
    if (error instanceof SavedRunSpecError) throw error
    fail()
  }
}
/** Canonical, stable-order UTF-8 JSON bytes. Optional absence is retained exactly. */
export function encodeSavedRunSpec(value: unknown): Uint8Array {
  const result = Buffer.from(canonical(validateSavedRunSpec(value)), 'utf8')
  if (result.byteLength > SAVED_RUN_SPEC_MAX_BYTES) fail('SAVED_RUN_SPEC_TOO_LARGE')
  return result
}
const byteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
function ownBytes(value: unknown): Buffer {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !types.isUint8Array(value) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value)) || !byteLengthGetter) fail('SAVED_RUN_SPEC_BYTES_INVALID')
  const length: number = Reflect.apply(byteLengthGetter, value, [])
  if (length > SAVED_RUN_SPEC_MAX_BYTES) fail('SAVED_RUN_SPEC_TOO_LARGE')
  if (length === 0 || Reflect.ownKeys(value).length !== length) fail('SAVED_RUN_SPEC_BYTES_INVALID')
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('SAVED_RUN_SPEC_BYTES_INVALID')
  }
  return Buffer.from(value as Uint8Array)
}
function parseStrict(source: string): unknown {
  let cursor = 0
  const whitespace = (): void => { while (cursor < source.length && /[ \t\r\n]/.test(source[cursor])) cursor += 1 }
  const stringToken = (): string => {
    if (source[cursor] !== '"') fail('SAVED_RUN_SPEC_BYTES_INVALID')
    const start = cursor++
    while (cursor < source.length) {
      const character = source[cursor++]
      if (character === '\\') cursor += 1
      else if (character === '"') return JSON.parse(source.slice(start, cursor)) as string
    }
    return fail('SAVED_RUN_SPEC_BYTES_INVALID')
  }
  const walk = (depth: number): void => {
    if (depth > SAVED_RUN_SPEC_MAX_DEPTH) fail('SAVED_RUN_SPEC_BYTES_INVALID')
    whitespace()
    if (source[cursor] === '{') {
      cursor += 1; whitespace(); const seen = new Set<string>()
      if (source[cursor] === '}') { cursor += 1; return }
      while (true) {
        whitespace(); const key = stringToken(); if (seen.has(key)) fail('SAVED_RUN_SPEC_BYTES_INVALID'); seen.add(key)
        whitespace(); if (source[cursor++] !== ':') fail('SAVED_RUN_SPEC_BYTES_INVALID')
        walk(depth + 1); whitespace(); const end = source[cursor++]
        if (end === '}') return
        if (end !== ',') fail('SAVED_RUN_SPEC_BYTES_INVALID')
      }
    }
    if (source[cursor] === '[') {
      cursor += 1; whitespace(); if (source[cursor] === ']') { cursor += 1; return }
      while (true) { walk(depth + 1); whitespace(); const end = source[cursor++]; if (end === ']') return; if (end !== ',') fail('SAVED_RUN_SPEC_BYTES_INVALID') }
    }
    if (source[cursor] === '"') { stringToken(); return }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor))
    if (!match) fail('SAVED_RUN_SPEC_BYTES_INVALID')
    cursor += match[0].length
  }
  walk(0); whitespace(); if (cursor !== source.length) fail('SAVED_RUN_SPEC_BYTES_INVALID')
  return JSON.parse(source)
}
/** Reject invalid UTF-8/duplicate keys/trailing data/depth before validating the resolved object. */
export function decodeSavedRunSpec(value: Uint8Array): RunSpec {
  try {
    const bytes = ownBytes(value)
    // Preserve a BOM so the strict JSON scanner rejects it, rather than silently stripping bytes.
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return validateSavedRunSpec(parseStrict(source))
  } catch (error) {
    if (error instanceof SavedRunSpecError) throw error
    fail('SAVED_RUN_SPEC_BYTES_INVALID')
  }
}
/** Full original identity/config hash; integrity only, never project or recovery authorization. */
export function hashSavedRunSpec(value: unknown): string {
  return createHash('sha256').update(SAVED_RUN_SPEC_HASH_DOMAIN, 'utf8').update(encodeSavedRunSpec(value)).digest('hex')
}
/** Existing normalized configuration fingerprint, deliberately omitting run/project/snapshot identity. */
export function fingerprintSavedRunSpec(value: unknown): string { return fingerprintRunSpec(validateSavedRunSpec(value)) }
