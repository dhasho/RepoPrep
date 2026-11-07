import type { SourceAnalysis } from '../source-analysis'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import type { LlmModelFailure } from '../llm.ts'

export type WorkflowFailureCode = 'invalid-argument' | 'permission-denied' | 'stale-snapshot' | 'unreadable' | 'cancelled' | 'budget-exhausted' | 'timeout' | 'capacity-exhausted' | 'unknown-evidence' | 'configuration-changed' | 'model-failed'

function safeModelFailure(value: LlmModelFailure | undefined): LlmModelFailure | undefined {
  if (!value || typeof value !== 'object' || !['timeout', 'cancelled', 'network', 'http', 'response'].includes(value.kind)) return undefined
  const status = value.httpStatus
  const finishReason = value.finishReason
  return Object.freeze({
    kind: value.kind,
    ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status } : {}),
    ...(finishReason === 'length' || finishReason === 'content_filter' || finishReason === 'tool_calls' || finishReason === 'function_call' || finishReason === 'stop' || finishReason === 'other' ? { finishReason } : {})
  })
}

/** Static messages only; source paths, credentials and upstream errors do not belong here. */
export class WorkflowError extends Error {
  readonly code: WorkflowFailureCode
  readonly modelFailure?: LlmModelFailure
  constructor(code: WorkflowFailureCode, modelFailure?: LlmModelFailure) {
    super('Workflow operation rejected.')
    this.name = 'WorkflowError'
    this.code = code
    const safeFailure = safeModelFailure(modelFailure)
    if (safeFailure) this.modelFailure = safeFailure
  }
}

export interface LineRange { readonly startLine: number; readonly endLine: number }
export type EvidenceSourceKind = 'code' | 'documentation' | 'configuration' | 'other'
export interface WorkflowFile {
  readonly fileId: string
  readonly relPath: string
  readonly byteLength: number
  readonly sourceKind: EvidenceSourceKind
}

/** A capability-bearing, immutable read minted by the snapshot adapter. Copying its shape does not authorize evidence. */
export interface ApprovedProjectRead {
  readonly snapshotId: string
  readonly fileId: string
  readonly relPath: string
  readonly sourceKind: EvidenceSourceKind
  readonly text: string
  readonly contentHash: string
  readonly readBytes: number
  readonly lineMapping: 'preserved' | 'unknown'
  /** Counts produced while redacting the source; absent only for legacy/synthetic fixtures. */
  readonly redactionSummary?: Readonly<{ totalMatches: number; matchesByCategory: Readonly<Record<string, number>> }>
  readonly redactionVersion: string
  readonly parserVersion: string
  readonly analysis: SourceAnalysis | null
  readonly indexStatus: 'available' | 'unavailable'
}

export interface WorkflowFileRead {
  readonly read: ApprovedProjectRead
  readonly consumedBytes: number
  readonly cacheHit: boolean
}

/** Main-process-only boundary; model actions can refer to file IDs but never supply paths or read capabilities. */
export interface WorkflowProjectSnapshot {
  readonly projectId: string
  readonly snapshotId: string
  readonly policyVersion: string
  readonly files: readonly WorkflowFile[]
  readonly summary: Readonly<{ name: string; totalFiles: number; contentFileCount: number; truncated: boolean }>
  assertCurrent(signal?: AbortSignal): Promise<void>
  readFile(fileId: string, signal?: AbortSignal): Promise<WorkflowFileRead>
  ownsRead(value: unknown): value is ApprovedProjectRead
}

export interface EvidenceRecord {
  readonly id: string
  readonly snapshotId: string
  readonly fileId: string
  readonly relPath: string
  readonly originalRange: LineRange | null
  readonly displayRange: LineRange
  readonly contentHash: string
  readonly text: string
  readonly sourceKind: EvidenceSourceKind
  readonly readStatus: 'complete'
  readonly parseStatus: 'parsed' | 'unavailable'
  readonly omission: 'none'
  readonly transformationVersion: string
  readonly redactionSummary?: Readonly<{ totalMatches: number; matchesByCategory: Readonly<Record<string, number>> }>
}

export interface WorkflowEvidenceStore {
  /** Returns previously issued intersecting records plus newly issued uncovered spans; existing IDs never change meaning. */
  issue(read: ApprovedProjectRead, range: LineRange, signal?: AbortSignal): Promise<readonly EvidenceRecord[]>
  resolve(ids: readonly string[], snapshotId: string, signal?: AbortSignal): Promise<readonly EvidenceRecord[]>
  metadata(): Readonly<{ records: number; bytes: number; ids: readonly string[] }>
}
