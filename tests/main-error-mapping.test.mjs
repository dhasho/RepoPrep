import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc.ts'
import * as sharedTypes from '../shared/types.ts'
import { buildExplainMessages, generateInterview } from '../electron/services/generator.ts'
import { chatCompletionStream, isLlmTimeoutError, LlmRequestError } from '../electron/services/llm.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\authorized\\demo' : '/authorized/demo'
const GENERATION_TIMEOUT = '生成面试题时模型请求超时，请检查网络或稍后重试。'
const EXPLAIN_TIMEOUT = '名词解释请求超时，请检查网络或稍后重试。'
const GENERIC_ERROR = '请求处理失败，请稍后重试'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function loadTypescriptModule(filename, requireModule) {
  const fullPath = path.join(root, filename)
  const source = await readFile(fullPath, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const module = { exports: {} }
  const factory = vm.runInThisContext(
    `(function(exports, require, module, __filename, __dirname, process) { ${js}\n})`,
    { filename: fullPath }
  )
  factory(
    module.exports,
    requireModule,
    module,
    fullPath,
    path.dirname(fullPath),
    { on() {}, platform: process.platform, env: {} }
  )
  return module.exports
}

async function createHarness() {
  const handlers = new Map()
  const appEvents = new Map()
  const windows = []
  const saves = []
  const recents = []
  let ready
  const readyPromise = new Promise((resolve) => { ready = resolve })

  class FakeWindow {
    constructor() {
      this.destroyed = false
      this.sent = []
      this.webContents = {
        mainFrame: { url: 'about:blank' },
        on() {},
        send: (channel, payload) => this.sent.push({ channel, payload }),
        isDestroyed: () => this.destroyed,
        getURL: () => this.webContents.mainFrame.url
      }
      windows.push(this)
    }
    on() {}
    show() {}
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve() }
    destroy() { this.destroyed = true }
    static getAllWindows() { return windows.filter((window) => !window.destroyed) }
    static fromWebContents(contents) { return windows.find((window) => window.webContents === contents) ?? null }
  }

  const scan = {
    root: PROJECT_PATH, name: 'demo', totalFiles: 0, totalBytes: 0, languages: [],
    tree: { name: 'demo', path: '', type: 'dir', children: [] }, keyFiles: [], files: [],
    security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} }
  }
  let generateImpl = async () => ({ projectName: 'demo' })
  let streamImpl = async () => undefined
  const modules = new Map()
  const requireModule = (id) => {
    if (id === 'node:path') return path
    if (id === 'node:url') return { fileURLToPath, pathToFileURL }
    if (id === 'node:crypto') return { randomUUID }
    if (modules.has(id)) return modules.get(id)
    throw new Error(`unexpected require: ${id}`)
  }

  modules.set('@shared/ipc', { IPC })
  modules.set('@shared/types', sharedTypes)
  modules.set('../../shared/ipc.ts', { IPC })
  modules.set('../../shared/types.ts', sharedTypes)
  modules.set('./services/scan-cache', {
    ProjectScanCache: class {
      async getFresh() { return { status: 'reused', scan } }
      async refresh() { return { scan: { name: 'demo' } } }
      async invalidate() {}
    }
  })
  modules.set('./services/generator', {
    generateInterview: (...args) => generateImpl(...args),
    buildExplainMessages
  })
  modules.set('./services/llm', {
    chatCompletionStream: (...args) => streamImpl(...args),
    isLlmTimeoutError,
    listModels: async () => ({}),
    testConnection: async () => ({})
  })
  modules.set('./services/exporter', { exportMarkdownDialog: async () => ({}) })
  modules.set('./window-security', {
    getTrustedDevUrl: () => null,
    installPermissionDenials() {},
    installWindowSecurity() {}
  })
  modules.set('./services/store', {
    addRecentProject: (value) => recents.push(value),
    deleteResult() {},
    getRecentProjects: () => [{ path: PROJECT_PATH, name: 'demo', lastUsedAt: 'now' }],
    getSettings: () => ({ profiles: [{ id: 'p', name: 'Mock', baseUrl: 'https://provider.invalid/v1', apiKey: 'never-log-this', model: 'mock' }] }),
    loadResult: () => null,
    removeRecentProject: async () => {},
    saveResult: (...args) => saves.push(args),
    saveSettings() {}
  })

  const ipcAuthority = await loadTypescriptModule('electron/services/ipc-authority.ts', requireModule)
  modules.set('./services/ipc-authority', ipcAuthority)
  modules.set('./ipc-authority.ts', ipcAuthority)
  const ipcValidation = await loadTypescriptModule('electron/services/ipc-validation.ts', requireModule)
  modules.set('./services/ipc-validation.ts', ipcValidation)
  modules.set('./ipc-validation.ts', ipcValidation)
  const ipcGuards = await loadTypescriptModule('electron/services/ipc-handler-guards.ts', requireModule)
  modules.set('./services/ipc-handler-guards', ipcGuards)
  modules.set('./services/generation-tasks', await loadTypescriptModule('electron/services/generation-tasks.ts', requireModule))
  modules.set('electron', {
    app: {
      isPackaged: true,
      whenReady: () => readyPromise,
      on: (name, handler) => appEvents.set(name, handler),
      quit() {}
    },
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox() {} },
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    session: { defaultSession: {} }
  })

  await loadTypescriptModule('electron/main.ts', requireModule)
  ready()
  await new Promise((resolve) => setImmediate(resolve))
  const window = windows[0]
  const sender = window.webContents
  const invoke = (channel, ...args) => handlers.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args)

  return {
    handlers,
    windows,
    window,
    sender,
    invoke,
    saves,
    recents,
    TimeoutError: LlmRequestError,
    setGenerate: (implementation) => { generateImpl = implementation },
    setStream: (implementation) => { streamImpl = implementation }
  }
}

