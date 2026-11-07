import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { chatCompletionStream, isLlmTimeoutError, LlmRequestError, normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { estimateMessageTokens } from '../../../shared/token-budget.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { CONTEXT_CHAR_BUDGETS, validateMessageCharBudget } from '../../../shared/context-budget.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import type { LlmProfile, LlmUsage } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LLM_PROFILE_LIMITS } from '../../../shared/result-contract.ts'
import type { BudgetLedger, ModelStage } from './budget-ledger.ts'
import type { RunSpec } from './run-spec.ts'
import type { ChatMessage, CallOptions } from '../llm.ts'

export interface ModelCompletionInput {
  readonly id: string
  readonly stage: ModelStage
  readonly messages: readonly ChatMessage[]
  readonly signal?: AbortSignal
  readonly onDelta?: (delta: string) => unknown
  /** Main-process proof that the exact frozen messages still satisfy their evidence manifest. */
  readonly dispatchGuard?: (messages: readonly ChatMessage[]) => void
  readonly maxOutputTokens?: number
}
export interface ModelCompletion { readonly content: string; readonly usage: LlmUsage | null }
export type ModelTransport = (profile: LlmProfile, messages: ChatMessage[], onDelta: (delta: string) => unknown, options: CallOptions) => Promise<string>
export interface ModelGatewayOptions { readonly transport?: ModelTransport; readonly trace?: (event: Readonly<{ type: 'reserved' | 'dispatched' | 'settled' | 'failed'; id: string; stage: ModelStage }>) => void }

function normalizedProtocol(profile: LlmProfile): 'openai' | 'anthropic' { return profile.protocol ?? 'openai' }
function endpointFingerprint(profile: LlmProfile): string {
  try { return createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex') }
  catch { throw new WorkflowError('configuration-changed') }
}
function assertConfiguration(spec: RunSpec, profile: LlmProfile): void {
  if (!profile || typeof profile !== 'object' || profile.id !== spec.model.profileId || profile.model !== spec.model.model || endpointFingerprint(profile) !== spec.model.endpointFingerprint || normalizedProtocol(profile) !== (spec.model.protocol ?? 'openai') || profile.reasoningEffort !== spec.model.reasoningEffort || (profile.temperature ?? 0.4) !== (spec.model.temperature ?? 0.4) || profile.contextWindowTokens !== spec.model.contextWindowTokens || profile.maxOutputTokens !== spec.model.maxOutputTokens || typeof profile.apiKey !== 'string' || profile.apiKey.length > LLM_PROFILE_LIMITS.apiKey) {
    throw new WorkflowError('configuration-changed')
  }
}
function freezeProfile(profile: LlmProfile): LlmProfile {
  return Object.freeze({
    id: profile.id, name: profile.name, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model,
    ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.contextWindowTokens !== undefined ? { contextWindowTokens: profile.contextWindowTokens } : {}),
    ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {})
  })
}
function normalizeUsage(value: unknown): LlmUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const inputTokens = record.inputTokens; const outputTokens = record.outputTokens; const totalTokens = record.totalTokens
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isSafeInteger(totalTokens) || Number(inputTokens) < 0 || Number(outputTokens) < 0 || Number(totalTokens) !== Number(inputTokens) + Number(outputTokens)) return null
  return Object.freeze({ inputTokens: Number(inputTokens), outputTokens: Number(outputTokens), totalTokens: Number(totalTokens) })
}
function mapFailure(error: unknown, signal?: AbortSignal): WorkflowError {
  if (error instanceof WorkflowError) return error
  const modelFailure = error instanceof LlmRequestError ? error.modelFailure : undefined
  if (signal?.aborted || error instanceof LlmRequestError && error.kind === 'cancelled') return new WorkflowError('cancelled', modelFailure)
  if (isLlmTimeoutError(error)) return new WorkflowError('timeout', modelFailure)
  return new WorkflowError('model-failed', modelFailure)
}

