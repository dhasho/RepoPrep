import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { AppIcon } from './AppIcon'

interface Props {
  children: ReactNode
  visible: boolean
  layoutRef: RefObject<HTMLDivElement>
  minContentWidth?: number
  className?: string
}

const DEFAULT_WIDTH = 288
const MIN_WIDTH = 240
const HANDLE_WIDTH = 6
const MIN_CONTENT_WIDTH = 320

export default function ResizableQuestionOutline({ children, visible, layoutRef, className = '', minContentWidth = MIN_CONTENT_WIDTH }: Props) {
  const handleRef = useRef<HTMLDivElement>(null)
  const preferredWidth = useRef(DEFAULT_WIDTH)
  const [, setRevision] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; bodyCursor: string; bodyUserSelect: string } | null>(null)

  const measure = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    const element = layoutRef.current
    if (!element) return
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [layoutRef, measure])

  const restoreDrag = useCallback((releaseCapture: boolean) => {
    const active = drag.current
    if (!active) return
    drag.current = null
    if (releaseCapture) {
      try { handleRef.current?.releasePointerCapture(active.pointerId) } catch { /* capture may already be gone */ }
    }
    document.body.style.cursor = active.bodyCursor
    document.body.style.userSelect = active.bodyUserSelect
  }, [])

  useEffect(() => () => restoreDrag(true), [restoreDrag])
  useEffect(() => {
    if (!visible || collapsed) restoreDrag(true)
  }, [visible, collapsed, restoreDrag])

  const containerWidth = layoutRef.current?.clientWidth ?? 0
  const maxWidth = containerWidth > 0
    ? Math.max(0, Math.min(420, containerWidth - minContentWidth - HANDLE_WIDTH))
    : DEFAULT_WIDTH
  const minWidth = Math.min(MIN_WIDTH, maxWidth)
  const width = Math.min(Math.max(preferredWidth.current, minWidth), maxWidth)

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return
    event.preventDefault()
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* window listeners remain the fallback */ }
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = drag.current
      if (!active || event.pointerId !== active.pointerId) return
      event.preventDefault()
      preferredWidth.current = Math.max(minWidth, Math.min(active.startWidth + event.clientX - active.startX, maxWidth))
      measure()
    }
    const end = (event: PointerEvent) => {
      if (drag.current?.pointerId === event.pointerId) restoreDrag(true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [maxWidth, measure, minWidth, restoreDrag])

  const adjustByKeyboard = (key: string) => {
    if (key === 'ArrowLeft') preferredWidth.current = Math.max(minWidth, width - 24)
    else if (key === 'ArrowRight') preferredWidth.current = Math.min(maxWidth, width + 24)
    else if (key === 'Home') preferredWidth.current = minWidth
    else if (key === 'End') preferredWidth.current = maxWidth
    else return
    setRevision((value) => value + 1)
  }

  return <>
      <aside aria-label="题目目录" aria-hidden={!visible} hidden={!visible} data-question-directory className={`relative shrink-0 flex-col border-r border-slate-200 bg-white ${visible ? 'flex' : 'hidden'} ${collapsed ? 'w-10 items-center' : ''} ${className}`} style={{ width: collapsed ? '40px' : `${width}px` }}>
        {collapsed
          ? <button type="button" onClick={() => setCollapsed(false)} aria-label="展开题目目录" title="展开题目目录" className="mt-2 rounded-md p-2 text-indigo-600 hover:bg-indigo-50"><AppIcon name="chevron-right" size={18} /></button>
          : <button type="button" onClick={() => setCollapsed(true)} aria-label="收起题目目录" title="收起题目目录" className="absolute right-2 top-4 z-10 rounded p-1 text-slate-400 hover:bg-slate-100"><AppIcon name="arrow-left" size={16} /></button>}
        <div data-directory-content hidden={collapsed} className={`h-full min-h-0 min-w-0 flex-1 flex-col ${collapsed ? 'hidden' : 'flex'}`}>{children}</div>
      </aside>
      {visible && !collapsed && <div ref={handleRef} role="separator" aria-orientation="vertical" aria-label="调整题目目录宽度" aria-valuemin={Math.round(minWidth)} aria-valuemax={Math.round(maxWidth)} aria-valuenow={Math.round(width)} tabIndex={0} onLostPointerCapture={() => restoreDrag(false)} onPointerDown={beginDrag} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) event.preventDefault(); adjustByKeyboard(event.key) }} className="z-10 w-[6px] shrink-0 cursor-col-resize touch-none border-r border-slate-200 bg-slate-50 hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500" />}
  </>
}
