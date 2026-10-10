// End-to-end renderer lifecycle checks against the real App with delayed IPC mocks.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const require = createRequire(path.join(projectRoot, 'package.json'))
const bundlePath = path.join(projectRoot, '.render-test', 'app.cjs')
const sessionBundlePath = path.join(projectRoot, '.render-test', 'generation-session.cjs')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeOverview(projectPath) {
  const name = projectPath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project'
  return {
    root: projectPath,
    name,
    totalFiles: 1,
    totalBytes: 12,
    languages: [],
    tree: { name, path: '.', type: 'dir', children: [{ name: 'README.md', path: 'README.md', type: 'file', size: 12 }] },
    keyFiles: [],
    security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} }
  }
}

function makeResult(projectPath) {
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project'
  return {
    version: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    projectName,
    projectPath,
    granularity: 'medium',
    roleFocus: 'general',
    profileId: 'profile-1',
    modelUsed: 'mock-model',
    projectSummary: 'summary',
    sections: [{ id: 's1', title: 'Basics', questions: [{ id: 'q1', question: 'Question?', answer: 'Answer.', followUps: [] }] }],
    glossary: {}
  }
}

function makeApi() {
  let selectedPath = 'C:\\ProjectA'
  const requests = []
  const cancellations = []
  const listeners = new Set()
  const delayedLoads = new Map()
  const savedResults = new Map()
  let subscribeCount = 0
  let unsubscribeCount = 0
  const api = {
    selectFolder: async () => selectedPath,
    scanProject: async (projectPath) => makeOverview(projectPath),
    getRecentProjects: async () => [],
    removeRecent: async () => {},
    loadResult: async (projectPath) => {
      const control = delayedLoads.get(projectPath)
      if (control) await control.promise
      return savedResults.get(projectPath) ?? null
    },
    deleteResult: async () => {},
    getSettings: async () => ({
      profiles: [{ id: 'profile-1', name: 'Mock', baseUrl: 'https://example.test/v1', apiKey: '', model: 'mock-model' }],
      defaultProfileId: 'profile-1'
    }),
    saveSettings: async () => {},
    testLlm: async () => ({ ok: true, message: 'ok' }),
    listModels: async () => ({ ok: true, models: [], message: 'ok' }),
    exportMarkdown: async () => ({ ok: true, message: 'ok' }),
    generate: (request) => {
      const control = deferred()
      requests.push({ request, ...control })
      return control.promise
    },
    cancelGenerate: async (runId) => { cancellations.push(runId) },
    onGenerateProgress: (callback) => {
      subscribeCount++
      listeners.add(callback)
      return () => { listeners.delete(callback); unsubscribeCount++ }
    }
  }
  return {
    api,
    requests,
    cancellations,
    setSelectedPath: (next) => { selectedPath = next },
    delayLoad: (projectPath, control) => { delayedLoads.set(projectPath, control) },
    setSavedResult: (projectPath, result) => { savedResults.set(projectPath, result) },
    emitProgress: (progress) => { for (const listener of listeners) listener(progress) },
    get listenerCount() { return listeners.size },
    get subscribeCount() { return subscribeCount },
    get unsubscribeCount() { return unsubscribeCount }
  }
}

function installDom(dom) {
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true
  }
  const previous = new Map()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

async function mountApp() {
  const fs = await import('node:fs/promises')
  try { await fs.access(bundlePath) } catch {
    throw new Error(`Required App renderer bundle is missing: ${bundlePath}. Run scripts/build-render-test.mjs before this test.`)
  }
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' })
  const restore = installDom(dom)
  const mock = makeApi()
  dom.window.api = mock.api
  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const bundleRequire = createRequire(bundlePath)
  delete bundleRequire.cache[bundleRequire.resolve(bundlePath)]
  const App = bundleRequire(bundlePath).default
  const host = dom.window.document.getElementById('root')
  const root = createRoot(host)
  await React.act(async () => {
    root.render(React.createElement(App))
    await new Promise((resolve) => setImmediate(resolve))
  })
  return { dom, restore, mock, React, root, host }
}

