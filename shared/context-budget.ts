import type { ContextTruncationMetadata, Granularity } from './types'
export type { ContextTruncationMetadata } from './types'

/** Character limits for the complete text sent to the model, summed across messages. */
export const CONTEXT_CHAR_BUDGETS: Record<Granularity, number> = {
  coarse: 60_000,
  medium: 220_000,
  fine: 160_000
}

/** The model and the result UI use this same static warning when context was omitted. */
export const CONTEXT_TRUNCATION_WARNING = '部分项目信息未参与分析，结果可能遗漏相关内容。'

export function hasContextTruncation(meta?: ContextTruncationMetadata): boolean {
  return Boolean(meta && (meta.treeTruncated || meta.contentTruncated || meta.requestTruncated))
}

/** Keep the project tree informative without letting names consume the request. */
export function treeCharBudget(granularity: Granularity): number {
  return Math.min(12_000, Math.floor(CONTEXT_CHAR_BUDGETS[granularity] * 0.2))
}

export function formatContextTruncationWarning(meta?: ContextTruncationMetadata): string {
  return hasContextTruncation(meta) ? `⚠️ ${CONTEXT_TRUNCATION_WARNING}` : ''
}

/** Clip at a UTF-16 code point boundary and keep a short, stable omission marker. */
export function safeClipText(text: string, maxChars: number, marker = '…（已截断）'): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  const suffix = marker.length <= maxChars ? marker : ''
  let end = Math.max(0, maxChars - suffix.length)
  const last = text.charCodeAt(end - 1)
  const next = text.charCodeAt(end)
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
  return text.slice(0, end) + suffix
}

export function validateMessageCharBudget(
  messages: ReadonlyArray<{ content: string }>,
  budget: number
): boolean {
  return messages.reduce((total, message) => total + message.content.length, 0) <= budget
}
