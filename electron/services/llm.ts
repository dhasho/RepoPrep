// OpenAI / Anthropic 大模型客户端（主进程中调用，避免渲染进程跨域与密钥暴露）
import type { ListModelsResult, LlmProfile, LlmUsage, TestConnectionResult } from '@shared/types'
// @ts-ignore TS5097 -- the direct Node test runner needs explicit TypeScript extensions.
import { SseDecoder } from './sse-parser.ts'
// @ts-ignore TS5097 -- the direct Node test runner needs explicit TypeScript extensions.
import { LLM_PROFILE_LIMITS } from '../../shared/result-contract.ts'
// @ts-ignore TS5097 -- the direct Node test runner needs explicit TypeScript extensions.
import { createActualSettlement } from './actual-settlement.ts'
import type { ActualSettlement } from './actual-settlement.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmRequestErrorKind = 'timeout' | 'cancelled' | 'network' | 'http' | 'response'
export type LlmFinishReason = 'length' | 'content_filter' | 'tool_calls' | 'function_call' | 'stop' | 'other'
export interface LlmModelFailure {
  readonly kind: LlmRequestErrorKind
  readonly httpStatus?: number
  readonly finishReason?: LlmFinishReason
  readonly responseLimit?: 'stream-bytes'
}

const ERROR_MESSAGES: Record<LlmRequestErrorKind, string> = {
  timeout: '请求超时，请重试。',
  cancelled: '请求已取消。',
  network: '网络请求失败，请检查网络和服务配置后重试。',
  http: '大模型服务返回错误。',
  response: '大模型服务返回内容格式不正确。'
}

// Generator batches include structured answers and follow-ups; 4096 can truncate a valid 15–25 question JSON batch.
const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 16_384

/** Safe request failure; messages never include endpoint, provider body, or credentials. */
export class LlmRequestError extends Error {
  readonly kind: LlmRequestErrorKind
  readonly modelFailure: LlmModelFailure

  constructor(kind: LlmRequestErrorKind, message = ERROR_MESSAGES[kind], details: { httpStatus?: number; finishReason?: string; responseLimit?: 'stream-bytes' } = {}) {
    super(message)
    this.name = 'LlmRequestError'
    this.kind = kind
    const status = details.httpStatus
    const finishReason = details.finishReason
    this.modelFailure = Object.freeze({
      kind,
      ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status } : {}),
      ...(finishReason === 'length' || finishReason === 'content_filter' || finishReason === 'tool_calls' || finishReason === 'function_call' || finishReason === 'stop'
        ? { finishReason }
        : finishReason ? { finishReason: 'other' as const } : {}),
      ...(details.responseLimit === 'stream-bytes' ? { responseLimit: details.responseLimit } : {})
    })
  }
}

/** Strictly identifies timeout failures produced by this module. */
export function isLlmTimeoutError(error: unknown): boolean {
  return error instanceof LlmRequestError && error.kind === 'timeout'
}

/** 统一 baseUrl：去掉结尾斜杠；若未带 /v1 这类版本段则自动补 /v1 */
export function normalizeBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '')
  if (!/\/v\d+(\/|$)/.test(base)) base += '/v1'
  return base
}

function endpoint(profile: LlmProfile): string {
  const base = normalizeBaseUrl(profile.baseUrl)
  return profile.protocol === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`
}

function requestHeaders(profile: LlmProfile): Record<string, string> {
  if (profile.protocol === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      ...(profile.apiKey ? { 'x-api-key': profile.apiKey } : {}),
      'anthropic-version': '2023-06-01'
    }
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${profile.apiKey}`
  }
}

function requestBody(profile: LlmProfile, messages: ChatMessage[], stream: boolean, opts: CallOptions): Record<string, unknown> {
  if (profile.protocol === 'anthropic') {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
    return {
      model: profile.model,
      ...(system ? { system } : {}),
      messages: messages.filter((message) => message.role !== 'system'),
      stream,
      max_tokens: opts.maxOutputTokens ?? profile.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS
    }
  }
  return {
    model: profile.model,
    messages,
    ...(profile.reasoningEffort !== undefined ? { reasoning_effort: profile.reasoningEffort } : {}),
    temperature: profile.temperature ?? 0.4,
    stream,
    ...(stream && opts.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...((opts.maxOutputTokens ?? profile.maxOutputTokens) ? { max_tokens: opts.maxOutputTokens ?? profile.maxOutputTokens } : {})
  }
}

function parseAnthropicMessage(value: unknown): string {
  if (!isRecord(value) || value.type !== 'message' || !Array.isArray(value.content)) {
    throw new LlmRequestError('response')
  }
  if (value.stop_reason === 'max_tokens') throw new LlmRequestError('response', undefined, { finishReason: 'length' })

  let content = ''
  for (const block of value.content) {
    if (!isRecord(block) || typeof block.type !== 'string') throw new LlmRequestError('response')
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string' || hasUnpairedSurrogate(block.text)) throw new LlmRequestError('response')
    if (content.length + block.text.length > LLM_RESPONSE_LIMITS.chatContentChars) throw new LlmRequestError('response')
    content += block.text
  }
  return content
}

interface AnthropicStreamState {
  completed: boolean
}

function appendStreamText(
  value: unknown,
  state: { content: string },
  onDelta: ((delta: string) => void) | null
): void {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) throw new LlmRequestError('response')
  if (state.content.length + value.length > LLM_RESPONSE_LIMITS.chatContentChars) throw new LlmRequestError('response')
  if (value.length === 0) return
  state.content += value
  onDelta?.(value)
}

