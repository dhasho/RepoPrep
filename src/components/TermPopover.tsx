// 飞书风格名词解释弹卡：术语表解释 + AI 流式详细解释
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { EXPLAIN_CONTEXT_LIMITS } from '@shared/result-contract'
import { api } from '../lib/ipc'
import { ExplainStreamController } from '../lib/explain-stream'
import MarkdownView from './MarkdownView'
import { AppIcon } from './AppIcon'

export interface TermPopoverProps {
  term: string
  anchor: DOMRect
  question: string
  snippet: string
  glossaryHint?: string
  projectSummary: string
  profileId: string
  onClose: () => void
}

const POPOVER_WIDTH = 380

function clipContext(value: string, limit: number): { value: string; clipped: boolean } {
  if (value.length <= limit) return { value, clipped: false }
  let end = limit - 1
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return { value: `${value.slice(0, end)}…`, clipped: true }
}

export default function TermPopover(props: TermPopoverProps) {
  const { term, anchor, question, snippet, glossaryHint, projectSummary, profileId, onClose } = props
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [requestHint, setRequestHint] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // 流式请求的生命周期交给控制器统一管理：
  // 切换词条会先取消旧请求，卸载/离开页面会取消进行中的请求
  // （issue #12：此前关闭弹窗后主进程仍在跑、继续消耗模型额度）。
  const controller = useMemo(
    () =>
      new ExplainStreamController({
        explain: api.explain,
        cancelExplain: api.cancelExplain,
        onExplainEvent: api.onExplainEvent
      }),
    []
  )
  const explain = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const explainState = explain.status
  const explainText = explain.text
  const explainError = explain.error

  const startExplain = useCallback(() => {
    if (
      !term.trim() || term.length > EXPLAIN_CONTEXT_LIMITS.term ||
      !profileId.trim() || profileId.length > EXPLAIN_CONTEXT_LIMITS.profileId
    ) {
      setRequestHint('术语或模型配置无效，无法发起解释。')
      return
    }
    const bounded = {
      projectSummary: clipContext(projectSummary, EXPLAIN_CONTEXT_LIMITS.projectSummary),
      question: clipContext(question, EXPLAIN_CONTEXT_LIMITS.question),
      snippet: clipContext(snippet, EXPLAIN_CONTEXT_LIMITS.snippet),
      glossaryHint: clipContext(glossaryHint ?? '', EXPLAIN_CONTEXT_LIMITS.glossaryHint)
    }
    const clipped = Object.values(bounded).some((context) => context.clipped)
    setRequestHint(clipped ? '项目背景较长，本次解释将使用部分上下文。' : '')
    controller.start({
      term,
      profileId,
      projectSummary: bounded.projectSummary.value,
      question: bounded.question.value,
      snippet: bounded.snippet.value,
      glossaryHint: bounded.glossaryHint.value
    })
  }, [controller, term, profileId, projectSummary, question, snippet, glossaryHint])

  const stopExplain = useCallback(() => controller.stop(), [controller])

  // 卸载时务必终止主进程里的流式请求
  useEffect(() => () => controller.dispose(), [controller])

  // 定位：优先显示在词条下方，空间不足放上方，最后夹在视口内
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.min(Math.max(anchor.left, 12), vw - POPOVER_WIDTH - 12)
    let top = anchor.bottom + 10
    if (top + h > vh - 12) top = Math.max(anchor.top - 10 - h, 12)
    setPos({ left, top })
  }, [anchor, explainState, explainText])

  // 无术语表解释时自动请求 AI 解释
  useEffect(() => {
    if (!glossaryHint) startExplain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关闭时机：外部点击 / Esc / 滚动（弹卡跟随不了滚动，直接关闭）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = (e: Event) => {
      const box = boxRef.current
      if (box && e.target && 'nodeType' in e.target && box.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  // 流式输出时自动滚到底部
  useEffect(() => {
    const el = contentRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [explainText])

  return createPortal(
    <div
      ref={boxRef}
      className="fixed z-50 flex max-h-[55vh] w-[380px] flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
      style={{
        left: pos?.left ?? anchor.left,
        top: pos?.top ?? anchor.bottom + 10,
        visibility: pos ? 'visible' : 'hidden'
      }}
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-600">名词</span>
          <span className="truncate text-[15px] font-semibold text-slate-900">{term}</span>
        </div>
        <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={onClose} title="关闭" aria-label="关闭">
          <AppIcon name="close" size={14} />
        </button>
      </div>

      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {glossaryHint && (
          <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-[13px] leading-6 text-slate-600">
            <span className="mr-1 font-medium text-slate-500">术语表：</span>
            {glossaryHint}
          </div>
        )}

        {requestHint && <p className="mb-2 text-xs text-amber-700">{requestHint}</p>}

        {explainState === 'idle' && (
          <div className="py-2 text-center">
            <button
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              onClick={startExplain}
            >
              <AppIcon name="sparkles" size={16} className="mr-1" />让 AI 结合本项目详细解释
            </button>
          </div>
        )}

        {(explainState === 'streaming' ||
          (explainText && explainState !== 'error' && explainState !== 'stopped')) && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-400">
                AI 解释{explainState === 'streaming' ? '（生成中…）' : ''}
              </span>
              {explainState === 'streaming' && (
                <button className="text-xs text-slate-400 hover:text-slate-600" onClick={stopExplain}>
                  停止
                </button>
              )}
            </div>
            <MarkdownView markdown={explainText || '…'} />
            {explainState === 'done' && (
              <button
                className="mt-2 w-full rounded-lg border border-slate-200 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
                onClick={startExplain}
              >
                重新解释
              </button>
            )}
          </div>
        )}

        {explainState === 'error' && (
          <div className="py-2 text-center text-sm text-rose-600">
            <p className="mb-2">解释失败：{explainError}</p>
            <button
              className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
              onClick={startExplain}
            >
              重试
            </button>
          </div>
        )}

        {/* 用户主动停止：中性提示 + 继续按钮，并保留已经生成的部分（不显示成失败） */}
        {explainState === 'stopped' && (
          <div>
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <span className="text-xs text-slate-500">已停止生成</span>
              <button
                className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                onClick={startExplain}
              >
                继续解释
              </button>
            </div>
            {explainText && (
              <div className="mt-3">
                <MarkdownView markdown={explainText} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
