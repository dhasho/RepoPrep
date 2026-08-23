// OpenAI 兼容大模型客户端（主进程中调用，避免渲染进程跨域与密钥暴露）
import type { ListModelsResult, LlmProfile, TestConnectionResult } from '@shared/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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

async function request(
  profile: LlmProfile,
  messages: ChatMessage[],
  stream: boolean,
  onDelta: ((delta: string) => void) | null,
  opts: CallOptions
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 300_000)
  // 支持外部取消（生成取消按钮）
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const res = await fetch(endpoint(profile), {
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

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`接口返回 ${res.status}：${text.slice(0, 500) || res.statusText}`)
    }

    if (!stream) {
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('接口返回内容为空或格式不正确')
      return content
    }

    // SSE 流式解析
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let full = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const payload = s.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[]
          }
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            onDelta?.(delta)
          }
        } catch {
          /* 忽略无法解析的 chunk */
        }
      }
    }
    return full
  } finally {
    clearTimeout(timeout)
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
  onDelta: (delta: string) => void,
  opts: CallOptions = {}
): Promise<string> {
  return request(profile, messages, true, onDelta, opts)
}

/** 测试配置连通性：发送一句极短的提问 */
export async function testConnection(profile: LlmProfile): Promise<TestConnectionResult> {
  try {
    const reply = await chatCompletion(
      profile,
      [
        { role: 'system', content: '你是连通性测试助手。' },
        { role: 'user', content: '请只回复：ok' }
      ],
      { timeoutMs: 30_000, maxOutputTokens: 16 }
    )
    return { ok: true, message: `连接成功，模型「${profile.model}」可用，示例回复：${reply.slice(0, 50)}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `连接失败：${msg}` }
  }
}

/** 拉取该 Key 可用的模型列表（GET /models，OpenAI 兼容格式） */
export async function listModels(profile: LlmProfile): Promise<ListModelsResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(`${normalizeBaseUrl(profile.baseUrl)}/models`, {
      headers: profile.apiKey
        ? { Authorization: `Bearer ${profile.apiKey}` }
        : undefined, // Ollama 等本地服务无需 Key
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        models: [],
        message: `接口返回 ${res.status}：${text.slice(0, 200) || res.statusText}。该服务商可能不支持模型列表接口，可手动填写模型名。`
      }
    }
    const json = (await res.json()) as unknown
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, models: [], message: `获取模型列表失败：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}
