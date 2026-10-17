// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { after } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
// @ts-ignore TS5097 -- direct Node tests require the runtime .ts suffix.
import * as sharedTypes from '../../shared/types.ts'

const fixtureRoots: string[] = []
after(async () => {
  const allowedRoot = path.resolve(os.tmpdir())
  for (const root of fixtureRoots.splice(0)) {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(`${allowedRoot}${path.sep}`), `fixture cleanup must stay under temp directory: ${resolved}`)
    assert.ok(path.basename(resolved).startsWith('issue70-store-'), `unexpected fixture cleanup target: ${resolved}`)
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

async function makeHarness(): Promise<{ store: Record<string, (...args: any[]) => any>; root: string; userData: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue70-store-'))
  fixtureRoots.push(root)
  const userData = path.join(root, 'user-data')
  await fs.mkdir(userData)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const contractPath = path.resolve(here, '..', '..', 'shared', 'result-contract.ts')
  const contentReadPath = path.resolve(here, '..', '..', 'shared', 'content-read.ts')
  const storePath = path.resolve(here, 'store.ts')
  const options = { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
  const contentReadCode = ts.transpileModule(await fs.readFile(contentReadPath, 'utf8'), options).outputText
  const nativeRequire = (await import('node:module')).createRequire(import.meta.url)
  const evalModule = (code: string, filename: string, suppliedRequire: (id: string) => unknown): Record<string, any> => {
    const module = { exports: {} as Record<string, any> }
    const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) { ${code}\n})`, { filename }) as Function
    wrapper(module.exports, suppliedRequire, module, filename, path.dirname(filename))
    return module.exports
  }
  const contentReadModule = evalModule(contentReadCode, contentReadPath, (id) => {
    return nativeRequire(id)
  })
  const contractCode = ts.transpileModule(await fs.readFile(contractPath, 'utf8'), options).outputText
  const contractModule = { exports: {} as Record<string, unknown> }
  Object.assign(contractModule.exports, evalModule(contractCode, contractPath, (id) => {
    if (id === './content-read.ts') return contentReadModule
    throw new Error(`unexpected contract dependency: ${id}`)
  }))

  const storeCode = ts.transpileModule(await fs.readFile(storePath, 'utf8'), options).outputText
  const atomicPath = path.resolve(here, 'atomic-json.ts')
  const atomicCode = ts.transpileModule(await fs.readFile(atomicPath, 'utf8'), options).outputText
  const atomicModule = evalModule(atomicCode, atomicPath, nativeRequire)
  const storageContractPath = path.resolve(here, '..', '..', 'shared', 'storage-contract.ts')
  const storageContractCode = ts.transpileModule(await fs.readFile(storageContractPath, 'utf8'), options).outputText
  const storageContractModule = evalModule(storageContractCode, storageContractPath, nativeRequire)
  const displayNamePath = path.resolve(here, 'project-display-name.ts')
  const displayNameCode = ts.transpileModule(await fs.readFile(displayNamePath, 'utf8'), options).outputText
  const displayNameModule = evalModule(displayNameCode, displayNamePath, (id) => nativeRequire(id))
  const cryptoStub = { isAvailable: async () => true, encrypt: async (value: string) => Buffer.from(value), decrypt: async (value: Buffer) => value.toString() }
  const store = evalModule(storeCode, storePath, (id) => {
    if (id === 'electron') return { app: { getPath: (name: string) => {
      assert.equal(name, 'userData')
      return userData
    } } }
    if (id === '@shared/types') return sharedTypes
    if (id === '@shared/result-contract') return contractModule.exports
    if (id === '@shared/storage-contract') return storageContractModule
    if (id === './atomic-json') return atomicModule
    if (id === './project-display-name') return displayNameModule
    if (id === './credential-vault') return { encryptCredential: async (value: string) => ({ version: 1, ciphertext: Buffer.from(value).toString('base64') }), decryptCredential: async (value: any) => Buffer.from(value.ciphertext, 'base64').toString() }
    if (id === './native-credential-crypto') return { nativeCredentialCrypto: cryptoStub }
    return nativeRequire(id)
  })
  return { store, root, userData }
}

function legacyAffectedResult(projectPath: string): Record<string, any> {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectName: 'legacy-project',
    projectPath,
    granularity: 'fine',
    roleFocus: 'backend',
    profileId: 'p1',
    modelUsed: `${'n'.repeat(256)} / ${'m'.repeat(256)}`,
    projectSummary: '',
    sections: [{ id: 's1', title: 'Legacy', questions: [{ id: 'q1', question: 'Q', answer: '', followUps: [] }] }],
    glossary: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`term-${i}`, `definition-${i}`]))
  }
}

function storedResultFile(userData: string, projectPath: string): string {
  const hash = createHash('sha1').update(projectPath).digest('hex')
  return path.join(userData, 'projects', `${hash}.json`)
}

test('real store module loads old wide-glossary/profile result without migrating or rewriting it', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'legacy-project')
  const file = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const raw = JSON.stringify(legacyAffectedResult(projectPath), null, 2)
  await fs.writeFile(file, raw, 'utf8')

  const loaded = store.loadResult(projectPath)
  assert.equal(loaded.modelUsed.length, 515)
  assert.equal(Object.keys(loaded.glossary).length, 257)
  assert.equal(await fs.readFile(file, 'utf8'), raw, 'loading old result must not migrate or rewrite the historical file')
})

test('invalid save cannot overwrite prior result; invalid history is controlled and remains byte-identical', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'project')
  const file = storedResultFile(userData, projectPath)
  const valid = legacyAffectedResult(projectPath)
  store.saveResult(projectPath, valid)
  const before = await fs.readFile(file, 'utf8')

  assert.throws(() => store.saveResult(projectPath, { ...valid, invalidExtra: true }), /生成结果格式无效或超出支持范围，请重新生成。/)
  assert.equal(await fs.readFile(file, 'utf8'), before, 'invalid replacement must not overwrite the last valid result')

  const invalidRaw = JSON.stringify({ ...valid, invalidExtra: 'legacy payload' }, null, 2)
  await fs.writeFile(file, invalidRaw, 'utf8')
  assert.throws(() => store.loadResult(projectPath), /历史结果文件已损坏/)
  assert.ok(store.getStorageDiagnostics().some((diagnostic: any) =>
    diagnostic.kind === 'result' && diagnostic.projectPath === projectPath && diagnostic.problem === 'corrupt' && !diagnostic.canRecover
  ))
  assert.equal(await fs.readFile(file, 'utf8'), invalidRaw, 'invalid history remains unmodified for controlled recovery')
})

test('legacy empty names adapt only at lexical filesystem roots without rewriting the stored bytes', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.parse(path.resolve('.')).root
  const [recent] = store.addRecentProject({ path: projectPath, name: '' })
  assert.equal(recent.name, /^[A-Za-z]:[\\/]/.test(projectPath) ? `磁盘 ${projectPath[0].toUpperCase()}` : '文件系统根目录')
  const file = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const raw = JSON.stringify({ ...legacyAffectedResult(projectPath), projectName: '' }, null, 2)
  await fs.writeFile(file, raw, 'utf8')

  const previousMtime = (await fs.stat(file)).mtimeMs
  const loaded = store.loadResult(projectPath)
  assert.equal(loaded.projectName, /^[A-Za-z]:[\\/]/.test(projectPath) ? `磁盘 ${projectPath[0].toUpperCase()}` : '文件系统根目录')
  assert.equal(await fs.readFile(file, 'utf8'), raw)
  assert.equal((await fs.stat(file)).mtimeMs, previousMtime, 'legacy name adaptation is read-only')

  const invalidRootRaw = JSON.stringify({ ...legacyAffectedResult(projectPath), projectName: '', invalidExtra: true })
  await fs.writeFile(file, invalidRootRaw, 'utf8')
  assert.throws(() => store.loadResult(projectPath), /历史结果文件已损坏/)
  assert.ok(store.getStorageDiagnostics().some((diagnostic: any) =>
    diagnostic.kind === 'result' && diagnostic.projectPath === projectPath && diagnostic.problem === 'corrupt' && !diagnostic.canRecover
  ))
  assert.equal(await fs.readFile(file, 'utf8'), invalidRootRaw, 'legacy root adaptation must still reject other invalid fields')

  const invalidPaths = [path.join(projectPath, 'ordinary'), `${projectPath}folder${path.sep}..${path.sep}`]
  if (process.platform === 'win32') invalidPaths.push('\\\\?\\C:\\')
  for (const invalidPath of invalidPaths) {
    const invalidFile = storedResultFile(userData, invalidPath)
    const invalidRaw = JSON.stringify({ ...legacyAffectedResult(invalidPath), projectName: '' }, null, 2)
    await fs.writeFile(invalidFile, invalidRaw, 'utf8')
    assert.throws(() => store.loadResult(invalidPath), /历史结果文件已损坏/)
    assert.ok(store.getStorageDiagnostics().some((diagnostic: any) =>
      diagnostic.kind === 'result' && diagnostic.projectPath === invalidPath && diagnostic.problem === 'corrupt' && !diagnostic.canRecover
    ))
    assert.equal(await fs.readFile(invalidFile, 'utf8'), invalidRaw)
  }
})

test('legacy empty root name in a backup stays loadable and recoverable without rewriting backup bytes', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.parse(path.resolve('.')).root
  const file = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const backupRaw = JSON.stringify({ ...legacyAffectedResult(projectPath), projectName: '' }, null, 2)
  await fs.writeFile(`${file}.bak`, backupRaw, 'utf8')
  await fs.writeFile(file, '{ broken', 'utf8')

  const loaded = store.loadResult(projectPath)
  assert.notEqual(loaded.projectName, '')
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), backupRaw)
  const [diagnostic] = store.getStorageDiagnostics()
  assert.equal(diagnostic.usingBackup, true)
  await store.recoverStorage(diagnostic.id)
  assert.equal(await fs.readFile(file, 'utf8'), backupRaw, 'recovery copies the validated historical bytes unchanged')
  assert.notEqual(store.loadResult(projectPath).projectName, '')
})
