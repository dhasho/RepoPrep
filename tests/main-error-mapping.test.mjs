import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import { IPC } from '../shared/ipc.ts'
import * as sharedTypes from '../shared/types.ts'
import * as resultContract from '../shared/result-contract.ts'
import * as contentRead from '../shared/content-read.ts'
import * as storageContract from '../shared/storage-contract.ts'
import { buildExplainMessages, generateInterview } from '../electron/services/generator.ts'
import { scanProject } from '../electron/services/scanner.ts'
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

async function createHarness({ scan: suppliedScan, projectPath = PROJECT_PATH, getPrivateProfile: suppliedGetPrivateProfile } = {}) {
  const handlers = new Map()
  const appEvents = new Map()
  const windows = []
  const saves = []
  const analysisLists = []
  const analysisLoads = []
  const deletedResultPaths = []
  const recents = []
  let storedRecentProjects = [{ path: projectPath, name: 'demo', lastUsedAt: 'now' }]
  const probeCalls = []
  const appDataPath = path.join(path.parse(root).root, 'AppData', 'Roaming')
  let ready
  const readyPromise = new Promise((resolve) => { ready = resolve })

  class FakeWindow {
    constructor(options) {
      this.options = options
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

  const scan = suppliedScan ?? {
    root: projectPath, name: 'demo', totalFiles: 0, totalBytes: 0, languages: [],
    tree: { name: 'demo', path: '', type: 'dir', children: [] }, keyFiles: [], files: [],
    security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} }
  }
  let generateImpl = async () => ({ projectName: 'demo' })
  let streamImpl = async () => undefined
  let saveSettingsImpl = async () => undefined
  const savedProfile = { id: 'p', name: 'Mock', baseUrl: 'https://provider.invalid/v1', apiKey: 'never-log-this', model: 'mock' }
  const modules = new Map()
  const requireModule = (id) => {
    if (id === 'node:path') return path
    if (id === 'node:fs') return { mkdirSync() {} }
    if (id === 'node:url') return { fileURLToPath, pathToFileURL }
    if (id === 'node:crypto') return { randomUUID }
    if (modules.has(id)) return modules.get(id)
    throw new Error(`unexpected require: ${id}`)
  }

  modules.set('@shared/ipc', { IPC })
  modules.set('@shared/types', sharedTypes)
  modules.set('../../shared/ipc.ts', { IPC })
  modules.set('../../shared/types.ts', sharedTypes)
  modules.set('../../shared/result-contract.ts', resultContract)
  modules.set('../../shared/content-read.ts', contentRead)
  modules.set('../../shared/storage-contract.ts', storageContract)
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
    listModels: async (profile) => { probeCalls.push({ kind: 'models', profile }); return { ok: true, models: [], message: 'ok' } },
    testConnection: async (profile) => { probeCalls.push({ kind: 'test', profile }); return { ok: true, message: 'ok' } }
  })
  modules.set('./services/exporter', { exportMarkdownDialog: async () => ({}) })
  modules.set('./window-security', {
    getTrustedDevUrl: () => null,
    installPermissionDenials() {},
    installWindowSecurity() {}
  })
  modules.set('./services/store', {
    addRecentProject: (value) => recents.push(value),
    deleteResult: (requestedPath) => deletedResultPaths.push(requestedPath),
    getRecentProjects: () => [...storedRecentProjects],
    getSettings: () => ({ profiles: [{ id: 'p', name: 'Mock', baseUrl: 'https://provider.invalid/v1', apiKey: 'never-log-this', model: 'mock' }] }),
    getPrivateProfile: suppliedGetPrivateProfile ?? (async (id) => ({ ...savedProfile, id })),
    getStorageDiagnostics: () => [],
    listAnalyses: (requestedPath, cursor) => {
      analysisLists.push({ projectPath: requestedPath, cursor })
      return { items: [], nextCursor: null }
    },
    loadAnalysis: (requestedPath, id) => {
      analysisLoads.push({ projectPath: requestedPath, id })
      return null
    },
    loadResult: () => null,
    removeRecentProject: async (requestedPath) => { storedRecentProjects = storedRecentProjects.filter((entry) => entry.path !== requestedPath) },
    recoverStorage() {},
    saveResult: (...args) => {
      saves.push(args)
      return createHash('sha256').update(JSON.stringify(args[1])).digest('hex')
    },
    saveSettings: (...args) => saveSettingsImpl(...args)
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
      getPath: (name) => name === 'appData' ? appDataPath : null,
      setPath() {},
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
    analysisLists,
    analysisLoads,
    deletedResultPaths,
    recents,
    probeCalls,
    TimeoutError: LlmRequestError,
    setGenerate: (implementation) => { generateImpl = implementation },
    setStream: (implementation) => { streamImpl = implementation },
    setSaveSettings: (implementation) => { saveSettingsImpl = implementation }
  }
}

