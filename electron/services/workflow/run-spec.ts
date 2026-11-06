import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { GRANULARITY_QUESTION_BUDGET } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import type { Granularity, LlmProtocol, ReasoningEffort, RoleFocus } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { resolveGenerationBudget } from '../../../shared/token-budget.ts'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { SCAN_LIMIT_BOUNDS } from '../../../shared/types.ts'

export interface RunModelConfig {
  readonly profileId: string
  /** SHA-256 of the normalized provider endpoint; never the endpoint or credential itself. */
  readonly endpointFingerprint: string
  readonly model: string
  readonly protocol?: LlmProtocol
  readonly reasoningEffort?: ReasoningEffort
  readonly temperature?: number
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
}

export interface RunBudget {
  readonly maxModelRequests: number
  readonly maxToolCalls?: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly readBytes: number
  readonly wallClockMs: number
}

export interface RunSpec {
  readonly version: 1
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly strategy: 'static' | 'agentic'
  readonly strategyVersion: 'static-v1' | 'agentic-v1'
  readonly roleFocus: RoleFocus
  readonly granularity: Granularity
  readonly questionBudget: Readonly<{ min: number; target: number; max: number }>
  readonly model: Readonly<RunModelConfig>
  readonly promptVersion: string
  readonly toolVersion: string
  readonly policyVersion: string
  readonly budget: Readonly<{
    total: RunBudget
    investigation: RunBudget
    generationReserve: RunBudget
  }>
  /** Estimated input admitted by the existing app token-budget policy. */
  readonly generationInputTokens: number
  /** Provider output limit after applying the existing model-specific reserve. */
  readonly generationOutputTokens: number
}

const LIMITS = Object.freeze({
  requests: Object.freeze({ coarse: 5, medium: 5, fine: 14 }),
  inputTokens: 128_000,
  outputTokens: 65_536,
  // New workflow-wide aggregate cap, chosen at the scanner's maximum per-file
  // ceiling. The workflow ledger must enforce the aggregate; the legacy reader
  // only enforces each file's approved ceiling.
  readBytes: SCAN_LIMIT_BOUNDS.maxContentFileBytes.max,
  wallClockMs: 600_000,
  investigation: Object.freeze({ requests: 3, tools: 8, inputTokens: 18_000, outputTokens: 6_000, readBytes: 2 * 1024 * 1024, wallClockMs: 180_000 })
})

const SPEC_KEYS = ['version', 'runId', 'projectId', 'snapshotId', 'strategy', 'strategyVersion', 'roleFocus', 'granularity', 'model', 'promptVersion', 'toolVersion', 'policyVersion', 'budget'] as const
const MODEL_KEYS = ['profileId', 'endpointFingerprint', 'model', 'protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens'] as const
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}-v[1-9][0-9]{0,3}$/
type MutablePartialRunBudget = { -readonly [Key in keyof RunBudget]?: RunBudget[Key] }

function invalid(): never { throw new Error('Invalid RunSpec input.') }
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) invalid()
  }
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalid()
  return value
}
function version(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) invalid()
  return value
}
function enumValue<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) invalid()
  return value as T[number]
}
function safeInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid()
  return value
}
function freeze<T extends object>(value: T): Readonly<T> { return Object.freeze(value) }

function parseModel(value: unknown): RunModelConfig {
  if (!record(value)) invalid()
  exactKeys(value, MODEL_KEYS)
  const result: RunModelConfig = {
    profileId: id(value.profileId),
    endpointFingerprint: typeof value.endpointFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.endpointFingerprint) ? value.endpointFingerprint : invalid(),
    model: typeof value.model === 'string' && value.model.length <= 256 && value.model.length > 0 && !value.model.includes('\0') ? value.model : invalid(),
    ...(value.protocol !== undefined ? { protocol: enumValue(value.protocol, ['openai', 'anthropic'] as const) } : {}),
    ...(value.reasoningEffort !== undefined ? { reasoningEffort: enumValue(value.reasoningEffort, ['low', 'high'] as const) } : {}),
    ...(value.temperature !== undefined ? { temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2 ? value.temperature : invalid() } : {}),
    ...(value.contextWindowTokens !== undefined ? { contextWindowTokens: safeInteger(value.contextWindowTokens, 4096, 2_097_152) } : {}),
    ...(value.maxOutputTokens !== undefined ? { maxOutputTokens: safeInteger(value.maxOutputTokens, 256, 393_216) } : {})
  }
  if (result.protocol === 'anthropic' && result.reasoningEffort !== undefined) invalid()
  if (result.contextWindowTokens !== undefined && result.maxOutputTokens !== undefined && result.maxOutputTokens >= result.contextWindowTokens) invalid()
  return result
}