function handleAnthropicStreamEvent(
  event: { event: string; data: string },
  state: AnthropicStreamState,
  content: { content: string },
  onDelta: ((delta: string) => void) | null
): boolean | void {
  if (event.event === 'ping') return
  if (event.event === 'error') throw new LlmRequestError('response')

  const data = event.data.trim()
  if (!data && event.event === 'message_stop') {
    state.completed = true
    return false
  }
  if (!data) return

  const knownTypes = new Set([
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop', 'error'
  ])
  if (event.event !== 'message' && !knownTypes.has(event.event)) return

  let parsed: unknown
  try { parsed = JSON.parse(event.data) as unknown } catch {
    throw new LlmRequestError('response')
  }
  if (!isRecord(parsed)) throw new LlmRequestError('response')
  if ('error' in parsed && parsed.error !== null) throw new LlmRequestError('response')
  const type = typeof parsed.type === 'string' ? parsed.type : event.event
  if (type === 'ping') return
  if (type === 'error') throw new LlmRequestError('response')
  if (!knownTypes.has(type)) return
  if (state.completed) throw new LlmRequestError('response')

  if (type === 'message_start') {
    if (!isRecord(parsed.message)) throw new LlmRequestError('response')
    return
  }
  if (type === 'content_block_start') {
    if (!isRecord(parsed.content_block) || typeof parsed.content_block.type !== 'string') {
      throw new LlmRequestError('response')
    }
    if (parsed.content_block.type === 'text') appendStreamText(parsed.content_block.text, content, onDelta)
    return
  }
  if (type === 'content_block_delta') {
    if (!isRecord(parsed.delta) || typeof parsed.delta.type !== 'string') throw new LlmRequestError('response')
    if (parsed.delta.type === 'text_delta') appendStreamText(parsed.delta.text, content, onDelta)
    return
  }
  if (type === 'message_delta') {
    if (!isRecord(parsed.delta)) throw new LlmRequestError('response')
    if (parsed.delta.stop_reason === 'max_tokens') throw new LlmRequestError('response')
    if (parsed.delta.stop_reason !== undefined && parsed.delta.stop_reason !== null && typeof parsed.delta.stop_reason !== 'string') {
      throw new LlmRequestError('response')
    }
    return
  }
  if (type === 'message_stop') {
    state.completed = true
    return false
  }
}

export interface CallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputTokens?: number
  /** Private M05 streaming allowance; omitted callers retain the 4 MiB legacy cap. */
  maxStreamBodyBytes?: number
  includeUsage?: boolean
  /** Private main-process opt-in; waits for actual callbacks/cleanup, not an ownership proof. */
  awaitActualSettlement?: boolean
  /** Main-process admission guard. Unlike observers, rejection must prevent fetch. */
  beforeRequest?: () => void | Promise<void>
  /** Pure synchronous, repeatable final fence. Runs after awaited admission and observers, immediately before fetch. */
  beforeFetch?: () => void
  onUsage?: (usage: LlmUsage) => void
  onRequest?: () => void
}

function boundedUsage(value: unknown, protocol: LlmProfile['protocol']): LlmUsage | null {
  if (!isRecord(value)) return null
  const input = protocol === 'anthropic' ? value.input_tokens : value.prompt_tokens
  const output = protocol === 'anthropic' ? value.output_tokens : value.completion_tokens
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || Number(input) < 0 || Number(output) < 0 || Number(input) > 10_000_000 || Number(output) > 10_000_000) return null
  const inputTokens = Number(input); const outputTokens = Number(output)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