async function unmount(harness) {
  await harness.React.act(async () => harness.root.unmount())
  harness.dom.window.close()
  harness.restore()
}

async function act(harness, action) {
  await harness.React.act(async () => {
    action()
    await new Promise((resolve) => setImmediate(resolve))
  })
}

function button(host, text) {
  return [...host.querySelectorAll('button')].find((item) => (item.textContent || '').trim().includes(text))
}

async function openProject(harness, projectPath) {
  harness.mock.setSelectedPath(projectPath)
  await act(harness, () => button(harness.host, '选择项目文件夹').click())
  assert.ok(harness.host.textContent.includes(projectPath.split(/[\\/]/).filter(Boolean).at(-1)), '应进入目标项目配置页')
}

async function startGeneration(harness) {
  const start = [...harness.host.querySelectorAll('button')].find((item) => (item.textContent || '').includes('开始生成面试题'))
  assert.ok(start, '配置页应显示生成按钮')
  await act(harness, () => start.click())
  await act(harness, () => {})
  assert.equal(harness.mock.requests.length > 0, true, 'API generate 应被调用')
  return harness.mock.requests.at(-1)
}

async function leaveGenerationToSelect(harness) {
  await act(harness, () => button(harness.host, '切换项目').click())
  assert.ok(harness.host.textContent.includes('仍在生成'), '离页时应要求选择生成任务处理方式')
  await act(harness, () => button(harness.host, '后台继续').click())
  assert.ok(harness.host.textContent.includes('选择项目文件夹'), '后台继续后应进入项目选择页')
}

test('App foreground generation resolves to its result', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const request = await startGeneration(h)
    assert.match(request.request.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    h.mock.emitProgress({ runId: request.request.runId, step: 'Mock progress', percent: 42, ts: Date.now() })
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('Mock progress'))
    await act(h, () => request.resolve({ runId: request.request.runId, result: makeResult(request.request.projectPath) }))
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), '当前任务完成后应显示该项目结果')
  } finally { await unmount(h) }
})

test('App rejects a response whose runId does not match the active request', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const request = await startGeneration(h)
    await act(h, () => request.resolve({ runId: '00000000-0000-4000-8000-000000000099', result: makeResult('C:\\ProjectB') }))
    assert.ok(h.host.textContent.includes('生成失败'))
    assert.ok(h.host.textContent.includes('生成响应与当前任务不匹配'))
    assert.ok(!h.host.textContent.includes('ProjectB · 面试题'), 'mismatched result must not replace the visible result')
  } finally { await unmount(h) }
})

test('background task does not navigate on completion and its result remains reachable after settings/project B', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await act(h, () => button(h.host, '设置').click())
    assert.ok(h.host.textContent.includes('大模型配置'))
    await act(h, () => requestA.resolve({ runId: requestA.request.runId, result: makeResult(requestA.request.projectPath) }))
    assert.ok(h.host.textContent.includes('大模型配置'), '后台完成不能覆盖设置页或自动导航')
    await act(h, () => button(h.host, '返回').click())
    assert.ok(h.host.textContent.includes('选择项目文件夹'), '从设置返回项目选择页')
    await openProject(h, 'C:\\ProjectB')
    assert.ok(h.host.textContent.includes('ProjectB'), '当前配置仍是项目 B')
    await act(h, () => button(h.host, '后台生成').click())
    assert.ok(h.host.textContent.includes('ProjectA'))
    await act(h, () => button(h.host, '查看结果').click())
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), '后台完成结果应可主动打开')
  } finally { await unmount(h) }
})

test('background task recovery shows the frozen project A snapshot while project B is active', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await openProject(h, 'C:\\ProjectB')
    assert.ok(h.host.textContent.includes('ProjectB'))
    await act(h, () => button(h.host, '后台生成').click())
    await act(h, () => button(h.host, '恢复任务').click())
    assert.ok(h.host.textContent.includes('正在为「ProjectA」生成面试题'))
    assert.ok(!h.host.textContent.includes('正在为「ProjectB」生成面试题'))
    await act(h, () => requestA.reject(new Error('已取消')))
    assert.ok(h.host.textContent.includes('ProjectA'), '任务恢复后仍以 A 的冻结快照返回其配置')
  } finally { await unmount(h) }
})

