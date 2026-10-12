import type { InterviewResult } from './types'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { CONTENT_READ_LIMITS, isSafeContentReadPath } from './content-read.ts'

export const LLM_PROFILE_LIMITS = {
  id: 128,
  name: 256,
  model: 256,
  apiKey: 4096,
  baseUrl: 2048
} as const

export const MAX_LLM_PROFILES = 32

export const RESULT_LIMITS = {
  modelUsed: LLM_PROFILE_LIMITS.name + 3 + LLM_PROFILE_LIMITS.model,
  projectName: 256,
  projectPath: 4096,
  createdAt: 128,
  profileId: LLM_PROFILE_LIMITS.id,
  projectSummary: 50_000,
  sections: 200,
  sectionTitle: 512,
  sectionSummary: 12_000,
  questionsPerSection: 500,
  questions: 5000,
  followUpsPerItem: 100,
  followUps: 5000,
  followUpDepth: 16,
  question: 12_000,
  answer: 50_000,
  glossaryEntries: 2000,
  glossaryKey: 512,
  glossaryValue: 12_000,
  categoryKeys: 256,
  categoryKey: 128,
  treeNodes: 20_000,
  treeDepth: 32,
  treeArray: 5000,
  objectKeys: 256,
  totalChars: 1_000_000,
  totalBytes: 4 * 1024 * 1024
} as const

export const EXPLAIN_CONTEXT_LIMITS = {
  term: 512,
  profileId: LLM_PROFILE_LIMITS.id,
  projectSummary: 20_000,
  question: RESULT_LIMITS.question,
  snippet: 24_000,
  glossaryHint: 4000
} as const

export const RESULT_CONTRACT_MESSAGES = {
  generated: '生成结果格式无效或超出支持范围，请重新生成。',
  history: '历史结果格式无效或超出支持范围，请重新生成。'
} as const

export class ResultContractError extends Error {
  readonly kind: 'invalid' | 'oversized'

  constructor(kind: 'invalid' | 'oversized') {
    super(kind)
    this.name = 'ResultContractError'
    this.kind = kind
  }
}

function invalid(): never { throw new ResultContractError('invalid') }
function oversized(): never { throw new ResultContractError('oversized') }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ownDataEntries(value: object): Array<[string, unknown]> {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const entries: Array<[string, unknown]> = []
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') invalid()
    const descriptor = descriptors[key]
    if (!('value' in descriptor) || !descriptor.enumerable) invalid()
    entries.push([key, descriptor.value])
  }
  return entries
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const entries = ownDataEntries(value)
  if (entries.length > allowed.length || entries.some(([key]) => !allowed.includes(key))) invalid()
}

function plainDictionary(value: Record<string, unknown>, maxKeys: number): Array<[string, unknown]> {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const entries = ownDataEntries(value)
  if (entries.length > maxKeys) oversized()
  return entries
}

function text(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0')
}

function string(value: unknown, max: number, min = 1): asserts value is string {
  if (!text(value, max, min)) invalid()
}

function absolutePath(value: unknown, isAbsolutePath?: (value: string) => boolean): asserts value is string {
  string(value, RESULT_LIMITS.projectPath)
  if (isAbsolutePath) {
    if (!isAbsolutePath(value)) invalid()
    return
  }
  if (!(/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(value))) invalid()
}

/** Validate project identity fields before building a context or calling a model. */
export function assertProjectIdentityContract(
  projectName: unknown,
  projectPath: unknown,
  isAbsolutePath?: (value: string) => boolean
): asserts projectName is string {
  string(projectName, RESULT_LIMITS.projectName)
  if (/[\\/\x00-\x1f\x7f]/.test(projectName)) invalid()
  absolutePath(projectPath, isAbsolutePath)
}