export const LLM_RESPONSE_LIMITS = Object.freeze({
  chatBodyBytes: 4 * 1024 * 1024,
  maxStreamBodyBytes: 32 * 1024 * 1024,
  modelsBodyBytes: 1 * 1024 * 1024,
  modelCount: 2000,
  modelIdChars: LLM_PROFILE_LIMITS.model,
  chatContentChars: 1_000_000
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function resolveStreamBodyLimit(value: number | undefined): number {
  if (value === undefined) return LLM_RESPONSE_LIMITS.chatBodyBytes
  if (!Number.isSafeInteger(value) || value < LLM_RESPONSE_LIMITS.chatBodyBytes || value > LLM_RESPONSE_LIMITS.maxStreamBodyBytes) throw new LlmRequestError('response')
  return value
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return true
      const next = value.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

async function request(
  profile: LlmProfile,
  messages: ChatMessage[],
  stream: boolean,
  onDelta: ((delta: string) => unknown) | null,
  opts: CallOptions
): Promise<string> {
  const maxStreamBodyBytes = stream ? resolveStreamBodyLimit(opts.maxStreamBodyBytes) : LLM_RESPONSE_LIMITS.chatBodyBytes
  if (!stream && opts.maxStreamBodyBytes !== undefined && (!Number.isSafeInteger(opts.maxStreamBodyBytes) || opts.maxStreamBodyBytes < LLM_RESPONSE_LIMITS.chatBodyBytes || opts.maxStreamBodyBytes > LLM_RESPONSE_LIMITS.maxStreamBodyBytes)) throw new LlmRequestError('response')
  const controller = new AbortController()
  let abortKind: 'timeout' | 'cancelled' | null = null
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let externalListenerAttached = false
  let response: Response | null = null
  let callbackFailed = false
  let callbackFailure: unknown
  let pendingUsageReceipt: LlmUsage | null = null
  let usageReported = false
  const settlement = opts.awaitActualSettlement ? createActualSettlement() : undefined
  const cancelResponseBody = createBodyCanceller(settlement)
  const observe = (invoke: () => unknown): void => {
    try {
      if (settlement) settlement.capture(invoke)
      else void Promise.resolve(invoke()).catch(() => {})
    } catch { /* diagnostics cannot affect generation */ }
  }
  const reportUsage = (): void => {
    if (!pendingUsageReceipt || usageReported) return
    usageReported = true
    observe(() => opts.onUsage?.(pendingUsageReceipt!))
  }
  const abort = (kind: 'timeout' | 'cancelled'): void => {
    if (abortKind !== null) return
    abortKind = kind
    controller.abort()
  }
  const onExternalAbort = (): void => abort('cancelled')
  const throwIfAborted = (): void => {
    if (abortKind) throw new LlmRequestError(abortKind)
  }

  try {
    if (opts.signal) {
      opts.signal.addEventListener('abort', onExternalAbort, { once: true })
      externalListenerAttached = true
      if (opts.signal.aborted) onExternalAbort()
    }
    throwIfAborted()
    timeout = setTimeout(() => {
      if (!settled) abort('timeout')
    }, opts.timeoutMs ?? 300_000)

    const url = endpoint(profile)
    const headers = requestHeaders(profile)
    const body = JSON.stringify(requestBody(profile, messages, stream, opts))
    throwIfAborted()
    try {
      const admission = settlement?.capture(() => opts.beforeRequest?.())
      const value = admission ? admission.value : opts.beforeRequest?.()
      if (value !== undefined) await (admission ? admission.settlement : value)
    }
    catch (error) { callbackFailed = true; callbackFailure = error; throw error }
    throwIfAborted()
    observe(() => opts.onRequest?.())
    throwIfAborted()
    try {
      const guard = settlement?.capture(() => opts.beforeFetch?.())
      const finalGuard: unknown = guard ? guard.value : opts.beforeFetch?.()
      if (finalGuard !== undefined) {
        if (!guard) void Promise.resolve(finalGuard).catch(() => {})
        throw new LlmRequestError('response')
      }
    } catch (error) { callbackFailed = true; callbackFailure = error; throw error }
    throwIfAborted()
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    })
    throwIfAborted()

    if (!response.ok) {
      cancelResponseBody(response.body)
      throw new LlmRequestError('http', `大模型服务返回 HTTP ${response.status}。`, { httpStatus: response.status })
    }

    if (!stream) {
      const text = await readBodyText(response.body, controller.signal, {
        maxBytes: LLM_RESPONSE_LIMITS.chatBodyBytes,
        fatalUtf8: true,
        cancel: cancelResponseBody
      })
      throwIfAborted()
      let json: unknown
      try {
        json = JSON.parse(text) as unknown
      } catch {
        throw new LlmRequestError('response')
      }
      const usage = isRecord(json) ? boundedUsage(json.usage, profile.protocol) : null
      if (usage) pendingUsageReceipt = usage
      let content: string
      if (profile.protocol === 'anthropic') {
        content = parseAnthropicMessage(json)
      } else {
        if (!isRecord(json) || !Array.isArray(json.choices)) throw new LlmRequestError('response')
        const first = json.choices[0]
        const message = isRecord(first) ? first.message : undefined
        const rawContent = isRecord(message) ? message.content : undefined
        if (typeof rawContent !== 'string') throw new LlmRequestError('response')
        content = rawContent
        if (typeof content !== 'string' || content.length > LLM_RESPONSE_LIMITS.chatContentChars || hasUnpairedSurrogate(content)) {
          throw new LlmRequestError('response')
        }
      }
      throwIfAborted()
      reportUsage()
      return content
    }

    // Some compatible endpoints ignore stream=true and return one JSON completion.
    if (!response.body) throw new LlmRequestError('response')
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    const probe = contentType.includes('text/event-stream')
      ? { mode: 'sse' as const, chunks: [] as Uint8Array[] }
      : contentType.includes('application/json')
        ? { mode: 'json' as const, chunks: [] as Uint8Array[] }
        : await probeStreamBody(response.body, controller.signal, maxStreamBodyBytes, cancelResponseBody)
    if (probe.mode === 'json') {
      const text = await readBodyText(response.body, controller.signal, {
        maxBytes: LLM_RESPONSE_LIMITS.chatBodyBytes,
        fatalUtf8: true,
        initialChunks: probe.chunks,
        cancel: cancelResponseBody
      })
      throwIfAborted()
      let json: unknown
      try { json = JSON.parse(text) as unknown } catch { throw new LlmRequestError('response') }
      const usage = isRecord(json) ? boundedUsage(json.usage, profile.protocol) : null
      if (usage) pendingUsageReceipt = usage
      const content = profile.protocol === 'anthropic'
        ? parseAnthropicMessage(json)
        : extractOpenAiContent(json)
      if (!content || content.length > LLM_RESPONSE_LIMITS.chatContentChars || hasUnpairedSurrogate(content)) throw new LlmRequestError('response')
      if (onDelta) {
        try { await awaitCallback(() => onDelta(content), controller.signal, settlement) }
        catch (error) { callbackFailed = true; callbackFailure = error; throw error }
      }
      throwIfAborted()
      reportUsage()
      return content
    }

    // SSE 流式解析
    let full = ''
    let completed = false
    let sawStop = false
    let anthropicInputTokens: unknown
    let anthropicOutputTokens: unknown
    let lastUsageReceipt: LlmUsage | null = null
    let terminalFailure: LlmRequestError | null = null
    let anthropicTerminalUsage = false
    const anthropicState: AnthropicStreamState = { completed: false }
    const contentState = { content: '' }
    const deltas: string[] = []
    const notifyDelta = (delta: string): void => { deltas.push(delta) }
    const usageFromEvent = (value: unknown, eventType?: string): void => {
      if (!isRecord(value)) return
      if (profile.protocol === 'anthropic') {
        const usageValue = isRecord(value.message) && isRecord(value.message.usage)
          ? value.message.usage
          : isRecord(value.delta) && isRecord(value.delta.usage) ? value.delta.usage : value.usage
        const hasTerminalOutput = eventType === 'message_delta' && isRecord(usageValue) && Number.isSafeInteger(usageValue.output_tokens) && Number(usageValue.output_tokens) >= 0
        if (isRecord(usageValue)) {
          if (usageValue.input_tokens !== undefined) anthropicInputTokens = usageValue.input_tokens
          if (usageValue.output_tokens !== undefined) anthropicOutputTokens = usageValue.output_tokens
        }
        if (hasTerminalOutput) anthropicTerminalUsage = true
        const usage = boundedUsage({ input_tokens: anthropicInputTokens, output_tokens: anthropicOutputTokens }, profile.protocol)
        if (usage && anthropicTerminalUsage) {
          lastUsageReceipt = usage
          pendingUsageReceipt = usage
        }
        return
      }
      const usage = boundedUsage(value.usage, profile.protocol)
      if (usage) {
        lastUsageReceipt = usage
        pendingUsageReceipt = usage
      }
    }
    const decoder = new SseDecoder((event) => {
      if (terminalFailure) {
        // Once a terminal provider failure is known, only usage metadata is accepted.
        if (event.data.trim() === '[DONE]' || profile.protocol === 'anthropic' && event.event === 'message_stop') return false
        if (profile.protocol === 'anthropic') {
          try {
            const parsed = event.data.trim() ? JSON.parse(event.data) as unknown : null
            const type = isRecord(parsed) && typeof parsed.type === 'string' ? parsed.type : event.event
            if (type === 'message_stop') return false
            usageFromEvent(isRecord(parsed) && isRecord(parsed.message) ? parsed.message : parsed, type)
          } catch { /* A malformed tail cannot replace the already-known provider failure. */ }
        } else {
          try {
            const parsed = JSON.parse(event.data) as unknown
            if (isRecord(parsed)) usageFromEvent(parsed)
          } catch { /* A malformed tail cannot replace the already-known provider failure. */ }
        }
        return true
      }
      if (profile.protocol === 'anthropic') {
        try {
          const parsed = event.data.trim() ? JSON.parse(event.data) as unknown : null
          const parsedRecord = isRecord(parsed) ? parsed : null
          const type = parsedRecord && typeof parsedRecord.type === 'string' ? parsedRecord.type : event.event
          usageFromEvent(isRecord(parsed) && isRecord(parsed.message) ? parsed.message : parsed, type)
          const reason = type === 'message_delta' && isRecord(parsedRecord?.delta) ? parsedRecord.delta.stop_reason : undefined
          if (reason === 'max_tokens') {
            terminalFailure = new LlmRequestError('response', undefined, { finishReason: 'length' })
            return true
          }
          const shouldContinue = handleAnthropicStreamEvent(event, anthropicState, contentState, notifyDelta)
          full = contentState.content
          if (shouldContinue === false) completed = true
          return shouldContinue
        } catch (error) {
          if (callbackFailed) throw callbackFailure
          if (error instanceof LlmRequestError) throw error
          throw new LlmRequestError('response')
        }
      }
      if (event.event === 'error') throw new LlmRequestError('response')
      const payload = event.data.trim()
      // Empty data messages and named heartbeat events carry no chat payload.
      if (payload.length === 0) return
      if (payload === '[DONE]') {
        completed = true
        return false
      }

      let chunk: unknown
      try {
        chunk = JSON.parse(event.data) as unknown
      } catch {
        throw new LlmRequestError('response')
      }
      if (!isRecord(chunk)) throw new LlmRequestError('response')
      usageFromEvent(chunk)
      if ('error' in chunk && chunk.error !== null) throw new LlmRequestError('response')

      const choices = chunk.choices
      if (choices === undefined) {
        if ('usage' in chunk) return
        throw new LlmRequestError('response')
      }
      if (!Array.isArray(choices)) throw new LlmRequestError('response')
      if (choices.length === 0) return // usage-only chunk
      if (sawStop) throw new LlmRequestError('response')

      let selected: Record<string, unknown> | null = null
      for (let i = 0; i < choices.length; i++) {
        const choice = choices[i]
        if (!isRecord(choice)) throw new LlmRequestError('response')
        if (choice.index !== undefined && typeof choice.index !== 'number') throw new LlmRequestError('response')
        if (choice.index === 0 || (choice.index === undefined && i === 0)) {
          selected = choice
          break
        }
      }
      if (!selected) return

      const delta = selected.delta
      if (delta !== undefined && delta !== null) {
        if (!isRecord(delta)) throw new LlmRequestError('response')
        const content = delta.content
        if (content !== undefined && content !== null) {
          if (typeof content !== 'string' || hasUnpairedSurrogate(content)) throw new LlmRequestError('response')
          if (content.length > 0) {
            if (full.length + content.length > LLM_RESPONSE_LIMITS.chatContentChars) throw new LlmRequestError('response')
            full += content
            notifyDelta(content)
          }
        }
      }

      const finishReason = selected.finish_reason
      if (finishReason === undefined || finishReason === null) return
      if (finishReason === 'stop') {
        sawStop = true
        return
      }
      if (finishReason === 'length' || finishReason === 'content_filter' || finishReason === 'tool_calls' || finishReason === 'function_call') {
        terminalFailure = new LlmRequestError('response', undefined, { finishReason })
        return true
      }
      throw new LlmRequestError('response', undefined, { finishReason: typeof finishReason === 'string' ? finishReason : undefined })
    }, { maxBufferChars: LLM_RESPONSE_LIMITS.chatContentChars })

    const feed = async (decoded: string): Promise<boolean> => {
      let parseFailure: unknown
      try {
        decoder.push(decoded)
      } catch (error) {
        parseFailure = error instanceof LlmRequestError ? error : new LlmRequestError('response')
      }
      const queued = deltas.splice(0)
      if (terminalFailure) queued.length = 0
      for (const delta of queued) {
        if (abortKind) throw new LlmRequestError(abortKind)
        try { if (onDelta) await awaitCallback(() => onDelta(delta), controller.signal, settlement) }
        catch (error) { callbackFailed = true; callbackFailure = error; throw error }
      }
      if (parseFailure !== undefined) throw parseFailure
      return !decoder.stopped
    }

    await readBodyChunks(response.body, controller.signal, feed, {
      flushDecoder: true,
      fatalUtf8: true,
      maxBytes: stream ? maxStreamBodyBytes : LLM_RESPONSE_LIMITS.chatBodyBytes,
      ...(stream ? { maxBytesResponseLimit: 'stream-bytes' as const } : {}),
      initialChunks: probe.chunks,
      cancel: cancelResponseBody
    })
    throwIfAborted()
    if (!decoder.stopped) {
      let parseFailure: unknown
      try {
        decoder.finish()
      } catch (error) {
        parseFailure = error instanceof LlmRequestError ? error : new LlmRequestError('response')
      }
      const queued = deltas.splice(0)
      if (terminalFailure) queued.length = 0
      for (const delta of queued) {
        if (abortKind) throw new LlmRequestError(abortKind)
        try { if (onDelta) await awaitCallback(() => onDelta(delta), controller.signal, settlement) }
        catch (error) { callbackFailed = true; callbackFailure = error; throw error }
      }
      if (parseFailure !== undefined) throw parseFailure
    }
    throwIfAborted()
    if (profile.protocol === 'anthropic' && anthropicState.completed) completed = true
    if (sawStop) completed = true // EOF is also a valid terminator after finish_reason: stop.
    if (lastUsageReceipt) pendingUsageReceipt = lastUsageReceipt
    if (terminalFailure) throw terminalFailure
    if (!completed || full.trim().length === 0) throw new LlmRequestError('response')
    reportUsage()
    return full
  } catch (error) {
    if (pendingUsageReceipt) reportUsage()
    if (abortKind) throw new LlmRequestError(abortKind)
    if (callbackFailed) throw callbackFailure
    if (error instanceof LlmRequestError) throw error
    // An AbortError without our timeout/user-abort marker is an unrelated transport failure.
    throw new LlmRequestError('network')
  } finally {
    settled = true
    if (timeout !== undefined) clearTimeout(timeout)
    if (opts.signal && externalListenerAttached) {
      opts.signal.removeEventListener('abort', onExternalAbort)
    }
    if (response?.body && !response.body.locked && !response.bodyUsed) cancelResponseBody(response.body)
    if (settlement) await settlement.sealAndDrain()
  }
}

function extractOpenAiContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new LlmRequestError('response')
  const first = value.choices[0]
  if (isRecord(first) && first.finish_reason !== undefined && first.finish_reason !== null && first.finish_reason !== 'stop') {
    throw new LlmRequestError('response', undefined, { finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : undefined })
  }
  const message = isRecord(first) ? first.message : undefined
  const content = isRecord(message) ? message.content : undefined
  if (typeof content !== 'string') throw new LlmRequestError('response')
  return content
}

