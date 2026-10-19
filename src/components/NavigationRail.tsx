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
    <aside className="flex w-12 shrink-0 flex-col items-center border-r border-slate-200 bg-slate-50 py-3" aria-label="主导航">
      <nav className="flex w-full flex-col items-center gap-2" aria-label="目录切换">
        <button
          type="button"
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${mode === 'projects' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-white hover:text-slate-800'}`}
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
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-35 ${mode === 'questions' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-white hover:text-slate-800'}`}
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
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white hover:text-slate-800"
          title="设置"
          aria-label="设置"
          onClick={onSettings}
        >
          <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18.8 13.5a7.8 7.8 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L13.8 3h-3.6l-.3 2.4a7.6 7.6 0 0 0-2.6 1.5l-2-.8-1.8 3.1 1.7 1.3a7.8 7.8 0 0 0 0 3l-1.7 1.3 1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.3 2.4h3.6l.3-2.4a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </aside>
  )
}