export function createModelGateway(spec: RunSpec, privateProfile: LlmProfile, ledger: BudgetLedger, options: ModelGatewayOptions = {}) {
  assertConfiguration(spec, privateProfile)
  const profile = freezeProfile(privateProfile)
  const transport = options.transport ?? chatCompletionStream
  const safeTrace = (event: Readonly<{ type: 'reserved' | 'dispatched' | 'settled' | 'failed'; id: string; stage: ModelStage }>): void => {
    try { options.trace?.(Object.freeze(event)) } catch { /* tracing is observational */ }
  }
  return Object.freeze({
    async complete(input: ModelCompletionInput): Promise<ModelCompletion> {
      if (!input || typeof input !== 'object' || !Array.isArray(input.messages) || input.messages.length > 256 || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.id) || !['investigation', 'generation', 'review', 'repair', 'compensation'].includes(input.stage)) throw new WorkflowError('invalid-argument')
      if (input.onDelta !== undefined && typeof input.onDelta !== 'function') throw new WorkflowError('invalid-argument')
      if (input.dispatchGuard !== undefined && typeof input.dispatchGuard !== 'function') throw new WorkflowError('invalid-argument')
      const dispatchGuard = input.dispatchGuard
      const maxChars = input.stage === 'investigation' ? Math.min(CONTEXT_CHAR_BUDGETS[spec.granularity], spec.budget.investigation.inputTokens * 4) : CONTEXT_CHAR_BUDGETS[spec.granularity]
      if (!input.messages.every(message => message && ['system', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string') || !validateMessageCharBudget(input.messages, maxChars)) throw new WorkflowError('budget-exhausted')
      // This scan is now bounded by the shared per-granularity character ceiling.
      const messages = Object.freeze(input.messages.map(message => Object.freeze({ role: message.role, content: message.content }))) as readonly ChatMessage[]
      const transportMessages = Object.freeze([...messages]) as unknown as ChatMessage[]
      assertConfiguration(spec, profile)
      const maxStageOutput = input.stage === 'investigation' ? spec.budget.investigation.outputTokens : spec.generationOutputTokens
      const outputTokens = input.maxOutputTokens ?? Math.min(maxStageOutput, profile.maxOutputTokens ?? spec.generationOutputTokens)
      if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > spec.generationOutputTokens || outputTokens > maxStageOutput || (spec.model.maxOutputTokens !== undefined && outputTokens > spec.model.maxOutputTokens) || (spec.model.contextWindowTokens !== undefined && outputTokens >= spec.model.contextWindowTokens)) throw new WorkflowError('invalid-argument')
      const estimatedInputTokens = estimateMessageTokens(messages)
      if (!Number.isSafeInteger(estimatedInputTokens) || (spec.model.contextWindowTokens !== undefined && estimatedInputTokens + outputTokens > spec.model.contextWindowTokens)) throw new WorkflowError('budget-exhausted')
      if (input.signal?.aborted) throw new WorkflowError('cancelled')
      ledger.assertCanContinue(input.stage)
      ledger.reserveModel({ id: input.id, stage: input.stage, inputTokens: estimatedInputTokens, outputTokens, contextChars: messages.reduce((sum, message) => sum + message.content.length, 0) })
      safeTrace({ type: 'reserved', id: input.id, stage: input.stage })
      let dispatched = false
      let unknownUnsent = false
      let receipt: LlmUsage | null = null
      let content: string | null = null
      let pendingDelta = ''
      let credentialEcho = false
      const apiKey = profile.apiKey
      const emitSafeDelta = (delta: string): unknown => {
        if (!input.onDelta || !delta) return undefined
        if (!apiKey) return input.onDelta(delta)
        if (credentialEcho) throw new WorkflowError('model-failed')
        const combined = pendingDelta + delta
        if (combined.includes(apiKey)) {
          credentialEcho = true
          pendingDelta = ''
          throw new WorkflowError('model-failed')
        }
        let safeLength = Math.max(0, combined.length - apiKey.length + 1)
        if (safeLength > 0 && safeLength < combined.length && /[\uD800-\uDBFF]/.test(combined[safeLength - 1]) && /[\uDC00-\uDFFF]/.test(combined[safeLength])) safeLength--
        const safe = combined.slice(0, safeLength)
        pendingDelta = combined.slice(safeLength)
        return safe ? input.onDelta(safe) : undefined
      }
      try {
        const snapshot = ledger.snapshot()
        const remainingMs = Math.min(spec.budget.total.wallClockMs - snapshot.elapsedMs, input.stage === 'investigation' ? snapshot.remaining.investigationWallClockMs : Number.MAX_SAFE_INTEGER)
        if (remainingMs <= 0) throw new WorkflowError('budget-exhausted')
        const beforeRequest = (): void => {
          assertConfiguration(spec, profile)
          ledger.assertCanContinue(input.stage)
          dispatchGuard?.(messages)
          ledger.markDispatched(input.id)
          dispatched = true
          safeTrace({ type: 'dispatched', id: input.id, stage: input.stage })
        }
        const rawContent = await transport(profile, transportMessages, emitSafeDelta, {
          signal: input.signal,
          timeoutMs: Math.max(1, Math.min(300_000, remainingMs)),
          maxOutputTokens: outputTokens,
          includeUsage: true,
          beforeRequest,
          onUsage: (usage) => { receipt = normalizeUsage(usage) }
        })
        if (!dispatched) {
          ledger.markUnknownUnsent(input.id)
          unknownUnsent = true
          throw new WorkflowError('model-failed')
        }
        // A custom transport or synchronous response handling may outlive the timer. Never return a result after either hard deadline.
        if (input.signal?.aborted) throw new WorkflowError('cancelled')
        ledger.assertCanContinue(input.stage)
        if (typeof rawContent !== 'string') throw new WorkflowError('model-failed')
        if (apiKey && rawContent.includes(apiKey)) throw new WorkflowError('model-failed')
        if (pendingDelta && input.onDelta) await input.onDelta(pendingDelta)
        pendingDelta = ''
        if (input.signal?.aborted) throw new WorkflowError('cancelled')
        ledger.assertCanContinue(input.stage)
        content = rawContent
        return Object.freeze({ content, usage: normalizeUsage(receipt) })
      } catch (error) {
        throw mapFailure(error, input.signal)
      } finally {
        if (!dispatched) {
          if (!unknownUnsent) ledger.releaseUnsent(input.id)
          safeTrace({ type: 'failed', id: input.id, stage: input.stage })
        } else {
          ledger.settleModel(input.id, normalizeUsage(receipt))
          safeTrace({ type: content === null ? 'failed' : 'settled', id: input.id, stage: input.stage })
        }
      }
    }
  })
}
