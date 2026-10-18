import type { LlmProfileDraft, LlmProtocol } from '@shared/types'

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  model: string
  hint: string
}

export interface ProviderMapping {
  preset: ProviderPreset
  model: string
}

/** URL and model values from the providers' official OpenAI-compatible documentation. */
const openAiPresets: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', hint: 'platform.deepseek.com' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', hint: 'open.bigmodel.cn' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: '阿里云百炼' },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', hint: 'platform.moonshot.cn' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: 'platform.openai.com' },
  { id: 'ollama', name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', hint: '本地运行，无需 Key' }
]

/** URLs and model IDs verified against the providers' Anthropic-compatible documentation. */
const anthropicPresets: ProviderPreset[] = [
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', hint: 'platform.claude.com' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', hint: 'api-docs.deepseek.com' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3', hint: 'docs.bigmodel.cn' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen-plus', hint: '阿里云百炼' },
  { id: 'ollama', name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder', hint: '本地运行，无需 Key' }
]

export const PROVIDER_PRESETS: Record<LlmProtocol, readonly ProviderPreset[]> = {
  openai: openAiPresets,
  anthropic: anthropicPresets
}

export function effectiveProtocol(profile: Pick<LlmProfileDraft, 'protocol'>): LlmProtocol {
  return profile.protocol ?? 'openai'
}

export function canonicalEndpoint(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null
    return parsed.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Resolve a provider by its canonical protocol-specific URL; the model may be custom. */
export function findProviderPreset(profile: Pick<LlmProfileDraft, 'protocol' | 'baseUrl' | 'model'>): ProviderPreset | null {
  const protocol = effectiveProtocol(profile)
  const endpoint = canonicalEndpoint(profile.baseUrl)
  if (!endpoint) return null
  return PROVIDER_PRESETS[protocol].find((preset) =>
    canonicalEndpoint(preset.baseUrl) === endpoint
  ) ?? null
}

export function mappedProviderPreset(profile: Pick<LlmProfileDraft, 'protocol' | 'baseUrl' | 'model'>, target: LlmProtocol): ProviderMapping | null {
  const source = findProviderPreset(profile)
  const preset = source ? PROVIDER_PRESETS[target].find((item) => item.id === source.id) : undefined
  if (!source || !preset) return null
  return {
    preset,
    model: profile.model === source.model ? preset.model : profile.model
  }
}
