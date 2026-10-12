// 术语弹卡的组件级测试（issue #12）
//
// 分工说明：
// - 「快速切换词条不串流」「停止不算错误」等竞态属于控制器逻辑，
//   由 src/lib/explain-stream.test.ts 覆盖（真实控制器 + 假 API）。
// - 「卸载即取消请求」是组件 effect 里接的线，renderToStaticMarkup 不执行
//   effect，因此这里用 jsdom 真实挂载/卸载来断言 cancelExplain 被调用。
// - 其余渲染断言（各状态文案、按钮显隐）用静态渲染即可。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type React from 'react'

const noop = () => undefined

async function requireBundlePath(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundlePath = path.join(here, '..', '..', '.render-test', 'term-popover.cjs')
  const fs = await import('node:fs/promises')
  await fs.access(bundlePath)
  return bundlePath
}

async function renderPopover(props: Record<string, unknown>): Promise<string> {
  const bundlePath = await requireBundlePath()

  // 组件用了 createPortal（需要 document.body）与 window 尺寸读取
  const g = globalThis as unknown as { window?: unknown; document?: unknown }
  const prevWindow = g.window
  const prevDocument = g.document
  g.window = {
    innerWidth: 1280,
    innerHeight: 800,
    api: {
      explain: () => new Promise<void>(noop),
      cancelExplain: noop,
      onExplainEvent: () => noop
    }
  }
  g.document = { body: {} }

  try {
    const { createRequire } = await import('node:module')
    const requireBundle = createRequire(import.meta.url)
    const mod = requireBundle(bundlePath) as { default?: React.ComponentType<Record<string, unknown>> }
    assert.ok(mod?.default, 'render-test bundle must export TermPopover')
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    return renderToStaticMarkup(
      React.createElement(mod.default, {
        term: '依赖注入',
        anchor: { left: 10, top: 10, bottom: 30, right: 10, width: 0, height: 20 },
        question: '为什么这样设计？',
        snippet: '片段',
        projectSummary: '摘要',
        profileId: 'p1',
        onClose: noop,
        ...props
      })
    )
  } finally {
    g.window = prevWindow
    g.document = prevDocument
  }
}

test('组件级：有术语表解释时展示术语表并停留在 idle（显示手动触发按钮）', async () => {
  const html = await renderPopover({ glossaryHint: '一种解耦方式' })
  assert.ok(html.includes('名词'), '应渲染出弹卡「名词」标签')
  assert.ok(html.includes('术语表'), '应展示术语表解释')
  assert.ok(html.includes('让 AI 结合本项目详细解释'), '应显示手动触发按钮')
  assert.ok(!html.includes('已停止生成'), 'idle 状态不应出现已停止提示')
  assert.ok(!html.includes('解释失败'), 'idle 状态不应出现失败提示')
  assert.ok(!html.includes('生成中'), 'idle 状态不应显示生成中')
})

test('组件级：idle 状态不渲染「停止」按钮（只有 streaming 才显示）', async () => {
  const html = await renderPopover({ glossaryHint: '一种解耦方式' })
  assert.ok(!html.includes('>停止<'), 'idle 时不应出现停止按钮')
  assert.ok(!html.includes('继续解释'), 'idle 时不应出现继续解释按钮')
})

test('组件级：组件接上了控制器（自动请求分支不会抛错，且渲染出流式区域）', async () => {
  // 无 glossaryHint 时组件会在 effect 里自动 start；静态渲染不跑 effect，
  // 因此这里只验证渲染本身不抛错、且未进入错误/停止态。
  const html = await renderPopover({})
  assert.ok(html.includes('名词'), '应正常渲染')
  assert.ok(!html.includes('解释失败'), '自动请求分支不应直接进入错误态')
  assert.ok(!html.includes('已停止生成'), '不应直接进入已停止态')
})

