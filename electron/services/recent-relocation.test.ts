// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { randomUUID } from 'node:crypto'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { SCAN_LIMIT_BOUNDS } from '../../shared/types.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import * as resultContract from '../../shared/result-contract.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import * as contentRead from '../../shared/content-read.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import * as storageContract from '../../shared/storage-contract.ts'
// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import * as generationPreview from '../../shared/generation-preview.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function loadTypescriptModule(filename: string, requireModule: (id: string) => unknown, context: Record<string, unknown> = {}) {
  const absolutePath = path.join(projectRoot, filename)
  const source = readFileSync(absolutePath, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const module = { exports: {} as Record<string, any> }
  const sandbox = {
    module,
    exports: module.exports,
    require: requireModule,
    __dirname: path.dirname(absolutePath),
    __filename: absolutePath,
    console,
    URL,
    AbortController,
    process: { on() {}, platform: 'win32', env: {} },
    ...context
  }
  vm.runInThisContext(`(function(exports, require, module, __filename, __dirname, process) { ${js}\n})`, { filename: absolutePath })(
    module.exports, requireModule, module, absolutePath, path.dirname(absolutePath), sandbox.process
  )
  return module.exports
}

function loadStore(userDataPath: string) {
  const filename = fileURLToPath(new URL('./store.ts', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const module = { exports: {} as Record<string, (...args: any[]) => any> }
  const requireModule = createRequire(import.meta.url)
  const sandbox = {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === 'electron') return { app: { getPath: () => userDataPath } }
      if (id === './credential-vault') return {
        encryptCredential: async (value: string) => ({ version: 1, ciphertext: Buffer.from(value).toString('base64') }),
        decryptCredential: async (value: { ciphertext: string }) => Buffer.from(value.ciphertext, 'base64').toString()
      }
      if (id === './native-credential-crypto') return { nativeCredentialCrypto: { isAvailable: async () => true, encrypt: async (value: string) => Buffer.from(value), decrypt: async (value: Buffer) => value.toString() } }
      return requireModule(id)
    },
    __dirname: path.dirname(filename),
    __filename: filename
  }
  vm.runInThisContext(`(function(exports, require, module, __filename, __dirname) { ${js}\n})`, { filename })(
    module.exports, sandbox.require, module, filename, path.dirname(filename)
  )
  return module.exports as unknown as {
    addRecentProject(entry: { path: string; name: string }): unknown
    getRecentProjects(): Array<{ path: string; name: string }>
    removeRecentProject(projectPath: string): void
    loadResult(projectPath: string): { sections: Array<{ id: string }> } | null
    saveResult(projectPath: string, result: unknown): void
  }
}

function savedResult(projectPath: string) {
  return {
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    projectName: 'Demo',
    projectPath,
    granularity: 'medium',
    roleFocus: 'general',
    profileId: 'fixture',
    modelUsed: 'Fixture / mock',
    projectSummary: 'Previously saved material',
    sections: [{ id: 'preserved', title: 'Saved section', questions: [] }],
    glossary: {}
  }
}

function cleanupFixture(userDataPath: string): void {
  const resolved = path.resolve(userDataPath)
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
  assert.ok(path.basename(resolved).startsWith('projectlens-recent-'))
  rmSync(resolved, { recursive: true, force: true })
}

