// Exercise filesystem-root naming through the real scan, approved content reader,
// generation, contract, export, and store modules using a strictly virtual FS.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const testFile = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(testFile), '..')
const externalRequire = createRequire(path.join(repoRoot, 'package.json'))

function createVirtualFileSystem(platformPath, rootPath) {
  const readmePath = platformPath.join(rootPath, 'README.md')
  const content = Buffer.from('# Synthetic filesystem-root fixture\n')
  const records = new Map([
    [rootPath, { kind: 'dir', dev: 1n, ino: 10n, size: 4096n }],
    [readmePath, { kind: 'file', dev: 1n, ino: 11n, size: BigInt(content.length) }]
  ])
  const allowedLookups = new Set([rootPath, readmePath, platformPath.join(rootPath, '.gitignore')])
  let fileOpens = 0

  function stats(record) {
    if (!record) {
      const error = new Error('virtual entry does not exist')
      error.code = 'ENOENT'
      throw error
    }
    return {
      dev: record.dev,
      ino: record.ino,
      size: record.size,
      mtimeNs: 1_000_000n,
      ctimeNs: 2_000_000n,
      mtimeMs: 1,
      ctimeMs: 2,
      isDirectory: () => record.kind === 'dir',
      isFile: () => record.kind === 'file',
      isSymbolicLink: () => false
    }
  }

  function checkedRecord(filePath) {
    const normalized = platformPath.normalize(filePath)
    assert.ok(allowedLookups.has(normalized), `unexpected virtual filesystem access: ${normalized}`)
    return records.get(normalized)
  }

  const fsPromises = {
    async realpath(filePath) {
      const normalized = platformPath.normalize(filePath)
      checkedRecord(normalized)
      return normalized
    },
    async lstat(filePath, options) {
      assert.equal(options?.bigint, true)
      return stats(checkedRecord(filePath))
    },
    async readdir(filePath, options) {
      assert.equal(platformPath.normalize(filePath), rootPath)
      checkedRecord(filePath)
      const entries = [{ name: 'README.md', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }]
      return options?.withFileTypes ? entries : entries.map((entry) => entry.name)
    },
    async open(filePath) {
      const normalized = platformPath.normalize(filePath)
      assert.equal(normalized, readmePath, 'the real content reader may open only the virtual README')
      const record = checkedRecord(normalized)
      assert.equal(record?.kind, 'file')
      fileOpens++
      return {
        async stat(options) {
          assert.equal(options?.bigint, true)
          return stats(record)
        },
        async read(buffer, offset, length, position) {
          const bytesRead = content.copy(buffer, offset, position, position + length)
          return { bytesRead, buffer }
        },
        async close() {}
      }
    }
  }

  return {
    fsPromises,
    fsSync: { constants: { O_RDONLY: 0, O_NOFOLLOW: 0 } },
    get fileOpens() { return fileOpens },
    readmePath
  }
}

function createVirtualStoreFs() {
  const files = new Map()
  return {
    files,
    fsSync: {
      readFileSync(filePath) {
        if (!files.has(filePath)) {
          const error = new Error('virtual store file missing')
          error.code = 'ENOENT'
          throw error
        }
        return files.get(filePath)
      },
      mkdirSync() {},
      writeFileSync(filePath, value) { files.set(filePath, String(value)) },
      rmSync(filePath) { files.delete(filePath) }
    }
  }
}