test('restoring A while project B loadResult is pending invalidates B navigation', async () => {
  const h = await mountApp()
  const delayedB = deferred()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    h.mock.delayLoad('C:\\ProjectB', delayedB)
    await act(h, () => {
      h.mock.setSelectedPath('C:\\ProjectB')
      button(h.host, '选择项目文件夹').click()
    })
    assert.ok(h.host.textContent.includes('选择项目文件夹'), 'B scan should still be waiting on loadResult')
    await act(h, () => button(h.host, '后台生成').click())
    await act(h, () => button(h.host, '恢复任务').click())
    assert.ok(h.host.textContent.includes('正在为「ProjectA」生成面试题'))
    delayedB.resolve()
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('正在为「ProjectA」生成面试题'), 'stale B load must not replace restored task A')
    await act(h, () => requestA.reject(new Error('已取消')))
  } finally { await unmount(h) }
})

test('cancelling restored A returns to A with A history, ignores late progress, and shows cancelling state', async () => {
  const h = await mountApp()
  const resultA = makeResult('C:\\ProjectA')
  h.mock.setSavedResult('C:\\ProjectA', resultA)
  h.mock.setSavedResult('C:\\ProjectB', makeResult('C:\\ProjectB'))
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await openProject(h, 'C:\\ProjectB')
    assert.ok(button(h.host, '查看上次生成结果'), 'B should have its own saved history')
    await act(h, () => button(h.host, '后台生成').click())
    await act(h, () => button(h.host, '恢复任务').click())
    assert.ok(h.host.textContent.includes('正在为「ProjectA」生成面试题'))

    const cancelButton = button(h.host, '取消生成')
    await act(h, () => cancelButton.click())
    assert.deepEqual(h.mock.cancellations, [requestA.request.runId], 'foreground cancel must target A runId')
    assert.equal(cancelButton.disabled, true)
    assert.equal(cancelButton.textContent.trim(), '正在取消…')
    h.mock.emitProgress({ runId: requestA.request.runId, step: 'late after cancel', percent: 95, ts: Date.now() })
    await act(h, () => {})
    assert.ok(!h.host.textContent.includes('late after cancel'), 'cancelling task must ignore late progress')

    await act(h, () => requestA.reject(new Error('已取消生成')))
    assert.ok(h.host.textContent.includes('ProjectA'), 'cancellation should return to A configuration')
    const historyButton = button(h.host, '查看上次生成结果')
    assert.ok(historyButton, 'A saved history must be restored')
    await act(h, () => historyButton.click())
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'))
    assert.ok(!h.host.textContent.includes('ProjectB · 面试题'), 'B history must not be attached to A')
  } finally { await unmount(h) }
})

test('leaving B to view completed A prompts choices; background B stays reachable after it completes', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await act(h, () => requestA.resolve({ runId: requestA.request.runId, result: makeResult(requestA.request.projectPath) }))
    await openProject(h, 'C:\\ProjectB')
    const requestB = await startGeneration(h)

    await act(h, () => button(h.host, '后台生成').click())
    await act(h, () => button(h.host, '查看结果').click())
    assert.ok(h.host.textContent.includes('仍在生成'), 'opening A must first ask what to do with foreground B')
    assert.ok(button(h.host, '后台继续'))
    assert.ok(button(h.host, '取消生成并离开'))
    assert.ok(button(h.host, '留在生成页'))
    await act(h, () => button(h.host, '后台继续').click())
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'))

    await act(h, () => requestB.resolve({ runId: requestB.request.runId, result: makeResult(requestB.request.projectPath) }))
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), 'background B completion must not steal navigation')
    assert.ok(button(h.host, '后台生成（2）'), 'both detached task results should remain reachable')
    await act(h, () => button(h.host, '后台生成').click())
    assert.ok(h.host.textContent.includes('ProjectB'))
    assert.ok(h.host.textContent.includes('已完成，可查看结果'))
    await act(h, () => button(h.host, '查看结果').click())
    assert.ok(h.host.textContent.includes('ProjectB · 面试题'))
  } finally { await unmount(h) }
})

