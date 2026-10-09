// 将生成结果导出为 Markdown 文件（对话框与写盘；渲染逻辑在 markdown-export.ts）
import { BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import type { InterviewResult } from '@shared/types'
// @ts-ignore TS5097 -- the direct Node test runner requires the explicit extension; bundler resolution does not.
import { resultToMarkdown } from './markdown-export.ts'

/** 弹出保存对话框并写入文件（挂父窗口成为应用模态，与 issue #1 同类问题的预防性修复） */
export async function exportMarkdownDialog(
  result: InterviewResult,
  parent?: BrowserWindow
): Promise<{ ok: boolean; path?: string; message: string }> {
  const defaultName = `${result.projectName}-面试题-${new Date(result.createdAt).toISOString().slice(0, 10)}.md`
  const options: Electron.SaveDialogOptions = {
    title: '导出面试题为 Markdown',
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  }
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (canceled || !filePath) return { ok: false, message: '已取消导出' }
  try {
    fs.writeFileSync(filePath, resultToMarkdown(result), 'utf-8')
    return { ok: true, path: filePath, message: `已导出到 ${filePath}` }
  } catch {
    return { ok: false, message: '导出失败，请检查目标位置是否可写并重试。' }
  }
}
