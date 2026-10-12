// 批次合并与"产出不足补偿"的单元测试（issue #9）
//
// 背景：原实现声称"把前面批次的不足转给后续批次"，但由于 kept_j ≤ quota_j，
// 后续批次的可用预算恒不小于其配额，该分支**永不触发**（是死代码）。
// 这里用可注入的假模型直接测试补偿逻辑，避免重蹈"声明了但没生效"的覆辙。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { GRANULARITY_QUESTION_BUDGET, type Section } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { mergeWithCompensation, type MergeInput } from './generator.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { LlmRequestError } from './llm.ts'

const budget = GRANULARITY_QUESTION_BUDGET.fine

function section(count: number, title = '主题'): Section {
  return {
    id: `s-${title}-${count}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    questions: Array.from({ length: count }, (_, i) => ({
      id: `q-${title}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      question: `${title} 问题 ${i + 1}`,
      answer: `答案 ${i + 1}`,
      followUps: []
    }))
  }
}

/** 造一个假模型：按每次请求的 quota 决定实际产出多少题 */
function makeInput(
  quotas: number[],
  deliver: (call: { index: number; quota: number; isCompensation: boolean }, callNo: number) => number,
  overrides: Partial<MergeInput> = {}
): { input: MergeInput; calls: Array<{ index: number; quota: number; isCompensation: boolean }> } {
  const calls: Array<{ index: number; quota: number; isCompensation: boolean }> = []
  const batches = quotas.map((_q, i) => ({ label: `批次${i}` }))
  const input: MergeInput = {
    budget,
    batches,
    quotas,
    total: quotas.reduce((a, b) => a + b, 0),
    requestBatch: async (index, quota, extraInstruction) => {
      const isCompensation = typeof extraInstruction === 'string'
      calls.push({ index, quota, isCompensation })
      const n = deliver({ index, quota, isCompensation }, calls.length)
      return {
        projectSummary: '',
        sections: n > 0 ? [section(n, `批次${index} 请求${calls.length}`)] : [],
        glossary: {}
      }
    },
    ...overrides
  }
  return { input, calls }
}

// 注意：这里必须用「配额之和 ≥ budget.min(25)」的配额，否则任何交付量都会低于下限而触发补偿，
// 测不出"无补偿"的分支。32/30 是细粒度真实规划出来的量级。
const FULL_QUOTAS = [12, 10, 10] // 合计 32（= target）
const FULL_TOTAL = 32

test('模型超额：每批按配额裁剪，总量等于规划总量', async () => {
  const { input } = makeInput(FULL_QUOTAS, ({ quota }) => quota + 5) // 每批多出 5 题
  const result = await mergeWithCompensation(input)
  assert.equal(result.collected, FULL_TOTAL, '总量应等于规划配额之和')
  assert.ok(result.droppedByQuota > 0, '应记录被丢弃的超额题量')
  assert.equal(result.compensationRounds, 0, '总量达标时不应触发补偿')
  assert.equal(result.compensated, 0)
})

test('模型刚好履约：无裁剪、无补偿', async () => {
  const { input } = makeInput(FULL_QUOTAS, ({ quota }) => quota)
  const result = await mergeWithCompensation(input)
  assert.equal(result.collected, FULL_TOTAL)
  assert.equal(result.droppedByQuota, 0)
  assert.equal(result.compensationRounds, 0)
})

test('模型严重不足：触发补偿并补回缺口', async () => {
  // 首轮每批只出 1 题（共 3 题），远低于下限 25；补偿轮正常履约
  const { input, calls } = makeInput(FULL_QUOTAS, ({ quota, isCompensation }) => (isCompensation ? quota : 1))
  const result = await mergeWithCompensation(input, 2)

  assert.ok(result.compensationRounds > 0, '低于下限时应触发补偿')
  assert.ok(result.compensated > 0, '补偿应补回题量')
  assert.ok(result.collected > 3, `补偿后总量应高于首轮的 3 题，实际 ${result.collected}`)
  const compensationCalls = calls.filter((c) => c.isCompensation)
  assert.ok(compensationCalls.length > 0)
  assert.ok(compensationCalls[0].quota <= budget.min, '补偿请求量不应超过缺口上限')
})

