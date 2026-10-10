import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { GenerateOptions, InterviewResult, ProjectOverview, Settings } from '@shared/types'
import { api } from './lib/ipc'
import { GenerationSession, type GenerationTask } from './lib/generation-session'
import SelectPage from './pages/SelectPage'
import ConfigurePage from './pages/ConfigurePage'
import GeneratingPage from './pages/GeneratingPage'
import ResultPage from './pages/ResultPage'
import SettingsPage from './pages/SettingsPage'

export type View = 'select' | 'configure' | 'generating' | 'result' | 'settings'
type LeaveTarget = { kind: 'select' | 'settings' } | { kind: 'task'; runId: string }

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
  const [existingResult, setExistingResult] = useState<InterviewResult | null>(null)
  const [result, setResult] = useState<InterviewResult | null>(null)
  const [settings, setSettings] = useState<Settings>({ profiles: [], defaultProfileId: null })

  const session = useMemo(() => new GenerationSession(api), [])
  const sessionSnapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const foregroundTask = foregroundRunId
    ? sessionSnapshot.tasks.find((task) => task.runId === foregroundRunId) ?? null
    : null
  const activeTask = sessionSnapshot.activeRunId
    ? sessionSnapshot.tasks.find((task) => task.runId === sessionSnapshot.activeRunId) ?? null
    : null
  const backgroundTasks = sessionSnapshot.tasks.filter((task) => task.mode === 'background')

  const refreshSettings = useCallback(() => {
    api.getSettings().then(setSettings).catch(() => undefined)
  }, [])

  useEffect(() => {
    session.activate()
    refreshSettings()
    const off = api.onGenerateProgress((progress) => session.receiveProgress(progress))
    return () => {
      off()
      session.dispose()
    }
  }, [refreshSettings, session])

  // Only the current foreground task may navigate on settlement. Detached tasks keep
  // their result in the session history and never replace the visible project/result.
  useEffect(() => {
    const task = foregroundTask
    if (!task || task.mode !== 'foreground' || viewRef.current !== 'generating') return
    if (task.status === 'succeeded' && task.result) {
      setLeaveTarget(null)
      setOverview(task.overview as ProjectOverview)
      setExistingResult(task.result)
      setResult(task.result)
      setForegroundRunId(null)
      navigationEpoch.current++
      setView('result')
    } else if (task.status === 'cancelled') {
      setLeaveTarget(null)
      setOverview(task.overview as ProjectOverview)
      setExistingResult(task.existingResult as InterviewResult | null)
      setForegroundRunId(null)
      navigationEpoch.current++
      setView('configure')
    }
  }, [foregroundTask])

  const restoreTask = (task: GenerationTask) => {
    navigationEpoch.current++
    setTaskPanelOpen(false)
    if (task.status === 'succeeded' && task.result) {
      setOverview(task.overview as ProjectOverview)
      setExistingResult(task.result)
      setResult(task.result)
      setForegroundRunId(null)
      setView('result')
      return
    }
    if (task.status === 'cancelled') {
      setOverview(task.overview as ProjectOverview)
      setExistingResult(task.existingResult as InterviewResult | null)
      setForegroundRunId(null)
      setView('configure')
      return
    }
    session.resume(task.runId)
    setForegroundRunId(task.runId)
    setView('generating')
  }

  const commitNavigation = (target: LeaveTarget, from: View) => {
    setLeaveTarget(null)
    if (target.kind === 'task') {
      const task = session.getTask(target.runId)
      if (task) restoreTask(task)
      return
    }
    navigationEpoch.current++
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
    const nextOverview = await api.scanProject(path)
    const nextResult = await api.loadResult(path)
    if (ticket !== navigationEpoch.current) return
    setOverview(nextOverview)
    setExistingResult(nextResult)
    setView('configure')
  }, [])

  const startGenerate = useCallback((options: GenerateOptions) => {
    if (!overview) return
    const taskExistingResult = existingResult?.projectPath === overview.root ? existingResult : null
    const runId = session.start(options, overview, taskExistingResult)
    if (!runId) return
    navigationEpoch.current++
    setForegroundRunId(runId)
    setView('generating')
  }, [existingResult, overview, session])

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

  const regenerate = useCallback(() => {
    navigationEpoch.current++
    setView(overview ? 'configure' : 'select')
  }, [overview])

  const viewExisting = useCallback((nextResult: InterviewResult) => {
    navigationEpoch.current++
    setResult(nextResult)
    setView('result')
  }, [])

  const busyForConfigure = activeTask && (activeTask.status === 'running' || activeTask.status === 'cancelling')
    ? { projectName: activeTask.overview.name, runId: activeTask.runId, cancelling: activeTask.status === 'cancelling' }
    : null

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

      <main className="min-h-0 flex-1">
        {view === 'select' && (
          <SelectPage settings={settings} openProject={openProject} viewExisting={viewExisting} openSettings={() => requestNavigation({ kind: 'settings' })} />
        )}
        {view === 'configure' && overview && (
          <ConfigurePage
            overview={overview}
            existingResult={existingResult}
            settings={settings}
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
              setExistingResult(foregroundTask.existingResult as InterviewResult | null)
              setForegroundRunId(null)
              navigationEpoch.current++
              setView('configure')
            }}
          />
        )}
        {view === 'result' && result && <ResultPage result={result} settings={settings} onRegenerate={regenerate} />}
        {view === 'settings' && (
          <SettingsPage
            settings={settings}
            onSaved={(next) => { setSettings(next); refreshSettings() }}
            onBack={() => {
              navigationEpoch.current++
              setView(prevView === 'settings' ? 'select' : prevView)
            }}
          />
        )}
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
    </div>
  )
}
