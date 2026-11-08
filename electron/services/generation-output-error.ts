import type { GenerationRequestStage } from './workflow/generation-request'

export type GenerationOutputFailureReason =
  | 'json-syntax'
  | 'citation-invalid'
  | 'normalized-structure-invalid'
  | 'checkpoint-invalid'
  | 'empty-output'

export interface GenerationOutputRejection {
  readonly reason: GenerationOutputFailureReason
  readonly attempt: 1 | 2
  readonly stage: GenerationRequestStage
  readonly batchIndex: number
  readonly requestId?: string
}

const REASONS = new Set<GenerationOutputFailureReason>([
  'json-syntax', 'citation-invalid', 'normalized-structure-invalid', 'checkpoint-invalid', 'empty-output'
])
const STAGES = new Set<GenerationRequestStage>(['generation', 'repair', 'compensation'])

function freezeRejection(value: GenerationOutputRejection): GenerationOutputRejection {
  if (!REASONS.has(value.reason) || !STAGES.has(value.stage) ||
      (value.attempt !== 1 && value.attempt !== 2) || !Number.isSafeInteger(value.batchIndex) || value.batchIndex < 0) {
    throw new TypeError('Invalid generation output diagnostic')
  }
  return Object.freeze({
    reason: value.reason,
    attempt: value.attempt,
    stage: value.stage,
    batchIndex: value.batchIndex,
    ...(typeof value.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.requestId) ? { requestId: value.requestId } : {})
  })
}

/** A safe classification for completed model output rejected by the generator. */
export class GenerationOutputError extends Error {
  readonly rejections: readonly GenerationOutputRejection[]

  constructor(message: string, rejections: readonly GenerationOutputRejection[]) {
    super(message)
    this.name = 'GenerationOutputError'
    this.rejections = Object.freeze(rejections.slice(0, 2).map(freezeRejection))
    Object.freeze(this.rejections)
  }
}

/** Read only diagnostics created by this module; arbitrary provider fields are ignored. */
export function readGenerationOutputFailure(value: unknown): readonly GenerationOutputRejection[] | undefined {
  if (!(value instanceof GenerationOutputError)) return undefined
  return value.rejections
}