async function awaitCallback(invoke: () => unknown, signal: AbortSignal, settlement?: ActualSettlement): Promise<void> {
  const accepted = settlement?.capture(invoke)
  const actual = accepted ? accepted.settlement : Promise.resolve(invoke())
  // The legacy abort race also needs an observer when already aborted.
  void actual.catch(() => {})
  if (signal.aborted) throw new LlmRequestError('cancelled')
  let listener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new LlmRequestError('cancelled'))
    signal.addEventListener('abort', listener, { once: true })
  })
  try { await Promise.race([actual, aborted]) }
  finally { if (listener) signal.removeEventListener('abort', listener) }
}

/** Read and release the response reader ourselves so aborts during body reads are observable. */
async function readBodyText(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  options: { maxBytes?: number; fatalUtf8?: boolean; initialChunks?: Uint8Array[]; cancel?: BodyCanceller } = {}
): Promise<string> {
  if (!body) return ''
  let text = ''
  await readBodyChunks(body, signal, (chunk) => { text += chunk }, options)
  return text
}

async function probeStreamBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, maxBytes = LLM_RESPONSE_LIMITS.chatBodyBytes, cancelBodyReader: BodyCanceller = cancelBody): Promise<{ mode: 'json' | 'sse'; chunks: Uint8Array[] }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  let done = false
  let classified = false
  let atStreamStart = true
  const bomPrefix: number[] = []
  const classifyByte = (byte: number): 'json' | 'sse' | null => {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) return null
    classified = true
    return byte === 0x7b || byte === 0x5b ? 'json' : 'sse'
  }
  let cancelRequested = false
  const cancel = (): void => {
    if (cancelRequested) return
    cancelRequested = true
    cancelBodyReader(body, reader)
  }
  const onAbort = (): void => cancel()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) { done = true; return { mode: 'json', chunks } }
      chunks.push(result.value)
      bytesRead += result.value.byteLength
      if (bytesRead > maxBytes) throw new LlmRequestError('response', undefined, { responseLimit: 'stream-bytes' })
      for (const byte of result.value) {
        if (atStreamStart) {
          bomPrefix.push(byte)
          if (bomPrefix.length === 1 && bomPrefix[0] === 0xef || bomPrefix.length === 2 && bomPrefix[0] === 0xef && bomPrefix[1] === 0xbb) continue
          atStreamStart = false
          const hasBom = bomPrefix.length === 3 && bomPrefix[0] === 0xef && bomPrefix[1] === 0xbb && bomPrefix[2] === 0xbf
          if (!hasBom) for (const prefixByte of bomPrefix) {
            const mode = classifyByte(prefixByte)
            if (mode) return { mode, chunks }
          }
          bomPrefix.length = 0
          continue
        }
        const mode = classifyByte(byte)
        if (mode) return { mode, chunks }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!done && !classified) cancel()
    try { reader.releaseLock() } catch { /* cleanup must not mask request error */ }
  }
}

