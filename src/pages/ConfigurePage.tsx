// 配置页：项目概览 + 颗粒度/方向选择 + 开始生成
import { useState } from 'react'
import type { GenerateOptions, Granularity, InterviewResult, ProjectOverview, RoleFocus, PublicSettings } from '@shared/types'
import { GRANULARITY_META, ROLE_META } from '@shared/types'
import FileTreeView from '../components/FileTreeView'

interface Props {
  overview: ProjectOverview
  existingResult: InterviewResult | null
  settings: PublicSettings
  initialOptions?: Pick<GenerateOptions, 'granularity' | 'roleFocus' | 'profileId'>
  notice?: string | null
  onStart: (options: GenerateOptions) => void
  onViewExisting: (result: InterviewResult, sourceRecentPath: string) => void
  projectStoragePath: string
  busyTask?: { projectName: string; runId: string; cancelling: boolean } | null
  onResumeTask?: () => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

export default function ConfigurePage({ overview, existingResult, settings, initialOptions, notice = null, onStart, onViewExisting, projectStoragePath, busyTask = null, onResumeTask }: Props) {
  const [granularity, setGranularity] = useState<Granularity>(initialOptions?.granularity ?? 'medium')
  const [roleFocus, setRoleFocus] = useState<RoleFocus>(initialOptions?.roleFocus ?? 'general')
  const preferredProfileId = initialOptions?.profileId
  const profileId = [preferredProfileId, settings.defaultProfileId, settings.profiles[0]?.id]
    .find((id) => id && settings.profiles.some((profile) => profile.id === id)) ?? ''
  const profile = settings.profiles.find((p) => p.id === profileId)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {notice && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
            {notice}
          </div>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{overview.name}</h1>
            <p className="mt-1 text-xs text-slate-400" title={overview.root}>
              {overview.root}
            </p>
          </div>
          {existingResult && (
            <button
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
              onClick={() => onViewExisting(existingResult, projectStoragePath)}
            >
              查看上次生成结果（{new Date(existingResult.createdAt).toLocaleString('zh-CN')}）
            </button>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[380px_1fr]">
          {/* 左：项目概览 */}
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex gap-6 text-sm">
                <div>
                  <div className="text-lg font-semibold text-slate-900">{overview.totalFiles}</div>
                  <div className="text-xs text-slate-400">文件</div>
                </div>
                <div>
                  <div className="text-lg font-semibold text-slate-900">{formatBytes(overview.totalBytes)}</div>
                  <div className="text-xs text-slate-400">文本总量</div>
                </div>
              </div>
              {overview.truncation && (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                  ⚠️ 扫描不完整：
                  {overview.truncation.byFileCount && `文件数达到上限 ${overview.truncation.limits.maxFiles}；`}
                  {overview.truncation.byTreeNodes && `树节点数达到上限 ${overview.truncation.limits.maxTreeNodes}；`}
                  {overview.truncation.oversizedFiles > 0 && `${overview.truncation.oversizedFiles} 个文件超过单文件大小上限未纳入阅读；`}
                  {overview.truncation.estimatedSkipped > 0 && `估计至少还有 ${overview.truncation.estimatedSkipped} 项未扫描；`}
                  生成结果可能遗漏内容。可在「设置 → 扫描安全上限」调整扫描上限后重新扫描。
                </div>
              )}
              {overview.languages.length > 0 && (
                <div className="space-y-1.5">
                  {overview.languages.slice(0, 6).map((l) => (
                    <div key={l.lang} className="flex items-center gap-2 text-xs">
                      <span className="w-20 shrink-0 text-slate-500">{l.lang}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-indigo-400" style={{ width: `${l.percent}%` }} />
                      </div>
                      <span className="w-10 shrink-0 text-right text-slate-400">{l.percent}%</span>
                    </div>
                  ))}
                </div>
              )}
              {overview.security.excludedFiles > 0 && (
                <div className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  已安全排除 {overview.security.excludedFiles} 个敏感文件，不会读取或发送其内容
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-[13px] font-medium text-slate-600">项目文件树</h3>
              <FileTreeView root={overview.tree} />
            </div>

            {overview.keyFiles.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <h3 className="mb-2 text-[13px] font-medium text-slate-600">识别到的关键文件</h3>
                <ul className="space-y-1">
                  {overview.keyFiles.slice(0, 10).map((k) => (
                    <li key={k.path} className="flex items-baseline gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono text-slate-600" title={k.path}>
                        {k.path}
                      </span>
                      <span className="shrink-0 text-slate-400">{k.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* 右：生成配置 */}
          <div className="space-y-6">
            {busyTask && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="text-sm text-amber-800">
                  {busyTask.cancelling
                    ? `正在取消「${busyTask.projectName}」的生成…`
                    : `「${busyTask.projectName}」仍在生成；结束后才能开始另一个任务。`}
                </div>
                {onResumeTask && (
                  <button className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100" onClick={onResumeTask}>
                    查看任务
                  </button>
                )}
              </div>
            )}
            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-slate-900">① 问题颗粒度</h2>
              <div className="space-y-2.5">
                {(Object.keys(GRANULARITY_META) as Granularity[]).map((g) => {
                  const meta = GRANULARITY_META[g]
                  const active = granularity === g
                  return (
                    <button
                      key={g}
                      className={`w-full rounded-xl border p-4 text-left transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-50/70 ring-1 ring-indigo-400'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                      onClick={() => setGranularity(g)}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-3.5 w-3.5 rounded-full border-2 ${
                            active ? 'border-indigo-600 bg-indigo-600' : 'border-slate-300'
                          }`}
                        />
                        <span className="text-[15px] font-semibold text-slate-900">{meta.label}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                          {meta.sub}
                        </span>
                        <span className="ml-auto text-xs font-medium text-indigo-600">{meta.count}</span>
                      </div>
                      <p className="mt-1.5 pl-5.5 text-[13px] leading-5 text-slate-500" style={{ paddingLeft: 22 }}>
                        {meta.desc}
                      </p>
                      <p className="mt-0.5 pl-5.5 text-xs text-slate-400" style={{ paddingLeft: 22 }}>
                        {meta.note}
                      </p>
                    </button>
                  )
                })}
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-slate-900">② 考察方向</h2>
              <div className="flex overflow-hidden rounded-xl border border-slate-200 bg-white">
                {(Object.keys(ROLE_META) as RoleFocus[]).map((r) => (
                  <button
                    key={r}
                    className={`flex-1 px-4 py-2.5 text-sm transition ${
                      roleFocus === r
                        ? 'bg-indigo-600 font-medium text-white'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                    onClick={() => setRoleFocus(r)}
                  >
                    {ROLE_META[r].label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-400">{ROLE_META[roleFocus].prompt}</p>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-slate-900">③ 大模型</h2>
              {profile ? (
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <span className="text-2xl">🤖</span>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-slate-800">{profile.name}</div>
                    <div className="text-xs text-slate-400">
                      {profile.model} · {profile.baseUrl}
                    </div>
                  </div>
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">已配置</span>
                </div>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  尚未配置大模型，无法生成。请先前往「设置」完成配置。
                </div>
              )}
            </section>

            <button
              className="w-full rounded-xl bg-indigo-600 py-3.5 text-[15px] font-medium text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
              disabled={!profile || Boolean(busyTask)}
              onClick={() =>
                onStart({
                  projectPath: overview.root,
                  granularity,
                  roleFocus,
                  profileId
                })
              }
            >
              开始生成面试题（{GRANULARITY_META[granularity].count}）
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
