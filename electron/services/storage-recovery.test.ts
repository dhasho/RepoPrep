// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { after } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import ts from 'typescript'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { AuthorizedProjectRegistry } from './ipc-authority.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { createGuardedIpcHandler } from './ipc-handler-guards.ts'

const roots: string[] = []
const nativeRequire = createRequire(import.meta.url)
const compilerOptions = {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}

after(async () => {
  const allowedRoot = path.resolve(os.tmpdir())
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root)
    assert.ok(path.relative(allowedRoot, resolved).startsWith('projectlens-issue72-storage-'))
    assert.ok(path.basename(resolved).startsWith('projectlens-issue72-storage-'))
    await fs.promises.rm(resolved, { recursive: true, force: true })
  }
})

type DeleteTarget = 'primary' | 'backup' | 'corrupt'
type Fault = { operation: string; target: DeleteTarget; code: string; fired: boolean }

function makeFaultFs(): {
  fs: typeof import('node:fs')
  arm: (operation: string, target?: DeleteTarget, code?: string) => void
  readonly deleteAttempts: string[]
  readonly openReadDescriptors: number
} {
  let fault: Fault | undefined
  const deleteAttempts: string[] = []
  const descriptorTargets = new Map<number, Fault['target']>()
  const readDescriptors = new Map<number, Fault['target']>()
  const matchesTarget = (file: unknown, target: Fault['target']) => {
    if (typeof file !== 'string') return false
    const basename = path.basename(file)
    return target === 'backup'
      ? basename.includes('.json.bak.projectlens-')
      : basename.endsWith('.projectlens-') || /\.json\.projectlens-/.test(basename)
  }
  const maybeFail = (operation: string, file: unknown, role?: Fault['target']) => {
    if (!fault || fault.fired || fault.operation !== operation || (role !== fault.target && !matchesTarget(file, fault.target))) return
    fault.fired = true
    if (operation === 'write' && typeof file === 'number') return
    const detail = operation === 'delete' || operation === 'lstat'
      ? ` ${String(file)} api-key=delete-private-marker`
      : ''
    const error = new Error(`injected ${operation} failure${detail}`)
    Object.assign(error, { code: fault.code })
    throw error
  }
  const deleteRole = (file: unknown): DeleteTarget | undefined => {
    if (typeof file !== 'string') return undefined
    const name = path.basename(file)
    if (name.endsWith('.json.bak')) return 'backup'
    if (name.endsWith('.json.corrupt')) return 'corrupt'
    if (name.endsWith('.json')) return 'primary'
    return undefined
  }
  const intercepted = new Set(['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync'])
  const fsFacade = new Proxy(fs, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver)
      if (property === 'rmSync' && typeof method === 'function') return (...args: unknown[]) => {
        const file = args[0]
        const role = deleteRole(file)
        if (role) deleteAttempts.push(role)
        maybeFail('delete', file, role)
        const result = method.apply(target, args)
        maybeFail('delete-after', file, role)
        return result
      }
      if (property === 'lstatSync' && typeof method === 'function') return (...args: unknown[]) => {
        maybeFail('lstat', args[0], deleteRole(args[0]))
        return method.apply(target, args)
      }
      if (!intercepted.has(String(property)) || typeof method !== 'function') return method
      return (...args: unknown[]) => {
        if (property === 'openSync') {
          maybeFail('create', args[0])
          const fd = method.apply(target, args) as number
          if (matchesTarget(args[0], 'backup')) descriptorTargets.set(fd, 'backup')
          else if (matchesTarget(args[0], 'primary')) descriptorTargets.set(fd, 'primary')
          else if (typeof args[0] === 'string' && path.basename(args[0]).endsWith('.json.bak')) readDescriptors.set(fd, 'backup')
          else if (typeof args[0] === 'string' && path.basename(args[0]).endsWith('.json')) readDescriptors.set(fd, 'primary')
          return fd
        }
        if (property === 'renameSync') {
          const destination = args[1]
          const role = typeof destination === 'string' && destination.endsWith('.json.bak')
            ? 'backup'
            : typeof destination === 'string' && destination.endsWith('.json')
              ? 'primary'
              : undefined
          maybeFail('rename', destination, role)
        }
        if (property === 'writeSync' && fault?.operation === 'partial-write' && !fault.fired) {
          // Write a prefix to the real descriptor, then fail the next operation.
          const fd = args[0] as number
          if (descriptorTargets.get(fd) !== fault.target) return method.apply(target, args)
          const buffer = args[1] as Buffer
          const offset = typeof args[2] === 'number' ? args[2] : 0
          const length = typeof args[3] === 'number' ? args[3] : buffer.length - offset
          const position = args.length > 4 ? args[4] as number | null : null
          const written = method.call(target, fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position)
          fault.fired = true
          const error = new Error('injected partial-write failure')
          Object.assign(error, { code: fault.code, written })
          throw error
        }
        const fd = typeof args[0] === 'number' ? args[0] : undefined
        if (property === 'fsyncSync') maybeFail('fsync', undefined, fd === undefined ? undefined : descriptorTargets.get(fd))
        if (property === 'closeSync') {
          if (fault?.operation === 'read-close') maybeFail('read-close', undefined, fd === undefined ? undefined : readDescriptors.get(fd))
          else maybeFail('close', undefined, fd === undefined ? undefined : descriptorTargets.get(fd))
        }
        const result = method.apply(target, args)
        if (property === 'closeSync' && fd !== undefined) {
          descriptorTargets.delete(fd)
          readDescriptors.delete(fd)
        }
        return result
      }
    }
  }) as typeof import('node:fs')
  return {
    fs: fsFacade,
    arm(operation, target = 'primary', code = 'EIO') { fault = { operation, target, code, fired: false } },
    get deleteAttempts() { return [...deleteAttempts] },
    get openReadDescriptors() { return readDescriptors.size }
  }
}

