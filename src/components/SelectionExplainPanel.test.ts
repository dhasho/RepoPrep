// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

test('panel lifecycle, focus, bounded context, stale events, and per-report completion cache', async () => {
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
  const { default: Panel } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.render-test/selection-explain-panel.cjs'))
  const container = dom.window.document.querySelector('#root')!
  const root = createRoot(container)
  const cache = new Map<string, string>()
  const closeCalls: string[] = []
  const collapseCalls: string[] = []
  const trigger = dom.window.document.createElement('button')
  trigger.textContent = 'trigger'; dom.window.document.body.appendChild(trigger); trigger.focus()
  const props = { selectedText: 'SELECTED_ORIGINAL', question: 'Q'.repeat(13000), snippet: 'CONTEXT'.repeat(8000), projectSummary: 'S'.repeat(25000), profileId: 'p1', explanationCache: cache, onClose: () => { closeCalls.push('close') }, onCollapse: () => { collapseCalls.push('collapse') } }
  const render = async (show: boolean, overrides: Record<string, unknown> = {}) => {
    await React.act(async () => root.render(show ? React.createElement(React.StrictMode, null, React.createElement('div', { id: 'host', hidden: Boolean(overrides.collapsed) }, React.createElement(Panel, { ...props, ...overrides }))) : null))
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
    const panel = dom.window.document.querySelector('#selection-explain-panel')!
    const content = panel.querySelector('.overflow-y-auto') as HTMLDivElement
    let mockScrollTop = 400
    let mockScrollHeight = 1000
    let mockClientHeight = 200
    const scrollWrites: number[] = []
    Object.defineProperties(content, {
      scrollTop: { configurable: true, get: () => mockScrollTop, set: (value: number) => { mockScrollTop = value; scrollWrites.push(value) } },
      scrollHeight: { configurable: true, get: () => mockScrollHeight },
      clientHeight: { configurable: true, get: () => mockClientHeight }
    })
    assert.equal(panel.getAttribute('role'), 'complementary')
    assert.equal(dom.window.document.querySelector('[role="dialog"], [aria-modal], .fixed, [data-reactroot]'), null, 'panel has no modal, backdrop, or portal wrapper')
    assert.equal(dom.window.document.activeElement, trigger, 'mount does not steal focus from the report')
    await React.act(async () => panel.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })))
    assert.equal(closeCalls.length, 0, 'internal mousedown does not close')
    await React.act(async () => { const scrollable = panel.querySelector('.overflow-y-auto')!; scrollable.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })) })
    assert.equal(closeCalls.length, 0)
    const closeButton = panel.querySelector<HTMLButtonElement>('[aria-label="关闭 AI 解释"]')!
    const outside = dom.window.document.createElement('button'); outside.textContent = 'report control'; dom.window.document.body.appendChild(outside)
    await React.act(async () => { closeButton.focus(); dom.window.document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    assert.equal(closeCalls.length, 0, 'Tab is not trapped')
    await React.act(async () => { const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); outside.dispatchEvent(event) })
    assert.equal(closeCalls.length, 0, 'Escape outside panel does not close')
    outside.focus()
    await React.act(async () => { const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); panel.dispatchEvent(event) })
    assert.equal(closeCalls.length, 0, 'Escape on the region does not close while focus is outside')
    await React.act(async () => { closeButton.focus(); const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); closeButton.dispatchEvent(event) })
    assert.equal(closeCalls.length, 1, 'Escape inside panel closes')
    await render(true)
    assert.equal(requests.length, 1)
    mockScrollTop = 240
    await React.act(async () => content.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
    const visibleWrites = scrollWrites.length
    await emit(0, 'delta', 'VISIBLE_STREAM_WHILE_READING')
    assert.equal(scrollWrites.length, visibleWrites, 'new deltas do not pull a reader away from earlier text')
    await render(true, { collapsed: true })
    assert.equal(requests.length, 1, 'collapse does not restart request')
    assert.deepEqual(cancelled, [], 'collapse does not cancel request')
    assert.equal((dom.window.document.querySelector('#host') as HTMLElement).hidden, true, 'test host hides the mounted panel')
    mockScrollTop = 0; mockClientHeight = 0; mockScrollHeight = 0
    const hiddenWrites = scrollWrites.length
    await emit(0, 'delta', 'STREAM_WHILE_COLLAPSED')
    assert.ok(dom.window.document.body.textContent?.includes('STREAM_WHILE_COLLAPSED'), 'stream remains mounted while collapsed')
    assert.equal(scrollWrites.length, hiddenWrites, 'hidden stream updates do not write zero-sized scroll state')
    await React.act(async () => (panel.querySelector('[aria-label="收起 AI 解释"]') as HTMLButtonElement).click())
    assert.equal(collapseCalls.length, 1, 'collapse control calls its callback')
    mockClientHeight = 200; mockScrollHeight = 1600
    await render(true, { collapsed: false })
    assert.equal(mockScrollTop, 240, 'expanding restores the prior reading position')
    assert.equal(requests.length, 1)
    assert.deepEqual(cancelled, [])
    assert.ok(dom.window.document.body.textContent?.includes('STREAM_WHILE_COLLAPSED'), 'expanded panel retains accumulated stream')
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
    await React.act(async () => panel.dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, true, 'Escape is handled inside panel')
    assert.equal(closeCalls.length, 2)
    outside.focus()
    await render(false)
    assert.ok(!panel.contains(dom.window.document.activeElement), 'panel removal does not retain focus inside the removed panel')
    await render(true, { profileId: 'p1', question: 'OTHER_QUESTION' })
    await React.act(async () => (dom.window.document.querySelector('[aria-label="关闭 AI 解释"]') as HTMLButtonElement).click())
    assert.equal(closeCalls.length, 3, 'close control calls its callback')
  } finally {
    await React.act(async () => root.unmount())
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT] = previous
    dom.window.close()
  }
})
