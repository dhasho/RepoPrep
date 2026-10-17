// 设置页：大模型配置管理（OpenAI 兼容接口，支持检测 Key 可用模型列表）
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LlmProfileDraft, PublicSettings, SettingsSaveRequest } from '@shared/types'
import type { ScanLimits } from '@shared/types'
import { DEFAULT_SCAN_LIMITS, SCAN_LIMIT_BOUNDS } from '@shared/types'
import { api } from '../lib/ipc'
import { SettingsSaveFlow } from '../lib/settings-save'
import { ModelDetectionController, modelStateOf } from '../lib/model-detection'
import { ConnectionTestController } from '../lib/connection-test'
import { parseScanLimitDraft, scanLimitDraftOf, type ScanLimitDraft, type ScanLimitErrors } from '../lib/scan-limit-input'
import { MAX_LLM_PROFILES, profileFieldErrorId, validateProfiles, type ProfileField, type ProfileValidationError } from '../lib/profile-validation'

interface Props {
  settings: PublicSettings
  onSaved: (s: PublicSettings) => void
  onBack: () => void
}

/** 常见服务商快捷模板（baseUrl + 默认模型，API Key 需自行填写） */
const PRESETS: { name: string; baseUrl: string; model: string; hint: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: 'platform.deepseek.com' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', hint: 'open.bigmodel.cn' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: '阿里云百炼' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', hint: 'platform.moonshot.cn' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: '需海外网络' },
  { name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', hint: '本地运行，无需 Key' }
]

const emptyProfile = (): LlmProfileDraft => ({
  id: `profile-${Date.now()}`,
  name: '新配置',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  hasApiKey: false,
  credentialStatus: 'missing',
  credentialAction: 'replace',
  model: 'deepseek-chat',
  temperature: 0.4
})

function canonicalEndpoint(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null
    return parsed.href.replace(/\/+$/, '')
  } catch { return null }
}