function evaluateCommonJs(code: string, filename: string, suppliedRequire: (id: string) => unknown): Record<string, any> {
  const module = { exports: {} as Record<string, any> }
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code) as Function
  run(module.exports, suppliedRequire, module, filename, path.dirname(filename))
  return module.exports
}

async function makeHarness(): Promise<{
  store: Record<string, (...args: any[]) => any>
  atomic: Record<string, (...args: any[]) => any>
  root: string
  userData: string
  faultFs: ReturnType<typeof makeFaultFs>
}> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projectlens-issue72-storage-'))
  roots.push(root)
  const userData = path.join(root, 'user-data')
  await fs.promises.mkdir(userData)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const atomicPath = path.resolve(here, 'atomic-json.ts')
  const storePath = path.resolve(here, 'store.ts')
  const contentReadPath = path.resolve(here, '..', '..', 'shared', 'content-read.ts')
  const contractPath = path.resolve(here, '..', '..', 'shared', 'result-contract.ts')
  const storageContractPath = path.resolve(here, '..', '..', 'shared', 'storage-contract.ts')
  const faultFs = makeFaultFs()
  const fsRequire = (id: string) => id === 'node:fs' || id === 'fs' ? faultFs.fs : nativeRequire(id)
  const transpile = async (file: string) => ts.transpileModule(await fs.promises.readFile(file, 'utf8'), compilerOptions).outputText

  const atomic = evaluateCommonJs(await transpile(atomicPath), atomicPath, fsRequire)
  const contentRead = evaluateCommonJs(await transpile(contentReadPath), contentReadPath, (id) => nativeRequire(id))
  const contract = evaluateCommonJs(await transpile(contractPath), contractPath, (id) => {
    if (id === './content-read.ts') return contentRead
    return nativeRequire(id)
  })
  const storageContract = evaluateCommonJs(await transpile(storageContractPath), storageContractPath, (id) => nativeRequire(id))
  const store = evaluateCommonJs(await transpile(storePath), storePath, (id) => {
    if (id === 'electron') return { app: { getPath: (name: string) => {
      assert.equal(name, 'userData')
      return userData
    } } }
    if (id === '@shared/result-contract') return contract
    if (id === '@shared/storage-contract') return storageContract
    if (id === './atomic-json') return atomic
    return fsRequire(id)
  })
  return { store, atomic, root, userData, faultFs }
}

function sampleResult(projectPath: string, projectName = path.basename(projectPath)): Record<string, any> {
  return {
    version: 1,
    createdAt: '2026-10-11T00:00:00.000Z',
    projectName,
    projectPath,
    granularity: 'medium',
    roleFocus: 'general',
    profileId: 'profile-1',
    modelUsed: 'test-model',
    projectSummary: 'summary',
    sections: [{ id: 's1', title: 'Basics', questions: [{ id: 'q1', question: 'Question?', answer: 'Answer.', followUps: [] }] }],
    glossary: {}
  }
}

