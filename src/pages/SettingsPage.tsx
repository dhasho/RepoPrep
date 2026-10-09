// 设置页：大模型配置管理（OpenAI 兼容接口，支持检测 Key 可用模型列表）
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { LlmProfile, Settings, TestConnectionResult } from '@shared/types'
import { api } from '../lib/ipc'
import { ModelDetectionController, modelStateOf } from '../lib/model-detection'

interface Props {
  settings: Settings
  onSaved: (s: Settings) => void
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

const emptyProfile = (): LlmProfile => ({
  id: `profile-${Date.now()}`,
  name: '新配置',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.4
})

export default function SettingsPage({ settings, onSaved, onBack }: Props) {
  const [profiles, setProfiles] = useState<LlmProfile[]>(settings.profiles)
  const [defaultId, setDefaultId] = useState<string | null>(settings.defaultProfileId)
  const [selectedId, setSelectedId] = useState<string>(
    settings.defaultProfileId ?? settings.profiles[0]?.id ?? ''
  )
  const [dirty, setDirty] = useState(false)
  const [test, setTest] = useState<TestConnectionResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saved, setSaved] = useState(false)

  // 模型列表检测：状态按 profile 隔离、竞态由控制器统一处理（issue #14）。
  // 响应只写回发起它的配置；换 Base URL / API Key 或快速重复检测时，
  // 过期的响应（无论成败）都会被丢弃，不会显示误导性内容。
  const detection = useMemo(() => new ModelDetectionController({ listModels: api.listModels }), [])
  const modelSlots = useSyncExternalStore(detection.subscribe, detection.getSnapshot, detection.getSnapshot)
  const modelState = modelStateOf(modelSlots, selectedId)
  const [modelFilter, setModelFilter] = useState('')

  useEffect(() => {
    if (!profiles.length && !selectedId) {
      const p = emptyProfile()
      setProfiles([p])
      setSelectedId(p.id)
      setDirty(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = profiles.find((p) => p.id === selectedId) ?? null

  const patchSelected = (patch: Partial<LlmProfile>) => {
    setProfiles((l) => l.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)))
    setDirty(true)
    setSaved(false)
    // 换了接口地址或 Key：取消（失效）进行中的检测并清空旧列表（issue #14）
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined) {
      detection.invalidate(selectedId)
    }
  }

  /** 调用主进程 GET /models 检测该 Key 可用的模型（竞态处理见 model-detection.ts） */
  const detectModels = () => {
    if (!selected) return
    setModelFilter('')
    detection.detect(selected)
  }

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase()
    return q ? modelState.models.filter((m) => m.toLowerCase().includes(q)) : modelState.models
  }, [modelState.models, modelFilter])

  const save = () => {
    if (!selected) return
    if (!selected.name.trim() || !selected.baseUrl.trim() || !selected.model.trim()) {
      setTest({ ok: false, message: '名称、接口地址、模型名不能为空' })
      return
    }
    const next: Settings = { profiles, defaultProfileId: defaultId ?? profiles[0]?.id ?? null }
    void api.saveSettings(next)
    onSaved(next)
    setDirty(false)
    setSaved(true)
  }

  const addProfile = () => {
    const p = emptyProfile()
    setProfiles((l) => [...l, p])
    setSelectedId(p.id)
    setDirty(true)
    setSaved(false)
    setTest(null)
    setModelFilter('')
  }

  const removeProfile = () => {
    if (!selected) return
    const rest = profiles.filter((p) => p.id !== selected.id)
    detection.invalidate(selected.id) // 该配置已删除，进行中的检测作废
    setProfiles(rest)
    if (defaultId === selected.id) setDefaultId(rest[0]?.id ?? null)
    setSelectedId(rest[0]?.id ?? '')
    setDirty(true)
    setSaved(false)
    setTest(null)
    setModelFilter('')
  }

  const runTest = async () => {
    if (!selected) return
    setTesting(true)
    setTest(null)
    try {
      setTest(await api.testLlm(selected))
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
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
        <button className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100" onClick={onBack}>
          ← 返回
        </button>
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-5">
        {/* 配置列表 */}
        <div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {profiles.map((p, i) => (
              <button
                key={p.id}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm ${
                  i > 0 ? 'border-t border-slate-100' : ''
                } ${p.id === selectedId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-50'}`}
                onClick={() => {
                  setSelectedId(p.id)
                  setTest(null)
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
            className="mt-2 w-full rounded-lg border border-dashed border-slate-300 py-2 text-sm text-slate-500 hover:border-indigo-400 hover:text-indigo-600"
            onClick={addProfile}
          >
            ＋ 新增配置
          </button>
        </div>

        {/* 编辑区 */}
        {selected ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
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
                  onChange={(e) => patchSelected({ name: e.target.value })}
                  placeholder="如：DeepSeek 日常用"
                />
              </Field>
              <Field label="接口地址 Base URL">
                <input
                  className={inputCls}
                  value={selected.baseUrl}
                  onChange={(e) => patchSelected({ baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                />
              </Field>
              <Field label="API Key">
                <input
                  className={inputCls}
                  type="password"
                  value={selected.apiKey}
                  onChange={(e) => patchSelected({ apiKey: e.target.value })}
                  onBlur={() => {
                    // 粘贴完 Key 失焦时自动检测一次可用模型
                    if (
                      selected.apiKey.trim() &&
                      selected.baseUrl.trim() &&
                      modelState.models.length === 0 &&
                      !modelState.loading
                    ) {
                      detectModels()
                    }
                  }}
                  placeholder="sk-…（本地保存于本机，仅用于调用接口；Ollama 等本地服务可留空）"
                />
              </Field>
              <Field label="模型名">
                <div className="relative">
                  <div className="flex gap-2">
                    <input
                      className={inputCls}
                      value={selected.model}
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
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                  onClick={save}
                >
                  保存{dirty ? ' *' : ''}
                </button>
                <button
                  className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  onClick={runTest}
                  disabled={testing}
                >
                  {testing ? '测试中…' : '测试连接'}
                </button>
                <label className="flex cursor-pointer items-center gap-1.5 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="accent-indigo-600"
                    checked={defaultId === selected.id}
                    onChange={(e) => setDefaultId(e.target.checked ? selected.id : (profiles[0]?.id ?? null))}
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

              {saved && <p className="text-sm text-emerald-600">✓ 已保存</p>}
              {test && (
                <p className={`text-sm ${test.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {test.ok ? '✓ ' : '✗ '}
                  {test.message}
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

      <p className="mt-5 text-xs leading-5 text-slate-400">
        说明：API Key 仅保存在本机用户数据目录，用于本应用直接调用对应服务商接口，不会上传到任何第三方。
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
