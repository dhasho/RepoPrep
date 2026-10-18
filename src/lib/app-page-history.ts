import type { GenerateOptions, InterviewResult, ProjectOverview } from '@shared/types'
import type { SidebarMode } from '../components/NavigationRail'
import type { GenerationTask } from './generation-session'
import type { NavigationHistory } from './navigation-history'

export type View = 'select' | 'configure' | 'generating' | 'generation-error' | 'result' | 'settings'

export interface GenerationFailureSnapshot {
  readonly runId: string
  readonly error: string
}

export interface AppPageSnapshot {
  readonly view: View
  readonly sidebarMode: SidebarMode
  readonly overview: ProjectOverview | null
  readonly projectStoragePath: string | null
  readonly existingResult: InterviewResult | null
  readonly result: InterviewResult | null
  readonly resultStoragePath: string | null
  readonly selectedAnalysisId: string | null
  readonly configureInitialOptions: GenerateOptions | undefined
  readonly configureNotice: string | null
  readonly configureRevision: number
  readonly foregroundRunId: string | null
  readonly generationFailure: GenerationFailureSnapshot | null
}

export function pageKey(page: AppPageSnapshot): string {
  if (page.view === 'configure') return `configure:${page.projectStoragePath ?? page.overview?.root ?? 'unknown'}`
  if (page.view === 'result') return `analysis:${page.resultStoragePath ?? page.result?.projectPath ?? 'unknown'}:${page.selectedAnalysisId ?? page.result?.createdAt ?? 'unknown'}`
  if (page.view === 'generating') return `generating:${page.foregroundRunId ?? 'unknown'}`
  if (page.view === 'generation-error') return `generation-error:${page.generationFailure?.runId ?? 'unknown'}`
  return page.view
}

/** Project a terminal run into a page that no longer depends on the recent-task cache. */
export function settleGenerationPage(page: AppPageSnapshot, task: GenerationTask): AppPageSnapshot {
  if (page.view !== 'generating' || page.foregroundRunId !== task.runId) return page
  if (task.status === 'running' || task.status === 'cancelling') return page
  const overview = page.overview ?? (task.overview as ProjectOverview)
  const configureInitialOptions = { ...task.options }
  if (task.status === 'succeeded' && task.result) {
    const path = task.resultStoragePath ?? task.options.projectPath
    return {
      ...page, view: 'result', sidebarMode: 'questions', overview,
      projectStoragePath: path, existingResult: task.result, result: task.result,
      resultStoragePath: path, selectedAnalysisId: task.analysisId ?? null,
      configureInitialOptions, configureNotice: null, foregroundRunId: null, generationFailure: null
    }
  }
  if (task.status === 'cancelled') {
    return {
      ...page, view: 'configure', sidebarMode: 'projects', overview,
      projectStoragePath: task.options.projectPath,
      existingResult: task.existingResult as InterviewResult | null,
      configureInitialOptions, configureNotice: null, configureRevision: page.configureRevision + 1,
      foregroundRunId: null, generationFailure: null
    }
  }
  if (task.status === 'failed') {
    return {
      ...page, view: 'generation-error', sidebarMode: 'projects', overview,
      projectStoragePath: task.options.projectPath,
      existingResult: task.existingResult as InterviewResult | null,
      configureInitialOptions, configureNotice: null, foregroundRunId: null,
      generationFailure: { runId: task.runId, error: task.error || '生成失败，请重试。' }
    }
  }
  return page
}

/** Preserve cursor and forward history; terminal payloads share existing data references. */
export function settleGenerationHistory(
  history: NavigationHistory<AppPageSnapshot>,
  tasks: readonly GenerationTask[]
): NavigationHistory<AppPageSnapshot> {
  const byRunId = new Map(tasks.map((task) => [task.runId, task]))
  let changed = false
  const entries = history.entries.map((entry) => {
    const task = entry.value.foregroundRunId ? byRunId.get(entry.value.foregroundRunId) : undefined
    const page = task ? settleGenerationPage(entry.value, task) : entry.value
    if (page === entry.value) return entry
    changed = true
    return { key: pageKey(page), value: page }
  })
  return changed ? { ...history, entries } : history
}
