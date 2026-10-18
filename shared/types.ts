// 主进程与渲染进程共享的类型定义

export type Granularity = 'coarse' | 'medium' | 'fine'
export type RoleFocus = 'general' | 'frontend' | 'backend' | 'algorithm'
export type LlmProtocol = 'openai' | 'anthropic'

/** 大模型配置；缺少 protocol 的旧配置按 OpenAI Chat Completions 处理。 */
export interface LlmProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  protocol?: LlmProtocol
  temperature?: number
}

export interface Settings {
  profiles: LlmProfile[]
  defaultProfileId: string | null
  /** 扫描安全上限（高级设置）；缺省字段使用内置默认值 */
  scanLimits?: Partial<ScanLimits>
}

export interface PublicLlmProfile extends Omit<LlmProfile, 'apiKey'> {
  hasApiKey: boolean
  credentialStatus: 'missing' | 'stored' | 'locked' | 'migration-pending'
}

export interface LlmProfileDraft extends Omit<PublicLlmProfile, 'hasApiKey' | 'credentialStatus'> {
  /** New key supplied for replacement, present only in this renderer draft/request. */
  apiKey?: string
  hasApiKey?: boolean
  credentialStatus?: 'missing' | 'stored' | 'locked' | 'migration-pending'
  useSavedCredential?: boolean
  credentialAction?: 'keep' | 'replace' | 'clear'
}

export interface PublicSettings extends Omit<Settings, 'profiles'> {
  profiles: PublicLlmProfile[]
}

/** Persisted secrets remain main-process-only; these request contracts carry user intent. */
export interface SettingsSaveRequest extends Omit<Settings, 'profiles'> { profiles: LlmProfileDraft[] }

/** 扫描安全上限的合法区间（设置校验与扫描器夹取共用同一份） */
export const SCAN_LIMIT_BOUNDS = {
  maxFiles: { min: 1, max: 250_000 },
  maxTreeNodes: { min: 1, max: 500_000 },
  maxContentFileBytes: { min: 1024, max: 8 * 1024 * 1024 }
} as const

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFiles: 50_000,
  maxTreeNodes: 100_000,
  maxContentFileBytes: 1024 * 1024
}

export interface TestConnectionResult {
  ok: boolean
  message: string
}

/** GET /models 的检测结果 */
export interface ListModelsResult {
  ok: boolean
  models: string[]
  message: string
}

/** 文件树节点 */
export interface FileNode {
  name: string
  path: string // 相对项目根目录
  type: 'file' | 'dir'
  /** The node is excluded from model-visible tree output by the scanner policy. */
  modelExcluded?: boolean
  size?: number
  children?: FileNode[]
}

export interface LanguageStat {
  lang: string
  files: number
  percent: number
}

export interface KeyFileInfo {
  path: string
  reason: string
}

export interface SecurityProtectionSummary {
  excludedFiles: number
  redactedFiles: number
  redactionMatches: number
  categories: Record<string, number>
}

export interface ProjectOverview {
  root: string
  /** Exact path key used by the main process for recent/result persistence. */
  storagePath?: string
  name: string
  totalFiles: number
  totalBytes: number
  languages: LanguageStat[]
  tree: FileNode
  keyFiles: KeyFileInfo[]
  security: SecurityProtectionSummary
  /** 触发任一扫描安全上限时才有值；界面与模型提示据此说明"分析不完整" */
  truncation?: ScanTruncation
}

/** 扫描安全上限（可在设置的"高级设置"中调整，主进程会再做夹取） */
export interface ScanLimits {
  /** 最多纳入扫描的文件数（口径与 totalFiles 一致，不含二进制文件） */
  maxFiles: number
  /** 最多记录的树节点数（文件 + 目录） */
  maxTreeNodes: number
  /** 纳入模型阅读的单文件大小上限（字节） */
  maxContentFileBytes: number
}

export interface ScanTruncation {
  /** 触发文件数上限 */
  byFileCount: boolean
  /** 触发树节点上限 */
  byTreeNodes: boolean
  /** 因超过单文件大小上限而未纳入内容阅读的文件数 */
  oversizedFiles: number
  /** 触发数量上限时在断点处统计到的未处理条目数（下界估计，不含更深层目录内部） */
  estimatedSkipped: number
  /** 本次扫描实际生效的上限（便于提示里展示） */
  limits: ScanLimits
}

/** 追问（支持嵌套） */
export interface FollowUp {
  question: string
  answer: string
  followUps?: FollowUp[]
}

export interface QuestionItem {
  id: string
  question: string
  answer: string // Markdown，专业名词用 [[名词]] 标记
  followUps: FollowUp[]
  /** Legacy version-1 history field; new generation results do not create or display it. */
  sourceEvidence?: SourceEvidence[]
}

export interface SourceEvidence {
  sourceId: string
  snapshotHash: string
  path: string
  startLine: number
  endLine: number
  excerpt: string
}

export interface SourceEvidenceSummary {
  /** Count of refs normalized from valid model question objects across all replies. */
  asked: number
  /** Refs whose ids and ranges passed validation against their request manifest. */
  accepted: number
  rejected: number
  /** Accepted refs still attached after question and total excerpt budgets are applied. */
  retained?: number
}

export interface Section {
  id: string
  title: string
  summary?: string
  questions: QuestionItem[]
}

