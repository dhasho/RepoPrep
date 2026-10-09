import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { randomUUID } from 'node:crypto'
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

async function createHarness({ scan = async () => ({ status: 'reused', scan: { name: 'demo' } }), generate } = {}) {
  const handlers = new Map()
  const appEvents = new Map()
  const windows = []
  const saves = []
  const recents = []
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
  const app = { isPackaged: true, whenReady: () => readyPromise, on: (name, listener) => appEvents.set(name, listener), quit() {} }
  const modules = {
    electron: { app, BrowserWindow: FakeWindow, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox() {} }, ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) }, session: { defaultSession: {} } },
    '@shared/ipc': { IPC },
    '@shared/types': {},
    './services/scan-cache': { ProjectScanCache: class { async getFresh(...args) { return scan(...args) } async refresh() { return { scan: { name: 'demo' } } } async invalidate() {} } },
    './services/generation-tasks': null,
    './services/generator': { generateInterview: (...args) => generate(...args), buildExplainMessages() {} },
    './services/llm': { chatCompletionStream: async () => {}, listModels: async () => ({}), testConnection: async () => ({}) },
    './services/exporter': { exportMarkdownDialog: async () => ({}) },
    './window-security': { getTrustedDevUrl: () => null, installPermissionDenials() {}, installWindowSecurity() {} },
    './services/store': { addRecentProject: (value) => recents.push(value), deleteResult() {}, getRecentProjects: () => [], getSettings: () => ({ profiles: [{ id: 'p' }], scanLimits: { maxFiles: 12 } }), loadResult: () => null, removeRecentProject: async () => {}, saveResult: (...args) => saves.push(args), saveSettings() {} },
    './services/ipc-authority': { AuthorizedProjectRegistry: class { registerRecent() {} registerSelected() {} removeRecent() {} requireAuthorized(value) { return value } } },
    './services/ipc-handler-guards': { ExplainAbortRegistry: class { begin() { return new AbortController() } finish() {} cancel() {} }, registerGuardedIpcHandler: (_ipc, channel, _deps, handler) => handlers.set(channel, handler) }
  }
  const requireModule = (id) => {
    if (id === 'node:path') return path
    if (id === 'node:url') return { fileURLToPath, pathToFileURL }
    if (id === 'node:crypto') return { randomUUID }
    if (!modules[id]) throw new Error(`unexpected require: ${id}`)
    return modules[id]
  }
  const taskModule = await loadTypescriptModule('electron/services/generation-tasks.ts', requireModule)
  modules['./services/generation-tasks'] = taskModule
  await loadTypescriptModule('electron/main.ts', requireModule, { BrowserWindow: FakeWindow })
  ready()
  await new Promise((resolve) => setImmediate(resolve))
  return { handlers, appEvents, windows, saves, recents, IPC }
}

const options = { projectPath: '/authorized/demo', granularity: 'coarse', roleFocus: 'general', profileId: 'p' }
const result = { projectName: 'demo' }

test('关闭窗口期间旧生成占槽，迟到的进度和结果都不能污染重开的窗口', async () => {
  const generation = deferred()
  let onProgress
  let calls = 0
  const harness = await createHarness({ generate: async (args) => {
    calls += 1
    if (calls === 1) { onProgress = args.onProgress; return generation.promise }
    args.onProgress('新任务进度', undefined, 25)
    return result
  } })
  const oldWindow = harness.windows[0]
  const pending = harness.handlers.get(harness.IPC.generateRun)({ sender: oldWindow.webContents }, options)
  await new Promise((resolve) => setImmediate(resolve))
  oldWindow.destroy()
  harness.appEvents.get('window-all-closed')()
  harness.appEvents.get('activate')()
  const newWindow = harness.windows[1]
  await assert.rejects(harness.handlers.get(harness.IPC.generateRun)({ sender: newWindow.webContents }, options), /已有生成任务在进行中/)
  const oldRunId = oldWindow.sent[0].payload.runId
  assert.equal(harness.saves.length, 0)
  assert.equal(harness.recents.length, 0)
  onProgress('上下文就绪', undefined, 70)
  assert.equal(newWindow.sent.length, 0)
  generation.resolve(result)
  await assert.rejects(pending, /已取消生成/)
  assert.equal(harness.saves.length, 0)
  assert.equal(await harness.handlers.get(harness.IPC.generateRun)({ sender: newWindow.webContents }, options), result)
  const progress = newWindow.sent.filter((event) => event.channel === harness.IPC.generateProgress)
  assert.equal(progress.length, 3)
  assert.equal(progress[0].payload.ts > 0, true)
  assert.equal(typeof progress[0].payload.runId, 'string')
  assert.notEqual(progress[0].payload.runId, oldRunId)
  assert.equal(progress[2].payload.step, '新任务进度')
  assert.equal(harness.saves.length, 1)
  assert.equal(harness.recents.length, 1)
})

test('普通取消后忽略迟到进度和结果，finally 释放任务槽位', async () => {
  const generation = deferred()
  let onProgress
  let calls = 0
  const harness = await createHarness({ generate: async (args) => {
    calls += 1
    if (calls === 1) { onProgress = args.onProgress; return generation.promise }
    args.onProgress('取消后重试', undefined, 20)
    return result
  } })
  const window = harness.windows[0]
  const sender = window.webContents
  const pending = harness.handlers.get(harness.IPC.generateRun)({ sender }, options)
  await new Promise((resolve) => setImmediate(resolve))
  const canceledRunId = window.sent[0].payload.runId
  harness.handlers.get(harness.IPC.generateCancel)({ sender })
  onProgress('迟到', undefined, 90)
  generation.resolve(result)
  await assert.rejects(pending, /已取消生成/)
  assert.equal(window.sent.some((event) => event.payload.step === '迟到'), false)
  assert.equal(harness.saves.length, 0)
  assert.equal(await harness.handlers.get(harness.IPC.generateRun)({ sender }, options), result)
  const retryProgress = window.sent.filter((event) => event.payload.step === '取消后重试')
  assert.equal(retryProgress.length, 1)
  assert.notEqual(retryProgress[0].payload.runId, canceledRunId)
})

test('扫描仍在等待时取消会丢弃迟到扫描，生成失败也由 finally 释放槽位', async () => {
  const scanWait = deferred()
  let scanCalls = 0
  let generateCalls = 0
  const harness = await createHarness({
    scan: async () => { scanCalls += 1; return scanCalls === 1 ? scanWait.promise : { status: 'reused', scan: { name: 'demo' } } },
    generate: async () => { generateCalls += 1; if (generateCalls === 1) throw new Error('model failure'); return result }
  })
  const sender = harness.windows[0].webContents
  const canceled = harness.handlers.get(harness.IPC.generateRun)({ sender }, options)
  await new Promise((resolve) => setImmediate(resolve))
  harness.handlers.get(harness.IPC.generateCancel)({ sender })
  scanWait.resolve({ status: 'reused', scan: { name: 'late' } })
  await assert.rejects(canceled, /已取消生成/)
  assert.equal(generateCalls, 0, '取消后的迟到扫描不会继续调用生成器')
  await assert.rejects(harness.handlers.get(harness.IPC.generateRun)({ sender }, options), /model failure/)
  assert.equal(await harness.handlers.get(harness.IPC.generateRun)({ sender }, options), result)
  assert.equal(harness.saves.length, 1)
})
