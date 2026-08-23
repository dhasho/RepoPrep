// 将生成结果导出为 Markdown 文件
import { dialog } from 'electron'
import fs from 'node:fs'
import type { FollowUp, InterviewResult } from '@shared/types'
import { GRANULARITY_META, ROLE_META, stripTermMarks } from '@shared/types'

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

export function resultToMarkdown(result: InterviewResult): string {
  const lines: string[] = []
  lines.push(`# ${result.projectName} · 项目面试题`)
  lines.push('')
  lines.push(
    `> 颗粒度：${GRANULARITY_META[result.granularity].label}（${GRANULARITY_META[result.granularity].sub}）｜方向：${ROLE_META[result.roleFocus].label}｜模型：${result.modelUsed}｜生成时间：${new Date(result.createdAt).toLocaleString('zh-CN')}`
  )
  lines.push('')
  if (result.projectSummary) {
    lines.push('## 项目概览')
    lines.push('')
    lines.push(stripTermMarks(result.projectSummary))
    lines.push('')
  }

  for (const section of result.sections) {
    lines.push(`## ${section.title}`)
    lines.push('')
    if (section.summary) {
      lines.push(`*${section.summary}*`)
      lines.push('')
    }
    section.questions.forEach((q, idx) => {
      lines.push(`### Q${idx + 1}. ${stripTermMarks(q.question)}`)
      lines.push('')
      lines.push(stripTermMarks(q.answer))
      lines.push('')
      if (q.followUps.length) {
        lines.push(`**追问：**`)
        lines.push('')
        lines.push(renderFollowUps(q.followUps, 0))
      }
    })
  }

  const terms = Object.entries(result.glossary)
  if (terms.length) {
    lines.push('## 附录：专业名词表')
    lines.push('')
    lines.push('| 名词 | 解释 |')
    lines.push('| --- | --- |')
    for (const [term, def] of terms) {
      lines.push(`| ${term} | ${def.replace(/\n/g, ' ')} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 弹出保存对话框并写入文件 */
export async function exportMarkdownDialog(result: InterviewResult): Promise<{ ok: boolean; path?: string; message: string }> {
  const defaultName = `${result.projectName}-面试题-${new Date(result.createdAt).toISOString().slice(0, 10)}.md`
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出面试题为 Markdown',
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (canceled || !filePath) return { ok: false, message: '已取消导出' }
  try {
    fs.writeFileSync(filePath, resultToMarkdown(result), 'utf-8')
    return { ok: true, path: filePath, message: `已导出到 ${filePath}` }
  } catch (err) {
    return { ok: false, message: `导出失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
