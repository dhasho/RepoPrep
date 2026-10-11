export type ContentReadFailureReason = 'permission' | 'missing' | 'io'

export interface ContentReadFailure {
  path: string
  reason: ContentReadFailureReason
}

export interface ContentReadSummary {
  attemptedReads: number
  successfulReads: number
  failedReads: number
  failuresByReason: Record<ContentReadFailureReason, number>
  failures: ContentReadFailure[]
}

export const CONTENT_READ_LIMITS = { attempts: 100_000, samples: 50, path: 2048 } as const

export const CONTENT_READ_MESSAGES = {
  allFailed: '没有可读取的候选文件，无法分析项目内容。请检查文件权限后重新扫描。'
} as const

const WARNING_SAMPLE_LIMIT = 5
const WARNING_PATH_LENGTH_LIMIT = 160

export function emptyContentReadSummary(): ContentReadSummary {
  return {
    attemptedReads: 0,
    successfulReads: 0,
    failedReads: 0,
    failuresByReason: { permission: 0, missing: 0, io: 0 },
    failures: []
  }
}

export function contentReadFailureReason(error: unknown): ContentReadFailureReason {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (code === 'EACCES' || code === 'EPERM') return 'permission'
    if (code === 'ENOENT') return 'missing'
  }
  return 'io'
}

export function isSafeContentReadPath(value: string): boolean {
  if (
    !value ||
    value.length > CONTENT_READ_LIMITS.path ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes('\\')
  ) return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export function recordContentReadFailure(
  summary: ContentReadSummary,
  path: string,
  reason: ContentReadFailureReason
): void {
  summary.failedReads++
  summary.failuresByReason[reason]++
  if (summary.failures.length < CONTENT_READ_LIMITS.samples && isSafeContentReadPath(path)) {
    summary.failures.push({ path, reason })
  }
}

export function contentReadWarning(summary: ContentReadSummary): string {
  if (summary.failedReads === 0) return ''
  const reasonLabels = {
    permission: '权限不足',
    missing: '文件不存在',
    io: '读取异常'
  } as const
  const reasons = (['permission', 'missing', 'io'] as const)
    .filter((reason) => summary.failuresByReason[reason] > 0)
    .map((reason) => `${reasonLabels[reason]} ${summary.failuresByReason[reason]} 次`)
  const paths = summary.failures.slice(0, WARNING_SAMPLE_LIMIT).map((failure) => {
    const quotedPath = JSON.stringify(failure.path)
    if (quotedPath.length <= WARNING_PATH_LENGTH_LIMIT) {
      return `${quotedPath}（${reasonLabels[failure.reason]}）`
    }

    const segments = Array.from(failure.path)
    let edgeLength = 38
    let shortenedPath = `${segments.slice(0, edgeLength).join('')}…${segments.slice(-edgeLength).join('')}`
    while (JSON.stringify(shortenedPath).length > WARNING_PATH_LENGTH_LIMIT && edgeLength > 0) {
      edgeLength--
      shortenedPath = `${segments.slice(0, edgeLength).join('')}…${segments.slice(-edgeLength).join('')}`
    }
    return `${JSON.stringify(shortenedPath)}（${reasonLabels[failure.reason]}）`
  })
  const omitted = summary.failedReads - paths.length
  const sampleText = paths.length
    ? `失败路径样本：${paths.join('、')}${omitted > 0 ? `；另有 ${omitted} 次读取失败未列出` : ''}。`
    : `失败路径样本无法安全显示；另有 ${summary.failedReads} 次读取失败未列出。`
  return `⚠️ 内容读取不完整：尝试读取 ${summary.attemptedReads} 次，成功 ${summary.successfulReads} 次，失败 ${summary.failedReads} 次（${reasons.join('、')}）。${sampleText}`
}
