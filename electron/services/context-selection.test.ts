// End-to-end regressions for real-scan context selection and rendered budgets.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { afterEach } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import fs from 'node:fs/promises'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import os from 'node:os'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import path from 'node:path'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { CONTEXT_CHAR_BUDGETS } from '../../shared/context-budget.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { LlmProfile } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { buildContext, renderBatch } from './context-builder.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { generateInterview } from './generator.ts'

const tempDirs: string[] = []
const profile: LlmProfile = {
  id: 'context-selection-fixture',
  name: 'Mock',
  baseUrl: 'https://mock.example/v1',
  apiKey: 'must-not-enter-context',
  model: 'mock-model'
}

afterEach(async () => {
  const tempRoot = path.resolve(os.tmpdir())
  for (const dir of tempDirs.splice(0)) {
    const resolved = path.resolve(dir)
    assert.equal(path.dirname(resolved), tempRoot)
    assert.ok(path.basename(resolved).startsWith('repoprep-context-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-context-selection-'))
  tempDirs.push(root)
  await fs.mkdir(path.join(root, 'src', 'core', 'deep'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'shared'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'auth'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'billing'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'native'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'scripts'), { recursive: true })
  await fs.writeFile(path.join(root, 'README.md'), `README_KEEP_START\n${'overview '.repeat(10_000)}\nREADME_KEEP_END`)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'selection-fixture', main: 'src/core/deep/entry.ts' }))
  await fs.writeFile(path.join(root, 'src', 'core', 'deep', 'entry.ts'), "import { core } from '../../shared/engine.js'\nexport const MANIFEST_DEEP_ENTRY = core\n")
  await fs.writeFile(path.join(root, 'src', 'shared', 'engine.ts'), 'export const DEEP_REFERENCED_CORE = "engine"\n')
  await fs.writeFile(path.join(root, 'src', 'auth', 'service.ts'), 'export const AUTH_MODULE_REPRESENTATIVE = true\nconst OPENAI_API_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop"\n')
  await fs.writeFile(path.join(root, 'src', 'billing', 'service.ts'), 'export const BILLING_MODULE_REPRESENTATIVE = true\n')
  await fs.writeFile(path.join(root, 'src', 'core', 'deep', 'runtime.mts'), 'export const MTS_SOURCE_KEEP = true\n')
  await fs.writeFile(path.join(root, 'src', 'core', 'deep', 'legacy.cts'), 'export const CTS_SOURCE_KEEP = true\n')
  await fs.writeFile(path.join(root, 'src', 'native', 'public.hh'), 'const int HH_SOURCE_KEEP = 1;\n')
  await fs.writeFile(path.join(root, 'src', 'native', 'bridge.mm'), 'int MM_SOURCE_KEEP = 1;\n')
  await fs.writeFile(path.join(root, 'src', 'native', 'analytics.r'), 'R_SOURCE_KEEP <- TRUE\n')
  await fs.writeFile(path.join(root, 'src', 'scripts', 'release.sh'), 'SH_SOURCE_KEEP=1\n')
  await fs.writeFile(path.join(root, 'src', 'scripts', 'release.ps1'), '$PS1_SOURCE_KEEP = 1\n')
  return root
}

function installMock(capture: Array<{ messages: Array<{ role: string; content: string }> }>): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    capture.push({ messages: (Array.isArray(body.messages) ? body.messages : []) as typeof capture[number]['messages'] })
    const prompt = capture.at(-1)?.messages.map((message) => message.content).join('\n') ?? ''
    const requested = Number(prompt.match(/(?:严格|约)\s*(\d+)\s*题/)?.[1] ?? 6)
    const result = {
      projectSummary: 'A synthetic project.',
      sections: [{ title: 'Project', summary: 'Generated from the fixture.', questions: Array.from({ length: requested }, (_, index) => ({ question: `Question ${index + 1}?`, answer: 'Answer.', followUps: [] })) }],
      glossary: {}
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return () => { globalThis.fetch = originalFetch }
}

