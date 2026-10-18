export type SidebarMode = 'projects' | 'questions'

interface Props {
  mode: SidebarMode
  canShowQuestions: boolean
  onProjects: () => void
  onQuestions: () => void
  onSettings: () => void
}

const iconClass = 'h-5 w-5'

export default function NavigationRail({ mode, canShowQuestions, onProjects, onQuestions, onSettings }: Props) {
  return (
    <aside className="flex w-14 shrink-0 flex-col items-center border-r border-slate-200 bg-slate-50 py-3" aria-label="主导航">
      <nav className="flex w-full flex-col items-center gap-2" aria-label="目录切换">
        <button
          type="button"
          className={`flex h-10 w-10 items-center justify-center rounded-lg transition ${mode === 'projects' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-white hover:text-slate-800'}`}
          title="项目分析目录"
          aria-label="项目分析目录"
          aria-pressed={mode === 'projects'}
          onClick={onProjects}
        >
          <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
            <path d="M3.5 9h17" />
          </svg>
        </button>
        <button
          type="button"
          className={`flex h-10 w-10 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-35 ${mode === 'questions' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-white hover:text-slate-800'}`}
          title={canShowQuestions ? '最近分析的问题目录' : '先打开一份分析，才能查看问题目录'}
          aria-label="最近分析的问题目录"
          aria-pressed={mode === 'questions'}
          disabled={!canShowQuestions}
          onClick={onQuestions}
        >
          <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 6h12M8 12h12M8 18h12" />
            <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
          </svg>
        </button>
      </nav>

      <div className="mt-auto">
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white hover:text-slate-800"
          title="设置"
          aria-label="设置"
          onClick={onSettings}
        >
          <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2.8v2.1m0 14.2v2.1M21.2 12h-2.1M4.9 12H2.8m15.7-6.5L17 7m-10 10-1.5 1.5m14.5 0L18.5 17m-10-10L7 5.5" />
          </svg>
        </button>
      </div>
    </aside>
  )
}
