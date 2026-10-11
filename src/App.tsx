import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { GenerateOptions, InterviewResult, ProjectOverview, Settings } from '@shared/types'
import { RESULT_CONTRACT_MESSAGES } from '@shared/result-contract'
import { STORAGE_MESSAGES, type StorageDiagnostic } from '@shared/storage-contract'
import { api } from './lib/ipc'
import { GenerationSession, type GenerationTask } from './lib/generation-session'
import SelectPage from './pages/SelectPage'
import ConfigurePage from './pages/ConfigurePage'
import GeneratingPage from './pages/GeneratingPage'
import ResultPage from './pages/ResultPage'
import SettingsPage from './pages/SettingsPage'

export type View = 'select' | 'configure' | 'generating' | 'result' | 'settings'
type LeaveTarget = { kind: 'select' | 'settings' } | { kind: 'task'; runId: string }
type HistoryRecoveryStatus = 'scanning' | 'removing' | 'error'
interface HistoryRecoveryState {
  result: InterviewResult
  sourceRecentPath: string
  targetPath: string
  status: HistoryRecoveryStatus
  error: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isInvalidHistoryLoadError(error: unknown): boolean {
  const message = errorMessage(error)
  const escaped = RESULT_CONTRACT_MESSAGES.history.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|: )(?:Error: )?${escaped}$`).test(message)
}

function isCorruptHistoryLoadError(error: unknown): boolean {
  const escaped = STORAGE_MESSAGES.corruptResult.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|: )(?:Error: )?${escaped}$`).test(errorMessage(error))
}

function projectName(path: string | undefined): string {
  if (!path) return '历史项目'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? '历史项目'
}