async function readBodyChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onChunk: (text: string) => boolean | void | Promise<boolean | void>,
  options: { flushDecoder?: boolean; fatalUtf8?: boolean; maxBytes?: number; maxBytesResponseLimit?: 'stream-bytes'; initialChunks?: Uint8Array[]; cancel?: BodyCanceller } = {}
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: options.fatalUtf8 ?? false })
  let finished = false
  let cancelRequested = false
  let bytesRead = 0
  const cancelReader = (): void => {
    if (cancelRequested) return
    cancelRequested = true
    const cancel = options.cancel ?? cancelBody
    cancel(body, reader)
  }
  const onAbort = (): void => cancelReader()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const consumeChunk = async (value: Uint8Array): Promise<boolean> => {
    if (options.maxBytes !== undefined) {
      if (value.byteLength > options.maxBytes - bytesRead) throw new LlmRequestError('response', undefined, options.maxBytesResponseLimit ? { responseLimit: options.maxBytesResponseLimit } : {})
      bytesRead += value.byteLength
    }
    let decoded: string
    try { decoded = decoder.decode(value, { stream: true }) } catch { throw new LlmRequestError('response') }
    return !decoded || await onChunk(decoded) !== false
  }
  try {
    for (const chunk of options.initialChunks ?? []) {
      if (!await consumeChunk(chunk)) return
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        if (options.flushDecoder !== false) {
          let tail: string
          try { tail = decoder.decode() } catch { throw new LlmRequestError('response') }
          if (tail) await onChunk(tail)
        }
        return
      }
      if (!await consumeChunk(value)) return
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!finished) cancelReader()
    try { reader.releaseLock() } catch { /* cleanup must not mask the request error */ }
  }
}