const options = { projectPath: PROJECT_PATH, granularity: 'coarse', roleFocus: 'general', profileId: 'p' }
const explainRequest = (requestId = randomUUID()) => ({
  requestId,
  term: '超时',
  profileId: 'p',
  projectSummary: 'demo',
  question: '怎样处理超时？',
  snippet: '模型请求片段'
})

test('trusted renderer reaches the exact generation-timeout business message through the real IPC guard', async () => {
  const h = await createHarness()
  let calls = 0
  h.setGenerate(async () => {
    calls++
    throw new h.TimeoutError('timeout', 'provider https://private.invalid?key=secret')
  })
  await assert.rejects(h.invoke(IPC.generateRun, options), (error) => error.message === GENERATION_TIMEOUT)
  assert.equal(calls, 1)
  assert.equal(h.saves.length, 0)

  const untrusted = { sender: h.sender, senderFrame: { url: h.sender.mainFrame.url } }
  await assert.rejects(h.handlers.get(IPC.generateRun)(untrusted, options), /请求无效或未获授权/)
  assert.equal(calls, 1, 'untrusted sender must be rejected before main handler execution')
})

test('compensation timeout from the real generator reaches the guard without saving partial success', async () => {
  const h = await createHarness()
  h.setGenerate(generateInterview)
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers = []
  let requests = 0
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback: () => callback(...args), delay }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = () => {}
  globalThis.fetch = async (_input, init) => {
    requests++
    if (requests === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        projectSummary: 'demo', sections: [{ title: 'Basic', questions: [
          { question: 'One question', answer: 'One answer', followUps: [] }
        ] }], glossary: {}
      }) } }] }))
    }
    const timer = timers.at(-1)
    assert.equal(timer.delay, 600_000)
    timer.callback()
    assert.equal(init.signal.aborted, true)
    throw new Error('mock transport stopped after deadline')
  }
  try {
    await assert.rejects(h.invoke(IPC.generateRun, options), (error) => error.message === GENERATION_TIMEOUT)
    assert.equal(requests, 2, 'an initial shortfall must reach the compensation request')
    assert.equal(h.saves.length, 0, 'a compensation deadline must not persist partial success')
    assert.equal(h.recents.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test('user cancellation takes priority over a timeout that settles after cancel', async () => {
  const h = await createHarness()
  const pending = deferred()
  let started
  const begun = new Promise((resolve) => { started = resolve })
  h.setGenerate(async () => { started(); return pending.promise })
  const generation = h.invoke(IPC.generateRun, options)
  await begun
  await h.invoke(IPC.generateCancel)
  pending.reject(new h.TimeoutError('timeout', 'timeout with secret'))
  await assert.rejects(generation, (error) => error.message === '已取消生成')
  assert.equal(h.saves.length, 0)
})

test('network AbortError and provider errors with secrets are sanitized as generic generation failures', async () => {
  const h = await createHarness()
  const abort = new Error('network abort at https://provider.invalid?key=secret')
  abort.name = 'AbortError'
  h.setGenerate(async () => { throw abort })
  await assert.rejects(h.invoke(IPC.generateRun, options), (error) => error.message === GENERIC_ERROR)

  h.setGenerate(async () => { throw new Error('provider rejected apiKey=secret at https://provider.invalid') })
  await assert.rejects(h.invoke(IPC.generateRun, options), (error) => {
    assert.equal(error.message, GENERIC_ERROR)
    assert.equal(error.message.includes('secret'), false)
    assert.equal(error.message.includes('provider.invalid'), false)
    return true
  })
})

test('explain timeout is an error event with a static message, while adjacent user cancellation remains cancelled', async () => {
  const h = await createHarness()
  h.setStream(async () => { throw new h.TimeoutError('timeout', 'timeout https://private.invalid?key=secret') })
  const timeoutId = randomUUID()
  await h.invoke(IPC.explainStart, explainRequest(timeoutId))
  let events = h.window.sent.filter((event) => event.channel === IPC.explainEvent).map((event) => event.payload)
  assert.deepEqual(events, [{ requestId: timeoutId, type: 'error', data: EXPLAIN_TIMEOUT }])

  h.window.sent.length = 0
  const pending = deferred()
  let signal
  let started
  const begun = new Promise((resolve) => { started = resolve })
  h.setStream(async (_profile, _messages, _onDelta, options) => {
    signal = options.signal
    started()
    return pending.promise
  })
  const canceledId = randomUUID()
  const explanation = h.invoke(IPC.explainStart, explainRequest(canceledId))
  await begun
  await h.invoke(IPC.explainCancel, canceledId)
  assert.equal(signal.aborted, true)
  pending.reject(new h.TimeoutError('timeout', 'timeout after explicit cancel'))
  await explanation
  events = h.window.sent.filter((event) => event.channel === IPC.explainEvent).map((event) => event.payload)
  assert.deepEqual(events, [{ requestId: canceledId, type: 'error', data: '已取消' }])
})

test('explain network AbortError and upstream secret errors use only the generic event text', async () => {
  const h = await createHarness()
  const networkAbort = new Error('provider secret apiKey at https://provider.invalid')
  networkAbort.name = 'AbortError'
  h.setStream(async () => { throw networkAbort })
  const requestId = randomUUID()
  await h.invoke(IPC.explainStart, explainRequest(requestId))
  const event = h.window.sent.find((item) => item.channel === IPC.explainEvent)?.payload
  assert.deepEqual(event, { requestId, type: 'error', data: '请求处理失败，请稍后重试' })
  assert.equal(JSON.stringify(event).includes('secret'), false)
  assert.equal(JSON.stringify(event).includes('provider.invalid'), false)
})

test('real streamed explain failures emit error instead of done and never echo upstream error data', async () => {
  for (const wire of [
    'event: error\ndata: {"error":{"message":"UPSTREAM_FAKE_SECRET"}}\n\n',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    ''
  ]) {
    const h = await createHarness()
    h.setStream(chatCompletionStream)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
    try {
      const requestId = randomUUID()
      await h.invoke(IPC.explainStart, explainRequest(requestId))
      const events = h.window.sent.filter((item) => item.channel === IPC.explainEvent).map((item) => item.payload)
      assert.equal(events.some((event) => event.type === 'done'), false)
      assert.equal(events.at(-1).type, 'error')
      assert.equal(events.at(-1).requestId, requestId)
      assert.equal(JSON.stringify(events).includes('UPSTREAM_FAKE_SECRET'), false)
    } finally { globalThis.fetch = originalFetch }
  }
})