const options = { runId: randomUUID(), projectPath: PROJECT_PATH, granularity: 'coarse', roleFocus: 'general', profileId: 'p' }
const explainRequest = (requestId = randomUUID()) => ({
  requestId,
  term: '超时',
  profileId: 'p',
  projectSummary: 'demo',
  question: '怎样处理超时？',
  snippet: '模型请求片段'
})

test('Windows uses native caption controls over the application titlebar without changing renderer isolation', async () => {
  const h = await createHarness()
  const options = h.window.options

  if (process.platform === 'win32') {
    assert.equal(options.titleBarStyle, 'hidden')
    assert.deepEqual(options.titleBarOverlay, { color: '#ffffff', symbolColor: '#475569', height: 48 })
  } else {
    assert.equal(options.titleBarStyle, undefined)
    assert.equal(options.titleBarOverlay, undefined)
  }
  assert.equal(options.minWidth, 1100)
  assert.deepEqual(options.webPreferences, {
    preload: options.webPreferences.preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false
  })
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

test('analysis history IPC validates IDs and keeps both endpoints behind renderer and project guards', async () => {
  const h = await createHarness()
  const id = 'a'.repeat(64)
  assert.deepEqual(await h.invoke(IPC.listAnalyses, PROJECT_PATH), { items: [], nextCursor: null })
  assert.equal(await h.invoke(IPC.loadAnalysis, PROJECT_PATH, id), null)
  assert.deepEqual(h.analysisLists, [{ projectPath: PROJECT_PATH, cursor: undefined }])
  assert.deepEqual(h.analysisLoads, [{ projectPath: PROJECT_PATH, id }])

  const callsBeforeRejects = [h.analysisLists.length, h.analysisLoads.length]
  await assert.rejects(h.invoke(IPC.listAnalyses, PROJECT_PATH, 'not-a-cursor'), /请求无效或未获授权/)
  await assert.rejects(h.invoke(IPC.loadAnalysis, PROJECT_PATH, '../not-an-analysis-id'), /请求无效或未获授权/)

  const untrusted = { sender: h.sender, senderFrame: { url: h.sender.mainFrame.url } }
  await assert.rejects(h.handlers.get(IPC.listAnalyses)(untrusted, PROJECT_PATH), /请求无效或未获授权/)
  await assert.rejects(h.handlers.get(IPC.loadAnalysis)(untrusted, PROJECT_PATH, id), /请求无效或未获授权/)
  assert.deepEqual([h.analysisLists.length, h.analysisLoads.length], callsBeforeRejects, 'invalid callers and IDs must be rejected before the store sees a request')
})

test('generation returns a stable-shaped analysis ID without exposing the private profile key', async () => {
  const h = await createHarness()
  const response = await h.invoke(IPC.generateRun, options)
  assert.match(response.analysisId, /^[a-f0-9]{64}$/)
  assert.equal(h.saves.length, 1)
  assert.equal(h.saves[0][0], PROJECT_PATH)
  assert.equal(JSON.stringify(response).includes('never-log-this'), false)
})

test('removing a recent project revokes analysis IPC authority without deleting saved history', async () => {
  const h = await createHarness()
  const id = 'b'.repeat(64)
  await h.invoke(IPC.recentProjects)
  await h.invoke(IPC.removeRecent, PROJECT_PATH)
  await assert.rejects(h.invoke(IPC.listAnalyses, PROJECT_PATH), /请求无效或未获授权/)
  await assert.rejects(h.invoke(IPC.loadAnalysis, PROJECT_PATH, id), /请求无效或未获授权/)
  assert.deepEqual(h.analysisLists, [])
  assert.deepEqual(h.analysisLoads, [])
  assert.deepEqual(h.deletedResultPaths, [], 'recent removal must not delete the project result archive')
})

test('settings IPC awaits persistence and returns only allowlisted credential guidance', async () => {
  const h = await createHarness()
  const expected = '设置尚未完成安全迁移，请检查系统凭据存储后重试。'
  let complete
  let settled = false
  const pending = new Promise((resolve) => { complete = resolve })
  h.setSaveSettings(async () => { await pending; throw new Error(`${expected} secret=never-show-this`) })
  const request = h.invoke(IPC.settingsSave, { profiles: [], defaultProfileId: null }).then(
    () => { settled = true },
    (error) => { settled = true; throw error }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'settings IPC must wait for asynchronous storage completion')
  complete()
  await assert.rejects(request, (error) => error.message === '保存设置失败，请重试；若持续失败请检查磁盘状态。')

  h.setSaveSettings(async () => { throw new Error(expected) })
  await assert.rejects(h.invoke(IPC.settingsSave, { profiles: [], defaultProfileId: null }), (error) => error.message === expected)
  assert.equal(JSON.stringify(h.saves).includes('never-show-this'), false)
})

test('model and connection probes bind saved credentials to the canonical endpoint and honor clear intent', async () => {
  const h = await createHarness()
  const request = {
    id: 'p', name: 'Probe', baseUrl: 'https://PROVIDER.invalid:443/v1/', model: 'probe-model',
    apiKey: '', hasApiKey: true, credentialStatus: 'stored', useSavedCredential: true, credentialAction: 'keep'
  }
  const result = await h.invoke(IPC.llmTest, request)
  assert.equal(h.probeCalls[0].profile.apiKey, 'never-log-this')
  assert.doesNotMatch(JSON.stringify(result), /never-log-this/)

  await assert.rejects(h.invoke(IPC.llmListModels, { ...request, baseUrl: 'https://attacker.invalid/v1' }),
    (error) => error.message === '已保存的 API Key 仅适用于原接口地址，请先替换 Key。')
  assert.equal(h.probeCalls.length, 1, 'changed endpoint must be rejected before a model request')

  await h.invoke(IPC.llmTest, { ...request, credentialAction: 'clear' })
  assert.equal(h.probeCalls[1].profile.apiKey, '', 'clear intent wins over a stale saved-key reference')
})

test('content boundary rejection reaches the renderer with a static rescan hint and saves nothing', async () => {
  const h = await createHarness()
  h.setGenerate(async () => { throw new Error('项目文件在读取期间发生变化，请重新扫描后重试。') })
  await assert.rejects(h.invoke(IPC.generateRun, options), (error) => error.message === '项目文件在读取期间发生变化，请重新扫描后重试。')
  assert.equal(h.saves.length, 0)
  assert.equal(h.recents.length, 0)
})

test('compensation timeout from the real generator reaches the guard without saving partial success', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-compensation-timeout-'))
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  try {
    await fs.writeFile(path.join(fixtureRoot, 'README.md'), '# Approved fixture\n\nThis real project is used for the compensation timeout path.\n')
    await fs.mkdir(path.join(fixtureRoot, 'src'))
    await fs.writeFile(path.join(fixtureRoot, 'src', 'app.ts'), 'export const approved = true\n')
    const scan = await scanProject(fixtureRoot)
    const h = await createHarness({ scan, projectPath: fixtureRoot })
    h.setGenerate(generateInterview)
    const requestOptions = { ...options, projectPath: fixtureRoot }
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
    await assert.rejects(h.invoke(IPC.generateRun, requestOptions), (error) => error.message === GENERATION_TIMEOUT)
    assert.equal(requests, 2, 'an initial shortfall must reach the compensation request')
    assert.equal(h.saves.length, 0, 'a compensation deadline must not persist partial success')
    assert.equal(h.recents.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    const resolvedFixture = path.resolve(fixtureRoot)
    const resolvedTemp = path.resolve(os.tmpdir())
    assert.ok(resolvedFixture.startsWith(`${resolvedTemp}${path.sep}`), 'cleanup target must remain inside the generated temp directory')
    await fs.rm(resolvedFixture, { recursive: true, force: true })
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
  await h.invoke(IPC.generateCancel, options.runId)
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

test('generation canceled during private credential resolution never scans, generates, or saves after resolution', async () => {
  const pendingCredential = deferred()
  let credentialStarted
  const started = new Promise((resolve) => { credentialStarted = resolve })
  let scanCalls = 0
  let generateCalls = 0
  const h = await createHarness({
    scan: async () => { scanCalls++; return { status: 'reused', scan: { name: 'demo' } } },
    getPrivateProfile: async (id) => { credentialStarted(); return pendingCredential.promise.then((profile) => ({ ...profile, id })) }
  })
  h.setGenerate(async () => { generateCalls++; return { projectName: 'generated' } })
  const requestId = randomUUID()
  const generation = h.invoke(IPC.generateRun, { ...options, runId: requestId })
  await started
  await h.invoke(IPC.generateCancel, requestId)
  pendingCredential.resolve({ id: 'p', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-only', model: 'mock' })
  await assert.rejects(generation, (error) => error.message === '已取消生成')
  assert.equal(scanCalls, 0)
  assert.equal(generateCalls, 0)
  assert.equal(h.saves.length, 0)
  assert.equal(h.recents.length, 0)
})

test('explain canceled during private credential resolution ends once with static cancellation and never starts streaming', async () => {
  const pendingCredential = deferred()
  let credentialStarted
  const started = new Promise((resolve) => { credentialStarted = resolve })
  let streamCalls = 0
  const h = await createHarness({
    getPrivateProfile: async (id) => { credentialStarted(); return pendingCredential.promise.then((profile) => ({ ...profile, id })) }
  })
  h.setStream(async () => { streamCalls++; return 'must not stream' })
  const requestId = randomUUID()
  const explanation = h.invoke(IPC.explainStart, explainRequest(requestId))
  await started
  await h.invoke(IPC.explainCancel, requestId)
  pendingCredential.resolve({ id: 'p', name: 'Synthetic', baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-only', model: 'mock' })
  await explanation
  const events = h.window.sent.filter((event) => event.channel === IPC.explainEvent).map((event) => event.payload)
  assert.deepEqual(events, [{ requestId, type: 'error', data: '已取消' }])
  assert.equal(streamCalls, 0)
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
