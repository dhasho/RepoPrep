import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundlePath = path.join(rootDir, '.render-test', 'generating-page.cjs')

await build({
  entryPoints: [path.join(rootDir, 'src/pages/GeneratingPage.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  target: 'node20',
  outfile: bundlePath,
  logLevel: 'silent',
  alias: { '@shared': path.join(rootDir, 'shared'), '@': path.join(rootDir, 'src') },
  external: ['react', 'react-dom', 'react/jsx-runtime']
})

const overview = {
  root: 'C:/project', name: 'RepoPrep', totalFiles: 4, totalBytes: 100,
  languages: [], tree: { name: 'root', path: '.', type: 'dir', children: [] }, keyFiles: [],
  security: { excludedFiles: 2, redactedFiles: 1, redactionMatches: 3, categories: { credential: 3 } }
}
const options = { projectPath: 'C:/project', granularity: 'medium', roleFocus: 'backend', profileId: 'profile' }
const preview = (overrides = {}) => ({ projectSummary: '', sections: [], completedQuestions: 0, targetQuestions: 2, ...overrides })

async function mount(t: test.TestContext, props: Record<string, unknown>) {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
  const g = globalThis as unknown as Record<string, unknown>
  const previous = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, g[key], Object.getOwnPropertyDescriptor(g, key)] as const)
  g.window = dom.window
  g.document = dom.window.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const require = createRequire(import.meta.url)
  delete require.cache[require.resolve(bundlePath)]
  const Page = require(bundlePath).default
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  await React.act(async () => { root.render(React.createElement(Page, props)) })
  t.after(async () => {
    await React.act(async () => { root.unmount() })
    for (const [key, value, descriptor] of previous) {
      if (descriptor) Object.defineProperty(g, key, descriptor)
      else Reflect.deleteProperty(g, key)
    }
    dom.window.close()
  })
  return { React, dom, root, container, Page }
}

test('empty preview shows report header and thinking state without progress cards', async (t) => {
  const { container } = await mount(t, { overview, options, preview: preview(), startedAt: Date.UTC(2026, 0, 2), progress: { step: '内部步骤', detail: '{"secret":"raw"}', percent: 73 }, logs: [{ step: '技术日志', detail: '不要展示', percent: 73 }] })
  assert.ok(container.textContent?.includes('RepoPrep · 面试题'))
  assert.ok(container.textContent?.includes('中粒度'))
  assert.ok(container.textContent?.includes('后端方向'))
  assert.ok(container.textContent?.includes('正在思考'))
  assert.ok(container.textContent?.includes('安全保护：排除 2 / 脱敏 1 文件'))
  assert.ok(!container.textContent?.includes('73%'))
  assert.ok(!container.textContent?.includes('内部步骤'))
  assert.ok(!container.textContent?.includes('技术日志'))
  assert.ok(!container.textContent?.includes('raw'))
  assert.equal([...container.querySelectorAll('button')].some((button) => /导出|重新生成/.test(button.textContent ?? '')), false)
})

test('partial active answer renders before a completed question and report updates stay mounted', async (t) => {
  const { React, container, root, Page } = await mount(t, {
    overview, options,
    preview: preview({ activeQuestion: { key: 'q-1', sectionTitle: '流式章节', title: '标题片段', question: '问题片段', answer: '答案第一段\n\n答案第二段 **仍在生成**', followUps: [] } }),
    startedAt: 1_700_000_000_000, progress: null, logs: [], error: null, onCancel: () => undefined, onBack: () => undefined
  })
  assert.ok(container.textContent?.includes('答案第一段'))
  assert.ok(container.textContent?.includes('答案第二段'))
  assert.ok(container.textContent?.includes('正在生成'))
  assert.equal(container.querySelector('[data-generation-preview]')?.querySelector('button'), null, 'incomplete report exposes no export action')
  const nextPreview = preview({
    projectSummary: '已到达的项目概览。',
    sections: [{ id: 's1', title: '章节一', summary: '章节简介', questions: [{ id: 'q1', title: '问题主题', question: '问题片段？', answer: '答案第一段\n\n答案第二段 **仍在生成**', followUps: [{ question: '追问一？', answer: '追问答案。' }] }] }],
    completedQuestions: 2, targetQuestions: 2
  })
  await React.act(async () => { root.render(React.createElement(Page, { overview, options, preview: nextPreview, startedAt: 1_700_000_000_000, progress: null, logs: [], error: null, onCancel: () => undefined, onBack: () => undefined })) })
  assert.ok(container.textContent?.includes('已到达的项目概览。'))
  assert.ok(container.textContent?.includes('答案第一段'), 'prior generated text remains visible as preview updates')
  assert.ok(container.textContent?.includes('Q01'))
  assert.ok(container.textContent?.includes('追问答案。'))
  assert.ok(container.querySelectorAll('.md-body p').length >= 2, 'Markdown paragraphs render as separate readable paragraphs')
})

test('active answer stays visible while question text is still empty', async (t) => {
  const { container } = await mount(t, {
    overview, options, preview: preview({ activeQuestion: { key: 'q-1', sectionTitle: '章节', question: '', answer: '先到的答案片段', followUps: [] } }),
    startedAt: 1, progress: null, logs: [], error: null, onCancel: () => undefined, onBack: () => undefined
  })
  assert.ok(container.textContent?.includes('先到的答案片段'))
  assert.ok(container.textContent?.includes('Q01'))
})

test('user reading upward is not pulled to the bottom by later preview deltas', async (t) => {
  const { React, dom, container, root, Page } = await mount(t, { overview, options, preview: preview({ projectSummary: '初始正文' }), startedAt: 1, progress: null, logs: [], error: null, onCancel: () => undefined, onBack: () => undefined })
  const scroll = container.querySelector<HTMLElement>('.overflow-y-auto')!
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
  scroll.scrollTop = 100
  await React.act(async () => { scroll.dispatchEvent(new dom.window.Event('scroll')) })
  await React.act(async () => { root.render(React.createElement(Page, { overview, options, preview: preview({ projectSummary: '更新后的正文' }), startedAt: 1, progress: null, logs: [], error: null, onCancel: () => undefined, onBack: () => undefined })) })
  assert.equal(scroll.scrollTop, 100)
})

test('error keeps preview content and does not render raw HTML or progress JSON', async (t) => {
  const { container } = await mount(t, {
    overview, options, preview: preview({ projectSummary: '正文保留。\n\n<img src=x onerror="alert(1)">', sections: [{ id: 's1', title: '完成段', questions: [{ id: 'q1', question: '已验证的问题', answer: '答案保留。', followUps: [] }] }], completedQuestions: 1 }),
    startedAt: 1, progress: { step: 'x', detail: '{"raw":"payload"}', percent: 99 }, logs: [], error: '安全错误提示', onCancel: () => undefined, onBack: () => undefined
  })
  assert.ok(container.textContent?.includes('正文保留。'))
  assert.ok(container.textContent?.includes('已验证的问题'))
  assert.ok(container.textContent?.includes('安全错误提示'))
  assert.ok(container.textContent?.includes('返回调整配置并重试'))
  assert.equal(container.querySelector('img'), null)
  assert.ok(!container.textContent?.includes('payload'))
  assert.ok(!container.textContent?.includes('99%'))
})


