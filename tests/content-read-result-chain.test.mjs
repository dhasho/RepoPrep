// Real generation result carried through contract validation, IPC, export and the built ResultPage.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as sharedTypes from '../shared/types.ts'
import { IPC } from '../shared/ipc.ts'
import { assertInterviewResultContract } from '../shared/result-contract.ts'
import { resultToMarkdown } from '../electron/services/markdown-export.ts'
import { validateIpcArgs } from '../electron/services/ipc-validation.ts'
import { generateInterview } from '../electron/services/generator.ts'
import { scanProject } from '../electron/services/scanner.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '..', '.render-test', 'result-page.cjs')

async function renderResultPage(result) {
  await fs.access(bundlePath)
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { exportMarkdown: async () => ({ ok: true, message: 'ok' }) } }
  })
  try {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const requireBundle = createRequire(import.meta.url)
    const resolved = requireBundle.resolve(bundlePath)
    if (requireBundle.cache?.[resolved]) delete requireBundle.cache[resolved]
    const { default: ResultPage } = requireBundle(bundlePath)
    return renderToStaticMarkup(React.createElement(ResultPage, {
      result,
      settings: { profiles: [], defaultProfileId: null },
      onRegenerate: () => undefined
    }))
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    dom.window.close()
  }
}

async function loadIsolatedResultStore(userData) {
  const nativeRequire = createRequire(import.meta.url)
  const options = { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
  const evaluate = (code, filename, suppliedRequire) => {
    const module = { exports: {} }
    const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) { ${code}\n})`, { filename })
    wrapper(module.exports, suppliedRequire, module, filename, path.dirname(filename))
    return module.exports
  }
  const load = async (file, suppliedRequire = nativeRequire) => evaluate(
    ts.transpileModule(await fs.readFile(file, 'utf8'), options).outputText,
    file,
    suppliedRequire
  )
  const contentReadPath = path.resolve(here, '..', 'shared', 'content-read.ts')
  const contentRead = await load(contentReadPath)
  const contractPath = path.resolve(here, '..', 'shared', 'result-contract.ts')
  const contract = await load(contractPath, (id) => {
    if (id === './content-read.ts') return contentRead
    throw new Error(`unexpected contract dependency: ${id}`)
  })
  const atomicPath = path.resolve(here, '..', 'electron', 'services', 'atomic-json.ts')
  const atomic = await load(atomicPath)
  const storageContractPath = path.resolve(here, '..', 'shared', 'storage-contract.ts')
  const storageContract = await load(storageContractPath)
  const displayNamePath = path.resolve(here, '..', 'electron', 'services', 'project-display-name.ts')
  const displayName = await load(displayNamePath)
  const credentialVaultPath = path.resolve(here, '..', 'electron', 'services', 'credential-vault.ts')
  const credentialVault = await load(credentialVaultPath)
  const forbiddenCredentialCrypto = {
    isAvailable: async () => { throw new Error('unexpected credential crypto access in result-only test') },
    encrypt: async () => { throw new Error('unexpected credential encryption in result-only test') },
    decrypt: async () => { throw new Error('unexpected credential decryption in result-only test') }
  }
  const storePath = path.resolve(here, '..', 'electron', 'services', 'store.ts')
  const store = await load(storePath, (id) => {
    if (id === 'electron') return { app: { getPath: (name) => {
      assert.equal(name, 'userData')
      return userData
    } } }
    if (id === '@shared/types') return sharedTypes
    if (id === '@shared/result-contract') return contract
    if (id === '@shared/storage-contract') return storageContract
    if (id === './atomic-json') return atomic
    if (id === './project-display-name') return displayName
    if (id === './credential-vault') return credentialVault
    if (id === './native-credential-crypto') return { nativeCredentialCrypto: forbiddenCredentialCrypto }
    return nativeRequire(id)
  })
  store.setCredentialCryptoForTests(forbiddenCredentialCrypto)
  return store
}

test('real generation warning flows through contract, IPC, Markdown and built ResultPage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue71-render-integration-'))
  const allowedRoot = path.resolve(os.tmpdir())
  const resolvedRoot = path.resolve(root)
  assert.ok(resolvedRoot.startsWith(`${allowedRoot}${path.sep}`), 'fixture is rooted below the operating system temp directory')
  assert.ok(path.basename(root).startsWith('issue71-render-integration-'))

  const readme = path.join(root, 'README.md')
  const sourceFile = path.join(root, 'src', 'evidence.ts')
  const originalOpen = fs.open
  const originalFetch = globalThis.fetch
  try {
    await fs.writeFile(readme, '# Synthetic project\n')
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"synthetic"}')
    const sourceContent = [
      'export function createClient() {',
      '  const region = "test-region"',
      '  const endpoint = `https://${region}.example.invalid`',
      '  const timeoutMs = 1000',
      '  const headers = { "content-type": "application/json" }',
      '  const retryCount = 2',
      '  const retriesEnabled = retryCount > 0',
      '  const requestOptions = { headers, timeoutMs }',
      '  const clientName = "synthetic-client"',
      '  const shouldRetry = retriesEnabled && Boolean(clientName)',
      '  const logRequests = false',
      "  const apiKey = 'synthetic-api-secret';",
      '  return connect(endpoint, apiKey, requestOptions, shouldRetry, logRequests)',
      '}'
    ].join('\n')
    await fs.mkdir(path.dirname(sourceFile), { recursive: true })
    await fs.writeFile(sourceFile, sourceContent, 'utf8')
    const scan = await scanProject(root)
    const progressDetails = []
    const providerMessages = []
    let providerRequestCount = 0
    fs.open = async (filePath, ...args) => {
      if (String(filePath) === readme) {
        throw Object.assign(new Error(`private-root ${root} synthetic secret`), { code: 'EACCES' })
      }
      return originalOpen(filePath, ...args)
    }
    globalThis.fetch = async (_input, init) => {
      providerRequestCount += 1
      const requestBody = JSON.parse(String(init?.body))
      providerMessages.push(...(requestBody.messages ?? []).map((message) => message.content ?? ''))
      const prompt = requestBody.messages?.find((message) => message.role === 'user')?.content ?? ''
      assert.ok(prompt.includes('### 文件：src/evidence.ts'), 'primary user context contains ordinary project source')
      assert.match(prompt, /apiKey[^\n]*REDACTED/i, 'the request context contains the redacted assignment')
      assert.doesNotMatch(prompt, /sourceId|\b\d+ \| /, 'source identifiers and line numbering add no request overhead')
      assert.ok(!prompt.includes('synthetic-api-secret'), 'raw secret never enters the primary model context')
      const quota = Number(prompt.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1] ?? 20)
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          projectSummary: 'Synthetic generated summary',
          sections: [{ title: 'Synthetic section', questions: Array.from({ length: quota }, (_, index) => ({
            question: `Question ${index + 1}`,
            answer: `Answer ${index + 1}`,
            followUps: [],
            sourceRefs: [{ sourceId: 'ignored-legacy-reference', startLine: 12, endLine: 13 }]
          })) }],
          glossary: {}
        }) } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const result = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'backend',
      profile: { id: 'p1', name: 'Mock', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic-key', model: 'mock' },
      signal: new AbortController().signal,
      onProgress: (_step, detail) => { if (detail) progressDetails.push(detail) }
    })

    assert.ok(result.contentReadSummary)
    assert.equal(result.generationDiagnostics.status, 'succeeded')
    assert.equal(result.generationDiagnostics.requestCount, providerRequestCount)
    assert.equal(result.generationDiagnostics.actualUsage, null, 'missing provider usage remains unknown')
    assert.equal(result.generationDiagnostics.usageComplete, false)
    assert.doesNotMatch(JSON.stringify(result.generationDiagnostics), new RegExp(root))
    assert.doesNotMatch(JSON.stringify(result.generationDiagnostics), /synthetic-key|synthetic-api-secret|profileId/i)
    assert.doesNotThrow(() => assertInterviewResultContract(result))
    assert.doesNotThrow(() => validateIpcArgs(IPC.exportMarkdown, [result]))
    assert.ok(providerMessages.some((message) => message.includes('内容读取不完整') && message.includes('README.md')))
    assert.ok(progressDetails.some((detail) => detail.includes('内容读取不完整') && detail.includes('README.md')))
    assert.ok(!providerMessages.join('\n').includes(root))
    assert.ok(!providerMessages.join('\n').includes('synthetic secret'))
    assert.ok(!providerMessages.join('\n').includes('synthetic-api-secret'))
    assert.ok(!progressDetails.join('\n').includes(root))
    assert.ok(!progressDetails.join('\n').includes('synthetic secret'))

    const resultQuestions = result.sections.flatMap((section) => section.questions)
    assert.ok(resultQuestions.length >= 2)
    assert.ok(resultQuestions.every((question) => !Object.hasOwn(question, 'sourceEvidence')))
    assert.ok(!Object.hasOwn(result, 'sourceEvidenceSummary'))
    assert.ok(!JSON.stringify(result).includes('synthetic-api-secret'), 'generated result contains no raw secret')

    const markdown = resultToMarkdown(result)
    assert.ok(markdown.includes('尝试读取'))
    assert.ok(markdown.includes('README\\.md'))
    assert.ok(!markdown.includes('分析范围与用量'))
    assert.ok(!markdown.includes('系统估算输入'))
    assert.ok(!markdown.includes('服务商用量未知'))
    assert.ok(!markdown.includes('synthetic-api-secret'))
    assert.ok(!markdown.includes(root))
    assert.ok(!markdown.includes('源码依据'))
    assert.ok(!markdown.includes('sourceId'))

    const userData = path.join(root, 'isolated-user-data')
    await fs.mkdir(userData)
    const store = await loadIsolatedResultStore(userData)
    const analysisId = store.saveResult(root, result)
    const listedAnalysis = store.listAnalyses(root).items.find((item) => item.id === analysisId)
    assert.ok(listedAnalysis, 'the result remains reachable through the analysis list')
    const loadedAnalysis = store.loadAnalysis(root, analysisId)
    assert.deepEqual(loadedAnalysis.generationDiagnostics, result.generationDiagnostics)
    const storedPath = path.join(userData, 'projects', `${createHash('sha1').update(root).digest('hex')}.json`)
    const storedBytes = await fs.readFile(storedPath, 'utf8')
    assert.ok(!storedBytes.includes('synthetic-api-secret'), 'saved JSON contains no raw secret')
    assert.doesNotMatch(storedBytes, /sourceEvidence|sourceEvidenceSummary|sourceRefs|sourceId/)
    await fs.writeFile(sourceFile, 'changed after generating the interview\n', 'utf8')
    await fs.rm(sourceFile)
    const loaded = store.loadResult(root)
    assert.deepEqual(loaded.generationDiagnostics, result.generationDiagnostics)
    const reloadedMarkdown = resultToMarkdown(loaded)
    assert.ok(!reloadedMarkdown.includes('源码依据'))
    assert.ok(!reloadedMarkdown.includes('sourceId'))
    assert.ok(!reloadedMarkdown.includes('changed after generating'))
    assert.ok(!reloadedMarkdown.includes('synthetic-api-secret'))
    const html = await renderResultPage(loaded)
    assert.ok(html.includes('role="alert"'))
    assert.ok(html.includes('README.md'))
    assert.ok(!html.includes('分析范围与用量'))
    assert.ok(!html.includes('服务商用量：未知'))
    assert.ok(!html.includes('源码依据'))
    assert.ok(!html.includes('sourceId'))
    assert.ok(!html.includes('synthetic-api-secret'))
    assert.ok(!html.includes(root))

    fs.open = originalOpen
    await fs.writeFile(sourceFile, sourceContent, 'utf8')
    const normalProgressDetails = []
    const normalScan = await scanProject(root)
    const normalResult = await generateInterview({
      scan: normalScan,
      granularity: 'medium',
      roleFocus: 'backend',
      profile: { id: 'p1', name: 'Mock', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic-key', model: 'mock' },
      signal: new AbortController().signal,
      onProgress: (_step, detail) => { if (detail) normalProgressDetails.push(detail) }
    })
    assert.equal(normalResult.contentReadSummary, undefined)
    assert.ok(!normalProgressDetails.join('\n').includes('内容读取不完整'))
    assert.ok(!resultToMarkdown(normalResult).includes('内容读取不完整'))
    const normalHtml = await renderResultPage(normalResult)
    assert.ok(!normalHtml.includes('内容读取不完整'))
  } finally {
    fs.open = originalOpen
    globalThis.fetch = originalFetch
    assert.ok(resolvedRoot.startsWith(`${allowedRoot}${path.sep}`), 'cleanup target remains under the temp directory')
    assert.ok(path.basename(resolvedRoot).startsWith('issue71-render-integration-'), 'cleanup target has the expected fixture name')
    await fs.rm(resolvedRoot, { recursive: true, force: true })
  }
})