test('real scan keeps full fitting documentation, covers deep manifest/reference source, and stays stable under reversed scans', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  const built = await buildContext(scan, 'fine')
  assert.equal(built.contextTruncation.contentTruncated, false, 'the selected text fits without omission')
  assert.ok(built.batches.some((batch) => batch.files.some((file) => file.relPath === 'README.md' && file.content.includes('README_KEEP_END'))),
    'a large but fitting README must remain complete')
  const allFiles = built.batches.flatMap((batch) => batch.files.map((file) => file.relPath))
  assert.ok(allFiles.includes('src/core/deep/entry.ts'), 'the manifest-declared deep entry is selected')
  assert.ok(allFiles.includes('src/shared/engine.ts'), 'the imported deep core is selected')
  assert.ok(allFiles.includes('src/auth/service.ts'))
  assert.ok(allFiles.includes('src/billing/service.ts'))
  for (const batch of built.batches) {
    assert.equal(batch.totalChars, renderBatch(built.headerText, built.treeText, batch).length)
    assert.ok(batch.totalChars <= CONTEXT_CHAR_BUDGETS.fine)
  }

  const medium = await buildContext(scan, 'medium')
  assert.equal(medium.contextTruncation.contentTruncated, false)
  assert.ok(medium.batches[0].files.some((file) => file.relPath === 'README.md' && file.content.includes('README_KEEP_END')),
    'a medium context with enough total room must preserve the complete README')

  scan.files.reverse()
  const reversed = await buildContext(scan, 'fine')
  scan.files.reverse()
  assert.deepEqual(reversed.batches.map((batch) => [batch.label, batch.files.map((file) => file.relPath)]),
    built.batches.map((batch) => [batch.label, batch.files.map((file) => file.relPath)]))

  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restoreFetch = installMock(requests)
  try {
    await generateInterview({
      scan, granularity: 'fine', roleFocus: 'backend', profile,
      signal: new AbortController().signal, onProgress: () => undefined
    })
  } finally { restoreFetch() }
  const prompt = requests.flatMap((request) => request.messages.map((message) => message.content)).join('\n')
  for (const marker of ['README_KEEP_END', 'MANIFEST_DEEP_ENTRY', 'DEEP_REFERENCED_CORE', 'AUTH_MODULE_REPRESENTATIVE', 'BILLING_MODULE_REPRESENTATIVE']) {
    assert.ok(prompt.includes(marker), `generated requests should include ${marker}`)
  }
  assert.doesNotMatch(prompt, /sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ/)
  assert.doesNotMatch(prompt, new RegExp(profile.apiKey))
  for (const request of requests) {
    assert.ok(request.messages.reduce((sum, message) => sum + message.content.length, 0) <= CONTEXT_CHAR_BUDGETS.fine)
  }
})

test('coarse context limits approved reads to documentation and configuration candidates', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  const originalOpen = fs.open
  const opened: string[] = []
  fs.open = (async (filePath: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    opened.push(String(filePath))
    return Reflect.apply(originalOpen, fs, [filePath, ...args]) as Awaited<ReturnType<typeof fs.open>>
  }) as typeof fs.open
  let built: Awaited<ReturnType<typeof buildContext>>
  try {
    built = await buildContext(scan, 'coarse')
  } finally { fs.open = originalOpen }
  assert.ok(opened.length > 0)
  assert.ok(opened.every((filePath) => !/[/\\]src[/\\]/.test(filePath)), 'coarse probes and content reads must not open source files')
  assert.ok(built.batches.flatMap((batch) => batch.files).every((file) => !/\.(ts|tsx|js|py)$/i.test(file.relPath)))
})

