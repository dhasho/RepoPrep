// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

test('question directory resizes, preserves its content on collapse, and fully hides when requested', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' })
  const g = globalThis as any
  const previous = [g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT, g.ResizeObserver]
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true
  g.ResizeObserver = undefined
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const require = createRequire(import.meta.url)
  const { default: Outline } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.render-test/resizable-question-outline.cjs'))
  const container = dom.window.document.querySelector('#root') as HTMLElement
  const root = createRoot(container)
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1000 })
  let visible = true
  let minContentWidth = 320
  const render = async () => React.act(async () => root.render(React.createElement(Outline, {
    visible,
    minContentWidth,
    layoutRef: { current: container },
    children: React.createElement('div', null,
      React.createElement('input', { 'aria-label': '目录搜索', defaultValue: '缓存' }),
      React.createElement('nav', { 'data-directory-scroll': true, style: { overflowY: 'auto', height: '100px' } }, React.createElement('div', { style: { height: '400px' } }, '目录内容'))
    )
  })))
  const pointer = (target: Element, type: string, x: number, id = 7) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true }) as any
    Object.defineProperty(event, 'pointerId', { value: id })
    Object.defineProperty(event, 'button', { value: 0 })
    Object.defineProperty(event, 'clientX', { value: x })
    target.dispatchEvent(event)
  }
  const width = () => parseFloat((dom.window.document.querySelector('[data-question-directory]') as HTMLElement).style.width)
  try {
    await render()
    assert.equal(width(), 288)
    assert.equal(dom.window.document.querySelector('[role="separator"]')?.getAttribute('aria-label'), '调整题目目录宽度')
    const nav = dom.window.document.querySelector('[data-directory-scroll]') as HTMLElement
    nav.scrollTop = 47
    const separator = dom.window.document.querySelector('[role="separator"]')!
    await React.act(async () => pointer(separator, 'pointerdown', 300))
    const move = new dom.window.Event('pointermove', { bubbles: true, cancelable: true }) as any
    Object.defineProperty(move, 'pointerId', { value: 7 })
    Object.defineProperty(move, 'clientX', { value: 360 })
    await React.act(async () => dom.window.dispatchEvent(move))
    assert.equal(width(), 348)
    const up = new dom.window.Event('pointerup', { bubbles: true }) as any
    Object.defineProperty(up, 'pointerId', { value: 7 })
    await React.act(async () => dom.window.dispatchEvent(up))
    dom.window.document.body.style.cursor = 'crosshair'
    dom.window.document.body.style.userSelect = 'text'
    await React.act(async () => pointer(separator, 'pointerdown', 360, 8))
    const cancel = new dom.window.Event('pointercancel', { bubbles: true }) as any
    Object.defineProperty(cancel, 'pointerId', { value: 8 })
    await React.act(async () => dom.window.dispatchEvent(cancel))
    assert.equal(dom.window.document.body.style.cursor, 'crosshair', 'cancel restores the prior body cursor')
    assert.equal(dom.window.document.body.style.userSelect, 'text', 'cancel restores the prior selection behavior')

    await React.act(async () => (dom.window.document.querySelector('[aria-label="收起题目目录"]') as HTMLButtonElement).click())
    assert.equal(width(), 40)
    assert.equal((dom.window.document.querySelector('[data-directory-content]') as HTMLElement).hidden, true)
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('[data-directory-content]') as HTMLElement).display, 'none')
    assert.equal((dom.window.document.querySelector('[data-directory-scroll]') as HTMLElement).scrollTop, 47)
    assert.equal((dom.window.document.querySelector('[aria-label="目录搜索"]') as HTMLInputElement).value, '缓存')
    await React.act(async () => (dom.window.document.querySelector('[aria-label="展开题目目录"]') as HTMLButtonElement).click())
    assert.equal(width(), 348, 'preferred width is restored on expansion')

    visible = false
    await render()
    assert.equal((dom.window.document.querySelector('[data-question-directory]') as HTMLElement).hidden, true)
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('[data-question-directory]') as HTMLElement).display, 'none')
    assert.equal(dom.window.document.querySelector('[role="separator"]'), null)
    assert.equal((dom.window.document.querySelector('[data-directory-scroll]') as HTMLElement).scrollTop, 47)
    visible = true
    await render()
    assert.equal(width(), 348)
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 932 })
    minContentWidth = 606
    await render()
    assert.equal(width(), 320, 'opening AI preserves space for both report and explanation')
    minContentWidth = 320
    await render()
    assert.equal(width(), 348, 'closing AI restores the directory preference instead of overwriting it')
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 560 })
    await React.act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
    await render()
    assert.equal(width(), 234, 'narrow page leaves at least 320px for the report area')
    assert.ok(width() <= 234, 'the directory cannot overflow the remaining report area')
  } finally {
    await React.act(async () => root.unmount())
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT, g.ResizeObserver] = previous
    dom.window.close()
  }
})
