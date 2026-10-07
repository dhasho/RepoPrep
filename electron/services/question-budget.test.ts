// 题量配额规划的单元测试（issue #9）
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { GRANULARITY_QUESTION_BUDGET, GRANULARITY_META, questionCountLabel } from '../../shared/types.ts'
import {
  batchWeight,
  MAX_QUESTIONS_PER_BATCH,
  MIN_QUESTIONS_GLOBAL,
  MIN_QUESTIONS_PER_BATCH,
  planQuestionQuotas,
  truncateToQuota,
  type BatchWeightInput
  // @ts-expect-error Node 24 strip-types requires the explicit extension; project bundler resolution does not.
} from './question-budget.ts'

const globalBatch = (weight: number): BatchWeightInput => ({ label: '全局概览', weight, kind: 'global' })
const moduleBatch = (name: string, weight: number): BatchWeightInput => ({ label: `模块「${name}」`, weight, kind: 'module' })

/** 断言配额结果满足全部结构性约束 */
function assertPlanInvariants(
  plan: ReturnType<typeof planQuestionQuotas>,
  batches: readonly BatchWeightInput[]
): void {
  const sum = plan.quotas.reduce((a, q) => a + q.quota, 0)
  assert.equal(plan.total, sum, 'total 应等于各配额之和')
  // 单批时该批就是全部产出，上限为预算上限；多批时上限自适应（见 maxOf 注释）
  const maxPerBatch =
    batches.length === 1 ? plan.max : Math.max(MAX_QUESTIONS_PER_BATCH, Math.ceil(plan.total / batches.length) + 4)
  for (const q of plan.quotas) {
    assert.ok(q.quota >= MIN_QUESTIONS_PER_BATCH, `${q.label} 配额 ${q.quota} 低于单批下限`)
    assert.ok(q.quota <= maxPerBatch, `${q.label} 配额 ${q.quota} 高于单批上限 ${maxPerBatch}`)
  }
  // 全局批不低于其专属下限
  for (const q of plan.quotas) {
    if (q.kind === 'global') assert.ok(q.quota >= MIN_QUESTIONS_GLOBAL, `全局批配额 ${q.quota} 低于 ${MIN_QUESTIONS_GLOBAL}`)
  }
  // 只要批次数量允许，总量应落在预算区间内
  const minFeasible = batches.reduce(
    (a, b) => a + (b.kind === 'global' ? Math.max(MIN_QUESTIONS_PER_BATCH, MIN_QUESTIONS_GLOBAL) : MIN_QUESTIONS_PER_BATCH),
    0
  )
  const maxFeasible = batches.length * MAX_QUESTIONS_PER_BATCH
  if (minFeasible <= plan.max && maxFeasible >= plan.min) {
    assert.ok(sum >= plan.min, `总量 ${sum} 低于预算下限 ${plan.min}`)
    assert.ok(sum <= plan.max, `总量 ${sum} 高于预算上限 ${plan.max}`)
  }
}

test('预算元数据与界面文案一致，且细粒度区间就是 25–40', () => {
  assert.deepEqual(GRANULARITY_QUESTION_BUDGET.fine, { min: 25, target: 32, max: 40 })
  assert.deepEqual(GRANULARITY_QUESTION_BUDGET.coarse, { min: 8, target: 10, max: 12 })
  assert.deepEqual(GRANULARITY_QUESTION_BUDGET.medium, { min: 15, target: 20, max: 25 })
  // 界面文案由预算生成，不可能与预算脱节
  assert.equal(GRANULARITY_META.fine.count, '约 25–40 题')
  assert.equal(GRANULARITY_META.coarse.count, '约 8–12 题')
  assert.equal(GRANULARITY_META.medium.count, '约 15–25 题')
  for (const g of ['coarse', 'medium', 'fine'] as const) {
    assert.equal(GRANULARITY_META[g].count, questionCountLabel(g))
    const b = GRANULARITY_QUESTION_BUDGET[g]
    assert.ok(b.min < b.target && b.target < b.max)
  }
})

