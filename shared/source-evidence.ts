import type { SourceEvidence } from './types'
// @ts-ignore TS5097 -- extension is required by CJS-based Node test harnesses.
import { isSafeContentReadPath, SOURCE_EVIDENCE_LIMITS } from './content-read.ts'

export interface SourceManifestEntry {
  sourceId: string
  snapshotHash: string
  path: string
  content: string
  citableLineCount: number
}

export interface SourceRefResolution {
  evidence: SourceEvidence[]
  asked: number
  accepted: number
  rejected: number
  usedChars: number
}

function safeRelativePath(value: string): boolean {
  return value.length <= SOURCE_EVIDENCE_LIMITS.pathChars && isSafeContentReadPath(value)
}

function linesOf(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/)
  if (/(?:\r\n|\n|\r)$/.test(content)) lines.pop()
  return lines
}

/** Resolve untrusted model refs exclusively against the exact request manifest. */
export function resolveSourceRefs(
  raw: unknown,
  manifest: readonly SourceManifestEntry[],
  remainingChars: number = SOURCE_EVIDENCE_LIMITS.totalExcerptChars
): SourceRefResolution {
  if (raw === undefined) return { evidence: [], asked: 0, accepted: 0, rejected: 0, usedChars: 0 }
  if (!Array.isArray(raw)) return { evidence: [], asked: 1, accepted: 0, rejected: 1, usedChars: 0 }
  const refs = raw
  const accepted: SourceEvidence[] = []
  const asked = refs.length
  let rejected = Math.max(0, refs.length - SOURCE_EVIDENCE_LIMITS.perQuestion)
  let usedChars = 0
  const allowed = new Map(manifest.map((entry) => [entry.sourceId, entry]))
  for (const value of refs.slice(0, SOURCE_EVIDENCE_LIMITS.perQuestion)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { rejected++; continue }
    const ref = value as Record<string, unknown>
    if (Object.keys(ref).some((key) => !['sourceId', 'startLine', 'endLine'].includes(key))) { rejected++; continue }
    const entry = typeof ref.sourceId === 'string' ? allowed.get(ref.sourceId) : undefined
    const { startLine, endLine } = ref
    if (!entry || !safeRelativePath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.snapshotHash) ||
      !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      (startLine as number) < 1 || (endLine as number) < (startLine as number) ||
      (endLine as number) - (startLine as number) + 1 > SOURCE_EVIDENCE_LIMITS.linesPerReference ||
      (endLine as number) > entry.citableLineCount) {
      rejected++
      continue
    }
    const excerpt = linesOf(entry.content).slice((startLine as number) - 1, endLine as number).join('\n')
    if (!excerpt || excerpt.length > SOURCE_EVIDENCE_LIMITS.excerptCharsPerReference || usedChars + excerpt.length > remainingChars) {
      rejected++
      continue
    }
    // Clone every object per use: the result contract rejects shared references.
    accepted.push({
      sourceId: entry.sourceId,
      snapshotHash: entry.snapshotHash,
      path: entry.path,
      startLine: startLine as number,
      endLine: endLine as number,
      excerpt
    })
    usedChars += excerpt.length
  }
  return { evidence: accepted, asked, accepted: accepted.length, rejected, usedChars }
}
