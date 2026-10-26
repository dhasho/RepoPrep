// Electron 主进程：窗口管理 + IPC 注册
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { GENERATION_DRAFT_MESSAGES } from '@shared/generation-checkpoint'
import type { ExplainRequest, GenerateRequest, GenerateResponse, InterviewResult, LlmProfile, LlmProfileDraft, SettingsSaveRequest, GenerationDraftSummary } from '@shared/types'
import type { GenerationCheckpoint } from '@shared/generation-checkpoint'
import { ProjectScanCache } from './services/scan-cache'
import { GenerationTaskRegistry } from './services/generation-tasks'
import { beginGenerationDraft, completeGenerationDraft, readGenerationDraft, removeGenerationDraft, saveGenerationDraft } from './services/generation-drafts'
import { generateInterview, buildExplainMessages } from './services/generator'
import { chatCompletionStream, isLlmTimeoutError, listModels, testConnection } from './services/llm'
import { exportMarkdownDialog } from './services/exporter'
import { getTrustedDevUrl, installPermissionDenials, installWindowSecurity } from './window-security'
import {
  addRecentProject,
  deleteResult,
  getRecentProjects,
  getSettings,
  getPrivateProfile,
  getStorageDiagnostics,
  loadResult,
  listAnalyses,
  loadAnalysis,
  recoverStorage,
  removeRecentProject,
  saveResult,
  saveSettings
} from './services/store'
import { AuthorizedProjectRegistry } from './services/ipc-authority'
import { ExplainAbortRegistry, registerGuardedIpcHandler } from './services/ipc-handler-guards'

