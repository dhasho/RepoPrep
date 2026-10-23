import type { Granularity, LlmProfile } from './types'

export const TOKEN_ESTIMATE_METHOD = 'mixed-text-v1' as const
export const INPUT_TOKEN_TARGETS: Record<Granularity, number> = { coarse: 16_000, medium: 32_000, fine: 24_000 }
export const DEFAULT_OUTPUT_RESERVE = 16_384
export const DEEPSEEK_THINKING_RESERVE = 65_536

/** Conservative monotonic estimate: ASCII word runs ~= 4 chars/token, punctuation and whitespace separately; CJK one code point/token; other Unicode ~= 2 code points/token. This is not provider tokenization. */
export function estimateTextTokens(text: string): number {
  let total = 0
  let asciiWord = 0
  let asciiWhitespace = 0
  let otherUnicode = 0
  const flushWord = (): void => { total += Math.ceil(asciiWord / 4); asciiWord = 0 }
  const flushUnicode = (): void => { total += Math.ceil(otherUnicode / 2); otherUnicode = 0 }
  const flushWhitespace = (): void => { total += Math.ceil(asciiWhitespace / 4); asciiWhitespace = 0 }
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (cp <= 0x7f && /[A-Za-z0-9]/.test(char)) { flushUnicode(); flushWhitespace(); asciiWord++; continue }
    flushWord()
    if (cp >= 0x3400 && cp <= 0x9fff || cp >= 0xf900 && cp <= 0xfaff || cp >= 0x20000 && cp <= 0x3134f) {
      flushUnicode(); flushWhitespace(); total++
    } else if (cp <= 0x7f && /\s/.test(char)) { flushUnicode(); asciiWhitespace++ }
    else if (/\s/.test(char)) { flushUnicode(); flushWhitespace(); total++ }
    else if (cp <= 0x7f) { flushUnicode(); flushWhitespace(); total++ }
    else { flushWhitespace(); otherUnicode++ }
  }
  flushWord(); flushUnicode(); flushWhitespace()
  return total
}

export function estimateMessageTokens(messages: readonly { role: string; content: string }[]): number {
  return messages.reduce((sum, message) => sum + estimateTextTokens(message.content) + 4 + estimateTextTokens(message.role), 2)
}

export interface GenerationBudget { inputTokens: number; reservedOutputTokens: number; contextWindowTokens: number | null }
export function resolveGenerationBudget(profile: Pick<LlmProfile, 'protocol' | 'model' | 'contextWindowTokens' | 'maxOutputTokens'>, granularity: Granularity): GenerationBudget {
  const deepseek = /deepseek.*(v4|flash|reasoner)/i.test(profile.model)
  const reserve = profile.maxOutputTokens ?? (profile.protocol === 'anthropic' ? DEFAULT_OUTPUT_RESERVE : deepseek ? DEEPSEEK_THINKING_RESERVE : DEFAULT_OUTPUT_RESERVE)
  const window = profile.contextWindowTokens ?? null
  const appTarget = INPUT_TOKEN_TARGETS[granularity]
  return { inputTokens: Math.max(0, window === null ? appTarget : Math.min(appTarget, window - reserve)), reservedOutputTokens: reserve, contextWindowTokens: window }
}
