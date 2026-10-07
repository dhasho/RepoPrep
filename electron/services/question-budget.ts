// 题量配额规划：把某一颗粒度的总题量预算分配到各个分析批次上。
//
// 背景（issue #9）：细粒度原先让全局批出 10–15 题、每个模块批各出 6–10 题，
// 最多 1 + 10 个批次，实际可得 70–115 题，与界面/README 承诺的 25–40 题严重不符。
//
// 这里把「总题量」变成可分配的预算：先按批次权重把 target 分配下去，
// 得到一组期望值，再整体线性缩放并做上下限钳制，最后用「最大余数法」补齐到 target。
// 结果满足 min ≤ Σ 配额 ≤ max，且每个批次都在 [minPerBatch, maxPerBatch] 区间内。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { GRANULARITY_QUESTION_BUDGET, type Granularity } from '../../shared/types.ts'

/** 单个批次请求的题量下限：太少会让该模块失去考察价值 */
export const MIN_QUESTIONS_PER_BATCH = 2
/** 单个批次请求的题量上限：过多会让模型输出质量下降 */
export const MAX_QUESTIONS_PER_BATCH = 8
/** 全局批（架构/选型批）在细粒度下承担的最低题量 */
export const MIN_QUESTIONS_GLOBAL = 6
/** 全局批的权重下限：全局概览的重要性不低于任一单个模块 */
export const MIN_GLOBAL_WEIGHT = 0.5

export type BatchKind = 'global' | 'module'

export interface BatchWeightInput {
  label: string
  /** 相对权重（例如由文件数与字符数合成）。会被归一化，无需提前缩放。 */
  weight: number
  kind: BatchKind
}

export interface BatchQuota {
  label: string
  kind: BatchKind
  weight: number
  /** 该批次应当请求的题量 */
  quota: number
}

export interface QuestionPlan {
  granularity: Granularity
  /** 规划出的总题量（= 各配额之和，落在预算区间内） */
  total: number
  min: number
  max: number
  quotas: BatchQuota[]
}

/** 由文件数与字符数合成批次权重：两者都很小的模块不应该拿到和核心模块一样的题量。 */
export function batchWeight(fileCount: number, totalChars: number): number {
  const files = Math.max(0, fileCount)
  const chars = Math.max(0, totalChars)
  // 几何平均：既照顾"文件多但都短"的模块，也照顾"文件少但很长"的模块
  return Math.sqrt(files * Math.max(chars / 1000, 1))
}

function sanitizeWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0
}

/**
 * 按批次权重把预算分配到各批次。
 *
 * 算法：
 * 1. 权重归一化，算出各批次的期望题量 target × share；
 * 2. 钳制到 [minPerBatch, maxPerBatch]；若钳制后的总和仍不等于 target，
 *    用「最大余数法」逐个增/减：优先给"应得份额 - 当前配额"最大者 +1，
 *    优先从"当前配额 - 应得份额"最大者 -1；
 * 3. 全局批额外保证不低于 MIN_QUESTIONS_GLOBAL。
 *
 * ## 总量保证与适用边界（重要）
 *
 * 单批上下限可能让 target 不可达：
 * - 若「各批下限之和 > budget.max」→ 总量会**超过**上限（受下限约束，此时保证不了区间）；
 * - 若「各批上限之和 < budget.min」→ 总量会低于下限。
 * 因此本函数保证的是：**当预算区间可行时（下限之和 ≤ max 且上限之和 ≥ min），
 * 结果满足 budget.min ≤ Σ配额 ≤ budget.max**；不可行时退化为边界值且不抛错。
 *
 * 调用方必须意识到这个边界与批次数直接相关：全局批下限 6 + 每个模块批下限 2，
 * 因此只有**批次数 ≤ 17** 时下限之和（6 + 2×(n-1)）才不超过 max=40。
 * 当前 context-builder 的 MAX_MODULE_BATCHES = 10（最多 11 批、下限之和 26）留有充足余量；
 * **若将来调大 MAX_MODULE_BATCHES 超过 17，细粒度就会突破 25–40**。
 * 相应地，batchCountBound.test 里固定了这一约束。
 */
