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
    storagePath: projectPath,
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

function makeApi({
  selectedPath: initialSelectedPath = 'C:\\ProjectA',
  recent: initialRecent = [],
  savedResults: initialSavedResults = new Map(),
  loadFailures: initialLoadFailures = new Map(),
  scanOverview,
  profiles = [{ id: 'profile-1', name: 'Mock', baseUrl: 'https://example.test/v1', apiKey: '', model: 'mock-model' }],
  defaultProfileId = profiles[0]?.id ?? null
} = {}) {
  let selectedPath = initialSelectedPath
  let recent = [...initialRecent]
  const requests = []
  const cancellations = []
  const scans = []
  const loads = []
  const removals = []
  const deletions = []
  const listeners = new Set()
  const delayedScans = new Map()
  const delayedLoads = new Map()
  const scanFailures = new Map()
  const loadFailures = new Map()
  const removeFailures = new Map()
  const cleanupControls = new Set()
  const savedResults = initialSavedResults instanceof Map
    ? new Map(initialSavedResults)
    : new Map(Object.entries(initialSavedResults))
  let subscribeCount = 0
  let unsubscribeCount = 0
  let selectCalls = 0
  const queue = (map, projectPath, value) => {
    const values = map.get(projectPath) ?? []
    values.push(value)
    map.set(projectPath, values)
  }
  const take = (map, projectPath) => {
    const values = map.get(projectPath)
    if (!values?.length) return undefined
    const value = values.shift()
    if (!values.length) map.delete(projectPath)
    return value
  }
  if (initialLoadFailures instanceof Map) {
    for (const [projectPath, error] of initialLoadFailures) queue(loadFailures, projectPath, error)
  } else {
    for (const [projectPath, error] of Object.entries(initialLoadFailures)) queue(loadFailures, projectPath, error)
  }
  const api = {
    selectFolder: async () => { selectCalls++; return selectedPath },
    scanProject: async (projectPath) => {
      scans.push(projectPath)
      const failure = take(scanFailures, projectPath)
      if (failure) throw failure
      const control = take(delayedScans, projectPath)
      if (control) await control.promise
      const overview = scanOverview ? scanOverview(projectPath, scans.length - 1) : makeOverview(projectPath)
      const storagePath = overview.storagePath ?? projectPath
      recent = [
        { path: storagePath, name: projectPath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project', lastUsedAt: '2026-10-10T00:00:00.000Z' },
        ...recent.filter((project) => project.path !== storagePath)
      ].slice(0, 20)
      return overview
    },
    getRecentProjects: async () => [...recent],
    removeRecent: async (projectPath) => {
      removals.push(projectPath)
      const failure = take(removeFailures, projectPath)
      if (failure) throw failure
      recent = recent.filter((project) => project.path !== projectPath)
    },
    loadResult: async (projectPath) => {
      loads.push(projectPath)
      const failure = take(loadFailures, projectPath)
      if (failure) throw failure
      const control = delayedLoads.get(projectPath)
      if (control?.length) {
        const next = control.shift()
        if (!control.length) delayedLoads.delete(projectPath)
        await next.promise
      }
      return savedResults.get(projectPath) ?? null
    },
    deleteResult: async (projectPath) => { deletions.push(projectPath) },
    getSettings: async () => ({
      profiles,
      defaultProfileId
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
    scans,
    loads,
    removals,
    deletions,
    delayScan: (projectPath, control = deferred()) => {
      queue(delayedScans, projectPath, control)
      cleanupControls.add(control)
      return control
    },
    setSelectedPath: (next) => { selectedPath = next },
    delayLoad: (projectPath, control = deferred()) => {
      queue(delayedLoads, projectPath, control)
      cleanupControls.add(control)
      return control
    },
    failNextScan: (projectPath, error = new Error('scan failed')) => queue(scanFailures, projectPath, error),
    failNextLoad: (projectPath, error = new Error('load failed')) => queue(loadFailures, projectPath, error),
    failNextRemove: (projectPath, error = new Error('remove failed')) => queue(removeFailures, projectPath, error),
    setRecent: (entries) => { recent = [...entries] },
    setSavedResult: (projectPath, result) => { savedResults.set(projectPath, result) },
    cleanupPending: () => {
      for (const control of cleanupControls) control.resolve()
      for (const pending of requests) {
        pending.resolve({ runId: pending.request.runId, result: makeResult(pending.request.projectPath) })
      }
    },
    get selectCalls() { return selectCalls },
    get recentPaths() { return recent.map((project) => project.path) },
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

async function mountApp(apiOptions = {}) {
  const fs = await import('node:fs/promises')
  try { await fs.access(bundlePath) } catch {
    throw new Error(`Required App renderer bundle is missing: ${bundlePath}. Run scripts/build-render-test.mjs before this test.`)
  }
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' })
  const restore = installDom(dom)
  const mock = makeApi(apiOptions)
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

function recentRow(host, projectPath) {
  const pathLabel = [...host.querySelectorAll('[title]')].find((item) => item.getAttribute('title') === projectPath)
  return pathLabel?.parentElement?.parentElement ?? null
}

function recentButton(host, projectPath, text) {
  return [...(recentRow(host, projectPath)?.querySelectorAll('button') ?? [])]
    .find((item) => (item.textContent || '').trim().includes(text) || item.getAttribute('title') === text)
}

async function viewRecentResult(harness, projectPath) {
  const action = recentButton(harness.host, projectPath, '查看结果')
  assert.ok(action, `recent history result for ${projectPath} should be available`)
  await act(harness, () => action.click())
}

async function beginHistoryRecovery(harness, projectPath) {
  await viewRecentResult(harness, projectPath)
  await startRecoveryFromVisibleResult(harness)
}

async function startRecoveryFromVisibleResult(harness) {
  const regenerate = button(harness.host, '重新生成')
  assert.ok(regenerate, 'history result should offer regeneration')
  await act(harness, () => regenerate.click())
}

async function openRecentProject(harness, projectPath) {
  const action = recentButton(harness.host, projectPath, '重新分析')
  assert.ok(action, `recent project ${projectPath} should be available to open`)
  await act(harness, () => action.click())
}

async function cleanupAndUnmount(harness) {
  await act(harness, () => harness.mock.cleanupPending())
  await unmount(harness)
}

function assertRecoveryActions(host) {
  for (const label of ['原项目无法读取', '重试扫描', '重新定位项目', '从最近项目移除', '保留历史结果']) {
    assert.ok(host.textContent.includes(label), `history recovery should offer “${label}”`)
  }
}

async function openProject(harness, projectPath) {
  harness.mock.setSelectedPath(projectPath)
  await act(harness, () => button(harness.host, '选择项目文件夹').click())
  assert.ok(harness.host.textContent.includes(projectPath.split(/[\\/]/).filter(Boolean).at(-1)), '应进入目标项目配置页')
}

test('invalid stored history lets recent reanalysis and folder selection regenerate the project', async () => {
  const projectPath = 'C:\\InvalidHistory'
  for (const entry of ['recent', 'folder']) {
    const h = await mountApp({
      recent: [{ path: projectPath, name: 'InvalidHistory', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
      loadFailures: new Map([[projectPath, new Error(`Error invoking remote method 'result:load': Error: 历史结果格式无效或超出支持范围，请重新生成。`)]])
    })
    try {
      h.mock.failNextLoad(projectPath, new Error(`Error invoking remote method 'result:load': Error: 历史结果格式无效或超出支持范围，请重新生成。`))
      if (entry === 'recent') await openRecentProject(h, projectPath)
      else await openProject(h, projectPath)
      assert.ok(h.host.textContent.includes('历史结果格式无效或超出支持范围，请重新生成。'), `${entry} recovery shows a safe notice`)
      assert.ok(!button(h.host, '查看上次生成结果'), 'invalid history is not offered for viewing')
      const request = await startGeneration(h)
      await act(h, () => request.resolve({ runId: request.request.runId, result: makeResult(projectPath) }))
      assert.ok(h.host.textContent.includes('InvalidHistory · 面试题'), `${entry} recovery can finish regeneration`)
      assert.deepEqual(h.mock.deletions, [], 'recovery preserves the invalid history file')
    } finally { await cleanupAndUnmount(h) }
  }
})

test('unknown history load failures still block entering project configuration', async () => {
  const projectPath = 'C:\\ProjectA'
  const h = await mountApp({
    recent: [{ path: projectPath, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    loadFailures: new Map([[projectPath, new Error('storage unavailable')]])
  })
  try {
    h.mock.failNextLoad(projectPath, new Error('storage unavailable'))
    await openRecentProject(h, projectPath)
    assert.ok(h.host.textContent.includes('选择项目文件夹'), 'unexpected storage failure leaves the app on project selection')
    assert.ok(h.host.textContent.includes('打开项目失败：storage unavailable'))
    assert.ok(!button(h.host, '开始生成面试题'), 'unexpected storage failure must not enter project configuration')
  } finally { await cleanupAndUnmount(h) }
})

test('late invalid-history load failure cannot replace the newer project configuration', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const h = await mountApp({
    recent: [pathA, pathB].map((projectPath) => ({
      path: projectPath, name: projectPath.split('\\').at(-1), lastUsedAt: '2026-10-10T00:00:00.000Z'
    })),
    savedResults: new Map([[pathB, makeResult(pathB)]])
  })
  const delayed = h.mock.delayLoad(pathA)
  try {
    h.mock.setSelectedPath(pathA)
    await act(h, () => button(h.host, '选择项目文件夹').click())
    await openRecentProject(h, pathB)
    delayed.reject(new Error('Error invoking remote method \'result:load\': Error: 历史结果格式无效或超出支持范围，请重新生成。'))
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('ProjectB'), 'project B remains the active configuration')
    assert.ok(!h.host.textContent.includes('历史结果格式无效或超出支持范围，请重新生成。'), 'stale A failure cannot set a notice on B')
  } finally { await cleanupAndUnmount(h) }
})

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

  const session3 = new GenerationSession({
    generate: (request) => Promise.resolve({ runId: request.runId, result: makeResult('C:\\RequestedAlias'), storagePath: 'c:/RequestedAlias' }),
    cancelGenerate: () => undefined
  }, () => 'run-storage-key')
  const storedOptions = { ...opts, projectPath: 'C:\\RequestedAlias' }
  const storedRun = session3.start(storedOptions, makeOverview(storedOptions.projectPath))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session3.getTask(storedRun).options.projectPath, storedOptions.projectPath, 'the frozen generation request keeps its original key')
  assert.equal(session3.getTask(storedRun).resultStoragePath, 'c:/RequestedAlias', 'the actual persisted result key is kept separately')
  session3.dispose()
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

test('viewing recent A then regenerating rescans A and restores its options and still-valid profile', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const resultA = { ...makeResult(pathA), granularity: 'fine', roleFocus: 'backend', profileId: 'profile-1' }
  const recent = [pathA, pathB].map((projectPath) => ({
    path: projectPath, name: projectPath.split('\\').at(-1), lastUsedAt: '2026-10-10T00:00:00.000Z'
  }))
  const h = await mountApp({
    recent,
    savedResults: new Map([[pathA, resultA], [pathB, makeResult(pathB)]]),
    profiles: [
      { id: 'profile-1', name: 'History profile', baseUrl: 'https://one.example/v1', apiKey: '', model: 'one' },
      { id: 'profile-2', name: 'Default profile', baseUrl: 'https://two.example/v1', apiKey: '', model: 'two' }
    ],
    defaultProfileId: 'profile-2'
  })
  try {
    await openRecentProject(h, pathB)
    assert.deepEqual(h.mock.scans, [pathB])
    await act(h, () => button(h.host, '切换项目').click())
    await viewRecentResult(h, pathA)
    await startRecoveryFromVisibleResult(h)

    assert.equal(h.mock.scans.filter((item) => item === pathA).length, 1, 'history recovery must scan A instead of stale B')
    assert.equal(h.mock.scans.filter((item) => item === pathB).length, 1)
    assert.equal(h.mock.loads.at(-1), pathA, 'the result loaded after scan must belong to A')
    assert.ok(h.host.textContent.includes('ProjectA'))
    const request = await startGeneration(h)
    assert.deepEqual(request.request, {
      projectPath: pathA, granularity: 'fine', roleFocus: 'backend', profileId: 'profile-1', runId: request.request.runId
    })
    await act(h, () => request.resolve({ runId: request.request.runId, result: makeResult(pathA) }))
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'))
  } finally { await cleanupAndUnmount(h) }
})

test('a removed history profile falls back to the current usable profile', async () => {
  const pathA = 'C:\\ProjectA'
  const resultA = { ...makeResult(pathA), granularity: 'coarse', roleFocus: 'frontend', profileId: 'removed-profile' }
  const h = await mountApp({
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, resultA]]),
    profiles: [{ id: 'profile-2', name: 'Available', baseUrl: 'https://two.example/v1', apiKey: '', model: 'two' }],
    defaultProfileId: 'profile-2'
  })
  try {
    await beginHistoryRecovery(h, pathA)
    const request = await startGeneration(h)
    assert.equal(request.request.projectPath, pathA)
    assert.equal(request.request.granularity, 'coarse')
    assert.equal(request.request.roleFocus, 'frontend')
    assert.equal(request.request.profileId, 'profile-2')
    await act(h, () => request.resolve({ runId: request.request.runId, result: makeResult(pathA) }))
  } finally { await cleanupAndUnmount(h) }
})

test('failed history scan keeps the old result actionable and retry scan restores configuration', async () => {
  const pathA = 'C:\\ProjectA'
  const resultA = { ...makeResult(pathA), granularity: 'fine', roleFocus: 'algorithm', profileId: 'profile-1' }
  const h = await mountApp({
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, resultA]])
  })
  try {
    h.mock.failNextScan(pathA, new Error('missing folder'))
    await beginHistoryRecovery(h, pathA)
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), 'failed recovery must keep the history result visible')
    assertRecoveryActions(h.host)
    assert.deepEqual(h.mock.deletions, [], 'recovery must never delete the saved result')

    const retry = button(h.host, '重试扫描')
    await act(h, () => retry.click())
    assert.deepEqual(h.mock.scans, [pathA, pathA])
    assert.equal(h.mock.loads.at(-1), pathA)
    assert.ok(h.host.textContent.includes(pathA), 'retry should restore configuration for the same root')
    const request = await startGeneration(h)
    assert.equal(request.request.granularity, 'fine')
    assert.equal(request.request.roleFocus, 'algorithm')
    assert.equal(request.request.profileId, 'profile-1')
    await act(h, () => request.resolve({ runId: request.request.runId, result: makeResult(pathA) }))
  } finally { await cleanupAndUnmount(h) }
})

