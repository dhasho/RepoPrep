// OpenAI 兼容大模型客户端（主进程中调用，避免渲染进程跨域与密钥暴露）
import type { ListModelsResult, LlmProfile, TestConnectionResult } from '@shared/types'
// @ts-ignore TS5097 -- the direct Node test runner needs explicit TypeScript extensions.
import { SseDecoder } from './sse-parser.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmRequestErrorKind = 'timeout' | 'cancelled' | 'network' | 'http' | 'response'

const ERROR_MESSAGES: Record<LlmRequestErrorKind, string> = {
  timeout: '请求超时，请重试。',
  cancelled: '请求已取消。',
  network: '网络请求失败，请检查网络和服务配置后重试。',
  http: '大模型服务返回错误。',
  response: '大模型服务返回内容格式不正确。'
}

/** Safe request failure; messages never include endpoint, provider body, or credentials. */
export class LlmRequestError extends Error {
  readonly kind: LlmRequestErrorKind

  constructor(kind: LlmRequestErrorKind, message = ERROR_MESSAGES[kind]) {
    super(message)
    this.name = 'LlmRequestError'
    this.kind = kind
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
  return `${normalizeBaseUrl(profile.baseUrl)}/chat/completions`
}

interface CallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputTokens?: number
}

const MAX_LLM_STREAM_CHARS = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  onDelta: ((delta: string) => void) | null,
  opts: CallOptions
): Promise<string> {
  const controller = new AbortController()
  let abortKind: 'timeout' | 'cancelled' | null = null
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let externalListenerAttached = false
  let response: Response | null = null
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

    response = await fetch(endpoint(profile), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature ?? 0.4,
        stream,
        ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {})
      }),
      signal: controller.signal
    })
    throwIfAborted()

    if (!response.ok) {
      cancelBody(response.body)
      throw new LlmRequestError('http', `大模型服务返回 HTTP ${response.status}。`)
    }

    if (!stream) {
      const text = await readBodyText(response.body, controller.signal)
      throwIfAborted()
      let json: { choices?: { message?: { content?: string } }[] }
      try {
        json = JSON.parse(text) as typeof json
      } catch {
        throw new LlmRequestError('response')
      }
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new LlmRequestError('response')
      throwIfAborted()
      return content
    }

    // SSE 流式解析
    if (!response.body) throw new LlmRequestError('response')
    let full = ''
    let completed = false
    let sawStop = false
    let callbackFailed = false
    let callbackFailure: unknown
    const decoder = new SseDecoder((event) => {
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
            if (full.length + content.length > MAX_LLM_STREAM_CHARS) throw new LlmRequestError('response')
            full += content
            try {
              onDelta?.(content)
            } catch (error) {
              callbackFailed = true
              callbackFailure = error
              throw error
            }
          }
        }
      }

      const finishReason = selected.finish_reason
      if (finishReason === undefined || finishReason === null) return
      if (finishReason === 'stop') {
        sawStop = true
        return
      }
      throw new LlmRequestError('response')
    }, { maxBufferChars: MAX_LLM_STREAM_CHARS })

    const feed = (decoded: string): boolean => {
      try {
        decoder.push(decoded)
      } catch (error) {
        if (callbackFailed) throw callbackFailure
        if (error instanceof LlmRequestError) throw error
        throw new LlmRequestError('response')
      }
      return !decoder.stopped
    }

    await readBodyChunks(response.body, controller.signal, feed, { flushDecoder: true, fatalUtf8: true })
    throwIfAborted()
    if (!decoder.stopped) {
      try {
        decoder.finish()
      } catch (error) {
        if (callbackFailed) throw callbackFailure
        if (error instanceof LlmRequestError) throw error
        throw new LlmRequestError('response')
      }
    }
    throwIfAborted()
    if (sawStop) completed = true // EOF is also a valid terminator after finish_reason: stop.
    if (!completed || full.trim().length === 0) throw new LlmRequestError('response')
    return full
  } catch (error) {
    if (abortKind) throw new LlmRequestError(abortKind)
    if (error instanceof LlmRequestError) throw error
    // An AbortError without our timeout/user-abort marker is an unrelated transport failure.
    throw new LlmRequestError('network')
  } finally {
    settled = true
    if (timeout !== undefined) clearTimeout(timeout)
    if (opts.signal && externalListenerAttached) {
      opts.signal.removeEventListener('abort', onExternalAbort)
    }
    if (response?.body && !response.body.locked && !response.bodyUsed) cancelBody(response.body)
  }
}

/** Read and release the response reader ourselves so aborts during body reads are observable. */
async function readBodyText(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal
): Promise<string> {
  if (!body) return ''
  let text = ''
  await readBodyChunks(body, signal, (chunk) => { text += chunk })
  return text
}

async function readBodyChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onChunk: (text: string) => boolean | void,
  options: { flushDecoder?: boolean; fatalUtf8?: boolean } = {}
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: options.fatalUtf8 ?? false })
  let finished = false
  let cancelRequested = false
  const cancelReader = (): void => {
    if (cancelRequested) return
    cancelRequested = true
    try { void reader.cancel().catch(() => undefined) } catch { /* cleanup must not mask the request error */ }
  }
  const onAbort = (): void => cancelReader()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        if (options.flushDecoder !== false) {
          let tail: string
          try { tail = decoder.decode() } catch { throw new LlmRequestError('response') }
          if (tail) onChunk(tail)
        }
        return
      }
      let decoded: string
      try { decoded = decoder.decode(value, { stream: true }) } catch { throw new LlmRequestError('response') }
      if (decoded && onChunk(decoded) === false) return
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!finished) cancelReader()
    try { reader.releaseLock() } catch { /* cleanup must not mask the request error */ }
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || body.locked) return
  try { void body.cancel().catch(() => undefined) } catch { /* best-effort cleanup */ }
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
  onDelta: (delta: string) => void,
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

/** 拉取该 Key 可用的模型列表（GET /models，OpenAI 兼容格式） */
export async function listModels(profile: LlmProfile): Promise<ListModelsResult> {
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
    const bodyText = await readBodyText(response.body, controller.signal)
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
    const ids = Array.from(
      new Set(
        arr
          .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b))
    return { ok: true, models: ids, message: `检测到 ${ids.length} 个可用模型，点击即可选择` }
  } catch {
    if (timedOut) {
      return { ok: false, models: [], message: '获取模型列表超时，请检查服务是否可用后重试。' }
    }
    return { ok: false, models: [], message: '获取模型列表失败，请检查网络、服务地址和配置后重试。' }
  } finally {
    settled = true
    clearTimeout(timer)
    if (response?.body && !response.body.locked && !response.bodyUsed) cancelBody(response.body)
  }
}
