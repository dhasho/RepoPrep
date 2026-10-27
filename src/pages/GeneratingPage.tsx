// 生成中页：报告式流式正文预览
import { useEffect, useRef } from 'react'
import type { GenerateOptions, GenerateProgress, GenerationPreview, ProjectOverview, FollowUp } from '@shared/types'
import { GRANULARITY_META, ROLE_META, stripTermMarks } from '@shared/types'
import { formatContextTruncationWarning } from '@shared/context-budget'
import { formatAnswerMarkdown } from '@shared/answer-markdown'
import MarkdownView from '../components/MarkdownView'
import { AppIcon } from '../components/AppIcon'

interface Props {
  overview: ProjectOverview | null
  options: GenerateOptions | null
  progress: GenerateProgress | null
  logs: readonly GenerateProgress[]
  error: string | null
  cancelling?: boolean
  onCancel: () => void
  onBack: () => void
  preview?: GenerationPreview | null
  startedAt?: number
}

function formatReportDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN')
}

function FollowUpPreview({ followUp, index, depth = 0 }: { followUp: FollowUp; index: number; depth?: number }) {
  return (
    <div className={`mt-3 min-w-0 ${depth ? 'ml-4 border-l-2 border-slate-200 pl-3' : 'rounded-lg bg-slate-50 p-3'}`}>
      <h4 className="text-xs font-semibold text-amber-600">追问 {index}</h4>
      <div className="mt-1 min-w-0 break-words text-[13px] leading-6 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-all">
        <MarkdownView markdown={stripTermMarks(followUp.question)} />
      </div>
      {followUp.answer && (
        <div className="mt-2 min-w-0 break-words text-sm leading-6 text-slate-700 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-all">
          <MarkdownView markdown={formatAnswerMarkdown(stripTermMarks(followUp.answer))} />
        </div>
      )}
      {followUp.followUps?.map((child, childIndex) => (
        <FollowUpPreview key={`${index}-${childIndex}`} followUp={child} index={childIndex + 1} depth={depth + 1} />
      ))}
    </div>
  )
}