test('regeneration displays a disabled scan state and rapid clicks issue one recovery scan', async () => {
  const pathA = 'C:\\ProjectA'
  const h = await mountApp({
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, makeResult(pathA)]])
  })
  const pendingScan = h.mock.delayScan(pathA)
  try {
    await viewRecentResult(h, pathA)
    await act(h, () => button(h.host, '重新生成').click())
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), 'history view remains until its scan and load finish')
    const scanning = button(h.host, '重新扫描项目…')
    assert.ok(scanning, 'the result action should show the active scan state')
    assert.equal(scanning.disabled, true)
    await act(h, () => { scanning.click(); scanning.click() })
    assert.equal(h.mock.scans.filter((item) => item === pathA).length, 1, 'rapid clicks should not duplicate the scan')
    pendingScan.resolve()
    await act(h, () => {})
    assert.ok(h.host.textContent.includes(pathA))
  } finally { await cleanupAndUnmount(h) }
})

test('relocation uses the new root and history preferences without attaching A result to it', async () => {
  const pathA = 'C:\\ProjectA'
  const newPath = 'D:\\RelocatedA'
  const resultA = { ...makeResult(pathA), granularity: 'fine', roleFocus: 'backend', profileId: 'profile-1' }
  const h = await mountApp({
    selectedPath: newPath,
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, resultA]])
  })
  try {
    h.mock.failNextScan(pathA, new Error('old location missing'))
    await beginHistoryRecovery(h, pathA)
    assertRecoveryActions(h.host)
    await act(h, () => button(h.host, '重新定位项目').click())
    assert.equal(h.mock.selectCalls, 1)
    assert.equal(h.mock.scans.at(-1), newPath)
    assert.equal(h.mock.loads.at(-1), newPath)
    assert.deepEqual(h.mock.removals, [pathA], 'old recent path is removed only after new scan and load succeed')
    assert.ok(h.host.textContent.includes(newPath))
    assert.ok(!button(h.host, '查看上次生成结果'), 'the old A result must not be attached to the relocated root')

    const request = await startGeneration(h)
    assert.equal(request.request.projectPath, newPath)
    assert.equal(request.request.granularity, 'fine')
    assert.equal(request.request.roleFocus, 'backend')
    assert.equal(request.request.profileId, 'profile-1')
    await act(h, () => request.resolve({ runId: request.request.runId, result: makeResult(newPath) }))
  } finally { await cleanupAndUnmount(h) }
})

