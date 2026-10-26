import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const TermPopover = require('../../.render-test/term-popover.cjs').default

async function withPopover(definition: string | undefined, run: (h: { dom: JSDOM; container: HTMLElement; requests: string[]; closed: () => number }) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><p id="outside">outside</p></body></html>', { url: 'http://localhost/' })
  const g = globalThis as unknown as Record<string, unknown>
  const previous = [g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT]
  g.window = dom.window
  g.document = dom.window.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  const requests: string[] = []
  ;(dom.window as unknown as Record<string, unknown>).api = { explain: () => { requests.push('unexpected') } }
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  let closed = 0
  let mounted = true
  try {
    await React.act(async () => { root.render(React.createElement(TermPopover, {
      term: 'Electron', definition, anchor: new dom.window.DOMRect(10, 10, 20, 20),
      onClose: () => { closed++; mounted = false; root.unmount() }
    })) })
    await run({ dom, container, requests, closed: () => closed })
  } finally {
    if (mounted) await React.act(async () => { root.unmount() })
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT] = previous
    dom.window.close()
  }
}

test('term popover is a stable glossary view and never requests AI, with or without a definition', async () => {
  for (const definition of ['这是一个跨平台桌面框架。它用主进程协调系统能力，渲染进程显示界面。', undefined]) {
    await withPopover(definition, async ({ container, requests }) => {
      const before = container.textContent
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)) })
      assert.deepEqual(requests, [])
      assert.equal(container.textContent, before, 'no delayed replacement or generation screen')
      assert.ok(container.textContent?.includes('术语表'))
      assert.ok(!container.textContent?.includes('生成中'))
      assert.equal(container.querySelectorAll('.md-body').length, definition ? 2 : 1)
      assert.equal(container.querySelectorAll('button').length, 1, 'only the close button; no automatic or manual model action here')
      if (definition) {
        assert.equal([...container.querySelectorAll('.md-body')].map((body) => body.textContent).join(''), definition)
        assert.ok(container.querySelector('section[aria-label="是什么"] .pl-3'))
        assert.ok(container.querySelector('section[aria-label="如何作用"] .pl-3'))
      } else assert.ok(container.textContent?.includes('术语表暂无此项解释'))
    })
  }
})

test('glossary formatting preserves inline code and already formatted lists', async () => {
  await withPopover('框架使用 `Node.js` 提供系统能力。它通过 IPC 交换消息。', async ({ container }) => {
    assert.equal(container.querySelector('section[aria-label="是什么"] code')?.textContent, 'Node.js')
    assert.equal(container.querySelector('section[aria-label="如何作用"] .md-body')?.textContent, '它通过 IPC 交换消息。')
  })
  await withPopover('已有解释。\n\n- 保留原列表\n- 保留第二项', async ({ container }) => {
    assert.equal(container.querySelectorAll('li').length, 2)
    assert.equal(container.querySelectorAll('.md-body').length, 1)
    assert.equal(container.querySelector('section[aria-label="如何作用"]'), null)
  })
})

test('glossary internal scrolling stays open; Escape, outside clicks and external scroll close it', async () => {
  for (const closeBy of ['escape', 'outside', 'scroll'] as const) {
    await withPopover('第一句定义。第二句解释如何作用。', async ({ dom, container, requests, closed }) => {
      const content = container.querySelector('.overflow-y-auto')!
      await React.act(async () => { content.dispatchEvent(new dom.window.Event('scroll')) })
      assert.equal(closed(), 0)
      await React.act(async () => {
        if (closeBy === 'escape') dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
        else if (closeBy === 'outside') dom.window.document.getElementById('outside')!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
        else dom.window.document.dispatchEvent(new dom.window.Event('scroll'))
      })
      assert.equal(closed(), 1)
      assert.deepEqual(requests, [])
    })
  }
})