test('单个全局批次（粗/中粒度）拿到该颗粒度的总题量目标', () => {
  for (const g of ['coarse', 'medium'] as const) {
    const plan = planQuestionQuotas(g, [globalBatch(1)])
    assert.equal(plan.quotas.length, 1)
    assert.equal(plan.quotas[0].quota, GRANULARITY_QUESTION_BUDGET[g].target)
    assertPlanInvariants(plan, [globalBatch(1)])
  }
})

test('细粒度：无模块批时全局批独占预算，仍在区间内', () => {
  const batches = [globalBatch(1)]
  const plan = planQuestionQuotas('fine', batches)
  assert.equal(plan.quotas[0].quota, GRANULARITY_QUESTION_BUDGET.fine.target)
  assertPlanInvariants(plan, batches)
})

test('细粒度：小项目（1 个模块）总量落在 25–40', () => {
  const batches = [globalBatch(1), moduleBatch('src', batchWeight(8, 32_000))]
  const plan = planQuestionQuotas('fine', batches)
  assertPlanInvariants(plan, batches)
  assert.ok(plan.total >= 25 && plan.total <= 40, `总量 ${plan.total} 越界`)
})

test('细粒度：10 个顶层模块（上限）总量仍落在 25–40 且每模块都有题', () => {
  const batches: BatchWeightInput[] = [globalBatch(10)]
  for (let i = 0; i < 10; i++) batches.push(moduleBatch(`mod${i}`, batchWeight(20 + i, 40_000 + i * 1000)))
  const plan = planQuestionQuotas('fine', batches)
  assertPlanInvariants(plan, batches)
  assert.ok(plan.total >= 25 && plan.total <= 40, `总量 ${plan.total} 越界`)
  assert.equal(plan.quotas.filter((q) => q.kind === 'module').length, 10)
  // 每个模块都要有题，否则会出现"某个模块完全没被考察"
  for (const q of plan.quotas) {
    if (q.kind === 'module') assert.ok(q.quota >= MIN_QUESTIONS_PER_BATCH, `${q.label} 没有分配到题量`)
  }
})

test('细粒度：模块数从 1 到 10 的每一种情况总量都不越界', () => {
  for (let modules = 0; modules <= 10; modules++) {
    const batches: BatchWeightInput[] = [globalBatch(Math.max(1, modules))]
    for (let i = 0; i < modules; i++) batches.push(moduleBatch(`m${i}`, batchWeight(5 + i * 7, 8_000 + i * 3_000)))
    const plan = planQuestionQuotas('fine', batches)
    assertPlanInvariants(plan, batches)
    assert.ok(
      plan.total >= GRANULARITY_QUESTION_BUDGET.fine.min && plan.total <= GRANULARITY_QUESTION_BUDGET.fine.max,
      `模块数 ${modules} 时总量 ${plan.total} 越界`
    )
  }
})

test('配额按权重倾斜：更重的模块拿到不少于更轻模块的题量', () => {
  const batches = [globalBatch(1), moduleBatch('big', batchWeight(60, 200_000)), moduleBatch('small', batchWeight(1, 1_000))]
  const plan = planQuestionQuotas('fine', batches)
  const big = plan.quotas.find((q) => q.label === '模块「big」')!
  const small = plan.quotas.find((q) => q.label === '模块「small」')!
  assert.ok(big.quota >= small.quota, `重的模块 ${big.quota} 应不少于轻的 ${small.quota}`)
  assertPlanInvariants(plan, batches)
})

test('权重全为 0 或非法时退化为等权，不产生 NaN', () => {
  const batches: BatchWeightInput[] = [globalBatch(0), moduleBatch('a', 0), moduleBatch('b', Number.NaN)]
  const plan = planQuestionQuotas('fine', batches)
  for (const q of plan.quotas) assert.ok(Number.isInteger(q.quota) && q.quota > 0, `配额非法：${q.quota}`)
  assertPlanInvariants(plan, batches)
})

test('批次数量极端时总量被结构性上下限约束（不抛错、不越界）', () => {
  // 30 个模块：下限之和 6 + 30×2 = 66 已超过 max 40，此时应停留在可行边界
  const batches: BatchWeightInput[] = [globalBatch(30)]
  for (let i = 0; i < 30; i++) batches.push(moduleBatch(`m${i}`, 1))
  const plan = planQuestionQuotas('fine', batches)
  const sum = plan.quotas.reduce((a, q) => a + q.quota, 0)
  assert.equal(plan.total, sum)
  assert.ok(sum >= 30 * MIN_QUESTIONS_PER_BATCH, '每个模块都应至少有下限题量')
  for (const q of plan.quotas) assert.ok(q.quota <= MAX_QUESTIONS_PER_BATCH)
})

