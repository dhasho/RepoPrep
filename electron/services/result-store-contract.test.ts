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
// @ts-ignore TS5097 -- direct Node tests require the runtime .ts suffix.
import { resultToMarkdown } from './markdown-export.ts'

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

async function makeHarness(existingUserData?: string): Promise<{ store: Record<string, (...args: any[]) => any>; root: string; userData: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue70-store-'))
  fixtureRoots.push(root)
  const userData = existingUserData ?? path.join(root, 'user-data')
  await fs.mkdir(userData, { recursive: true })
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

function legacyGithubMetadata(): Record<string, unknown> {
  return {
    login: 'legacy-user',
    name: 'Legacy Repository',
    repoOwner: 'legacy-owner',
    repo: 'legacy-repo',
    repoHtmlUrl: 'https://example.invalid/legacy-owner/legacy-repo',
    defaultBranch: 'main',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    stats: { commits: 1 },
    commits: [],
    pullRequests: [],
    issues: [],
    reviewedPullRequests: [],
    contextText: 'synthetic historical repository context',
    truncated: true
  }
}

function storedResultFile(userData: string, projectPath: string): string {
  const hash = createHash('sha1').update(projectPath).digest('hex')
  return path.join(userData, 'projects', `${hash}.json`)
}

function storedHistoryDir(userData: string, projectPath: string): string {
  const hash = createHash('sha1').update(projectPath).digest('hex')
  return path.join(userData, 'projects', `${hash}.history`)
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate)
    return true
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
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

test('legacy GitHub result metadata is normalized only during bounded history reads', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'legacy-github-project')
  const file = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const result = { ...legacyAffectedResult(projectPath), github: legacyGithubMetadata() }
  const raw = JSON.stringify(result, null, 2)
  await fs.writeFile(file, raw, 'utf8')

  const loaded = store.loadResult(projectPath)
  assert.equal('github' in loaded, false, 'obsolete repository data is omitted from the current result')
  assert.equal(loaded.projectName, 'legacy-project')
  assert.equal(await fs.readFile(file, 'utf8'), raw, 'history normalization must not rewrite the source file')

  assert.throws(() => store.saveResult(projectPath, result), /生成结果格式无效或超出支持范围，请重新生成。/)
  assert.equal(await fs.readFile(file, 'utf8'), raw, 'strict generated-result validation must reject legacy fields')
})

test('legacy GitHub backup remains readable and explicit recovery preserves its original bytes', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'legacy-github-backup')
  const file = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const backupRaw = JSON.stringify({ ...legacyAffectedResult(projectPath), github: legacyGithubMetadata() }, null, 2)
  await fs.writeFile(`${file}.bak`, backupRaw, 'utf8')
  await fs.writeFile(file, '{ broken', 'utf8')

  const loaded = store.loadResult(projectPath)
  assert.equal('github' in loaded, false)
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), backupRaw, 'backup reads must not rewrite historical bytes')
  const [diagnostic] = store.getStorageDiagnostics()
  assert.equal(diagnostic.usingBackup, true)
  await store.recoverStorage(diagnostic.id)
  assert.equal(await fs.readFile(file, 'utf8'), backupRaw, 'recovery copies the original validated backup bytes')
  assert.equal('github' in store.loadResult(projectPath), false)
})

test('history with unrelated invalid fields or an unrecognized GitHub shape remains corrupt', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'invalid-legacy-github')
  const file = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(file), { recursive: true })

  for (const [label, extra] of [
    ['unrelated field', { github: legacyGithubMetadata(), unrelated: true }],
    ['unknown github field', { github: { ...legacyGithubMetadata(), accessToken: 'synthetic-secret' } }],
    ['malformed github field', { github: { ...legacyGithubMetadata(), commits: 'not-a-list' } }]
  ] as const) {
    const raw = JSON.stringify({ ...legacyAffectedResult(projectPath), ...extra }, null, 2)
    await fs.writeFile(file, raw, 'utf8')
    assert.throws(() => store.loadResult(projectPath), /历史结果文件已损坏/, label)
    assert.equal(await fs.readFile(file, 'utf8'), raw, `${label} must remain byte-identical`)
  }
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