function makeBudget(granularity: Granularity, requested: Partial<RunBudget>, generationInputTokens: number, generationOutputTokens: number): Readonly<RunSpec['budget']> {
  const totalRequests = requested.maxModelRequests ?? LIMITS.requests[granularity]
  const total = freeze({
    maxModelRequests: totalRequests,
    inputTokens: requested.inputTokens ?? LIMITS.inputTokens,
    outputTokens: requested.outputTokens ?? LIMITS.outputTokens,
    readBytes: requested.readBytes ?? LIMITS.readBytes,
    wallClockMs: requested.wallClockMs ?? LIMITS.wallClockMs
  })
  const investigation = freeze({
    // Always retain one request for generation, even when investigation cannot run.
    maxModelRequests: Math.min(LIMITS.investigation.requests, Math.max(0, total.maxModelRequests - 1)),
    maxToolCalls: LIMITS.investigation.tools,
    inputTokens: Math.min(LIMITS.investigation.inputTokens, Math.max(0, total.inputTokens - generationInputTokens)),
    outputTokens: Math.min(LIMITS.investigation.outputTokens, Math.max(0, total.outputTokens - generationOutputTokens)),
    readBytes: Math.min(LIMITS.investigation.readBytes, total.readBytes),
    wallClockMs: Math.min(LIMITS.investigation.wallClockMs, Math.max(0, total.wallClockMs - 1))
  })
  // This is capacity withheld from investigation: the remainder of every global
  // ceiling remains available to generation, repair and review in the shared ledger.
  const generationReserve = freeze({
    maxModelRequests: total.maxModelRequests - investigation.maxModelRequests,
    inputTokens: total.inputTokens - investigation.inputTokens,
    outputTokens: total.outputTokens - investigation.outputTokens,
    readBytes: total.readBytes - investigation.readBytes,
    wallClockMs: total.wallClockMs - investigation.wallClockMs
  })
  return freeze({ total, investigation, generationReserve })
}

function parseRequestedBudget(value: unknown, granularity: Granularity): Partial<RunBudget> {
  if (value === undefined) return {}
  if (!record(value)) invalid()
  const keys = ['maxModelRequests', 'inputTokens', 'outputTokens', 'readBytes', 'wallClockMs'] as const
  exactKeys(value, keys)
  const maxima = {
    maxModelRequests: LIMITS.requests[granularity],
    inputTokens: LIMITS.inputTokens,
    outputTokens: LIMITS.outputTokens,
    readBytes: LIMITS.readBytes,
    wallClockMs: LIMITS.wallClockMs
  }
  const parsed: MutablePartialRunBudget = {}
  for (const key of keys) {
    if (value[key] !== undefined) parsed[key] = safeInteger(value[key], key === 'maxModelRequests' || key === 'wallClockMs' ? 1 : 0, maxima[key])
  }
  return parsed
}

/** Validate untrusted input, normalize it, and return a deeply immutable run contract. */
export function createRunSpec(input: unknown): RunSpec {
  if (!record(input)) invalid()
  exactKeys(input, SPEC_KEYS)
  if (input.version !== 1) invalid()
  const strategy = enumValue(input.strategy, ['static', 'agentic'] as const)
  const expectedStrategyVersion = strategy === 'static' ? 'static-v1' : 'agentic-v1'
  if (input.strategyVersion !== expectedStrategyVersion) invalid()
  const roleFocus = enumValue(input.roleFocus, ['general', 'frontend', 'backend', 'algorithm'] as const)
  const granularity = enumValue(input.granularity, ['coarse', 'medium', 'fine'] as const)
  const model = parseModel(input.model)
  const effective = resolveGenerationBudget(model, granularity)
  const outputTokens = effective.reservedOutputTokens
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 256 || outputTokens > LIMITS.outputTokens) invalid()
  if (effective.contextWindowTokens !== null && (outputTokens >= effective.contextWindowTokens || effective.inputTokens < 1)) invalid()
  const requestedBudget = parseRequestedBudget(input.budget, granularity)
  const totalInputTokens = requestedBudget.inputTokens ?? LIMITS.inputTokens
  const totalOutputTokens = requestedBudget.outputTokens ?? LIMITS.outputTokens
  const generationInputTokens = Math.min(effective.inputTokens, totalInputTokens)
  if (totalInputTokens < 1 || totalOutputTokens < outputTokens) invalid()
  const budget = makeBudget(granularity, requestedBudget, generationInputTokens, outputTokens)
  const result: RunSpec = {
    version: 1,
    runId: id(input.runId),
    projectId: id(input.projectId),
    snapshotId: id(input.snapshotId),
    strategy,
    strategyVersion: expectedStrategyVersion,
    roleFocus,
    granularity,
    questionBudget: freeze({ ...GRANULARITY_QUESTION_BUDGET[granularity] }),
    model: freeze(model),
    promptVersion: version(input.promptVersion),
    toolVersion: version(input.toolVersion),
    policyVersion: version(input.policyVersion),
    budget,
    generationInputTokens,
    generationOutputTokens: outputTokens
  }
  return freeze(result)
}

/**
 * Stable SHA-256 of normalized run configuration. Identity is omitted so otherwise
 * identical runs can be compared/replayed across run, project and snapshot IDs;
 * those IDs remain explicit trace fields and are never used to authorize reuse.
 */
export function fingerprintRunSpec(spec: RunSpec): string {
  const config = {
    version: spec.version,
    strategy: spec.strategy,
    strategyVersion: spec.strategyVersion,
    roleFocus: spec.roleFocus,
    granularity: spec.granularity,
    questionBudget: { min: spec.questionBudget.min, target: spec.questionBudget.target, max: spec.questionBudget.max },
    model: {
      profileId: spec.model.profileId,
      endpointFingerprint: spec.model.endpointFingerprint,
      model: spec.model.model,
      protocol: spec.model.protocol ?? null,
      reasoningEffort: spec.model.reasoningEffort ?? null,
      temperature: spec.model.temperature ?? null,
      contextWindowTokens: spec.model.contextWindowTokens ?? null,
      maxOutputTokens: spec.model.maxOutputTokens ?? null
    },
    promptVersion: spec.promptVersion,
    toolVersion: spec.toolVersion,
    policyVersion: spec.policyVersion,
    budget: {
      total: { ...spec.budget.total },
      investigation: { ...spec.budget.investigation },
      generationReserve: { ...spec.budget.generationReserve }
    },
    generationInputTokens: spec.generationInputTokens,
    generationOutputTokens: spec.generationOutputTokens
  }
  return createHash('sha256').update(canonicalJson(config)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (record(value)) {
    const members = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}
