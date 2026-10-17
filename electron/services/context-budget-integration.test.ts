// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { afterEach } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { isSafeContentReadPath } from '../../shared/content-read.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { CONTEXT_CHAR_BUDGETS, CONTEXT_TRUNCATION_WARNING } from '../../shared/context-budget.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { GRANULARITY_QUESTION_BUDGET } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { FileNode, Granularity, LlmProfile } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { buildContext, renderBatch } from './context-builder.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { generateInterview } from './generator.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { resultToMarkdown } from './markdown-export.ts'

const tempDirs: string[] = []
const profile: LlmProfile = {
  id: 'context-budget-fixture',
  name: 'Mock',
  baseUrl: 'https://mock.example/v1',
  apiKey: 'must-not-enter-context-or-result',
  model: 'mock-model'
}

afterEach(async () => {
  const tempRoot = path.resolve(os.tmpdir())
  for (const dir of tempDirs.splice(0)) {
    const resolved = path.resolve(dir)
    assert.equal(path.dirname(resolved), tempRoot, `fixture cleanup must stay directly inside the temp directory: ${resolved}`)
    assert.ok(path.basename(resolved).startsWith('issue90-context-budget-'), `unexpected fixture cleanup target: ${resolved}`)
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue90-context-budget-'))
  tempDirs.push(root)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  // This remains within the scanner's 256 KiB file ceiling but forces the
  // coarse context to clip actual source text after prompt and tree overhead.
  await fs.writeFile(path.join(root, 'README.md'), `README-IMPORTANT-START\n${'project detail '.repeat(8_000)}\nREADME-IMPORTANT-END`)
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"context-budget-fixture"}')
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const CORE_SOURCE_KEEP = "important-code"\n')
  await fs.writeFile(path.join(root, `${'L'.repeat(160)}.md`), 'LONG_NAME_DOC_KEEP\nA legal long filename in the real scanned project.\n')
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=issue90-private-path-secret\n')
  await fs.mkdir(path.join(root, 'src', 'module-a'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'module-a', 'core.ts'), 'export const MODULE_CORE_KEEP = true\n')
  return root
}

async function makeManyLineFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue90-context-budget-'))
  tempDirs.push(root)
  const lines = Array.from({ length: 4_000 }, (_, index) => `DOC_LINE_${String(index + 1).padStart(4, '0')} ${'x'.repeat(20)}`)
  await fs.writeFile(path.join(root, 'README.md'), `${lines.join('\n')}\n`)
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"many-line-fixture"}')
  return root
}

async function makeCombinedWarningFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue90-context-budget-'))
  tempDirs.push(root)
  await fs.mkdir(path.join(root, 'src', 'module-a'), { recursive: true })
  await fs.writeFile(path.join(root, 'README.md'), `README-NEAR-BUDGET-START\n${'project detail '.repeat(2_500)}\nREADME-NEAR-BUDGET-END`)
  await fs.writeFile(path.join(root, 'guide.md'), `GUIDE-TRUNCATION-START\n${'additional detail '.repeat(8_000)}\nGUIDE-TRUNCATION-END`)
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"combined-warning-fixture"}')
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const CORE_SOURCE_KEEP = true\n')
  await fs.writeFile(path.join(root, 'src', 'module-a', 'core.ts'), 'export const MODULE_CORE_KEEP = true\n')
  return root
}

async function makeModuleCapFixture(directoryCount: number, includeRootCode = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue90-context-budget-'))
  tempDirs.push(root)
  await fs.writeFile(path.join(root, 'README.md'), 'A short project overview.\n')
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"module-cap-fixture"}')
  if (includeRootCode) await fs.writeFile(path.join(root, 'root.ts'), 'export const ROOT_MODULE_KEEP = true\n')
  for (let index = 0; index < directoryCount; index++) {
    const moduleName = `module${String(index).padStart(2, '0')}`
    await fs.mkdir(path.join(root, moduleName), { recursive: true })
    await fs.writeFile(path.join(root, moduleName, 'service.ts'), `export const MODULE_CAP_KEEP_${String(index).padStart(2, '0')} = true\n`)
  }
  return root
}

