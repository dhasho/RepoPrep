import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { EXPLAIN_CONTEXT_LIMITS } from '@shared/result-contract'
import { api } from '../lib/ipc'
import { ExplainStreamController } from '../lib/explain-stream'
import MarkdownView from './MarkdownView'
import { AppIcon } from './AppIcon'

export interface SelectionExplainDialogProps {
  selectedText: string
  question: string
  snippet: string
  projectSummary: string
  profileId: string
  explanationCache?: Map<string, string>
  onClose: () => void
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value
  let end = limit - 1
  if (end > 0 && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--
  return `${value.slice(0, end)}…`
}

function boundedSnippet(selectedText: string, snippet: string): string {
  const prefix = '选中的原文：\n'
  const middle = '\n\n所在问答的上下文：\n'
  const remaining = Math.max(0, EXPLAIN_CONTEXT_LIMITS.snippet - prefix.length - selectedText.length - middle.length)
  return `${prefix}${selectedText}${middle}${clip(snippet, remaining)}`
}

export default function SelectionExplainDialog({ selectedText, question, snippet, projectSummary, profileId, explanationCache, onClose }: SelectionExplainDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const safeText = clip(selectedText, 8000)
  const term = safeText.length <= EXPLAIN_CONTEXT_LIMITS.term ? safeText : '所选文本'
  const request = useMemo(() => ({
    term,
    profileId,
    projectSummary: clip(projectSummary, EXPLAIN_CONTEXT_LIMITS.projectSummary),
    question: clip(question, EXPLAIN_CONTEXT_LIMITS.question),
    snippet: boundedSnippet(safeText, snippet),
    glossaryHint: ''
  }), [term, profileId, projectSummary, question, safeText, snippet])
  const contextKey = JSON.stringify(Object.values(request))
  const cachedText = explanationCache?.get(contextKey)
  const valid = !!term.trim() && !!request.profileId.trim() && request.profileId.length <= EXPLAIN_CONTEXT_LIMITS.profileId && selectedText.length <= 8000
  const controller = useMemo(() => new ExplainStreamController({ explain: api.explain, cancelExplain: api.cancelExplain, onExplainEvent: api.onExplainEvent }), [contextKey])
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const dialogRef = useRef<HTMLElement>(null)
  const start = useCallback(() => {
    if (!valid) return
    explanationCache?.delete(contextKey)
    controller.start(request)
  }, [valid, controller, request, explanationCache, contextKey])
  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => {
    if (!valid || explanationCache?.has(contextKey)) return
    const timer = setTimeout(start, 0)
    return () => clearTimeout(timer)
  }, [valid, explanationCache, contextKey, start])
  useEffect(() => {
    if (!explanationCache || snapshot.status !== 'done' || !snapshot.text.trim() || snapshot.text.length > 16_000) return
    explanationCache.set(contextKey, snapshot.text)
    while (explanationCache.size > 32) {
      const oldest = explanationCache.keys().next().value
      if (oldest === undefined) break
      explanationCache.delete(oldest)
    }
  }, [explanationCache, contextKey, snapshot.status, snapshot.text])
  useEffect(() => {
    const previousFocus = document.activeElement instanceof document.defaultView!.HTMLElement ? document.activeElement as HTMLElement : null
    const dialog = dialogRef.current
    const getFocusable = () => dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('hidden')) : []
    getFocusable()[0]?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = getFocusable()
      if (!items.length) { event.preventDefault(); dialog?.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [onClose])
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight }, [snapshot.text])
  const state = cachedText && snapshot.status === 'idle' ? 'done' : snapshot.status
  const text = snapshot.text || cachedText || (snapshot.status === 'idle' || snapshot.status === 'streaming' ? valid ? '正在准备详细解释…' : '选中内容或模型配置无效，无法发起解释。' : '')

  return createPortal(<div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="selection-explain-title" className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 id="selection-explain-title" className="text-base font-semibold text-slate-900">向 AI 提问</h2>
        <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose} title="关闭" aria-label="关闭"><AppIcon name="close" size={16} /></button>
      </header>
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        <blockquote className="mb-4 max-h-24 overflow-y-auto border-l-2 border-indigo-200 pl-3 text-sm text-slate-500">{safeText}</blockquote>
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-400">AI 解释{snapshot.status === 'streaming' ? '（生成中…）' : ''}
          {snapshot.status === 'streaming' && <button type="button" onClick={() => controller.stop()} className="text-slate-500 hover:text-slate-700">停止</button>}
        </div>
        <MarkdownView markdown={text} />
        {state === 'done' && <button type="button" className="mt-3 w-full rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50" onClick={start}>重新解释</button>}
        {snapshot.status === 'error' && <div className="py-3 text-center text-sm text-rose-600"><p className="mb-2">解释失败：{snapshot.error}</p><button type="button" onClick={start} className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600">重试</button></div>}
        {snapshot.status === 'stopped' && <div className="mt-2 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500"><span>已停止生成</span><button type="button" onClick={start} className="rounded border border-slate-200 bg-white px-3 py-1 text-xs">继续解释</button></div>}
      </div>
    </section>
  </div>, document.body)
}
