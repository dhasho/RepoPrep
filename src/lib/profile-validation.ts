import type { LlmProfileDraft } from '@shared/types'
import { LLM_PROFILE_LIMITS, MAX_LLM_PROFILES } from '@shared/result-contract'

export type ProfileField = 'id' | 'name' | 'baseUrl' | 'apiKey' | 'model'

export interface ProfileValidationError {
  profileIndex: number
  field: ProfileField
  message: string
}

const FIELD_LABELS: Record<ProfileField, string> = {
  id: '配置标识',
  name: '配置名称',
  baseUrl: '接口地址',
  apiKey: 'API Key',
  model: '模型名'
}

const FIELD_LIMITS: Record<ProfileField, number> = LLM_PROFILE_LIMITS

function profileFieldError(value: string, field: ProfileField): string | null {
  const label = FIELD_LABELS[field]
  const limit = FIELD_LIMITS[field]
  if (value.length > limit) return `${label}不得超过 ${limit} 个字符`
  if (value.includes('\0')) return `${label}不能包含空字符`
  if (field === 'id' && value.length === 0) return '配置标识不能为空，请删除后重新创建'
  if (field === 'name' || field === 'model') {
    return value.trim() ? null : `${label}不能为空`
  }
  if (field === 'baseUrl') {
    if (!value) return `${label}不能为空`
    let parsed: URL
    try { parsed = new URL(value) } catch { return '接口地址必须是有效的 HTTP(S) 地址' }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
      return '接口地址必须是有效的 HTTP(S) 地址'
    }
    if (parsed.username || parsed.password) return '接口地址不能包含用户名或密码'
  }
  return null
}

export function validateProfiles(profiles: readonly LlmProfileDraft[]): ProfileValidationError[] {
  const errors: ProfileValidationError[] = []
  profiles.forEach((profile, profileIndex) => {
    for (const field of ['id', 'name', 'baseUrl', 'apiKey', 'model'] as const) {
      const value = field === 'apiKey' ? profile.apiKey ?? '' : profile[field]
      const message = profileFieldError(value, field)
      if (message) errors.push({ profileIndex, field, message })
    }
  })
  return errors
}

export function profileFieldErrorId(profileIndex: number, field: ProfileField): string {
  return `profile-${profileIndex}-${field}-error`
}

export { FIELD_LABELS, MAX_LLM_PROFILES }
