// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

test('dialog lifecycle, focus, bounded context, stale events, and per-report completion cache', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' })
  type E = { requestId: string; type: 'delta' | 'done' | 'error'; data: string }
  const requests: Array<Record<string, string>> = []
  const cancelled: string[] = []
  const handlers: Array<(event: E) => void> = []
  ;(dom.window as any).api = { explain: async (req: Record<string, string>) => { requests.push(req) }, cancelExplain: (id: string) => cancelled.push(id), onExplainEvent: (cb: (event: E) => void) => { handlers.push(cb); return () => undefined } }
  const g = globalThis as any
  const previous = [g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT]
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const require = createRequire(import.meta.url)
  const { default: Dialog } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.render-test/selection-explain-dialog.cjs'))
  const container = dom.window.document.querySelector('#root')!
  const root = createRoot(container)
  const cache = new Map<string, string>()
  const closeCalls: string[] = []
  const trigger = dom.window.document.createElement('button')
  trigger.textContent = 'trigger'; dom.window.document.body.appendChild(trigger); trigger.focus()
  const props = { selectedText: 'SELECTED_ORIGINAL', question: 'Q'.repeat(13000), snippet: 'CONTEXT'.repeat(8000), projectSummary: 'S'.repeat(25000), profileId: 'p1', explanationCache: cache, onClose: () => { closeCalls.push('close') } }
  const render = async (show: boolean, overrides: Record<string, unknown> = {}) => {
    await React.act(async () => root.render(show ? React.createElement(React.StrictMode, null, React.createElement(Dialog, { ...props, ...overrides })) : null))
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  }
  const emit = async (index: number, type: E['type'], data = '') => React.act(async () => handlers[index]({ requestId: requests[index].requestId, type, data }))
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === label)
    assert.ok(button, `missing button ${label}`)
    await React.act(async () => button!.click())
  }
  try {
    assert.equal(requests.length, 0)
    await render(true)
    assert.equal(requests.length, 1, 'StrictMode starts one real request')
    assert.ok(requests[0].snippet.length <= 24_000)
    assert.ok(requests[0].snippet.includes('SELECTED_ORIGINAL'))
    assert.equal(requests[0].term, 'SELECTED_ORIGINAL')
    assert.ok(requests[0].question.length <= 12_000)
    assert.ok(requests[0].projectSummary.length <= 20_000)
    const dialog = dom.window.document.querySelector('[role="dialog"]')!
    assert.equal(dom.window.document.activeElement, dialog.querySelector('button'), 'focus enters the modal')
    await React.act(async () => dialog.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })))
    assert.equal(closeCalls.length, 0, 'internal mousedown and scrolling do not close')
    await React.act(async () => { const scrollable = dialog.querySelector('.overflow-y-auto')!; scrollable.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })) })
    assert.equal(closeCalls.length, 0)
    await React.act(async () => { const buttons = [...dialog.querySelectorAll('button')]; buttons[buttons.length - 1].focus(); dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    assert.equal(dom.window.document.activeElement, dialog.querySelector('button'), 'Tab wraps at the final control')
    await React.act(async () => { const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }); dom.window.dispatchEvent(event) })
    assert.equal(dom.window.document.activeElement, [...dialog.querySelectorAll('button')].at(-1), 'Shift+Tab wraps at the first control')
    await emit(0, 'delta', 'PARTIAL_ERROR')
    await emit(0, 'error', 'failure')
    assert.equal(cache.size, 0, 'partial error result is not cached')
    assert.ok(!dom.window.document.body.textContent?.includes('正在准备详细解释'))
    assert.ok(dom.window.document.body.textContent?.includes('解释失败'))
    const oldId = requests[0].requestId
    await click('重试')
    assert.equal(requests.length, 2)
    assert.notEqual(requests[1].requestId, oldId, 'retry starts a new request id')
    await emit(1, 'delta', 'PARTIAL_STOP')
    await click('停止')
    assert.equal(cache.size, 0, 'stopped partial result is not cached')
    assert.deepEqual(cancelled, [requests[1].requestId])
    assert.ok(!dom.window.document.body.textContent?.includes('正在准备详细解释'))
    await click('继续解释')
    assert.equal(requests.length, 3)
    assert.notEqual(requests[2].requestId, requests[1].requestId)
    await emit(2, 'delta', 'OLD_CONTEXT_TEXT')
    await render(true, { question: 'OTHER_QUESTION' })
    assert.equal(requests.length, 4, 'changing context starts an isolated request')
    assert.deepEqual(cancelled, [requests[1].requestId, requests[2].requestId], 'context replacement cancels the previous request')
    await emit(2, 'delta', 'LATE_OLD_DELTA')
    await emit(2, 'done')
    await emit(2, 'error', 'late error')
    assert.ok(!dom.window.document.body.textContent?.includes('LATE_OLD_DELTA'))
    assert.equal(cache.size, 0, 'late completion from prior context is not cached')
    await emit(3, 'delta', 'NEW_CONTEXT_COMPLETE')
    await emit(3, 'done')
    assert.equal(cache.size, 1)
    await render(true, { question: 'OTHER_QUESTION' })
    assert.equal(requests.length, 4, 'completed exact context reuses report cache')
    assert.ok(dom.window.document.body.textContent?.includes('NEW_CONTEXT_COMPLETE'))
    await render(true, { profileId: 'P'.repeat(129) })
    assert.equal(requests.length, 4, 'invalid long profile identity never requests')
    assert.ok(dom.window.document.body.textContent?.includes('模型配置无效'))
    await render(true, { profileId: 'p1', question: 'OTHER_QUESTION' })
    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await React.act(async () => dom.window.dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, true, 'Escape is consumed by the modal')
    assert.equal(closeCalls.length, 1, 'Escape closes the modal')
    await render(false)
    assert.equal(dom.window.document.activeElement, trigger, 'closing restores focus to the still-connected trigger')
    await render(true, { profileId: 'p1', question: 'OTHER_QUESTION' })
    await React.act(async () => dom.window.document.querySelector('.fixed.inset-0')!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })))
    assert.equal(closeCalls.length, 2, 'backdrop click closes the modal')
  } finally {
    await React.act(async () => root.unmount())
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT] = previous
    dom.window.close()
  }
})