test('lock files stay in the tree but never enter context bodies or local model requests', async () => {
  const root = await makeFixture()
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"name":"LOCK_BODY_MARKER_PACKAGE_LOCK","lockfileVersion":3}')
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: LOCK_BODY_MARKER_PNPM_LOCK\n')
  await fs.writeFile(path.join(root, 'yarn.lock'), '# LOCK_BODY_MARKER_YARN_LOCK\n')
  const scan = await scanProject(root)
  for (const relPath of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    assert.ok((scan.tree.children ?? []).some((node) => node.name === relPath), `${relPath} remains visible in the project tree`)
  }

  const markers = ['LOCK_BODY_MARKER_PACKAGE_LOCK', 'LOCK_BODY_MARKER_PNPM_LOCK', 'LOCK_BODY_MARKER_YARN_LOCK']
  for (const granularity of ['coarse', 'medium', 'fine'] as const) {
    const built = await buildContext(scan, granularity)
    const body = built.batches.flatMap((batch) => batch.files).map((file) => file.content).join('\n')
    for (const marker of markers) assert.ok(!body.includes(marker), `${granularity} batch body must exclude ${marker}`)
    assert.ok(built.batches.flatMap((batch) => batch.files).some((file) =>
      file.relPath === 'package.json' && file.content.includes('selection-fixture')),
    `${granularity} retains the real root manifest content`)
    if (granularity === 'fine') {
      assert.ok(built.batches.some((batch) => batch.kind === 'module' && batch.files.some((file) => file.content.includes('AUTH_MODULE_REPRESENTATIVE'))))
    }

    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const restoreFetch = installMock(requests)
    try {
      await generateInterview({
        scan, granularity, roleFocus: 'backend', profile,
        signal: new AbortController().signal, onProgress: () => undefined
      })
    } finally { restoreFetch() }
    const prompt = requests.flatMap((request) => request.messages.map((message) => message.content)).join('\n')
    for (const marker of markers) assert.ok(!prompt.includes(marker), `${granularity} model requests must exclude ${marker}`)
    assert.ok(prompt.includes('selection-fixture'), `${granularity} model requests retain the root manifest content`)
    for (const request of requests) {
      assert.ok(request.messages.reduce((sum, message) => sum + message.content.length, 0) <= CONTEXT_CHAR_BUDGETS[granularity],
        `${granularity} model request stays within its character budget`)
    }
  }
})

test('fine modules include scanner-recognized source types while coarse keeps business source out', async () => {
  const root = await makeFixture()
  const scan = await scanProject(root)
  const requiredSources = [
    ['src/core/deep/runtime.mts', 'MTS_SOURCE_KEEP'], ['src/core/deep/legacy.cts', 'CTS_SOURCE_KEEP'],
    ['src/native/public.hh', 'HH_SOURCE_KEEP'], ['src/native/bridge.mm', 'MM_SOURCE_KEEP'],
    ['src/native/analytics.r', 'R_SOURCE_KEEP'], ['src/scripts/release.sh', 'SH_SOURCE_KEEP'],
    ['src/scripts/release.ps1', 'PS1_SOURCE_KEEP']
  ] as const
  for (const [relPath] of requiredSources) {
    assert.ok(scan.files.some((file) => file.relPath === relPath && file.isContentCandidate), `scanner approves ${relPath}`)
  }
  const expected = [
    'MTS_SOURCE_KEEP', 'CTS_SOURCE_KEEP', 'HH_SOURCE_KEEP', 'MM_SOURCE_KEEP',
    'R_SOURCE_KEEP', 'SH_SOURCE_KEEP', 'PS1_SOURCE_KEEP'
  ]
  const fine = await buildContext(scan, 'fine')
  const fineBody = fine.batches.filter((batch) => batch.kind === 'module')
    .flatMap((batch) => batch.files).map((file) => file.content).join('\n')
  const missing = expected.filter((marker) => !fineBody.includes(marker))
  assert.deepEqual(missing, [], `fine module context should include all scanner-approved source types; missing ${missing.join(', ')}`)
  assert.equal(fine.moduleCount, 1, 'all fixture source files remain grouped under the single top-level src module')

  const coarse = await buildContext(scan, 'coarse')
  const coarseBody = coarse.batches.flatMap((batch) => batch.files).map((file) => file.content).join('\n')
  for (const marker of expected) assert.ok(!coarseBody.includes(marker), `coarse context must exclude business source ${marker}`)
  assert.ok(coarseBody.includes('selection-fixture'), 'coarse still includes the root package manifest')
})

