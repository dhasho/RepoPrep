// 首页：选择项目文件夹 + 最近项目
import { useEffect, useState } from 'react'
import type { InterviewResult, RecentProject, Settings } from '@shared/types'
import { GRANULARITY_META } from '@shared/types'
import { api } from '../lib/ipc'

interface Props {
  settings: Settings
  openProject: (path: string) => Promise<void>
  viewExisting: (result: InterviewResult, sourceRecentPath: string) => void
  openSettings: () => void
}

export default function SelectPage({ settings, openProject, viewExisting, openSettings }: Props) {
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [results, setResults] = useState<Record<string, InterviewResult | null>>({})
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getRecentProjects().then(async (list) => {
      setRecent(list)
      const entries = await Promise.all(
        list.map(async (p) => [p.path, await api.loadResult(p.path)] as const)
      )
      setResults(Object.fromEntries(entries))
    })
  }, [])

  const open = async (path: string) => {
    setError('')
    setOpening(path)
    try {
      await openProject(path)
    } catch (e) {
      setError(`打开项目失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setOpening(null)
    }
  }

  const chooseFolder = async () => {
    // 防重入：对话框弹出前的窗口期内重复点击不应触发多次
    if (opening) return
    setError('')
    setOpening('dialog')
    try {
      const path = await api.selectFolder()
      if (path) await open(path)
    } catch (e) {
      setError(`打开项目失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setOpening(null)
    }
  }

  const removeRecent = async (path: string) => {
    await api.removeRecent(path)
    setRecent((l) => l.filter((p) => p.path !== path))
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6 py-10">
      <div className="mb-2 text-5xl">🔭</div>
      <h1 className="text-2xl font-bold text-slate-900">ProjectLens</h1>
      <p className="mt-2 max-w-md text-center text-sm leading-6 text-slate-500">
        选择你的项目，AI 面试官将通读代码与文档，生成「问题 + 参考答案 + 追问」
        的面试准备材料。答案中的专业名词带下划线，点击即可查看解释，还能让 AI 继续深挖。
      </p>

      {settings.profiles.length === 0 && (
        <div className="mt-6 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          <span>尚未配置大模型，先完成配置才能生成面试题。</span>
          <button className="font-medium underline" onClick={openSettings}>
            前往设置 →
          </button>
        </div>
      )}

      <button
        className="mt-8 flex items-center gap-2 rounded-xl bg-indigo-600 px-8 py-3.5 text-[15px] font-medium text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
        onClick={chooseFolder}
        disabled={opening === 'dialog'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        选择项目文件夹
      </button>

      {error && <p className="mt-4 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</p>}

      {recent.length > 0 && (
        <div className="mt-10 w-full">
          <h2 className="mb-3 text-sm font-medium text-slate-500">最近项目</h2>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {recent.map((p, i) => {
              const r = results[p.path]
              return (
                <div
                  key={p.path}
                  className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-slate-100' : ''}`}
                >
                  <span className="text-lg">📁</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-800">{p.name}</span>
                      {r && (
                        <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-600">
                          已生成 · {GRANULARITY_META[r.granularity].label}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-400" title={p.path}>
                      {p.path}
                    </div>
                  </div>
                  {r && (
                    <button
                      className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                      onClick={() => viewExisting(r, p.path)}
                    >
                      查看结果
                    </button>
                  )}
                  <button
                    className="shrink-0 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
                    disabled={opening === p.path}
                    onClick={() => open(p.path)}
                  >
                    {opening === p.path ? '打开中…' : '重新分析'}
                  </button>
                  <button
                    className="shrink-0 rounded p-1.5 text-slate-300 hover:bg-slate-50 hover:text-slate-500"
                    title="从最近列表移除"
                    onClick={() => removeRecent(p.path)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
