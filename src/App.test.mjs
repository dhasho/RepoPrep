// End-to-end renderer lifecycle checks against the real App with delayed IPC mocks.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
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

function makeResult(projectPath, overrides = {}) {
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
    glossary: {},
    ...overrides
  }
}

function analysisId(seed) {
  return createHash('sha256').update(String(seed)).digest('hex')
}

function makeAnalysis(projectPath, result, overrides = {}) {
  const id = overrides.id ?? analysisId(JSON.stringify(result))
  return {
    summary: {
      id,
      createdAt: result.createdAt,
      granularity: result.granularity,
      roleFocus: result.roleFocus,
      ...overrides.summary
    },
    result
  }
}

function makeApi({
  selectedPath: initialSelectedPath = 'C:\\ProjectA',
  recent: initialRecent = [],
  savedResults: initialSavedResults = new Map(),
  loadFailures: initialLoadFailures = new Map(),
  storageDiagnostics: initialStorageDiagnostics = [],
  storageRecoveryFailures: initialStorageRecoveryFailures = new Map(),
  generationDrafts: initialGenerationDrafts = new Map(),
  generationDraftFailures: initialDraftFailures = new Map(),
  scanOverview,
  generateImmediately,
  profiles = [{ id: 'profile-1', name: 'Mock', baseUrl: 'https://example.test/v1', apiKey: '', model: 'mock-model' }],
  defaultProfileId = profiles[0]?.id ?? null
} = {}) {
  let selectedPath = initialSelectedPath
  let recent = [...initialRecent]
  const analysesByProject = new Map()
  const requests = []
  const explainRequests = []
  const explainCancellations = []
  const explainListeners = new Set()
  const cancellations = []
  const scans = []
  const loads = []
  const analysisLoads = []
  const analysisLists = []
  const removals = []
  const deletions = []
  const storageRecoveries = []
  let storageDiagnostics = [...initialStorageDiagnostics]
  const storageRecoveryFailures = initialStorageRecoveryFailures instanceof Map
    ? new Map(initialStorageRecoveryFailures)
    : new Map(Object.entries(initialStorageRecoveryFailures))
  const generationDrafts = initialGenerationDrafts instanceof Map ? new Map(initialGenerationDrafts) : new Map(Object.entries(initialGenerationDrafts))
  const draftReads = []
  const draftDiscards = []
  const draftFailures = initialDraftFailures instanceof Map ? new Map(initialDraftFailures) : new Map(Object.entries(initialDraftFailures))
  const delayedStorageRecoveries = new Map()
  const listeners = new Set()
  const delayedScans = new Map()
  const delayedLoads = new Map()
  const delayedAnalysisLoads = new Map()
  const scanFailures = new Map()
  const loadFailures = new Map()
  const analysisListFailures = new Map()
  const analysisLoadFailures = new Map()
  const removeFailures = new Map()
  const delayedAnalysisLists = new Map()
  const cleanupControls = new Set()
  const savedResults = initialSavedResults instanceof Map
    ? new Map(initialSavedResults)
    : new Map(Object.entries(initialSavedResults))
  for (const [projectPath, result] of savedResults) {
    if (result) analysesByProject.set(projectPath, [makeAnalysis(projectPath, result)])
  }
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
    getGenerationDraft: async (projectPath) => {
      draftReads.push(projectPath)
      const failures = draftFailures.get(projectPath)
      if (failures?.length) { const error = failures.shift(); if (!failures.length) draftFailures.delete(projectPath); throw error }
      return generationDrafts.get(projectPath) ?? null
    },
    discardGenerationDraft: async (projectPath, draftId) => { draftDiscards.push({ projectPath, draftId }); if (generationDrafts.get(projectPath)?.id === draftId) generationDrafts.delete(projectPath) },
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
    listAnalyses: async (projectPath, cursor) => {
      analysisLists.push({ projectPath, cursor })
      const failure = take(analysisListFailures, projectPath)
      if (failure) throw failure
      const control = take(delayedAnalysisLists, projectPath)
      if (control) await control.promise
      const entries = analysesByProject.get(projectPath) ?? []
      const start = cursor ? Math.max(0, entries.findIndex((entry) => entry.summary.id === cursor) + 1) : 0
      const items = entries.slice(start, start + 50).map(({ summary }) => summary)
      return { items, nextCursor: start + 50 < entries.length ? items.at(-1)?.id ?? null : null }
    },
    loadAnalysis: async (projectPath, id) => {
      analysisLoads.push({ projectPath, id })
      const failure = take(analysisLoadFailures, `${projectPath}:${id}`) ?? take(analysisLoadFailures, projectPath)
      if (failure) throw failure
      const control = take(delayedAnalysisLoads, `${projectPath}:${id}`)
      if (control) await control.promise
      const entry = (analysesByProject.get(projectPath) ?? []).find((item) => item.summary.id === id)
      return entry?.result ?? null
    },
    deleteResult: async (projectPath) => { deletions.push(projectPath) },
    getSettings: async () => ({
      profiles,
      defaultProfileId
    }),
    getStorageDiagnostics: async () => [...storageDiagnostics],
    recoverStorage: async (id) => {
      storageRecoveries.push(id)
      const failure = storageRecoveryFailures.get(id)
      if (failure) {
        storageRecoveryFailures.delete(id)
        throw failure
      }
      const control = delayedStorageRecoveries.get(id)
      if (control) {
        delayedStorageRecoveries.delete(id)
        await control.promise
      }
      storageDiagnostics = storageDiagnostics.filter((diagnostic) => diagnostic.id !== id)
    },
    saveSettings: async () => {},
    testLlm: async () => ({ ok: true, message: 'ok' }),
    listModels: async () => ({ ok: true, models: [], message: 'ok' }),
    exportMarkdown: async () => ({ ok: true, message: 'ok' }),
    generate: (request) => {
      const control = deferred()
      const pending = { request, ...control }
      requests.push(pending)
      if (generateImmediately) return generateImmediately(request)
      return control.promise.then((response) => {
        if (!response?.result) return response
        const entry = makeAnalysis(request.projectPath, response.result, { id: response.analysisId })
        const entries = analysesByProject.get(request.projectPath) ?? []
        analysesByProject.set(request.projectPath, [entry, ...entries.filter((item) => item.summary.id !== entry.summary.id)])
        return { ...response, analysisId: entry.summary.id }
      })
    },
    cancelGenerate: async (runId) => { cancellations.push(runId) },
    explain: (request) => {
      const control = deferred()
      explainRequests.push({ request, ...control })
      return control.promise
    },
    cancelExplain: async (requestId) => { explainCancellations.push(requestId) },
    onExplainEvent: (callback) => {
      explainListeners.add(callback)
      return () => explainListeners.delete(callback)
    },
    onGenerateProgress: (callback) => {
      subscribeCount++
      listeners.add(callback)
      return () => { listeners.delete(callback); unsubscribeCount++ }
    }
  }
  return {
    api,
    requests,
    draftReads,
    draftDiscards,
    explainRequests,
    explainCancellations,
    cancellations,
    scans,
    loads,
    analysisLoads,
    analysisLists,
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
    delayAnalysisLoad: (projectPath, id, control = deferred()) => {
      queue(delayedAnalysisLoads, `${projectPath}:${id}`, control)
      cleanupControls.add(control)
      return control
    },
    delayAnalysisList: (projectPath, control = deferred()) => {
      queue(delayedAnalysisLists, projectPath, control)
      cleanupControls.add(control)
      return control
    },
    failNextScan: (projectPath, error = new Error('scan failed')) => queue(scanFailures, projectPath, error),
    failNextDraftRead: (projectPath, error = new Error('draft read failed')) => queue(draftFailures, projectPath, error),
    failNextLoad: (projectPath, error = new Error('load failed')) => queue(loadFailures, projectPath, error),
    failNextAnalysisList: (projectPath, error = new Error('analysis list failed')) => queue(analysisListFailures, projectPath, error),
    failNextAnalysisLoad: (projectPath, error = new Error('analysis load failed'), id) => queue(analysisLoadFailures, id ? `${projectPath}:${id}` : projectPath, error),
    failNextRemove: (projectPath, error = new Error('remove failed')) => queue(removeFailures, projectPath, error),
    setRecent: (entries) => { recent = [...entries] },
    setSavedResult: (projectPath, result) => {
      savedResults.set(projectPath, result)
      if (result) analysesByProject.set(projectPath, [makeAnalysis(projectPath, result)])
    },
    setAnalyses: (projectPath, entries) => {
      const normalized = entries.map((entry, index) => entry.summary ? entry : makeAnalysis(projectPath, entry.result ?? entry, { id: entry.id ?? analysisId(`${projectPath}:fixture:${index}`), summary: entry }))
      analysesByProject.set(projectPath, normalized)
    },
    get historySnapshot() {
      return [...analysesByProject].map(([projectPath, entries]) => [projectPath, entries.map((entry) => entry.summary.id)])
    },
    cleanupPending: () => {
      for (const control of cleanupControls) control.resolve()
      for (const pending of requests) {
        pending.resolve({ runId: pending.request.runId, result: makeResult(pending.request.projectPath) })
      }
    },
    get selectCalls() { return selectCalls },
    get recentPaths() { return recent.map((project) => project.path) },
    get storageDiagnostics() { return [...storageDiagnostics] },
    get storageRecoveries() { return [...storageRecoveries] },
    setStorageDiagnostics: (entries) => { storageDiagnostics = [...entries] },
    delayStorageRecovery: (id, control = deferred()) => {
      delayedStorageRecoveries.set(id, control)
      cleanupControls.add(control)
      return control
    },
    emitProgress: (progress) => { for (const listener of listeners) listener(progress) },
    emitExplainEvent: (event) => { for (const listener of explainListeners) listener(event) },
    emitExplainDelta: (request, data) => { for (const listener of explainListeners) listener({ type: 'delta', requestId: request.request.requestId, data }) },
    emitExplainDone: (request) => { for (const listener of explainListeners) listener({ type: 'done', requestId: request.request.requestId, data: '' }) },
    emitExplainError: (request, message) => { for (const listener of explainListeners) listener({ type: 'error', requestId: request.request.requestId, data: message }) },
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
    requestAnimationFrame: dom.window.requestAnimationFrame?.bind(dom.window) ?? ((callback) => setTimeout(() => callback(Date.now()), 0)),
    cancelAnimationFrame: dom.window.cancelAnimationFrame?.bind(dom.window) ?? clearTimeout,
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
    await action()
    await new Promise((resolve) => setImmediate(resolve))
  })
}