function installMock(capture: Array<{ messages: Array<{ role: string; content: string }> }>, mode: 'normal' | 'repair' | 'short' | 'evidence' | 'evidence-repair' | 'evidence-repair-stale' | 'evidence-cross-batch' = 'normal') {
  const originalFetch = globalThis.fetch
  let call = 0
  let moduleASourceId: string | undefined
  const invalidReply = '😀'.repeat(11_001) + 'REPAIR-TAIL-SHOULD-BE-CLIPPED'
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const messages = Array.isArray(body.messages) ? body.messages : []
    capture.push({ messages: messages as typeof capture[number]['messages'] })
    call++
    if (['repair', 'evidence-repair', 'evidence-repair-stale'].includes(mode) && call === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: invalidReply } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const prompt = messages.map((message: { content?: string }) => message.content ?? '').join('\n')
    const sourceId = prompt.match(/\[sourceId: ([^\]]+)\]/)?.[1]
    const currentSources = sourceEntries({ messages: messages as typeof capture[number]['messages'] })
    const currentSourceId = currentSources.keys().next().value as string | undefined
    const moduleName = prompt.match(/本次只分析项目的单个模块「([^」]+)」/)?.[1]
    if (mode === 'evidence-cross-batch' && moduleName === 'module-a') moduleASourceId = currentSourceId
    const requestedText = prompt.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1]
    if (!requestedText) throw new Error('mock prompt did not include its explicit question quota')
    const requested = Number(requestedText)
    const count = mode === 'short' ? 1 : requested
    const result = {
      projectSummary: 'A bounded synthetic fixture.',
      sections: [{
        title: 'Project',
        summary: 'Generated from the fixture.',
        questions: Array.from({ length: count }, (_, index) => ({
          question: `Fixture question ${call}-${index + 1}?`,
          answer: `Fixture answer ${index + 1}.`,
          followUps: [],
          ...((mode === 'evidence' || mode === 'evidence-repair') && sourceId ? { sourceRefs: [{ sourceId, startLine: 1, endLine: 1 }] } : {}),
          ...(mode === 'evidence-repair-stale' && currentSourceId ? {
            sourceRefs: [
              staleFirstRequestRef(capture[0], { messages: messages as typeof capture[number]['messages'] }),
              { sourceId: currentSourceId, startLine: 1, endLine: 1 }
            ]
          } : {}),
          ...(mode === 'evidence-cross-batch' && moduleName === 'module-b' && moduleASourceId && currentSourceId ? {
            sourceRefs: [
              { sourceId: moduleASourceId, startLine: 1, endLine: 1 },
              { sourceId: currentSourceId, startLine: 1, endLine: 1 }
            ]
          } : {})
        }))
      }],
      glossary: {}
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return () => { globalThis.fetch = originalFetch }
}

function sourceEntries(request: { messages: Array<{ role: string; content: string }> }): Map<string, number> {
  const prompt = request.messages.map((message) => message.content).join('\n')
  const entries = new Map<string, number>()
  const files = /### 文件：[^\n]*\[sourceId: ([^\]]+)\]\n```\n([\s\S]*?)\n```/g
  for (const match of prompt.matchAll(files)) {
    const numberedLines = Array.from(match[2].matchAll(/^(\d+) \| (.*)$/gm))
    if (!numberedLines.length) continue
    let citable = Number(numberedLines[numberedLines.length - 1][1])
    if (numberedLines[numberedLines.length - 1][2].includes('…（内容已截断）')) citable--
    entries.set(match[1], citable)
  }
  return entries
}

function staleFirstRequestRef(
  first: { messages: Array<{ role: string; content: string }> } | undefined,
  retry: { messages: Array<{ role: string; content: string }> }
): { sourceId: string; startLine: number; endLine: number } {
  if (!first) throw new Error('missing initial model request')
  const initialEntries = sourceEntries(first)
  const retryEntries = sourceEntries(retry)
  for (const [sourceId, initialLines] of initialEntries) {
    const retryLines = retryEntries.get(sourceId) ?? 0
    if (initialLines > retryLines) {
      return { sourceId, startLine: retryLines + 1, endLine: retryLines + 1 }
    }
  }
  throw new Error('repair request did not shrink any source range from the initial request')
}