// Preserve the existing Electron userData directory across the product rename.
// Development used the npm package name; packaged builds used productName.
const legacyUserDataPath = path.join(app.getPath('appData'), app.isPackaged ? 'ProjectLens' : 'projectlens')
mkdirSync(legacyUserDataPath, { recursive: true })
app.setPath('userData', legacyUserDataPath)

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
      projects: authorizedProjects,
      getStorageRecoveryProject: (id) => {
        const diagnostic = getStorageDiagnostics().find((entry) => entry.id === id)
        return diagnostic?.kind === 'result' ? diagnostic.projectPath ?? null : null
      }
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
    title: 'RepoPrep',
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#ffffff', symbolColor: '#475569', height: 48 }
    } : {}),
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
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') console.error(`[renderer] ${details.message}`)
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
    console.error(`[RepoPrep] ${message}; 已回退至本地页面`)
    if (!app.isPackaged) {
      // 诊断提示本身不能成为新的失败点：弹窗失败也必须继续创建窗口。
      try {
        dialog.showErrorBox('ELECTRON_RENDERER_URL 不被信任', `已回退至本地页面。\n\n${message}`)
      } catch (dialogError) {
        console.error('[RepoPrep] 无法显示配置错误提示:', dialogError)
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
  // 窗口全部关闭时中止生成；槽位由旧 handler 的 finally 释放（issue #20）
  generationTasks.cancelAll()
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

const scanCache = new ProjectScanCache()

handle(IPC.scanProject, async (_e, projectPath: string) => {
  const settings = await getSettings()
  const { scan } = await scanCache.refresh(projectPath, settings.scanLimits)
  addRecentProject({ path: projectPath, name: scan.name })
  return { ...scan, storagePath: projectPath }
})

handle(IPC.recentProjects, () => {
  const recent = getRecentProjects()
  authorizedProjects.registerRecent(recent.map((project) => project.path))
  return recent
})

handle(IPC.removeRecent, async (_e, projectPath: string) => {
  await removeRecentProject(projectPath)
  // 撤销授权与显式失效缓存必须一起做：否则被移除的项目仍可复用旧扫描结果。
  authorizedProjects.removeRecent(projectPath)
  authorizedProjects.registerRecent(getRecentProjects().map((project) => project.path))
  await scanCache.invalidate(projectPath)
})

handle(IPC.loadResult, (_e, projectPath: string) => loadResult(projectPath))

handle(IPC.generationDraftGet, (_e, projectPath: string): GenerationDraftSummary | null =>
  readGenerationDraft(projectPath)?.summary ?? null
)

handle(IPC.generationDraftDiscard, (_e, projectPath: string, draftId: string) => {
  if (generationTasks.active) throw new Error('已有生成任务在进行中')
  const draft = readGenerationDraft(projectPath)
  if (!draft || draft.summary.id !== draftId) {
    throw new Error(GENERATION_DRAFT_MESSAGES.missing)
  }
  removeGenerationDraft(projectPath, draftId)
})

handle(IPC.listAnalyses, (_e, projectPath: string, cursor?: string) => listAnalyses(projectPath, cursor))

handle(IPC.loadAnalysis, (_e, projectPath: string, analysisId: string) => loadAnalysis(projectPath, analysisId))

handle(IPC.deleteResult, (_e, projectPath: string) => {
  deleteResult(projectPath)
})

// ---------- 生成 ----------

// 生成槽位注册表（issue #20）：begin() 同步占用，杜绝并发生成；
// runId 用于防止陈旧的 finish 误清新任务的锁。
const generationTasks = new GenerationTaskRegistry()

handle(IPC.generateRun, async (event, request: GenerateRequest): Promise<GenerateResponse> => {
  // 任何 await 之前同步占用槽位：重复请求在这里被拒绝，不会并发扫描/生成
  const runId = request.runId.toLowerCase()
  const task = generationTasks.begin(runId)
  if (!task) throw new Error('已有生成任务在进行中')
  const { controller: abort } = task
  const options = request
  const sender = event.sender
  const isCurrentTask = (): boolean =>
    generationTasks.active?.runId === runId && !abort.signal.aborted && !sender.isDestroyed()
  const ensureCurrentTask = (): void => {
    if (!isCurrentTask()) throw new Error('已取消生成')
  }
  // 进度绑定到发起请求的 webContents，并在发送时检查任务和取消状态。
  // ts 保留主进程产生时刻，runId 供 renderer 做任务隔离。
  const sendProgress = (step: string, detail: string | undefined, percent: number): void => {
    if (!isCurrentTask()) return
    sender.send(IPC.generateProgress, { step, detail, percent, ts: Date.now(), runId })
  }

  try {
    const settings = await getSettings()
    ensureCurrentTask()
    const profile = await getPrivateProfile(options.profileId)
    ensureCurrentTask()
    if (!profile) throw new Error('未找到指定的大模型配置，请先到设置页完成配置')

    sendProgress('校验项目扫描', '检查项目扫描缓存', 2)
    const cached = await scanCache.getFresh(options.projectPath, settings.scanLimits)
    ensureCurrentTask()
    const scanDetail = cached.status === 'reused'
      ? '使用未变化的项目扫描结果'
      : cached.reason === 'changed'
        ? '检测到项目文件变化，重新扫描'
        : '没有可复用的扫描结果，重新扫描'
    sendProgress(
      cached.status === 'reused' ? '复用扫描缓存' : '重新扫描项目',
      scanDetail,
      5
    )

    let draft = readGenerationDraft(options.projectPath)
    if (options.resumeDraftId) {
      if (!draft || draft.summary.id !== options.resumeDraftId) {
        throw new Error(GENERATION_DRAFT_MESSAGES.missing)
      }
      if (draft.summary.granularity !== options.granularity || draft.summary.roleFocus !== options.roleFocus || draft.summary.profileId !== profile.id) {
        throw new Error(GENERATION_DRAFT_MESSAGES.changed)
      }
    } else {
      draft = beginGenerationDraft(options.projectPath, {
        projectName: cached.scan.name,
        granularity: options.granularity,
        roleFocus: options.roleFocus,
        profileId: profile.id,
        modelLabel: profile.model
      })
    }
    ensureCurrentTask()
    if (!draft) throw new Error(GENERATION_DRAFT_MESSAGES.corrupt)

    if (draft.summary.ready && draft.result) {
      const analysisId = saveResult(options.projectPath, draft.result)
      ensureCurrentTask()
      addRecentProject({ path: options.projectPath, name: cached.scan.name, granularity: options.granularity })
      ensureCurrentTask()
      removeGenerationDraft(options.projectPath, draft.summary.id)
      return { runId, result: draft.result, storagePath: options.projectPath, ...(typeof analysisId === 'string' ? { analysisId } : {}) }
    }
    const generationParams = {
      scan: cached.scan,
      granularity: options.granularity,
      roleFocus: options.roleFocus,
      profile,
      signal: abort.signal,
      onProgress: sendProgress,
      checkpoint: {
        state: draft.checkpoint,
        save: (state: GenerationCheckpoint) => {
          ensureCurrentTask()
          saveGenerationDraft(options.projectPath, draft!.summary.id, state)
        }
      }
    } as Parameters<typeof generateInterview>[0]
    const result = await generateInterview(generationParams)
    ensureCurrentTask()
    completeGenerationDraft(options.projectPath, draft.summary.id, result)
    ensureCurrentTask()
    const analysisId = saveResult(options.projectPath, result)
    ensureCurrentTask()
    addRecentProject({ path: options.projectPath, name: cached.scan.name, granularity: options.granularity })
    ensureCurrentTask()
    removeGenerationDraft(options.projectPath, draft.summary.id)
    return { runId, result, storagePath: options.projectPath, ...(typeof analysisId === 'string' ? { analysisId } : {}) }
  } catch (err) {
    if (!isCurrentTask()) throw new Error('已取消生成')
    if (isLlmTimeoutError(err)) {
      throw new Error('生成面试题时模型请求超时，请检查网络或稍后重试。')
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    // runId 守卫：陈旧的 finish 不会清掉新任务的锁
    generationTasks.finish(runId)
  }
})

handle(IPC.generateCancel, (_event, runId: string) => {
  generationTasks.cancel(runId)
})

// ---------- 名词 AI 解释（流式） ----------

const explainAborts = new ExplainAbortRegistry()

handle(IPC.explainStart, async (_e, req: ExplainRequest): Promise<void> => {
  const abort = explainAborts.begin(req.requestId)
  if (!abort) throw new Error('已有相同名词解释请求在进行中')
  try {
    const profile = await getPrivateProfile(req.profileId)
    if (abort.signal.aborted) throw new Error('explain-aborted')
    if (!profile) throw new Error('profile-missing')
    await chatCompletionStream(
      profile,
      buildExplainMessages({
        term: req.term,
        projectSummary: req.projectSummary,
        question: req.question,
        snippet: req.snippet,
        glossaryHint: req.glossaryHint
      }),
      (delta) => { if (!abort.signal.aborted) send(IPC.explainEvent, { requestId: req.requestId, type: 'delta', data: delta }) },
      { signal: abort.signal, timeoutMs: 120_000, maxOutputTokens: 1200 }
    )
    if (!abort.signal.aborted) send(IPC.explainEvent, { requestId: req.requestId, type: 'done', data: '' })
  } catch (err) {
    const msg = abort.signal.aborted
      ? '已取消'
      : isLlmTimeoutError(err)
        ? '名词解释请求超时，请检查网络或稍后重试。'
        : '请求处理失败，请稍后重试'
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

handle(IPC.storageDiagnostics, () => getStorageDiagnostics().filter((diagnostic) => {
  if (diagnostic.kind !== 'result') return true
  if (!diagnostic.projectPath) return false
  try {
    authorizedProjects.requireAuthorized(diagnostic.projectPath)
    return true
  } catch {
    return false
  }
}))

handle(IPC.storageRecover, (_e, id: string) => {
  return recoverStorage(id).then(() => {
  // Restored recent records affect the set of allowed history projects.
  if (id === 'recent') authorizedProjects.registerRecent(getRecentProjects().map((project) => project.path))
  })
})

/**
 * 把设置写盘失败的 errno 翻译成可操作、不含敏感信息（不含路径/密钥）的提示
 * （issue #15）。消息须在 ipc-handler-guards.ts 的 SAFE_BUSINESS_ERRORS
 * 白名单内才能原样到达渲染进程。
 */
function describeSettingsWriteError(err: unknown): string {
  if (err instanceof Error && [
    '修改接口地址前，请先替换或清除已保存的 API Key。',
    '修改接口协议前，请先替换或清除已保存的 API Key。',
    '设置尚未完成安全迁移，请检查系统凭据存储后重试。',
    '系统凭据存储当前不可用，设置未更改。请稍后重试。'
  ].includes(err.message)) return err.message
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
  if (code === 'ENOSPC' || code === 'EDQUOT') return '磁盘空间不足，无法保存设置。请清理磁盘空间后重试。'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return '没有写入权限，无法保存设置。请检查应用数据目录权限后重试。'
  return '保存设置失败，请重试；若持续失败请检查磁盘状态。'
}

handle(IPC.settingsSave, async (_e, settings: SettingsSaveRequest): Promise<void> => {
  try {
    await saveSettings(settings)
  } catch (err) {
    throw new Error(describeSettingsWriteError(err))
  }
})

function canonicalEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    return url.href.replace(/\/+$/, '')
  } catch { return null }
}

async function resolveProbeProfile(request: LlmProfileDraft): Promise<LlmProfile> {
  const explicitKey = request.apiKey ?? ''
  const profileWithKey = (apiKey: string): LlmProfile => ({
    id: request.id,
    name: request.name,
    baseUrl: request.baseUrl,
    model: request.model,
    apiKey,
    ...(request.protocol !== undefined ? { protocol: request.protocol } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
  })
  if (explicitKey) return profileWithKey(explicitKey)
  if (request.credentialAction === 'clear' || request.credentialAction === 'replace') return profileWithKey('')
  if (request.useSavedCredential) {
    const saved = await getPrivateProfile(request.id)
    if (!saved || !saved.apiKey || canonicalEndpoint(saved.baseUrl) !== canonicalEndpoint(request.baseUrl)) {
      throw new Error('已保存的 API Key 仅适用于原接口地址，请先替换 Key。')
    }
    if ((saved.protocol ?? 'openai') !== (request.protocol ?? 'openai')) {
      throw new Error('已保存的 API Key 仅适用于原接口协议，请先替换 Key。')
    }
    return profileWithKey(saved.apiKey)
  }
  return profileWithKey('')
}

handle(IPC.llmTest, async (_e, profile: LlmProfileDraft) => testConnection(await resolveProbeProfile(profile)))

handle(IPC.llmListModels, async (_e, profile: LlmProfileDraft) => listModels(await resolveProbeProfile(profile)))

handle(IPC.exportMarkdown, (e, result: InterviewResult) =>
  exportMarkdownDialog(result, BrowserWindow.fromWebContents(e.sender) ?? undefined)
)

// 通道清单与 schema 覆盖率自检在 services/ipc-validation.ts 中随模块加载执行，
// 那里是通道定义的唯一下游，不再需要在这里维护通道数量。

// 便于排查：开发模式下输出一条就绪日志
console.log(`[RepoPrep] main ready, devUrl=${process.env['ELECTRON_RENDERER_URL'] ?? '(none)'}, randomId=${randomUUID().slice(0, 8)}`)