test('real result store preserves legacy source fields so historical answers remain readable after source deletion', async () => {
  const { store, root } = await makeHarness()
  const projectPath = path.join(root, 'synthetic-project')
  const sourceFile = path.join(projectPath, 'src', 'module.ts')
  const excerpt = 'export const value = "[REDACTED]";\nreturn value'
  const rawSecret = 'synthetic-api-secret'
  const snapshotHash = createHash('sha256').update('synthetic redacted snapshot', 'utf8').digest('hex')
  const evidence = () => ({
    sourceId: 'synthetic-source-1', snapshotHash, path: 'src/module.ts',
    startLine: 12, endLine: 13, excerpt
  })
  const result = {
    ...legacyAffectedResult(projectPath),
    sections: [{ id: 's1', title: 'Synthetic source', questions: [
      { id: 'q1', question: 'Q1', answer: 'A1', followUps: [], sourceEvidence: [evidence()] },
      { id: 'q2', question: 'Q2', answer: 'A2', followUps: [], sourceEvidence: [evidence()] }
    ] }],
    sourceEvidenceSummary: { asked: 2, accepted: 2, rejected: 0, retained: 2 }
  }

  await fs.mkdir(path.dirname(sourceFile), { recursive: true })
  await fs.writeFile(sourceFile, `export const token = "${rawSecret}";\nreturn value`, 'utf8')
  store.saveResult(projectPath, result)
  const beforeChange = store.loadResult(projectPath)
  assert.deepEqual(beforeChange.sections[0].questions.map((question: any) => question.sourceEvidence), [
    [evidence()], [evidence()]
  ])
  await fs.writeFile(sourceFile, 'changed after generation\n', 'utf8')
  await fs.rm(sourceFile)

  const reloaded = store.loadResult(projectPath)
  assert.ok(reloaded)
  assert.deepEqual(reloaded.sections[0].questions.map((question: any) => question.sourceEvidence), [
    [evidence()], [evidence()]
  ], 'history retains cloned evidence independently from current source files')
  const markdown = resultToMarkdown(reloaded)
  assert.equal(markdown.split(snapshotHash).length - 1, 0, 'legacy hashes are not repeated in Markdown exports')
  assert.equal(markdown.split(excerpt).length - 1, 0, 'legacy source excerpts are not exported')
  assert.ok(markdown.includes('A1'))
  assert.ok(markdown.includes('A2'))
  assert.ok(!markdown.includes('changed after generation'))
  assert.ok(!JSON.stringify(reloaded).includes(rawSecret), 'saved history contains only the redacted excerpt')
  assert.ok(!markdown.includes(rawSecret), 'Markdown never exports the raw source secret')
})

test('real result storage retains successful generation scope for latest, list, history, and Markdown', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'generation-scope')
  const generationDiagnostics = {
    version: 1,
    status: 'succeeded',
    contextStrategy: 'structure-v1',
    tokenEstimateMethod: 'mixed-text-v1',
    estimatedInputTokens: 1200,
    inputTokenBudget: 16_000,
    reservedOutputTokens: 16_384,
    actualUsage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    usageComplete: false,
    requestCount: 2,
    repairRequestCount: 1,
    compensationRequestCount: 0,
    contextBuildMs: 15,
    modelMs: 800,
    totalMs: 820,
    selectedFiles: 4,
    selectedRegions: 7,
    omittedFiles: 2
  }
  const result = { ...legacyAffectedResult(projectPath), generationDiagnostics }
  const id = store.saveResult(projectPath, result)
  assert.deepEqual(store.loadResult(projectPath).generationDiagnostics, generationDiagnostics)
  assert.ok(store.listAnalyses(projectPath).items.some((item: { id: string }) => item.id === id))
  assert.deepEqual(store.loadAnalysis(projectPath, id).generationDiagnostics, generationDiagnostics)
  const markdown = resultToMarkdown(store.loadAnalysis(projectPath, id))
  assert.ok(!markdown.includes('分析范围与用量'))
  assert.ok(!markdown.includes('服务商部分回执'))
  assert.ok(!markdown.includes(projectPath))
  assert.deepEqual(store.loadResult(projectPath).generationDiagnostics, store.loadAnalysis(projectPath, id).generationDiagnostics)
  assert.ok(!JSON.stringify(generationDiagnostics).includes('profileId'))
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