test('historical relocation removes the exact source recent key across Windows path variants', async () => {
  const sourcePath = 'C:\\Demo\\'
  const resultPath = 'C:\\Demo'
  const variants = ['c:\\demo', 'C:/Demo/', 'C:\\Demo\\']
  for (const targetPath of variants) {
    const h = await mountApp({
      selectedPath: targetPath,
      recent: [{ path: sourcePath, name: 'Demo', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
      savedResults: new Map([[sourcePath, makeResult(resultPath)]])
    })
    try {
      h.mock.failNextScan(sourcePath, new Error('old location missing'))
      await beginHistoryRecovery(h, sourcePath)
      await act(h, () => button(h.host, '重新定位项目').click())
      assert.deepEqual(h.mock.removals, targetPath === sourcePath ? [] : [sourcePath], `remove the source recent.json key only when target differs exactly: ${targetPath}`)
      assert.ok(h.mock.recentPaths.includes(targetPath), 'the successful target scan inserts the selected key')
      const request = await startGeneration(h)
      assert.equal(request.request.projectPath, targetPath, 'generation keeps the selected storage key even when result.projectPath differs')
      await act(h, () => request.resolve({ runId: request.request.runId, result: makeResult(resultPath) }))
      const movedAgainPath = 'E:\\MovedAgain'
      h.mock.setSelectedPath(movedAgainPath)
      h.mock.failNextScan(targetPath, new Error('relocated location missing'))
      await act(h, () => button(h.host, '重新生成').click())
      await act(h, () => button(h.host, '重新定位项目').click())
      assert.equal(h.mock.scans.at(-1), movedAgainPath)
      assert.equal(h.mock.removals.at(-1), targetPath, 'a later recovery uses the actual prior recent key, not result.projectPath')
    } finally { await cleanupAndUnmount(h) }
  }
})

test('App binds scans and generated history to actual storage keys from IPC responses', async () => {
  const requestedPath = 'c:/demo/ProjectX/'
  const canonicalRoot = 'C:\\Demo\\ProjectX'
  const scanStoragePath = 'C:\\Demo\\ProjectX\\'
  const resultStoragePath = 'c:\\demo\\projectx\\'
  const h = await mountApp({
    selectedPath: requestedPath,
    scanOverview: (path) => path === requestedPath
      ? { ...makeOverview(canonicalRoot), storagePath: scanStoragePath }
      : makeOverview(path)
  })
  try {
    await openProject(h, requestedPath)
    assert.deepEqual(h.mock.loads, [scanStoragePath], 'loadResult follows the storage key returned by scanProject')
    assert.ok(h.mock.recentPaths.includes(scanStoragePath), 'scan mock inserts the returned storage key into recent projects')

    const request = await startGeneration(h)
    assert.equal(request.request.projectPath, scanStoragePath, 'generation uses the scan response storage key')
    await act(h, () => request.resolve({
      runId: request.request.runId,
      result: makeResult(canonicalRoot),
      storagePath: resultStoragePath
    }))
    assert.ok(h.host.textContent.includes('ProjectX · 面试题'))

    await act(h, () => button(h.host, '重新生成').click())
    assert.equal(h.mock.scans.at(-1), resultStoragePath, 'later history recovery uses the generation response storage key')
    assert.equal(h.mock.loads.at(-1), resultStoragePath)
  } finally { await cleanupAndUnmount(h) }
})

test('cancelling relocation leaves A history intact and performs no scan or removal', async () => {
  const pathA = 'C:\\ProjectA'
  const scansBefore = []
  const h = await mountApp({
    selectedPath: null,
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, makeResult(pathA)]])
  })
  try {
    h.mock.failNextScan(pathA)
    await beginHistoryRecovery(h, pathA)
    scansBefore.push(...h.mock.scans)
    await act(h, () => button(h.host, '重新定位项目').click())
    assert.equal(h.mock.selectCalls, 1)
    assert.deepEqual(h.mock.scans, scansBefore, 'cancelled folder selection must not scan another path')
    assert.deepEqual(h.mock.removals, [])
    assert.deepEqual(h.mock.deletions, [])
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'))
    assertRecoveryActions(h.host)
  } finally { await cleanupAndUnmount(h) }
})

