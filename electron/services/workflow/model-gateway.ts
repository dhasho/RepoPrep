import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createDurableModelAdmission, durableModelEvent } from './model-journal.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { retainUnknownModel, blockBudgetLedger, requiresDurableModelAdmission, beginOrdinaryModelCompletion } from './budget-ledger.ts'
import type { DurableModelJournal, DurableOperationInput } from './model-journal.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript modules with explicit extensions.
import { chatCompletionStream, isLlmTimeoutError, LLM_RESPONSE_LIMITS, LlmRequestError, normalizeBaseUrl } from '../llm.ts'
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
  /** Required by the critical journal when durable admission is enabled. Program-owned hashes only. */
  readonly durableOperation?: DurableOperationInput
}
export interface ModelCompletion { readonly content: string; readonly usage: LlmUsage | null }
export type ModelTransport = (profile: LlmProfile, messages: ChatMessage[], onDelta: (delta: string) => unknown, options: CallOptions) => Promise<string>
export interface ModelGatewayOptions { readonly durability?: DurableModelJournal; readonly transport?: ModelTransport; readonly trace?: (event: Readonly<{ type: 'reserved' | 'dispatched' | 'settled' | 'failed'; id: string; stage: ModelStage }>) => void }

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

function assertDispatchGuard(guard: ModelCompletionInput['dispatchGuard'], messages: readonly ChatMessage[]): void {
  const result = guard?.(messages)
  if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new WorkflowError('invalid-argument') }
}

