// Render real navigation components to verify the project/history tree and empty state.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { readFile } from 'node:fs/promises'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import type { AnalysisSummary } from '../../shared/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const require = createRequire(path.join(root, 'package.json'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ProjectSidebar = require(path.join(root, '.render-test', 'project-sidebar.cjs')).default
const SelectPage = require(path.join(root, '.render-test', 'select-page.cjs')).default
const projectPath = 'C:\\repo\\api'

const analysis: AnalysisSummary = {
  id: 'a'.repeat(64),
  createdAt: '2026-10-17T08:30:00.000Z',
  granularity: 'fine',
  roleFocus: 'backend'
}

test('项目导航将新建入口放在项目组之前，并在项目下展示带日期和颗粒度的分析', () => {
  const html = renderToStaticMarkup(React.createElement(ProjectSidebar, {
    projects: [{
      path: projectPath, name: 'api', lastUsedAt: '2026-10-17T00:00:00.000Z',
      analyses: [analysis], nextCursor: 'a'.repeat(64), expanded: true, loading: false, error: null
    }],
    loading: false,
    error: null,
    selectedProjectPath: projectPath,
    selectedAnalysisId: analysis.id,
    onNew: () => {},
    onSelectProject: () => {},
    onSelectAnalysis: () => {},
    onToggleProject: () => {},
    onLoadMore: () => {},
    onRemove: () => {}
  }))

  assert.ok(html.indexOf('新建') < html.indexOf('所有项目'))
  assert.ok(html.includes(`data-project-path="${projectPath}"`))
  assert.match(html, new RegExp(`data-analysis-id="${analysis.id}"`))
  assert.ok(html.includes('2026/10/17') || html.includes('2026年10月17日'))
  assert.match(html, /title="[^"]* \d{2}:\d{2}:\d{2} · 细粒度 · 后端方向"/)
  assert.ok(html.includes('细粒度'))
  assert.ok(html.includes('加载更多'))
  assert.match(html, /aria-expanded="true"/)
})

test('无选中项目时主面板只显示指定的居中提示', () => {
  const html = renderToStaticMarkup(React.createElement(SelectPage))
  assert.match(html, /选择一个项目，我们开始分析/)
  assert.doesNotMatch(html, /AI 面试官|生成「问题|RepoPrep/)
  assert.match(html, /items-center justify-center/)
})

test('左右侧栏切换动画尊重减少动态效果设置', async () => {
  const css = await readFile(path.join(root, 'src', 'styles', 'globals.css'), 'utf8')
  assert.match(css, /\.sidebar-enter\s*\{[^}]*animation:/s)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
})