export function planQuestionQuotas(
  granularity: Granularity,
  batches: readonly BatchWeightInput[]
): QuestionPlan {
  const budget = GRANULARITY_QUESTION_BUDGET[granularity]

  if (!batches.length) {
    return { granularity, total: 0, min: budget.min, max: budget.max, quotas: [] }
  }

  const weights = batches.map((b) => sanitizeWeight(b.weight))
  const weightSum = weights.reduce((a, b) => a + b, 0)
  // 权重全为 0 时退化为等权，保证仍然能分配出配额
  const shares = weights.map((w) => (weightSum > 0 ? w / weightSum : 1 / batches.length))

  const minOf = (index: number): number =>
    batches[index].kind === 'global'
      ? Math.max(MIN_QUESTIONS_PER_BATCH, MIN_QUESTIONS_GLOBAL)
      : MIN_QUESTIONS_PER_BATCH
  // 单批时该批就是全部产出，上限必须是预算上限（否则 coarse 的 10 题会被砍到 8）。
  // 多批时用较小的单批上限，但要保证"各批上限之和 ≥ target"仍然成立，
  // 否则配额会被上限卡住、总量达不到 target（例如 2 个批次 × 上限 8 = 16 < 32）。
  const maxOf = (): number =>
    batches.length === 1
      ? budget.max
      : Math.max(MAX_QUESTIONS_PER_BATCH, Math.ceil(budget.target / batches.length) + 4)

  const minSum = batches.reduce((sum, _b, i) => sum + minOf(i), 0)
  const maxSum = batches.length * maxOf()
  const target = Math.min(Math.max(budget.target, minSum), Math.max(maxSum, minSum))

  const ideal = shares.map((share) => share * target)
  const quotas = ideal.map((value, i) => Math.min(Math.max(Math.round(value), minOf(i)), maxOf()))

  // 用最大余数法把总和精确对齐到 target
  let diff = target - quotas.reduce((a, b) => a + b, 0)
  let guard = batches.length * 4 + 8
  while (diff !== 0 && guard-- > 0) {
    if (diff > 0) {
      let best = -1
      let bestScore = -Infinity
      for (let i = 0; i < quotas.length; i++) {
        if (quotas[i] >= maxOf()) continue
        const score = ideal[i] - quotas[i]
        if (score > bestScore) {
          bestScore = score
          best = i
        }
      }
      if (best < 0) break // 已全部触顶，无法再增加
      quotas[best]++
      diff--
    } else {
      let best = -1
      let bestScore = -Infinity
      for (let i = 0; i < quotas.length; i++) {
        if (quotas[i] <= minOf(i)) continue
        const score = quotas[i] - ideal[i]
        if (score > bestScore) {
          bestScore = score
          best = i
        }
      }
      if (best < 0) break // 已全部触底，无法再减少
      quotas[best]--
      diff++
    }
  }

  const quotasOut: BatchQuota[] = batches.map((batch, i) => ({
    label: batch.label,
    kind: batch.kind,
    weight: weights[i],
    quota: quotas[i]
  }))

  return {
    granularity,
    total: quotasOut.reduce((sum, q) => sum + q.quota, 0),
    min: budget.min,
    max: budget.max,
    quotas: quotasOut
  }
}

/**
 * 按配额裁剪单个批次产出：超出配额时保留前 quota 题。
 *
 * 选择"保留前 N 题"是因为提示词里已要求模型按重要性排序、优先覆盖核心内容，
 * 且这样是确定性的、可测试的。整个 section 被裁空时不保留该 section（由调用方过滤）。
 *
 * quota 会被规范化为非负整数（NaN/负数/小数一律归零或向下取整），
 * 避免出现 kept 为小数、或保留空 section 这类畸形结果。
 */
export function truncateToQuota<S extends { questions: unknown[] }>(
  sections: readonly S[],
  quota: number
): { sections: S[]; kept: number; dropped: number } {
  const limit = Number.isFinite(quota) ? Math.max(0, Math.floor(quota)) : 0
  const keptSections: S[] = []
  let kept = 0
  let dropped = 0

  for (const section of sections) {
    if (kept >= limit) {
      dropped += section.questions.length
      continue
    }
    const room = limit - kept
    if (section.questions.length <= room) {
      keptSections.push(section)
      kept += section.questions.length
      continue
    }
    keptSections.push({ ...section, questions: section.questions.slice(0, room) })
    kept += room
    dropped += section.questions.length - room
  }

  return { sections: keptSections, kept, dropped }
}