export interface InterviewResult {
  version: number
  createdAt: string
  projectName: string
  projectPath: string
  granularity: Granularity
  roleFocus: RoleFocus
  profileId: string // 生成时使用的模型配置（供名词解释复用）
  modelUsed: string
  projectSummary: string
  sections: Section[]
  glossary: Record<string, string>
  security?: SecurityProtectionSummary
  /** Present only when part of the scanned model context was omitted. */
  contextTruncation?: ContextTruncationMetadata
  /** Present only when one or more candidate files could not be read. */
  contentReadSummary?: import('./content-read').ContentReadSummary
  /** Legacy version-1 history field retained so old results continue to validate. */
  sourceEvidenceSummary?: SourceEvidenceSummary
}

/** Compact metadata shown in a project's saved analysis history. */
export interface AnalysisSummary {
  id: string
  createdAt: string
  granularity: Granularity
  roleFocus: RoleFocus
}

export interface AnalysisPage {
  items: AnalysisSummary[]
  nextCursor: string | null
}

export interface ContextTruncationMetadata {
  treeTruncated: boolean
  contentTruncated: boolean
  requestTruncated: boolean
}

export interface RecentProject {
  path: string
  name: string
  lastUsedAt: string
  granularity?: Granularity
}

export interface GenerateProgress {
  step: string
  detail?: string
  percent: number // 0-100
  /** 产生该进度的生成任务 runId（渲染进程创建；用于隔离不同任务的进度，issue #21） */
  runId: string
  /** 事件产生的时刻（epoch 毫秒）。由主进程发送时写入，渲染层只读它，避免历史日志时间漂移 */
  ts: number
}

export interface GenerateOptions {
  projectPath: string
  granularity: Granularity
  roleFocus: RoleFocus
  profileId: string
}

/** 一次生成请求的会话标识；runId 由渲染进程为每次尝试创建。 */
export interface GenerateRequest extends GenerateOptions {
  runId: string
}

/** 生成响应封套；result 保持原有持久化格式与类型。 */
export interface GenerateResponse {
  runId: string
  result: InterviewResult
  /** Exact path key used by the main process for recent/result persistence. */
  storagePath?: string
  /** Stable identifier for the saved analysis represented by result. */
  analysisId?: string
}

export interface ExplainRequest {
  requestId: string
  term: string
  profileId: string
  projectSummary: string
  question: string
  snippet: string // 术语所在答案片段（已去除 [[ ]] 标记）
  glossaryHint?: string
}

export type ExplainEvent =
  | { requestId: string; type: 'delta'; data: string }
  | { requestId: string; type: 'done'; data: string }
  | { requestId: string; type: 'error'; data: string }

export interface GenerateRunError {
  name: string
  message: string
}

/**
 * 各颗粒度的题量预算。这是题量的**单一事实来源**：
 * 界面文案（GRANULARITY_META.count 由它生成）、生成时的配额规划（question-budget.ts）
 * 都以它为准，避免出现「承诺 25–40 题、实际出 70 题」这类不一致。
 */
export const GRANULARITY_QUESTION_BUDGET: Record<
  Granularity,
  { min: number; target: number; max: number }
> = {
  coarse: { min: 8, target: 10, max: 12 },
  medium: { min: 15, target: 20, max: 25 },
  fine: { min: 25, target: 32, max: 40 }
}

/** 由预算生成界面文案，例如「约 25–40 题」 */
export function questionCountLabel(granularity: Granularity): string {
  const { min, max } = GRANULARITY_QUESTION_BUDGET[granularity]
  return `约 ${min}–${max} 题`
}

export const GRANULARITY_META: Record<
  Granularity,
  { label: string; sub: string; desc: string; count: string; note: string }
> = {
  coarse: {
    label: '粗粒度',
    sub: '架构级',
    desc: '整体架构、技术选型、模块职责与设计权衡，不深入代码细节',
    count: questionCountLabel('coarse'),
    note: '仅分析文件树、README 与配置文件，速度最快'
  },
  medium: {
    label: '中粒度',
    sub: '模块级',
    desc: '模块功能实现、数据流转、接口设计与模块间协作',
    count: questionCountLabel('medium'),
    note: '附带核心源码一起分析'
  },
  fine: {
    label: '细粒度',
    sub: '实现级',
    desc: '函数实现细节、算法与数据结构、边界处理、性能与错误处理',
    count: questionCountLabel('fine'),
    note: '按模块分批多次调用大模型，耗时较长、消耗 Token 较多'
  }
}

export const ROLE_META: Record<RoleFocus, { label: string; prompt: string }> = {
  general: {
    label: '通用',
    prompt: '不限定方向，从整体工程能力角度全面考察。'
  },
  frontend: {
    label: '前端',
    prompt: '侧重前端视角：界面架构、状态管理、渲染性能、组件设计、工程化与构建。'
  },
  backend: {
    label: '后端',
    prompt: '侧重后端视角：服务架构、数据存储与一致性、并发与吞吐、安全、可用性与性能。'
  },
  algorithm: {
    label: '算法',
    prompt: '侧重算法视角：核心算法与数据结构选型、时间空间复杂度、优化思路与工程折中。'
  }
}

/** 把 [[名词]] 标记去除，保留纯文本（用于搜索、导出、AI 解释上下文） */
export function stripTermMarks(text: string): string {
  return text.replace(/\[\[([^\[\]]+)\]\]/g, '$1')
}

/** 提取文本中所有被标记的名词（按出现顺序去重） */
export function extractTerms(text: string): string[] {
  const out: string[] = []
  const re = /\[\[([^\[\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}
