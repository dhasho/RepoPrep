import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { AppIcon } from './AppIcon'

export interface ReadingSplitPaneProps {
  primary: ReactNode
  secondary?: ReactNode
  collapsed: boolean
  onExpand: () => void
}

const DEFAULT_SECONDARY_WIDTH = 400
const HANDLE_WIDTH = 6

export default function ReadingSplitPane({ primary, secondary, collapsed, onExpand }: ReadingSplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const separatorRef = useRef<HTMLDivElement>(null)
  const preferredWidth = useRef(DEFAULT_SECONDARY_WIDTH)
  const [revision, setRevision] = useState(0)
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; bodyCursor: string; bodyUserSelect: string } | null>(null)
  const hasSecondary = secondary !== undefined && secondary !== null

  const measure = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const containerWidth = containerRef.current?.clientWidth ?? 0
  const available = Math.max(0, containerWidth - HANDLE_WIDTH)
  const constrainedWidth = available < 600
    ? available / 2
    : Math.min(Math.max(preferredWidth.current, 280), available - 320)

  const restoreDrag = useCallback((releaseCapture: boolean) => {
    const active = drag.current
    if (!active) return
    drag.current = null
    if (releaseCapture) {
      try { separatorRef.current?.releasePointerCapture(active.pointerId) } catch { /* capture may already be gone */ }
    }
    document.body.style.cursor = active.bodyCursor
    document.body.style.userSelect = active.bodyUserSelect
  }, [])

  useEffect(() => () => restoreDrag(true), [restoreDrag])

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const separator = event.currentTarget
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: constrainedWidth,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    try { separator.setPointerCapture(event.pointerId) } catch { /* window listeners remain the fallback */ }
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = drag.current
      if (!active || event.pointerId !== active.pointerId) return
      event.preventDefault()
      const width = active.startWidth + active.startX - event.clientX
      const min = available < 600 ? 0 : 280
      const max = available < 600 ? available : available - 320
      preferredWidth.current = Math.max(min, Math.min(width, max))
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
  }, [available, measure, restoreDrag])

  const adjustByKeyboard = (key: string) => {
    if (key === 'ArrowLeft') preferredWidth.current = Math.min(preferredWidth.current + 24, Math.max(0, available - 320))
    else if (key === 'ArrowRight') preferredWidth.current = Math.max(preferredWidth.current - 24, available < 600 ? 0 : 280)
    else if (key === 'Home') preferredWidth.current = available < 600 ? 0 : 280
    else if (key === 'End') preferredWidth.current = Math.max(0, available - 320)
    else return
    setRevision((value) => value + 1)
  }

  return <div ref={containerRef} data-reading-split className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
    <div data-reading-primary className="reading-pane min-h-0 min-w-0 flex-1 overflow-auto">{primary}</div>
    {hasSecondary && <>
      {!collapsed && <div ref={separatorRef} role="separator" aria-orientation="vertical" aria-label="调整报告与 AI 解释区域宽度" aria-valuemin={available < 600 ? 0 : 280} aria-valuemax={Math.max(0, available < 600 ? available : available - 320)} aria-valuenow={Math.round(constrainedWidth)} tabIndex={0} onPointerDown={beginDrag} onKeyDown={(event) => adjustByKeyboard(event.key)} className="z-10 w-[6px] shrink-0 cursor-col-resize touch-none border-l border-slate-200 bg-slate-50 hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500" />}
      <aside data-reading-secondary className={`reading-pane flex h-full shrink-0 border-l border-slate-200 bg-white ${collapsed ? 'w-10 flex-col items-center py-2' : 'min-h-0 overflow-auto'}`} style={{ width: collapsed ? '40px' : `${constrainedWidth}px` }}>
        {collapsed && <button type="button" onClick={onExpand} aria-label="展开 AI 解释" title="展开 AI 解释" className="rounded-md p-2 text-indigo-600 hover:bg-indigo-50"><AppIcon name="bot" size={18} /></button>}
        <div hidden={collapsed} className={collapsed ? '' : 'min-h-0 w-full'}>{secondary}</div>
      </aside>
    </>}
  </div>
}
