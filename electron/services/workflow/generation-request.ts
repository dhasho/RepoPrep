import type { QuestionItem } from '@shared/types'
import type { ChatMessage, CallOptions } from '../llm'
import type { RenderedSelection } from '../context-builder'

export type GenerationRequestStage = 'generation' | 'repair' | 'compensation'
export type GenerationRequestAcceptanceMode = 'streaming' | 'complete-response'

export interface GenerationRequestPreparationInput {
  requestId: string
  stage: GenerationRequestStage
  batchIndex: number
  label: string
  quota: number
  maxChars: number
  maxInputTokens: number
  signal: AbortSignal
  /** Build the exact legacy prompt for the context text selected by the adapter. */
  buildMessages: (contextText: string) => ChatMessage[]
}

export interface PreparedGenerationRequest {
  requestId: string
  stage: GenerationRequestStage
  messages: readonly ChatMessage[]
  /** Adapter-owned dispatch metadata; generator treats this as opaque. */
  dispatch?: unknown
  /** Exact source selection represented by this prepared packet, when available. */
  selection?: RenderedSelection
}

export interface AcceptedGenerationQuestion {
  requestId: string
  rawQuestion: unknown
  question: QuestionItem
}

export interface GenerationRequestAdapter {
  id: string
  /** Optional internal policy: defer accepted-question callbacks until the full response is validated. */
  acceptanceMode?: GenerationRequestAcceptanceMode
  prepare(input: GenerationRequestPreparationInput): PreparedGenerationRequest | Promise<PreparedGenerationRequest>
  complete(
    prepared: PreparedGenerationRequest,
    onDelta: (delta: string) => unknown,
    options: CallOptions
  ): Promise<string>
  acceptQuestion(input: AcceptedGenerationQuestion): void | Promise<void>
}

/** Safe signal that one streamed candidate failed source-evidence validation. */
export class CitationValidationError extends Error {
  readonly code = 'INVALID_CITATION'

  constructor() {
    super('模型输出引用了未随本次请求提供的证据。')
    this.name = 'CitationValidationError'
  }
}