test('模型持续不足：补偿轮数有上限，不会无限重试', async () => {
  const { input, calls } = makeInput(FULL_QUOTAS, () => 1) // 永远只出 1 题
  const result = await mergeWithCompensation(input, 2)
  assert.equal(result.compensationRounds, 2, '补偿轮数应被上限截断')
  assert.equal(calls.length, FULL_QUOTAS.length + 2, '总调用次数 = 首轮批次数 + 补偿轮数')
})

test('总量已达下限时不再补偿', async () => {
  const { input } = makeInput(FULL_QUOTAS, ({ quota }) => quota)
  const result = await mergeWithCompensation(input, 2)
  assert.ok(result.collected >= budget.min, `总量 ${result.collected} 应已达下限`)
  assert.equal(result.compensationRounds, 0, '达到下限后不应补偿')
})

test('精确落在下限的边界：不补偿（collected == min）', async () => {
  // 配额 25 恰好等于下限；每批刚好履约 → 不应触发补偿
  const { input } = makeInput([10, 8, 7], ({ quota }) => quota)
  const result = await mergeWithCompensation(input, 2)
  assert.equal(result.collected, budget.min)
  assert.equal(result.compensationRounds, 0, '恰好达到下限时不应补偿')
})

test('补偿请求失败时保留已有结果，不让整次生成失败', async () => {
  const { input } = makeInput(FULL_QUOTAS, ({ isCompensation }) => {
    if (isCompensation) throw new Error('模型不配合')
    return 1
  })
  const result = await mergeWithCompensation(input, 2)
  assert.equal(result.collected, 3, '首轮结果应保留')
  assert.ok(result.compensationRounds >= 1, '应尝试过补偿')
  assert.equal(result.compensated, 0, '补偿失败则补回 0 题')
})

test('补偿请求超时必须向上传递，不能静默返回部分结果', async () => {
  const { input } = makeInput(FULL_QUOTAS, ({ isCompensation }) => {
    if (isCompensation) throw new LlmRequestError('timeout')
    return 1
  })
  await assert.rejects(mergeWithCompensation(input, 2), (error: unknown) => {
    assert.ok(error instanceof LlmRequestError)
    assert.equal(error.kind, 'timeout')
    return true
  })
})

test('补偿时挑选"贡献最少"的批次', async () => {
  const delivered = [12, 1, 10] // 第 1 个批次给得最少
  const { input, calls } = makeInput(FULL_QUOTAS, ({ index, quota, isCompensation }) =>
    isCompensation ? quota : delivered[index]
  )
  await mergeWithCompensation(input, 1)
  const comp = calls.filter((c) => c.isCompensation)
  assert.equal(comp.length, 1)
  assert.equal(comp[0].index, 1, '应向贡献最少的批次（index=1）请求补偿')
})

test('空批次列表不会抛错', async () => {
  const { input } = makeInput([], () => 0)
  const result = await mergeWithCompensation(input)
  assert.equal(result.collected, 0)
  assert.equal(result.sections.length, 0)
  assert.equal(result.compensationRounds, 0)
})

test('补偿补回后总量达到下限（真实可达性检查）', async () => {
  const quotas = [6, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4] // 合计 30
  // 首轮每批只出配额的一半（取整），补偿轮足额
  const { input } = makeInput(quotas, ({ quota, isCompensation }) => (isCompensation ? quota : Math.floor(quota / 2)))
  const result = await mergeWithCompensation(input, 3)
  assert.ok(
    result.collected >= budget.min,
    `补偿后总量 ${result.collected} 应达到下限 ${budget.min}（补偿轮数 ${result.compensationRounds}）`
  )
})
