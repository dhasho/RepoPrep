import path from 'node:path'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import type { GenerateOptions, Granularity, InterviewResult, LlmProfile, RoleFocus, Settings } from '../../shared/types.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import { SCAN_LIMIT_BOUNDS } from '../../shared/types.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; runtime tests need them.
import { IPC } from '../../shared/ipc.ts'

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
function plainDictionary(value: Record<string, unknown>, maxKeys: number): void {
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  if ((prototype !== Object.prototype && prototype !== null) || keys.length > maxKeys || keys.some((key) => typeof key !== 'string')) fail()
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
  string(value, 2048)
  let parsed: URL
  try { parsed = new URL(value) } catch { return fail() }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) fail()
}
function profile(value: unknown): asserts value is LlmProfile {
  if (!record(value)) fail()
  exactKeys(value, ['id', 'name', 'baseUrl', 'apiKey', 'model', 'temperature'])
  string(value.id, 128); string(value.name, 256); url(value.baseUrl)
  string(value.apiKey, 4096, 0); string(value.model, 256)
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
  if (!record(value) || !Array.isArray(value.profiles) || value.profiles.length > 32) fail()
  exactKeys(value, ['profiles', 'defaultProfileId', 'scanLimits'])
  if (value.defaultProfileId !== null) string(value.defaultProfileId, 128)
  for (const item of value.profiles) profile(item)
  if (value.defaultProfileId !== null && !value.profiles.some((p) => record(p) && p.id === value.defaultProfileId)) fail()
  if (value.scanLimits !== undefined) scanLimits(value.scanLimits)
}

const GRANULARITIES = ['coarse', 'medium', 'fine'] as const satisfies readonly Granularity[]
const ROLES = ['general', 'frontend', 'backend', 'algorithm'] as const satisfies readonly RoleFocus[]
function generateOptions(value: unknown): asserts value is GenerateOptions {
  if (!record(value)) fail()
  exactKeys(value, ['projectPath', 'granularity', 'roleFocus', 'profileId'])
  absolutePath(value.projectPath); enumValue(value.granularity, GRANULARITIES); enumValue(value.roleFocus, ROLES); string(value.profileId, 128)
}
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function requestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) fail()
}
function explain(value: unknown): void {
  if (!record(value)) fail()
  exactKeys(value, ['requestId', 'term', 'profileId', 'projectSummary', 'question', 'snippet', 'glossaryHint'])
  requestId(value.requestId); string(value.term, 512); string(value.profileId, 128)
  string(value.projectSummary, 20_000, 0); string(value.question, 12_000); string(value.snippet, 24_000, 0)
  if (value.glossaryHint !== undefined) string(value.glossaryHint, 4_000, 0)
}

/** 对传入树做有界遍历，避免 stringify、循环引用及超大/深层对象造成无界工作。 */
function boundedTree(root: unknown, limits = { nodes: 20_000, depth: 32, string: 1_000_000, array: 5000, keys: 256 }): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0; let chars = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++nodes > limits.nodes || depth > limits.depth) fail(messages.oversized)
    if (typeof value === 'string') {
      chars += value.length
      if (value.length > limits.string || chars > limits.string) fail(messages.oversized)
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) fail()
    } else if (typeof value === 'object') {
      if (seen.has(value)) fail()
      seen.add(value)
      if (Array.isArray(value)) {
        if (value.length > limits.array) fail(messages.oversized)
        if (Object.getPrototypeOf(value) !== Array.prototype) fail()
        const keys = Reflect.ownKeys(value)
        if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail()
        for (let i = 0; i < value.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(value, i)) fail()
          stack.push({ value: value[i], depth: depth + 1 })
        }
      } else {
        let count = 0
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue
          if (++count > limits.keys) fail(messages.oversized)
          chars += key.length
          if (chars > limits.string) fail(messages.oversized)
          stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
        }
      }
    } else fail()
  }
}
function interviewResult(value: unknown): asserts value is InterviewResult {
  boundedTree(value)
  if (!record(value)) fail()
  exactKeys(value, ['version', 'createdAt', 'projectName', 'projectPath', 'granularity', 'roleFocus', 'profileId', 'modelUsed', 'projectSummary', 'sections', 'glossary', 'security'])
  if (value.version !== 1 || !text(value.createdAt, 128) || !Number.isFinite(Date.parse(value.createdAt)) || !text(value.projectName, 256)) fail()
  if (/[\\/\x00-\x1f\x7f]/.test(value.projectName)) fail()
  absolutePath(value.projectPath); enumValue(value.granularity, GRANULARITIES); enumValue(value.roleFocus, ROLES)
  string(value.profileId, 128); string(value.modelUsed, 256); string(value.projectSummary, 50_000, 0)
  if (!Array.isArray(value.sections) || value.sections.length > 200 || !record(value.glossary)) fail()
  plainDictionary(value.glossary, 2000)
  if (value.security !== undefined) {
    if (!record(value.security)) fail()
    exactKeys(value.security, ['excludedFiles', 'redactedFiles', 'redactionMatches', 'categories'])
    for (const key of ['excludedFiles', 'redactedFiles', 'redactionMatches'] as const) {
      const count = value.security[key]
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail()
    }
    if (!record(value.security.categories)) fail()
    plainDictionary(value.security.categories, 256)
    for (const category of Reflect.ownKeys(value.security.categories) as string[]) {
      const count = value.security.categories[category]
      string(category, 128)
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail()
    }
  }
  let questions = 0; let follows = 0
  const checkFollow = (f: unknown, depth: number): void => {
    if (++follows > 5000 || depth > 16 || !record(f)) fail(messages.oversized)
    exactKeys(f, ['question', 'answer', 'followUps'])
    string(f.question, 12_000); string(f.answer, 50_000, 0)
    if (f.followUps !== undefined) {
      if (!Array.isArray(f.followUps) || f.followUps.length > 100) fail()
      for (const child of f.followUps) checkFollow(child, depth + 1)
    }
  }
  for (const section of value.sections) {
    if (!record(section)) fail()
    exactKeys(section, ['id', 'title', 'summary', 'questions'])
    string(section.id, 128); string(section.title, 512)
    if (section.summary !== undefined) string(section.summary, 12_000, 0)
    if (!Array.isArray(section.questions) || section.questions.length > 500) fail()
    for (const question of section.questions) {
      if (++questions > 5000 || !record(question) || !Array.isArray(question.followUps) || question.followUps.length > 100) fail(messages.oversized)
      exactKeys(question, ['id', 'question', 'answer', 'followUps'])
      string(question.id, 128); string(question.question, 12_000); string(question.answer, 50_000, 0)
      for (const child of question.followUps) checkFollow(child, 1)
    }
  }
  for (const key of Reflect.ownKeys(value.glossary) as string[]) {
    string(key, 512)
    string(value.glossary[key], 12_000, 0)
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
  [IPC.generateCancel]: (a) => exactArgs(a, 0),
  [IPC.settingsGet]: (a) => exactArgs(a, 0),
  [IPC.scanProject]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.removeRecent]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.loadResult]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.deleteResult]: (a) => { exactArgs(a, 1); absolutePath(a[0]) },
  [IPC.generateRun]: (a) => { exactArgs(a, 1); generateOptions(a[0]) },
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
