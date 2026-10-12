import type { Section } from '@shared/types'

export const MAX_COMPENSATION_INSTRUCTION_CHARS = 8000

/** Normalize only the visible question wording; answers and term definitions stay untouched. */
export function normalizeQuestionKey(text: string): string {
  return text
    .replace(/\[\[([^\[\]]*)\]\]/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

export function selectUniqueQuestions(
  sections: readonly Section[],
  quota: number,
  seen: Set<string>
): { sections: Section[]; kept: number; dropped: number; duplicates: number } {
  const limit = Number.isFinite(quota) ? Math.max(0, Math.floor(quota)) : 0
  const selected: Section[] = []
  let kept = 0
  let dropped = 0
  let duplicates = 0

  for (const section of sections) {
    const questions = [] as Section['questions']
    for (const question of section.questions) {
      const key = normalizeQuestionKey(question.question)
      if (seen.has(key)) {
        duplicates++
        continue
      }
      if (kept >= limit) {
        dropped++
        continue
      }
      seen.add(key)
      questions.push(question)
      kept++
    }
    if (questions.length) selected.push({ ...section, questions })
  }

  return { sections: selected, kept, dropped, duplicates }
}

function clipAtCodePointBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  let clipped = ''
  for (const point of text) {
    if (clipped.length + point.length > maxChars) break
    clipped += point
  }
  return clipped
}

export function buildCompensationInstruction(input: {
  delivered: number
  gap: number
  ask: number
  sections: readonly Section[]
}): string {
  const prefix =
    `这是补充请求：此前该部分已保留 ${input.delivered} 题，总量还差 ${input.gap} 题。` +
    `请再补充 ${input.ask} 个此前没有覆盖到的考察点，不要重复已有问题。\n` +
    '以下是已保留的问题，请避开这些问题：\n'
  const omission = '…（其余问题省略）'
  const max = MAX_COMPENSATION_INSTRUCTION_CHARS
  if (prefix.length + omission.length > max) return clipAtCodePointBoundary(prefix, max)

  const questions: string[] = []
  const seen = new Set<string>()
  for (const section of input.sections) {
    for (const question of section.questions) {
      const key = normalizeQuestionKey(question.question)
      if (seen.has(key)) continue
      seen.add(key)
      questions.push(question.question.replace(/\s+/g, ' ').trim())
    }
  }

  let output = prefix
  for (let index = 0; index < questions.length; index++) {
    const line = `- ${questions[index]}\n`
    const moreRemain = index < questions.length - 1
    const reserve = moreRemain ? omission.length : 0
    const available = max - output.length - reserve
    if (line.length <= available) {
      output += line
      continue
    }

    const truncatedAvailable = max - output.length - omission.length
    if (truncatedAvailable > 3) {
      const content = clipAtCodePointBoundary(questions[index], truncatedAvailable - 4)
      output += `- ${content}…\n`
    }
    if (moreRemain || line.length > available) output += omission
    break
  }
  return clipAtCodePointBoundary(output, max)
}