test('removing an unreadable recent succeeds without deleting its history; failure keeps the recovery actions', async () => {
  const pathA = 'C:\\ProjectA'
  const createHarness = async () => mountApp({
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, makeResult(pathA)]])
  })
  const success = await createHarness()
  try {
    success.mock.failNextScan(pathA)
    await beginHistoryRecovery(success, pathA)
    await act(success, () => button(success.host, '从最近项目移除').click())
    assert.deepEqual(success.mock.removals, [pathA])
    assert.deepEqual(success.mock.deletions, [])
    assert.ok(success.host.textContent.includes('选择项目文件夹'))
    assert.ok(!success.host.textContent.includes('ProjectA'), 'successful recent removal should leave the list')
  } finally { await cleanupAndUnmount(success) }

  const failure = await createHarness()
  try {
    failure.mock.failNextScan(pathA)
    await beginHistoryRecovery(failure, pathA)
    failure.mock.failNextRemove(pathA, new Error('remove rejected'))
    await act(failure, () => button(failure.host, '从最近项目移除').click())
    assert.deepEqual(failure.mock.removals, [pathA])
    assert.deepEqual(failure.mock.deletions, [])
    assert.ok(failure.host.textContent.includes('ProjectA · 面试题'))
    assertRecoveryActions(failure.host)
    assert.ok(failure.host.textContent.includes('移除'), 'removal failure should give an actionable warning')
  } finally { await cleanupAndUnmount(failure) }
})