function button(host, text) {
  return [...host.querySelectorAll('button')].find((item) =>
    (item.textContent || '').trim().includes(text) || item.getAttribute('aria-label')?.includes(text))
}

function buttonByLabel(host, label) {
  return [...host.querySelectorAll('button[aria-label]')]
    .find((item) => item.getAttribute('aria-label') === label)
}

async function askSelectedTerm(harness, term) {
  const target = termButton(harness.host, term)
  assert.ok(target)
  const range = harness.dom.window.document.createRange()
  range.selectNodeContents(target)
  const selection = harness.dom.window.document.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  const before = harness.mock.explainRequests.length
  await act(harness, () => target.dispatchEvent(new harness.dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: 50 })))
  assert.equal(harness.mock.explainRequests.length, before, 'selection itself is free of model requests')
  const ask = button(harness.host, '向 AI 提问')
  assert.ok(ask)
  await act(harness, () => ask.click())
  await act(harness, () => new Promise((resolve) => setTimeout(resolve, 5)))
}

async function showProjectDirectory(harness) {
  const projects = buttonByLabel(harness.host, '项目分析目录')
  assert.ok(projects, 'project directory rail button should be available')
  if (projects.getAttribute('aria-pressed') !== 'true') {
    await act(harness, () => projects.click())
  }
  return projects
}

async function showQuestionDirectory(harness) {
  const questions = buttonByLabel(harness.host, '最近分析的问题目录')
  assert.ok(questions, 'question directory rail button should be available')
  if (questions.disabled) return questions
  if (questions.getAttribute('aria-pressed') !== 'true') {
    await act(harness, () => questions.click())
  }
  return questions
}

async function clickHistoryButton(harness, direction) {
  const label = direction === 'back' ? '上一步' : '下一步'
  const historyButton = buttonByLabel(harness.host, label)
  assert.ok(historyButton, `${label} navigation control should be available`)
  assert.equal(historyButton.disabled, false, `${label} navigation should have a history target`)
  await act(harness, () => historyButton.click())
}

function recentRow(host, projectPath) {
  const projectButton = [...host.querySelectorAll('button[data-project-path]')]
    .find((item) => item.getAttribute('data-project-path') === projectPath)
  return projectButton?.parentElement?.parentElement ?? null
}

async function recentAnalysisRows(harness, projectPath) {
  await showProjectDirectory(harness)
  const project = recentRow(harness.host, projectPath)
  assert.ok(project, `recent project ${projectPath} should be available`)
  if (!project.querySelector('button[data-analysis-id]')) {
    const toggle = [...project.querySelectorAll('button[aria-label]')]
      .find((item) => item.getAttribute('aria-label')?.includes('的分析'))
    assert.ok(toggle, `project ${projectPath} should expose an analyses expander`)
    await act(harness, () => toggle.click())
  }
  return [...project.querySelectorAll('button[data-analysis-id]')]
}

async function viewRecentResult(harness, projectPath, expectedId) {
  const analysisRows = await recentAnalysisRows(harness, projectPath)
  const action = expectedId
    ? analysisRows.find((item) => item.getAttribute('data-analysis-id') === expectedId)
    : analysisRows[0]
  assert.ok(action, `history analysis ${expectedId ?? ''} for ${projectPath} should be available`)
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
  await showProjectDirectory(harness)
  const action = [...harness.host.querySelectorAll('button[data-project-path]')]
    .find((item) => item.getAttribute('data-project-path') === projectPath)
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
  await beginOpenProject(harness, projectPath)
  assert.ok(harness.host.textContent.includes(projectPath.split(/[\\/]/).filter(Boolean).at(-1)), '应进入目标项目配置页')
}

async function beginOpenProject(harness, projectPath) {
  harness.mock.setSelectedPath(projectPath)
  let create = button(harness.host, '新建')
  if (!create && buttonByLabel(harness.host, '项目分析目录')) {
    await showProjectDirectory(harness)
    create = button(harness.host, '新建')
  }
  assert.ok(create, '项目选择页应通过侧栏新建入口选择文件夹')
  await act(harness, () => create.click())
}

