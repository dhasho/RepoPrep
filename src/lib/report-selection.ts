export interface ReportSelection {
  text: string
  anchor: DOMRect
  range: Range
  questionIndex: number | null
}

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement
}

/** Only selections wholly owned by the visible report can become model input. */
export function readReportSelection(root: HTMLElement, pointer?: { x: number; y: number }): ReportSelection | null {
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = elementOf(range.startContainer)
  const end = elementOf(range.endContainer)
  if ([start, end].some((element) => element?.closest('input, textarea, [contenteditable="true"]'))) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const question = start?.closest('[data-report-question]')
  const sameQuestion = question && question === end?.closest('[data-report-question]')
  const index = sameQuestion ? Number(question.getAttribute('data-report-question')) : NaN
  const bounds = typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect()
    : start?.getBoundingClientRect()
  const ViewRect = root.ownerDocument.defaultView!.DOMRect
  const anchor = pointer
    ? new ViewRect(pointer.x, pointer.y, 0, 0)
    : new ViewRect(bounds?.left ?? 0, bounds?.top ?? 0, bounds?.width ?? 0, bounds?.height ?? 0)
  return { text, anchor, range: range.cloneRange(), questionIndex: Number.isInteger(index) && index > 0 ? index : null }
}

export function selectReportText(root: HTMLElement): ReportSelection | null {
  const selection = root.ownerDocument.getSelection()
  if (!selection) return null
  const range = root.ownerDocument.createRange()
  range.selectNodeContents(root)
  selection.removeAllRanges()
  selection.addRange(range)
  return readReportSelection(root)
}

/** Clipboard writes happen only from the user's Copy action; no Electron API is exposed. */
export async function copyReportSelection(root: HTMLElement, selected: ReportSelection): Promise<boolean> {
  const doc = root.ownerDocument
  try {
    const clipboard = doc.defaultView?.navigator.clipboard
    if (clipboard?.writeText) {
      await clipboard.writeText(selected.text)
      return true
    }
  } catch {
    // Some desktop environments deny the async Clipboard API; retain Ctrl+C semantics.
  }
  if (!root.contains(selected.range.startContainer) || !root.contains(selected.range.endContainer)) return false
  try {
    const selection = doc.getSelection()
    if (!selection || typeof doc.execCommand !== 'function') return false
    selection.removeAllRanges()
    selection.addRange(selected.range)
    return doc.execCommand('copy')
  } catch {
    return false
  }
}