async function loadMainHarness(store: ReturnType<typeof loadStore>, selectedPath: string) {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const appEvents = new Map<string, (...args: any[]) => void>()
  const windows: any[] = []
  const invalidations: string[] = []
  const ready = Promise.resolve()
  class FakeWindow {
    events = new Map<string, (...args: any[]) => void>()
    destroyed = false
    webContents = {
      mainFrame: { url: '' },
      on() {},
      send() {},
      isDestroyed: () => this.destroyed,
      getURL: () => this.webContents.mainFrame.url
    }
    constructor() { windows.push(this) }
    on(name: string, listener: (...args: any[]) => void) { this.events.set(name, listener) }
    show() {}
    loadURL(url: string) { this.webContents.mainFrame.url = url; return Promise.resolve() }
    destroy() { this.destroyed = true }
    static getAllWindows() { return windows.filter((window) => !window.destroyed) }
    static fromWebContents(contents: unknown) { return windows.find((window) => window.webContents === contents) ?? null }
  }
  const electron = {
    app: {
      isPackaged: true,
      getPath: (name: string) => name === 'appData' ? path.join(path.parse(projectRoot).root, 'AppData', 'Roaming') : null,
      setPath() {},
      whenReady: () => ready,
      on: (name: string, listener: (...args: any[]) => void) => appEvents.set(name, listener),
      quit() {}
    },
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }), showErrorBox() {} },
    ipcMain: { handle: (channel: string, listener: (...args: any[]) => Promise<any>) => handlers.set(channel, listener) },
    session: { defaultSession: {} }
  }
  const modules = new Map<string, unknown>([
    ['electron', electron],
    ['@shared/ipc', { IPC }],
    ['@shared/generation-preview', generationPreview],
    ['@shared/types', {}],
    ['@shared/generation-checkpoint', { GENERATION_DRAFT_MESSAGES: { exists: 'exists', missing: 'missing', changed: 'changed', corrupt: 'corrupt', unreadable: 'unreadable', save: 'save', discard: 'discard' } }],
    ['./services/generation-drafts', { readGenerationDraft: () => null, beginGenerationDraft: () => null, saveGenerationDraft() {}, completeGenerationDraft() {}, removeGenerationDraft() {} }],
    ['./services/scan-cache', { ProjectScanCache: class {
      async refresh(projectPath: string) { return { scan: { root: projectPath, name: projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Demo' } } }
      async getFresh(projectPath: string) { return { scan: { root: projectPath, name: 'Demo' } } }
      async invalidate(projectPath: string) { invalidations.push(projectPath) }
    } }],
    ['./services/generation-tasks', { GenerationTaskRegistry: class {
      begin() { return true }
      finish() {}
      cancelAll() {}
    } }],
    ['./services/generator', { generateInterview: async () => ({}), buildExplainMessages() {} }],
    ['./services/llm', { chatCompletionStream: async () => {}, listModels: async () => ({}), testConnection: async () => ({}) }],
    ['./services/exporter', { exportMarkdownDialog: async () => ({}) }],
    ['./window-security', { getTrustedDevUrl: () => null, installPermissionDenials() {}, installWindowSecurity() {} }],
    ['./services/store', store]
  ])
  const moduleCache = new Map<string, unknown>()
  const requireModule = (id: string): any => {
    if (modules.has(id)) return modules.get(id)
    if (moduleCache.has(id)) return moduleCache.get(id)
    if (id === 'node:path') return path
    if (id === 'node:fs') return { mkdirSync() {} }
    if (id === 'node:url') return { fileURLToPath, pathToFileURL }
    if (id === 'node:crypto') return { randomUUID }
    if (id === '../../shared/types.ts') return { SCAN_LIMIT_BOUNDS }
    if (id === '../../shared/result-contract.ts') return resultContract
    if (id === '../../shared/content-read.ts') return contentRead
    if (id === '../../shared/storage-contract.ts') return storageContract
    if (id === './ipc-validation.ts') {
      const loaded = loadTypescriptModule('electron/services/ipc-validation.ts', requireModule)
      moduleCache.set(id, loaded)
      return loaded
    }
    if (id === '../../shared/ipc.ts') return { IPC }
    if (id === '../../shared/content-read.ts') return contentRead
    if (id === './ipc-authority.ts') {
      const loaded = loadTypescriptModule('electron/services/ipc-authority.ts', requireModule)
      moduleCache.set('./services/ipc-authority', loaded)
      return loaded
    }
    if (id === './services/ipc-authority') {
      const loaded = loadTypescriptModule('electron/services/ipc-authority.ts', requireModule)
      moduleCache.set(id, loaded)
      return loaded
    }
    if (id === './services/ipc-handler-guards') {
      const loaded = loadTypescriptModule('electron/services/ipc-handler-guards.ts', requireModule)
      moduleCache.set(id, loaded)
      return loaded
    }
    throw new Error(`unexpected require in main harness: ${id}`)
  }
  loadTypescriptModule('electron/main.ts', requireModule, { BrowserWindow: FakeWindow })
  await new Promise((resolve) => setImmediate(resolve))
  return { handlers, windows, invalidations }
}

test('main registered recent relocation handlers remove one exact key and retain remaining alias authorization', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'projectlens-recent-'))
  try {
    const store = loadStore(userDataPath)
    const sourceKey = 'C:\\Demo'
    const remainingAlias = 'c:/demo'
    const targetKey = 'D:\\MovedDemo'
    store.addRecentProject({ path: sourceKey, name: 'Demo' })
    store.addRecentProject({ path: remainingAlias, name: 'Demo alias' })
    store.saveResult(sourceKey, savedResult(sourceKey))

    const harness = await loadMainHarness(store, targetKey)
    const window = harness.windows[0]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }

    const initialRecent = await harness.handlers.get(IPC.recentProjects)!(event)
    assert.ok(initialRecent.some((entry: { path: string }) => entry.path === sourceKey))
    assert.equal(await harness.handlers.get(IPC.selectFolder)!(event), targetKey, 'the main selectFolder handler registers the selected target')
    const scan = await harness.handlers.get(IPC.scanProject)!(event, targetKey)
    assert.equal(scan.storagePath, targetKey, 'the main scan handler returns the actual recent storage key')

    await harness.handlers.get(IPC.removeRecent)!(event, sourceKey)
    assert.deepEqual([...store.getRecentProjects()].map((entry) => entry.path).sort(), [remainingAlias, targetKey].sort())
    assert.deepEqual(harness.invalidations, [sourceKey], 'the real main handler invalidates the removed project cache')
    assert.equal(await harness.handlers.get(IPC.loadResult)!(event, remainingAlias), null, 'remaining same-key alias stays authorized after main re-registers recent entries')
    assert.equal(await harness.handlers.get(IPC.loadResult)!(event, targetKey), null, 'selected target authorization remains valid')
    assert.equal(store.loadResult(sourceKey)?.sections[0].id, 'preserved', 'removing a recent entry leaves its result file untouched')

    const beforeRejectedRemoval = [...store.getRecentProjects()].map((entry) => entry.path).sort()
    await assert.rejects(
      harness.handlers.get(IPC.removeRecent)!({ ...event, senderFrame: { url: event.senderFrame.url } }, remainingAlias),
      /请求无效或未获授权/
    )
    assert.deepEqual([...store.getRecentProjects()].map((entry) => entry.path).sort(), beforeRejectedRemoval, 'untrusted sender cannot mutate recent storage')
  } finally {
    cleanupFixture(userDataPath)
  }
})

