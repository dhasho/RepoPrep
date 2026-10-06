// Electron 主进程：窗口管理 + IPC 注册
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import type { ExplainRequest, GenerateOptions, InterviewResult, LlmProfile, Settings } from '@shared/types'
import { scanProject, type ScanResult } from './services/scanner'
import { generateInterview, buildExplainMessages } from './services/generator'
import { chatCompletionStream, listModels, testConnection } from './services/llm'
import { exportMarkdownDialog } from './services/exporter'
import { getTrustedDevUrl, installPermissionDenials, installWindowSecurity } from './window-security'
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
import { AuthorizedProjectRegistry } from './services/ipc-authority'
import { ExplainAbortRegistry, registerGuardedIpcHandler } from './services/ipc-handler-guards'

process.on('uncaughtException', (err) => console.error('[main] uncaughtException:', err))

let mainWindow: BrowserWindow | null = null
/** 由 createWindow 在确定入口后写入；null 表示还没有可信入口，此时拒绝一切 IPC。 */
let trustedAppEntryUrl: string | null = null
const authorizedProjects = new AuthorizedProjectRegistry()

/**
 * 注册 IPC handler。发送方校验、运行时 schema 校验与项目授权都在
 * registerGuardedIpcHandler 这一层完成，这里不再单独包一层守卫。
 * 信任入口由 trustedAppEntryUrl 提供，因此窗口安全策略只有一处定义。
 */
function handle(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  registerGuardedIpcHandler(
    ipcMain,
    channel,
    {
      getExpectedWebContents: () => mainWindow?.webContents ?? null,
      getTrustedRendererUrl: () => trustedAppEntryUrl,
      projects: authorizedProjects
    },
    listener
  )
}

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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
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
  const entryPath = path.join(__dirname, '../renderer/index.html')
  const localEntryUrl = pathToFileURL(entryPath).href
  let entryUrl = localEntryUrl
  try {
    entryUrl = getTrustedDevUrl(process.env['ELECTRON_RENDERER_URL'], app.isPackaged) ?? localEntryUrl
  } catch (error) {
    // 回退本身是安全的（不信任不合规的 URL），但静默回退会让 `npm run dev` 表现成
    // 白屏或加载到过期的构建产物。这里在未打包时把配置错误直接弹出来，避免开发
    // 者把“配置写错”误判成“dev 环境坏了”。
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ProjectLens] ${message}; 已回退至本地页面`)
    if (!app.isPackaged) {
      // 诊断提示本身不能成为新的失败点：弹窗失败也必须继续创建窗口。
      try {
        dialog.showErrorBox('ELECTRON_RENDERER_URL 不被信任', `已回退至本地页面。\n\n${message}`)
      } catch (dialogError) {
        console.error('[ProjectLens] 无法显示配置错误提示:', dialogError)
      }
    }
  }
  // 先确定信任入口再建页面：窗口一旦开始加载，IPC 守卫就必须能拿到它。
  trustedAppEntryUrl = entryUrl
  installWindowSecurity(mainWindow, entryUrl)
  void mainWindow.loadURL(entryUrl)
}

app.whenReady().then(() => {
  installPermissionDenials(session.defaultSession)
  // 最近项目在启动时登记，使 refresh 后直接打开历史项目也能通过授权检查。
  authorizedProjects.registerRecent(getRecentProjects().map((project) => project.path))
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

handle(IPC.selectFolder, async (e): Promise<string | null> => {
  // 挂父窗口使对话框为应用模态：弹窗存在期间主窗口不可交互，
  // 避免残留弹窗在其他页面完成选择后引发意外导航（见 issue #1）
  const win = BrowserWindow.fromWebContents(e.sender)
  const options: Electron.OpenDialogOptions = {
    title: '选择要分析的项目文件夹',
    properties: ['openDirectory']
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (r.canceled || !r.filePaths.length) return null
  const selectedPath = r.filePaths[0]
  authorizedProjects.registerSelected(selectedPath)
  return selectedPath
})

const scanCache = new Map<string, ScanResult>()

handle(IPC.scanProject, async (_e, projectPath: string) => {
  const scan = await scanProject(projectPath)
  scanCache.set(projectPath, scan)
  addRecentProject({ path: projectPath, name: scan.name })
  return scan
})

handle(IPC.recentProjects, () => {
  const recent = getRecentProjects()
  authorizedProjects.registerRecent(recent.map((project) => project.path))
  return recent
})

handle(IPC.removeRecent, (_e, projectPath: string) => {
  removeRecentProject(projectPath)
  authorizedProjects.removeRecent(projectPath)
})

handle(IPC.loadResult, (_e, projectPath: string) => loadResult(projectPath))

handle(IPC.deleteResult, (_e, projectPath: string) => {
  deleteResult(projectPath)
})

// ---------- 生成 ----------

let currentGenerateAbort: AbortController | null = null

handle(IPC.generateRun, async (_e, options: GenerateOptions): Promise<InterviewResult> => {
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

handle(IPC.generateCancel, () => {
  currentGenerateAbort?.abort()
})

// ---------- 名词 AI 解释（流式） ----------

const explainAborts = new ExplainAbortRegistry()

handle(IPC.explainStart, async (_e, req: ExplainRequest): Promise<void> => {
  const settings = getSettings()
  const profile = settings.profiles.find((p) => p.id === req.profileId)
  if (!profile) {
    send(IPC.explainEvent, { requestId: req.requestId, type: 'error', data: '未找到大模型配置' })
    return
  }
  const abort = explainAborts.begin(req.requestId)
  if (!abort) throw new Error('已有相同名词解释请求在进行中')
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
    const msg = abort.signal.aborted ? '已取消' : '请求处理失败，请稍后重试'
    send(IPC.explainEvent, { requestId: req.requestId, type: 'error', data: msg })
  } finally {
    explainAborts.finish(req.requestId, abort)
  }
})

handle(IPC.explainCancel, (_e, requestId: string) => {
  explainAborts.cancel(requestId)
})

// ---------- 设置与工具 ----------

handle(IPC.settingsGet, () => getSettings())

handle(IPC.settingsSave, (_e, settings: Settings) => {
  saveSettings(settings)
})

handle(IPC.llmTest, (_e, profile: LlmProfile) => testConnection(profile))

handle(IPC.llmListModels, (_e, profile: LlmProfile) => listModels(profile))

handle(IPC.exportMarkdown, (e, result: InterviewResult) =>
  exportMarkdownDialog(result, BrowserWindow.fromWebContents(e.sender) ?? undefined)
)

// 通道清单与 schema 覆盖率自检在 services/ipc-validation.ts 中随模块加载执行，
// 那里是通道定义的唯一下游，不再需要在这里维护通道数量。

// 便于排查：开发模式下输出一条就绪日志
console.log(`[ProjectLens] main ready, devUrl=${process.env['ELECTRON_RENDERER_URL'] ?? '(none)'}, randomId=${randomUUID().slice(0, 8)}`)