type BodyCanceller = (body: ReadableStream<Uint8Array> | null, reader?: ReadableStreamDefaultReader<Uint8Array>) => void

function cancelBody(body: ReadableStream<Uint8Array> | null, reader?: ReadableStreamDefaultReader<Uint8Array>): void {
  if (!body || !reader && body.locked) return
  try { void Promise.resolve(reader ? reader.cancel() : body.cancel()).catch(() => {}) } catch { /* best-effort cleanup */ }
}

function createBodyCanceller(settlement?: ActualSettlement): BodyCanceller {
  const cancelled = new WeakSet<ReadableStream<Uint8Array>>()
  return (body, reader): void => {
    if (!body || cancelled.has(body) || !reader && body.locked) return
    cancelled.add(body)
    if (!settlement) { cancelBody(body, reader); return }
    try { settlement.capture(() => reader ? reader.cancel() : body.cancel()) } catch { /* cleanup cannot mask the request outcome */ }
  }
}

/** 非流式对话 */
export function chatCompletion(
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: CallOptions = {}
): Promise<string> {
  return request(profile, messages, false, null, opts)
}

/** 流式对话，onDelta 实时回调增量文本 */
export function chatCompletionStream(
  profile: LlmProfile,
  messages: ChatMessage[],
  onDelta: (delta: string) => unknown,
  opts: CallOptions = {}
): Promise<string> {
  return request(profile, messages, true, onDelta, opts)
}