test('application titlebar centers RepoPrep, keeps its actions reachable, and has a draggable surface', async () => {
  const h = await mountApp()
  try {
    const titlebar = h.host.querySelector('header.app-titlebar')
    const title = titlebar?.querySelector('.app-titlebar-title')
    const actions = titlebar?.querySelector('.app-titlebar-actions')
    const back = buttonByLabel(h.host, '上一步')
    const forward = buttonByLabel(h.host, '下一步')
    assert.ok(titlebar, 'the application has one custom titlebar row')
    assert.equal(title?.textContent, 'RepoPrep')
    assert.ok(back && forward, 'history controls live in the titlebar')
    assert.equal(back.disabled, true, 'empty app cannot navigate backward')
    assert.equal(forward.disabled, true, 'empty app cannot navigate forward')
    assert.ok(buttonByLabel(h.host, '设置'), 'settings moved to the navigation rail')
    assert.ok(!actions?.querySelector('button[aria-label="设置"]'), 'titlebar no longer holds settings')
    assert.ok(!actions?.textContent.includes('切换项目'), 'titlebar no longer has a project-switch action')
    assert.match(titlebar.className, /app-titlebar/)
    assert.match(actions.className, /app-titlebar-actions/)
    assert.equal(h.host.textContent.includes('🔭'), false, 'telescope branding is removed from the app shell and project selection')
  } finally { await cleanupAndUnmount(h) }
})

test('new-folder cancellation keeps the project entry view and writes no history', async () => {
  const h = await mountApp()
  try {
    assert.ok(h.host.textContent.includes('选择一个项目，我们开始分析'))
    assert.equal(buttonByLabel(h.host, '最近分析的问题目录')?.disabled, true, 'empty app cannot open the question directory')
    const before = h.mock.historySnapshot
    await openProject(h, 'C:\\ProjectA')
    const scansBeforeCancel = [...h.mock.scans]
    const selectCallsBeforeCancel = h.mock.selectCalls
    const backBeforeCancel = buttonByLabel(h.host, '上一步')?.disabled
    const forwardBeforeCancel = buttonByLabel(h.host, '下一步')?.disabled
    h.mock.setSelectedPath(null)
    await act(h, () => button(h.host, '新建').click())
    assert.equal(h.mock.selectCalls, selectCallsBeforeCancel + 1)
    assert.deepEqual(h.mock.scans, scansBeforeCancel)
    assert.deepEqual(h.mock.historySnapshot, before)
    assert.ok(h.host.textContent.includes('ProjectA'), 'cancel leaves the current configuration visible')
    assert.equal(buttonByLabel(h.host, '上一步')?.disabled, backBeforeCancel)
    assert.equal(buttonByLabel(h.host, '下一步')?.disabled, forwardBeforeCancel)
  } finally { await cleanupAndUnmount(h) }
})

test('project/question sidebars preserve the selected analysis, its search, expansion, and live term explanation', async () => {
  const projectPath = 'C:\\ProjectA'
  const result = makeResult(projectPath, {
    sections: [{ id: 's1', title: 'Section A', questions: [{
      id: 'q1', question: 'SEARCH_NEEDLE explains [[TermA]] in the full question',
      answer: 'EXPANDED_ANSWER_A with [[TermA]] context', followUps: []
    }] }],
    glossary: { TermA: 'GLOSSARY_A' }
  })
  const h = await mountApp({
    recent: [{ path: projectPath, name: 'ProjectA', lastUsedAt: result.createdAt }],
    savedResults: new Map([[projectPath, result]])
  })
  try {
    await viewRecentResult(h, projectPath)
    const search = h.host.querySelector('input[placeholder*="搜索问题"]')
    assert.ok(search)
    const setInputValue = Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value')?.set
    setInputValue?.call(search, 'SEARCH_NEEDLE')
    const { Simulate } = require('react-dom/test-utils')
    await act(h, () => Simulate.change(search, { target: search }))

    const questionCard = [...h.host.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('SEARCH_NEEDLE'))
    assert.ok(questionCard, 'the filtered question stays visible')
    await act(h, () => questionCard.click())
    assert.ok(h.host.textContent.includes('EXPANDED_ANSWER_A'))
    const loadedAnalysisCount = h.mock.analysisLoads.length

    const term = termButton(h.host, 'TermA')
    assert.ok(term)
    await act(h, () => term.click())
    assert.equal(h.mock.explainRequests.length, 0, 'term lookup is a static glossary operation')
    await askSelectedTerm(h, 'TermA')
    const pending = h.mock.explainRequests.at(-1)
    assert.ok(pending)

    const stop = button(h.host, '停止')
    assert.ok(stop)
    stop.focus()

    await showProjectDirectory(h)
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), 'the project directory changes only the sidebar')
    await showQuestionDirectory(h)
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'), 'the question directory changes only the sidebar')
    const restoredSearch = h.host.querySelector('input[placeholder*="搜索问题"]')
    assert.equal(restoredSearch?.value, 'SEARCH_NEEDLE')
    assert.ok(h.host.textContent.includes('EXPANDED_ANSWER_A'), 'expanded answer state survives both sidebar switches')
    assert.equal(h.dom.window.document.activeElement, stop, 'parent updates do not reset focus inside the AI dialog')
    assert.deepEqual(h.mock.scans, [], 'sidebar switches do not scan the selected project')
    assert.equal(h.mock.analysisLoads.length, loadedAnalysisCount, 'sidebar switches do not reload the selected analysis')
    assert.deepEqual(h.mock.explainCancellations, [], 'sidebar switches do not cancel a term explanation')

    h.mock.emitExplainDelta(pending, 'LIVE_EXPLANATION_SURVIVES_SIDEBAR_SWITCH')
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('LIVE_EXPLANATION_SURVIVES_SIDEBAR_SWITCH'))
  } finally { await cleanupAndUnmount(h) }
})

test('question directory restores the exact last analysis after a project configuration visit', async () => {
  const projectPath = 'C:\\ProjectA'
  const older = makeResult(projectPath, {
    createdAt: '2026-10-17T04:15:00.000Z',
    sections: [{ id: 'older', title: 'Older', questions: [{ id: 'old-q', question: 'EXACT_OLDER_ANALYSIS', answer: 'Older answer', followUps: [] }] }]
  })
  const latest = makeResult(projectPath, {
    createdAt: '2026-10-17T06:42:00.000Z',
    sections: [{ id: 'latest', title: 'Latest', questions: [{ id: 'latest-q', question: 'LATEST_ANALYSIS', answer: 'Latest answer', followUps: [] }] }]
  })
  const olderEntry = makeAnalysis(projectPath, older)
  const h = await mountApp({
    recent: [{ path: projectPath, name: 'ProjectA', lastUsedAt: latest.createdAt }],
    savedResults: new Map([[projectPath, latest]])
  })
  try {
    h.mock.setAnalyses(projectPath, [makeAnalysis(projectPath, latest), olderEntry])
    await viewRecentResult(h, projectPath, olderEntry.summary.id)
    await openRecentProject(h, projectPath)
    assert.ok(button(h.host, '开始生成面试题'), 'selecting the project opens its configure page')
    const questionDirectory = buttonByLabel(h.host, '最近分析的问题目录')
    assert.ok(questionDirectory && !questionDirectory.disabled)
    await act(h, () => questionDirectory.click())
    assert.ok(h.host.textContent.includes('EXACT_OLDER_ANALYSIS'), 'question directory restores the last selected analysis ID')
    assert.ok(!h.host.textContent.includes('LATEST_ANALYSIS'))
    assert.deepEqual(h.mock.analysisLoads.map((load) => load.id), [olderEntry.summary.id], 'restoring the snapshot does not load the latest result')
    assert.deepEqual(h.mock.scans, [projectPath], 'only the explicit project configuration visit scans')
  } finally { await cleanupAndUnmount(h) }
})

