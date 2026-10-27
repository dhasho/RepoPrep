// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

test('reading split pane resizes, collapses without unmounting, and cleans up drag state', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' })
  const g = globalThis as any
  const previous = [g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT, g.ResizeObserver]
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true
  g.ResizeObserver = undefined
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const require = createRequire(import.meta.url)
  const { default: Pane } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.render-test/reading-split-pane.cjs'))
  const container = dom.window.document.querySelector('#root') as HTMLElement
  const root = createRoot(container)
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1000 })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.hasAttribute('data-reading-split') ? container.clientWidth : 0 } })
  let collapsed = false
  let secondaryUnmounts = 0
  function Secondary() {
    React.useEffect(() => () => { secondaryUnmounts++ }, [])
    return React.createElement('div', null, 'AI explanation')
  }
  const render = async (withSecondary = true) => React.act(async () => root.render(React.createElement(Pane, {
    primary: React.createElement('div', null, 'Report'),
    secondary: withSecondary ? React.createElement(Secondary) : undefined,
    collapsed,
    onExpand: () => { collapsed = false }
  })))
  const pointer = (target: Element, type: string, x: number, id = 7) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true }) as any
    Object.defineProperty(event, 'pointerId', { value: id })
    Object.defineProperty(event, 'button', { value: 0 })
    Object.defineProperty(event, 'clientX', { value: x })
    target.dispatchEvent(event)
  }
  const width = () => parseFloat((dom.window.document.querySelector('[data-reading-secondary]') as HTMLElement).style.width)
  try {
    await render(false)
    assert.equal(dom.window.document.querySelector('[role="separator"]'), null)
    assert.equal((dom.window.document.querySelector('[data-reading-primary]') as HTMLElement).className.includes('flex-1'), true)
    await render()
    const separator = dom.window.document.querySelector('[role="separator"]')!
    assert.equal(width(), 400)
    assert.equal(separator.getAttribute('aria-label'), '调整报告与 AI 解释区域宽度')
    dom.window.document.body.style.cursor = 'crosshair'
    dom.window.document.body.style.userSelect = 'text'
    await React.act(async () => pointer(separator, 'pointerdown', 500))
    const move = new dom.window.Event('pointermove', { bubbles: true, cancelable: true }) as any
    Object.defineProperty(move, 'pointerId', { value: 7 })
    Object.defineProperty(move, 'clientX', { value: 450 })
    await React.act(async () => dom.window.dispatchEvent(move))
    assert.equal(width(), 450, 'dragging left grows the secondary pane')
    const up = new dom.window.Event('pointerup', { bubbles: true }) as any
    Object.defineProperty(up, 'pointerId', { value: 7 })
    await React.act(async () => dom.window.dispatchEvent(up))
    assert.equal(dom.window.document.body.style.cursor, 'crosshair')
    assert.equal(dom.window.document.body.style.userSelect, 'text')
    const endKey = new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
    await React.act(async () => separator.dispatchEvent(endKey))
    assert.equal(endKey.defaultPrevented, true, 'supported resize keys do not scroll the page')
    assert.equal(width(), 674, 'End reaches the maximum while preserving 320px primary space')
    await React.act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    assert.equal(width(), 280)
    await React.act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(width(), 280, 'ArrowRight cannot cross the minimum')
    await React.act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    assert.equal(width(), 674)
    await React.act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    assert.equal(width(), 674, 'ArrowLeft cannot cross the maximum')
    await React.act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    await React.act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    assert.equal(width(), 304)

    await React.act(async () => pointer(separator, 'pointerdown', 400, 8))
    assert.equal(dom.window.document.body.style.cursor, 'col-resize')
    const cancel = new dom.window.Event('pointercancel', { bubbles: true }) as any
    Object.defineProperty(cancel, 'pointerId', { value: 8 })
    await React.act(async () => dom.window.dispatchEvent(cancel))
    assert.equal(dom.window.document.body.style.cursor, 'crosshair')
    assert.equal(dom.window.document.body.style.userSelect, 'text')

    await React.act(async () => pointer(separator, 'pointerdown', 400, 10))
    const widthBeforeExtraPointer = width()
    await React.act(async () => pointer(separator, 'pointerdown', 300, 11))
    assert.equal(dom.window.document.body.style.cursor, 'col-resize')
    const extraMove = new dom.window.Event('pointermove', { bubbles: true, cancelable: true }) as any
    Object.defineProperty(extraMove, 'pointerId', { value: 11 })
    Object.defineProperty(extraMove, 'clientX', { value: 200 })
    await React.act(async () => dom.window.dispatchEvent(extraMove))
    assert.equal(width(), widthBeforeExtraPointer, 'a second pointer cannot take over the active drag')
    const firstUp = new dom.window.Event('pointerup', { bubbles: true }) as any
    Object.defineProperty(firstUp, 'pointerId', { value: 10 })
    await React.act(async () => dom.window.dispatchEvent(firstUp))
    assert.equal(dom.window.document.body.style.cursor, 'crosshair')
    assert.equal(dom.window.document.body.style.userSelect, 'text')

    collapsed = true
    await render()
    assert.equal(dom.window.document.querySelector('[role="separator"]'), null)
    assert.equal(dom.window.document.querySelector('[data-reading-secondary]')?.textContent, 'AI explanation')
    assert.equal(secondaryUnmounts, 0)
    const expand = dom.window.document.querySelector('[aria-label="展开 AI 解释"]')!
    await React.act(async () => (expand as HTMLButtonElement).click())
    await render()
    assert.equal(width(), 304, 'preferred width survives collapse and expansion')

    const expandedSeparator = dom.window.document.querySelector('[role="separator"]')!
    await React.act(async () => pointer(expandedSeparator, 'pointerdown', 400, 12))
    assert.equal(dom.window.document.body.style.cursor, 'col-resize')
    collapsed = true
    await render()
    assert.equal(dom.window.document.body.style.cursor, 'crosshair', 'collapsing during drag restores body styles')
    assert.equal(dom.window.document.body.style.userSelect, 'text')
    collapsed = false
    await render()
    assert.equal(width(), 304)

    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 450 })
    await React.act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
    await render()
    assert.equal(width(), 284, 'narrow layout preserves at least 160px for the report when clamping a preferred width')
    const narrowSeparator = dom.window.document.querySelector('[role="separator"]')!
    await React.act(async () => pointer(narrowSeparator, 'pointerdown', 300, 13))
    const narrowMove = new dom.window.Event('pointermove', { bubbles: true, cancelable: true }) as any
    Object.defineProperty(narrowMove, 'pointerId', { value: 13 })
    Object.defineProperty(narrowMove, 'clientX', { value: 320 })
    await React.act(async () => dom.window.dispatchEvent(narrowMove))
    assert.equal(width(), 264, 'narrow layout remains draggable while preserving space for both panes')
    assert.equal(narrowSeparator.getAttribute('aria-valuemin'), '160')
    assert.equal(narrowSeparator.getAttribute('aria-valuemax'), '284')
    await React.act(async () => narrowSeparator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    assert.equal(width(), 160, 'narrow layout keeps the secondary pane usable')
    await React.act(async () => narrowSeparator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    assert.equal(width(), 284, 'narrow layout keeps at least 160px for the report')
    const narrowUp = new dom.window.Event('pointerup', { bubbles: true }) as any
    Object.defineProperty(narrowUp, 'pointerId', { value: 13 })
    await React.act(async () => dom.window.dispatchEvent(narrowUp))

    await React.act(async () => pointer(dom.window.document.querySelector('[role="separator"]')!, 'pointerdown', 300, 9))
    assert.equal(dom.window.document.body.style.userSelect, 'none')
    await React.act(async () => root.unmount())
    assert.equal(dom.window.document.body.style.cursor, 'crosshair')
    assert.equal(dom.window.document.body.style.userSelect, 'text')
    assert.equal(secondaryUnmounts, 1)
  } finally {
    if (dom.window.document.querySelector('#root')?.hasChildNodes()) await React.act(async () => root.unmount())
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT, g.ResizeObserver] = previous
    dom.window.close()
  }
})
