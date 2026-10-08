// 题号计算：为每个问题建立稳定的原始全局序号。
//
// 背景（issue #11）：结果页在搜索过滤后，用**过滤数组**的下标去查询**原始数组**，
// 导致题号随搜索词变化，甚至出现 Q0；大纲里的 Q 标签则完全没有编号。
//
// 这里把序号计算与渲染解耦：过滤只改变"哪些项可见"，不改变序号。
// 序号一律基于原始结果预先算好（O(n)），渲染期间只做 Map 查表，不再遍历全部问题。
//
// 为什么同时用"位置"和"id"两个键：
// - 位置键（sectionIndex:questionIndex）是**权威**来源，任何数据都能算出正确序号，
//   因此即便历史结果缺少 id（loadResult 不校验磁盘 JSON）或出现重复 id，也不会显示错误编号；
// - id 键是快路径，让渲染侧可以只凭 q.id 取号。重复 id 时它保留首次出现的位置，
//   不会覆盖成后面那一个（渲染侧请优先传位置，见 numberOf）。
import type { Section } from '@shared/types'

/** 一个问题在原始结果中的稳定位置 */
export interface QuestionPosition {
  /** 原始全局序号（1 起，跨 section 连续） */
  number: number
  /** 原始 section 序号（1 起，不随过滤变化） */
  sectionNumber: number
  /** 原始 section 内下标 */
  questionIndex: number
}

/** 问题位置 → 稳定序号（权威） */
export type QuestionNumberMap = ReadonlyMap<string, QuestionPosition>

const positionKey = (sectionIndex: number, questionIndex: number): string => `${sectionIndex}:${questionIndex}`

/**
 * 为整个结果建立序号映射。
 *
 * **必须在过滤之前**基于原始 sections 调用，这样序号才与过滤条件无关。
 * 返回的 Map 同时支持位置键（`${sectionIndex}:${questionIndex}`）与问题 id 键。
 */
export function buildQuestionNumbers(sections: readonly Section[]): QuestionNumberMap {
  const map = new Map<string, QuestionPosition>()
  let number = 0
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const questions = sections[sectionIndex]?.questions ?? []
    for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
      number++
      const position: QuestionPosition = { number, sectionNumber: sectionIndex + 1, questionIndex }
      map.set(positionKey(sectionIndex, questionIndex), position)
      const id = questions[questionIndex]?.id
      // id 只用快路径：重复 id 时保留首次出现的位置，不覆盖
      if (typeof id === 'string' && id && !map.has(id)) map.set(id, position)
    }
  }
  return map
}

/**
 * 取问题的稳定全局序号；查不到时返回 0（调用方据此显示未知，而不是伪造编号）。
 *
 * 建议同时传位置（sectionIndex/questionIndex）：位置是权威键，
 * 能覆盖 id 缺失或重复 id 的数据；只传 id 时退化为 id 查找。
 */
export function numberOf(
  map: QuestionNumberMap,
  questionId: string | undefined,
  position?: { sectionIndex: number; questionIndex: number }
): number {
  return lookup(map, questionId, position)?.number ?? 0
}

/** 取问题所属的原始 section 序号；查不到时用调用方给的兜底值 */
export function sectionNumberOf(
  map: QuestionNumberMap,
  questionId: string | undefined,
  position?: { sectionIndex: number; questionIndex: number },
  fallback = 0
): number {
  return lookup(map, questionId, position)?.sectionNumber ?? fallback
}

function lookup(
  map: QuestionNumberMap,
  questionId: string | undefined,
  position?: { sectionIndex: number; questionIndex: number }
): QuestionPosition | undefined {
  if (position) {
    const byPosition = map.get(positionKey(position.sectionIndex, position.questionIndex))
    if (byPosition) return byPosition
  }
  return questionId ? map.get(questionId) : undefined
}

/** 题号显示格式：统一两位补零，例如 Q03；未知序号显示 Q-- */
export function formatQuestionNumber(n: number): string {
  return n > 0 ? `Q${String(n).padStart(2, '0')}` : 'Q--'
}