export function createModelGateway(spec: RunSpec, privateProfile: LlmProfile, ledger: BudgetLedger, options: ModelGatewayOptions = {}) {
  assertConfiguration(spec, privateProfile)
  const profile = freezeProfile(privateProfile)
  const transport = options.transport ?? chatCompletionStream
  const journal = options.durability
  const durable = journal ? createDurableModelAdmission(spec, ledger, journal) : undefined
  const assertAdmission = (): void => {
    if (requiresDurableModelAdmission(ledger) && !durable) throw new WorkflowError('invalid-argument')
  }
  assertAdmission()
  const safeTrace = (event: Readonly<{ type: 'reserved' | 'dispatched' | 'settled' | 'failed'; id: string; stage: ModelStage }>): void => {
    try { options.trace?.(Object.freeze(event)) } catch { /* tracing is observational */ }
  }
  return Object.freeze({
    async complete(input: ModelCompletionInput): Promise<ModelCompletion> {
      assertAdmission()
      const releaseOrdinary = durable ? undefined : beginOrdinaryModelCompletion(ledger)
      try {
        if (!input || typeof input !== 'object' || !Array.isArray(input.messages) || input.messages.length > 256 || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.id) || !['investigation', 'generation', 'review', 'repair', 'compensation'].includes(input.stage)) throw new WorkflowError('invalid-argument')
        if (input.durableOperation !== undefined && !durable) throw new WorkflowError('invalid-argument')
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
        const maxStreamBodyBytes = Math.max(LLM_RESPONSE_LIMITS.chatBodyBytes, Math.min(LLM_RESPONSE_LIMITS.maxStreamBodyBytes, outputTokens * 1024))
        const estimatedInputTokens = estimateMessageTokens(messages)
        if (!Number.isSafeInteger(estimatedInputTokens) || (spec.model.contextWindowTokens !== undefined && estimatedInputTokens + outputTokens > spec.model.contextWindowTokens)) throw new WorkflowError('budget-exhausted')
        if (input.signal?.aborted) throw new WorkflowError('cancelled')
        const durableContext = durable?.context(input.id, input.stage, messages, input.durableOperation, estimatedInputTokens, outputTokens)
        if (durableContext) {
          try { durable!.assertCurrent(durableContext, messages); assertDispatchGuard(dispatchGuard, messages) } catch (error) { throw mapFailure(error, input.signal) }
        }
        ledger.assertCanContinue(input.stage)
        ledger.reserveModel({ id: input.id, stage: input.stage, inputTokens: estimatedInputTokens, outputTokens, contextChars: messages.reduce((sum, message) => sum + message.content.length, 0), ...(durableContext ? { semanticHash: durableContext.semanticHash, semanticOperationHash: durableContext.semanticOperationHash, requestHash: durableContext.requestHash, manifestHash: durableContext.manifestHash } : {}) })
        safeTrace({ type: 'reserved', id: input.id, stage: input.stage })
        let dispatched = false
        let hookStarted = false
        let intentStarted = false
        let finished = false
        let protocolViolation = false
        let journalFailed = false
        const flush = async (kind: 'reservation' | 'intent' | 'receipt' | 'unknown', state?: 'dispatched' | 'settled' | 'unknown' | 'unknown-unsent', usage: LlmUsage | null = null, afterFlush?: () => void): Promise<void> => {
          if (!durable || !durableContext) return
          try { await durable.flush(durableModelEvent(kind, durableContext, usage, content === null ? 'missing' : 'uncommitted', protocolViolation ? 'transport-protocol' : kind === 'unknown' ? 'receipt-unavailable' : 'none'), state ? { id: input.id, state, usage } : undefined, afterFlush) }
          catch { journalFailed = true; blockBudgetLedger(ledger); throw new WorkflowError('model-failed') }
        }
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
          if (durable) await flush('reservation')
          const snapshot = ledger.snapshot()
          const remainingMs = Math.min(spec.budget.total.wallClockMs - snapshot.elapsedMs, input.stage === 'investigation' ? snapshot.remaining.investigationWallClockMs : Number.MAX_SAFE_INTEGER)
          if (remainingMs <= 0) throw new WorkflowError('budget-exhausted')
          const checkDispatch = (): void => {
            if (finished || protocolViolation) throw new WorkflowError('model-failed')
            if (input.signal?.aborted) throw new WorkflowError('cancelled')
            assertConfiguration(spec, profile)
            if (durableContext) durable!.assertCurrent(durableContext, messages)
            assertDispatchGuard(dispatchGuard, messages)
            ledger.assertCanContinue(input.stage)
            // Keep this last: a synchronous guard can try to activate durability too.
            assertAdmission()
          }
          const markDispatched = (): void => {
            checkDispatch()
            ledger.markDispatched(input.id)
            dispatched = true
            safeTrace({ type: 'dispatched', id: input.id, stage: input.stage })
          }
          const beforeRequest = durable ? (): Promise<void> => {
            if (hookStarted || finished) {
              protocolViolation = true; blockBudgetLedger(ledger)
              const refused = Promise.reject(new WorkflowError('model-failed')); void refused.catch(() => {}); return refused
            }
            hookStarted = true
            const guarded = (async (): Promise<void> => {
              checkDispatch()
              intentStarted = true
              await flush('intent', 'dispatched', null, markDispatched)
            })()
            void guarded.catch(() => {})
            return guarded
          } : markDispatched
          const rawContent = await transport(profile, transportMessages, emitSafeDelta, {
            signal: input.signal,
            timeoutMs: Math.max(1, Math.min(300_000, remainingMs)),
            maxOutputTokens: outputTokens,
            maxStreamBodyBytes,
            includeUsage: true,
            beforeRequest,
            beforeFetch: () => {
              if (!dispatched) throw new WorkflowError('model-failed')
              checkDispatch()
            },
            onUsage: (usage) => { receipt = normalizeUsage(usage) }
          })
          if (!dispatched || protocolViolation) {
            if (!durable) ledger.markUnknownUnsent(input.id)
            else protocolViolation = true
            unknownUnsent = true
            throw new WorkflowError('model-failed')
          }
          // A custom transport or synchronous response handling may outlive the timer. Never return a result after either hard deadline.
          if (input.signal?.aborted) throw new WorkflowError('cancelled')
          ledger.assertCanContinue(input.stage)
          if (durable && !normalizeUsage(receipt)) throw new WorkflowError('model-failed')
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
          finished = true
          if (durable) {
            if (!dispatched || protocolViolation || !normalizeUsage(receipt) || journalFailed) {
              retainUnknownModel(ledger, input.id, dispatched || intentStarted)
              if (!journalFailed) await flush('unknown', dispatched || intentStarted ? 'unknown' : 'unknown-unsent')
              safeTrace({ type: 'failed', id: input.id, stage: input.stage })
            } else {
              try { await flush('receipt', 'settled', normalizeUsage(receipt), () => ledger.settleModel(input.id, normalizeUsage(receipt))) }
              catch (error) { retainUnknownModel(ledger, input.id, true); throw error }
              if (content !== null) {
                try {
                  if (input.signal?.aborted) throw new WorkflowError('cancelled')
                  durable!.assertCurrent(durableContext!, messages)
                  assertDispatchGuard(dispatchGuard, messages)
                  const final = ledger.snapshot()
                  if (final.elapsedMs >= spec.budget.total.wallClockMs || input.stage === 'investigation' && final.remaining.investigationWallClockMs <= 0) throw new WorkflowError('budget-exhausted')
                } catch (error) { throw mapFailure(error, input.signal) }
              }
              safeTrace({ type: content === null ? 'failed' : 'settled', id: input.id, stage: input.stage })
            }
          } else if (!dispatched) {
            if (!unknownUnsent) ledger.releaseUnsent(input.id)
            safeTrace({ type: 'failed', id: input.id, stage: input.stage })
          } else {
            ledger.settleModel(input.id, normalizeUsage(receipt))
            safeTrace({ type: content === null ? 'failed' : 'settled', id: input.id, stage: input.stage })
          }
        }
      } finally { releaseOrdinary?.() }
    }
  })
}