test('choosing stay while opening A keeps foreground B running in the task panel', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await act(h, () => requestA.resolve({ runId: requestA.request.runId, result: makeResult(requestA.request.projectPath) }))
    await openProject(h, 'C:\\ProjectB')
    const requestB = await startGeneration(h)
    await act(h, () => button(h.host, '后台生成').click())
    await act(h, () => button(h.host, '查看结果').click())
    await act(h, () => button(h.host, '留在生成页').click())
    assert.ok(h.host.textContent.includes('正在为「ProjectB」生成面试题'))
    assert.deepEqual(h.mock.cancellations, [])
    await act(h, () => button(h.host, '关闭').click())
    assert.ok(h.host.textContent.includes('正在为「ProjectB」生成面试题'))
    await act(h, () => requestB.resolve({ runId: requestB.request.runId, result: makeResult(requestB.request.projectPath) }))
    assert.ok(h.host.textContent.includes('ProjectB · 面试题'))
  } finally { await unmount(h) }
})

test('choosing cancel-and-leave to A cancels exact foreground B and keeps A visible after B settles', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await act(h, () => requestA.resolve({ runId: requestA.request.runId, result: makeResult(requestA.request.projectPath) }))
    await openProject(h, 'C:\\ProjectB')
    const requestB = await startGeneration(h)
    await act(h, () => button(h.host, '后台生成').click())
    await act(h, () => button(h.host, '查看结果').click())
    await act(h, () => button(h.host, '取消生成并离开').click())
    assert.deepEqual(h.mock.cancellations, [requestB.request.runId], 'task-target cancellation must use B runId')
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'))
    await act(h, () => requestB.reject(new Error('已取消生成')))
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), 'B cancellation must not steal navigation from A')
  } finally { await unmount(h) }
})

test('cancel-and-leave does not navigate when A cancellation settles after project B opens', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await act(h, () => button(h.host, '切换项目').click())
    await act(h, () => button(h.host, '取消生成并离开').click())
    assert.deepEqual(h.mock.cancellations, [requestA.request.runId], 'cancel must carry A runId')
    await openProject(h, 'C:\\ProjectB')
    await act(h, () => requestA.reject(new Error('已取消生成')))
    assert.ok(h.host.textContent.includes('ProjectB'), 'late foreground cancellation must not navigate away from B')
    assert.ok(!h.host.textContent.includes('正在为「ProjectA」生成面试题'))
  } finally { await unmount(h) }
})

test('old run progress is ignored while a newer project run is foreground', async () => {
  const h = await mountApp()
  try {
    await openProject(h, 'C:\\ProjectA')
    const requestA = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await openProject(h, 'C:\\ProjectB')
    await act(h, () => requestA.resolve({ runId: requestA.request.runId, result: makeResult(requestA.request.projectPath) }))
    assert.ok(h.host.textContent.includes('ProjectB'))
    const requestB = await startGeneration(h)
    h.mock.emitProgress({ runId: requestA.request.runId, step: 'OLD A PROGRESS', percent: 90, ts: Date.now() })
    h.mock.emitProgress({ runId: requestB.request.runId, step: 'B PROGRESS', percent: 33, ts: Date.now() })
    await act(h, () => {})
    assert.ok(!h.host.textContent.includes('OLD A PROGRESS'))
    assert.ok(h.host.textContent.includes('B PROGRESS'))
    await act(h, () => requestB.resolve({ runId: requestB.request.runId, result: makeResult(requestB.request.projectPath) }))
    assert.ok(h.host.textContent.includes('ProjectB · 面试题'))
  } finally { await unmount(h) }
})

