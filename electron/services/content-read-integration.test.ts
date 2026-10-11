// Real scan/context and generation regression coverage for partial content reads.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { after } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { CONTENT_READ_MESSAGES, emptyContentReadSummary, recordContentReadFailure } from '../../shared/content-read.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { buildContext, renderBatch } from './context-builder.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { generateInterview } from './generator.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { scanProject, treeToText } from './scanner.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { readProjectContent, ProjectContentBoundaryError } from './project-content-reader.ts'

const fixtureRoots: string[] = []
const fixturePrefix = 'issue71-content-fixture-'

after(async () => {
  const allowedRoot = path.resolve(os.tmpdir())
  for (const root of fixtureRoots.splice(0)) {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(`${allowedRoot}${path.sep}`), `fixture cleanup must stay under temp directory: ${resolved}`)
    assert.ok(path.basename(resolved).startsWith(fixturePrefix), `unexpected fixture cleanup target: ${resolved}`)
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), fixturePrefix))
  fixtureRoots.push(root)
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = path.join(root, ...relPath.split('/'))
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, contents)
  }
  return root
}

function errno(code: string, name?: string): Error {
  const error = Object.assign(new Error(`synthetic-secret /private/root ${code}`), { code })
  if (name) error.name = name
  return error
}

function patchContentReadFailures(
  failures: Map<string, { code: string; stage?: 'open' | 'read' }>,
  attempted: string[] = []
): () => void {
  const originalOpen = fs.open
  fs.open = (async (filePath: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    const absolute = String(filePath)
    attempted.push(absolute)
    const failure = failures.get(absolute)
    if (failure?.stage !== 'read' && failure) throw errno(failure.code)
    const handle = await Reflect.apply(originalOpen, fs, [filePath, ...args]) as Awaited<ReturnType<typeof fs.open>>
    if (failure?.stage !== 'read') return handle
    return {
      stat: (options: { bigint: true }) => handle.stat(options),
      read: (..._readArgs: Parameters<typeof handle.read>) => { throw errno(failure!.code) },
      close: () => handle.close()
    }
  }) as typeof fs.open
  return () => { fs.open = originalOpen }
}

test('unsafe failure paths retain attempt counts without persisting an unsafe sample', () => {
  const summary = emptyContentReadSummary()
  recordContentReadFailure(summary, 'C:/private/file.ts', 'permission')
  recordContentReadFailure(summary, 'src/../private.ts', 'io')
  assert.equal(summary.failedReads, 2)
  assert.deepEqual(summary.failuresByReason, { permission: 1, missing: 0, io: 1 })
  assert.deepEqual(summary.failures, [])
})

test('real scan plus context keeps readable content and records sanitized EACCES, ENOENT and EIO attempts', async () => {
  const root = await makeFixture({
    'README.md': '# Synthetic read failures\n',
    'package.json': '{"name":"synthetic"}',
    'src/main.ts': 'export const entry = true\n',
    'src/normal.ts': 'export const readable = "normal-content-is-included"\n'
  })
  const scan = await scanProject(root)
  const failures = new Map([
    [path.join(root, 'README.md'), { code: 'EACCES' }],
    [path.join(root, 'package.json'), { code: 'ENOENT' }],
    [path.join(root, 'src/main.ts'), { code: 'EIO', stage: 'read' as const }]
  ])
  const attempted: string[] = []
  const restoreOpen = patchContentReadFailures(failures, attempted)
  try {
    const context = await buildContext(scan, 'medium')
    assert.equal(context.contentReadSummary.attemptedReads, 4)
    assert.equal(context.contentReadSummary.successfulReads, 1)
    assert.equal(context.contentReadSummary.failedReads, 3)
    assert.deepEqual(context.contentReadSummary.failuresByReason, { permission: 1, missing: 1, io: 1 })
    assert.deepEqual(context.contentReadSummary.failures.map(({ path: relPath, reason }) => [relPath, reason]), [
      ['README.md', 'permission'],
      ['package.json', 'missing'],
      ['src/main.ts', 'io']
    ])
    assert.ok(context.headerText.includes('尝试读取 4 次'))
    assert.ok(context.headerText.includes('权限不足 1 次'))
    assert.ok(!context.headerText.includes('synthetic-secret'))
    assert.ok(!context.headerText.includes('/private/root'))
    assert.ok(!context.headerText.includes(root))
    const prompts = context.batches.map((batch) => renderBatch(context.headerText, treeToText(scan.tree), batch)).join('\n')
    assert.ok(prompts.includes('normal-content-is-included'), 'readable files remain in the model context')
    assert.ok(!prompts.includes('synthetic-secret'), 'raw filesystem errors never enter the prompt')
    assert.equal(attempted.length, 4)
  } finally {
    restoreOpen()
  }
})