test('generated evidence is resolved from each actual request and cloned across questions', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests, 'evidence')
  let result: Awaited<ReturnType<typeof generateInterview>>
  try {
    result = await generateInterview({
      scan, granularity: 'fine', roleFocus: 'backend', profile,
      signal: new AbortController().signal, onProgress: () => undefined
    })
  } finally { restore() }

  const requestSources = requests.map((request) => {
    const prompt = request.messages.map((message) => message.content).join('\n')
    return new Set(Array.from(prompt.matchAll(/\[sourceId: ([^\]]+)\]/g), (match) => match[1]))
  })
  const questions = result!.sections.flatMap((section) => section.questions)
  assert.ok(questions.length >= 2)
  assert.ok(questions.every((question) => question.sourceEvidence?.length === 1))
  assert.ok(questions.some((question, index) => questions.slice(index + 1).some((other) =>
    question.sourceEvidence![0].sourceId === other.sourceEvidence![0].sourceId)), 'two questions should cite one source')
  for (const question of questions) {
    const requestIndex = Number(question.question.match(/^Fixture question (\d+)-/)?.[1]) - 1
    assert.ok(requestSources[requestIndex]?.has(question.sourceEvidence![0].sourceId), 'evidence must belong to the request that produced the question')
    assert.equal(question.sourceEvidence![0].path.includes('..'), false)
    assert.ok(question.sourceEvidence![0].excerpt.length > 0)
  }
  assert.equal(result!.sourceEvidenceSummary?.asked, questions.length)
  assert.equal(result!.sourceEvidenceSummary?.accepted, questions.length)
  assert.equal(result!.sourceEvidenceSummary?.retained, questions.reduce((count, question) => count + (question.sourceEvidence?.length ?? 0), 0))
  for (const question of questions) {
    assert.match(question.sourceEvidence![0].snapshotHash, /^[a-f0-9]{64}$/)
    for (const other of questions) if (other !== question && other.sourceEvidence?.[0].sourceId === question.sourceEvidence![0].sourceId) {
      assert.notStrictEqual(question.sourceEvidence![0], other.sourceEvidence![0], 'each result field must own a cloned evidence object')
    }
  }
})

function addOversizedLegalTree(scan: Awaited<ReturnType<typeof scanProject>>): void {
  const children: FileNode[] = Array.from({ length: 3996 }, (_, index) => {
    const name = `${String(index).padStart(4, '0')}_${'x'.repeat(248)}`
    return { name, path: name, type: 'file', size: 1 }
  })
  children.push(
    { name: 'README.md', path: 'README.md', type: 'file', size: 1 },
    { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 1 },
    { name: '.env', path: '.env', type: 'file', size: 64 }
  )
  assert.equal(children.length, 3999)
  assert.ok(children.every((node) => node.name.length <= 255), 'synthetic path components remain legal')
  scan.tree.children = children
}

function addDeepLegalTree(scan: Awaited<ReturnType<typeof scanProject>>): void {
  const segments: string[] = []
  const first: FileNode = { name: 'deep-00', path: 'deep-00', type: 'dir', children: [] }
  let current = first
  segments.push(first.name)
  for (let index = 1; index < 40; index++) {
    const name = `deep-${String(index).padStart(2, '0')}`
    const child: FileNode = { name, path: [...segments, name].join('/'), type: 'dir', children: [] }
    current.children = [child]
    current = child
    segments.push(name)
  }
  current.children = [{ name: 'deep-leaf.md', path: [...segments, 'deep-leaf.md'].join('/'), type: 'file' }]
  scan.tree.children = [first]
}

function assertRequestsStayBounded(
  requests: Array<{ messages: Array<{ role: string; content: string }> }>,
  granularity: Granularity
): void {
  for (const [index, request] of requests.entries()) {
    const chars = request.messages.reduce((sum, message) => sum + message.content.length, 0)
    assert.ok(chars <= CONTEXT_CHAR_BUDGETS[granularity], `${granularity} request ${index + 1} sent ${chars} chars`)
  }
}

