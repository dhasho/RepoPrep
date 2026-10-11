// IPC 通道名与桥接 API 契约（preload 暴露、渲染进程调用）
import type {
  ExplainEvent,
  ExplainRequest,
  GenerateRequest,
  GenerateProgress,
  GenerateResponse,
  InterviewResult,
  ListModelsResult,
  LlmProfile,
  ProjectOverview,
  RecentProject,
  Settings,
  TestConnectionResult
} from './types'
import type { StorageDiagnostic } from './storage-contract'

export const IPC = {
  selectFolder: 'dialog:selectFolder',
  scanProject: 'project:scan',
  recentProjects: 'project:recent',
  removeRecent: 'project:removeRecent',
  loadResult: 'result:load',
  deleteResult: 'result:delete',
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
  storageRecover: 'storage:recover'
} as const

/** preload 暴露到 window.api 的接口 */
export interface ProjectLensApi {
  selectFolder(): Promise<string | null>
  scanProject(path: string): Promise<ProjectOverview>
  getRecentProjects(): Promise<RecentProject[]>
  removeRecent(path: string): Promise<void>
  loadResult(projectPath: string): Promise<InterviewResult | null>
  deleteResult(projectPath: string): Promise<void>
  generate(request: GenerateRequest): Promise<GenerateResponse>
  cancelGenerate(runId: string): Promise<void>
  onGenerateProgress(cb: (p: GenerateProgress) => void): () => void
  explain(req: ExplainRequest): Promise<void>
  cancelExplain(requestId: string): Promise<void>
  onExplainEvent(cb: (e: ExplainEvent) => void): () => void
  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>
  testLlm(profile: LlmProfile): Promise<TestConnectionResult>
  listModels(profile: LlmProfile): Promise<ListModelsResult>
  exportMarkdown(result: InterviewResult): Promise<{ ok: boolean; path?: string; message: string }>
  getStorageDiagnostics(): Promise<StorageDiagnostic[]>
  recoverStorage(id: string): Promise<void>
}