function validSettings(id = 'profile-1'): Record<string, any> {
  return {
    profiles: [{ id, name: 'Profile', baseUrl: 'https://example.test/v1', apiKey: 'private-key-marker', model: 'test-model' }],
    defaultProfileId: id
  }
}

function resultFile(userData: string, projectPath: string): string {
  const hash = nativeRequire('node:crypto').createHash('sha1').update(projectPath).digest('hex') as string
  return path.join(userData, 'projects', `${hash}.json`)
}

function assertNoHelperTemps(file: string): void {
  const names = fs.readdirSync(path.dirname(file))
  const base = path.basename(file)
  const prefixes = [`.${base}.projectlens-`, `.${base}.bak.projectlens-`, `.${base}.corrupt.projectlens-`]
  assert.equal(names.some((name) => prefixes.some((prefix) => name.startsWith(prefix))), false)
}

function storageScenarios(userData: string) {
  const projectPath = 'C:\\ProjectA'
  return [
    { kind: 'settings', file: path.join(userData, 'settings.json'),
      seed: (store: any) => store.saveSettings({ profiles: [], defaultProfileId: null }),
      update: (store: any) => store.saveSettings(validSettings('new')),
      read: (store: any) => store.getSettings() },
    { kind: 'recent', file: path.join(userData, 'recent.json'),
      seed: (store: any) => store.addRecentProject({ path: projectPath, name: 'ProjectA' }),
      update: (store: any) => store.addRecentProject({ path: 'C:\\ProjectB', name: 'ProjectB' }),
      read: (store: any) => store.getRecentProjects() },
    { kind: 'result', file: resultFile(userData, projectPath),
      seed: (store: any) => store.saveResult(projectPath, sampleResult(projectPath)),
      update: (store: any) => store.saveResult(projectPath, { ...sampleResult(projectPath), projectSummary: 'replacement' }),
      read: (store: any) => store.loadResult(projectPath) }
  ]
}

test('atomic store failures preserve valid settings, recent history, and result bytes', async () => {
  for (const kind of ['settings', 'recent', 'result']) {
    for (const operation of ['create', 'partial-write', 'fsync', 'close', 'rename']) {
      const { store, userData, faultFs } = await makeHarness()
      const scenario = storageScenarios(userData).find((item) => item.kind === kind)!
      scenario.seed(store)
      const file = scenario.file
      const before = fs.readFileSync(file)
      faultFs.arm(operation, 'primary')
      assert.throws(() => scenario.update(store), (error: unknown) => {
        assert.ok(error instanceof Error)
        const expected = kind === 'result'
          ? '保存结果失败，请检查磁盘空间或权限后重试。'
          : '保存本地数据失败，请检查磁盘空间或权限后重试。'
        assert.equal(error.message, expected)
        assert.equal(error.message.includes(userData), false)
        assert.equal(error.message.includes('private-key-marker'), false)
        return true
      })
      assert.deepEqual(fs.readFileSync(file), before, `${scenario.kind}/${operation} must preserve the complete old file`)
      const loaded = scenario.read(store)
      assert.ok(loaded, `${scenario.kind}/${operation} should leave the previous value loadable`)
      assertNoHelperTemps(file)
    }
  }
})

test('failure to replace the backup leaves the last complete primary intact for every store kind', async () => {
  for (const kind of ['settings', 'recent', 'result']) {
    const { store, userData, faultFs } = await makeHarness()
    const scenario = storageScenarios(userData).find((item) => item.kind === kind)!
    scenario.seed(store)
    const before = fs.readFileSync(scenario.file)
    faultFs.arm('rename', 'backup')
    assert.throws(() => scenario.update(store))
    assert.deepEqual(fs.readFileSync(scenario.file), before)
    assert.ok(scenario.read(store), `${kind} should remain loadable after its backup update fails`)
    assertNoHelperTemps(scenario.file)
  }
})

