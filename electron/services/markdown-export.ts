// 将生成结果渲染为 Markdown 文本（纯函数，无 Electron 依赖，便于直接测试）
// @ts-ignore TS5097 -- the direct Node test runner requires the explicit extension; bundler resolution does not.
import type { FollowUp, InterviewResult } from '../../shared/types.ts'
// @ts-ignore TS5097 -- the direct Node test runner requires the explicit extension; bundler resolution does not.
import { formatContextTruncationWarning } from '../../shared/context-budget.ts'
// @ts-ignore TS5097 -- the direct Node test runner requires the explicit extension; bundler resolution does not.
import { GRANULARITY_META, ROLE_META, stripTermMarks } from '../../shared/types.ts'
// @ts-ignore TS5097 -- the direct Node test runner requires the explicit extension; bundler resolution does not.
import { contentReadWarning } from '../../shared/content-read.ts'

/**
 * 转义 Markdown 表格单元格内容（issue #19）：
 * - 反斜杠最先转义（避免二次转义）；
 * - 竖线转义为 \|，否则会切断 GFM 表格列；
 * - 换行统一替换为空格（GFM 表格单元格不支持裸换行）。
 */
export function escapeTableCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, ' ')
}

function escapeMarkdownText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/([\\`*_{}\[\]()#+.!|><~-])/g, '\\$1')
}

function renderContentReadWarning(result: InterviewResult): string[] {
  const summary = result.contentReadSummary
  if (!summary || summary.failedReads === 0) return []

  // Failure samples are project-controlled paths, so quote every Markdown-sensitive character.
  return [`> ${escapeMarkdownText(contentReadWarning(summary))}`]
}

function renderFollowUps(followUps: FollowUp[], depth: number): string {
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  for (const f of followUps) {
    lines.push(`${indent}- **追问：**${stripTermMarks(f.question)}`)
    lines.push('')
    const answerLines = stripTermMarks(f.answer)
      .split('\n')
      .map((l) => `${indent}  ${l}`)
    lines.push(...answerLines)
    lines.push('')
    if (f.followUps?.length) lines.push(renderFollowUps(f.followUps, depth + 1))
  }
  return lines.join('\n')
}

function markdownCodeSpan(value: string): string {
  const runs = value.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(1, ...runs.map((run) => run.length + 1)))
  const padded = value.startsWith(' ') || value.endsWith(' ') || value.includes('`') ? ` ${value} ` : value
  return `${fence}${padded}${fence}`
}

function renderSourceEvidence(evidence: NonNullable<InterviewResult['sections'][number]['questions'][number]['sourceEvidence']>): string[] {
  if (!evidence.length) return []
  const lines = ['**源码依据（生成时保存的脱敏快照）**', '']
  for (const item of evidence) {
    lines.push(`- 路径：${markdownCodeSpan(item.path)}；原始行号：L${item.startLine}–L${item.endLine}`)
    lines.push(`  快照 SHA-256：${item.snapshotHash}`)
    lines.push('')
    const backtickRun = Math.max(0, ...(item.excerpt.match(/`+/g) ?? []).map((run) => run.length))
    const tildeRun = Math.max(0, ...(item.excerpt.match(/~+/g) ?? []).map((run) => run.length))
    const marker = backtickRun <= tildeRun ? '`' : '~'
    const fence = marker.repeat(Math.max(3, Math.min(backtickRun, tildeRun) + 1))
    lines.push(fence)
    lines.push(item.excerpt)
    lines.push(fence)
    lines.push('')
  }
  lines.push('行号范围已校验，表示该内容来自生成时快照；这不代表它在语义上支持答案，也不代表答案正确。', '')
  return lines
}

export function resultToMarkdown(result: InterviewResult): string {
  const lines: string[] = []
  lines.push(`# ${result.projectName} · 项目面试题`)
  lines.push('')
  lines.push(
    `> 颗粒度：${GRANULARITY_META[result.granularity].label}（${GRANULARITY_META[result.granularity].sub}）｜方向：${ROLE_META[result.roleFocus].label}｜模型：${result.modelUsed}｜生成时间：${new Date(result.createdAt).toLocaleString('zh-CN')}`
  )
  lines.push('')
  const contextWarning = formatContextTruncationWarning(result.contextTruncation)
  if (contextWarning) {
    lines.push(`> ${contextWarning}`)
  }
  const contentReadWarning = renderContentReadWarning(result)
  if (contentReadWarning.length) {
    lines.push(...contentReadWarning)
  }
  if (contextWarning || contentReadWarning.length) {
    lines.push('')
  }
  if (result.projectSummary) {
    lines.push('## 项目概览')
    lines.push('')
    lines.push(stripTermMarks(result.projectSummary))
    lines.push('')
  }

  // 题号全局连续（与结果页 Q1..Qn 一致），不再每个 section 重新从 1 开始
  let questionNo = 0
  for (const section of result.sections) {
    lines.push(`## ${stripTermMarks(section.title)}`)
    lines.push('')
    if (section.summary) {
      lines.push(`*${stripTermMarks(section.summary)}*`)
      lines.push('')
    }
    for (const q of section.questions) {
      questionNo++
      lines.push(`### Q${questionNo}. ${stripTermMarks(q.question)}`)
      lines.push('')
      lines.push(stripTermMarks(q.answer))
      lines.push('')
      lines.push(...renderSourceEvidence(q.sourceEvidence ?? []))
      if (q.followUps.length) {
        lines.push(`**追问：**`)
        lines.push('')
        lines.push(renderFollowUps(q.followUps, 0))
      }
    }
  }

  const terms = Object.entries(result.glossary)
  if (terms.length) {
    lines.push('## 附录：专业名词表')
    lines.push('')
    lines.push('| 名词 | 解释 |')
    lines.push('| --- | --- |')
    for (const [term, def] of terms) {
      lines.push(`| ${escapeTableCell(term)} | ${escapeTableCell(def)} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
