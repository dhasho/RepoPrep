// 结果页：大纲导航 + 问题卡片（答案/追问）+ 名词解释弹卡 + 搜索 + 导出
import { useMemo, useState } from 'react'
import type { FollowUp, InterviewResult, QuestionItem, Section, Settings } from '@shared/types'
import { GRANULARITY_META, ROLE_META, stripTermMarks } from '@shared/types'
import { api } from '../lib/ipc'
import { buildQuestionNumbers, formatQuestionNumber, numberOf, sectionNumberOf } from '../lib/question-numbering'
import MarkdownView, { TermText, type OnTerm } from '../components/MarkdownView'
import TermPopover from '../components/TermPopover'

interface Props {
  result: InterviewResult
  settings: Settings
  onRegenerate: () => void
  /** 仅用于测试：设置搜索框初始值（生产调用方不传，行为不变） */
  initialSearch?: string
}

interface TermTarget {
  term: string
  anchor: DOMRect
  question: string
  snippet: string
  glossaryHint?: string
}

/** 过滤后的条目：问题自带原始下标，用于取稳定题号（过滤不改变题号） */
type QuestionEntry = QuestionItem & { sectionIndex: number; questionIndex: number }
type QuestionSection = Omit<Section, 'questions'> & { sectionIndex: number; questions: QuestionEntry[] }

/** 从答案中截取术语附近的片段，作为 AI 解释的上下文 */
function snippetAround(answer: string, term: string): string {
  const text = stripTermMarks(answer)
  const idx = text.indexOf(term)
  if (idx < 0) return text.slice(0, 200)
  const start = Math.max(0, idx - 90)
  return (start > 0 ? '…' : '') + text.slice(start, idx + term.length + 110)
}

