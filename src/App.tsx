import { useCallback, useEffect, useState } from 'react'
import type { GenerateOptions, GenerateProgress, InterviewResult, ProjectOverview, Settings } from '@shared/types'
import { api } from './lib/ipc'
import SelectPage from './pages/SelectPage'
import ConfigurePage from './pages/ConfigurePage'
import GeneratingPage from './pages/GeneratingPage'
import ResultPage from './pages/ResultPage'
import SettingsPage from './pages/SettingsPage'

export type View = 'select' | 'configure' | 'generating' | 'result' | 'settings'

export default function App() {
  const [view, setView] = useState<View>('select')
  const [prevView, setPrevView] = useState<View>('select') // 从设置页返回的目标

  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [existingResult, setExistingResult] = useState<InterviewResult | null>(null)
  const [result, setResult] = useState<InterviewResult | null>(null)

  const [settings, setSettings] = useState<Settings>({ profiles: [], defaultProfileId: null })

  // 生成过程状态
  const [genOptions, setGenOptions] = useState<GenerateOptions | null>(null)
  const [genProgress, setGenProgress] = useState<GenerateProgress | null>(null)
  const [genLogs, setGenLogs] = useState<GenerateProgress[]>([])
  const [genError, setGenError] = useState<string | null>(null)

  const refreshSettings = useCallback(() => {
    api.getSettings().then(setSettings).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshSettings()
    const off = api.onGenerateProgress((p) => {
      setGenProgress(p)
      setGenLogs((logs) => [...logs.slice(-80), p])
    })
    return off
  }, [refreshSettings])

  const openSettings = () => {
    setPrevView(view)
    setView('settings')
  }

  /** 打开（扫描）一个项目并进入配置页 */
  const openProject = useCallback(async (path: string) => {
    const ov = await api.scanProject(path)
    setOverview(ov)
    setExistingResult(await api.loadResult(path))
    setGenError(null)
    setView('configure')
  }, [])

  /** 开始生成：进入生成页并调用主进程 */
  const startGenerate = useCallback((options: GenerateOptions) => {
    setGenOptions(options)
    setGenError(null)
    setGenLogs([])
    setGenProgress({ step: '准备中…', percent: 1, ts: Date.now() })
    setView('generating')
    api
      .generate(options)
      .then((r) => {
        setResult(r)
        setView('result')
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('取消')) {
          setView('configure')
          return
        }
        setGenError(msg)
      })
  }, [])

  const cancelGenerate = useCallback(() => {
    void api.cancelGenerate()
  }, [])

  const regenerate = useCallback(() => {
    if (!overview) {
      setView('select')
      return
    }
    setView('configure')
  }, [overview])

  const viewExisting = useCallback((r: InterviewResult) => {
    setResult(r)
    setView('result')
  }, [])

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
            <button
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
              onClick={() => setView('select')}
            >
              切换项目
            </button>
          )}
          <button
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            onClick={openSettings}
          >
            ⚙️ 设置
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {view === 'select' && (
          <SelectPage
            settings={settings}
            openProject={openProject}
            viewExisting={viewExisting}
            openSettings={openSettings}
          />
        )}
        {view === 'configure' && overview && (
          <ConfigurePage
            overview={overview}
            existingResult={existingResult}
            settings={settings}
            onStart={startGenerate}
            onViewExisting={viewExisting}
          />
        )}
        {view === 'generating' && (
          <GeneratingPage
            overview={overview}
            options={genOptions}
            progress={genProgress}
            logs={genLogs}
            error={genError}
            onCancel={cancelGenerate}
            onBack={() => setView('configure')}
          />
        )}
        {view === 'result' && result && (
          <ResultPage result={result} settings={settings} onRegenerate={regenerate} />
        )}
        {view === 'settings' && (
          <SettingsPage
            settings={settings}
            onSaved={(s) => {
              setSettings(s)
              refreshSettings()
            }}
            onBack={() => setView(prevView === 'settings' ? 'select' : prevView)}
          />
        )}
      </main>
    </div>
  )
}