test('settings write errors retain only allowlisted errno codes for static IPC mapping', async () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO']) {
    const { store, userData, faultFs } = await makeHarness()
    store.saveSettings({ profiles: [], defaultProfileId: null })
    const file = path.join(userData, 'settings.json')
    const before = fs.readFileSync(file)
    faultFs.arm('rename', 'backup', code)
    assert.throws(() => store.saveSettings(validSettings('replacement')), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, '保存本地数据失败，请检查磁盘空间或权限后重试。')
      assert.equal((error as NodeJS.ErrnoException).code, code === 'EIO' ? undefined : code)
      assert.equal(error.message.includes(userData), false)
      assert.equal(error.message.includes(code), false)
      return true
    })
    assert.deepEqual(fs.readFileSync(file), before)
  }
})

test('valid backup is a read-only fallback and explicit recovery archives corrupt bytes', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(path.dirname(userData), 'authorized-project')
  const file = resultFile(userData, projectPath)
  store.saveResult(projectPath, sampleResult(projectPath, 'Older'))
  store.saveResult(projectPath, sampleResult(projectPath, 'Newer'))
  const backup = fs.readFileSync(`${file}.bak`)
  const corrupt = Buffer.from('{"invalid": "preserve this exact payload"')
  fs.writeFileSync(file, corrupt)

  assert.equal(store.loadResult(projectPath).projectName, 'Older')
  assert.deepEqual(fs.readFileSync(file), corrupt, 'fallback reads must not rewrite the damaged primary')
  const [diagnostic] = store.getStorageDiagnostics()
  assert.equal(diagnostic.usingBackup, true)
  assert.equal(diagnostic.canRecover, true)
  assert.equal(diagnostic.problem, 'corrupt')
  assert.equal(JSON.stringify(diagnostic).includes(userData), false)

  store.recoverStorage(diagnostic.id)
  assert.deepEqual(fs.readFileSync(file), backup)
  assert.deepEqual(fs.readFileSync(`${file}.corrupt`), corrupt)
  assert.equal(store.getStorageDiagnostics().length, 0)
})

test('deleting a result removes every recovery copy so historical data cannot return from backup', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'deleted-project')
  const file = resultFile(userData, projectPath)
  store.saveResult(projectPath, sampleResult(projectPath, 'Old'))
  store.saveResult(projectPath, sampleResult(projectPath, 'New'))
  fs.writeFileSync(file, Buffer.from('{corrupt'))
  assert.equal(store.loadResult(projectPath).projectName, 'Old', 'valid backup is read without rewriting damaged primary')
  const [diagnostic] = store.getStorageDiagnostics()
  store.recoverStorage(diagnostic.id)
  assert.deepEqual([file, `${file}.bak`, `${file}.corrupt`].map((candidate) => fs.existsSync(candidate)), [true, true, true])

  store.deleteResult(projectPath)
  assert.deepEqual([file, `${file}.bak`, `${file}.corrupt`].map((candidate) => fs.existsSync(candidate)), [false, false, false])
  assert.equal(store.getStorageDiagnostics().some((item: any) => item.id === diagnostic.id), false)
  assert.equal(store.loadResult(projectPath), null, 'a later read must not resurrect deleted history from a backup')
})

test('result deletion attempts every copy, reports partial failure, refreshes diagnostics, and retries idempotently', async () => {
  for (const target of ['primary', 'backup', 'corrupt'] as const) {
    const { store, userData, faultFs } = await makeHarness()
    const projectPath = path.join(userData, `delete-${target}`)
    const file = resultFile(userData, projectPath)
    store.saveResult(projectPath, sampleResult(projectPath, 'Older'))
    store.saveResult(projectPath, sampleResult(projectPath, 'Newer'))
    fs.writeFileSync(`${file}.corrupt`, Buffer.from('{damaged archive'))
    fs.writeFileSync(file, Buffer.from('{damaged primary'))
    assert.equal(store.loadResult(projectPath).projectName, 'Older')
    faultFs.arm('delete', target, target === 'primary' ? 'EACCES' : 'EPERM')

    assert.throws(() => store.deleteResult(projectPath), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, '删除历史结果未完成，部分文件可能仍存在。请检查权限后重试。')
      assert.equal(error.message.includes(userData), false)
      return true
    })
    assert.deepEqual(faultFs.deleteAttempts.slice(-3), ['backup', 'corrupt', 'primary'])
    assert.equal(fs.existsSync(`${file}${target === 'backup' ? '.bak' : target === 'corrupt' ? '.corrupt' : ''}`), true)
    assert.equal(fs.existsSync(file), target === 'primary')
    assert.equal(fs.existsSync(`${file}.bak`), target === 'backup')
    assert.equal(fs.existsSync(`${file}.corrupt`), target === 'corrupt')

    const diagnostic = store.getStorageDiagnostics().find((item: any) => item.id === `result:${nativeRequire('node:crypto').createHash('sha1').update(projectPath).digest('hex')}`)
    if (target === 'backup') {
      assert.equal(diagnostic?.usingBackup, true)
      assert.equal(diagnostic?.canRecover, true)
    } else if (target === 'primary') {
      assert.equal(diagnostic?.canRecover, false, 'a corrupt primary without its backup is not recoverable')
    } else {
      assert.equal(diagnostic, undefined, 'missing primary and backup clear diagnostics even when a corrupt archive remains')
    }

    store.deleteResult(projectPath)
    assert.deepEqual([file, `${file}.bak`, `${file}.corrupt`].map((candidate) => fs.existsSync(candidate)), [false, false, false])
    assert.equal(store.loadResult(projectPath), null)
    assert.deepEqual(store.getStorageDiagnostics(), [])
    store.deleteResult(projectPath)
  }
})