test('saved analyses retain distinct granularities and load after replacing the latest result', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'analysis-history-project')
  const first = { ...legacyAffectedResult(projectPath), createdAt: '2026-02-01T08:30:00+08:00', granularity: 'fine', roleFocus: 'backend' }
  const second = { ...legacyAffectedResult(projectPath), createdAt: '2026-02-02T00:00:00.000Z', granularity: 'coarse', roleFocus: 'frontend', projectSummary: 'second analysis' }
  const firstId = store.saveResult(projectPath, first)
  const secondId = store.saveResult(projectPath, second)
  assert.match(firstId, /^[a-f0-9]{64}$/)
  assert.match(secondId, /^[a-f0-9]{64}$/)
  assert.notEqual(firstId, secondId)
  assert.equal(store.loadResult(projectPath).projectSummary, 'second analysis', 'legacy latest-result API still returns the latest version')

  const page = store.listAnalyses(projectPath)
  assert.deepEqual(page.items.map((item: any) => item.id), [secondId, firstId])
  assert.deepEqual(page.items.map((item: any) => [item.granularity, item.roleFocus]), [['coarse', 'frontend'], ['fine', 'backend']])
  assert.equal(page.nextCursor, null)
  assert.equal(store.loadAnalysis(projectPath, firstId).createdAt, first.createdAt)

  const historyDir = storedHistoryDir(userData, projectPath)
  const reloaded = await fs.readFile(path.join(historyDir, (await fs.readdir(historyDir))[0]), 'utf8')
  assert.ok(reloaded.includes('2026-02-01T08:30:00+08:00'), 'archive retains the original serialized record')
})

test('valid legacy result bytes are archived before overwrite and archive failure leaves latest untouched', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'archive-bytes-project')
  const file = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const legacy = { ...legacyAffectedResult(projectPath), github: legacyGithubMetadata() }
  const originalBytes = JSON.stringify(legacy, null, 2)
  await fs.writeFile(file, originalBytes, 'utf8')
  const normalized = store.loadResult(projectPath)
  const id = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
  const replacement = { ...legacyAffectedResult(projectPath), createdAt: '2026-03-01T00:00:00.000Z', projectSummary: 'new' }
  store.saveResult(projectPath, replacement)
  const archive = path.join(storedHistoryDir(userData, projectPath), (await fs.readdir(storedHistoryDir(userData, projectPath)))[0])
  assert.equal(path.basename(archive).includes(id), true)
  assert.equal(await fs.readFile(archive, 'utf8'), originalBytes, 'legacy github bytes are preserved exactly')
  assert.equal(store.loadAnalysis(projectPath, id).projectSummary, '')

  const latestBefore = await fs.readFile(file, 'utf8')
  await fs.rm(storedHistoryDir(userData, projectPath), { recursive: true })
  await fs.writeFile(storedHistoryDir(userData, projectPath), 'blocking file')
  assert.throws(() => store.saveResult(projectPath, { ...replacement, projectSummary: 'must not save' }), /保存结果失败/)
  assert.equal(await fs.readFile(file, 'utf8'), latestBefore, 'archive failure happens before replacing the current result')
})

test('analysis pages paginate stable ids and a missing cursor returns an empty page', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'many-analysis-history')
  const ids: string[] = []
  for (let index = 0; index < 53; index += 1) {
    ids.push(store.saveResult(projectPath, {
      ...legacyAffectedResult(projectPath),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      granularity: (['coarse', 'medium', 'fine'] as const)[index % 3],
      projectSummary: `analysis ${index}`
    }))
  }
  const first = store.listAnalyses(projectPath)
  assert.equal(first.items.length, 50)
  assert.ok(first.nextCursor)
  const second = store.listAnalyses(projectPath, first.nextCursor)
  assert.equal(second.items.length, 3)
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...first.items, ...second.items].map((item: any) => item.id)).size, 53)
  assert.equal(store.listAnalyses(projectPath, 'f'.repeat(64)).items.length, 0)
  assert.equal(store.loadAnalysis(projectPath, ids[0]).projectSummary, 'analysis 0')
})

