// Markdown 导出渲染的快照式测试（issue #19）
//
// 覆盖验收标准：表格特殊字符转义、全局连续题号（与结果页一致）、
// section 标题/摘要的术语标记清理。头部含本地化生成时间（随环境时区变化），
// 因此按行断言而非整篇比对。
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import type { InterviewResult } from '../../shared/types.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { escapeTableCell, resultToMarkdown } from './markdown-export.ts'

function makeResult(overrides?: Partial<InterviewResult>): InterviewResult {
  return {
    version: 1,
    createdAt: '2026-10-07T08:00:00.000Z',
    projectName: '演示项目',
    projectPath: 'C:\\demo',
    granularity: 'fine',
    roleFocus: 'backend',
    profileId: 'p1',
    modelUsed: 'test-model',
    projectSummary: '这是一个 [[依赖注入]] 项目。',
    sections: [
      {
        id: 's1',
        title: '第一节 [[架构设计]]',
        summary: '概览 [[单一职责]] 要点',
        questions: [
          { id: 'q1', question: '什么是 [[依赖注入]]？', answer: '回答一。', followUps: [] },
          { id: 'q2', question: '第二题', answer: '回答二。', followUps: [] }
        ]
      },
      {
        id: 's2',
        title: '第二节',
        questions: [{ id: 'q3', question: '第三题', answer: '回答三。', followUps: [] }]
      }
    ],
    glossary: {
      'C++ | Pipeline': '含 | 竖线与\n换行以及 \\ 反斜杠的解释',
      普通名词: '普通解释'
    },
    security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} },
    ...overrides
  }
}

test('快照：表格单元格中的竖线、换行、反斜杠被正确转义', () => {
  const md = resultToMarkdown(makeResult())
  const rows = md.split('\n').filter((l) => l.startsWith('| C++'))
  assert.equal(rows.length, 1, '含竖线的术语必须仍在同一表格行内')
  assert.equal(
    rows[0],
    '| C++ \\| Pipeline | 含 \\| 竖线与 换行以及 \\\\ 反斜杠的解释 |',
    '竖线转义为 \\|，换行折叠为空格，反斜杠转义为 \\\\'
  )
  // 表格行数保持完整：表头 + 分隔 + 两条术语
  const appendix = md.slice(md.indexOf('| 名词 |'))
  assert.equal(appendix.split('\n').filter((l) => l.startsWith('|')).length, 4)
})

test('escapeTableCell：反斜杠最先转义，避免二次转义', () => {
  assert.equal(escapeTableCell('a|b\\c\nd'), 'a\\|b\\\\c d')
  assert.equal(escapeTableCell('无特殊字符'), '无特殊字符')
})

test('快照：题号全局连续，与结果页 Q1..Qn 一致', () => {
  const md = resultToMarkdown(makeResult())
  const questionHeadings = md.split('\n').filter((l) => l.startsWith('### Q'))
  assert.deepEqual(
    questionHeadings.map((l) => l.match(/^### (Q\d+)\./)![1]),
    ['Q1', 'Q2', 'Q3'],
    '跨 section 连续编号'
  )
  assert.ok(questionHeadings[0].includes('什么是 依赖注入？'), '题目中的术语标记被清理')
})

test('快照：section 标题与摘要清理术语标记', () => {
  const md = resultToMarkdown(makeResult())
  assert.ok(md.includes('## 第一节 架构设计'), '标题中的 [[ ]] 标记被清理')
  assert.ok(!md.includes('[[架构设计]]'))
  assert.ok(md.includes('*概览 单一职责 要点*'), '摘要中的标记被清理')
  assert.ok(!md.includes('[[单一职责]]'))
})

test('无术语表 / 空摘要时不输出对应区块', () => {
  const md = resultToMarkdown(
    makeResult({ glossary: {}, projectSummary: '' })
  )
  assert.ok(!md.includes('## 附录：专业名词表'))
  assert.ok(!md.includes('## 项目概览'))
})
