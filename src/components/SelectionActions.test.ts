// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

test('toolbar callbacks, preserves selection on mousedown, and closes on outside input', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' })
  const g = globalThis as any
  const previous = [g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT]
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const require = createRequire(import.meta.url)
  const { default: Actions } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.render-test/selection-actions.cjs'))
  const calls: string[] = []
  const container = dom.window.document.querySelector('#root')!
  const root = createRoot(container)
  const close = () => calls.push('close')
  try {
    await React.act(async () => root.render(React.createElement(Actions, { anchor: new dom.window.DOMRect(30, 40, 10, 10), onAsk: () => calls.push('ask'), onCopy: () => calls.push('copy'), onSelectAll: () => calls.push('all'), onClose: close })))
    for (const [label, value] of [['向 AI 提问', 'ask'], ['复制', 'copy'], ['全选', 'all']] as const) {
      const button = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === label)!
      const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
      button.dispatchEvent(down)
      assert.equal(down.defaultPrevented, true)
      await React.act(async () => button.click())
      assert.equal(calls.at(-1), value)
    }
    await React.act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })))
    assert.equal(calls.at(-1), 'close')
  } finally {
    await React.act(async () => root.unmount())
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT] = previous
    dom.window.close()
  }
})