test('corrupt archived record does not prevent loading other analysis records', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'one-corrupt-analysis')
  const first = store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), projectSummary: 'first' })
  const second = store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), createdAt: '2026-04-01T00:00:00.000Z', projectSummary: 'second' })
  const rows = store.listAnalyses(projectPath).items
  const badRow = rows.find((row: any) => row.id === first)
  const historyDir = storedHistoryDir(userData, projectPath)
  const badName = (await fs.readdir(historyDir)).find((name) => name.includes(first))!
  await fs.writeFile(path.join(historyDir, badName), '{ broken', 'utf8')
  assert.equal(store.listAnalyses(projectPath).items.length, 2, 'bad archive metadata does not hide healthy summaries')
  assert.throws(() => store.loadAnalysis(projectPath, first), /历史结果文件已损坏/)
  assert.equal(store.loadAnalysis(projectPath, second).projectSummary, 'second')
  assert.equal(badRow.id, first)
})

test('recent project capacity grows to 200 and rejects additions without evicting saved projects', async () => {
  const { store, userData } = await makeHarness()
  for (let index = 0; index < 200; index += 1) {
    store.addRecentProject({ path: path.join(userData, `recent-${index}`), name: `Project ${index}` })
  }
  assert.equal(store.getRecentProjects().length, 200)
  assert.throws(() => store.addRecentProject({ path: path.join(userData, 'recent-overflow'), name: 'Overflow' }), /保存本地数据失败/)
  const retained = store.getRecentProjects()
  assert.equal(retained.length, 200)
  assert.ok(retained.some((project: any) => project.path.endsWith('recent-0')))
  assert.ok(!retained.some((project: any) => project.path.endsWith('recent-overflow')))
})

test('corrupt latest with valid backup lists and loads the backup id, then archives exact backup bytes before save', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'corrupt-latest-valid-backup')
  const latestFile = storedResultFile(userData, projectPath)
  await fs.mkdir(path.dirname(latestFile), { recursive: true })
  const backup = { ...legacyAffectedResult(projectPath), createdAt: '2026-05-01T01:02:03.000Z', projectSummary: 'backup value' }
  const backupBytes = JSON.stringify(backup, null, 2)
  await fs.writeFile(`${latestFile}.bak`, backupBytes, 'utf8')
  await fs.writeFile(latestFile, '{ latest is corrupt', 'utf8')
  const backupId = createHash('sha256').update(JSON.stringify(backup)).digest('hex')

  assert.equal(store.listAnalyses(projectPath).items[0].id, backupId)
  assert.equal(store.loadAnalysis(projectPath, backupId).projectSummary, 'backup value')
  const replacement = { ...legacyAffectedResult(projectPath), createdAt: '2026-05-02T00:00:00.000Z', projectSummary: 'replacement' }
  store.saveResult(projectPath, replacement)
  const historyDir = storedHistoryDir(userData, projectPath)
  const archiveName = (await fs.readdir(historyDir)).find((name) => name.includes(backupId))!
  assert.equal(await fs.readFile(path.join(historyDir, archiveName), 'utf8'), backupBytes)
  assert.equal(store.loadAnalysis(projectPath, backupId).projectSummary, 'backup value')

  const blockedPath = path.join(userData, 'corrupt-latest-archive-blocked')
  const blockedFile = storedResultFile(userData, blockedPath)
  await fs.mkdir(path.dirname(blockedFile), { recursive: true })
  await fs.writeFile(`${blockedFile}.bak`, backupBytes, 'utf8')
  const corruptBytes = '{ preserve this corrupt latest'
  await fs.writeFile(blockedFile, corruptBytes, 'utf8')
  await fs.writeFile(storedHistoryDir(userData, blockedPath), 'blocking file')
  assert.throws(() => store.saveResult(blockedPath, { ...replacement, projectPath: blockedPath }), /保存结果失败/)
  assert.equal(await fs.readFile(blockedFile, 'utf8'), corruptBytes, 'archive failure leaves the latest bytes unchanged')
  assert.equal(await fs.readFile(`${blockedFile}.bak`, 'utf8'), backupBytes, 'archive failure leaves backup bytes unchanged')
  assert.equal(store.loadResult(projectPath).projectSummary, 'replacement')
})

test('corrupt latest and backup do not hide healthy archived analyses', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'bad-latest-and-backup')
  const first = store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), projectSummary: 'archived one' })
  const second = store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), createdAt: '2026-06-01T00:00:00.000Z', projectSummary: 'archived two' })
  store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), createdAt: '2026-06-02T00:00:00.000Z', projectSummary: 'latest' })
  const latestFile = storedResultFile(userData, projectPath)
  await fs.writeFile(latestFile, '{ damaged primary', 'utf8')
  await fs.writeFile(`${latestFile}.bak`, '{ damaged backup', 'utf8')

  const ids = store.listAnalyses(projectPath).items.map((item: any) => item.id)
  assert.deepEqual(new Set(ids), new Set([first, second]))
  assert.equal(store.loadAnalysis(projectPath, first).projectSummary, 'archived one')
  assert.equal(store.loadAnalysis(projectPath, second).projectSummary, 'archived two')
})