test('approved real scan bounds actual model messages for coarse, medium, and fine despite 3999 long tree nodes', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  // Mutating this already-approved scan preserves the scanner's private source
  // approval record, while exercising the same builder/generator path.
  addOversizedLegalTree(scan)

  for (const granularity of ['coarse', 'medium', 'fine'] as const) {
    const built = await buildContext(scan, granularity)
    assert.ok(built.treeText.length <= Math.min(12_000, CONTEXT_CHAR_BUDGETS[granularity] * 0.2))
    for (const batch of built.batches) {
      assert.equal(batch.totalChars, renderBatch(built.headerText, built.treeText, batch).length,
        `${granularity} batch ${batch.label} should count headings, tree, fences, separators, and content`)
    }
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const restore = installMock(requests)
    const progress: Array<{ step: string; detail?: string }> = []
    let result: Awaited<ReturnType<typeof generateInterview>>
    try {
      result = await generateInterview({
        scan,
        granularity,
        roleFocus: 'backend',
        profile,
        signal: new AbortController().signal,
        onProgress: (step, detail) => progress.push({ step, detail })
      })
    } finally {
      restore()
    }

    assert.ok(requests.length > 0)
    assertRequestsStayBounded(requests, granularity)
    assert.ok(requests.some((request) => request.messages.some((message) => message.content.includes('README-IMPORTANT-START'))),
      `${granularity} should retain the beginning of the important project document`)
    for (const batch of built.batches) {
      assert.ok(batch.totalChars <= CONTEXT_CHAR_BUDGETS[granularity], `${granularity} batch ${batch.label} exceeds its context allowance`)
    }
    if (granularity !== 'coarse') {
      assert.ok(requests.some((request) => request.messages.some((message) => message.content.includes('CORE_SOURCE_KEEP'))),
        `${granularity} should retain the important entry point`)
      assert.ok(requests.some((request) => request.messages.some((message) => message.content.includes('LONG_NAME_DOC_KEEP'))),
        `${granularity} should keep a useful document alongside the oversized synthetic tree`)
      assert.ok(JSON.stringify(requests).includes(`${'L'.repeat(160)}.md`), 'the real long filename must be counted in rendered message text')
    }
    const serialized = JSON.stringify(requests)
    assert.doesNotMatch(serialized, /issue90-private-path-secret/)
    assert.doesNotMatch(serialized, /\.env/)
    assert.doesNotMatch(serialized, new RegExp(profile.apiKey))
    assert.ok(result!.contextTruncation && Object.values(result!.contextTruncation).some(Boolean))
    assert.equal(result!.contextTruncation?.treeTruncated, true)
    if (granularity === 'coarse') {
      assert.equal(result!.contextTruncation?.contentTruncated, true, 'oversized real documentation must be identified as omitted')
      assert.equal(result!.contextTruncation?.requestTruncated, false,
        'the reserved warning allowance lets the complete built context fit without request-level clipping')
      const firstUserMessage = requests[0].messages.find((message) => message.role === 'user')
      const normalizeSourceIds = (value: string): string => value.replace(/\[sourceId: [^\]]+\]/g, '[sourceId]')
      assert.ok(firstUserMessage && normalizeSourceIds(firstUserMessage.content).includes(normalizeSourceIds(renderBatch(built.headerText, built.treeText, built.batches[0]))),
        'the first coarse request should preserve the complete rendered batch, including tree and headers')
      assert.ok(firstUserMessage?.content.includes(CONTEXT_TRUNCATION_WARNING),
        'the full context should still disclose the omitted tree and file content')
    }
    assert.doesNotMatch(JSON.stringify(result!), new RegExp(profile.apiKey))
    assert.ok(JSON.stringify(progress).includes(CONTEXT_TRUNCATION_WARNING), 'progress must disclose omitted context')
    assert.ok(serialized.includes(CONTEXT_TRUNCATION_WARNING), 'the model request must disclose omitted context')
  }
})

test('deep legal directory trees remain bounded and keep their final leaf visible', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  addDeepLegalTree(scan)
  const built = await buildContext(scan, 'medium')
  assert.ok(built.treeText.includes('deep-39/'))
  assert.ok(built.treeText.includes('deep-leaf.md'))
  assert.ok(built.treeText.length <= 12_000)
  assert.equal(built.contextTruncation.treeTruncated, false)
  for (const batch of built.batches) {
    assert.ok(batch.totalChars <= CONTEXT_CHAR_BUDGETS.medium)
  }
})

test('JSON repair retry carries prior messages and still stays inside the coarse request budget', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests, 'repair')
  let result: Awaited<ReturnType<typeof generateInterview>>
  try {
    result = await generateInterview({
      scan,
      granularity: 'coarse',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: () => undefined
    })
  } finally {
    restore()
  }
  assert.equal(result!.contextTruncation?.requestTruncated, true,
    'repair history must trigger request-level context clipping and preserve it in result metadata')
  assert.equal(requests.length, 2, 'the malformed first response should trigger exactly one repair request')
  const previousReply = requests[1].messages.find((message) => message.role === 'assistant')
  assert.ok(previousReply, 'repair request should include the prior assistant response')
  assert.ok(previousReply.content.length <= 20_000, 'the prior response should be clipped before retry')
  assert.ok(previousReply.content.endsWith('…（已截断）'), 'clipping marker should disclose the shortened previous response')
  assert.doesNotMatch(previousReply.content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    'the repair history must not end with half of a Unicode surrogate pair')
  assert.ok(requests[1].messages.some((message) => message.role === 'user' && /合法 JSON/.test(message.content)), 'repair request should preserve its JSON instruction')
  assert.ok(requests[1].messages.some((message) => message.role === 'user' && message.content.includes('请只依据实际提供的上下文作答，不要假设已看到省略内容。')),
    'the repair request should explicitly mark context removed to fit its prior reply')
  assertRequestsStayBounded(requests, 'coarse')
})