test('空批次列表返回空配额而不是抛错', () => {
  const plan = planQuestionQuotas('fine', [])
  assert.equal(plan.quotas.length, 0)
  assert.equal(plan.total, 0)
  assert.equal(plan.min, GRANULARITY_QUESTION_BUDGET.fine.min)
  assert.equal(plan.max, GRANULARITY_QUESTION_BUDGET.fine.max)
})

test('truncateToQuota：按配额保留前 N 题，返回保留与丢弃数量', () => {
  const sections = [
    { title: 'A', questions: [1, 2, 3] },
    { title: 'B', questions: [4, 5, 6] }
  ]
  const within = truncateToQuota(sections, 10)
  assert.equal(within.kept, 6)
  assert.equal(within.dropped, 0)
  assert.equal(within.sections.length, 2)

  const cut = truncateToQuota(sections, 4)
  assert.equal(cut.kept, 4)
  assert.equal(cut.dropped, 2)
  assert.deepEqual(cut.sections.map((s) => s.questions.length), [3, 1])

  const tiny = truncateToQuota(sections, 2)
  assert.equal(tiny.kept, 2)
  assert.equal(tiny.dropped, 4)
  assert.deepEqual(tiny.sections.map((s) => s.questions.length), [2])

  const zero = truncateToQuota(sections, 0)
  assert.equal(zero.kept, 0)
  assert.equal(zero.dropped, 6)
  assert.equal(zero.sections.length, 0)
})

test('README 的题量说明与代码保持一致（验收标准第 4 条）', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const readme = await readFile(path.join(here, '..', '..', 'README.md'), 'utf-8')

  for (const g of ['coarse', 'medium', 'fine'] as const) {
    const label = questionCountLabel(g)
    assert.ok(
      readme.includes(label),
      `README 应出现「${label}」（${GRANULARITY_META[g].label}），否则文档与实现不一致`
    )
  }
  // 各颗粒度的 label 与 count 也应能在 README 里对应上
  for (const g of ['coarse', 'medium', 'fine'] as const) {
    const meta = GRANULARITY_META[g]
    const row = readme.split('\n').find((line) => line.includes(meta.label))
    assert.ok(row, `README 应有「${meta.label}」所在行`)
    assert.ok(row!.includes(meta.count), `README 的「${meta.label}」行应写有「${meta.count}」，实际：${row!.trim()}`)
  }
})

test('truncateToQuota 对非法/畸形的 quota 也能规范化（不产生小数或空 section）', () => {
  const sections = [{ title: 'A', questions: [1, 2, 3] }]
  for (const bad of [Number.NaN, -5, 0.5, Number.POSITIVE_INFINITY]) {
    const r = truncateToQuota(sections, bad)
    assert.ok(Number.isInteger(r.kept), `quota=${bad} 时 kept 应为整数，实际 ${r.kept}`)
    assert.ok(r.kept >= 0 && r.kept <= 3, `quota=${bad} 时 kept=${r.kept} 越界`)
    for (const s of r.sections) {
      assert.ok(s.questions.length > 0, `quota=${bad} 时不应保留空 section`)
    }
  }
  // 小数应向下取整而不是四舍五入放大
  assert.equal(truncateToQuota(sections, 2.9).kept, 2)
  // 恰好 0 应清空
  assert.equal(truncateToQuota(sections, 0).kept, 0)
  assert.equal(truncateToQuota(sections, 0).sections.length, 0)
})

test('batchWeight 单调且对文件数与内容量都敏感', () => {
  assert.ok(batchWeight(10, 10_000) > batchWeight(5, 10_000), '文件多应更重')
  assert.ok(batchWeight(10, 20_000) > batchWeight(10, 10_000), '内容多应更重')
  assert.equal(batchWeight(0, 0), 0)
  assert.ok(Number.isFinite(batchWeight(3, 5_000)))
})