function storageProblemMessage(diagnostic: StorageDiagnostic): string {
  if (diagnostic.kind === 'result') {
    if (diagnostic.problem === 'corrupt') return STORAGE_MESSAGES.corruptResult
    if (diagnostic.problem === 'missing') return '历史结果文件缺失。'
    return STORAGE_MESSAGES.unreadableResult
  }
  const subject = diagnostic.kind === 'settings' ? '设置' : '最近项目列表'
  if (diagnostic.problem === 'corrupt') return `${subject}文件已损坏。`
  if (diagnostic.problem === 'missing') return `${subject}文件缺失。`
  return `${subject}文件暂时无法读取，请检查权限后重试。`
}
export default function App() {
  const [view, setView] = useState<View>('select')
  const viewRef = useRef(view)
  viewRef.current = view
  const navigationEpoch = useRef(0)
  const [prevView, setPrevView] = useState<View>('select')
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null)
  const [taskPanelOpen, setTaskPanelOpen] = useState(false)
  const [foregroundRunId, setForegroundRunId] = useState<string | null>(null)
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [projectStoragePath, setProjectStoragePath] = useState<string | null>(null)
  const [existingResult, setExistingResult] = useState<InterviewResult | null>(null)
  const [result, setResult] = useState<InterviewResult | null>(null)
  const [resultStoragePath, setResultStoragePath] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings>({ profiles: [], defaultProfileId: null })
  const [configureInitialOptions, setConfigureInitialOptions] = useState<GenerateOptions | undefined>()
  const [configureNotice, setConfigureNotice] = useState<string | null>(null)
  const [configureRevision, setConfigureRevision] = useState(0)
  const [historyRecovery, setHistoryRecovery] = useState<HistoryRecoveryState | null>(null)
  const historyRecoveryAttempt = useRef<number | null>(null)
  const [storageDiagnostics, setStorageDiagnostics] = useState<StorageDiagnostic[]>([])
  const [storageRecovery, setStorageRecovery] = useState<{ id: string; error: string } | null>(null)
  const [recoveringStorageId, setRecoveringStorageId] = useState<string | null>(null)
  const recoveryLock = useRef(false)
  const [selectPageRevision, setSelectPageRevision] = useState(0)
  const diagnosticsRequest = useRef(0)
  const mounted = useRef(false)

  const session = useMemo(() => new GenerationSession(api), [])
  const sessionSnapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const foregroundTask = foregroundRunId
    ? sessionSnapshot.tasks.find((task) => task.runId === foregroundRunId) ?? null
    : null
  const activeTask = sessionSnapshot.activeRunId
    ? sessionSnapshot.tasks.find((task) => task.runId === sessionSnapshot.activeRunId) ?? null
    : null
  const backgroundTasks = sessionSnapshot.tasks.filter((task) => task.mode === 'background')

  const refreshStorageDiagnostics = useCallback(() => {
    const request = ++diagnosticsRequest.current
    void api.getStorageDiagnostics().then((items) => {
      if (mounted.current && request === diagnosticsRequest.current) setStorageDiagnostics(items)
    }).catch(() => undefined)
  }, [])

  const refreshSettings = useCallback(() => {
    api.getSettings().then((next) => {
      if (mounted.current) setSettings(next)
    }).catch(() => undefined).finally(refreshStorageDiagnostics)
  }, [refreshStorageDiagnostics])

  useEffect(() => {
    mounted.current = true
    session.activate()
    refreshSettings()
    refreshStorageDiagnostics()
    const off = api.onGenerateProgress((progress) => session.receiveProgress(progress))
    return () => {
      mounted.current = false
      diagnosticsRequest.current++
      off()
      session.dispose()
    }
  }, [refreshSettings, refreshStorageDiagnostics, session])

  // Only the current foreground task may navigate on settlement. Detached tasks keep
  // their result in the session history and never replace the visible project/result.
  useEffect(() => {
    const task = foregroundTask
    if (!task || task.mode !== 'foreground' || viewRef.current !== 'generating') return
    if (task.status === 'succeeded' && task.result) {
      historyRecoveryAttempt.current = null
      setLeaveTarget(null)
      setHistoryRecovery(null)
      setOverview(task.overview as ProjectOverview)
      setProjectStoragePath(task.resultStoragePath ?? task.options.projectPath)
      setExistingResult(task.result)
      setResult(task.result)
      setResultStoragePath(task.resultStoragePath ?? task.options.projectPath)
      setForegroundRunId(null)
      navigationEpoch.current++
      setView('result')
    } else if (task.status === 'cancelled') {
      historyRecoveryAttempt.current = null
      setLeaveTarget(null)
      setHistoryRecovery(null)
      setOverview(task.overview as ProjectOverview)
      setProjectStoragePath(task.resultStoragePath ?? task.options.projectPath)
      setExistingResult(task.existingResult as InterviewResult | null)
      setConfigureInitialOptions({ projectPath: task.options.projectPath, granularity: task.options.granularity, roleFocus: task.options.roleFocus, profileId: task.options.profileId })
      setConfigureNotice(null)
      setConfigureRevision((revision) => revision + 1)
      setForegroundRunId(null)
      navigationEpoch.current++
      setView('configure')
    }
  }, [foregroundTask])

  const restoreTask = (task: GenerationTask) => {
    navigationEpoch.current++
    historyRecoveryAttempt.current = null
    setHistoryRecovery(null)
    setTaskPanelOpen(false)
    if (task.status === 'succeeded' && task.result) {
      setOverview(task.overview as ProjectOverview)
      setProjectStoragePath(task.resultStoragePath ?? task.options.projectPath)
      setExistingResult(task.result)
      setResult(task.result)
      setResultStoragePath(task.resultStoragePath ?? task.options.projectPath)
      setForegroundRunId(null)
      setView('result')
      return
    }
    if (task.status === 'cancelled') {
      setOverview(task.overview as ProjectOverview)
      setProjectStoragePath(task.options.projectPath)
      setExistingResult(task.existingResult as InterviewResult | null)
      setConfigureInitialOptions({ projectPath: task.options.projectPath, granularity: task.options.granularity, roleFocus: task.options.roleFocus, profileId: task.options.profileId })
      setConfigureNotice(null)
      setConfigureRevision((revision) => revision + 1)
      setForegroundRunId(null)
      setView('configure')
      return
    }
    session.resume(task.runId)
    setForegroundRunId(task.runId)
    setView('generating')
  }

  const commitNavigation = (target: LeaveTarget, from: View) => {
    navigationEpoch.current++
    historyRecoveryAttempt.current = null
    setHistoryRecovery(null)
    setLeaveTarget(null)
    if (target.kind === 'task') {
      const task = session.getTask(target.runId)
      if (task) restoreTask(task)
      return
    }
    if (target.kind === 'settings') setPrevView(from === 'generating' ? 'select' : from)
    setView(target.kind)
  }

  const requestNavigation = (target: LeaveTarget) => {
    const task = foregroundTask
    if (viewRef.current === 'generating' && task && (task.status === 'running' || task.status === 'cancelling')) {
      setLeaveTarget(target)
      return
    }
    commitNavigation(target, viewRef.current)
  }

  const leaveInBackground = () => {
    const task = foregroundTask
    if (task) session.detach(task.runId)
    if (leaveTarget) commitNavigation(leaveTarget, 'generating')
  }

  const cancelAndLeave = () => {
    const task = foregroundTask
    if (task) {
      session.detach(task.runId)
      session.cancel(task.runId)
    }
    if (leaveTarget) commitNavigation(leaveTarget, 'generating')
  }

  /** Open (scan) a project and enter its configuration page. */
  const openProject = useCallback(async (path: string) => {
    const ticket = ++navigationEpoch.current
    historyRecoveryAttempt.current = null
    const nextOverview = await api.scanProject(path)
    if (ticket !== navigationEpoch.current) return
    let nextResult: InterviewResult | null
    let notice: string | null = null
    try {
      nextResult = await api.loadResult(nextOverview.storagePath ?? path)
      refreshStorageDiagnostics()
    } catch (error) {
      refreshStorageDiagnostics()
      if (ticket !== navigationEpoch.current) return
      if (!isInvalidHistoryLoadError(error) && !isCorruptHistoryLoadError(error)) throw error
      nextResult = null
      notice = isCorruptHistoryLoadError(error) ? STORAGE_MESSAGES.corruptResult : RESULT_CONTRACT_MESSAGES.history
    }
    if (ticket !== navigationEpoch.current) return
    setOverview(nextOverview)
    setProjectStoragePath(nextOverview.storagePath ?? path)
    setExistingResult(nextResult)
    setConfigureInitialOptions(undefined)
    setConfigureNotice(notice)
    setConfigureRevision((revision) => revision + 1)
    setHistoryRecovery(null)
    setView('configure')
  }, [refreshStorageDiagnostics])

  const recoverStorage = async (diagnostic: StorageDiagnostic) => {
    if (!diagnostic.canRecover || recoveryLock.current) return
    recoveryLock.current = true
    const ticket = navigationEpoch.current
    setRecoveringStorageId(diagnostic.id)
    setStorageRecovery(null)
    try {
      await api.recoverStorage(diagnostic.id)
      refreshStorageDiagnostics()
      if (diagnostic.kind === 'settings') refreshSettings()
      if (mounted.current && ticket === navigationEpoch.current && viewRef.current === 'select' && (diagnostic.kind === 'recent' || diagnostic.kind === 'result')) {
        setSelectPageRevision((revision) => revision + 1)
      }
      if (
        diagnostic.kind === 'result' && diagnostic.projectPath && mounted.current &&
        ticket === navigationEpoch.current && viewRef.current === 'result' && resultStoragePath === diagnostic.projectPath
      ) {
        try {
          const recoveredResult = await api.loadResult(diagnostic.projectPath)
          if (mounted.current && ticket === navigationEpoch.current && viewRef.current === 'result' && resultStoragePath === diagnostic.projectPath && recoveredResult) {
            setResult(recoveredResult)
            setResultStoragePath(diagnostic.projectPath)
          }
        } catch {
          refreshStorageDiagnostics()
        }
      }
    } catch {
      if (mounted.current) setStorageRecovery({ id: diagnostic.id, error: STORAGE_MESSAGES.restoreFailed })
      refreshStorageDiagnostics()
    } finally {
      recoveryLock.current = false
      if (mounted.current) setRecoveringStorageId(null)
    }
  }

  const startGenerate = useCallback((options: GenerateOptions) => {
    if (!overview) return
    const taskExistingResult = existingResult?.projectPath === overview.root ? existingResult : null
    const runId = session.start({ ...options, projectPath: projectStoragePath ?? options.projectPath }, overview, taskExistingResult)
    if (!runId) return
    navigationEpoch.current++
    historyRecoveryAttempt.current = null
    setHistoryRecovery(null)
    setForegroundRunId(runId)
    setView('generating')
  }, [existingResult, overview, projectStoragePath, session])

  const cancelGenerate = useCallback(() => {
    if (foregroundTask) session.cancel(foregroundTask.runId)
  }, [foregroundTask, session])

  const requestReturnToTask = (targetTask: GenerationTask) => {
    const current = foregroundTask
    if (
      viewRef.current === 'generating' && current && current.runId !== targetTask.runId &&
      (current.status === 'running' || current.status === 'cancelling')
    ) {
      setLeaveTarget({ kind: 'task', runId: targetTask.runId })
      return
    }
    setLeaveTarget(null)
    restoreTask(session.getTask(targetTask.runId) ?? targetTask)
  }

  const optionsForHistory = (history: InterviewResult, projectPath: string): GenerateOptions => {
    const profileId = settings.profiles.some((profile) => profile.id === history.profileId)
      ? history.profileId
      : settings.profiles.some((profile) => profile.id === settings.defaultProfileId)
        ? settings.defaultProfileId!
        : settings.profiles[0]?.id ?? ''
    return {
      projectPath,
      granularity: history.granularity,
      roleFocus: history.roleFocus,
      profileId
    }
  }

  const scanHistoryProject = async (history: InterviewResult, sourceRecentPath: string, targetPath: string, ticket: number): Promise<void> => {
    const isCurrentAttempt = () => ticket === navigationEpoch.current && historyRecoveryAttempt.current === ticket
    try {
      const nextOverview = await api.scanProject(targetPath)
      if (!isCurrentAttempt()) return
      const nextResult = await api.loadResult(nextOverview.storagePath ?? targetPath)
      if (!isCurrentAttempt()) return
      const storedTargetPath = nextOverview.storagePath ?? targetPath

      let oldRecentNotice: string | null = null
      if (sourceRecentPath !== storedTargetPath) {
        try {
          await api.removeRecent(sourceRecentPath)
        } catch (error) {
          if (!isCurrentAttempt()) return
          oldRecentNotice = `项目已重新定位，但旧项目的最近记录移除失败：${errorMessage(error)}`
        }
        if (!isCurrentAttempt()) return
      }

      navigationEpoch.current++
      historyRecoveryAttempt.current = null
      setOverview(nextOverview)
      setProjectStoragePath(storedTargetPath)
      setExistingResult(nextResult)
      setConfigureInitialOptions(optionsForHistory(history, storedTargetPath))
      setConfigureNotice(oldRecentNotice)
      setConfigureRevision((revision) => revision + 1)
      setHistoryRecovery(null)
      setView('configure')
    } catch (error) {
      if (!isCurrentAttempt()) return
      setHistoryRecovery({ result: history, sourceRecentPath, targetPath, status: 'error', error: errorMessage(error) })
    } finally {
      if (historyRecoveryAttempt.current === ticket) historyRecoveryAttempt.current = null
    }
  }

  const beginHistoryRecovery = (history: InterviewResult, sourceRecentPath: string) => {
    if (historyRecoveryAttempt.current !== null) return
    const ticket = ++navigationEpoch.current
    historyRecoveryAttempt.current = ticket
    setHistoryRecovery({ result: history, sourceRecentPath, targetPath: sourceRecentPath, status: 'scanning', error: '' })
    void scanHistoryProject(history, sourceRecentPath, sourceRecentPath, ticket)
  }

  const retryHistoryScan = () => {
    if (!historyRecovery || historyRecovery.status !== 'error') return
    if (historyRecoveryAttempt.current !== null) return
    const ticket = ++navigationEpoch.current
    historyRecoveryAttempt.current = ticket
    setHistoryRecovery({ ...historyRecovery, status: 'scanning', error: '' })
    void scanHistoryProject(historyRecovery.result, historyRecovery.sourceRecentPath, historyRecovery.targetPath, ticket)
  }

  const relocateHistoryProject = async () => {
    const recovery = historyRecovery
    if (!recovery || recovery.status !== 'error') return
    if (historyRecoveryAttempt.current !== null) return
    const ticket = ++navigationEpoch.current
    historyRecoveryAttempt.current = ticket
    setHistoryRecovery({ ...recovery, status: 'scanning', error: '' })
    try {
      const selectedPath = await api.selectFolder()
      if (ticket !== navigationEpoch.current || historyRecoveryAttempt.current !== ticket) return
      if (!selectedPath) {
        historyRecoveryAttempt.current = null
        setHistoryRecovery({ ...recovery, status: 'error', error: '未选择新项目文件夹。' })
        return
      }
      setHistoryRecovery({ ...recovery, targetPath: selectedPath, status: 'scanning', error: '' })
      void scanHistoryProject(recovery.result, recovery.sourceRecentPath, selectedPath, ticket)
    } catch (error) {
      if (ticket !== navigationEpoch.current || historyRecoveryAttempt.current !== ticket) return
      historyRecoveryAttempt.current = null
      setHistoryRecovery({ ...recovery, status: 'error', error: errorMessage(error) })
    }
  }

  const removeHistoryFromRecent = async () => {
    const recovery = historyRecovery
    if (!recovery || recovery.status !== 'error') return
    if (historyRecoveryAttempt.current !== null) return
    const ticket = ++navigationEpoch.current
    historyRecoveryAttempt.current = ticket
    setHistoryRecovery({ ...recovery, status: 'removing', error: '' })
    try {
      await api.removeRecent(recovery.sourceRecentPath)
      if (ticket !== navigationEpoch.current || historyRecoveryAttempt.current !== ticket) return
      navigationEpoch.current++
      historyRecoveryAttempt.current = null
      setHistoryRecovery(null)
      setView('select')
    } catch (error) {
      if (ticket !== navigationEpoch.current || historyRecoveryAttempt.current !== ticket) return
      historyRecoveryAttempt.current = null
      setHistoryRecovery({ ...recovery, status: 'error', error: `从最近项目移除失败：${errorMessage(error)}` })
    }
  }

  const keepHistoryResult = () => {
    navigationEpoch.current++
    historyRecoveryAttempt.current = null
    setHistoryRecovery(null)
  }

  const viewExisting = useCallback((nextResult: InterviewResult, sourceRecentPath: string) => {
    navigationEpoch.current++
    historyRecoveryAttempt.current = null
    setHistoryRecovery(null)
    setResult(nextResult)
    setResultStoragePath(sourceRecentPath)
    setView('result')
  }, [])

  const busyForConfigure = activeTask && (activeTask.status === 'running' || activeTask.status === 'cancelling')
    ? { projectName: activeTask.overview.name, runId: activeTask.runId, cancelling: activeTask.status === 'cancelling' }
    : null
  const visibleStorageDiagnostics = storageDiagnostics.filter((item) => item.problem !== 'missing' || item.usingBackup || item.canRecover)

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔭</span>
          <span className="select-none text-[15px] font-semibold tracking-wide text-slate-800">ProjectLens</span>
          <span className="ml-1 hidden select-none text-xs text-slate-400 sm:inline">项目面试题生成器</span>
        </div>
        <div className="flex items-center gap-1">
          {view !== 'select' && view !== 'settings' && (
            <button className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100" onClick={() => requestNavigation({ kind: 'select' })}>
              切换项目
            </button>
          )}
          {backgroundTasks.length > 0 && (
            <button className="rounded-md px-3 py-1.5 text-sm text-indigo-700 hover:bg-indigo-50" onClick={() => setTaskPanelOpen(true)}>
              后台生成（{backgroundTasks.length}）
            </button>
          )}
          <button className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100" onClick={() => requestNavigation({ kind: 'settings' })}>
            ⚙️ 设置
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {visibleStorageDiagnostics.length > 0 && (
          <section className="mx-auto max-h-32 w-full max-w-5xl shrink-0 space-y-2 overflow-y-auto px-4 pt-3" aria-label="存储状态">
            {visibleStorageDiagnostics.map((diagnostic) => (
              <div key={diagnostic.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
                <p className="min-w-0 flex-1">
                  <span className="font-medium">{diagnostic.kind === 'result' ? projectName(diagnostic.projectPath) : diagnostic.kind === 'settings' ? '设置' : '最近项目列表'}：</span>
                  {storageProblemMessage(diagnostic)}{diagnostic.usingBackup ? ' 当前正在使用最近的完整备份。' : ''}
                </p>
                {diagnostic.canRecover && (
                  <button
                    className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 disabled:opacity-50"
                    disabled={recoveringStorageId !== null}
                    onClick={() => void recoverStorage(diagnostic)}
                  >
                    {recoveringStorageId === diagnostic.id ? '正在恢复…' : storageRecovery?.id === diagnostic.id ? '重试恢复备份' : '恢复最近完整备份'}
                  </button>
                )}
                {storageRecovery?.id === diagnostic.id && (
                  <span className="w-full text-xs text-rose-700" role="alert">{storageRecovery.error}</span>
                )}
              </div>
            ))}
          </section>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {view === 'select' && (
            <SelectPage key={selectPageRevision} settings={settings} openProject={openProject} viewExisting={viewExisting} openSettings={() => requestNavigation({ kind: 'settings' })} onStorageRead={refreshStorageDiagnostics} storageDiagnostics={storageDiagnostics} />
          )}
          {view === 'configure' && overview && (
            <ConfigurePage
              key={`${overview.root}:${configureRevision}`}
              overview={overview}
              projectStoragePath={projectStoragePath ?? overview.root}
              existingResult={existingResult}
              settings={settings}
              initialOptions={configureInitialOptions}
              notice={configureNotice}
              onStart={startGenerate}
              onViewExisting={viewExisting}
              busyTask={busyForConfigure}
              onResumeTask={() => activeTask && requestReturnToTask(activeTask)}
            />
          )}
          {view === 'generating' && foregroundTask && (
            <GeneratingPage
              overview={foregroundTask.overview as ProjectOverview}
              options={foregroundTask.options as GenerateOptions}
              progress={foregroundTask.progress}
              logs={foregroundTask.logs}
              error={foregroundTask.error}
              cancelling={foregroundTask.status === 'cancelling'}
              onCancel={cancelGenerate}
              onBack={() => {
                setOverview(foregroundTask.overview as ProjectOverview)
                setProjectStoragePath(foregroundTask.options.projectPath)
                setExistingResult(foregroundTask.existingResult as InterviewResult | null)
                setForegroundRunId(null)
                setConfigureInitialOptions({
                  projectPath: foregroundTask.options.projectPath,
                  granularity: foregroundTask.options.granularity,
                  roleFocus: foregroundTask.options.roleFocus,
                  profileId: foregroundTask.options.profileId
                })
                setConfigureNotice(null)
                setConfigureRevision((revision) => revision + 1)
                navigationEpoch.current++
                setView('configure')
              }}
            />
          )}
          {view === 'result' && result && (
            <ResultPage
              result={result}
              settings={settings}
              onRegenerate={() => beginHistoryRecovery(result, resultStoragePath ?? result.projectPath)}
              regenerating={Boolean(historyRecovery)}
            />
          )}
          {view === 'settings' && (
            <SettingsPage
              settings={settings}
              onSaved={(next) => { setSettings(next); refreshSettings(); refreshStorageDiagnostics() }}
              onBack={() => {
                navigationEpoch.current++
                setView(prevView === 'settings' ? 'select' : prevView)
              }}
            />
          )}
        </div>
      </main>

      {leaveTarget && foregroundTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" role="dialog" aria-modal="true" aria-labelledby="leave-generation-title">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 id="leave-generation-title" className="text-base font-semibold text-slate-900">「{foregroundTask.overview.name}」仍在生成</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">选择离开方式。后台任务会保留进度，完成后可从“后台生成”查看结果。</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600" onClick={() => setLeaveTarget(null)}>留在生成页</button>
              <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm text-rose-700" onClick={cancelAndLeave}>取消生成并离开</button>
              <button className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white" onClick={leaveInBackground}>后台继续</button>
            </div>
          </div>
        </div>
      )}

      {taskPanelOpen && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/30 p-4" role="dialog" aria-modal="true" aria-labelledby="background-tasks-title">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 id="background-tasks-title" className="text-base font-semibold text-slate-900">生成任务</h2>
              <button className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100" onClick={() => setTaskPanelOpen(false)}>关闭</button>
            </div>
            <div className="mt-4 space-y-2">
              {backgroundTasks.map((task) => (
                <div key={task.runId} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800">{task.overview.name}</div>
                    <div className="text-xs text-slate-500">
                      {task.status === 'running' ? `后台生成中 · ${task.progress?.percent ?? 0}%` :
                        task.status === 'cancelling' ? '正在取消…' :
                          task.status === 'succeeded' ? '已完成，可查看结果' :
                            task.status === 'cancelled' ? '已取消' : `生成失败：${task.error ?? '未知错误'}`}
                    </div>
                  </div>
                  {task.status !== 'cancelling' && (
                    <button className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white" onClick={() => requestReturnToTask(task)}>
                      {task.status === 'succeeded' ? '查看结果' : task.status === 'cancelled' ? '返回配置' : task.status === 'failed' ? '查看详情' : '恢复任务'}
                    </button>
                  )}
                  {(task.status === 'running' || task.status === 'cancelling') && (
                    <button className="shrink-0 rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-700 disabled:opacity-50" disabled={task.status === 'cancelling'} onClick={() => session.cancel(task.runId)}>
                      {task.status === 'cancelling' ? '正在取消…' : '取消'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === 'result' && historyRecovery && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4" role="dialog" aria-modal="true" aria-labelledby="history-recovery-title">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 id="history-recovery-title" className="text-base font-semibold text-slate-900">
              {historyRecovery.status === 'scanning'
                ? '正在重新扫描历史项目…'
                : historyRecovery.status === 'removing'
                  ? '正在从最近项目移除…'
                  : '原项目无法读取'}
            </h2>
            <p className="mt-2 break-all text-xs text-slate-500">{historyRecovery.targetPath}</p>
            {historyRecovery.error && (
              <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                {historyRecovery.error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {historyRecovery.status === 'error' && (
                <>
                  <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600" onClick={retryHistoryScan}>
                    重试扫描
                  </button>
                  <button className="rounded-lg border border-indigo-200 px-3 py-2 text-sm text-indigo-700" onClick={relocateHistoryProject}>
                    重新定位项目
                  </button>
                  <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm text-rose-700" onClick={removeHistoryFromRecent}>
                    从最近项目移除
                  </button>
                </>
              )}
              <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm text-white" onClick={keepHistoryResult}>
                保留历史结果
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