test('JSON repair evidence is resolved against the shrunken retry request manifest', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests, 'evidence-repair')
  let result: Awaited<ReturnType<typeof generateInterview>>
  try {
    result = await generateInterview({
      scan, granularity: 'coarse', roleFocus: 'backend', profile,
      signal: new AbortController().signal, onProgress: () => undefined
    })
  } finally { restore() }
  assert.equal(requests.length, 2)
  const retry = requests[1].messages.map((message) => message.content).join('\n')
  const retryIds = new Set(Array.from(retry.matchAll(/\[sourceId: ([^\]]+)\]/g), (match) => match[1]))
  const questions = result!.sections.flatMap((section) => section.questions)
  assert.ok(questions.length > 0)
  assert.ok(questions.every((question) => question.sourceEvidence?.length === 1))
  assert.ok(questions.every((question) => retryIds.has(question.sourceEvidence![0].sourceId)))
  assert.equal(result!.sourceEvidenceSummary?.accepted, questions.length)
  assert.equal(result!.sourceEvidenceSummary?.retained, questions.length)
})

test('JSON repair rejects first-attempt lines omitted from the retry but keeps retry-visible evidence', async () => {
  const root = await makeManyLineFixture()
  const scan = await scanProject(root)
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests, 'evidence-repair-stale')
  let result: Awaited<ReturnType<typeof generateInterview>>
  try {
    result = await generateInterview({
      scan, granularity: 'coarse', roleFocus: 'backend', profile,
      signal: new AbortController().signal, onProgress: () => undefined
    })
  } finally { restore() }

  assert.equal(requests.length, 2)
  const initialSources = sourceEntries(requests[0])
  const retrySources = sourceEntries(requests[1])
  const stale = Array.from(initialSources).find(([sourceId, lineCount]) => lineCount > (retrySources.get(sourceId) ?? 0))
  assert.ok(stale, 'the fixture must expose lines in attempt one that the fitted repair request omits')
  const questions = result!.sections.flatMap((section) => section.questions)
  assert.ok(questions.length > 0)
  assert.ok(questions.every((question) => question.sourceEvidence?.length === 1))
  for (const question of questions) {
    const evidence = question.sourceEvidence![0]
    assert.ok(retrySources.has(evidence.sourceId), 'only the retry request can authorize a persisted citation')
    assert.ok(evidence.sourceId !== stale![0] || evidence.endLine <= (retrySources.get(stale![0]) ?? 0))
  }
  assert.ok((result!.sourceEvidenceSummary?.rejected ?? 0) > 0, 'the first-request-only range must count as rejected')
  assert.equal(result!.sourceEvidenceSummary?.accepted, questions.length)
  assert.equal(result!.sourceEvidenceSummary?.retained, questions.length)
})

test('module B cannot cite a source ID exclusive to module A', async () => {
  const root = await makeFixture()
  await fs.mkdir(path.join(root, 'module-a'), { recursive: true })
  await fs.mkdir(path.join(root, 'module-b'), { recursive: true })
  await fs.writeFile(path.join(root, 'module-a', 'service.ts'), 'export const MODULE_A_ONLY = true\n')
  await fs.writeFile(path.join(root, 'module-b', 'service.ts'), 'export const MODULE_B_ONLY = true\n')
  const scan = await scanProject(root)
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests, 'evidence-cross-batch')
  let result: Awaited<ReturnType<typeof generateInterview>>
  try {
    result = await generateInterview({
      scan, granularity: 'fine', roleFocus: 'backend', profile,
      signal: new AbortController().signal, onProgress: () => undefined
    })
  } finally { restore() }

  const moduleARequestIndex = requests.findIndex((request) => request.messages.some((message) => message.content.includes('只分析项目的单个模块「module-a」')))
  const moduleBRequestIndex = requests.findIndex((request) => request.messages.some((message) => message.content.includes('只分析项目的单个模块「module-b」')))
  assert.ok(moduleARequestIndex >= 0 && moduleBRequestIndex > moduleARequestIndex, 'module A must be requested before module B')
  const moduleAIds = new Set(sourceEntries(requests[moduleARequestIndex]).keys())
  const moduleBIds = new Set(sourceEntries(requests[moduleBRequestIndex]).keys())
  assert.ok([...moduleAIds].some((sourceId) => !moduleBIds.has(sourceId)), 'the fixture needs a source ID exclusive to module A')
  const moduleBQuestions = result!.sections.flatMap((section) => section.questions).filter((question) => {
    const callNo = Number(question.question.match(/^Fixture question (\d+)-/)?.[1])
    const prompt = requests[callNo - 1]?.messages.map((message) => message.content).join('\n') ?? ''
    return prompt.includes('单个模块「module-b」')
  })
  assert.ok(moduleBQuestions.length > 0)
  for (const question of moduleBQuestions) {
    assert.equal(question.sourceEvidence?.length, 1)
    assert.ok(moduleBIds.has(question.sourceEvidence![0].sourceId))
    assert.ok(!moduleAIds.has(question.sourceEvidence![0].sourceId))
  }
  assert.ok((result!.sourceEvidenceSummary?.rejected ?? 0) >= moduleBQuestions.length)
  assert.equal(result!.sourceEvidenceSummary?.retained, result!.sections.flatMap((section) => section.questions).reduce((count, question) => count + (question.sourceEvidence?.length ?? 0), 0))
})