test('relocation remove failure still opens the new root and reports that A remains recent', async () => {
  const pathA = 'C:\\ProjectA'
  const newPath = 'D:\\RelocatedA'
  const h = await mountApp({
    selectedPath: newPath,
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, { ...makeResult(pathA), granularity: 'fine', roleFocus: 'backend' }]])
  })
  try {
    h.mock.failNextScan(pathA)
    await beginHistoryRecovery(h, pathA)
    h.mock.failNextRemove(pathA, new Error('remove rejected'))
    await act(h, () => button(h.host, '重新定位项目').click())
    assert.equal(h.mock.scans.at(-1), newPath)
    assert.equal(h.mock.loads.at(-1), newPath)
    assert.deepEqual(h.mock.removals, [pathA])
    assert.ok(h.host.textContent.includes(newPath), 'new root should remain configured')
    assert.ok(h.mock.recentPaths.includes(pathA), 'the old recent entry should remain after removal failure')
    assert.ok(h.host.textContent.includes('旧项目的最近记录移除失败'), 'the configuration should explain the failed old-recent removal')
    assert.ok(!button(h.host, '查看上次生成结果'))
  } finally { await cleanupAndUnmount(h) }
})

test('late historical scan success or failure cannot replace project B or show A recovery state', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  for (const outcome of ['success', 'failure']) {
    const h = await mountApp({
      recent: [pathA, pathB].map((projectPath) => ({
        path: projectPath, name: projectPath.split('\\').at(-1), lastUsedAt: '2026-10-10T00:00:00.000Z'
      })),
      savedResults: new Map([[pathA, makeResult(pathA)], [pathB, makeResult(pathB)]])
    })
    const delayed = h.mock.delayScan(pathA)
    try {
      await viewRecentResult(h, pathA)
      await act(h, () => button(h.host, '重新生成').click())
      await act(h, () => button(h.host, '切换项目').click())
      await viewRecentResult(h, pathB)
      const loadsOfAAfterNavigation = h.mock.loads.filter((item) => item === pathA).length
      if (outcome === 'success') delayed.resolve()
      else delayed.reject(new Error('A disappeared while scan was pending'))
      await act(h, () => {})
      assert.ok(h.host.textContent.includes('ProjectB · 面试题'), `${outcome} for stale A scan cannot replace B`)
      assert.ok(!h.host.textContent.includes('原项目无法读取'), 'stale scan failure must not show its recovery panel')
      assert.equal(h.mock.loads.filter((item) => item === pathA).length, loadsOfAAfterNavigation, 'stale scan must not start a stale A load')
    } finally { await cleanupAndUnmount(h) }
  }
})