export default function GeneratingPage({ overview, options, error, cancelling = false, onCancel, onBack, preview = null, startedAt }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followsBottom = useRef(true)
  const displayStartedAt = useRef(startedAt ?? Date.now())
  const sections = preview?.sections ?? []
  const completeCount = sections.reduce((total, section) => total + section.questions.length, 0)
  const active = preview?.activeQuestion
  const date = formatReportDate(displayStartedAt.current)
  const contextWarning = formatContextTruncationWarning(preview?.contextTruncation)
  const security = preview?.security ?? overview?.security

  useEffect(() => {
    const container = scrollRef.current
    if (container && followsBottom.current) container.scrollTop = container.scrollHeight
  }, [preview])

  const updateFollowMode = () => {
    const container = scrollRef.current
    if (!container) return
    followsBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 80
  }

  let questionNumber = 0
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-slate-900">{overview?.name ?? '项目'} · 面试题</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              {options && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-600">{GRANULARITY_META[options.granularity].label}</span>}
              {options && <span className="rounded bg-slate-100 px-1.5 py-0.5">{ROLE_META[options.roleFocus].label}方向</span>}
              <span>{date}</span>
            </p>
            {security && (security.excludedFiles > 0 || security.redactedFiles > 0) && (
              <div className="mt-2 inline-flex rounded-lg border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
                安全保护：排除 {security.excludedFiles} / 脱敏 {security.redactedFiles} 文件（{security.redactionMatches} 处）
              </div>
            )}
          </div>
          <button
            className="shrink-0 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
            onClick={onCancel}
            disabled={cancelling || Boolean(error)}
          >
            {cancelling ? '正在取消…' : '取消生成'}
          </button>
        </div>
      </header>

      <div ref={scrollRef} onScroll={updateFollowMode} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <main data-generation-preview className="mx-auto max-w-3xl min-w-0 px-6 py-6">
          {contextWarning && <div role="status" className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{contextWarning}</div>}
          {preview?.projectSummary ? (
            <section className="mb-6 min-w-0 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-indigo-900"><AppIcon name="clipboard" size={16} />项目概览</h2>
              <div className="min-w-0 break-words text-sm [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-all">
                <MarkdownView markdown={stripTermMarks(preview.projectSummary)} />
              </div>
            </section>
          ) : null}

          {sections.map((section, sectionIndex) => (
            <section key={section.id} className="mb-8 min-w-0">
              <div className="mb-3 border-b border-slate-200 pb-2">
                <h2 className="text-base font-semibold text-slate-900"><span className="mr-2 text-slate-300">{String(sectionIndex + 1).padStart(2, '0')}</span>{section.title}</h2>
                {section.summary && <p className="mt-0.5 pl-8 text-xs text-slate-400">{stripTermMarks(section.summary)}</p>}
              </div>
              <div className="space-y-3">
                {section.questions.map((question) => {
                  questionNumber += 1
                  return (
                    <article key={question.id} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white">
                      <div className="flex min-w-0 items-start gap-3 px-4 py-3.5">
                        <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-500">Q{String(questionNumber).padStart(2, '0')}</span>
                        <div className="min-w-0 break-words text-[15px] font-medium leading-6 text-slate-900 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-all">
                          <MarkdownView markdown={stripTermMarks(question.question)} />
                        </div>
                      </div>
                      <div className="min-w-0 border-t border-slate-100 px-4 pb-4 pt-3">
                        <div className="min-w-0 break-words text-sm leading-6 text-slate-700 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-all">
                          <MarkdownView markdown={formatAnswerMarkdown(stripTermMarks(question.answer))} />
                        </div>
                        {question.followUps.length > 0 && <div className="mt-4"><div className="mb-2 text-xs font-semibold text-slate-400">面试官可能的追问（{question.followUps.length}）</div>{question.followUps.map((followUp, index) => <FollowUpPreview key={`${question.id}-${index}`} followUp={followUp} index={index + 1} />)}</div>}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}

          {active && (
            <section className="mb-8 min-w-0" aria-label="正在生成的问题">
              {sections.at(-1)?.title !== active.sectionTitle && (
                <div className="mb-3 border-b border-slate-200 pb-2">
                  <h2 className="text-base font-semibold text-slate-900"><span className="mr-2 text-slate-300">{String(sections.length + 1).padStart(2, '0')}</span>{active.sectionTitle}</h2>
                  {active.sectionSummary && <p className="mt-0.5 pl-8 text-xs text-slate-400">{stripTermMarks(active.sectionSummary)}</p>}
                </div>
              )}
              <article className="min-w-0 overflow-hidden rounded-xl border border-indigo-200 bg-white">
                <div className="flex min-w-0 items-start gap-3 px-4 py-3.5">
                  <span className="shrink-0 rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-semibold tabular-nums text-indigo-600">Q{String(completeCount + 1).padStart(2, '0')}</span>
                  <div className="min-w-0 flex-1">
                    {active.title && <p className="mb-1 text-xs font-medium text-slate-400">{stripTermMarks(active.title)}</p>}
                    {active.question && <div className="min-w-0 break-words text-[15px] font-medium leading-6 text-slate-900 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-all"><MarkdownView markdown={stripTermMarks(active.question)} /></div>}
                    <span className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-600"><AppIcon name="loader" size={13} className="animate-spin" />正在生成</span>
                  </div>
                </div>
                {active.answer && <div className="min-w-0 border-t border-slate-100 px-4 pb-4 pt-3"><div className="min-w-0 break-words text-sm leading-6 text-slate-700 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-all"><MarkdownView markdown={formatAnswerMarkdown(stripTermMarks(active.answer))} /></div></div>}
                {active.followUps.length > 0 && <div className="border-t border-slate-100 px-4 pb-4 pt-3"><div className="mb-2 text-xs font-semibold text-slate-400">追问生成中</div>{active.followUps.map((followUp, index) => <FollowUpPreview key={`${active.key}-${index}`} followUp={followUp} index={index + 1} />)}</div>}
              </article>
            </section>
          )}

          {!error && !cancelling && !preview?.projectSummary && sections.length === 0 && !active && (
            <div role="status" className="flex items-center gap-2 py-2 text-sm text-slate-500">
              <AppIcon name="sparkles" size={16} className="animate-pulse text-indigo-500" />
              <span>正在思考</span>
              <span aria-hidden="true" className="thinking-dots w-5 overflow-hidden">•••</span>
            </div>
          )}

          {(preview?.projectSummary || sections.length > 0 || active) && (
            <p role="status" className="mt-6 text-xs text-slate-400">{error ? '生成已停止' : cancelling ? '正在取消…' : `已保存 ${completeCount} 题，报告仍在生成中`}</p>
          )}
          {error && (
            <section role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4">
              <h2 className="text-sm font-semibold text-rose-800">生成失败</h2>
              <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6 text-rose-700">{error}</pre>
              <p className="mt-3 text-xs leading-5 text-slate-500">已校验保存的完整题目可在返回配置后继续；尚未完整接收的题目会重新生成。</p>
              <button className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700" onClick={onBack}><AppIcon name="arrow-left" size={16} className="mr-1" />返回调整配置并重试</button>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