test('ordinary projects produce no truncation metadata or warning', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests)
  const progress: Array<{ step: string; detail?: string }> = []
  let result: Awaited<ReturnType<typeof generateInterview>>
  try {
    result = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
  } finally {
    restore()
  }
  assert.equal(result!.contextTruncation, undefined)
  assert.doesNotMatch(JSON.stringify(progress), new RegExp(CONTEXT_TRUNCATION_WARNING))
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(CONTEXT_TRUNCATION_WARNING))
  assert.doesNotMatch(JSON.stringify(requests), /\.env|issue90-private-path-secret/,
    'real sensitive paths and their contents must stay out of an otherwise ordinary model request')
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(profile.apiKey))
})

test('fine module batch cap marks omitted content and warns in real model requests and progress', async () => {
  for (const directoryCount of [10, 11]) {
    const root = await makeModuleCapFixture(directoryCount, false)
    const scan = await scanProject(root)
    const built = await buildContext(scan, 'fine')
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const restore = installMock(requests)
    const progress: Array<{ step: string; detail?: string }> = []
    let result: Awaited<ReturnType<typeof generateInterview>>
    try {
      result = await generateInterview({
        scan,
        granularity: 'fine',
        roleFocus: 'backend',
        profile,
        signal: new AbortController().signal,
        onProgress: (step, detail) => progress.push({ step, detail })
      })
    } finally {
      restore()
    }

    const capped = directoryCount === 11
    assert.equal(built.moduleCount, 10, 'the fine-grained module request cap remains ten')
    assert.equal(built.contextTruncation.treeTruncated, false)
    assert.equal(built.contextTruncation.requestTruncated, false)
    assert.equal(built.contextTruncation.contentTruncated, capped,
      capped ? 'the eleventh non-empty module group must be reported as omitted' : 'exactly ten groups must not be reported as omitted')
    assert.ok(built.treeText.length < 12_000)
    assert.ok(built.batches.every((batch) => batch.totalChars < CONTEXT_CHAR_BUDGETS.fine))
    if (capped) {
      assert.deepEqual(result!.contextTruncation, {
        treeTruncated: false,
        contentTruncated: true,
        requestTruncated: false
      })
    } else {
      assert.equal(result!.contextTruncation, undefined)
    }
    const questionCount = result!.sections.reduce((sum, section) => sum + section.questions.length, 0)
    assert.ok(questionCount >= GRANULARITY_QUESTION_BUDGET.fine.min)
    assert.ok(questionCount <= GRANULARITY_QUESTION_BUDGET.fine.max)
    assert.ok(requests.length <= 11, 'one global plus at most ten module requests are sent')
    assertRequestsStayBounded(requests, 'fine')

    const promptText = requests.flatMap((request) => request.messages.map((message) => message.content)).join('\n')
    let includedDirectoryMarkers = 0
    for (let index = 0; index < directoryCount; index++) {
      const marker = `MODULE_CAP_KEEP_${String(index).padStart(2, '0')}`
      if (promptText.includes(marker)) includedDirectoryMarkers++
      else assert.ok(capped, `${marker} should be present when all ten groups fit`)
    }
    assert.equal(includedDirectoryMarkers, 10, 'exactly ten directory modules are sent at the cap')
    const markdown = resultToMarkdown(result!)
    if (capped) {
      assert.ok(directoryCount > includedDirectoryMarkers, 'at least one unselected module marker must be absent from every request')
      assert.ok(progress.some(({ detail }) => detail?.includes(CONTEXT_TRUNCATION_WARNING)),
        'generation progress must disclose the omitted module group')
      assert.ok(promptText.includes(CONTEXT_TRUNCATION_WARNING),
        'actual model requests must disclose the omitted module group')
      assert.ok(markdown.includes(CONTEXT_TRUNCATION_WARNING),
        'Markdown export must disclose the omitted module group')
    } else {
      assert.doesNotMatch(JSON.stringify(progress), new RegExp(CONTEXT_TRUNCATION_WARNING))
      assert.doesNotMatch(promptText, new RegExp(CONTEXT_TRUNCATION_WARNING))
      assert.doesNotMatch(markdown, new RegExp(CONTEXT_TRUNCATION_WARNING))
    }
  }

  for (const directoryCount of [9, 10]) {
    const root = await makeModuleCapFixture(directoryCount)
    const scan = await scanProject(root)
    const built = await buildContext(scan, 'fine')
    assert.equal(built.moduleCount, 10, 'nine directories plus root code form ten groups; ten plus root code exceed the cap')
    assert.equal(built.contextTruncation.contentTruncated, directoryCount === 10)
  }
})