/** 测试配置连通性：发送一句极短的提问 */
export async function testConnection(profile: LlmProfile): Promise<TestConnectionResult> {
  try {
    await chatCompletion(
      profile,
      [
        { role: 'system', content: '你是连通性测试助手。' },
        { role: 'user', content: '请只回复：ok' }
      ],
      { timeoutMs: 30_000, maxOutputTokens: 16 }
    )
    // A connectivity check must never reflect model-generated text to the renderer.
    return { ok: true, message: '连接成功，配置可用。' }
  } catch (error) {
    if (isLlmTimeoutError(error)) {
      return { ok: false, message: '连接测试超时，请检查服务是否可用后重试。' }
    }
    return { ok: false, message: '连接测试失败，请检查网络、服务地址和配置后重试。' }
  }
}

/** 按接口规范拉取可用模型；不提供列表的服务可手动填写模型名。 */
export async function listModels(profile: LlmProfile): Promise<ListModelsResult> {
  return profile.protocol === 'anthropic' ? listAnthropicModels(profile) : listOpenAiModels(profile)
}

async function listOpenAiModels(profile: LlmProfile): Promise<ListModelsResult> {
  const controller = new AbortController()
  let timedOut = false
  let settled = false
  let response: Response | null = null
  const timer = setTimeout(() => {
    if (settled) return
    timedOut = true
    controller.abort()
  }, 20_000)
  try {
    response = await fetch(`${normalizeBaseUrl(profile.baseUrl)}/models`, {
      headers: profile.apiKey
        ? { Authorization: `Bearer ${profile.apiKey}` }
        : undefined, // Ollama 等本地服务无需 Key
      signal: controller.signal
    })
    if (timedOut) {
      return { ok: false, models: [], message: '获取模型列表超时，请检查服务是否可用后重试。' }
    }
    if (!response.ok) {
      cancelBody(response.body)
      // Do not surface provider response bodies; they may contain secrets or URLs.
      return {
        ok: false,
        models: [],
        message: `接口返回 HTTP ${response.status}。该服务可能不支持模型列表接口，可手动填写模型名。`
      }
    }
    const bodyText = await readBodyText(response.body, controller.signal, {
      maxBytes: LLM_RESPONSE_LIMITS.modelsBodyBytes,
      fatalUtf8: true
    })
    if (timedOut) {
      return { ok: false, models: [], message: '获取模型列表超时，请检查服务是否可用后重试。' }
    }
    let json: unknown
    try { json = JSON.parse(bodyText) as unknown } catch {
      return { ok: false, models: [], message: '接口返回的模型列表格式不正确，请手动填写模型名。' }
    }
    // 兼容三种返回格式：{data:[{id}...]}（OpenAI 规范）、{models:[...]}、裸数组
    const arr: unknown[] = Array.isArray(json)
      ? json
      : ((json as { data?: unknown[]; models?: unknown[] })?.data ??
        (json as { models?: unknown[] })?.models ??
        [])
    if (!Array.isArray(arr) || arr.length === 0) {
      return { ok: false, models: [], message: '接口返回了空的模型列表，请手动填写模型名。' }
    }
    if (arr.length > LLM_RESPONSE_LIMITS.modelCount) {
      return { ok: false, models: [], message: '接口返回的模型列表格式或大小超出限制，请手动填写模型名。' }
    }
    const candidates = arr.map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
    if (candidates.some((id) => typeof id === 'string' && id.length > LLM_RESPONSE_LIMITS.modelIdChars)) {
      return { ok: false, models: [], message: '接口返回的模型列表格式或大小超出限制，请手动填写模型名。' }
    }
    const ids = Array.from(
      new Set(
        candidates
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0 && !s.includes('\0') && !hasUnpairedSurrogate(s))
      )
    ).sort((a, b) => a.localeCompare(b))
    if (ids.length === 0) {
      return { ok: false, models: [], message: '接口没有返回可用的模型名称，请手动填写模型名。' }
    }
    return { ok: true, models: ids, message: `检测到 ${ids.length} 个可用模型，点击即可选择` }
  } catch (error) {
    if (timedOut) {
      return { ok: false, models: [], message: '获取模型列表超时，请检查服务是否可用后重试。' }
    }
    if (error instanceof LlmRequestError && error.kind === 'response') {
      return { ok: false, models: [], message: '接口返回的模型列表格式或大小超出限制，请手动填写模型名。' }
    }
    return { ok: false, models: [], message: '获取模型列表失败，请检查网络、服务地址和配置后重试。' }
  } finally {
    settled = true
    clearTimeout(timer)
    if (response?.body && !response.body.locked && !response.bodyUsed) cancelBody(response.body)
  }
}