function createSourceLoader({ platformPath, platform, virtualFs, virtualStore }) {
  const cache = new Map()
  const virtualUserData = platform === 'win32' ? 'Z:\\virtual-user-data' : '/virtual-user-data'

  function resolveSource(parentFile, specifier) {
    let sourcePath
    if (specifier.startsWith('@shared/')) {
      sourcePath = path.join(repoRoot, 'shared', specifier.slice('@shared/'.length))
    } else if (specifier.startsWith('.')) {
      sourcePath = path.resolve(path.dirname(parentFile), specifier)
    } else {
      return null
    }
    for (const candidate of [sourcePath, `${sourcePath}.ts`, `${sourcePath}.mjs`, path.join(sourcePath, 'index.ts')]) {
      try {
        if (externalRequire('node:fs').statSync(candidate).isFile()) return candidate
      } catch {}
    }
    throw new Error(`Cannot resolve source module ${specifier} from ${parentFile}`)
  }

  function loadModule(sourcePath) {
    const absolutePath = path.resolve(sourcePath)
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports
    const module = { exports: {} }
    cache.set(absolutePath, module)
    const source = externalRequire('node:fs').readFileSync(absolutePath, 'utf8')
    const js = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText

    const localRequire = (specifier) => {
      if (specifier === 'node:path') return platformPath
      if (specifier === 'node:fs/promises') return virtualFs.fsPromises
      if (specifier === 'node:fs') return { ...virtualFs.fsSync, ...virtualStore?.fsSync }
      if (specifier === 'node:crypto') return externalRequire(specifier)
      if (specifier === 'electron') return { app: { getPath: (name) => {
        assert.equal(name, 'userData')
        return virtualUserData
      } } }
      const resolved = resolveSource(absolutePath, specifier)
      return resolved ? loadModule(resolved) : externalRequire(specifier)
    }

    const factory = vm.runInThisContext(
      `(function(exports, require, module, __filename, __dirname, process) { ${js}\n})`,
      { filename: absolutePath }
    )
    factory(module.exports, localRequire, module, absolutePath, path.dirname(absolutePath), {
      platform,
      env: {},
      on() {}
    })
    return module.exports
  }

  return { loadModule }
}

function mockQuestionResponse() {
  return {
    choices: [{ message: { content: JSON.stringify({
      projectSummary: 'Synthetic project used to verify root display names.',
      sections: [{
        title: 'Project overview',
        summary: 'Questions about the synthetic project.',
        questions: Array.from({ length: 10 }, (_, index) => ({
          question: `How does synthetic behavior ${index + 1} work?`,
          answer: `It is represented in README.md, item ${index + 1}.`,
          followUps: []
        }))
      }],
      glossary: {}
    }) } }]
  }
}