test('history data reloads from the same userData directory with a fresh store instance', async () => {
  const firstHarness = await makeHarness()
  const projectPath = path.join(firstHarness.userData, 'restart-history')
  const first = firstHarness.store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), projectSummary: 'before restart' })
  firstHarness.store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), createdAt: '2026-07-01T00:00:00.000Z', projectSummary: 'after restart' })

  const restarted = await makeHarness(firstHarness.userData)
  assert.equal(restarted.store.loadAnalysis(projectPath, first).projectSummary, 'before restart')
  assert.equal(restarted.store.listAnalyses(projectPath).items.length, 2)
  assert.equal(restarted.store.loadResult(projectPath).projectSummary, 'after restart')
})

test('analysis identifiers are scoped to their project storage key', async () => {
  const { store, userData } = await makeHarness()
  const projectA = path.join(userData, 'project-a')
  const projectB = path.join(userData, 'project-b')
  const id = store.saveResult(projectA, { ...legacyAffectedResult(projectA), projectSummary: 'project A' })
  assert.equal(store.loadAnalysis(projectB, id), null)
  assert.equal(store.listAnalyses(projectB).items.length, 0)
})

test('deleting a result removes current, archived, and stray history files while preserving other projects', async () => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'delete-all-analysis-history')
  const otherProject = path.join(userData, 'keep-analysis-history')
  const oldId = store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), projectSummary: 'old' })
  const latestId = store.saveResult(projectPath, { ...legacyAffectedResult(projectPath), createdAt: '2026-08-01T00:00:00.000Z', projectSummary: 'latest' })
  const otherId = store.saveResult(otherProject, { ...legacyAffectedResult(otherProject), projectSummary: 'keep' })
  const latestFile = storedResultFile(userData, projectPath)
  const historyDir = storedHistoryDir(userData, projectPath)
  await fs.writeFile(`${latestFile}.corrupt`, '{ damaged copy', 'utf8')
  await fs.writeFile(path.join(historyDir, 'unindexed-corrupt.json'), '{ invalid archive', 'utf8')
  await fs.writeFile(path.join(historyDir, '.atomic-leftover.tmp'), 'partial write', 'utf8')

  store.deleteResult(projectPath)

  assert.equal(store.loadResult(projectPath), null)
  assert.deepEqual(store.listAnalyses(projectPath).items, [])
  for (const id of [oldId, latestId]) assert.equal(store.loadAnalysis(projectPath, id), null)
  assert.deepEqual(await Promise.all([latestFile, `${latestFile}.bak`, `${latestFile}.corrupt`, historyDir].map(pathExists)), [false, false, false, false])
  assert.equal(store.listAnalyses(otherProject).items[0].id, otherId)
  assert.equal(store.loadAnalysis(otherProject, otherId).projectSummary, 'keep')
  store.deleteResult(projectPath)
  assert.equal(store.loadResult(projectPath), null, 'repeated deletion remains idempotent')

  store.addRecentProject({ path: otherProject, name: 'keep' })
  store.removeRecentProject(otherProject)
  assert.equal(store.loadAnalysis(otherProject, otherId).projectSummary, 'keep', 'removing a recent entry leaves stored results intact')
})