function boundedTree(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number; rootGlossary: boolean; undefinedAllowed: boolean }> = [
    { value: root, depth: 0, rootGlossary: false, undefinedAllowed: false }
  ]
  const seen = new WeakSet<object>()
  let nodes = 0
  let chars = 0
  while (stack.length) {
    const { value, depth, rootGlossary, undefinedAllowed } = stack.pop()!
    if (++nodes > RESULT_LIMITS.treeNodes || depth > RESULT_LIMITS.treeDepth) oversized()
    if (typeof value === 'string') {
      chars += value.length
      if (value.length > RESULT_LIMITS.totalChars || chars > RESULT_LIMITS.totalChars) oversized()
    } else if (value === undefined) {
      // Only object properties can be optional; field validation below decides which ones are.
      // Array elements are pushed with undefinedAllowed=false and are rejected here.
      if (!undefinedAllowed) invalid()
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) invalid()
    } else if (typeof value === 'object') {
      if (seen.has(value)) invalid()
      seen.add(value)
      if (Array.isArray(value)) {
        if (value.length > RESULT_LIMITS.treeArray) oversized()
        if (Object.getPrototypeOf(value) !== Array.prototype) invalid()
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) invalid()
        for (let i = 0; i < value.length; i++) {
          const descriptor = descriptors[String(i)]
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid()
          stack.push({ value: descriptor.value, depth: depth + 1, rootGlossary: false, undefinedAllowed: false })
        }
      } else {
        if (!record(value)) invalid()
        const entries = plainDictionary(value, rootGlossary ? RESULT_LIMITS.glossaryEntries : RESULT_LIMITS.objectKeys)
        for (const [key, child] of entries) {
          chars += key.length
          if (chars > RESULT_LIMITS.totalChars) oversized()
          stack.push({ value: child, depth: depth + 1, rootGlossary: value === root && key === 'glossary', undefinedAllowed: true })
        }
      }
    } else invalid()
  }
}

function enumValue<T extends string>(value: unknown, choices: readonly T[]): asserts value is T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid()
}

const CONTENT_READ_REASONS = ['permission', 'missing', 'io'] as const

function isContentReadCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= CONTENT_READ_LIMITS.attempts
}

function assertContentReadSummary(value: unknown): void {
  if (!record(value)) invalid()
  exactKeys(value, ['attemptedReads', 'successfulReads', 'failedReads', 'failuresByReason', 'failures'])
  const { attemptedReads, successfulReads, failedReads } = value
  if (!isContentReadCount(attemptedReads) || !isContentReadCount(successfulReads) || !isContentReadCount(failedReads)) invalid()
  if (attemptedReads !== successfulReads + failedReads) invalid()
  if (!record(value.failuresByReason)) invalid()
  exactKeys(value.failuresByReason, CONTENT_READ_REASONS)
  if (ownDataEntries(value.failuresByReason).length !== CONTENT_READ_REASONS.length) invalid()
  let reasonTotal = 0
  for (const reason of CONTENT_READ_REASONS) {
    const count = value.failuresByReason[reason]
    if (!isContentReadCount(count)) invalid()
    reasonTotal += count
  }
  if (reasonTotal !== failedReads) invalid()
  if (!Array.isArray(value.failures) || value.failures.length > CONTENT_READ_LIMITS.samples || value.failures.length > failedReads) invalid()
  const sampledByReason: Record<(typeof CONTENT_READ_REASONS)[number], number> = { permission: 0, missing: 0, io: 0 }
  for (const failure of value.failures) {
    if (!record(failure)) invalid()
    exactKeys(failure, ['path', 'reason'])
    if (typeof failure.path !== 'string' || failure.path.length === 0) invalid()
    if (failure.path.length > CONTENT_READ_LIMITS.path) oversized()
    if (!isSafeContentReadPath(failure.path)) invalid()
    enumValue(failure.reason, CONTENT_READ_REASONS)
    sampledByReason[failure.reason]++
  }
  for (const reason of CONTENT_READ_REASONS) {
    const count = value.failuresByReason[reason]
    if (!isContentReadCount(count) || sampledByReason[reason] > count) invalid()
  }
}

function compactJsonByteLength(value: unknown): number {
  if (value === null) return 4
  if (typeof value === 'string') return new TextEncoder().encode(JSON.stringify(value)).length
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number') return String(Object.is(value, -0) ? 0 : value).length
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    let bytes = 2 + Math.max(0, value.length - 1)
    for (let index = 0; index < value.length; index++) {
      bytes += compactJsonByteLength(descriptors[String(index)].value)
    }
    return bytes
  }
  if (record(value)) {
    let bytes = 2
    let count = 0
    for (const [key, item] of ownDataEntries(value)) {
      if (item === undefined) continue
      if (count++) bytes++
      bytes += new TextEncoder().encode(JSON.stringify(key)).length + 1 + compactJsonByteLength(item)
    }
    return bytes
  }
  invalid()
}

const GRANULARITIES = ['coarse', 'medium', 'fine'] as const
const ROLES = ['general', 'frontend', 'backend', 'algorithm'] as const

