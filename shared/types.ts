// 主进程与渲染进程共享的类型定义

export type Granularity = 'coarse' | 'medium' | 'fine'
export type RoleFocus = 'general' | 'frontend' | 'backend' | 'algorithm'

/** 大模型配置（OpenAI 兼容接口） */
export interface LlmProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
}

export interface Settings {
  profiles: LlmProfile[]
  defaultProfileId: string | null
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
  name: string
  totalFiles: number
  totalBytes: number
  languages: LanguageStat[]
  tree: FileNode
  keyFiles: KeyFileInfo[]
  security: SecurityProtectionSummary
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
}

export interface GenerateOptions {
  projectPath: string
  granularity: Granularity
  roleFocus: RoleFocus
  profileId: string
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
