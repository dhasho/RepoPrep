import type { GenerateOptions, InterviewResult, Section } from './types'

/** Bump when generation prompts, quota planning or replay semantics change. */
export const GENERATION_CHECKPOINT_VERSION = 2 as const

export interface CheckpointBatch {
  projectSummary: string
  sections: Section[]
  glossary: Record<string, string>
}

export interface GenerationCheckpoint {
  version: 1 | 2
  fingerprint: string
  totalBatches: number
  entries: Array<{ key: string; batch: CheckpointBatch }>
  /** Validated, durable question prefix for the currently active request. */
  pending?: { key: string; batch: CheckpointBatch }
}

export interface GenerationDraftSummary extends GenerateOptions {
  id: string
  projectName: string
  modelLabel: string
  createdAt: string
  updatedAt: string
  completedBatches: number
  completedQuestions: number
  totalBatches: number
  ready: boolean
}

/** Main-process disk record; raw prompts, project sources and credentials are absent. */
export interface GenerationDraftRecord {
  version: 1
  summary: GenerationDraftSummary
  checkpoint: GenerationCheckpoint | null
  result?: InterviewResult
}

export const GENERATION_DRAFT_MESSAGES = {
  exists: '存在可恢复的生成任务，请继续或先丢弃该任务。',
  missing: '未找到此生成草稿，请重新打开项目。',
  changed: '项目上下文或模型配置已变化，无法继续原任务。请丢弃草稿后重新生成。',
  corrupt: '生成草稿损坏或版本不兼容，请丢弃后重新生成。',
  unreadable: '无法读取生成草稿，请检查应用数据目录权限。',
  save: '无法保存生成检查点，请检查磁盘空间和权限后重试。',
  discard: '无法丢弃生成草稿，请稍后重试。'
} as const