test('result deletion rejects unsafe history entries and linked storage roots without touching outside sentinels', async (context) => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'delete-linked-history')
  const historyDir = storedHistoryDir(userData, projectPath)
  const externalDir = path.join(userData, 'outside-history')
  const sentinel = path.join(externalDir, 'sentinel.txt')
  await fs.mkdir(externalDir)
  await fs.writeFile(sentinel, 'keep', 'utf8')
  await fs.mkdir(historyDir, { recursive: true })
  const nestedSentinel = path.join(historyDir, 'unexpected-child', 'sentinel.txt')
  await fs.mkdir(path.dirname(nestedSentinel))
  await fs.writeFile(nestedSentinel, 'keep nested', 'utf8')
  assert.throws(() => store.deleteResult(projectPath), /删除历史结果未完成/)
  assert.equal(await fs.readFile(nestedSentinel, 'utf8'), 'keep nested', 'unexpected nested trees are never recursively removed')
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep')

  await fs.rm(path.join(historyDir, 'unexpected-child'), { recursive: true })
  const linkedEntry = path.join(historyDir, 'linked-sentinel')
  try {
    await fs.symlink(sentinel, linkedEntry, 'file')
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(code ?? '')) context.diagnostic(`history entry symlink check skipped (${code})`)
    else throw error
  }
  if (await pathExists(linkedEntry)) {
    assert.throws(() => store.deleteResult(projectPath), /删除历史结果未完成/)
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep', 'linked history entries are never followed')
    await fs.rm(linkedEntry)
  }

  await fs.rm(historyDir, { recursive: true })
  try {
    await fs.symlink(externalDir, historyDir, 'junction')
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(code ?? '')) {
      context.diagnostic(`history junction check skipped (${code})`)
    } else throw error
  }
  if (await pathExists(historyDir)) {
    assert.throws(() => store.deleteResult(projectPath), /删除历史结果未完成/)
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep')
    await fs.rm(historyDir, { recursive: true, force: true })
  }

  const projects = path.join(userData, 'projects')
  const externalProjects = path.join(userData, 'outside-projects')
  await fs.mkdir(externalProjects)
  const hash = createHash('sha1').update(projectPath).digest('hex')
  const externalResult = path.join(externalProjects, `${hash}.json`)
  await fs.writeFile(externalResult, 'outside result sentinel', 'utf8')
  await fs.mkdir(path.join(externalProjects, `${hash}.history`))
  await fs.writeFile(path.join(externalProjects, `${hash}.history`, 'sentinel.txt'), 'outside archive sentinel', 'utf8')
  const linkedProjects = path.join(userData, 'projects-linked')
  await fs.rename(projects, linkedProjects)
  try {
    await fs.symlink(externalProjects, projects, 'junction')
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(code ?? '')) {
      context.diagnostic(`projects root junction check skipped (${code})`)
      return
    } else throw error
  }
  assert.throws(() => store.deleteResult(projectPath), /删除历史结果未完成/)
  assert.equal(await fs.stat(projects).then((stat) => stat.isDirectory()), true)
  assert.equal(await fs.readFile(externalResult, 'utf8'), 'outside result sentinel')
  assert.equal(await fs.readFile(path.join(externalProjects, `${hash}.history`, 'sentinel.txt'), 'utf8'), 'outside archive sentinel')
})

test('history junctions and entry symlinks are not followed outside the private store', async (context) => {
  const { store, userData } = await makeHarness()
  const projectPath = path.join(userData, 'history-links')
  const external = path.join(userData, 'external-history')
  await fs.mkdir(external)
  const outside: Record<string, any> = { ...legacyAffectedResult(projectPath), projectSummary: 'external record' }
  const id = createHash('sha256').update(JSON.stringify(outside)).digest('hex')
  const outsideName = `${Date.parse(outside.createdAt)}-${outside.granularity}-${outside.roleFocus}-${id}.json`
  await fs.writeFile(path.join(external, outsideName), JSON.stringify(outside, null, 2), 'utf8')
  const linkedHistory = storedHistoryDir(userData, projectPath)
  await fs.mkdir(path.dirname(linkedHistory), { recursive: true })
  try {
    await fs.symlink(external, linkedHistory, 'junction')
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(code ?? '')) {
      context.skip(`platform does not permit creating a junction/symlink fixture (${code})`)
      return
    }
    throw error
  }
  assert.throws(() => store.listAnalyses(projectPath), /历史结果暂时无法读取/)
  assert.throws(() => store.loadAnalysis(projectPath, id), /历史结果暂时无法读取/)

  await fs.rm(linkedHistory, { recursive: true, force: true })
  await fs.mkdir(linkedHistory)
  try {
    await fs.symlink(path.join(external, outsideName), path.join(linkedHistory, outsideName), 'file')
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(code ?? '')) {
      context.diagnostic(`file symlink check skipped (${code}); directory junction rejection was verified`)
      return
    }
    throw error
  }
  assert.equal(store.listAnalyses(projectPath).items.length, 0)
  assert.equal(store.loadAnalysis(projectPath, id), null)
})