test('start immediately invokes IPC; dispose cancels it and stale settlement/cancel cannot affect a newer run', async () => {
  const fs = await import('node:fs/promises')
  try { await fs.access(sessionBundlePath) } catch {
    throw new Error(`Required generation session bundle is missing: ${sessionBundlePath}. Run scripts/build-render-test.mjs before this test.`)
  }
  const sessionRequire = createRequire(sessionBundlePath)
  const { GenerationSession } = sessionRequire(sessionBundlePath)
  const pending = []
  const cancelled = []
  const session = new GenerationSession({
    generate: (request) => { const item = { request, ...deferred() }; pending.push(item); return item.promise },
    cancelGenerate: (runId) => { cancelled.push(runId) }
  }, (() => { const ids = ['run-a', 'run-b']; return () => ids.shift() })())
  const opts = { projectPath: 'C:\\ProjectA', granularity: 'medium', roleFocus: 'general', profileId: 'p1' }
  const overviewA = makeOverview(opts.projectPath)
  const runA = session.start(opts, overviewA)
  assert.equal(Object.isFrozen(session.getTask(runA).overview.tree.children[0]), true)
  assert.equal(pending.length, 1, 'generate must be invoked synchronously before start returns')
  assert.equal(session.start({ ...opts, projectPath: 'C:\\ProjectB' }, makeOverview('C:\\ProjectB')), null, 'a second run cannot replace an unsettled run')
  assert.equal(pending.length, 1)
  session.dispose()
  assert.deepEqual(cancelled, [runA], 'immediate dispose must cancel the already-sent run id')
  assert.equal(session.getSnapshot().activeRunId, null, 'dispose must release the old active slot')
  session.activate()
  const runB = session.start({ ...opts, projectPath: 'C:\\ProjectB' }, makeOverview('C:\\ProjectB'))
  await new Promise((resolve) => setImmediate(resolve))
  session.receiveProgress({ runId: runA, step: 'late progress', percent: 99, ts: Date.now() })
  assert.equal(session.cancel(runA), false)
  assert.equal(session.getSnapshot().activeRunId, runB)
  assert.equal(session.getTask(runB).overview.name, 'ProjectB')
  assert.equal(session.getTask(runB).logs.some((entry) => entry.step === 'late progress'), false)
  assert.deepEqual(cancelled, [runA], 'stale cancel must not reach or cancel B')
  pending[0].resolve({ runId: runA, result: makeResult(opts.projectPath) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.getSnapshot().activeRunId, runB, 'old delayed result must not release the new task')
  assert.equal(session.getTask(runB).status, 'running')
  pending[1].reject(new Error('B failure'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.getTask(runB).status, 'failed')
  assert.equal(session.getTask(runB).error, 'B failure')

  const lateRejectors = []
  const session2 = new GenerationSession({
    generate: (request) => { const item = { request, ...deferred() }; lateRejectors.push(item); return item.promise },
    cancelGenerate: () => undefined
  }, (() => { const ids = ['run-old', 'run-current']; return () => ids.shift() })())
  const oldRun = session2.start(opts, overviewA)
  session2.dispose()
  session2.activate()
  const currentRun = session2.start({ ...opts, projectPath: 'C:\\ProjectB' }, makeOverview('C:\\ProjectB'))
  await new Promise((resolve) => setImmediate(resolve))
  lateRejectors[0].reject(new Error('late old rejection'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session2.getSnapshot().activeRunId, currentRun)
  assert.equal(session2.getTask(currentRun).status, 'running')
  assert.equal(session2.getTask(currentRun).error, null)
  assert.ok(oldRun)
})

test('unmount cancels the active run by id and removes the progress listener', async () => {
  const h = await mountApp()
  let request
  try {
    assert.equal(h.mock.listenerCount, 1)
    await openProject(h, 'C:\\ProjectA')
    request = await startGeneration(h)
  } finally {
    await unmount(h)
  }
  assert.deepEqual(h.mock.cancellations, [request.request.runId])
  assert.equal(h.mock.listenerCount, 0)
  assert.equal(h.mock.unsubscribeCount, 1)
})
