import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- direct Node tests need explicit TypeScript extensions.
import { estimateMessageTokens, estimateTextTokens, resolveGenerationBudget } from './token-budget.ts'

describe('mixed token budgeting', () => {
  it('estimates monotonic mixed-script text and keeps emoji code points intact', () => {
    assert.ok(estimateTextTokens('中文') >= 2)
    assert.ok(estimateTextTokens('long ASCII words') > 0)
    assert.equal(estimateTextTokens('😀'), 1)
    assert.ok(estimateMessageTokens([{ role: 'user', content: '中文 hello 😀' }]) > estimateTextTokens('中文 hello 😀'))
  })
  it('reserves output inside a configured model window and leaves unknown capacity null', () => {
    assert.equal(resolveGenerationBudget({ protocol: 'anthropic', model: 'x', contextWindowTokens: 32000 }, 'medium').inputTokens, 15616)
    assert.equal(resolveGenerationBudget({ protocol: 'openai', model: 'deepseek-v4-flash' }, 'coarse').reservedOutputTokens, 65536)
    assert.equal(resolveGenerationBudget({ protocol: 'openai', model: 'unknown' }, 'fine').contextWindowTokens, null)
    assert.equal(resolveGenerationBudget({ protocol: 'openai', model: 'unknown' }, 'medium').inputTokens, 64_000)
    assert.equal(resolveGenerationBudget({ protocol: 'openai', model: 'unknown', contextWindowTokens: 49_152 }, 'medium').inputTokens, 32_768)
  })
})