test('result deletion succeeds when rm reports an error after removing the target', async () => {
  const { store, userData, faultFs } = await makeHarness()
  const projectPath = path.join(userData, 'delete-after-error')
  const file = resultFile(userData, projectPath)
  store.saveResult(projectPath, sampleResult(projectPath))
  faultFs.arm('delete-after', 'primary', 'EIO')
  store.deleteResult(projectPath)
  assert.deepEqual([file, `${file}.bak`, `${file}.corrupt`].map((candidate) => fs.existsSync(candidate)), [false, false, false])
  assert.equal(store.loadResult(projectPath), null)
})

test('result deletion fails closed when final lstat cannot confirm absence', async () => {
  const { store, userData, faultFs } = await makeHarness()
  const projectPath = path.join(userData, 'delete-lstat')
  store.saveResult(projectPath, sampleResult(projectPath))
  faultFs.arm('lstat', 'backup', 'EACCES')
  assert.throws(() => store.deleteResult(projectPath), /删除历史结果未完成，部分文件可能仍存在/)
})

test('guarded result deletion authorizes before filesystem access and exposes only its static failure', async () => {
  const { store, userData, faultFs } = await makeHarness()
  const projectPath = path.join(userData, 'authorized-delete')
  store.saveResult(projectPath, sampleResult(projectPath))
  const mainFrame = { url: 'http://localhost:5173/' }
  const contents = { mainFrame }
  const event = { sender: contents, senderFrame: mainFrame }
  const projects = new AuthorizedProjectRegistry()
  projects.registerSelected(projectPath)
  const handler = createGuardedIpcHandler(IPC.deleteResult, {
    getExpectedWebContents: () => contents,
    getTrustedRendererUrl: () => 'http://localhost:5173/',
    projects
  }, (_event, requestedPath) => store.deleteResult(requestedPath as string))

  const beforeDenied = faultFs.deleteAttempts.length
  await assert.rejects(handler(event, path.join(userData, 'unapproved')), /无效或未获授权/)
  assert.equal(faultFs.deleteAttempts.length, beforeDenied, 'authorization must precede deletion')

  const file = resultFile(userData, projectPath)
  fs.writeFileSync(`${file}.bak`, Buffer.from('backup private marker'))
  faultFs.arm('delete', 'backup', 'EACCES')
  await assert.rejects(handler(event, projectPath), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, '删除历史结果未完成，部分文件可能仍存在。请检查权限后重试。')
    assert.equal(error.message.includes(userData), false)
    assert.equal(error.message.includes('EACCES'), false)
    assert.equal(error.message.includes('backup private marker'), false)
    return true
  })
  assert.equal(await handler(event, projectPath), undefined)
  assert.equal(store.loadResult(projectPath), null)
})