export default function ResultPage({ result, settings, onRegenerate, initialSearch = '' }: Props) {
  const [search, setSearch] = useState(initialSearch)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [activeId, setActiveId] = useState('')
  const [popover, setPopover] = useState<TermTarget | null>(null)
  const [toast, setToast] = useState('')

  const profileId = result.profileId || settings.defaultProfileId || settings.profiles[0]?.id || ''

  const onTerm = (question: QuestionItem): OnTerm =>
    (term, anchor) => {
      setPopover({
        term,
        anchor,
        question: stripTermMarks(question.question),
        snippet: snippetAround(question.answer, term),
        glossaryHint: result.glossary[term]
      })
    }

  const query = search.trim().toLowerCase()
  /**
   * 过滤后的条目自带**原始下标**。
   *
   * 这一点很关键：过滤只应改变"哪些项可见"，因此题号必须用原始下标去查
   * （issue #11）。若渲染时用过滤后数组的下标，被过滤掉的前置问题会让后面问题的
   * 题号整体前移 —— 实测：搜索"数据流"时 q4 在过滤后是第 0 个，会被算成 Q03 而不是 Q04。
   * 顺带这里也省掉了"用 section id 反查原始下标"的额外 Map。
   */
  const filtered = useMemo<QuestionSection[]>(() => {
    const withIndex = result.sections.map((s, sectionIndex) => ({
      ...s,
      sectionIndex,
      questions: s.questions.map((q, questionIndex) => ({ ...q, sectionIndex, questionIndex }))
    }))
    // 空 section 一律不渲染：它没有可见问题，渲染出来只会得到一个无意义的序号（00）。
    // 注意这不会改变题号——序号来自原始下标，与可见集合无关。
    if (!query) return withIndex.filter((s) => s.questions.length > 0)
    return withIndex
      .map((s) => ({
        ...s,
        questions: s.questions.filter((q) => {
          const text = [
            q.question,
            q.answer,
            ...q.followUps.flatMap((f) => [f.question, f.answer, ...(f.followUps ?? []).flatMap((g) => [g.question, g.answer])])
          ]
            .map(stripTermMarks)
            .join('\n')
          return text.toLowerCase().includes(query)
        })
      }))
      .filter((s) => s.questions.length > 0)
  }, [query, result.sections])

  const totalQuestions = result.sections.reduce((a, s) => a + s.questions.length, 0)
  const shownQuestions = filtered.reduce((a, s) => a + s.questions.length, 0)

  // 题号一律取原始结果的稳定序号（在过滤之前算好），
  // 因此无论怎么搜索，同一个问题显示的题号都相同，也不会出现 Q0。
  // 用 Map 查表，渲染期间不再遍历全部问题。
  const questionNumbers = useMemo(() => buildQuestionNumbers(result.sections), [result.sections])

  const toggle = (id: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const jumpTo = (question: QuestionItem) => {
    setExpanded((s) => new Set(s).add(question.id))
    setActiveId(question.id)
    requestAnimationFrame(() => {
      document.getElementById(`q-${question.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const doExport = async () => {
    setToast('正在导出…')
    const r = await api.exportMarkdown(result)
    setToast(r.message)
    setTimeout(() => setToast(''), 4000)
  }

  return (
    <div className="flex h-full">
      {/* 左：大纲 */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-3">
          <input
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:bg-white"
            placeholder="🔍 搜索问题 / 答案 / 名词"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {query && (
            <p className="mt-1.5 px-1 text-xs text-slate-400">
              匹配 {shownQuestions}/{totalQuestions} 题
            </p>
          )}
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.map((s) => (
            <div key={s.id} className="mb-3">
              <div className="mb-1 px-2 py-1 text-xs font-semibold text-slate-400" title={s.title}>
                {s.title}
              </div>
              {s.questions.map((q, qi) => (
                <button
                  key={q.id ?? `${s.id}-${q.questionIndex}-${qi}`}
                  className={`mb-0.5 flex w-full gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] leading-5 ${
                    activeId === q.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                  onClick={() => jumpTo(q)}
                >
                  <span
                    className={`shrink-0 text-[11px] tabular-nums ${
                      activeId === q.id ? 'text-indigo-400' : 'text-slate-400'
                    }`}
                  >
                    {formatQuestionNumber(
                      numberOf(questionNumbers, q.id, { sectionIndex: q.sectionIndex, questionIndex: q.questionIndex })
                    )}
                  </span>
                  <span className="line-clamp-2">{stripTermMarks(q.question)}</span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="p-4 text-center text-sm text-slate-400">没有匹配的问题</p>
          )}
        </nav>
      </aside>

      {/* 右：内容 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 概览头部 */}
        <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-4">
          <div className="mx-auto flex max-w-3xl items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-slate-900">{result.projectName} · 面试题</h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-600">
                  {GRANULARITY_META[result.granularity].label}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5">{ROLE_META[result.roleFocus].label}方向</span>
                <span>{totalQuestions} 题</span>
                <span>{Object.keys(result.glossary).length} 个名词</span>
                <span>{result.modelUsed}</span>
                <span>{new Date(result.createdAt).toLocaleString('zh-CN')}</span>
              </p>
              {result.security && (result.security.excludedFiles > 0 || result.security.redactedFiles > 0) && (
                <div className="mt-2 inline-flex rounded-lg border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
                  安全保护：排除 {result.security.excludedFiles} / 脱敏 {result.security.redactedFiles} 文件（{result.security.redactionMatches} 处）
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-700 hover:bg-slate-50"
                onClick={doExport}
              >
                导出 Markdown
              </button>
              <button
                className="rounded-lg bg-slate-800 px-3.5 py-2 text-sm text-white hover:bg-slate-700"
                onClick={onRegenerate}
              >
                重新生成
              </button>
            </div>
          </div>
        </div>

        {/* 正文滚动区 */}
        <div className="min-h-0 flex-1 overflow-y-auto" onClick={() => setPopover(null)}>
          <div className="mx-auto max-w-3xl px-6 py-6">
            {result.projectSummary && (
              <div className="mb-6 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
                <h2 className="mb-2 text-sm font-semibold text-indigo-900">📋 项目概览</h2>
                <div className="text-sm">
                  <MarkdownView markdown={result.projectSummary} onTerm={onTerm({ id: '', question: '项目概览', answer: result.projectSummary, followUps: [] })} />
                </div>
              </div>
            )}

            {filtered.map((s) => (
              <section key={s.id} className="mb-8">
                <div className="mb-3 border-b border-slate-200 pb-2">
                  <h2 className="text-base font-semibold text-slate-900">
                    <span className="mr-2 text-slate-300">{String(s.sectionIndex + 1).padStart(2, '0')}</span>
                    {s.title}
                  </h2>
                  {s.summary && <p className="mt-0.5 pl-8 text-xs text-slate-400">{s.summary}</p>}
                </div>

                <div className="space-y-3">
                  {s.questions.map((q, qi) => (
                    <QuestionCard
                      key={q.id ?? `${s.id}-${q.questionIndex}-${qi}`}
                      q={q}
                      index={numberOf(questionNumbers, q.id, { sectionIndex: q.sectionIndex, questionIndex: q.questionIndex })}
                      expanded={expanded.has(q.id)}
                      onToggle={() => toggle(q.id)}
                      onTerm={onTerm(q)}
                    />
                  ))}
                </div>
              </section>
            ))}

            {Object.keys(result.glossary).length > 0 && (
              <section className="mb-8">
                <div className="mb-3 border-b border-slate-200 pb-2">
                  <h2 className="text-base font-semibold text-slate-900">
                    <span className="mr-2 text-slate-300">📎</span>附录：专业名词表
                  </h2>
                  <p className="mt-0.5 pl-8 text-xs text-slate-400">
                    生成答案时识别出的专业名词（正文中的下划线名词可点击查看）
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {Object.entries(result.glossary).map(([term, def]) => (
                    <div key={term} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="mb-1 text-sm font-semibold text-slate-800">{term}</div>
                      <p className="text-[13px] leading-6 text-slate-500">{def}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-800 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      {popover && (
        <TermPopover
          key={`${popover.term}-${popover.anchor.top}-${popover.anchor.left}`}
          term={popover.term}
          anchor={popover.anchor}
          question={popover.question}
          snippet={popover.snippet}
          glossaryHint={popover.glossaryHint}
          projectSummary={stripTermMarks(result.projectSummary)}
          profileId={profileId}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

function QuestionCard({
  q,
  index,
  expanded,
  onToggle,
  onTerm
}: {
  q: QuestionItem
  index: number
  expanded: boolean
  onToggle: () => void
  onTerm: OnTerm
}) {
  return (
    <div id={`q-${q.id}`} className="scroll-mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <button className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-slate-50/60" onClick={onToggle}>
        <span className="mt-0.5 shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-500">
          {formatQuestionNumber(index)}
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-medium leading-6 text-slate-900">
          <TermText text={q.question} onTerm={onTerm} />
        </span>
        <span className={`mt-1 shrink-0 text-xs text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-4 pb-4 pt-3">
          <MarkdownView markdown={q.answer} onTerm={onTerm} />
          {q.followUps.length > 0 && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3">
              <div className="mb-2 text-xs font-semibold text-slate-400">面试官可能的追问（{q.followUps.length}）</div>
              {q.followUps.map((f, i) => (
                <FollowUpItem key={i} f={f} index={i + 1} onTerm={onTerm} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FollowUpItem({ f, index, onTerm, depth = 1 }: { f: FollowUp; index: number; onTerm: OnTerm; depth?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={depth > 1 ? 'ml-4 border-l-2 border-slate-200 pl-3' : ''}>
      <button className="flex w-full items-start gap-2 py-1.5 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="mt-0.5 shrink-0 text-[11px] font-semibold text-amber-500">追问{index}</span>
        <span className="min-w-0 flex-1 text-[13.5px] leading-6 text-slate-700">
          <TermText text={f.question} onTerm={onTerm} />
        </span>
        <span className={`mt-1 shrink-0 text-[10px] text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>
      {open && (
        <div className="pb-2 pl-11 pr-2">
          <MarkdownView markdown={f.answer} onTerm={onTerm} />
          {(f.followUps ?? []).length > 0 && (
            <div className="mt-2">
              {(f.followUps ?? []).map((g, i) => (
                <FollowUpItem key={i} f={g} index={i + 1} onTerm={onTerm} depth={depth + 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
