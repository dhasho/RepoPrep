// Markdown 导出渲染的快照式测试（issue #19）
//
// 覆盖验收标准：表格特殊字符转义、全局连续题号（与结果页一致）、
// section 标题/摘要的术语标记清理。头部含本地化生成时间（随环境时区变化），
// 因此按行断言而非整篇比对。
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import path from 'node:path'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import type { InterviewResult } from '../../shared/types.ts'
// @ts-ignore TS5097 -- runtime Node tests import the extension directly.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore TS5097 -- runtime Node tests import the extension directly.
import { assertInterviewResultContract } from '../../shared/result-contract.ts'
// @ts-ignore TS5097 -- runtime Node tests import the extension directly.
import { validateIpcArgs } from './ipc-validation.ts'
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

test('上下文有省略时导出与结果页相同的静态提示，旧结果不增加提示', () => {
  const warning = '⚠️ 部分项目信息未参与分析，结果可能遗漏相关内容。'
  const ordinary = resultToMarkdown(makeResult())
  assert.ok(!ordinary.includes(warning))

  for (const field of ['treeTruncated', 'contentTruncated', 'requestTruncated'] as const) {
    const markdown = resultToMarkdown(makeResult({ contextTruncation: {
      treeTruncated: false,
      contentTruncated: false,
      requestTruncated: false,
      [field]: true
    } }))
    assert.equal(markdown.split(warning).length - 1, 1, `${field} 应输出一次通用提示`)
    assert.ok(markdown.indexOf(warning) < markdown.indexOf('## 项目概览'), '提示应出现在正文之前')
  }

  const legacy = makeResult()
  delete (legacy as Partial<InterviewResult>).contextTruncation
  assert.ok(!resultToMarkdown(legacy).includes(warning), '未记录元数据的旧结果不应显示提示')
})

test('读取不完整的持久化结果在 Markdown 中显示受控原因、转义路径及省略次数', () => {
  const md = resultToMarkdown(makeResult({
    contentReadSummary: {
      attemptedReads: 9,
      successfulReads: 5,
      failedReads: 4,
      failuresByReason: { permission: 1, missing: 1, io: 2 },
      failures: [
        { path: 'src/a`b.ts', reason: 'permission' },
        { path: 'docs/guide.md', reason: 'missing' },
        { path: 'docs/<tag>.md', reason: 'io' }
      ]
    }
  }))

  assert.ok(md.includes('尝试读取 9 次，成功 5 次，失败 4 次'))
  assert.ok(md.includes('权限不足 1 次、文件不存在 1 次、读取异常 2 次'))
  assert.ok(md.includes('"src/a\\`b\\.ts"'), 'backticks and punctuation in quoted paths are escaped for Markdown')
  assert.ok(md.includes('"docs/\\<tag\\>\\.md"'), 'angle brackets in paths cannot become raw HTML')
  assert.ok(md.includes('另有 1 次读取失败未列出'))
})

test('Markdown export omits legacy source evidence excerpts and hashes', () => {
  const result = makeResult({
    sections: [{ id: 's1', title: 'Legacy', questions: [{
      id: 'q1', question: 'Question?', answer: 'Answer.', followUps: [], sourceEvidence: [{
        sourceId: 'source-1', snapshotHash: 'b'.repeat(64), path: 'src/legacy.ts',
        startLine: 4, endLine: 7, excerpt: 'LEGACY_SOURCE_EXCERPT'
      }]
    }] }],
    sourceEvidenceSummary: { asked: 1, accepted: 1, rejected: 0, retained: 1 }
  })
  const markdown = resultToMarkdown(result)
  assert.ok(markdown.includes('Answer.'))
  assert.ok(!markdown.includes('LEGACY_SOURCE_EXCERPT'))
  assert.ok(!markdown.includes('b'.repeat(64)))
  assert.ok(!markdown.includes('源码依据'))
})
test('正常结果和旧结果不显示内容读取警告', () => {
  assert.ok(!resultToMarkdown(makeResult()).includes('内容读取不完整'))
  assert.ok(!resultToMarkdown(makeResult({
    contentReadSummary: {
      attemptedReads: 2,
      successfulReads: 2,
      failedReads: 0,
      failuresByReason: { permission: 0, missing: 0, io: 0 },
      failures: []
    }
  })).includes('内容读取不完整'))
})

test('读取警告限制长路径样本文本，但结果元数据仍保留全部 50 个样本', () => {
  const summary = {
    attemptedReads: 100,
    successfulReads: 50,
    failedReads: 50,
    failuresByReason: { permission: 50, missing: 0, io: 0 },
    failures: Array.from({ length: 50 }, (_, index) => ({
      path: `src/${index}-${'x'.repeat(1000)}.ts`,
      reason: 'permission' as const
    }))
  }
  const markdown = resultToMarkdown(makeResult({ contentReadSummary: summary }))

  assert.equal(summary.failures.length, 50, 'warning rendering does not mutate or discard persisted samples')
  assert.ok(markdown.length < 6000, 'long persisted paths cannot consume the prompt/header display budget')
  assert.ok(markdown.includes('另有 45 次读取失败未列出'))
  assert.ok(!markdown.includes('49-'), 'only the bounded set of leading examples is displayed')
})

test('内容读取失败和上下文截断可以同时显示在导出开头', () => {
  const markdown = resultToMarkdown(makeResult({
    contextTruncation: { treeTruncated: false, contentTruncated: true, requestTruncated: false },
    contentReadSummary: {
      attemptedReads: 2,
      successfulReads: 1,
      failedReads: 1,
      failuresByReason: { permission: 1, missing: 0, io: 0 },
      failures: [{ path: 'src/private.ts', reason: 'permission' }]
    }
  }))

  assert.ok(markdown.includes('部分项目信息未参与分析'))
  assert.ok(markdown.includes('内容读取不完整'))
  assert.ok(markdown.indexOf('部分项目信息未参与分析') < markdown.indexOf('## 项目概览'))
  assert.ok(markdown.indexOf('内容读取不完整') < markdown.indexOf('## 项目概览'))
})
