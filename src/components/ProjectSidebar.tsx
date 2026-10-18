import type { AnalysisSummary } from '@shared/types'
import { GRANULARITY_META, ROLE_META } from '@shared/types'
import type { ProjectLibraryEntry } from '../hooks/useProjectLibrary'

interface Props {
  projects: ProjectLibraryEntry[]
  loading: boolean
  error: string | null
  selectedProjectPath: string | null
  selectedAnalysisId: string | null
  onNew: () => void
  onSelectProject: (path: string) => void
  onSelectAnalysis: (path: string, analysis: AnalysisSummary) => void
  onToggleProject: (path: string) => void
  onLoadMore: (path: string, cursor: string) => void
  onRemove: (path: string) => void
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

export default function ProjectSidebar({ projects, loading, error, selectedProjectPath, selectedAnalysisId, onNew, onSelectProject, onSelectAnalysis, onToggleProject, onLoadMore, onRemove }: Props) {
  return (
    <aside className="project-library-sidebar sidebar-enter flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white" aria-label="项目">
      <div className="border-b border-slate-200 p-3">
        <button aria-label="新建分析" className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100" onClick={onNew}>
          <span aria-hidden="true" className="text-lg leading-none text-indigo-600">＋</span>
          <span>新建</span>
        </button>
      </div>
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">所有项目</h2>
        {loading && <span className="text-[11px] text-slate-400">读取中</span>}
      </div>
      {error && <p className="px-4 pb-2 text-xs text-amber-700" role="status">{error}</p>}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="所有项目">
        {projects.map((project) => (
          <div key={project.path} className="mb-1">
            <div className={`group flex items-center rounded-lg ${selectedProjectPath === project.path ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
              <button
                className="min-w-0 flex-1 px-2 py-2 text-left"
                title={project.path}
                data-project-path={project.path}
                onClick={() => onSelectProject(project.path)}
              >
                <span className={`block truncate text-sm font-medium ${selectedProjectPath === project.path ? 'text-indigo-700' : 'text-slate-700'}`}>{project.name}</span>
              </button>
              <button
                className="mr-1 rounded p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
                aria-label={`${project.expanded ? '收起' : '展开'} ${project.name} 的分析`}
                aria-expanded={project.expanded}
                onClick={() => onToggleProject(project.path)}
              >
                <span aria-hidden="true">{project.expanded ? '⌄' : '›'}</span>
              </button>
              <button
                className="mr-1 invisible rounded p-1 text-[10px] text-slate-400 hover:bg-white hover:text-rose-600 group-hover:visible group-focus-within:visible"
                title="从最近项目移除"
                aria-label={`移除 ${project.name}`}
                onClick={() => onRemove(project.path)}
              >×</button>
            </div>
            {project.expanded && (
              <div className="ml-3 border-l border-slate-200 pl-2">
                {project.loading && <div className="px-2 py-2 text-xs text-slate-400">读取分析记录…</div>}
                {project.error && <div className="px-2 py-2 text-xs text-amber-700" role="status">{project.error}</div>}
                {!project.loading && !project.error && project.analyses.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">暂无分析</div>}
                {project.analyses.map((analysis) => (
                  <AnalysisRow key={analysis.id} analysis={analysis} active={analysis.id === selectedAnalysisId} onClick={() => onSelectAnalysis(project.path, analysis)} />
                ))}
                {project.nextCursor && !project.loading && (
                  <button className="px-2 py-1.5 text-xs text-indigo-600 hover:text-indigo-800" onClick={() => onLoadMore(project.path, project.nextCursor!)}>加载更多</button>
                )}
              </div>
            )}
          </div>
        ))}
        {!loading && !error && projects.length === 0 && <p className="px-3 py-4 text-xs text-slate-400">暂无项目</p>}
      </nav>
    </aside>
  )
}

function AnalysisRow({ analysis, active, onClick }: { analysis: AnalysisSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${active ? 'bg-indigo-100 text-indigo-800' : 'text-slate-600 hover:bg-slate-100'}`}
      data-analysis-id={analysis.id}
      title={`${new Date(analysis.createdAt).toLocaleString('zh-CN')} · ${GRANULARITY_META[analysis.granularity].label} · ${ROLE_META[analysis.roleFocus].label}方向`}
      onClick={onClick}
    >
      <span className="truncate">{formatDate(analysis.createdAt)}</span>
      <span className="shrink-0 text-[10px] text-slate-400">{GRANULARITY_META[analysis.granularity].label}</span>
    </button>
  )
}