test('back and forward restore the correct analysis, project options, and settings snapshot; a new visit clears forward history', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const analysisA = makeResult(pathA, {
    sections: [{ id: 'a', title: 'A', questions: [{ id: 'qa', question: 'SNAPSHOT_ANALYSIS_A', answer: 'A', followUps: [] }] }]
  })
  const latestB = makeResult(pathB, {
    granularity: 'coarse', roleFocus: 'frontend',
    sections: [{ id: 'b', title: 'B', questions: [{ id: 'qb', question: 'LATEST_ANALYSIS_B', answer: 'B', followUps: [] }] }]
  })
  const entryA = makeAnalysis(pathA, analysisA)
  const entryB = makeAnalysis(pathB, latestB)
  const recent = [pathA, pathB].map((projectPath) => ({
    path: projectPath,
    name: projectPath.split('\\').at(-1),
    lastUsedAt: '2026-10-17T00:00:00.000Z'
  }))
  const h = await mountApp({ recent, savedResults: new Map([[pathA, analysisA], [pathB, latestB]]) })
  try {
    h.mock.setAnalyses(pathA, [entryA])
    h.mock.setAnalyses(pathB, [entryB])
    await viewRecentResult(h, pathA, entryA.summary.id)
    await openRecentProject(h, pathB)
    assert.ok(h.host.textContent.includes('ProjectB'))
    await act(h, () => button(h.host, '细粒度').click())
    await act(h, () => button(h.host, '后端').click())
    await act(h, () => buttonByLabel(h.host, '设置').click())
    assert.ok(h.host.textContent.includes('大模型配置'))

    await clickHistoryButton(h, 'back')
    assert.ok(h.host.textContent.includes('ProjectB'), 'back from settings restores project B configuration')
    assert.ok(button(h.host, '细粒度')?.className.includes('border-indigo-500'), 'B granularity draft is restored')
    assert.ok(button(h.host, '后端')?.className.includes('bg-indigo-600'), 'B role draft is restored')
    await clickHistoryButton(h, 'back')
    assert.ok(h.host.textContent.includes('SNAPSHOT_ANALYSIS_A'), 'the previous entry is analysis A')
    assert.ok(!h.host.textContent.includes('LATEST_ANALYSIS_B'))

    await clickHistoryButton(h, 'forward')
    assert.ok(h.host.textContent.includes('ProjectB'))
    assert.ok(button(h.host, '细粒度')?.className.includes('border-indigo-500'))
    await clickHistoryButton(h, 'forward')
    assert.ok(h.host.textContent.includes('大模型配置'))

    await clickHistoryButton(h, 'back')
    await openRecentProject(h, pathA)
    assert.ok(h.host.textContent.includes('ProjectA'), 'a new visit opens project A')
    assert.equal(buttonByLabel(h.host, '下一步')?.disabled, true, 'branching from project B discards the old forward settings entry')
  } finally { await cleanupAndUnmount(h) }
})

test('back, forward, and question-directory navigation guard a running task; history restores its terminal result', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const resultA = makeResult(pathA, {
    sections: [{ id: 'a', title: 'A', questions: [{ id: 'qa', question: 'ACTIVE_ANALYSIS_A', answer: 'A', followUps: [] }] }]
  })
  const resultB = makeResult(pathB, {
    createdAt: '2026-10-17T07:10:00.000Z',
    sections: [{ id: 'b', title: 'B', questions: [{ id: 'qb', question: 'COMPLETED_TASK_B', answer: 'B', followUps: [] }] }]
  })
  const entryA = makeAnalysis(pathA, resultA)
  const h = await mountApp({ recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: resultA.createdAt }], savedResults: new Map([[pathA, resultA]]) })
  try {
    await viewRecentResult(h, pathA, entryA.summary.id)
    await openProject(h, pathB)
    const request = await startGeneration(h)

    await act(h, () => buttonByLabel(h.host, '设置').click())
    assert.ok(button(h.host, '后台继续'), 'opening settings during generation uses the existing leave guard')
    await act(h, () => button(h.host, '后台继续').click())
    assert.ok(h.host.textContent.includes('大模型配置'))

    await clickHistoryButton(h, 'back')
    assert.ok(h.host.textContent.includes('正在为「ProjectB」生成面试题'), 'back restores the still-running task snapshot')
    assert.equal(buttonByLabel(h.host, '下一步')?.disabled, false, 'settings remains the forward destination')

    await clickHistoryButton(h, 'forward')
    assert.ok(button(h.host, '留在生成页'), 'forward while generating is guarded')
    await act(h, () => button(h.host, '留在生成页').click())
    const questionDirectory = buttonByLabel(h.host, '最近分析的问题目录')
    assert.ok(questionDirectory && !questionDirectory.disabled)
    await act(h, () => questionDirectory.click())
    assert.ok(button(h.host, '留在生成页'), 'opening the last-analysis question directory while generating is guarded')
    await act(h, () => button(h.host, '留在生成页').click())
    await clickHistoryButton(h, 'back')
    assert.ok(button(h.host, '后台继续'), 'back while generating is guarded')
    await act(h, () => button(h.host, '后台继续').click())
    assert.ok(button(h.host, '开始生成面试题'), 'background continuation reaches the prior project configuration')

    await act(h, () => request.resolve({ runId: request.request.runId, result: resultB }))
    assert.ok(button(h.host, '开始生成面试题'), 'background completion does not steal navigation')
    await clickHistoryButton(h, 'forward')
    assert.ok(h.host.textContent.includes('COMPLETED_TASK_B'), 'forward restores the task result after it has already completed')
    assert.ok(!h.host.textContent.includes('正在为「ProjectB」生成面试题'), 'a terminal task snapshot cannot revive generation UI')

    h.mock.emitProgress({ runId: request.request.runId, step: 'STALE_HISTORY_PROGRESS', percent: 99, ts: Date.now() })
    await act(h, () => {})
    await clickHistoryButton(h, 'back')
    await clickHistoryButton(h, 'forward')
    assert.ok(h.host.textContent.includes('COMPLETED_TASK_B'))
    assert.ok(!h.host.textContent.includes('STALE_HISTORY_PROGRESS'), 'late progress cannot resurrect through a history step')
    assert.deepEqual(h.mock.cancellations, [], 'background history navigation leaves the run alive')
  } finally { await cleanupAndUnmount(h) }
})

async function generateDetachedHistory(h, count, { firstOutcome = 'succeeded', sameProject = false } = {}) {
  const runs = []
  for (let number = 1; number <= count; number++) {
    const projectPath = `C:\\RetainedHistory${sameProject ? '' : number}`
    await openProject(h, projectPath)
    if (number === 1) {
      await act(h, () => button(h.host, '粗粒度').click())
      await act(h, () => button(h.host, '后端').click())
    }
    const pending = await startGeneration(h)
    await act(h, () => buttonByLabel(h.host, '设置').click())
    const cancelled = number === 1 && firstOutcome === 'cancelled'
    await act(h, () => button(h.host, cancelled ? '取消生成并离开' : '后台继续').click())
    const value = makeResult(projectPath, {
      createdAt: new Date(Date.UTC(2026, 9, 18, 0, 0, number)).toISOString(),
      granularity: pending.request.granularity,
      roleFocus: pending.request.roleFocus,
      sections: [{ id: 'history', title: 'Retained', questions: [{ id: `q${number}`, question: `RETAINED_RESULT_${number}`, answer: `Answer ${number}`, followUps: [] }] }]
    })
    await act(h, () => {
      if (number === 1 && firstOutcome === 'failed') pending.reject(new Error('RETAINED_FIRST_FAILURE'))
      else if (cancelled) pending.reject(new Error('生成已取消'))
      else pending.resolve({ runId: pending.request.runId, result: value })
    })
    assert.ok(h.host.textContent.includes('大模型配置'), 'settlement must leave the current settings page in place')
    runs.push({ pending, value })
  }
  return runs
}