test('项目分析历史按页追加，收起项目后迟到的分页响应会被忽略', async () => {
  const { JSDOM } = require('jsdom') as { JSDOM: new (...args: unknown[]) => any }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const globalRecord = globalThis as unknown as Record<string, unknown>
  const previousActEnvironment = globalRecord.IS_REACT_ACT_ENVIRONMENT
  const pageRequests: Array<{
    cursor?: string
    resolve: (page: { items: AnalysisSummary[]; nextCursor: string | null }) => void
    reject: (error: Error) => void
  }> = []
  const recentRequests: Array<{ resolve: (projects: Array<{ path: string; name: string; lastUsedAt: string }>) => void }> = []
  let diagnostics: Array<{ id: string }> = []
  const diagnosticSnapshots: Array<Array<{ id: string }>> = []
  const api = {
    getRecentProjects: async () => new Promise<Array<{ path: string; name: string; lastUsedAt: string }>>((resolve) => recentRequests.push({ resolve })),
    listAnalyses: async (_path: string, cursor?: string) => new Promise<{ items: AnalysisSummary[]; nextCursor: string | null }>((resolve, reject) => pageRequests.push({ cursor, resolve, reject })),
    removeRecent: async () => undefined,
    getStorageDiagnostics: async () => diagnostics
  }
  const onStorageRead = () => { void api.getStorageDiagnostics().then((items) => diagnosticSnapshots.push(items)) }
  ;(dom.window as unknown as { api: typeof api }).api = api
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.window.document })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
  const { createRoot } = require('react-dom/client') as { createRoot: (container: Element) => { render: (element: unknown) => void; unmount: () => void } }
  const { useProjectLibrary } = require(path.join(root, '.render-test', 'project-library.cjs')) as { useProjectLibrary: (onStorageRead?: () => void) => unknown }
  const current = { value: null as any }
  function Harness() {
    current.value = useProjectLibrary(onStorageRead)
    return null
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const tree = createRoot(container)
  const act = React.act as (callback: () => void | Promise<void>) => Promise<void>

  try {
    await act(async () => { tree.render(React.createElement(Harness)); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    assert.equal(recentRequests.length, 1)
    await act(async () => {
      const refresh = current.value.refresh()
      diagnostics = [{ id: 'recent-list-recovery' }]
      recentRequests[1].resolve([{ path: projectPath, name: 'fresh', lastUsedAt: '2026-10-17T00:00:00.000Z' }])
      await refresh
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(diagnosticSnapshots.at(-1)?.some((item) => item.id === 'recent-list-recovery'), 'a recent-list read refreshes the actual diagnostics')
    recentRequests[0].resolve([{ path: projectPath, name: 'stale', lastUsedAt: '2026-10-16T00:00:00.000Z' }])
    await act(async () => { await Promise.resolve() })
    assert.equal(current.value.projects[0].name, 'fresh', 'an older recent-project response cannot overwrite a newer refresh')
    assert.equal(current.value.projects[0].path, projectPath)
    assert.equal(pageRequests.length, 0, 'history is not loaded until the project is expanded')

    await act(async () => { current.value.toggleExpanded(projectPath); await Promise.resolve() })
    assert.equal(pageRequests.length, 1)
    assert.equal(pageRequests[0].cursor, undefined)
    await act(async () => { pageRequests[0].resolve({ items: [analysis], nextCursor: 'cursor-1' }); await Promise.resolve() })
    assert.equal(current.value.projects[0].analyses.length, 1)

    const second = { ...analysis, id: 'b'.repeat(64), createdAt: '2026-10-16T08:30:00.000Z' }
    await act(async () => { current.value.loadMore(projectPath, 'cursor-1'); await Promise.resolve() })
    assert.equal(pageRequests[1].cursor, 'cursor-1')
    await act(async () => { pageRequests[1].resolve({ items: [second], nextCursor: 'cursor-2' }); await Promise.resolve() })
    assert.deepEqual(current.value.projects[0].analyses.map((item: AnalysisSummary) => item.id), [analysis.id, second.id])

    await act(async () => { current.value.loadMore(projectPath, 'cursor-2'); await Promise.resolve() })
    await act(async () => { current.value.toggleExpanded(projectPath) })
    const stale = { ...analysis, id: 'c'.repeat(64) }
    await act(async () => { pageRequests[2].resolve({ items: [stale], nextCursor: null }); await Promise.resolve() })
    assert.deepEqual(current.value.projects[0].analyses.map((item: AnalysisSummary) => item.id), [analysis.id, second.id])

    await act(async () => { current.value.refreshAnalyses(projectPath) })
    assert.equal(current.value.projects[0].analyses.length, 0, 'refresh invalidates a collapsed project history cache')
    await act(async () => { current.value.toggleExpanded(projectPath); await Promise.resolve() })
    assert.equal(pageRequests.length, 4, 'reopening the project loads a fresh first page')
    const refreshed = { ...analysis, id: 'd'.repeat(64) }
    await act(async () => { pageRequests[3].resolve({ items: [refreshed], nextCursor: null }); await Promise.resolve() })
    assert.deepEqual(current.value.projects[0].analyses.map((item: AnalysisSummary) => item.id), [refreshed.id])

    diagnostics = [{ id: 'corrupt-result-backup' }]
    await act(async () => { current.value.loadMore(projectPath, 'cursor-error'); await Promise.resolve() })
    await act(async () => { pageRequests[4].reject(new Error('corrupt archive')); await Promise.resolve() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(diagnosticSnapshots.at(-1)?.some((item) => item.id === 'corrupt-result-backup'), 'an analysis-list failure refreshes diagnostics so backup recovery appears')

    await act(async () => { current.value.refresh(); await Promise.resolve() })
    assert.equal(current.value.loading, true)
    await act(async () => { await current.value.remove(projectPath) })
    assert.equal(current.value.loading, false, 'removing a recent project clears the loading state after invalidating an in-flight list request')
    recentRequests[2].resolve([{ path: projectPath, name: 'stale-after-remove', lastUsedAt: '2026-10-17T00:00:00.000Z' }])
    await act(async () => { await Promise.resolve() })
    assert.equal(current.value.projects.length, 0)
  } finally {
    await act(async () => { tree.unmount() })
    dom.window.close()
    if (previousWindow === undefined) delete (globalThis as { window?: Window }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
    if (previousDocument === undefined) delete (globalThis as { document?: Document }).document
    else Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: previousDocument })
    if (previousActEnvironment === undefined) delete globalRecord.IS_REACT_ACT_ENVIRONMENT
    else Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: previousActEnvironment })
  }
})
