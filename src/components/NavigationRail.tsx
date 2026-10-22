import { AppIcon } from './AppIcon'

export type SidebarMode = 'projects' | 'questions'

interface Props {
  mode: SidebarMode
  canShowQuestions: boolean
  onProjects: () => void
  onQuestions: () => void
  onSettings: () => void
}

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
          <AppIcon name="folder" size={20} />
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
          <AppIcon name="list" size={20} />
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
          <AppIcon name="settings" size={20} />
        </button>
      </div>
    </aside>
  )
}