async function backToFirstGeneration(h, count) {
  for (let step = 0; step < 3 * (count - 1) + 1; step++) await clickHistoryButton(h, 'back')
}

for (const [count, outcome] of [[10, 'succeeded'], [11, 'succeeded'], [11, 'failed'], [11, 'cancelled']]) {
  test(`retained generation history restores ${outcome} after ${count} attempts`, async () => {
    const h = await mountApp()
    try {
      const runs = await generateDetachedHistory(h, count, { firstOutcome: outcome })
      assert.ok(h.host.textContent.includes('后台生成（10）'), 'recent task storage stays at ten instead of growing with page history')
      const loads = h.mock.analysisLoads.length
      await backToFirstGeneration(h, count)
      assert.ok(!h.host.textContent.includes('选择一个项目，我们开始分析'), 'a retained terminal entry must not degrade to the selection page')
      if (outcome === 'succeeded') {
        assert.ok(h.host.textContent.includes('RETAINED_RESULT_1'))
      } else {
        if (outcome === 'failed') {
          assert.ok(h.host.textContent.includes('RETAINED_FIRST_FAILURE'))
          await act(h, () => button(h.host, '返回调整配置并重试').click())
        }
        assert.ok(button(h.host, '开始生成面试题'))
        assert.ok(button(h.host, '粗粒度')?.className.includes('border-indigo-500'))
        assert.ok(button(h.host, '后端')?.className.includes('bg-indigo-600'), 'original request options survive terminal task eviction')
      }
      assert.equal(h.mock.analysisLoads.length, loads, 'history restoration must not load a possibly newer disk result')
      h.mock.emitProgress({ runId: runs[0].pending.request.runId, step: 'EVICTED_STALE_PROGRESS', percent: 95, ts: Date.now() })
      await act(h, () => {})
      assert.ok(!h.host.textContent.includes('EVICTED_STALE_PROGRESS'))
      assert.ok(!h.host.textContent.includes('正在为「RetainedHistory1」生成面试题'))
    } finally { await cleanupAndUnmount(h) }
  })
}

test('retained generation history keeps the exact same-project analysis after task eviction', async () => {
  const h = await mountApp()
  try {
    const runs = await generateDetachedHistory(h, 11, { sameProject: true })
    await backToFirstGeneration(h, 11)
    assert.ok(h.host.textContent.includes('RETAINED_RESULT_1'))
    assert.ok(!h.host.textContent.includes('RETAINED_RESULT_11'), 'returning to the first analysis must not choose the latest analysis')
    const firstId = makeAnalysis(runs[0].pending.request.projectPath, runs[0].value).summary.id
    const rows = await recentAnalysisRows(h, runs[0].pending.request.projectPath)
    const selected = rows.find((row) => row.getAttribute('data-analysis-id') === firstId)
    assert.ok(selected?.className.includes('bg-indigo-100'), 'the restored analysis ID also selects its exact sidebar row')
    assert.deepEqual(h.mock.analysisLoads, [], 'the exact captured result restores without a disk lookup')
  } finally { await cleanupAndUnmount(h) }
})

test('retained generation history captures synchronous failures before the page entry is inserted', async () => {
  const h = await mountApp({ generateImmediately: () => { throw new Error('SYNCHRONOUS_HISTORY_FAILURE') } })
  try {
    for (let number = 1; number <= 11; number++) {
      await openProject(h, `C:\\SynchronousHistory${number}`)
      await startGeneration(h)
      assert.ok(h.host.textContent.includes('SYNCHRONOUS_HISTORY_FAILURE'))
      await act(h, () => buttonByLabel(h.host, '设置').click())
    }
    await backToFirstGeneration(h, 11)
    assert.ok(h.host.textContent.includes('生成失败'))
    assert.ok(h.host.textContent.includes('SYNCHRONOUS_HISTORY_FAILURE'))
    await act(h, () => button(h.host, '返回调整配置并重试').click())
    assert.ok(h.host.textContent.includes('SynchronousHistory1'))
  } finally { await cleanupAndUnmount(h) }
})

test('retained background outcomes do not replace the last actually opened analysis', async () => {
  const viewedPath = 'C:\\ActuallyViewed'
  const viewed = makeResult(viewedPath, { sections: [{ id: 'viewed', title: 'Viewed', questions: [{ id: 'v', question: 'LAST_ACTUALLY_OPENED', answer: 'Viewed answer', followUps: [] }] }] })
  const h = await mountApp({ recent: [{ path: viewedPath, name: 'ActuallyViewed', lastUsedAt: viewed.createdAt }], savedResults: new Map([[viewedPath, viewed]]) })
  try {
    await viewRecentResult(h, viewedPath, makeAnalysis(viewedPath, viewed).summary.id)
    await generateDetachedHistory(h, 11)
    await showQuestionDirectory(h)
    assert.ok(h.host.textContent.includes('LAST_ACTUALLY_OPENED'))
    assert.ok(!h.host.textContent.includes('RETAINED_RESULT_11'))
  } finally { await cleanupAndUnmount(h) }
})

test('same-project history rows select exact IDs, preserve full questions, and switch back without scanning', async () => {
  const projectPath = 'C:\\HistoryProject'
  const first = makeResult(projectPath, {
    createdAt: '2026-10-17T04:15:00.000Z', granularity: 'coarse', roleFocus: 'general',
    sections: [{ id: 'first', title: 'First', questions: [{ id: 'q1', question: '完整原问题：请解释 first analysis 的调用链？', answer: 'First answer.', followUps: [] }] }]
  })
  const second = makeResult(projectPath, {
    createdAt: '2026-10-17T06:42:00.000Z', granularity: 'fine', roleFocus: 'backend',
    sections: [{ id: 'second', title: 'Second', questions: [{ id: 'q2', question: '完整原问题：second analysis 如何隔离迟到事件？', answer: 'Second answer.', followUps: [] }] }]
  })
  const firstEntry = makeAnalysis(projectPath, first)
  const secondEntry = makeAnalysis(projectPath, second)
  const h = await mountApp({ recent: [{ path: projectPath, name: 'HistoryProject', lastUsedAt: second.createdAt }] })
  try {
    h.mock.setAnalyses(projectPath, [secondEntry, firstEntry])
    const rows = await recentAnalysisRows(h, projectPath)
    assert.equal(rows.length, 2, 'both same-project analyses remain independently selectable')
    assert.match(rows[0].title, /\d{1,2}:42/, 'history rows include the creation time')

    await viewRecentResult(h, projectPath, firstEntry.summary.id)
    assert.ok(h.host.textContent.includes('完整原问题：请解释 first analysis 的调用链？'))
    await showProjectDirectory(h)
    await viewRecentResult(h, projectPath, secondEntry.summary.id)
    assert.ok(h.host.textContent.includes('完整原问题：second analysis 如何隔离迟到事件？'))
    await showProjectDirectory(h)
    await viewRecentResult(h, projectPath, firstEntry.summary.id)
    assert.ok(h.host.textContent.includes('完整原问题：请解释 first analysis 的调用链？'), 'switching back restores the selected ID')
    assert.deepEqual(h.mock.analysisLoads.map((load) => load.id), [firstEntry.summary.id, secondEntry.summary.id, firstEntry.summary.id])
    assert.deepEqual(h.mock.scans, [], 'opening saved analyses never rescans their project')
  } finally { await cleanupAndUnmount(h) }
})