test('recovery clears a stale diagnostic without replacing a newer valid primary', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'updated-project')
  const file = resultFile(userData, projectPath)
  store.saveResult(projectPath, sampleResult(projectPath, 'Older'))
  store.saveResult(projectPath, sampleResult(projectPath, 'Newer'))
  const backup = fs.readFileSync(`${file}.bak`)
  fs.writeFileSync(file, Buffer.from('{corrupt'))
  assert.equal(store.loadResult(projectPath).projectName, 'Older')
  const [diagnostic] = store.getStorageDiagnostics()

  const freshBytes = Buffer.from(JSON.stringify(sampleResult(projectPath, 'Fresh'), null, 2))
  fs.writeFileSync(file, freshBytes)
  store.recoverStorage(diagnostic.id)

  assert.deepEqual(fs.readFileSync(file), freshBytes)
  assert.deepEqual(fs.readFileSync(`${file}.bak`), backup)
  assert.equal(fs.existsSync(`${file}.corrupt`), false, 'healthy newer data should not be archived as corrupt')
  assert.equal(store.getStorageDiagnostics().some((item: any) => item.id === diagnostic.id), false)
  assert.equal(store.loadResult(projectPath).projectName, 'Fresh')
})

test('failed recovery replacement preserves both the damaged primary and complete backup', async () => {
  const { store, userData, faultFs } = await makeHarness()
  const projectPath = path.join(userData, 'recovery-failure')
  const file = resultFile(userData, projectPath)
  store.saveResult(projectPath, sampleResult(projectPath, 'Complete'))
  store.saveResult(projectPath, sampleResult(projectPath, 'Newer'))
  const backup = fs.readFileSync(`${file}.bak`)
  const damaged = Buffer.from('{damaged')
  fs.writeFileSync(file, damaged)
  store.loadResult(projectPath)
  const [diagnostic] = store.getStorageDiagnostics()

  faultFs.arm('rename', 'primary')
  assert.throws(() => store.recoverStorage(diagnostic.id), /恢复失败，请重试/)
  assert.deepEqual(fs.readFileSync(file), damaged)
  assert.deepEqual(fs.readFileSync(`${file}.bak`), backup)
  assert.deepEqual(fs.readFileSync(`${file}.corrupt`), damaged, 'failed recovery may preserve a corrupt archive without replacing source')
  assert.equal(store.getStorageDiagnostics()[0].canRecover, true)
})

test('settings and recent backups survive bad primaries, and their bytes change only on explicit recovery', async () => {
  const { store, userData } = await makeHarness()
  const settingsFile = path.join(userData, 'settings.json')
  const recentFile = path.join(userData, 'recent.json')
  const oldSettings = Buffer.from(JSON.stringify({ profiles: [], defaultProfileId: null }))
  const priorSettings = Buffer.from(JSON.stringify(validSettings('prior')))
  const oldRecent = Buffer.from(JSON.stringify([{ path: 'C:\\ProjectA', name: 'ProjectA', lastUsedAt: '2026-10-10T00:00:00.000Z' }]))
  const priorRecent = Buffer.from(JSON.stringify([{ path: 'C:\\ProjectB', name: 'ProjectB', lastUsedAt: '2026-10-09T00:00:00.000Z' }]))
  const damaged = Buffer.from('{broken json')
  fs.writeFileSync(settingsFile, damaged)
  fs.writeFileSync(`${settingsFile}.bak`, oldSettings)
  fs.writeFileSync(recentFile, damaged)
  fs.writeFileSync(`${recentFile}.bak`, oldRecent)

  assert.equal(store.getSettings().defaultProfileId, null)
  assert.equal(store.getRecentProjects()[0].name, 'ProjectA')
  assert.deepEqual(fs.readFileSync(settingsFile), damaged)
  assert.deepEqual(fs.readFileSync(recentFile), damaged)
  assert.deepEqual(store.getStorageDiagnostics().map((item: any) => [item.id, item.usingBackup]), [
    ['settings', true], ['recent', true]
  ])

  store.recoverStorage('settings')
  store.recoverStorage('recent')
  assert.deepEqual(fs.readFileSync(settingsFile), oldSettings)
  assert.deepEqual(fs.readFileSync(recentFile), oldRecent)
  assert.deepEqual(fs.readFileSync(`${settingsFile}.corrupt`), damaged)
  assert.deepEqual(fs.readFileSync(`${recentFile}.corrupt`), damaged)

  // A subsequent valid write refreshes a backup only from a valid complete primary.
  fs.writeFileSync(settingsFile, damaged)
  fs.writeFileSync(`${settingsFile}.bak`, priorSettings)
  store.saveSettings(validSettings('new'))
  assert.deepEqual(fs.readFileSync(settingsFile), Buffer.from(JSON.stringify(validSettings('new'), null, 2)))
  assert.deepEqual(fs.readFileSync(`${settingsFile}.corrupt`), damaged)
  assert.deepEqual(fs.readFileSync(`${settingsFile}.bak`), priorSettings)
  fs.writeFileSync(recentFile, damaged)
  fs.writeFileSync(`${recentFile}.bak`, priorRecent)
  store.addRecentProject({ path: 'C:\\ProjectC', name: 'ProjectC' })
  assert.deepEqual(fs.readFileSync(`${recentFile}.corrupt`), damaged)
  assert.deepEqual(fs.readFileSync(`${recentFile}.bak`), priorRecent)
})

