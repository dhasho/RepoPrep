import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
  onCollapse: () => void
  collapsed?: boolean
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

export default function SelectionExplainPanel({ selectedText, question, snippet, projectSummary, profileId, explanationCache, onCollapse, collapsed = false, onClose }: SelectionExplainPanelProps) {
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
  const panelRef = useRef<HTMLElement>(null)
  const followTailRef = useRef(true)
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
  const noteContentScroll = useCallback(() => {
    const content = contentRef.current
    if (!content) return
    followTailRef.current = content.scrollHeight - content.scrollTop - content.clientHeight < 48
  }, [])
  useEffect(() => {
    const content = contentRef.current
    if (content && followTailRef.current) content.scrollTop = content.scrollHeight
  }, [snapshot.text])
  useEffect(() => { void collapsed }, [collapsed])
  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
  }
  const state = cachedText && snapshot.status === 'idle' ? 'done' : snapshot.status
  const text = snapshot.text || cachedText || (snapshot.status === 'idle' || snapshot.status === 'streaming' ? valid ? '正在准备详细解释…' : '选中内容或模型配置无效，无法发起解释。' : '')

  return <aside ref={panelRef} tabIndex={-1} role="complementary" aria-label="AI 解释" id="selection-explain-panel" onKeyDown={onPanelKeyDown} className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-white">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="text-base font-semibold text-slate-900">向 AI 提问</h2>
        <div className="flex items-center gap-1">
          <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onCollapse} title="收起" aria-label="收起 AI 解释"><AppIcon name="chevron-right" size={16} /></button>
          <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose} title="关闭" aria-label="关闭 AI 解释"><AppIcon name="close" size={16} /></button>
        </div>
      </header>
      <div ref={contentRef} onScroll={noteContentScroll} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 py-4">
        <blockquote className="mb-4 max-h-24 overflow-y-auto break-words [overflow-wrap:anywhere] border-l-2 border-indigo-200 pl-3 text-sm text-slate-500">{safeText}</blockquote>
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-400">AI 解释{snapshot.status === 'streaming' ? '（生成中…）' : ''}
          {snapshot.status === 'streaming' && <button type="button" onClick={() => controller.stop()} className="text-slate-500 hover:text-slate-700">停止</button>}
        </div>
        <div className="min-w-0 [overflow-wrap:anywhere]"><MarkdownView markdown={text} /></div>
        {state === 'done' && <button type="button" className="mt-3 w-full rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50" onClick={start}>重新解释</button>}
        {snapshot.status === 'error' && <div className="py-3 text-center text-sm text-rose-600"><p className="mb-2">解释失败：{snapshot.error}</p><button type="button" onClick={start} className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600">重试</button></div>}
        {snapshot.status === 'stopped' && <div className="mt-2 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500"><span>已停止生成</span><button type="button" onClick={start} className="rounded border border-slate-200 bg-white px-3 py-1 text-xs">继续解释</button></div>}
      </div>
    </aside>
}
