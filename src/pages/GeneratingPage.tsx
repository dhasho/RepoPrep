// 生成中页：进度条 + 步骤日志 + 取消
import { useEffect, useRef } from 'react'
import type { GenerateOptions, GenerateProgress, ProjectOverview } from '@shared/types'
import { GRANULARITY_META, ROLE_META } from '@shared/types'
import { formatLogTime } from '../lib/log-time'
import { AppIcon } from '../components/AppIcon'

interface Props {
  overview: ProjectOverview | null
  options: GenerateOptions | null
  progress: GenerateProgress | null
  logs: readonly GenerateProgress[]
  error: string | null
  cancelling?: boolean
  onCancel: () => void
  onBack: () => void
}

export default function GeneratingPage({ overview, options, progress, logs, error, cancelling = false, onCancel, onBack }: Props) {
  const logEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  const percent = Math.min(100, Math.max(0, progress?.percent ?? 0))

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col justify-center px-6 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        {error ? (
          <>
            <div className="mb-3 flex justify-center text-rose-600"><AppIcon name="error" size={36} /></div>
            <h1 className="text-lg font-semibold text-slate-900">生成失败</h1>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-rose-50 px-4 py-3 text-[13px] leading-6 text-rose-700">
              {error}
            </pre>
            <p className="mt-3 text-xs leading-5 text-slate-500">已校验保存的完整题目可在返回配置后继续；尚未完整接收的题目会重新生成。</p>
            <div className="mt-5 flex gap-3">
              <button
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                onClick={onBack}
              >
                <AppIcon name="arrow-left" size={16} className="mr-1" />返回调整配置并重试
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <AppIcon name="loader" size={16} className="animate-spin text-indigo-600" />
              <div>
                <h1 className="text-lg font-semibold text-slate-900">
                  {overview ? `正在为「${overview.name}」生成面试题` : '正在生成面试题'}
                </h1>
                {options && (
                  <p className="mt-0.5 text-xs text-slate-400">
                    {GRANULARITY_META[options.granularity].label} · {ROLE_META[options.roleFocus].label}方向 ·
                    生成中请保持网络畅通
                  </p>
                )}
              </div>
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="font-medium text-slate-700">{progress?.step ?? '准备中…'}</span>
              <span className="text-slate-400">{percent}%</span>
            </div>
            {progress?.detail && <p className="mt-1 truncate text-xs text-slate-400">{progress.detail}</p>}

            <div className="mt-5 max-h-44 overflow-y-auto rounded-lg bg-slate-50 p-3">
              {logs.map((l, i) => (
                <div key={i} className="flex gap-2 py-0.5 text-xs text-slate-500">
                  <span className="shrink-0 text-slate-400">
                    {formatLogTime(l.ts)}
                  </span>
                  <span className="shrink-0 font-medium text-slate-600">{l.step}</span>
                  {l.detail && <span className="min-w-0 truncate">{l.detail}</span>}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            <div className="mt-6 text-center">
              <button
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-500 hover:bg-slate-50"
                onClick={onCancel}
                disabled={cancelling}
              >
                {cancelling ? '正在取消…' : '取消生成'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