test('ordinary missing files remain missing, while corrupt and unreadable history is explicit', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'missing-project')
  assert.equal(store.loadResult(projectPath), null)
  assert.deepEqual(store.getRecentProjects(), [])
  assert.deepEqual(store.getStorageDiagnostics(), [])

  const file = resultFile(userData, projectPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const corrupt = Buffer.from('{bad')
  fs.writeFileSync(file, corrupt)
  assert.throws(() => store.loadResult(projectPath), /历史结果文件已损坏/)
  assert.deepEqual(fs.readFileSync(file), corrupt)
  assert.equal(store.getStorageDiagnostics()[0].canRecover, false)
  fs.writeFileSync(`${file}.bak`, Buffer.from('{not a valid backup'))
  assert.throws(() => store.loadResult(projectPath), /历史结果文件已损坏/)
  const badBackupDiagnostic = store.getStorageDiagnostics()[0]
  assert.equal(badBackupDiagnostic.canRecover, false)
  assert.throws(() => store.recoverStorage(badBackupDiagnostic.id), /未找到可恢复的完整备份/)
  assert.deepEqual(fs.readFileSync(file), corrupt, 'failed recovery leaves the damaged source byte-identical')
  assert.deepEqual(fs.readFileSync(`${file}.bak`), Buffer.from('{not a valid backup'))

  const largeFile = resultFile(userData, path.join(userData, 'oversized-project'))
  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)
  fs.writeFileSync(largeFile, oversized)
  assert.throws(() => store.loadResult(path.join(userData, 'oversized-project')), /历史结果暂时无法读取/)
  assert.deepEqual(fs.readFileSync(largeFile), oversized)
})

test('malformed settings fall back to a valid backup and remain byte-identical until recovery', async () => {
  const { store, userData } = await makeHarness()
  const file = path.join(userData, 'settings.json')
  const invalid = Buffer.from(JSON.stringify({ profiles: [null], defaultProfileId: 'bad' }))
  const backup = Buffer.from(JSON.stringify(validSettings('backup')))
  fs.writeFileSync(file, invalid)
  fs.writeFileSync(`${file}.bak`, backup)

  assert.equal(store.getSettings().defaultProfileId, 'backup')
  assert.deepEqual(fs.readFileSync(file), invalid)
  const [diagnostic] = store.getStorageDiagnostics()
  assert.equal(diagnostic.id, 'settings')
  assert.equal(diagnostic.problem, 'corrupt')
  assert.equal(diagnostic.usingBackup, true)
  assert.equal(JSON.stringify(diagnostic).includes('private-key-marker'), false)
})

test('read descriptor close failures are reported as unreadable without changing source bytes', async () => {
  const { store, userData, faultFs } = await makeHarness()
  store.saveSettings(validSettings())
  const file = path.join(userData, 'settings.json')
  const before = fs.readFileSync(file)
  faultFs.arm('read-close')

  assert.deepEqual(store.getSettings(), { profiles: [], defaultProfileId: null })
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(store.getStorageDiagnostics()[0].problem, 'unreadable')
  assert.equal(faultFs.openReadDescriptors, 0, 'close should be retried best-effort so the descriptor does not leak')
})