// 用 jsdom 真实挂载/卸载组件，断言卸载时的 effect 清理确实调用了 cancelExplain
// （验收标准 1：关闭弹窗后对应网络请求立即终止 —— 这条线漏接，单测层发现不了）。
test('组件级（真实挂载）：卸载时取消进行中的解释请求并退订事件', async () => {
  const bundlePath = await requireBundlePath()

  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })

  const explained: string[] = []
  const cancelled: string[] = []
  let unsubscribed = 0
  const never = () => new Promise<void>(() => {})

  const g = globalThis as unknown as Record<string, unknown>
  const prevWindow = g.window
  const prevDocument = g.document
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT
  ;(dom.window as unknown as Record<string, unknown>).api = {
    explain: (req: { requestId: string }) => {
      explained.push(req.requestId)
      return never()
    },
    cancelExplain: (requestId: string) => {
      cancelled.push(requestId)
    },
    onExplainEvent: () => () => {
      unsubscribed++
    }
  }
  g.window = dom.window
  g.document = dom.window.document
  g.IS_REACT_ACT_ENVIRONMENT = true

  try {
    const { createRequire } = await import('node:module')
    const requireBundle = createRequire(import.meta.url)
    // 静态测试可能已 require 过产物并捕获了旧的 window.api 桩，强制重新加载
    const resolved = requireBundle.resolve(bundlePath)
    if (requireBundle.cache && requireBundle.cache[resolved]) delete requireBundle.cache[resolved]
    const mod = requireBundle(bundlePath) as { default?: React.ComponentType<Record<string, unknown>> }
    assert.ok(mod?.default, '打包产物应导出 TermPopover 组件')
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const act = (React as unknown as { act: (fn: () => Promise<void>) => Promise<void> }).act

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)

    // 无 glossaryHint → 挂载后自动发起 AI 解释
    await act(async () => {
      root.render(
        React.createElement(mod.default!, {
          term: '依赖注入',
          anchor: { left: 10, top: 10, bottom: 30, right: 10, width: 0, height: 20 },
          question: '为什么这样设计？',
          snippet: '片段',
          projectSummary: '摘要',
          profileId: 'p1',
          onClose: noop
        })
      )
    })

    assert.equal(explained.length, 1, '挂载后应自动发起一次解释请求')
    assert.match(
      explained[0],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'requestId 必须是 UUIDv4（IPC 校验只放行该格式）'
    )
    assert.deepEqual(cancelled, [], '进行中的请求不应被提前取消')

    await act(async () => {
      root.unmount()
    })

    assert.deepEqual(cancelled, [explained[0]], '卸载时必须用同一 requestId 调用 cancelExplain')
    assert.equal(unsubscribed, 1, '卸载时必须退订流式事件')
  } finally {
    g.window = prevWindow
    g.document = prevDocument
    g.IS_REACT_ACT_ENVIRONMENT = prevActEnv
  }
})

async function mountAndRequest(props: Record<string, unknown>): Promise<{ requests: Array<Record<string, unknown>>; html: string }> {
  const bundlePath = await requireBundlePath()
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const requests: Array<Record<string, unknown>> = []
  ;(dom.window as unknown as Record<string, unknown>).api = {
    explain: async (req: Record<string, unknown>) => { requests.push(req) },
    cancelExplain: noop,
    onExplainEvent: () => noop
  }

  const g = globalThis as unknown as Record<string, unknown>
  const prevWindow = g.window
  const prevDocument = g.document
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT
  g.window = dom.window
  g.document = dom.window.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const { createRequire } = await import('node:module')
    const requireBundle = createRequire(import.meta.url)
    const resolved = requireBundle.resolve(bundlePath)
    if (requireBundle.cache?.[resolved]) delete requireBundle.cache[resolved]
    const mod = requireBundle(bundlePath) as { default?: React.ComponentType<Record<string, unknown>> }
    assert.ok(mod.default)
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const act = (React as unknown as { act: (fn: () => Promise<void>) => Promise<void> }).act
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(mod.default!, {
        term: '依赖注入', anchor: { left: 10, top: 10, bottom: 30, right: 10, width: 0, height: 20 },
        question: '为什么这样设计？', snippet: '片段', projectSummary: '摘要', profileId: 'p1',
        onClose: noop, ...props
      }))
    })
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('让 AI 结合本项目详细解释'))
    assert.ok(button, 'manual explain button should be present')
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const html = container.textContent ?? ''
    await act(async () => { root.unmount() })
    return { requests, html }
  } finally {
    g.window = prevWindow
    g.document = prevDocument
    g.IS_REACT_ACT_ENVIRONMENT = prevActEnv
    dom.window.close()
  }
}