test('main removeRecent preserves a newly selected same-canonical recent key', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'projectlens-recent-collision-'))
  try {
    const store = loadStore(userDataPath)
    const sourceKey = 'C:\\Demo'
    const selectedKey = 'c:/demo'
    store.addRecentProject({ path: sourceKey, name: 'Demo' })
    store.saveResult(sourceKey, savedResult(sourceKey))

    const harness = await loadMainHarness(store, selectedKey)
    const window = harness.windows[0]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await harness.handlers.get(IPC.recentProjects)!(event)
    assert.equal(await harness.handlers.get(IPC.selectFolder)!(event), selectedKey)
    const scan = await harness.handlers.get(IPC.scanProject)!(event, selectedKey)
    assert.equal(scan.storagePath, selectedKey)

    await harness.handlers.get(IPC.removeRecent)!(event, sourceKey)
    assert.deepEqual([...store.getRecentProjects()].map((entry) => entry.path), [selectedKey], 'remove the old exact key while retaining the selected spelling')
    assert.equal(await harness.handlers.get(IPC.loadResult)!(event, selectedKey), null, 'the selected authorization remains valid after old-key removal')
    assert.equal(store.loadResult(sourceKey)?.sections[0].id, 'preserved', 'old result file is not migrated or deleted')
  } finally {
    cleanupFixture(userDataPath)
  }
})