test('a README over the medium budget leaves selected source representatives and exact bounded renders', async () => {
  const root = await makeFixture()
  await fs.writeFile(path.join(root, 'README.md'), `README_CONSTRAINED_START\n${'R'.repeat(230_000)}\nREADME_CONSTRAINED_END`)
  await fs.mkdir(path.join(root, 'src', 'auth', '__tests__'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'auth', '__tests__', 'noise.test.ts'), `export const TEST_FIXTURE_NOISE = '${'T'.repeat(80_000)}'\n`)
  const scan = await scanProject(root)
  const built = await buildContext(scan, 'medium')
  assert.equal(built.contextTruncation.contentTruncated, true)
  const files = built.batches.flatMap((batch) => batch.files)
  for (const relPath of [
    'README.md', 'src/core/deep/entry.ts', 'src/shared/engine.ts',
    'src/auth/service.ts', 'src/billing/service.ts'
  ]) {
    assert.ok(files.some((file) => file.relPath === relPath), `${relPath} should retain a representative slice`)
  }
  assert.ok(files.some((file) => file.relPath === 'package.json' && file.content.includes('selection-fixture')),
    'the root manifest remains useful under constrained budgets')
  for (const marker of ['MANIFEST_DEEP_ENTRY', 'DEEP_REFERENCED_CORE', 'AUTH_MODULE_REPRESENTATIVE', 'BILLING_MODULE_REPRESENTATIVE']) {
    assert.ok(files.some((file) => file.content.includes(marker)), `test fixture content must not displace useful implementation ${marker}`)
  }
  assert.ok(files.find((file) => file.relPath === 'README.md')?.content.includes('README_CONSTRAINED_START'))
  for (const batch of built.batches) {
    assert.equal(batch.totalChars, renderBatch(built.headerText, built.treeText, batch).length)
    assert.ok(batch.totalChars <= CONTEXT_CHAR_BUDGETS.medium)
  }
  scan.files.reverse()
  const reversed = await buildContext(scan, 'medium')
  scan.files.reverse()
  assert.deepEqual(reversed.batches.map((batch) => batch.files.map((file) => file.relPath)),
    built.batches.map((batch) => batch.files.map((file) => file.relPath)), 'constrained selection order is stable under reversed scans')
})