test('a failed module read does not falsely report hitting the ten non-empty batch cap', async () => {
  const root = await makeModuleCapFixture(10)
  const scan = await scanProject(root)
  const originalOpen = fs.open
  const failedPath = path.join(root, 'module00', 'service.ts')
  fs.open = (async (filePath: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    if (String(filePath) === failedPath) throw Object.assign(new Error('private read failure'), { code: 'EACCES' })
    return Reflect.apply(originalOpen, fs, [filePath, ...args]) as Awaited<ReturnType<typeof fs.open>>
  }) as typeof fs.open
  let built: Awaited<ReturnType<typeof buildContext>>
  try {
    built = await buildContext(scan, 'fine')
  } finally {
    fs.open = originalOpen
  }

  assert.equal(built.moduleCount, 10, 'the failed group adds no module batch, while the other ten groups do')
  assert.equal(built.contentReadSummary.failedReads, 1)
  assert.equal(built.contextTruncation.contentTruncated, false,
    'all non-empty groups were visited, so the batch-cap warning must stay clear')
  assert.ok(built.headerText.includes('内容读取不完整'), 'the real read failure remains visible through its separate warning')
  assert.ok(!built.headerText.includes(CONTEXT_TRUNCATION_WARNING))
})

test('fine-grained compensation requests remain within the same final-message budget', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  addOversizedLegalTree(scan)
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests, 'short')
  const progress: Array<{ step: string; detail?: string }> = []
  try {
    await generateInterview({
      scan,
      granularity: 'fine',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
  } finally {
    restore()
  }
  assert.ok(requests.length > 2, 'short model output should cause a bounded compensation round')
  assert.ok(requests.some((request) => request.messages.some((message) => /补充请求/.test(message.content))))
  assertRequestsStayBounded(requests, 'fine')
  assert.ok(JSON.stringify(progress).includes(CONTEXT_TRUNCATION_WARNING))
})

