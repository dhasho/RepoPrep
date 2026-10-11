export type StorageKind = 'settings' | 'recent' | 'result'
export type StorageProblem = 'corrupt' | 'unreadable' | 'missing'

export interface StorageDiagnostic {
  id: string
  kind: StorageKind
  problem: StorageProblem
  usingBackup: boolean
  canRecover: boolean
  projectPath?: string
}

export const STORAGE_MESSAGES = {
  corruptResult: '历史结果文件已损坏，原文件已保留。可恢复备份或重新生成。',
  unreadableResult: '历史结果暂时无法读取，请检查权限后重试。',
  saveResult: '保存结果失败，请检查磁盘空间或权限后重试。',
  deleteResult: '删除历史结果未完成，部分文件可能仍存在。请检查权限后重试。',
  restoreFailed: '恢复失败，请重试；原文件和备份已保留。',
  noBackup: '未找到可恢复的完整备份。'
} as const

const RESULT_ID_PATTERN = /^result:[0-9a-f]{40}$/

export function isStorageDiagnosticId(value: unknown): value is string {
  return value === 'settings' || value === 'recent' || (typeof value === 'string' && RESULT_ID_PATTERN.test(value))
}
