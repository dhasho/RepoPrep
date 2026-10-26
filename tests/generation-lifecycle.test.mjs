import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { createHash, randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function loadTypescriptModule(filename, requireModule, context = {}) {
  const source = await readFile(path.join(root, filename), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const sandbox = { module, exports: module.exports, require: requireModule, __dirname: path.dirname(path.join(root, filename)), __filename: path.join(root, filename), console, AbortController, process: { on() {}, platform: 'darwin', env: {} }, ...context }
  vm.runInNewContext(`(function(exports, require, module, __filename, __dirname) { ${js}\n})`, sandbox)(module.exports, requireModule, module, sandbox.__filename, sandbox.__dirname)
  return module.exports
}

async function createHarness({ scan = async () => ({ status: 'reused', scan: { name: 'demo' } }), generate, isPackaged = true, storedResult = null } = {}) {
  const handlers = new Map()
  const appEvents = new Map()
  const windows = []
  const saves = []
  const recents = []
  const drafts = new Map()
  const userDataPaths = []
  let ready
  const readyPromise = new Promise((resolve) => { ready = resolve })
  class FakeWindow {
    constructor() {
      this.events = new Map()
      this.destroyed = false
      this.sent = []
      this.webContents = {
        on: () => {}, send: (channel, payload) => this.sent.push({ channel, payload }),
        isDestroyed: () => this.destroyed, getURL: () => 'file:///renderer/index.html',
        mainFrame: {}
      }
      windows.push(this)
    }
    on(name, listener) { this.events.set(name, listener) }
    show() {}
    loadURL() { return Promise.resolve() }
    destroy() { this.destroyed = true }
    static getAllWindows() { return windows.filter((window) => !window.destroyed) }
    static fromWebContents(contents) { return windows.find((window) => window.webContents === contents) ?? null }
  }
  const app = {
    isPackaged,
    getPath: (name) => name === 'appData' ? path.join(path.parse(root).root, 'AppData', 'Roaming') : null,
    setPath: (name, value) => userDataPaths.push([name, value]),
    whenReady: () => readyPromise,
    on: (name, listener) => appEvents.set(name, listener),
    quit() {}
  }
  const modules = {
    electron: { app, BrowserWindow: FakeWindow, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox() {} }, ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) }, session: { defaultSession: {} } },
    '@shared/ipc': { IPC },
    '@shared/generation-checkpoint': { GENERATION_DRAFT_MESSAGES: {
      exists: '存在可恢复的生成任务，请继续或先丢弃该任务。', missing: '未找到此生成草稿，请重新打开项目。',
      changed: '项目上下文或模型配置已变化，无法继续原任务。请丢弃草稿后重新生成。',
      corrupt: '生成草稿损坏或版本不兼容，请丢弃后重新生成。', unreadable: '无法读取生成草稿，请检查应用数据目录权限。',
      save: '无法保存生成检查点，请检查磁盘空间和权限后重试。', discard: '无法丢弃生成草稿，请稍后重试。'
    } },
    '@shared/types': {},
    './services/scan-cache': { ProjectScanCache: class { async getFresh(...args) { return scan(...args) } async refresh() { return { scan: { name: 'demo' } } } async invalidate() {} } },
    './services/generation-tasks': null,
    './services/generation-drafts': {
      readGenerationDraft: (projectPath) => drafts.get(projectPath) ?? null,
      beginGenerationDraft: (projectPath, meta) => {
        if (drafts.has(projectPath)) throw new Error('存在可恢复的生成任务，请继续或先丢弃该任务。')
        const record = { version: 1, summary: { ...meta, projectPath, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedBatches: 0, completedQuestions: 0, totalBatches: 1, ready: false }, checkpoint: { version: 1, fingerprint: 'synthetic', totalBatches: 1, entries: [] } }
        drafts.set(projectPath, record)
        return record
      },
      saveGenerationDraft: (projectPath, _id, state) => { drafts.get(projectPath).checkpoint = state },
      completeGenerationDraft: (projectPath, _id, value) => { const draft = drafts.get(projectPath); draft.result = value; draft.summary.ready = true },
      removeGenerationDraft: (projectPath, id) => {
        if (id === null || drafts.get(projectPath)?.summary.id === id) drafts.delete(projectPath)
      }
    },
    './services/generator': { generateInterview: (...args) => generate(...args), buildExplainMessages() {} },
    './services/llm': { chatCompletionStream: async () => {}, isLlmTimeoutError: () => false, listModels: async () => ({}), testConnection: async () => ({}) },
    './services/exporter': { exportMarkdownDialog: async () => ({}) },
    './window-security': { getTrustedDevUrl: () => null, installPermissionDenials() {}, installWindowSecurity() {} },
    './services/store': { addRecentProject: (value) => recents.push(value), deleteResult() {}, getPrivateProfile: async (id) => ({ id, name: 'Mock', baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic', model: 'mock' }), getRecentProjects: () => [], getSettings: async () => ({ profiles: [], defaultProfileId: null, scanLimits: { maxFiles: 12 } }), loadResult: () => storedResult, removeRecentProject: async () => {}, saveResult: (...args) => saves.push(args), saveSettings() {} },
    './services/ipc-authority': { AuthorizedProjectRegistry: class { registerRecent() {} registerSelected() {} removeRecent() {} requireAuthorized(value) { return value } } },
    './services/ipc-handler-guards': { ExplainAbortRegistry: class { begin() { return new AbortController() } finish() {} cancel() {} }, registerGuardedIpcHandler: (_ipc, channel, _deps, handler) => handlers.set(channel, handler) }
  }
  const requireModule = (id) => {
    if (id === 'node:path') return path
    if (id === 'node:fs') return { mkdirSync() {} }
    if (id === 'node:url') return { fileURLToPath, pathToFileURL }
    if (id === 'node:crypto') return { randomUUID, createHash }
    if (!modules[id]) throw new Error(`unexpected require: ${id}`)
    return modules[id]
  }
  const taskModule = await loadTypescriptModule('electron/services/generation-tasks.ts', requireModule)
  modules['./services/generation-tasks'] = taskModule
  await loadTypescriptModule('electron/main.ts', requireModule, { BrowserWindow: FakeWindow })
  ready()
  await new Promise((resolve) => setImmediate(resolve))
  return { handlers, appEvents, windows, saves, recents, userDataPaths, drafts, IPC }
}

const options = { projectPath: '/authorized/demo', granularity: 'coarse', roleFocus: 'general', profileId: 'p' }
const result = { projectName: 'demo' }
const request = (runId) => ({ ...options, runId })

test('启动时继续使用重命名前的 userData 目录名称', async () => {
  for (const [isPackaged, legacyName] of [[true, 'ProjectLens'], [false, 'projectlens']]) {
    const harness = await createHarness({ isPackaged })
    assert.deepEqual(harness.userDataPaths, [[
      'userData',
      path.join(path.parse(root).root, 'AppData', 'Roaming', legacyName)
    ]])
  }
})

test('关闭窗口期间旧生成占槽，迟到的进度和结果都不能污染重开的窗口', async () => {
  const generation = deferred()
  let onProgress
  let calls = 0
  const firstRunId = randomUUID().toUpperCase()
  const nextRunId = randomUUID().toUpperCase()
  const canonicalNextRunId = nextRunId.toLowerCase()
  const harness = await createHarness({ generate: async (args) => {
    calls += 1
    if (calls === 1) { onProgress = args.onProgress; return generation.promise }
    args.onProgress('新任务进度', undefined, 25)
    return result
  } })
  const oldWindow = harness.windows[0]
  const pending = harness.handlers.get(harness.IPC.generateRun)({ sender: oldWindow.webContents }, request(firstRunId))
  await new Promise((resolve) => setImmediate(resolve))
  oldWindow.destroy()
  harness.appEvents.get('window-all-closed')()
  harness.appEvents.get('activate')()
  const newWindow = harness.windows[1]
  await assert.rejects(harness.handlers.get(harness.IPC.generateRun)({ sender: newWindow.webContents }, request(randomUUID())), /已有生成任务在进行中/)
  const oldRunId = oldWindow.sent[0].payload.runId
  assert.equal(oldRunId, firstRunId.toLowerCase(), '大小写不同的 UUID 应统一为规范小写 runId')
  assert.equal(harness.saves.length, 0)
  assert.equal(harness.recents.length, 0)
  onProgress('上下文就绪', undefined, 70)
  assert.equal(newWindow.sent.length, 0)
  generation.resolve(result)
  await assert.rejects(pending, /已取消生成/)
  assert.equal(harness.saves.length, 0)
  const oldDraft = await harness.handlers.get(harness.IPC.generationDraftGet)({ sender: oldWindow.webContents }, options.projectPath)
  await harness.handlers.get(harness.IPC.generationDraftDiscard)({ sender: oldWindow.webContents }, options.projectPath, oldDraft.id)
  const response = await harness.handlers.get(harness.IPC.generateRun)({ sender: newWindow.webContents }, request(nextRunId))
  assert.equal(response.runId, canonicalNextRunId)
  assert.equal(response.result, result)
  const progress = newWindow.sent.filter((event) => event.channel === harness.IPC.generateProgress)
  assert.equal(progress.length, 3)
  assert.equal(progress[0].payload.ts > 0, true)
  assert.equal(typeof progress[0].payload.runId, 'string')
  assert.equal(progress[0].payload.runId, canonicalNextRunId)
  assert.equal(progress[2].payload.runId, canonicalNextRunId)
  assert.equal(progress[2].payload.step, '新任务进度')
  assert.equal(harness.saves.length, 1)
  assert.equal(harness.recents.length, 1)
})

test('普通取消后忽略迟到进度和结果，finally 释放任务槽位', async () => {
  const generation = deferred()
  let onProgress
  let calls = 0
  let activeSignal
  const canceledRunId = randomUUID()
  const retryRunId = randomUUID()
  const harness = await createHarness({ generate: async (args) => {
    calls += 1
    activeSignal = args.signal
    if (calls === 1) { onProgress = args.onProgress; return generation.promise }
    args.onProgress('取消后重试', undefined, 20)
    return result
  } })
  const window = harness.windows[0]
  const sender = window.webContents
  const pending = harness.handlers.get(harness.IPC.generateRun)({ sender }, request(canceledRunId))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(window.sent[0].payload.runId, canceledRunId)
  harness.handlers.get(harness.IPC.generateCancel)({ sender }, retryRunId)
  assert.equal(activeSignal.aborted, false, '错 runId 的取消不应中止当前任务')
  harness.handlers.get(harness.IPC.generateCancel)({ sender }, canceledRunId.toUpperCase())
  assert.equal(activeSignal.aborted, true, 'runId 大小写差异仍应取消同一任务')
  onProgress('迟到', undefined, 90)
  generation.resolve(result)
  await assert.rejects(pending, /已取消生成/)
  assert.equal(window.sent.some((event) => event.payload.step === '迟到'), false)
  assert.equal(harness.saves.length, 0)
  assert.equal(harness.drafts.has(options.projectPath), true, 'cancelled generation keeps its recovery draft')
  const draft = await harness.handlers.get(harness.IPC.generationDraftGet)({ sender }, options.projectPath)
  await harness.handlers.get(harness.IPC.generationDraftDiscard)({ sender }, options.projectPath, draft.id)
  const response = await harness.handlers.get(harness.IPC.generateRun)({ sender }, request(retryRunId))
  assert.equal(response.runId, retryRunId)
  assert.equal(response.result, result)
  const retryProgress = window.sent.filter((event) => event.payload.step === '取消后重试')
  assert.equal(retryProgress.length, 1)
  assert.equal(retryProgress[0].payload.runId, retryRunId)
})

test('扫描仍在等待时取消会丢弃迟到扫描，生成失败也由 finally 释放槽位', async () => {
  const scanWait = deferred()
  let scanCalls = 0
  let generateCalls = 0
  const canceledRunId = randomUUID()
  const failureRunId = randomUUID()
  const successRunId = randomUUID()
  const harness = await createHarness({
    scan: async () => { scanCalls += 1; return scanCalls === 1 ? scanWait.promise : { status: 'reused', scan: { name: 'demo' } } },
    generate: async () => { generateCalls += 1; if (generateCalls === 1) throw new Error('model failure'); return result }
  })
  const sender = harness.windows[0].webContents
  const canceled = harness.handlers.get(harness.IPC.generateRun)({ sender }, request(canceledRunId))
  await new Promise((resolve) => setImmediate(resolve))
  harness.handlers.get(harness.IPC.generateCancel)({ sender }, canceledRunId)
  scanWait.resolve({ status: 'reused', scan: { name: 'late' } })
  await assert.rejects(canceled, /已取消生成/)
  assert.equal(generateCalls, 0, '取消后的迟到扫描不会继续调用生成器')
  await assert.rejects(harness.handlers.get(harness.IPC.generateRun)({ sender }, request(failureRunId)), /model failure/)
  assert.equal(harness.drafts.has(options.projectPath), true, 'model failure keeps its recovery draft')
  const failedDraft = await harness.handlers.get(harness.IPC.generationDraftGet)({ sender }, options.projectPath)
  await harness.handlers.get(harness.IPC.generationDraftDiscard)({ sender }, options.projectPath, failedDraft.id)
  const response = await harness.handlers.get(harness.IPC.generateRun)({ sender }, request(successRunId))
  assert.equal(response.runId, successRunId)
  assert.equal(response.result, result)
  assert.equal(harness.saves.length, 1)
})

test('草稿 IPC 只返回摘要、按精确 ID 丢弃，并在任务活动时拒绝丢弃', async () => {
  const generation = deferred()
  const harness = await createHarness({ generate: async () => generation.promise })
  const sender = harness.windows[0].webContents
  assert.equal(await harness.handlers.get(harness.IPC.generationDraftGet)({ sender }, options.projectPath), null)
  const pending = harness.handlers.get(harness.IPC.generateRun)({ sender }, request(randomUUID()))
  await new Promise((resolve) => setImmediate(resolve))
  const summary = await harness.handlers.get(harness.IPC.generationDraftGet)({ sender }, options.projectPath)
  assert.equal(summary.projectPath, options.projectPath)
  assert.equal(Object.hasOwn(summary, 'checkpoint'), false)
  assert.equal(Object.hasOwn(summary, 'result'), false)
  await assert.rejects(Promise.resolve().then(() =>
    harness.handlers.get(harness.IPC.generationDraftDiscard)({ sender }, options.projectPath, summary.id)
  ), /已有生成任务在进行中/)
  generation.reject(new Error('synthetic model failure'))
  await assert.rejects(pending, /synthetic model failure/)
  await assert.rejects(Promise.resolve().then(() =>
    harness.handlers.get(harness.IPC.generationDraftDiscard)({ sender }, options.projectPath, randomUUID())
  ), /未找到此生成草稿/)
  await harness.handlers.get(harness.IPC.generationDraftDiscard)({ sender }, options.projectPath, summary.id)
  assert.equal(await harness.handlers.get(harness.IPC.generationDraftGet)({ sender }, options.projectPath), null)
  harness.drafts.set(options.projectPath, { corrupt: true })
  await harness.handlers.get(harness.IPC.generationDraftDiscard)({ sender }, options.projectPath, null)
  assert.equal(harness.drafts.has(options.projectPath), false, 'null ID delegates corrupt-draft removal without resolving a valid draft ID')
})

test('ready 草稿重试只幂等保存已有结果，不再次调用 generator', async () => {
  let calls = 0
  const harness = await createHarness({ generate: async () => { calls += 1; return result } })
  const draftId = randomUUID()
  const readyResult = { projectName: 'demo', projectPath: options.projectPath, sections: [] }
  harness.drafts.set(options.projectPath, {
    version: 1,
    summary: { ...options, id: draftId, projectName: 'demo', modelLabel: 'mock', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedBatches: 1, completedQuestions: 0, totalBatches: 1, ready: true },
    checkpoint: null,
    result: readyResult
  })
  const response = await harness.handlers.get(harness.IPC.generateRun)({ sender: harness.windows[0].webContents }, { ...request(randomUUID()), resumeDraftId: draftId })
  assert.equal(response.result, readyResult)
  assert.equal(calls, 0)
  assert.equal(harness.saves.length, 1)
  assert.equal(harness.recents.length, 1)
  assert.equal(harness.drafts.has(options.projectPath), false)
})

test('crash after publication reuses the already-saved report without another write or history archive', async () => {
  const readyResult = { projectName: 'demo', projectPath: options.projectPath, sections: [] }
  let generationCalls = 0
  const harness = await createHarness({ storedResult: readyResult, generate: async () => { generationCalls++; return result } })
  const draftId = randomUUID()
  harness.drafts.set(options.projectPath, {
    version: 1,
    summary: { ...options, id: draftId, projectName: 'demo', modelLabel: 'mock', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedBatches: 1, completedQuestions: 0, totalBatches: 1, ready: true },
    checkpoint: null, result: readyResult
  })
  const response = await harness.handlers.get(harness.IPC.generateRun)({ sender: harness.windows[0].webContents }, { ...request(randomUUID()), resumeDraftId: draftId })
  assert.equal(generationCalls, 0)
  assert.equal(harness.saves.length, 0)
  assert.equal(response.analysisId, createHash('sha256').update(JSON.stringify(readyResult)).digest('hex'))
  assert.equal(harness.drafts.has(options.projectPath), false)
})