test('late historical load success or failure cannot replace project B or show A recovery state', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  for (const outcome of ['success', 'failure']) {
    const h = await mountApp({
      recent: [pathA, pathB].map((projectPath) => ({
        path: projectPath, name: projectPath.split('\\').at(-1), lastUsedAt: '2026-10-10T00:00:00.000Z'
      })),
      savedResults: new Map([[pathA, makeResult(pathA)], [pathB, makeResult(pathB)]])
    })
    const delayed = h.mock.delayLoad(pathA)
    try {
      await viewRecentResult(h, pathA)
      await act(h, () => button(h.host, '重新生成').click())
      assert.equal(h.mock.scans.at(-1), pathA)
      await act(h, () => button(h.host, '切换项目').click())
      await viewRecentResult(h, pathB)
      if (outcome === 'success') delayed.resolve()
      else delayed.reject(new Error('A result load failed late'))
      await act(h, () => {})
      assert.ok(h.host.textContent.includes('ProjectB · 面试题'), `${outcome} for stale A load cannot replace B`)
      assert.ok(!h.host.textContent.includes('原项目无法读取'), 'stale load failure must not show its recovery panel')
    } finally { await cleanupAndUnmount(h) }
  }
})

test('leaving a pending history recovery for Settings prevents late scan navigation; back returns to its result', async () => {
  const pathA = 'C:\\ProjectA'
  const h = await mountApp({
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, makeResult(pathA)]])
  })
  const delayed = h.mock.delayScan(pathA)
  try {
    await viewRecentResult(h, pathA)
    await act(h, () => button(h.host, '重新生成').click())
    await act(h, () => button(h.host, '设置').click())
    assert.ok(h.host.textContent.includes('大模型配置'))
    delayed.resolve()
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('大模型配置'), 'late history scan must not steal settings navigation')
    assert.equal(h.mock.loads.filter((item) => item === pathA).length, 1, 'stale scan must not continue into loadResult')
    await act(h, () => button(h.host, '返回').click())
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'))
    assert.ok(!h.host.textContent.includes('原项目无法读取'))
  } finally { await cleanupAndUnmount(h) }
})