test('combined read and context warnings remain bounded in real coarse and fine generation requests', async () => {
  const root = await makeCombinedWarningFixture()
  const scan = await scanProject(root)
  addOversizedLegalTree(scan)
  const failedPath = path.join(root, 'package.json')
  const rawReadError = 'issue90-raw-injected-error /private/root'

  for (const granularity of ['coarse', 'fine'] as const) {
    const originalOpen = fs.open
    const buildAttempts: string[] = []
    fs.open = (async (filePath: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
      const absolute = String(filePath)
      buildAttempts.push(absolute)
      if (absolute === failedPath) {
        throw Object.assign(new Error(rawReadError), { code: 'EACCES' })
      }
      return Reflect.apply(originalOpen, fs, [filePath, ...args]) as Awaited<ReturnType<typeof fs.open>>
    }) as typeof fs.open

    let built: Awaited<ReturnType<typeof buildContext>>
    try {
      built = await buildContext(scan, granularity)
    } finally {
      fs.open = originalOpen
    }

    assert.equal(built.contentReadSummary.failedReads, 1)
    assert.equal(built.contentReadSummary.attemptedReads, buildAttempts.length,
      `${granularity} should count only file reads that reached fs.open`)
    assert.equal(built.contentReadSummary.successfulReads, buildAttempts.length - 1)
    assert.equal(built.contentReadSummary.attemptedReads,
      built.contentReadSummary.successfulReads + built.contentReadSummary.failedReads)
    assert.equal(built.contextTruncation.treeTruncated, true)
    assert.equal(built.contextTruncation.contentTruncated, true)
    assert.ok(built.headerText.includes('内容读取不完整'))
    assert.ok(built.headerText.includes(CONTEXT_TRUNCATION_WARNING))
    assert.ok(built.batches.some((batch) => batch.files.some((file) => file.truncated)),
      `${granularity} should clip the long secondary document while retaining the README`)
    assert.ok(built.batches.some((batch) => batch.files.some((file) => file.relPath === 'README.md' && file.content.includes('README-NEAR-BUDGET-END'))),
      `${granularity} should retain the near-budget README`)
    for (const batch of built.batches) {
      assert.equal(batch.totalChars, renderBatch(built.headerText, built.treeText, batch).length,
        `${granularity} totalChars should include both warnings, tree, headings, fences, and content`)
      assert.ok(batch.totalChars <= CONTEXT_CHAR_BUDGETS[granularity],
        `${granularity} batch ${batch.label} exceeds its allowance with both warnings`)
    }

    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const restoreFetch = installMock(requests)
    const generationAttempts: string[] = []
    fs.open = (async (filePath: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
      const absolute = String(filePath)
      generationAttempts.push(absolute)
      if (absolute === failedPath) {
        throw Object.assign(new Error(rawReadError), { code: 'EACCES' })
      }
      return Reflect.apply(originalOpen, fs, [filePath, ...args]) as Awaited<ReturnType<typeof fs.open>>
    }) as typeof fs.open
    const progress: Array<{ step: string; detail?: string }> = []
    let result: Awaited<ReturnType<typeof generateInterview>>
    try {
      result = await generateInterview({
        scan,
        granularity,
        roleFocus: 'backend',
        profile,
        signal: new AbortController().signal,
        onProgress: (step, detail) => progress.push({ step, detail })
      })
    } finally {
      fs.open = originalOpen
      restoreFetch()
    }

    assert.ok(requests.length > 0)
    assertRequestsStayBounded(requests, granularity)
    assert.equal(result!.contentReadSummary?.attemptedReads, generationAttempts.length,
      `${granularity} result must not count files skipped before an actual read`)
    assert.equal(result!.contentReadSummary?.failedReads, 1)
    assert.equal(result!.contentReadSummary?.successfulReads, generationAttempts.length - 1)
    assert.equal(result!.contentReadSummary?.attemptedReads,
      result!.contentReadSummary!.successfulReads + result!.contentReadSummary!.failedReads)
    assert.ok(result!.contentReadSummary?.failures.length)
    assert.ok(result!.contentReadSummary!.failures.every(({ path: relPath }) => isSafeContentReadPath(relPath)),
      'result warning samples must contain only safe relative paths')
    assert.equal(result!.contextTruncation?.treeTruncated, true)
    assert.equal(result!.contextTruncation?.contentTruncated, true)
    const serializedRequests = JSON.stringify(requests)
    const serializedProgress = JSON.stringify(progress)
    const rawModelText = requests.flatMap((request) => request.messages.map((message) => message.content)).join('\n')
    const rawProgressText = progress.map(({ detail }) => detail ?? '').join('\n')
    const resultWarnings = JSON.stringify({
      contentReadSummary: result!.contentReadSummary,
      contextTruncation: result!.contextTruncation
    })
    assert.ok(serializedRequests.includes('内容读取不完整'))
    assert.ok(serializedRequests.includes(CONTEXT_TRUNCATION_WARNING))
    assert.ok(serializedProgress.includes('内容读取不完整'))
    assert.ok(serializedProgress.includes(CONTEXT_TRUNCATION_WARNING))
    assert.doesNotMatch(serializedRequests, new RegExp(profile.apiKey))
    assert.doesNotMatch(serializedProgress, new RegExp(profile.apiKey))
    for (const value of [rawModelText, rawProgressText, resultWarnings, serializedRequests, serializedProgress]) {
      assert.ok(!value.includes(root), 'warning output must not expose the absolute project root')
      assert.ok(!value.includes(rawReadError), 'warning output must not expose the injected filesystem error')
      assert.ok(!value.includes(profile.apiKey), 'warning output must not expose the fake API key')
      assert.ok(!value.includes(JSON.stringify(root)), 'warning output must not expose a JSON-escaped absolute root')
    }
    assert.doesNotMatch(serializedRequests, /issue90-private-path-secret|\.env/)
  }
})