test('late analysis A load cannot replace the analysis B selected afterward', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const resultA = makeResult(pathA, { sections: [{ id: 'a', title: 'A', questions: [{ id: 'qa', question: 'FULL_QUESTION_A', answer: 'A', followUps: [] }] }] })
  const resultB = makeResult(pathB, { sections: [{ id: 'b', title: 'B', questions: [{ id: 'qb', question: 'FULL_QUESTION_B', answer: 'B', followUps: [] }] }] })
  const entryA = makeAnalysis(pathA, resultA)
  const entryB = makeAnalysis(pathB, resultB)
  const h = await mountApp({ recent: [pathA, pathB].map((projectPath) => ({ path: projectPath, name: projectPath.split('\\').at(-1), lastUsedAt: '2026-10-10T00:00:00.000Z' })) })
  const pendingA = h.mock.delayAnalysisLoad(pathA, entryA.summary.id)
  try {
    h.mock.setAnalyses(pathA, [entryA])
    h.mock.setAnalyses(pathB, [entryB])
    const rowsA = await recentAnalysisRows(h, pathA)
    await act(h, () => rowsA[0].click())
    assert.ok(h.host.textContent.includes('选择一个项目，我们开始分析'), 'A remains pending on the project entry page')
    await viewRecentResult(h, pathB, entryB.summary.id)
    assert.ok(h.host.textContent.includes('FULL_QUESTION_B'))
    pendingA.resolve()
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('FULL_QUESTION_B'), 'late A completion cannot replace B')
    assert.ok(!h.host.textContent.includes('FULL_QUESTION_A'))
    assert.deepEqual(h.mock.scans, [])
    await clickHistoryButton(h, 'back')
    assert.ok(h.host.textContent.includes('选择一个项目，我们开始分析'), 'late A did not add a history entry')
    await clickHistoryButton(h, 'forward')
    assert.ok(h.host.textContent.includes('FULL_QUESTION_B'), 'forward returns to the successful B entry')
  } finally { await cleanupAndUnmount(h) }
})

test('failed analysis loading shows an error without adding a navigable page', async () => {
  const projectPath = 'C:\\ProjectA'
  const result = makeResult(projectPath, {
    sections: [{ id: 'a', title: 'A', questions: [{ id: 'qa', question: 'FAILED_ANALYSIS', answer: 'A', followUps: [] }] }]
  })
  const entry = makeAnalysis(projectPath, result)
  const h = await mountApp({ recent: [{ path: projectPath, name: 'ProjectA', lastUsedAt: result.createdAt }] })
  try {
    h.mock.setAnalyses(projectPath, [entry])
    await recentAnalysisRows(h, projectPath)
    h.mock.failNextAnalysisLoad(projectPath, new Error('storage unavailable'), entry.summary.id)
    const row = [...h.host.querySelectorAll('button[data-analysis-id]')]
      .find((item) => item.getAttribute('data-analysis-id') === entry.summary.id)
    assert.ok(row)
    await act(h, () => row.click())
    assert.ok(h.host.textContent.includes('打开分析记录失败'))
    assert.ok(h.host.textContent.includes('选择一个项目，我们开始分析'))
    assert.equal(buttonByLabel(h.host, '上一步')?.disabled, true)
    assert.equal(buttonByLabel(h.host, '下一步')?.disabled, true)
    assert.deepEqual(h.mock.scans, [], 'failed analysis loads do not scan a project')
  } finally { await cleanupAndUnmount(h) }
})

test('background generation refreshes project history without replacing the selected analysis', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const resultA = makeResult(pathA, { sections: [{ id: 'a', title: 'A', questions: [{ id: 'qa', question: 'FOREGROUND_HISTORY_A', answer: 'A', followUps: [] }] }] })
  const h = await mountApp({ recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: resultA.createdAt }], savedResults: new Map([[pathA, resultA]]) })
  try {
    await viewRecentResult(h, pathA)
    await showProjectDirectory(h)
    await openProject(h, pathB)
    const request = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await viewRecentResult(h, pathA)
    const resultB = makeResult(pathB, { createdAt: '2026-10-17T07:10:00.000Z', granularity: 'medium', roleFocus: 'frontend' })
    await act(h, () => request.resolve({ runId: request.request.runId, result: resultB }))
    assert.ok(h.host.textContent.includes('FOREGROUND_HISTORY_A'), 'background success leaves the selected analysis visible')
    await showProjectDirectory(h)
    const rowsB = await recentAnalysisRows(h, pathB)
    assert.ok(rowsB.length > 0, 'background success refreshes project B history')
    assert.deepEqual(h.mock.scans, [pathB], 'only opening the new project scans')
  } finally { await cleanupAndUnmount(h) }
})

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
      assert.equal((await recentAnalysisRows(h, projectPath)).length, 0, 'invalid latest history is not offered as a selectable analysis')
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
    assert.ok(h.host.textContent.includes('选择一个项目，我们开始分析'), 'unexpected storage failure leaves the app on project selection')
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
    await beginOpenProject(h, pathA)
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

test('saved generation draft is passive until resumed and continuation uses its original options and a fresh run id', async () => {
  const projectPath = 'C:\\ProjectDraft'
  const draft = {
    id: 'draft-123', projectPath, projectName: 'ProjectDraft', granularity: 'fine', roleFocus: 'backend',
    profileId: 'profile-1', modelLabel: 'mock-model', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:01:00.000Z',
    completedBatches: 2, completedQuestions: 8, totalBatches: 5, ready: true
  }
  const h = await mountApp({ generationDrafts: new Map([[projectPath, draft]]) })
  try {
    await openProject(h, projectPath)
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('可继续的生成任务'))
    assert.ok(h.host.textContent.includes('已保存 2/5 个完整批次 · 8 道题 · 原模型：mock-model'))
    assert.equal(h.mock.requests.length, 0, 'checking a draft does not call the model')
    await act(h, () => button(h.host, '继续生成').click())
    assert.equal(h.mock.requests.length, 1)
    const request = h.mock.requests[0].request
    assert.equal(request.resumeDraftId, draft.id)
    assert.notEqual(request.runId, draft.id)
    assert.match(request.runId, /^[0-9a-f-]{36}$/i)
    assert.deepEqual({ projectPath: request.projectPath, granularity: request.granularity, roleFocus: request.roleFocus, profileId: request.profileId }, {
      projectPath, granularity: draft.granularity, roleFocus: draft.roleFocus, profileId: draft.profileId
    })
  } finally { await unmount(h) }
})

test('draft read failure can be retried and discarding sends only the selected project path and draft id', async () => {
  const projectPath = 'C:\\ProjectDraft'
  const draft = {
    id: 'draft-discard', projectPath, projectName: 'ProjectDraft', granularity: 'medium', roleFocus: 'general',
    profileId: 'profile-1', modelLabel: 'mock-model', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:01:00.000Z',
    completedBatches: 1, completedQuestions: 4, totalBatches: 3, ready: true
  }
  const h = await mountApp({ generationDrafts: new Map([[projectPath, draft]]), generationDraftFailures: new Map([[projectPath, [new Error('temporary read failure')]]]) })
  try {
    await openProject(h, projectPath)
    assert.ok(h.host.textContent.includes('读取生成草稿失败'))
    const start = button(h.host, '开始生成面试题')
    assert.equal(start.disabled, true, 'starting is blocked while draft state is unknown')
    await act(h, () => button(h.host, '重试读取').click())
    assert.ok(h.host.textContent.includes('可继续的生成任务'))
    await act(h, () => button(h.host, '丢弃草稿').click())
    assert.deepEqual(h.mock.draftDiscards, [{ projectPath, draftId: draft.id }])
    assert.equal(h.mock.requests.length, 0, 'discarding a draft does not start a generation')
    assert.equal(h.mock.deletions.length, 0, 'discarding a draft does not delete analysis history')
    assert.ok(!h.host.textContent.includes('可继续的生成任务'))
    assert.equal(button(h.host, '开始生成面试题').disabled, false)
  } finally { await unmount(h) }
})

