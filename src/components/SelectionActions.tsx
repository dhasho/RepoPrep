import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SelectionActionsProps {
  anchor: DOMRect
  onAsk: () => void
  onCopy: () => void
  onSelectAll: () => void
  onClose: () => void
  askDisabled?: boolean
}

export default function SelectionActions({ anchor, onAsk, onCopy, onSelectAll, onClose, askDisabled = false }: SelectionActionsProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const left = Math.min(Math.max(anchor.left, 8), Math.max(8, window.innerWidth - box.offsetWidth - 8))
    const top = anchor.bottom + box.offsetHeight + 8 <= window.innerHeight - 8
      ? anchor.bottom + 8
      : Math.max(8, anchor.top - box.offsetHeight - 8)
    setPosition({ left, top })
  }, [anchor])
  useEffect(() => {
    const down = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const scroll = () => onClose()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('scroll', scroll, true)
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true) }
  }, [onClose])
  return createPortal(<div ref={ref} role="toolbar" aria-label="选中文本操作" className="fixed z-50 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-lg" style={{ left: position?.left ?? anchor.left, top: position?.top ?? anchor.bottom + 8, visibility: position ? 'visible' : 'hidden' }}>
    <button type="button" disabled={askDisabled} title={askDisabled ? '选中内容较长，请缩小范围后提问' : undefined} onMouseDown={(event) => event.preventDefault()} onClick={onAsk} className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">向 AI 提问</button>
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCopy} className="rounded-md px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100">复制</button>
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onSelectAll} className="rounded-md px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100">全选</button>
  </div>, document.body)
}