test('真实 TermPopover 将长解释上下文压到 IPC 预算并保留术语及 profile 身份', async () => {
  await requireBundlePath()

  // @ts-ignore TS5097 -- extension is required by direct Node test runner.
  const { validateIpcArgs } = await import('../../electron/services/ipc-validation.ts')
  // @ts-ignore TS5097 -- extension is required by direct Node test runner.
  const { IPC } = await import('../../shared/ipc.ts')
  // @ts-ignore TS5097 -- extension is required by direct Node test runner.
  const { EXPLAIN_CONTEXT_LIMITS } = await import('../../shared/result-contract.ts')
  const term = 'T'.repeat(500)
  const profileId = 'profile-preserved'
  const { requests, html } = await mountAndRequest({
    term, profileId, projectSummary: 'S'.repeat(50_000), question: 'Q'.repeat(12_000),
    snippet: 'N'.repeat(25_000), glossaryHint: 'G'.repeat(12_000)
  })
  assert.equal(requests.length, 1)
  assert.doesNotThrow(() => validateIpcArgs(IPC.explainStart, [requests[0]]))
  assert.equal(requests[0].term, term, 'term identity is preserved')
  assert.equal(requests[0].profileId, profileId, 'profile identity is preserved')
  assert.equal((requests[0].projectSummary as string).length, EXPLAIN_CONTEXT_LIMITS.projectSummary)
  assert.equal((requests[0].question as string).length, EXPLAIN_CONTEXT_LIMITS.question)
  assert.equal((requests[0].snippet as string).length, EXPLAIN_CONTEXT_LIMITS.snippet)
  assert.equal((requests[0].glossaryHint as string).length, EXPLAIN_CONTEXT_LIMITS.glossaryHint)
  assert.ok(html.includes('本次解释将使用部分上下文'))
})

test('TermPopover blocks an oversized term locally before explain IPC', async () => {
  await requireBundlePath()
  const { requests, html } = await mountAndRequest({ term: 'T'.repeat(513), glossaryHint: 'defined' })
  assert.deepEqual(requests, [])
  assert.ok(html.includes('术语或模型配置无效，无法发起解释。'))
})

test('真实挂载：长术语和流式解释可在弹卡内滚动，外部滚动仍关闭并取消同一请求', async () => {
  const bundlePath = await requireBundlePath()
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><main id="page"></main></body></html>', { url: 'http://localhost/' })
  const requests: string[] = []
  const cancelled: string[] = []
  let receiveEvent: ((event: { requestId: string; type: string; data: string }) => void) | null = null
  ;(dom.window as unknown as Record<string, unknown>).api = {
    explain: (req: { requestId: string }) => { requests.push(req.requestId); return new Promise<void>(noop) },
    cancelExplain: (requestId: string) => { cancelled.push(requestId) },
    onExplainEvent: (callback: typeof receiveEvent) => { receiveEvent = callback; return () => { receiveEvent = null } }
  }

  const g = globalThis as unknown as Record<string, unknown>
  const prevWindow = g.window
  const prevDocument = g.document
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT
  g.window = dom.window
  g.document = dom.window.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const { createRequire } = await import('node:module')
    const requireBundle = createRequire(import.meta.url)
    const resolved = requireBundle.resolve(bundlePath)
    if (requireBundle.cache?.[resolved]) delete requireBundle.cache[resolved]
    const mod = requireBundle(bundlePath) as { default?: React.ComponentType<Record<string, unknown>> }
    assert.ok(mod.default)
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const act = (React as unknown as { act: (fn: () => Promise<void>) => Promise<void> }).act
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    let closeCount = 0
    await act(async () => {
      root.render(React.createElement(mod.default!, {
        term: '长术语', anchor: { left: 10, top: 10, bottom: 30, right: 10, width: 0, height: 20 },
        question: '问题', snippet: '片段', projectSummary: '摘要', profileId: 'p1',
        glossaryHint: '很长的术语解释。'.repeat(400), onClose: () => { closeCount++; root.unmount() }
      }))
    })
    assert.equal(requests.length, 0, '有 glossary 时保留手动解释入口')
    const content = container.querySelector('.overflow-y-auto') as HTMLDivElement | null
    assert.ok(content, '长术语内容应位于实际 overflow-y-auto 容器')
    assert.ok((content.textContent?.length ?? 0) > 1000, '弹卡应包含长 glossary 内容')
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(content, 'clientHeight', { configurable: true, value: 300 })
    let scrollTop = 0
    Object.defineProperty(content, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        if (scrollTop === value) return
        scrollTop = value
        content.dispatchEvent(new dom.window.Event('scroll'))
      }
    })

    await act(async () => {
      content.dispatchEvent(new dom.window.Event('scroll'))
      content.querySelector('.mb-3')?.dispatchEvent(new dom.window.Event('scroll'))
    })
    assert.equal(closeCount, 0, '弹卡及其嵌套内容的非冒泡 scroll 不关闭弹卡')
    assert.deepEqual(cancelled, [], '内部滚动不取消解释请求')

    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('让 AI 结合本项目详细解释'))
    assert.ok(button)
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(requests.length, 1)
    const requestId = requests[0]
    await act(async () => {
      receiveEvent?.({ requestId, type: 'delta', data: 'streaming answer '.repeat(1500) })
    })
    assert.equal(closeCount, 0, '流式输出引起的自动滚底不会误关闭弹卡')
    assert.deepEqual(cancelled, [], '流式自动滚底不会取消请求')
    assert.ok(scrollTop > 0, '流式内容更新后仍自动滚到底部')

    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event('scroll')) })
    assert.equal(closeCount, 1, '外部 document scroll 仍关闭弹卡')
    assert.deepEqual(cancelled, [requestId], '外部滚动关闭时取消当前同一 requestId')
    dom.window.dispatchEvent(new dom.window.Event('scroll'))
    assert.equal(closeCount, 1, '卸载后 scroll listener 已清理')
  } finally {
    g.window = prevWindow
    g.document = prevDocument
    g.IS_REACT_ACT_ENVIRONMENT = prevActEnv
    dom.window.close()
  }
})