async function leaveGenerationToSelect(harness) {
  await clickHistoryButton(harness, 'back')
  assert.ok(harness.host.textContent.includes('仍在生成'), '离页时应要求选择生成任务处理方式')
  await act(harness, () => button(harness.host, '后台继续').click())
  // Back leaves generation for its configuration page. Continue through the
  // actual visited pages to preserve this helper's entry-page setup contract.
  for (let step = 0; step < 20 && !harness.host.textContent.includes('选择一个项目，我们开始分析'); step++) {
    await clickHistoryButton(harness, 'back')
  }
  assert.ok(harness.host.textContent.includes('选择一个项目，我们开始分析'), '后台继续后应回到项目入口页')
}

function termButton(host, term) {
  return [...host.querySelectorAll('.term-link')].find((item) => item.textContent.trim() === term)
}

async function pressEnter(harness, element) {
  assert.ok(element, 'keyboard target should exist')
  element.focus()
  await act(harness, () => element.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}

async function simulatedKeyboardButton(harness, element) {
  assert.ok(element, 'button target should exist')
  element.focus()
  // JSDOM does not implement Chromium's default keyboard activation. click() models that
  // activation for this renderer-only regression; native default activation is covered below.
  await act(harness, () => element.click())
}

async function mouseActivate(harness, element) {
  assert.ok(element, 'mouse target should exist')
  await act(harness, () => {
    element.dispatchEvent(new harness.dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.click()
  })
}

test('mouse navigation from history A to completed background B also cancels A explain', async () => {
  const pathA = 'C:\\MouseA'
  const pathB = 'C:\\MouseB'
  const resultA = makeResult(pathA, {
    profileId: 'profile-A', sections: [{ id: 'a', title: 'A', questions: [{ id: 'qa', question: 'QUESTION_A [[TERM_A]]', answer: 'ANSWER_A TERM_A context', followUps: [] }] }],
    glossary: { TERM_A: 'GLOSSARY_A' }
  })
  const resultB = makeResult(pathB)
  const h = await mountApp({
    recent: [{ path: pathA, name: 'MouseA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, resultA]]),
    profiles: [
      { id: 'profile-A', name: 'Profile A', baseUrl: 'https://a.example.test/v1', apiKey: '', model: 'model-a' },
      { id: 'profile-B', name: 'Profile B', baseUrl: 'https://b.example.test/v1', apiKey: '', model: 'model-b' }
    ], defaultProfileId: 'profile-B'
  })
  try {
    await openProject(h, pathB)
    const requestB = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await act(h, () => requestB.resolve({ runId: requestB.request.runId, result: resultB }))
    await viewRecentResult(h, pathA)
    await act(h, () => termButton(h.host, 'TERM_A').click())
    await askSelectedTerm(h, 'TERM_A')
    const pendingA = h.mock.explainRequests.at(-1)
    await mouseActivate(h, button(h.host, '后台生成'))
    await mouseActivate(h, button(h.host, '查看结果'))
    assert.deepEqual(h.mock.explainCancellations, [pendingA.request.requestId])
    assert.ok(h.host.textContent.includes('MouseB · 面试题'))
    assert.equal(h.dom.window.document.body.querySelector('.z-50'), null)
  } finally { await cleanupAndUnmount(h) }
})

test('viewing B from the background task panel disposes A term context and ignores late A events', async () => {
  const pathA = 'C:\\ProjectA'
  const pathB = 'C:\\ProjectB'
  const resultA = makeResult(pathA, {
    profileId: 'profile-A', projectSummary: 'SUMMARY_A',
    sections: [{ id: 's1', title: 'A section', questions: [{ id: 'qa', question: 'QUESTION_A [[TERM_A]]', answer: 'ANSWER_A TERM_A context', followUps: [] }] }],
    glossary: { TERM_A: 'GLOSSARY_A' }
  })
  const resultB = makeResult(pathB, {
    profileId: 'profile-B', projectSummary: 'SUMMARY_B',
    sections: [{ id: 's1', title: 'B section', questions: [{ id: 'qb', question: 'QUESTION_B [[TERM_B]]', answer: 'ANSWER_B TERM_B context', followUps: [] }] }],
    glossary: { TERM_B: 'GLOSSARY_B' }
  })
  const h = await mountApp({
    recent: [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    savedResults: new Map([[pathA, resultA]]),
    profiles: [
      { id: 'profile-A', name: 'Profile A', baseUrl: 'https://a.example.test/v1', apiKey: '', model: 'model-a' },
      { id: 'profile-B', name: 'Profile B', baseUrl: 'https://b.example.test/v1', apiKey: '', model: 'model-b' }
    ], defaultProfileId: 'profile-B'
  })
  try {
    await openProject(h, pathB)
    const requestB = await startGeneration(h)
    await leaveGenerationToSelect(h)
    await act(h, () => requestB.resolve({ runId: requestB.request.runId, result: resultB }))
    await viewRecentResult(h, pathA)
    assert.ok(h.host.textContent.includes('ProjectA · 面试题'))

    await pressEnter(h, termButton(h.host, 'TERM_A'))
    assert.ok(h.dom.window.document.body.textContent.includes('术语表'))
    assert.equal(h.mock.explainRequests.length, 0)
    await askSelectedTerm(h, 'TERM_A')
    const pendingA = h.mock.explainRequests.at(-1)
    assert.ok(pendingA, 'explicit Ask starts the selected-text explanation')
    assert.deepEqual({ ...pendingA.request, requestId: '<uuid>', snippet: '<context>' }, {
      term: 'TERM_A', profileId: 'profile-A', projectSummary: 'SUMMARY_A',
      question: 'QUESTION_A TERM_A', snippet: '<context>', glossaryHint: '', requestId: '<uuid>'
    })

    await simulatedKeyboardButton(h, button(h.host, '后台生成'))
    await simulatedKeyboardButton(h, button(h.host, '查看结果'))
    assert.ok(h.host.textContent.includes('ProjectB · 面试题'))
    assert.equal(h.dom.window.document.body.querySelector('.z-50'), null)
    assert.deepEqual(h.mock.explainCancellations, [pendingA.request.requestId], 'old A stream must be cancelled exactly once by its own UUID')

    await pressEnter(h, termButton(h.host, 'TERM_B'))
    await askSelectedTerm(h, 'TERM_B')
    const pendingB = h.mock.explainRequests.at(-1)
    assert.ok(pendingB)
    h.mock.emitExplainDelta(pendingB, 'B explanation prefix')
    await act(h, () => {})
    h.mock.emitExplainDelta(pendingA, 'LATE_A_DELTA')
    h.mock.emitExplainDone(pendingA)
    h.mock.emitExplainError(pendingA, 'LATE_A_ERROR')
    await act(h, () => {})
    assert.ok(h.dom.window.document.body.textContent.includes('B explanation prefix'))
    assert.ok(h.dom.window.document.body.textContent.includes('AI 解释（生成中…）'), 'late A delta/done/error must leave B streaming')
    assert.ok(!h.dom.window.document.body.textContent.includes('LATE_A_'))
    assert.deepEqual({ ...pendingB.request, requestId: '<uuid>', snippet: '<context>' }, {
      term: 'TERM_B', profileId: 'profile-B', projectSummary: 'SUMMARY_B',
      question: 'QUESTION_B TERM_B', snippet: '<context>', glossaryHint: '', requestId: '<uuid>'
    })
  } finally { await cleanupAndUnmount(h) }
})

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
    await act(h, () => buttonByLabel(h.host, '设置').click())
    assert.ok(h.host.textContent.includes('大模型配置'))
    await act(h, () => requestA.resolve({ runId: requestA.request.runId, result: makeResult(requestA.request.projectPath) }))
    assert.ok(h.host.textContent.includes('大模型配置'), '后台完成不能覆盖设置页或自动导航')
    await clickHistoryButton(h, 'back')
    assert.ok(h.host.textContent.includes('选择一个项目，我们开始分析'), '从设置返回项目入口页')
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
      button(h.host, '新建').click()
    })
    assert.ok(h.host.textContent.includes('选择一个项目，我们开始分析'), 'B scan should still be waiting on loadResult')
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
    assert.ok((await recentAnalysisRows(h, 'C:\\ProjectB')).length > 0, 'B should have its own saved history in the project sidebar')
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
    assert.ok((await recentAnalysisRows(h, 'C:\\ProjectA')).length > 0, 'A saved history must be restored')
    await viewRecentResult(h, 'C:\\ProjectA')
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
    await clickHistoryButton(h, 'back')
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
    await showProjectDirectory(h)
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
    assert.equal((await recentAnalysisRows(h, newPath)).length, 0, 'the old A result must not be attached to the relocated root')

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
    assert.ok(success.host.textContent.includes('选择一个项目，我们开始分析'))
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
    assert.equal((await recentAnalysisRows(h, newPath)).length, 0, 'a scan failure keeps old project history detached from the relocated root')
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
      await showProjectDirectory(h)
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
      await showProjectDirectory(h)
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
    await act(h, () => buttonByLabel(h.host, '设置').click())
    assert.ok(h.host.textContent.includes('大模型配置'))
    delayed.resolve()
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('大模型配置'), 'late history scan must not steal settings navigation')
    assert.equal(h.mock.loads.filter((item) => item === pathA).length, 0, 'stale scan must not continue into loadResult')
    await clickHistoryButton(h, 'back')
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
    loadFailures: new Map([[invalidPath, new Error('历史结果文件已损坏，原文件已保留。可恢复备份或重新生成。')]]),
    storageDiagnostics: [{
      id: `result:${'c'.repeat(40)}`, kind: 'result', problem: 'corrupt',
      usingBackup: false, canRecover: false, projectPath: invalidPath
    }]
  })
  try {
    await act(h, () => {})
    assert.ok(h.host.textContent.includes('历史结果文件已损坏，原文件已保留。可恢复备份或重新生成。'))
    assert.ok((await recentAnalysisRows(h, validPath)).length > 0, 'valid neighbor keeps its history action available')
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

test('storage diagnostics show backup use and recovery failure can be retried without exposing filesystem errors', async () => {
  const projectPath = 'C:\\Private\\Demo'
  const diagnostic = {
    id: `result:${'a'.repeat(40)}`,
    kind: 'result',
    problem: 'corrupt',
    usingBackup: true,
    canRecover: true,
    projectPath
  }
  const secret = 'credential-marker-do-not-render'
  const h = await mountApp({
    recent: [{ path: projectPath, name: 'Demo', lastUsedAt: '2026-10-10T00:00:00.000Z' }],
    storageDiagnostics: [diagnostic],
    storageRecoveryFailures: new Map([[diagnostic.id, new Error(`EACCES C:\\private\\userData\\result.json apiKey=${secret}`)]])
  })
  try {
    assert.ok(h.host.textContent.includes('Demo'), 'result diagnostic should identify the authorized project by name')
    assert.ok(h.host.textContent.includes('历史结果文件已损坏'))
    assert.ok(h.host.textContent.includes('当前正在使用最近的完整备份'))
    await act(h, () => button(h.host, '恢复最近完整备份').click())
    assert.ok(h.host.textContent.includes('恢复失败，请重试；原文件和备份已保留。'))
    assert.ok(button(h.host, '重试恢复备份'), 'failed recovery should retain a retry action')
    assert.equal(h.host.textContent.includes(secret), false, 'filesystem errors and credentials must stay hidden')
    assert.equal(h.host.textContent.includes('userData'), false, 'storage paths must stay hidden')
    await act(h, () => button(h.host, '重试恢复备份').click())
    assert.deepEqual(h.mock.storageRecoveries, [diagnostic.id, diagnostic.id])
    assert.equal(h.host.textContent.includes('当前正在使用最近的完整备份'), false, 'successful recovery refreshes the diagnostic')
  } finally { await cleanupAndUnmount(h) }
})

test('a missing settings file with a usable backup shows its status and recovery action', async () => {
  const diagnostic = { id: 'settings', kind: 'settings', problem: 'missing', usingBackup: true, canRecover: true }
  const h = await mountApp({ storageDiagnostics: [diagnostic] })
  try {
    assert.ok(h.host.textContent.includes('缺失'), 'a missing primary with backup should be distinguishable from corruption')
    assert.ok(h.host.textContent.includes('当前正在使用最近的完整备份'))
    assert.ok(button(h.host, '恢复最近完整备份'))
    await act(h, () => button(h.host, '恢复最近完整备份').click())
    assert.deepEqual(h.mock.storageRecoveries, ['settings'])
  } finally { await cleanupAndUnmount(h) }
})

test('rapid repeated recovery clicks send only one restore request', async () => {
  const id = `result:${'c'.repeat(40)}`
  const projectPath = 'C:\\ProjectC'
  const h = await mountApp({
    storageDiagnostics: [{ id, kind: 'result', problem: 'corrupt', usingBackup: true, canRecover: true, projectPath }]
  })
  const pending = h.mock.delayStorageRecovery(id)
  try {
    await act(h, () => {
      const restore = button(h.host, '恢复最近完整备份')
      restore.click()
      restore.click()
    })
    assert.deepEqual(h.mock.storageRecoveries, [id], 'the same outstanding ID should be deduplicated before IPC')
    await act(h, () => pending.resolve())
    assert.deepEqual(h.mock.storageRecoveries, [id])
  } finally { await cleanupAndUnmount(h) }
})

test('late storage recovery cannot replace a project opened while restore is pending', async () => {
  const damagedPath = 'C:\\ProjectA'
  const nextPath = 'C:\\ProjectB'
  const id = `result:${'b'.repeat(40)}`
  const h = await mountApp({
    recent: [damagedPath, nextPath].map((projectPath) => ({
      path: projectPath, name: projectPath.split('\\').at(-1), lastUsedAt: '2026-10-10T00:00:00.000Z'
    })),
    storageDiagnostics: [{
      id, kind: 'result', problem: 'corrupt', usingBackup: true, canRecover: true, projectPath: damagedPath
    }]
  })
  const pending = h.mock.delayStorageRecovery(id)
  try {
    await act(h, () => button(h.host, '恢复最近完整备份').click())
    await openRecentProject(h, nextPath)
    await act(h, () => pending.resolve())
    assert.ok(h.host.textContent.includes(nextPath), 'recovery completion must leave the later project selection visible')
    assert.equal(h.host.textContent.includes('ProjectA · 面试题'), false, 'stale recovery must not navigate to the damaged result')
  } finally { await cleanupAndUnmount(h) }
})