/** Validates untrusted interview results without invoking accessors or processing unbounded structures. */
export function assertInterviewResultContract(
  value: unknown,
  isAbsolutePath?: (value: string) => boolean
): asserts value is InterviewResult {
  boundedTree(value)
  if (!record(value)) invalid()
  exactKeys(value, ['version', 'createdAt', 'projectName', 'projectPath', 'granularity', 'roleFocus', 'profileId', 'modelUsed', 'projectSummary', 'sections', 'glossary', 'security', 'contextTruncation', 'contentReadSummary'])
  if (value.version !== 1 || !text(value.createdAt, RESULT_LIMITS.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) || !text(value.projectName, RESULT_LIMITS.projectName)) invalid()
  assertProjectIdentityContract(value.projectName, value.projectPath, isAbsolutePath)
  enumValue(value.granularity, GRANULARITIES)
  enumValue(value.roleFocus, ROLES)
  string(value.profileId, RESULT_LIMITS.profileId)
  string(value.modelUsed, RESULT_LIMITS.modelUsed)
  string(value.projectSummary, RESULT_LIMITS.projectSummary, 0)
  if (value.contextTruncation !== undefined) {
    if (!record(value.contextTruncation)) invalid()
    exactKeys(value.contextTruncation, ['treeTruncated', 'contentTruncated', 'requestTruncated'])
    for (const key of ['treeTruncated', 'contentTruncated', 'requestTruncated'] as const) {
      if (typeof value.contextTruncation[key] !== 'boolean') invalid()
    }
    if (!value.contextTruncation.treeTruncated && !value.contextTruncation.contentTruncated && !value.contextTruncation.requestTruncated) invalid()
  }
  if (!Array.isArray(value.sections) || value.sections.length > RESULT_LIMITS.sections || !record(value.glossary)) invalid()
  const glossary = plainDictionary(value.glossary, RESULT_LIMITS.glossaryEntries)
  if (value.security !== undefined) {
    if (!record(value.security)) invalid()
    exactKeys(value.security, ['excludedFiles', 'redactedFiles', 'redactionMatches', 'categories'])
    for (const key of ['excludedFiles', 'redactedFiles', 'redactionMatches'] as const) {
      const count = value.security[key]
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) invalid()
    }
    if (!record(value.security.categories)) invalid()
    const categories = plainDictionary(value.security.categories, RESULT_LIMITS.categoryKeys)
    for (const [category, count] of categories) {
      string(category, RESULT_LIMITS.categoryKey)
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) invalid()
    }
  }
  if (value.contentReadSummary !== undefined) assertContentReadSummary(value.contentReadSummary)
  let questions = 0
  let follows = 0
  const checkFollow = (follow: unknown, depth: number): void => {
    if (++follows > RESULT_LIMITS.followUps || depth > RESULT_LIMITS.followUpDepth) oversized()
    if (!record(follow)) invalid()
    exactKeys(follow, ['question', 'answer', 'followUps'])
    string(follow.question, RESULT_LIMITS.question)
    string(follow.answer, RESULT_LIMITS.answer, 0)
    if (follow.followUps !== undefined) {
      if (!Array.isArray(follow.followUps) || follow.followUps.length > RESULT_LIMITS.followUpsPerItem) invalid()
      for (const child of follow.followUps) checkFollow(child, depth + 1)
    }
  }
  for (const section of value.sections) {
    if (!record(section)) invalid()
    exactKeys(section, ['id', 'title', 'summary', 'questions'])
    string(section.id, RESULT_LIMITS.profileId)
    string(section.title, RESULT_LIMITS.sectionTitle)
    if (section.summary !== undefined) string(section.summary, RESULT_LIMITS.sectionSummary, 0)
    if (!Array.isArray(section.questions) || section.questions.length > RESULT_LIMITS.questionsPerSection) invalid()
    for (const question of section.questions) {
      if (++questions > RESULT_LIMITS.questions || !record(question) || !Array.isArray(question.followUps) || question.followUps.length > RESULT_LIMITS.followUpsPerItem) oversized()
      exactKeys(question, ['id', 'question', 'answer', 'followUps'])
      string(question.id, RESULT_LIMITS.profileId)
      string(question.question, RESULT_LIMITS.question)
      string(question.answer, RESULT_LIMITS.answer, 0)
      for (const child of question.followUps) checkFollow(child, 1)
    }
  }
  for (const [key, item] of glossary) {
    string(key, RESULT_LIMITS.glossaryKey)
    string(item, RESULT_LIMITS.glossaryValue, 0)
  }

  if (compactJsonByteLength(value) > RESULT_LIMITS.totalBytes) oversized()
}
