// Electron 主进程：窗口管理 + IPC 注册
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import type { ExplainRequest, GenerateOptions, InterviewResult, LlmProfile, Settings } from '@shared/types'
import { scanProject, type ScanResult } from './services/scanner'
import { generateInterview, buildExplainMessages } from './services/generator'
import { chatCompletionStream, listModels, testConnection } from './services/llm'
import { exportMarkdownDialog } from './services/exporter'
import {
  addRecentProject,
  deleteResult,
  getRecentProjects,
  getSettings,
  loadResult,
  removeRecentProject,
  saveResult,
  saveSettings
} from './services/store'

process.on('uncaughtException', (err) => console.error('[main] uncaughtException:', err))

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'ProjectLens',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // 把渲染进程的报错转发到主进程日志，便于排查白屏等问题
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error(`[renderer] ${message}`)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] 加载失败 ${code} ${desc} ${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] 进程异常退出: ${details.reason}`)
  })

  // electron-vite：开发模式加载 dev server，生产加载打包产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

// ---------- 对话框与项目 ----------

ipcMain.handle(IPC.selectFolder, async (e): Promise<string | null> => {
  // 挂父窗口使对话框为应用模态：弹窗存在期间主窗口不可交互，
  // 避免残留弹窗在其他页面完成选择后引发意外导航（见 issue #1）
  const win = BrowserWindow.fromWebContents(e.sender)
  const options: Electron.OpenDialogOptions = {
    title: '选择要分析的项目文件夹',
    properties: ['openDirectory']
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})

const scanCache = new Map<string, ScanResult>()

ipcMain.handle(IPC.scanProject, async (_e, projectPath: string) => {
  const scan = await scanProject(projectPath)
  scanCache.set(projectPath, scan)
  addRecentProject({ path: projectPath, name: scan.name })
  return scan
})

ipcMain.handle(IPC.recentProjects, () => getRecentProjects())

ipcMain.handle(IPC.removeRecent, (_e, projectPath: string) => {
  removeRecentProject(projectPath)
})

ipcMain.handle(IPC.loadResult, (_e, projectPath: string) => loadResult(projectPath))

ipcMain.handle(IPC.deleteResult, (_e, projectPath: string) => {
  deleteResult(projectPath)
})

// ---------- 生成 ----------

let currentGenerateAbort: AbortController | null = null

ipcMain.handle(IPC.generateRun, async (_e, options: GenerateOptions): Promise<InterviewResult> => {
  if (currentGenerateAbort) throw new Error('已有生成任务在进行中')
  const settings = getSettings()
  const profile = settings.profiles.find((p) => p.id === options.profileId)
  if (!profile) throw new Error('未找到指定的大模型配置，请先到设置页完成配置')

  const scan = scanCache.get(options.projectPath) ?? (await scanProject(options.projectPath))
  const abort = new AbortController()
  currentGenerateAbort = abort

  try {
    const result = await generateInterview({
      scan,
      granularity: options.granularity,
      roleFocus: options.roleFocus,
      profile,
      signal: abort.signal,
      onProgress: (step, detail, percent) => send(IPC.generateProgress, { step, detail, percent })
    })
    saveResult(options.projectPath, result)
    addRecentProject({ path: options.projectPath, name: scan.name, granularity: options.granularity })
    return result
  } catch (err) {
    if (abort.signal.aborted) throw new Error('已取消生成')
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    currentGenerateAbort = null
  }
})

ipcMain.handle(IPC.generateCancel, () => {
  currentGenerateAbort?.abort()
})

// ---------- 名词 AI 解释（流式） ----------

const explainAborts = new Map<string, AbortController>()

ipcMain.handle(IPC.explainStart, async (_e, req: ExplainRequest): Promise<void> => {
  const settings = getSettings()
  const profile = settings.profiles.find((p) => p.id === req.profileId)
  if (!profile) {
    send(IPC.explainEvent, { requestId: req.requestId, type: 'error', data: '未找到大模型配置' })
    return
  }
  const abort = new AbortController()
  explainAborts.set(req.requestId, abort)
  try {
    await chatCompletionStream(
      profile,
      buildExplainMessages({
        term: req.term,
        projectSummary: req.projectSummary,
        question: req.question,
        snippet: req.snippet,
        glossaryHint: req.glossaryHint
      }),
      (delta) => send(IPC.explainEvent, { requestId: req.requestId, type: 'delta', data: delta }),
      { signal: abort.signal, timeoutMs: 120_000, maxOutputTokens: 1200 }
    )
    send(IPC.explainEvent, { requestId: req.requestId, type: 'done', data: '' })
  } catch (err) {
    const msg = abort.signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err)
    send(IPC.explainEvent, { requestId: req.requestId, type: 'error', data: msg })
  } finally {
    explainAborts.delete(req.requestId)
  }
})

ipcMain.handle(IPC.explainCancel, (_e, requestId: string) => {
  explainAborts.get(requestId)?.abort()
})

// ---------- 设置与工具 ----------

ipcMain.handle(IPC.settingsGet, () => getSettings())

ipcMain.handle(IPC.settingsSave, (_e, settings: Settings) => {
  saveSettings(settings)
})

ipcMain.handle(IPC.llmTest, (_e, profile: LlmProfile) => testConnection(profile))

ipcMain.handle(IPC.llmListModels, (_e, profile: LlmProfile) => listModels(profile))

ipcMain.handle(IPC.exportMarkdown, (e, result: InterviewResult) =>
  exportMarkdownDialog(result, BrowserWindow.fromWebContents(e.sender) ?? undefined)
)

// 便于排查：开发模式下输出一条就绪日志
console.log(`[ProjectLens] main ready, devUrl=${process.env['ELECTRON_RENDERER_URL'] ?? '(none)'}, randomId=${randomUUID().slice(0, 8)}`)