test('all candidate reads failing raises the static error before any provider request', async () => {
  const root = await makeFixture({ 'README.md': '# Synthetic\n', 'package.json': '{"name":"synthetic"}' })
  const scan = await scanProject(root)
  const failureMap = new Map(scan.files.map((file) => [file.absPath, { code: 'EACCES' }]))
  const restoreOpen = patchContentReadFailures(failureMap)
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error('provider should not be called')
  }) as typeof fetch
  try {
    await assert.rejects(generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'backend',
      profile: { id: 'p1', name: 'Mock', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic-key', model: 'mock' },
      signal: new AbortController().signal,
      onProgress: () => undefined
    }), (error: unknown) => error instanceof Error && error.message === CONTENT_READ_MESSAGES.allFailed)
    assert.equal(fetchCalls, 0, 'no real or mocked provider request is made when every attempted read fails')
  } finally {
    restoreOpen()
    globalThis.fetch = originalFetch
  }
})

test('fine mode counts repeated reads of README.ts and keeps scan truncation warning alongside content warning', async () => {
  const root = await makeFixture({
    'README.md': '# Synthetic fine-grain project\n',
    'README.ts': 'export const duplicateCandidate = true\n',
    'z.ts': 'export const omittedByScanner = true\n'
  })
  const scan = await scanProject(root, { maxFiles: 2 })
  assert.equal(scan.truncation?.byFileCount, true, 'fixture uses the scanner’s real file-count truncation')
  assert.ok(scan.files.some((file) => file.relPath === 'README.ts'))
  const duplicateAbsPath = path.join(root, 'README.ts')
  const readCounts = new Map<string, number>()
  const originalOpen = fs.open
  fs.open = (async (filePath: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    const absolute = String(filePath)
    const handle = await Reflect.apply(originalOpen, fs, [filePath, ...args]) as Awaited<ReturnType<typeof fs.open>>
    return {
      stat: (options: { bigint: true }) => handle.stat(options),
      read: (...readArgs: Parameters<typeof handle.read>) => {
        const reads = (readCounts.get(absolute) ?? 0) + 1
        readCounts.set(absolute, reads)
        if (absolute === duplicateAbsPath && reads === 2) throw errno('EIO')
        return handle.read(...readArgs)
      },
      close: () => handle.close()
    }
  }) as typeof fs.open
  try {
    const context = await buildContext(scan, 'fine')
    assert.equal(readCounts.get(duplicateAbsPath), 2, 'README.ts is read in both global and module requests')
    assert.equal(context.contentReadSummary.attemptedReads, 3)
    assert.equal(context.contentReadSummary.successfulReads, 2)
    assert.equal(context.contentReadSummary.failedReads, 1)
    assert.deepEqual(context.contentReadSummary.failures, [{ path: 'README.ts', reason: 'io' }])
    assert.ok(context.headerText.includes('文件数达到上限'))
    assert.ok(context.headerText.includes('内容读取不完整'))
    assert.ok(context.batches.every((batch) => renderBatch(context.headerText, treeToText(scan.tree), batch).includes('文件数达到上限')))
  } finally {
    fs.open = originalOpen
  }
})

test('open/read errors remain boundary failures when the approved identity changes', async () => {
  for (const stage of ['open', 'read'] as const) {
    const root = await makeFixture({ 'README.md': '# Identity boundary\n' })
    const scan = await scanProject(root)
    const file = scan.files.find((candidate) => candidate.relPath === 'README.md')!
    const target = file.absPath
    const originalOpen = fs.open
    fs.open = (async (filePath: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
      if (String(filePath) !== target) return Reflect.apply(originalOpen, fs, [filePath, ...args])
      if (stage === 'open') {
        fsSync.writeFileSync(target, '# Changed identity after open denial\n')
        throw errno('EACCES')
      }
      const handle = await Reflect.apply(originalOpen, fs, [filePath, ...args]) as Awaited<ReturnType<typeof fs.open>>
      return {
        stat: (options: { bigint: true }) => handle.stat(options),
        read: (..._readArgs: Parameters<typeof handle.read>) => {
          fsSync.writeFileSync(target, '# Changed identity after read failure\n')
          throw errno('EIO')
        },
        close: () => handle.close()
      }
    }) as typeof fs.open
    try {
      await assert.rejects(readProjectContent(scan, file), (error: unknown) => error instanceof ProjectContentBoundaryError)
    } finally {
      fs.open = originalOpen
    }
  }
})
test('ProjectContentBoundaryError remains fatal instead of becoming a partial-read warning', async () => {
  const root = await makeFixture({ 'README.md': '# Synthetic boundary project\n' })
  const scan = await scanProject(root)
  const target = path.join(root, 'README.md')
  const originalLstat = fs.lstat
  fs.lstat = (async (filePath: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    if (String(filePath) === target) throw errno('EIO')
    return Reflect.apply(originalLstat, fs, [filePath, ...args])
  }) as typeof fs.lstat
  try {
    await assert.rejects(buildContext(scan, 'medium'), (error: unknown) => error instanceof Error && error.name === 'ProjectContentBoundaryError')
  } finally {
    fs.lstat = originalLstat
  }
})