test('storage diagnostics retain no more than 128 result subjects', async () => {
  const { store, userData } = await makeHarness()
  for (let index = 0; index < 130; index += 1) {
    const projectPath = path.join(userData, `project-${index}`)
    const file = resultFile(userData, projectPath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{broken')
    assert.throws(() => store.loadResult(projectPath), /历史结果文件已损坏/)
  }
  assert.equal(store.getStorageDiagnostics().length, 128)
})

test('old valid settings, recent entries, and version 1 results load without migration', async () => {
  const { store, userData } = await makeHarness()
  const oldSettings = Buffer.from(JSON.stringify({ profiles: [], defaultProfileId: null }))
  const oldRecent = Buffer.from(JSON.stringify([{ path: 'C:\\OldProject', name: 'OldProject', lastUsedAt: '2020-01-01T00:00:00.000Z' }]))
  fs.writeFileSync(path.join(userData, 'settings.json'), oldSettings)
  fs.writeFileSync(path.join(userData, 'recent.json'), oldRecent)
  const projectPath = path.join(userData, 'legacy-project')
  const result = sampleResult(projectPath, 'Legacy')
  const resultBytes = Buffer.from(JSON.stringify(result, null, 2))
  const file = resultFile(userData, projectPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, resultBytes)

  assert.equal(store.getSettings().defaultProfileId, null)
  assert.equal(store.getRecentProjects()[0].name, 'OldProject')
  assert.equal(store.loadResult(projectPath).projectName, 'Legacy')
  assert.deepEqual(fs.readFileSync(path.join(userData, 'settings.json')), oldSettings)
  assert.deepEqual(fs.readFileSync(path.join(userData, 'recent.json')), oldRecent)
  assert.deepEqual(fs.readFileSync(file), resultBytes)
})

test('bounded reads reject oversized data and orphan cleanup is capped to ten exact old target temps', async () => {
  const { atomic, userData } = await makeHarness()
  const target = path.join(userData, 'settings.json')
  const large = path.join(userData, 'large.json')
  fs.writeFileSync(large, Buffer.alloc(9))
  assert.equal(atomic.readBounded(large, 8).status, 'unreadable')
  assert.deepEqual(atomic.readBounded(path.join(userData, 'missing.json'), 8), { status: 'missing' })

  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await once(child, 'spawn')
  const deadPid = child.pid
  assert.ok(deadPid)
  const exited = once(child, 'exit')
  child.kill()
  await exited
  const base = path.basename(target)
  const tempFamilies = [`.${base}.projectlens-`, `.${base}.bak.projectlens-`, `.${base}.corrupt.projectlens-`]
  const allFamilies = tempFamilies.flatMap((prefix, familyIndex) =>
    Array.from({ length: [4, 3, 3][familyIndex] }, (_, index) => `${prefix}${deadPid}-${(familyIndex * 16 + index + 1).toString(16).padStart(24, 'a')}.tmp`)
  )
  for (const name of allFamilies) {
    const file = path.join(userData, name)
    fs.writeFileSync(file, 'orphan')
    fs.utimesSync(file, oldTime, oldTime)
  }
  assert.equal(atomic.cleanupOrphanTemps(target, Date.now()), 10, 'primary, backup, and corrupt temps share the cleanup limit')
  assert.equal(allFamilies.every((name) => !fs.existsSync(path.join(userData, name))), true)

  const cappedTemps = Array.from({ length: 12 }, (_, index) =>
    `.${base}.projectlens-${deadPid}-${(index + 100).toString(16).padStart(24, 'a')}.tmp`
  )
  for (const name of cappedTemps) {
    const file = path.join(userData, name)
    fs.writeFileSync(file, 'orphan')
    fs.utimesSync(file, oldTime, oldTime)
  }
  const foreign = path.join(userData, '.other.json.projectlens-123-aaaaaaaaaaaaaaaaaaaaaaaa.tmp')
  const malformed = path.join(userData, `.${base}.projectlens-123-short.tmp`)
  const young = path.join(userData, `.${base}.projectlens-${deadPid}-${'b'.repeat(24)}.tmp`)
  const live = path.join(userData, `.${base}.projectlens-${process.pid}-${'c'.repeat(24)}.tmp`)
  for (const file of [foreign, malformed, young, live]) fs.writeFileSync(file, 'keep')
  fs.utimesSync(live, oldTime, oldTime)

  assert.equal(atomic.cleanupOrphanTemps(target, Date.now()), 10)
  assert.equal(cappedTemps.filter((name) => fs.existsSync(path.join(userData, name))).length, 2)
  for (const file of [foreign, malformed, young, live]) assert.equal(fs.readFileSync(file, 'utf8'), 'keep')
})
