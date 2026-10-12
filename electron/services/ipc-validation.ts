import path from 'node:path'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import type { GenerateRequest, Granularity, LlmProfile, RoleFocus, Settings } from '../../shared/types.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import { SCAN_LIMIT_BOUNDS } from '../../shared/types.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import { isStorageDiagnosticId } from '../../shared/storage-contract.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import { assertInterviewResultContract, EXPLAIN_CONTEXT_LIMITS, LLM_PROFILE_LIMITS, MAX_LLM_PROFILES, ResultContractError } from '../../shared/result-contract.ts'

const messages = {
  unknown: '不允许的 IPC 请求。',
  args: 'IPC 请求参数无效。',
  schema: 'IPC 请求内容格式无效。',
  oversized: 'IPC 请求内容超出允许范围。'
} as const

export class IpcValidationError extends Error {
  constructor(message: string = messages.schema) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

function fail(message: string = messages.schema): never { throw new IpcValidationError(message) }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length > allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) fail()
}
function exactArgs(args: unknown[], count: number): void {
  if (!Array.isArray(args) || args.length !== count) fail(messages.args)
}
function text(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0')
}
function string(value: unknown, max = 4096, min = 1): asserts value is string {
  if (!text(value, max, min)) fail()
}
function absolutePath(value: unknown): asserts value is string {
  string(value, 4096)
  if (!path.isAbsolute(value)) fail()
}
function enumValue<T extends string>(value: unknown, choices: readonly T[]): asserts value is T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail()
}
function url(value: unknown): asserts value is string {
  string(value, LLM_PROFILE_LIMITS.baseUrl)
  let parsed: URL
  try { parsed = new URL(value) } catch { return fail() }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) fail()
}
function profile(value: unknown): asserts value is LlmProfile {
  if (!record(value)) fail()
  exactKeys(value, ['id', 'name', 'baseUrl', 'apiKey', 'model', 'temperature'])
  string(value.id, LLM_PROFILE_LIMITS.id); string(value.name, LLM_PROFILE_LIMITS.name); url(value.baseUrl)
  string(value.apiKey, LLM_PROFILE_LIMITS.apiKey, 0); string(value.model, LLM_PROFILE_LIMITS.model)
  if (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) fail()
}
function scanLimits(value: unknown): void {
  if (!record(value)) fail()
  exactKeys(value, ['maxFiles', 'maxTreeNodes', 'maxContentFileBytes'])
  const int = (v: unknown, bound: { min: number; max: number }): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < bound.min || v > bound.max) fail()
  }
  if (value.maxFiles !== undefined) int(value.maxFiles, SCAN_LIMIT_BOUNDS.maxFiles)
  if (value.maxTreeNodes !== undefined) int(value.maxTreeNodes, SCAN_LIMIT_BOUNDS.maxTreeNodes)
  if (value.maxContentFileBytes !== undefined) int(value.maxContentFileBytes, SCAN_LIMIT_BOUNDS.maxContentFileBytes)
}
function settings(value: unknown): asserts value is Settings {
  if (!record(value) || !Array.isArray(value.profiles) || value.profiles.length > MAX_LLM_PROFILES) fail()
  exactKeys(value, ['profiles', 'defaultProfileId', 'scanLimits'])
  if (value.defaultProfileId !== null) string(value.defaultProfileId, 128)
  for (const item of value.profiles) profile(item)
  if (value.defaultProfileId !== null && !value.profiles.some((p) => record(p) && p.id === value.defaultProfileId)) fail()
  if (value.scanLimits !== undefined) scanLimits(value.scanLimits)
}

const GRANULARITIES = ['coarse', 'medium', 'fine'] as const satisfies readonly Granularity[]
const ROLES = ['general', 'frontend', 'backend', 'algorithm'] as const satisfies readonly RoleFocus[]
function generateRequest(value: unknown): asserts value is GenerateRequest {
  if (!record(value)) fail()
  exactKeys(value, ['projectPath', 'granularity', 'roleFocus', 'profileId', 'runId'])
  absolutePath(value.projectPath); enumValue(value.granularity, GRANULARITIES); enumValue(value.roleFocus, ROLES); string(value.profileId, 128); requestId(value.runId)
}
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function requestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) fail()
}
function explain(value: unknown): void {
  if (!record(value)) fail()
  exactKeys(value, ['requestId', 'term', 'profileId', 'projectSummary', 'question', 'snippet', 'glossaryHint'])
  requestId(value.requestId); string(value.term, EXPLAIN_CONTEXT_LIMITS.term); string(value.profileId, EXPLAIN_CONTEXT_LIMITS.profileId)
  string(value.projectSummary, EXPLAIN_CONTEXT_LIMITS.projectSummary, 0); string(value.question, EXPLAIN_CONTEXT_LIMITS.question); string(value.snippet, EXPLAIN_CONTEXT_LIMITS.snippet, 0)
  if (value.glossaryHint !== undefined) string(value.glossaryHint, EXPLAIN_CONTEXT_LIMITS.glossaryHint, 0)
}

function interviewResult(value: unknown): void {
  try {
    assertInterviewResultContract(value, path.isAbsolute)
  } catch (error) {
    if (error instanceof ResultContractError && error.kind === 'oversized') fail(messages.oversized)
    fail()
  }
}

type Validator = (args: unknown[]) => void

/**
 * 每个 invoke 通道的运行时 schema。**这份表就是 invoke 通道清单的唯一定义处**：
 * 下方 `INVOKE_CHANNELS` 由它的键派生，因此“登记了新通道却忘了写校验”在构造上
 * 就不可能发生，也不再需要维护任何通道数量常量。
 * 新增通道时在这里加一条即可，`INVOKE_CHANNELS` 与 guard 白名单会自动跟上。
 */
const validators: Record<string, Validator> = {
  [IPC.selectFolder]: (a) => exactArgs(a, 0),
  [IPC.recentProjects]: (a) => exactArgs(a, 0),
  [IPC.generateCancel]: (a) => { exactArgs(a, 1); requestId(a[0]) },
  [IPC.settingsGet]: (a) => exactArgs(a, 0),
  [IPC.storageDiagnostics]: (a) => exactArgs(a, 0),
  [IPC.storageRecover]: (a) => { exactArgs(a, 1); if (!isStorageDiagnosticId(a[0])) fail() },
  [IPC.scanProject]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.removeRecent]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.loadResult]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.deleteResult]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.generateRun]: (a) => { exactArgs(a, 1); generateRequest(a[0]) },
  [IPC.explainStart]: (a) => { exactArgs(a, 1); explain(a[0]) },
  [IPC.explainCancel]: (a) => { exactArgs(a, 1); requestId(a[0]) },
  [IPC.settingsSave]: (a) => { exactArgs(a, 1); settings(a[0]) },
  [IPC.llmTest]: (a) => { exactArgs(a, 1); profile(a[0]) },
  [IPC.llmListModels]: (a) => { exactArgs(a, 1); profile(a[0]) },
  [IPC.exportMarkdown]: (a) => { exactArgs(a, 1); interviewResult(a[0]) }
}

/** IPC 请求白名单；由上面的 schema 表派生，不包含主进程向渲染进程发送的事件。 */
export const INVOKE_CHANNELS: readonly string[] = Object.keys(validators)

/** 在 IPC handler 中校验原始参数；任何未知通道或不符合 schema 的输入均拒绝。 */
export function validateIpcArgs(channel: string, args: unknown[]): void {
  const validator = Object.prototype.hasOwnProperty.call(validators, channel)
    ? validators[channel]
    : undefined
  if (!validator) fail(messages.unknown)
  validator(args)
}