test('真实挂载：Escape 和外部点击关闭弹卡并取消进行中的同一请求', async () => {
  const bundlePath = await requireBundlePath()
  const { createRequire } = await import('node:module')
  const requireBundle = createRequire(import.meta.url)
  const resolved = requireBundle.resolve(bundlePath)
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const act = (React as unknown as { act: (fn: () => Promise<void>) => Promise<void> }).act

  for (const closeBy of ['escape', 'outside'] as const) {
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body><button id="outside">outside</button></body></html>', { url: 'http://localhost/' })
    const requests: string[] = []
    const cancelled: string[] = []
    ;(dom.window as unknown as Record<string, unknown>).api = {
      explain: (req: { requestId: string }) => { requests.push(req.requestId); return new Promise<void>(noop) },
      cancelExplain: (requestId: string) => { cancelled.push(requestId) },
      onExplainEvent: () => () => undefined
    }
    const g = globalThis as unknown as Record<string, unknown>
    const prevWindow = g.window
    const prevDocument = g.document
    const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT
    g.window = dom.window
    g.document = dom.window.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    try {
      if (requireBundle.cache?.[resolved]) delete requireBundle.cache[resolved]
      const mod = requireBundle(bundlePath) as { default?: React.ComponentType<Record<string, unknown>> }
      assert.ok(mod.default)
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      let closeCount = 0
      await act(async () => {
        root.render(React.createElement(mod.default!, {
          term: '术语', anchor: { left: 10, top: 10, bottom: 30, right: 10, width: 0, height: 20 },
          question: '问题', snippet: '片段', projectSummary: '摘要', profileId: 'p1',
          onClose: () => { closeCount++; root.unmount() }
        }))
      })
      assert.equal(requests.length, 1)
      const requestId = requests[0]
      assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      await act(async () => {
        if (closeBy === 'escape') {
          dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
        } else {
          dom.window.document.getElementById('outside')?.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
        }
      })
      assert.equal(closeCount, 1, `${closeBy} closes the popover`)
      assert.deepEqual(cancelled, [requestId], `${closeBy} cancels the matching request once`)
    } finally {
      g.window = prevWindow
      g.document = prevDocument
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv
      dom.window.close()
    }
  }
})
