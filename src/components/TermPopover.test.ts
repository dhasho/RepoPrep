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

async function renderPopover(props: Record<string, unknown>): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundlePath = path.join(here, '..', '..', '.render-test', 'term-popover.cjs')
  const fs = await import('node:fs/promises')
  try {
    await fs.access(bundlePath)
  } catch {
    return null
  }

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
    if (!mod?.default) return null
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

test('组件级：有术语表解释时展示术语表并停留在 idle（显示手动触发按钮）', async (t) => {
  const html = await renderPopover({ glossaryHint: '一种解耦方式' })
  if (html === null) {
    t.skip('未生成 .render-test/term-popover.cjs（请用 npm run test:renderer 运行）')
    return
  }
  assert.ok(html.includes('名词'), '应渲染出弹卡「名词」标签')
  assert.ok(html.includes('术语表'), '应展示术语表解释')
  assert.ok(html.includes('让 AI 结合本项目详细解释'), '应显示手动触发按钮')
  assert.ok(!html.includes('已停止生成'), 'idle 状态不应出现已停止提示')
  assert.ok(!html.includes('解释失败'), 'idle 状态不应出现失败提示')
  assert.ok(!html.includes('生成中'), 'idle 状态不应显示生成中')
})

test('组件级：idle 状态不渲染「停止」按钮（只有 streaming 才显示）', async (t) => {
  const html = await renderPopover({ glossaryHint: '一种解耦方式' })
  if (html === null) {
    t.skip('未生成 .render-test/term-popover.cjs（请用 npm run test:renderer 运行）')
    return
  }
  assert.ok(!html.includes('>停止<'), 'idle 时不应出现停止按钮')
  assert.ok(!html.includes('继续解释'), 'idle 时不应出现继续解释按钮')
})

test('组件级：组件接上了控制器（自动请求分支不会抛错，且渲染出流式区域）', async (t) => {
  // 无 glossaryHint 时组件会在 effect 里自动 start；静态渲染不跑 effect，
  // 因此这里只验证渲染本身不抛错、且未进入错误/停止态。
  const html = await renderPopover({})
  if (html === null) {
    t.skip('未生成 .render-test/term-popover.cjs（请用 npm run test:renderer 运行）')
    return
  }
  assert.ok(html.includes('名词'), '应正常渲染')
  assert.ok(!html.includes('解释失败'), '自动请求分支不应直接进入错误态')
  assert.ok(!html.includes('已停止生成'), '不应直接进入已停止态')
})

// 用 jsdom 真实挂载/卸载组件，断言卸载时的 effect 清理确实调用了 cancelExplain
// （验收标准 1：关闭弹窗后对应网络请求立即终止 —— 这条线漏接，单测层发现不了）。
test('组件级（真实挂载）：卸载时取消进行中的解释请求并退订事件', async (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundlePath = path.join(here, '..', '..', '.render-test', 'term-popover.cjs')
  const fs = await import('node:fs/promises')
  try {
    await fs.access(bundlePath)
  } catch {
    t.skip('未生成 .render-test/term-popover.cjs（请用 npm run test:renderer 运行）')
    return
  }

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