const ANTHROPIC_MODELS_PAGE_SIZE = 100
const ANTHROPIC_MODELS_MAX_PAGES = Math.ceil(LLM_RESPONSE_LIMITS.modelCount / ANTHROPIC_MODELS_PAGE_SIZE)
const ANTHROPIC_MODELS_TOTAL_BYTES = 4 * 1024 * 1024

function modelsFailure(message: string): ListModelsResult {
  return { ok: false, models: [], message }
}

function finalizeModels(ids: string[]): ListModelsResult {
  const models = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
  if (models.length === 0) return modelsFailure('接口没有返回可用的模型名称，请手动填写模型名。')
  return { ok: true, models, message: `检测到 ${models.length} 个可用模型，点击即可选择` }
}

async function listAnthropicModels(profile: LlmProfile): Promise<ListModelsResult> {
  const controller = new AbortController()
  let timedOut = false
  let settled = false
  let response: Response | null = null
  const timer = setTimeout(() => {
    if (settled) return
    timedOut = true
    controller.abort()
  }, 20_000)
  const ids: string[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let totalItems = 0
  let totalBytes = 0

  try {
    for (let page = 0; page < ANTHROPIC_MODELS_MAX_PAGES; page++) {
      const url = new URL(`${normalizeBaseUrl(profile.baseUrl)}/models`)
      url.searchParams.set('limit', String(ANTHROPIC_MODELS_PAGE_SIZE))
      if (cursor) url.searchParams.set('after_id', cursor)
      response = await fetch(url, { headers: requestHeaders(profile), signal: controller.signal })
      if (timedOut) return modelsFailure('获取模型列表超时，请检查服务是否可用后重试。')
      if (!response.ok) {
        cancelBody(response.body)
        return modelsFailure(`接口返回 HTTP ${response.status}。该服务可能不支持模型列表接口，可手动填写模型名。`)
      }

      const bodyText = await readBodyText(response.body, controller.signal, {
        maxBytes: LLM_RESPONSE_LIMITS.modelsBodyBytes,
        fatalUtf8: true
      })
      totalBytes += Buffer.byteLength(bodyText, 'utf8')
      if (timedOut) return modelsFailure('获取模型列表超时，请检查服务是否可用后重试。')
      if (totalBytes > ANTHROPIC_MODELS_TOTAL_BYTES) {
        return modelsFailure('接口返回的模型列表格式或大小超出限制，请手动填写模型名。')
      }

      let parsed: unknown
      try { parsed = JSON.parse(bodyText) as unknown } catch {
        return modelsFailure('接口返回的模型列表格式不正确，请手动填写模型名。')
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
        return modelsFailure('接口返回的模型列表格式不正确，请手动填写模型名。')
      }
      if (parsed.has_more !== undefined && typeof parsed.has_more !== 'boolean') {
        return modelsFailure('接口返回的模型列表格式不正确，请手动填写模型名。')
      }
      totalItems += parsed.data.length
      if (totalItems > LLM_RESPONSE_LIMITS.modelCount) {
        return modelsFailure('接口返回的模型列表格式或大小超出限制，请手动填写模型名。')
      }
      for (const item of parsed.data) {
        if (!isRecord(item) || typeof item.id !== 'string') continue
        if (item.id.length > LLM_RESPONSE_LIMITS.modelIdChars) {
          return modelsFailure('接口返回的模型列表格式或大小超出限制，请手动填写模型名。')
        }
        if (item.id.trim().length > 0 && !item.id.includes('\0') && !hasUnpairedSurrogate(item.id)) ids.push(item.id)
      }

      if (parsed.has_more !== true) return finalizeModels(ids)
      const nextCursor = parsed.last_id
      if (
        typeof nextCursor !== 'string' || nextCursor.length === 0 ||
        nextCursor.length > LLM_RESPONSE_LIMITS.modelIdChars || nextCursor.includes('\0') ||
        hasUnpairedSurrogate(nextCursor) || seenCursors.has(nextCursor) || nextCursor === cursor
      ) {
        return modelsFailure('接口返回的模型列表格式不正确，请手动填写模型名。')
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    return modelsFailure('接口返回的模型列表格式或大小超出限制，请手动填写模型名。')
  } catch (error) {
    if (timedOut) return modelsFailure('获取模型列表超时，请检查服务是否可用后重试。')
    if (error instanceof LlmRequestError && error.kind === 'response') {
      return modelsFailure('接口返回的模型列表格式或大小超出限制，请手动填写模型名。')
    }
    return modelsFailure('获取模型列表失败，请检查网络、服务地址和配置后重试。')
  } finally {
    settled = true
    clearTimeout(timer)
    if (response?.body && !response.body.locked && !response.bodyUsed) cancelBody(response.body)
  }
}
