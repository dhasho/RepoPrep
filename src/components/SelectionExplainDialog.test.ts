// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

test('dialog requests only while mounted, bounds request context, caches completed output, and cancels on close', async () => {
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
  const root = createRoot(dom.window.document.querySelector('#root')!)
  const cache = new Map<string, string>()
  const props = { selectedText: 'SELECTED_ORIGINAL', question: 'Q'.repeat(13000), snippet: 'CONTEXT'.repeat(8000), projectSummary: 'S'.repeat(25000), profileId: 'p1', explanationCache: cache, onClose: () => undefined }
  const render = async (show: boolean) => {
    await React.act(async () => root.render(show ? React.createElement(React.StrictMode, null, React.createElement(Dialog, props)) : null))
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
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
    await React.act(async () => handlers[0]({ requestId: requests[0].requestId, type: 'delta', data: 'partial' }))
    await render(false)
    assert.deepEqual(cancelled, [requests[0].requestId])
    assert.equal(cache.size, 0)
    await render(true)
    assert.equal(requests.length, 2)
    await React.act(async () => handlers[1]({ requestId: requests[1].requestId, type: 'delta', data: 'COMPLETE' }))
    await React.act(async () => handlers[1]({ requestId: requests[1].requestId, type: 'done', data: '' }))
    assert.equal(cache.size, 1)
    await render(false)
    await render(true)
    assert.equal(requests.length, 2, 'completed exact context reuses report cache')
  } finally {
    await React.act(async () => root.unmount())
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT] = previous
    dom.window.close()
  }
})
