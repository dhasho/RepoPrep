// 点词只读取术语表；自由文本的 AI 解释由独立的框选操作触发。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import MarkdownView from './MarkdownView'
import { AppIcon } from './AppIcon'

export interface TermPopoverProps {
  term: string
  anchor: DOMRect
  definition?: string
  onClose: () => void
}

const POPOVER_WIDTH = 380

export default function TermPopover({ term, anchor, definition, onClose }: TermPopoverProps) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - 12))
    let top = anchor.bottom + 10
    if (top + el.offsetHeight > window.innerHeight - 12) top = Math.max(anchor.top - 10 - el.offsetHeight, 12)
    setPos({ left, top })
  }, [anchor, term, definition])

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onScroll = (event: Event) => {
      if (boxRef.current && event.target && 'nodeType' in event.target && boxRef.current.contains(event.target as Node)) return
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

  return createPortal(
    <div
      ref={boxRef}
      className="fixed z-50 flex max-h-[55vh] w-[380px] flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
      role="dialog"
      aria-label={`${term}：术语表解释`}
      style={{ left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.bottom + 10, visibility: pos ? 'visible' : 'hidden' }}
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <p className="mb-1 text-xs font-medium text-slate-400">术语表</p>
        <MarkdownView markdown={definition || '术语表暂无此项解释，可选中文本后使用“向 AI 提问”。'} />
      </div>
    </div>,
    document.body
  )
}
