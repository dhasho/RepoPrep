import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- direct Node tests require runtime .ts imports.
import { effectiveProtocol, findProviderPreset, mappedProviderPreset, PROVIDER_PRESETS } from './provider-presets.ts'
// @ts-ignore TS5097 -- direct Node tests require runtime .ts imports.
import type { LlmProfileDraft } from '../../shared/types.ts'

const profile = (overrides: Partial<LlmProfileDraft> = {}): LlmProfileDraft => ({
  id: 'profile',
  name: 'Profile',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  apiKey: '',
  ...overrides
})

test('legacy profiles default to OpenAI and recognized provider presets map across protocols', () => {
  const legacy = profile()
  assert.equal(effectiveProtocol(legacy), 'openai')
  assert.equal(findProviderPreset(legacy)?.id, 'deepseek')
  assert.deepEqual(mappedProviderPreset(legacy, 'anthropic'), {
    preset: PROVIDER_PRESETS.anthropic.find((preset) => preset.id === 'deepseek'),
    model: 'deepseek-flash'
  })
  assert.equal(mappedProviderPreset(profile({ protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' }), 'openai')?.preset.model, 'deepseek-flash')
})

test('known provider URL maps protocol while retaining a custom model, but custom URL is untouched', () => {
  const mapping = mappedProviderPreset(profile({ model: 'deepseek-v4-flash' }), 'anthropic')
  assert.equal(mapping?.preset.baseUrl, 'https://api.deepseek.com/anthropic')
  assert.equal(mapping?.model, 'deepseek-v4-flash')
  assert.equal(mappedProviderPreset(profile({ baseUrl: 'https://custom.invalid/v1' }), 'anthropic'), null)
})

test('Anthropic provider list excludes the Kimi endpoint with a different auth contract', () => {
  assert.deepEqual(PROVIDER_PRESETS.openai.map((preset) => preset.id), ['deepseek', 'zhipu', 'qwen', 'kimi', 'openai', 'ollama'])
  assert.deepEqual(PROVIDER_PRESETS.anthropic.map((preset) => preset.id), ['anthropic', 'deepseek', 'zhipu', 'qwen', 'ollama'])
  assert.equal(PROVIDER_PRESETS.anthropic.find((preset) => preset.id === 'zhipu')?.model, 'glm-5.3')
  assert.ok(!PROVIDER_PRESETS.anthropic.some((preset) => preset.id === 'kimi'))
})