async function exerciseRoot({ platform, platformPath, rootPath, expectedName }) {
  const virtualFs = createVirtualFileSystem(platformPath, platformPath.normalize(rootPath))
  const virtualStore = createVirtualStoreFs()
  const loader = createSourceLoader({ platformPath, platform, virtualFs, virtualStore })
  const scanner = loader.loadModule(path.join(repoRoot, 'electron', 'services', 'scanner.ts'))
  const generator = loader.loadModule(path.join(repoRoot, 'electron', 'services', 'generator.ts'))
  const snapshotModule = loader.loadModule(path.join(repoRoot, 'electron', 'services', 'project-snapshot.ts'))
  const store = loader.loadModule(path.join(repoRoot, 'electron', 'services', 'store.ts'))
  const resultContract = loader.loadModule(path.join(repoRoot, 'shared', 'result-contract.ts'))
  const ipcValidation = loader.loadModule(path.join(repoRoot, 'electron', 'services', 'ipc-validation.ts'))
  const markdownExport = loader.loadModule(path.join(repoRoot, 'electron', 'services', 'markdown-export.ts'))
  const ipc = loader.loadModule(path.join(repoRoot, 'shared', 'ipc.ts'))
  const scan = await scanner.scanProject(rootPath)

  assert.equal(scan.name, expectedName)
  assert.equal(scan.tree.name, expectedName)
  assert.equal(scan.root, rootPath, 'display-name repair must leave the selected project path untouched')
  const snapshot = await snapshotModule.captureProjectSnapshot(scan)
  assert.equal(snapshot.identity.realPath, platformPath.normalize(rootPath))
  assert.equal(snapshot.identity.key, platform === 'win32' ? platformPath.normalize(rootPath).toLowerCase() : platformPath.normalize(rootPath))

  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  const requestMessages = []
  globalThis.fetch = async (_input, init) => {
    fetchCalls++
    const body = JSON.parse(String(init?.body))
    requestMessages.push(...(body.messages ?? []).map((message) => String(message.content ?? '')))
    return new Response(JSON.stringify(mockQuestionResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  try {
    const profile = { id: 'root-test', name: 'Synthetic', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic-key', model: 'mock' }
    const result = await generator.generateInterview({
      scan,
      granularity: 'coarse',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress() {}
    })

    assert.equal(fetchCalls, 1, 'valid root identity should reach the mocked model once')
    assert.ok(requestMessages.join('\n').includes(`项目根目录：${expectedName}`))
    assert.ok(virtualFs.fileOpens > 0, 'generation must consume content through the real approved reader')
    assert.equal(result.projectName, expectedName)
    assert.equal(result.projectPath, rootPath)
    assert.equal(result.sections.reduce((count, section) => count + section.questions.length, 0), 10)
    assert.doesNotThrow(() => resultContract.assertInterviewResultContract(result))
    assert.doesNotThrow(() => ipcValidation.validateIpcArgs(ipc.IPC.exportMarkdown, [result]))

    const markdown = markdownExport.resultToMarkdown(result)
    assert.ok(markdown.includes(expectedName))
    assert.ok(markdown.includes('README.md'))

    store.saveResult(rootPath, result)
    const loaded = store.loadResult(rootPath)
    assert.equal(loaded?.projectName, expectedName)
    assert.equal(loaded?.projectPath, rootPath)
    assert.equal(loaded?.projectName, scan.name, 'overview and result use the same name field')
    const virtualUserData = platform === 'win32' ? 'Z:\\virtual-user-data' : '/virtual-user-data'
    const resultHash = createHash('sha1').update(rootPath).digest('hex')
    const expectedResultFile = platformPath.join(virtualUserData, 'projects', `${resultHash}.json`)
    assert.deepEqual([...virtualStore.files.keys()], [expectedResultFile], 'store key remains derived from the original project path')

    for (const invalidName of ['', '/', 'C:\\']) {
      fetchCalls = 0
      await assert.rejects(
        generator.generateInterview({
          scan: { ...scan, name: invalidName },
          granularity: 'coarse',
          roleFocus: 'backend',
          profile,
          signal: new AbortController().signal,
          onProgress() {}
        }),
        /生成结果格式无效/
      )
      assert.equal(fetchCalls, 0, `invalid project identity ${JSON.stringify(invalidName)} must fail before fetch`)
    }

    fetchCalls = 0
    await assert.rejects(
      generator.generateInterview({
        scan: { ...scan, root: '' },
        granularity: 'coarse',
        roleFocus: 'backend',
        profile,
        signal: new AbortController().signal,
        onProgress() {}
      }),
      /生成结果格式无效/
    )
    assert.equal(fetchCalls, 0, 'invalid project path must fail before fetch')
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('filesystem root names survive scan, real content reading, generation, IPC, export, and store', async () => {
  await exerciseRoot({ platform: 'win32', platformPath: path.win32, rootPath: 'C:\\', expectedName: '磁盘 C' })
  await exerciseRoot({ platform: 'linux', platformPath: path.posix, rootPath: '/', expectedName: '文件系统根目录' })
})

test('ordinary Windows project directory keeps its basename', async () => {
  const platformPath = path.win32
  const rootPath = 'C:\\demo'
  const virtualFs = createVirtualFileSystem(platformPath, rootPath)
  const loader = createSourceLoader({ platformPath, platform: 'win32', virtualFs, virtualStore: createVirtualStoreFs() })
  const scanner = loader.loadModule(path.join(repoRoot, 'electron', 'services', 'scanner.ts'))
  const scan = await scanner.scanProject(rootPath)
  assert.equal(scan.name, 'demo')
  assert.equal(scan.tree.name, 'demo')
  assert.equal(scan.root, rootPath)
})