test('resuming a background task wins navigation over a pending history scan success or failure', async () => {
  const pathA = 'C:\\ProjectA'
  for (const outcome of ['success', 'failure']) {
    const h = await mountApp({
      recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
      savedResults: new Map([[pathA, makeResult(pathA)]])
    })
    try {
      await openRecentProject(h, pathA)
      const background = await startGeneration(h)
      await leaveGenerationToSelect(h)
      await viewRecentResult(h, pathA)
      const delayed = h.mock.delayScan(pathA)
      await startRecoveryFromVisibleResult(h)
      await act(h, () => button(h.host, '后台生成').click())
      await act(h, () => button(h.host, '恢复任务').click())
      assert.ok(h.host.textContent.includes('正在为「ProjectA」生成面试题'))

      if (outcome === 'success') delayed.resolve()
      else delayed.reject(new Error('late history scan failure'))
      await act(h, () => {})
      assert.ok(h.host.textContent.includes('正在为「ProjectA」生成面试题'), 'task resume must win the pending history navigation')
      assert.ok(!h.host.textContent.includes('原项目无法读取'))
      assert.deepEqual(h.mock.cancellations, [], 'resuming the existing task must not cancel it')
      assert.equal(h.mock.requests.length, 1)
      assert.ok(background.request.runId)
    } finally { await cleanupAndUnmount(h) }
  }
})

test('an invalid recent result does not prevent a valid neighboring history result from opening', async () => {
  const invalidPath = 'C:\\InvalidHistory'
  const validPath = 'C:\\ValidHistory'
  const h = await mountApp({
    recent: [invalidPath, validPath].map((projectPath) => ({
      path: projectPath,
      name: projectPath.split('\\').at(-1),
      lastUsedAt: '2026-10-10T00:00:00.000Z'
    })),
    savedResults: new Map([[validPath, makeResult(validPath)]]),
    loadFailures: new Map([[invalidPath, new Error('历史结果格式无效或超出支持范围，请重新生成。')]])
  })
  try {
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('历史结果格式无效或超出支持范围，请重新生成。'))
    assert.ok(recentButton(h.host, validPath, '查看结果'), 'valid neighbor keeps its history action available')
    await viewRecentResult(h, validPath)
    assert.ok(h.host.textContent.includes('ValidHistory · 面试题'), 'valid neighbor remains usable')
  } finally { await cleanupAndUnmount(h) }
})

