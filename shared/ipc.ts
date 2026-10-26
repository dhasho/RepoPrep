// IPC 通道名与桥接 API 契约（preload 暴露、渲染进程调用）
import type {
  AnalysisPage,
  ExplainEvent,
  ExplainRequest,
  GenerateRequest,
  GenerateProgress,
  GenerateResponse,
  InterviewResult,
  ListModelsResult,
  LlmProfile,
  LlmProfileDraft,
  PublicSettings,
  ProjectOverview,
  RecentProject,
  Settings,
  TestConnectionResult
} from './types'
import type { GenerationDraftSummary } from './generation-checkpoint'
import type { StorageDiagnostic } from './storage-contract'

export const IPC = {
  selectFolder: 'dialog:selectFolder',
  scanProject: 'project:scan',
  recentProjects: 'project:recent',
  removeRecent: 'project:removeRecent',
  loadResult: 'result:load',
  deleteResult: 'result:delete',
  listAnalyses: 'analysis:list',
  loadAnalysis: 'analysis:load',
  generateRun: 'generate:run',
  generateCancel: 'generate:cancel',
  generateProgress: 'generate:progress', // 主进程 -> 渲染进程 事件
  explainStart: 'explain:start',
  explainCancel: 'explain:cancel',
  explainEvent: 'explain:event', // 主进程 -> 渲染进程 事件
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  llmTest: 'llm:test',
  llmListModels: 'llm:listModels',
  exportMarkdown: 'export:markdown',
  storageDiagnostics: 'storage:diagnostics',
  storageRecover: 'storage:recover',
  generationDraftGet: 'generation:draft:get',
  generationDraftDiscard: 'generation:draft:discard'
} as const

/** preload 暴露到 window.api 的接口 */
export interface ProjectLensApi {
  selectFolder(): Promise<string | null>
  scanProject(path: string): Promise<ProjectOverview>
  getRecentProjects(): Promise<RecentProject[]>
  removeRecent(path: string): Promise<void>
  loadResult(projectPath: string): Promise<InterviewResult | null>
  deleteResult(projectPath: string): Promise<void>
  listAnalyses(projectPath: string, cursor?: string): Promise<AnalysisPage>
  loadAnalysis(projectPath: string, analysisId: string): Promise<InterviewResult | null>
  generate(request: GenerateRequest): Promise<GenerateResponse>
  cancelGenerate(runId: string): Promise<void>
  onGenerateProgress(cb: (p: GenerateProgress) => void): () => void
  explain(req: ExplainRequest): Promise<void>
  cancelExplain(requestId: string): Promise<void>
  onExplainEvent(cb: (e: ExplainEvent) => void): () => void
  getSettings(): Promise<PublicSettings>
  saveSettings(settings: import('./types').SettingsSaveRequest): Promise<void>
  testLlm(profile: LlmProfileDraft): Promise<TestConnectionResult>
  listModels(profile: LlmProfileDraft): Promise<ListModelsResult>
  exportMarkdown(result: InterviewResult): Promise<{ ok: boolean; path?: string; message: string }>
  getStorageDiagnostics(): Promise<StorageDiagnostic[]>
  recoverStorage(id: string): Promise<void>
  getGenerationDraft(projectPath: string): Promise<GenerationDraftSummary | null>
  discardGenerationDraft(projectPath: string, draftId: string): Promise<void>
}