export default function SettingsPage({ settings, onSaved, onBack }: Props) {
  const savedBaseUrls = useRef(new Map(settings.profiles.map((profile) => [profile.id, profile.baseUrl])))
  const [profiles, setProfiles] = useState<LlmProfileDraft[]>(() => settings.profiles.map((profile) => ({ ...profile, apiKey: '', credentialAction: 'keep' })))
  const [defaultId, setDefaultId] = useState<string | null>(settings.defaultProfileId)
  const [selectedId, setSelectedId] = useState<string>(
    settings.defaultProfileId ?? settings.profiles[0]?.id ?? ''
  )
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [scanLimitDraft, setScanLimitDraft] = useState<ScanLimitDraft>(() => scanLimitDraftOf(settings.scanLimits))
  const [scanLimitErrors, setScanLimitErrors] = useState<ScanLimitErrors>({})
  const [profileErrors, setProfileErrors] = useState<ProfileValidationError[]>([])
  // 保存必须等待主进程写盘结果（issue #15）：保存中防重复提交；
  // 失败时不清除 dirty、显示可操作错误；带未保存修改返回时先提示
  const saveFlow = useMemo(() => new SettingsSaveFlow(api), [])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  // 模型列表检测：状态按 profile 隔离、竞态由控制器统一处理（issue #14）。
  // 响应只写回发起它的配置；换 Base URL / API Key 或快速重复检测时，
  // 过期的响应（无论成败）都会被丢弃，不会显示误导性内容。
  const detection = useMemo(() => new ModelDetectionController({ listModels: api.listModels }), [])
  const modelSlots = useSyncExternalStore(detection.subscribe, detection.getSnapshot, detection.getSnapshot)
  const modelState = modelStateOf(modelSlots, selectedId)
  const connectionTest = useMemo(() => new ConnectionTestController({ testLlm: api.testLlm }), [])
  const connectionTestState = useSyncExternalStore(
    connectionTest.subscribe,
    connectionTest.getSnapshot,
    connectionTest.getSnapshot
  )
  const currentTest = connectionTestState.profileId === selectedId ? connectionTestState : null
  const [modelFilter, setModelFilter] = useState('')

  useEffect(() => {
    connectionTest.activate()
    return () => connectionTest.dispose()
  }, [connectionTest])

  const selected = profiles.find((p) => p.id === selectedId) ?? null
  const selectedIndex = profiles.findIndex((p) => p.id === selectedId)
  const profileError = (field: ProfileField) => profileErrors.find((error) => error.profileIndex === selectedIndex && error.field === field)
  const usesSavedCredential = (profile: LlmProfileDraft) => {
    const savedEndpoint = canonicalEndpoint(savedBaseUrls.current.get(profile.id) ?? '')
    const currentEndpoint = canonicalEndpoint(profile.baseUrl)
    return !profile.apiKey && profile.hasApiKey === true &&
      (profile.credentialAction ?? 'keep') === 'keep' &&
      savedEndpoint !== null && savedEndpoint === currentEndpoint
  }

  const patchSelected = (patch: Partial<LlmProfileDraft>) => {
    connectionTest.invalidate()
    const nextProfiles = profiles.map((p) => (p.id === selectedId ? {
      ...p,
      ...patch,
      ...(patch.apiKey !== undefined && patch.credentialAction === undefined
        ? { credentialAction: patch.apiKey ? 'replace' as const : (p.hasApiKey ? 'keep' as const : (p.credentialAction === 'clear' ? 'clear' as const : 'replace' as const)) }
        : {})
    } : p))
    setProfiles(nextProfiles)
    setProfileErrors(validateProfiles(nextProfiles))
    setSaveError((error) => error?.startsWith('配置 ') ? null : error)
    setDirty(true)
    setSaved(false)
    saveFlow.markLocalEdit()
    // 换了接口地址或 Key：取消（失效）进行中的检测并清空旧列表（issue #14）
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined || patch.credentialAction !== undefined) {
      detection.invalidate(selectedId)
    }
  }

  /** 调用主进程 GET /models 检测该 Key 可用的模型（竞态处理见 model-detection.ts） */
  const detectModels = () => {
    if (!selected) return
    setModelFilter('')
    detection.detect({ ...selected, useSavedCredential: usesSavedCredential(selected) })
  }

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase()
    return q ? modelState.models.filter((m) => m.toLowerCase().includes(q)) : modelState.models
  }, [modelState.models, modelFilter])

  /**
   * 保存设置：等待主进程确认写盘成功后才更新本地"已保存"状态（issue #15）。
   * 写盘失败时保留 dirty 与未保存提示，展示主进程返回的可操作错误；
   * 保存期间又发生了本地修改（hasEditsDuringSave）时这些修改未持久化，dirty 保持 true。
   */
  const save = async () => {
    if (saving) return // 防重复提交（按钮同时禁用，流程控制器也会拒绝并发保存）
    if (profiles.length > MAX_LLM_PROFILES) {
      setSaved(false)
      setSaveError(`配置数量不得超过 ${MAX_LLM_PROFILES} 项`)
      return
    }
    const endpointChangedWithSavedKey = profiles.findIndex((profile) => {
      const savedEndpoint = canonicalEndpoint(savedBaseUrls.current.get(profile.id) ?? '')
      const currentEndpoint = canonicalEndpoint(profile.baseUrl)
      return profile.hasApiKey && (profile.credentialAction ?? 'keep') === 'keep' &&
        (savedEndpoint === null || savedEndpoint !== currentEndpoint)
    })
    if (endpointChangedWithSavedKey >= 0) {
      setSelectedId(profiles[endpointChangedWithSavedKey].id)
      setSaved(false)
      setSaveError(`配置 ${endpointChangedWithSavedKey + 1}：接口地址已变更，请输入新 Key 或清除已保存的 Key`)
      return
    }
    const invalidProfiles = validateProfiles(profiles)
    setProfileErrors(invalidProfiles)
    if (invalidProfiles.length) {
      setSaved(false)
      const firstError = invalidProfiles[0]
      setSelectedId(profiles[firstError.profileIndex].id)
      setSaveError(`配置 ${firstError.profileIndex + 1}：${firstError.message}`)
      return
    }
    const parsedLimits = parseScanLimitDraft(scanLimitDraft)
    setScanLimitErrors(parsedLimits.errors)
    if (!parsedLimits.value) return
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    connectionTest.invalidate()
    setConfirmDiscard(false)
    try {
      const next: SettingsSaveRequest = {
        profiles,
        defaultProfileId: profiles.some((profile) => profile.id === defaultId) ? defaultId : profiles[0]?.id ?? null,
        scanLimits: parsedLimits.value
      }
      const readback: { settings: PublicSettings | null } = { settings: null }
      const result = await saveFlow.save(next, async () => {
        readback.settings = await api.getSettings()
      })
      if (result.outcome === 'saved') {
        const currentDraftSaved = !result.hasEditsDuringSave
        const savedSettings = readback.settings
        if (!savedSettings) throw new Error('设置已保存，但读取状态失败，请重试')
        savedBaseUrls.current = new Map(savedSettings.profiles.map((profile) => [profile.id, profile.baseUrl]))
        onSaved(savedSettings)
        for (const submitted of next.profiles) detection.invalidate(submitted.id)
        setProfiles((current) => current.map((profile) => {
          const submitted = next.profiles.find((item) => item.id === profile.id)
          const savedProfile = savedSettings.profiles.find((item) => item.id === profile.id)
          if (!submitted || !savedProfile) return profile
          const sameCredentialIntent = profile.apiKey === submitted.apiKey &&
            (profile.credentialAction ?? 'keep') === (submitted.credentialAction ?? 'keep')
          return {
            ...profile,
            name: profile.name === submitted.name ? savedProfile.name : profile.name,
            baseUrl: profile.baseUrl === submitted.baseUrl ? savedProfile.baseUrl : profile.baseUrl,
            model: profile.model === submitted.model ? savedProfile.model : profile.model,
            temperature: profile.temperature === submitted.temperature ? savedProfile.temperature : profile.temperature,
            ...(sameCredentialIntent ? {
              apiKey: '',
              credentialAction: 'keep' as const,
              hasApiKey: savedProfile.hasApiKey,
              credentialStatus: savedProfile.credentialStatus
            } : {})
          }
        }))
        setSaved(currentDraftSaved)
        if (currentDraftSaved) setDirty(false)
      }
    } catch (e) {
      setSaved(false)
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** 带未保存修改时第一次点击先提示，确认后才真正返回（issue #15） */
  const handleBack = () => {
    if (!dirty || confirmDiscard) {
      onBack()
      return
    }
    setConfirmDiscard(true)
  }

  const addProfile = () => {
    if (profiles.length >= MAX_LLM_PROFILES) return
    const p = emptyProfile()
    const nextProfiles = [...profiles, p]
    setProfiles(nextProfiles)
    setProfileErrors(validateProfiles(nextProfiles))
    setSaveError((error) => error?.startsWith('配置 ') ? null : error)
    setSelectedId(p.id)
    setDirty(true)
    setSaved(false)
    connectionTest.invalidate()
    saveFlow.markLocalEdit()
    setModelFilter('')
    detection.hideList(selectedId)
  }

  const removeProfile = () => {
    if (!selected) return
    const rest = profiles.filter((p) => p.id !== selected.id)
    connectionTest.invalidate()
    detection.invalidate(selected.id) // 该配置已删除，进行中的检测作废
    setProfiles(rest)
    setProfileErrors(validateProfiles(rest))
    setSaveError((error) => error?.startsWith('配置 ') ? null : error)
    if (defaultId === selected.id) setDefaultId(rest[0]?.id ?? null)
    setSelectedId(rest[0]?.id ?? '')
    setDirty(true)
    setSaved(false)
    saveFlow.markLocalEdit()
    setModelFilter('')
  }

  const runTest = async () => {
    if (!selected) return
    await connectionTest.run({ ...selected, useSavedCredential: usesSavedCredential(selected) })
  }

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">大模型配置</h1>
          <p className="mt-1 text-sm text-slate-500">
            兼容所有 OpenAI 接口规范的服务商（DeepSeek / 智谱 GLM / 通义千问 / Kimi / OpenAI / Ollama 等）。
          </p>
        </div>
        <button className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100" onClick={handleBack}>
          ← 返回
        </button>
      </div>

      {confirmDiscard && dirty && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <span className="text-sm text-amber-700">有未保存的修改，直接返回将丢失这些修改。</span>
          <div className="flex gap-2">
            <button
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-100"
              onClick={() => setConfirmDiscard(false)}
            >
              继续编辑
            </button>
            <button
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
              onClick={onBack}
            >
              放弃修改并返回
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[220px_1fr] gap-5">
        {/* 配置列表 */}
        <div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {profiles.map((p, i) => (
              <button
                key={p.id}
                aria-invalid={Boolean(profileErrors.some((error) => error.profileIndex === i && error.field === 'id'))}
                aria-describedby={profileErrors.some((error) => error.profileIndex === i && error.field === 'id') ? profileFieldErrorId(i, 'id') : undefined}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm ${
                  i > 0 ? 'border-t border-slate-100' : ''
                } ${p.id === selectedId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-50'}`}
                onClick={() => {
                  connectionTest.invalidate()
                  setSelectedId(p.id)
                  setSaved(false)
                  // 检测状态按 profile 隔离，切回时各自恢复；只重置过滤词，
                  // 并收起上一次展开的列表（避免下拉带着 autoFocus 抢焦点）
                  setModelFilter('')
                  detection.hideList(p.id)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.id === defaultId && <span className="shrink-0 text-[10px] text-emerald-500">默认</span>}
              </button>
            ))}
          </div>
          <button
            className="mt-2 w-full rounded-lg border border-dashed border-slate-300 py-2 text-sm text-slate-500 hover:border-indigo-400 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={addProfile}
            disabled={profiles.length >= MAX_LLM_PROFILES}
          >
            ＋ 新增配置
          </button>
          <p className="mt-1 text-center text-xs text-slate-400">配置数量：{profiles.length}/{MAX_LLM_PROFILES}</p>
        </div>

        {/* 编辑区 */}
        {selected ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            {profileError('id') && <p id={profileFieldErrorId(selectedIndex, 'id')} className="mb-3 text-xs text-rose-600">{profileError('id')?.message}</p>}
            <div className="mb-4 flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-400 hover:text-indigo-600"
                  title={`${preset.hint} · ${preset.baseUrl}`}
                  onClick={() => patchSelected({ baseUrl: preset.baseUrl, model: preset.model })}
                >
                  {preset.name}
                </button>
              ))}
            </div>

            <div className="space-y-4">
              <Field label="配置名称">
                <input
                  className={inputCls}
                  value={selected.name}
                  aria-invalid={Boolean(profileError('name'))}
                  aria-describedby={profileError('name') ? profileFieldErrorId(selectedIndex, 'name') : undefined}
                  onChange={(e) => patchSelected({ name: e.target.value })}
                  placeholder="如：DeepSeek 日常用"
                />
                {profileError('name') && <p id={profileFieldErrorId(selectedIndex, 'name')} className="mt-1 text-xs text-rose-600">{profileError('name')?.message}</p>}
              </Field>
              <Field label="接口地址 Base URL">
                <input
                  className={inputCls}
                  value={selected.baseUrl}
                  aria-invalid={Boolean(profileError('baseUrl'))}
                  aria-describedby={profileError('baseUrl') ? profileFieldErrorId(selectedIndex, 'baseUrl') : undefined}
                  onChange={(e) => patchSelected({ baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                />
                {profileError('baseUrl') && <p id={profileFieldErrorId(selectedIndex, 'baseUrl')} className="mt-1 text-xs text-rose-600">{profileError('baseUrl')?.message}</p>}
              </Field>
              <Field label="API Key">
                <input
                  className={inputCls}
                  type="password"
                  value={selected.apiKey ?? ''}
                  aria-invalid={Boolean(profileError('apiKey'))}
                  aria-describedby={profileError('apiKey') ? profileFieldErrorId(selectedIndex, 'apiKey') : undefined}
                  onChange={(e) => patchSelected({ apiKey: e.target.value })}
                  onBlur={() => {
                    // 粘贴完 Key 失焦时自动检测一次可用模型
                    if (
                      selected.apiKey?.trim() &&
                      selected.baseUrl.trim() &&
                      modelState.models.length === 0 &&
                      !modelState.loading
                    ) {
                      detectModels()
                    }
                  }}
                  placeholder={selected.hasApiKey ? '已保存的 Key 不会显示；输入新 Key 可替换' : '输入 API Key；Ollama 等本地服务可留空'}
                />
                {profileError('apiKey') && <p id={profileFieldErrorId(selectedIndex, 'apiKey')} className="mt-1 text-xs text-rose-600">{profileError('apiKey')?.message}</p>}
                <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                  {(selected.credentialStatus === 'locked' || selected.credentialStatus === 'migration-pending') && <span>{selected.credentialStatus === 'locked' ? '系统凭据存储暂不可用' : '旧 Key 等待安全迁移'}</span>}
                  {selected.credentialAction === 'clear'
                    ? <><span className="text-amber-700">保存后清除已保存的 Key</span><button className="hover:underline" onClick={() => patchSelected({ credentialAction: 'keep' })}>保留已保存的 Key</button></>
                    : selected.credentialAction === 'replace'
                      ? <><span className="text-amber-700">{selected.hasApiKey ? '保存时使用新 Key 替换' : '保存新 Key'}</span>{selected.hasApiKey && <><button className="hover:underline" onClick={() => patchSelected({ apiKey: '', credentialAction: 'keep' })}>保留已保存的 Key</button><button className="text-rose-600 hover:underline" onClick={() => patchSelected({ apiKey: '', credentialAction: 'clear' })}>清除已保存的 Key</button></>}</>
                      : <><span>{selected.credentialStatus === 'locked' || selected.credentialStatus === 'migration-pending' ? (selected.hasApiKey ? '已保存 Key' : '未保存 Key（本地服务可留空）') : selected.hasApiKey ? 'Key 已加密保护' : '未保存 Key（本地服务可留空）'}</span>{selected.hasApiKey && <button className="text-rose-600 hover:underline" onClick={() => patchSelected({ credentialAction: 'clear' })}>清除已保存的 Key</button>}</>}
                </div>
              </Field>
              <Field label="模型名">
                <div className="relative">
                  <div className="flex gap-2">
                    <input
                      className={inputCls}
                      value={selected.model}
                      aria-invalid={Boolean(profileError('model'))}
                      aria-describedby={profileError('model') ? profileFieldErrorId(selectedIndex, 'model') : undefined}
                      onChange={(e) => patchSelected({ model: e.target.value })}
                      placeholder="deepseek-chat，或点右侧按钮检测"
                    />
                    <button
                      className="shrink-0 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-100 disabled:opacity-60"
                      onClick={detectModels}
                      disabled={modelState.loading}
                    >
                      {modelState.loading ? '检测中…' : '🔍 检测可用模型'}
                    </button>
                  </div>
                  {profileError('model') && <p id={profileFieldErrorId(selectedIndex, 'model')} className="mt-1 text-xs text-rose-600">{profileError('model')?.message}</p>}
                  {modelState.message && (
                    <p className={`mt-1.5 text-xs ${modelState.messageOk ? 'text-emerald-600' : 'text-slate-500'}`}>
                      {modelState.messageOk ? '✓ ' : ''}
                      {modelState.message}
                    </p>
                  )}
                  {modelState.showList && modelState.models.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-20 mt-1.5 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                      <div className="flex items-center gap-2 border-b border-slate-100 p-2">
                        <input
                          autoFocus
                          className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
                          placeholder="输入关键字过滤，回车选择第一个"
                          value={modelFilter}
                          onChange={(e) => setModelFilter(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && filteredModels[0]) {
                              patchSelected({ model: filteredModels[0] })
                              detection.hideList(selectedId)
                            }
                          }}
                        />
                        <button
                          className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          title="收起列表"
                          onClick={() => detection.hideList(selectedId)}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="max-h-52 overflow-y-auto py-1">
                        {filteredModels.map((m) => (
                          <button
                            key={m}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-indigo-50 ${
                              m === selected.model ? 'bg-indigo-50/60 text-indigo-700' : 'text-slate-700'
                            }`}
                            onClick={() => {
                              patchSelected({ model: m })
                              detection.hideList(selectedId)
                            }}
                          >
                            <span className="truncate font-mono text-[13px]">{m}</span>
                            {m === selected.model && <span className="shrink-0 text-xs">✓ 当前</span>}
                          </button>
                        ))}
                        {filteredModels.length === 0 && (
                          <p className="px-3 py-2 text-xs text-slate-400">没有匹配「{modelFilter}」的模型</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Field>
              <Field label={`温度 temperature：${selected.temperature ?? 0.4}`}>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={selected.temperature ?? 0.4}
                  onChange={(e) => patchSelected({ temperature: Number(e.target.value) })}
                  className="w-full accent-indigo-600"
                />
              </Field>

              <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
                <button
                  className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  onClick={runTest}
                  disabled={Boolean(currentTest?.testing)}
                >
                  {currentTest?.testing ? '测试中…' : '测试连接'}
                </button>
                <label className="flex cursor-pointer items-center gap-1.5 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="accent-indigo-600"
                    checked={defaultId === selected.id}
                    onChange={(e) => {
                      setDefaultId(e.target.checked ? selected.id : (profiles[0]?.id ?? null))
                      setDirty(true)
                      setSaved(false)
                      saveFlow.markLocalEdit()
                    }}
                  />
                  设为默认
                </label>
                <button
                  className="ml-auto rounded-lg px-3 py-2 text-sm text-rose-500 hover:bg-rose-50"
                  onClick={removeProfile}
                >
                  删除
                </button>
              </div>

              {currentTest?.result && (
                <p className={`text-sm ${currentTest.result.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {currentTest.result.ok ? '✓ ' : '✗ '}
                  {currentTest.result.message}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-400">
            左侧新增一个配置开始使用
          </div>
        )}
      </div>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="scan-limit-heading">
        <h2 id="scan-limit-heading" className="text-sm font-semibold text-slate-800">扫描安全上限</h2>
        <p className="mt-1 text-xs text-slate-500">项目较大时，扫描会在达到上限后停止并提示扫描不完整。默认最多纳入 50,000 个文件和 100,000 个树节点，单文件内容上限为 1 MiB；留空使用默认值，修改后在下一次扫描或生成时生效。</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {([
            ['maxFiles', '最多扫描文件数'],
            ['maxTreeNodes', '最多树节点数'],
            ['maxContentFileBytes', '单文件内容上限（字节）']
          ] as Array<[keyof ScanLimits, string]>).map(([key, label]) => {
            const bounds = SCAN_LIMIT_BOUNDS[key]
            const id = `scan-limit-${key}`
            const errorId = `${id}-error`
            return <div key={key}>
              <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
              <input id={id} name={key} type="text" inputMode="numeric" className={inputCls}
                value={scanLimitDraft[key]} aria-invalid={Boolean(scanLimitErrors[key])}
                aria-describedby={scanLimitErrors[key] ? errorId : undefined}
                onChange={(e) => {
                  setScanLimitDraft((draft) => ({ ...draft, [key]: e.target.value }))
                  setScanLimitErrors((errors) => ({ ...errors, [key]: undefined }))
                  setDirty(true)
                  setSaved(false)
                  saveFlow.markLocalEdit()
                }}
                onBlur={() => {
                  const result = parseScanLimitDraft(scanLimitDraft)
                  setScanLimitErrors((errors) => ({ ...errors, [key]: result.errors[key] }))
                }}
                placeholder={`默认 ${DEFAULT_SCAN_LIMITS[key]}`} />
              {scanLimitErrors[key] && <p id={errorId} className="mt-1 text-xs text-rose-600">{scanLimitErrors[key]}</p>}
              <p className="mt-1 text-[11px] text-slate-400">整数，范围 {bounds.min}–{bounds.max}</p>
            </div>
          })}
        </div>
      </section>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          onClick={save}
          disabled={saving}
        >
          {saving ? '保存中…' : `保存${dirty ? ' *' : ''}`}
        </button>
        {saved && <p className="text-sm text-emerald-600">✓ 已保存</p>}
        {saveError && <p className="text-sm text-rose-600">✗ {saveError}</p>}
      </div>

      <p className="mt-5 text-xs leading-5 text-slate-400">
        说明：API Key 使用操作系统凭据存储加密后保存在本机；本应用仅在请求模型服务时读取，不会上传到其他第三方。
        名词解释等 AI 能力默认复用生成面试题时的模型配置。
      </p>
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-slate-600">{label}</span>
      {children}
    </label>
  )
}