test('history recovery never cancels an active background run and restored configuration stays busy', async () => {
  const pathA = 'C:\\ProjectA'
  const h = await mountApp({
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, makeResult(pathA)]])
  })
  try {
    await openRecentProject(h, pathA)
    const background = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await viewRecentResult(h, pathA)
    await startRecoveryFromVisibleResult(h)
    assert.ok(h.host.textContent.includes('仍在生成'), 'existing active task should keep the restored configuration busy')
    const start = [...h.host.querySelectorAll('button')].find((item) => (item.textContent || '').includes('开始生成面试题'))
    assert.ok(start?.disabled)
    assert.deepEqual(h.mock.cancellations, [], 'history recovery must not cancel the detached task')
    await act(h, () => background.resolve({ runId: background.request.runId, result: makeResult(pathA) }))
    assert.ok(h.host.textContent.includes('ProjectA'), 'background completion must not steal configuration navigation')
    assert.deepEqual(h.mock.cancellations, [])
  } finally { await cleanupAndUnmount(h) }
})

test('returning from A history recovery to task B restores B options after cancel or failure', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const resultA = { ...makeResult(pathA), granularity: 'coarse', roleFocus: 'frontend', profileId: 'profile-A' }
  const resultB = { ...makeResult(pathB), granularity: 'medium', roleFocus: 'general', profileId: 'profile-B' }
  const profiles = [
    { id: 'profile-A', name: 'A profile', baseUrl: 'https://a.example/v1', apiKey: '', model: 'a-model' },
    { id: 'profile-B', name: 'B profile', baseUrl: 'https://b.example/v1', apiKey: '', model: 'b-model' }
  ]

  for (const settlement of ['cancel', 'failure']) {
    const h = await mountApp({
      defaultProfileId: 'profile-B',
      profiles,
      recent: [pathA, pathB].map((projectPath) => ({
        path: projectPath, name: projectPath.split('\\').at(-1), lastUsedAt: '2026-10-10T00:00:00.000Z'
      })),
      savedResults: new Map([[pathA, resultA], [pathB, resultB]])
    })
    try {
      await openRecentProject(h, pathB)
      await act(h, () => button(h.host, '细粒度').click())
      await act(h, () => button(h.host, '后端').click())
      const requestB = await startGeneration(h)
      assert.deepEqual(
        { projectPath: requestB.request.projectPath, granularity: requestB.request.granularity, roleFocus: requestB.request.roleFocus, profileId: requestB.request.profileId },
        { projectPath: pathB, granularity: 'fine', roleFocus: 'backend', profileId: 'profile-B' },
        'first B generation should use the choices configured for B'
      )

      await leaveGenerationToSelect(h)
      await viewRecentResult(h, pathA)
      await startRecoveryFromVisibleResult(h)
      assert.ok(h.host.textContent.includes('仍在生成'), 'background B should keep recovered A configuration busy')
      await act(h, () => button(h.host, '查看任务').click())
      assert.ok(h.host.textContent.includes('正在为「ProjectB」生成面试题'), 'task panel should restore B')
      assert.ok(h.host.textContent.includes('细粒度 · 后端方向'), 'resumed B should show its frozen task options')

      if (settlement === 'cancel') {
        await act(h, () => button(h.host, '取消生成').click())
        assert.deepEqual(h.mock.cancellations, [requestB.request.runId], 'cancel targets the restored B run')
        await act(h, () => requestB.reject(new Error('已取消生成')))
      } else {
        await act(h, () => requestB.reject(new Error('B provider failed')))
        assert.ok(h.host.textContent.includes('B provider failed'))
        await act(h, () => button(h.host, '返回调整配置并重试').click())
        assert.deepEqual(h.mock.cancellations, [], 'failure should not be converted into a cancellation')
      }

      assert.ok(h.host.textContent.includes(pathB), 'settling restored B should return to its configuration')
      const retryB = await startGeneration(h)
      assert.deepEqual(
        { projectPath: retryB.request.projectPath, granularity: retryB.request.granularity, roleFocus: retryB.request.roleFocus, profileId: retryB.request.profileId },
        { projectPath: pathB, granularity: 'fine', roleFocus: 'backend', profileId: 'profile-B' },
        `after B ${settlement}, retry must restore B options rather than A or global defaults`
      )
      await act(h, () => retryB.resolve({ runId: retryB.request.runId, result: makeResult(pathB) }))
    } finally { await cleanupAndUnmount(h) }
  }
})