test('a deep referenced core remains in the real prompt beside 2000 ordinary files without thousands of empty picks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-context-selection-'))
  tempDirs.push(root)
  await fs.mkdir(path.join(root, 'src', 'common'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'common', 'zcore', 'deep'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'large-selection-fixture', main: 'src/entry.ts' }))
  await fs.writeFile(path.join(root, 'src', 'entry.ts'), "import { DEEP_CORE_SELECTION_KEEP } from './common/zcore/deep/core.js'\nexport const ENTRY_SELECTION_KEEP = DEEP_CORE_SELECTION_KEEP\n")
  await fs.writeFile(path.join(root, 'src', 'common', 'zcore', 'deep', 'core.ts'), 'export const DEEP_CORE_SELECTION_KEEP = "referenced"\n')
  for (let start = 0; start < 2_000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, async (_, offset) => {
      const index = start + offset
      const name = `file-${String(index).padStart(4, '0')}.ts`
      await fs.writeFile(path.join(root, 'src', 'common', name), `export const ORDINARY_${index} = ${index}\n`)
    }))
  }
  const scan = await scanProject(root)
  assert.ok(scan.files.length > 128, 'fixture exceeds the bounded probe size')
  const built = await buildContext(scan, 'fine')
  assert.ok(built.batches.some((batch) => batch.kind === 'module' && batch.files.length <= 64))
  for (const batch of built.batches) {
    assert.equal(batch.totalChars, renderBatch(built.headerText, built.treeText, batch).length)
    assert.ok(batch.totalChars <= CONTEXT_CHAR_BUDGETS.fine)
  }
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const restore = installMock(requests)
  try {
    await generateInterview({
      scan, granularity: 'fine', roleFocus: 'backend', profile,
      signal: new AbortController().signal, onProgress: () => undefined
    })
  } finally { restore() }
  const prompt = requests.flatMap((request) => request.messages.map((message) => message.content)).join('\n')
  assert.ok(prompt.includes('DEEP_CORE_SELECTION_KEEP'))
  assert.ok(prompt.includes('ENTRY_SELECTION_KEEP'))
  const headingCounts = requests.map((request) => {
    const requestText = request.messages.map((message) => message.content).join('\n')
    return (requestText.match(/### 文件：/g) ?? []).length
  })
  assert.ok(headingCounts.every((count) => count <= 66), `each prompt should contain a bounded file window: ${headingCounts}`)
  assert.doesNotMatch(prompt, /ORDINARY_1999/)
})

test('coarse water filling keeps an oversized README and small project manifests', async () => {
  const root = await makeFixture()
  await fs.writeFile(path.join(root, 'README.md'), `README_MANIFEST_START\n${'R'.repeat(230_000)}\nREADME_MANIFEST_END`)
  await fs.writeFile(path.join(root, 'go.mod'), 'module example.test/app\n')
  const scan = await scanProject(root)
  const built = await buildContext(scan, 'coarse')
  const files = built.batches.flatMap((batch) => batch.files)
  for (const relPath of ['README.md', 'package.json', 'go.mod']) {
    assert.ok(files.some((file) => file.relPath === relPath && file.content.length > 0), `${relPath} should retain useful content`)
  }
  assert.ok(files.some((file) => file.relPath === 'README.md' && file.truncated))
  assert.ok(built.contextTruncation.contentTruncated)
  assert.ok(built.batches.every((batch) => batch.totalChars <= CONTEXT_CHAR_BUDGETS.coarse))
})

test('more than 128 small files near the fine boundary use exact rendered overhead', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-context-selection-'))
  tempDirs.push(root)
  await fs.mkdir(path.join(root, 'src', 'common'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"many-small-files"}')
  for (let start = 0; start < 200; start += 50) {
    await Promise.all(Array.from({ length: 50 }, async (_, offset) => {
      const index = start + offset
      await fs.writeFile(path.join(root, 'src', 'common', `small-${String(index).padStart(3, '0')}.ts`), `export const SMALL_${index} = '${'x'.repeat(4_800)}'\n`)
    }))
  }
  const scan = await scanProject(root)
  assert.ok(scan.files.length > 128)
  const built = await buildContext(scan, 'fine')
  const batch = built.batches.find((item) => item.kind === 'module')
  assert.ok(batch, `scan=${scan.files.length}, ext=${scan.files.slice(0, 3).map((file) => `${file.ext}/${file.isContentCandidate}`).join(',')}, modules=${built.moduleCount}, reads=${JSON.stringify(built.contentReadSummary)}`)
  assert.ok(batch.files.length <= 64)
  assert.ok(batch.totalChars >= CONTEXT_CHAR_BUDGETS.fine - 8_000, 'the selected text should use the available budget without crossing it')
  assert.equal(batch.totalChars, renderBatch(built.headerText, built.treeText, batch).length)
  assert.ok(batch.totalChars <= CONTEXT_CHAR_BUDGETS.fine)
})
