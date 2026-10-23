import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { buildContext, renderBatch, renderBatchWithinBudget } from './context-builder.ts'

test('real scan selects a late complete JS/TS unit under a tightened budget and reports actual selection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    const filler = `${'// early noise that should not stand in for a module\n'.repeat(2600)}`
    const source = `${filler}const OPENAI_API_KEY = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop'\nexport function lateCore() {\n  return 'LATE_COMPLETE_CORE_MARKER'\n}\n`
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'structure-selection' }))
    await fs.writeFile(path.join(root, 'src', 'core.ts'), source)
    const scan = await scanProject(root)
    const built = await buildContext(scan, 'medium', { maxChars: 14_000, roleFocus: 'backend' })
    const batch = built.batches[0]
    const file = batch.files.find((item) => item.relPath === 'src/core.ts')
    assert.ok(file, 'the core file should be selected')
    assert.ok(file.content.includes('LATE_COMPLETE_CORE_MARKER'))
    assert.ok(file.content.includes('export function lateCore'))
    assert.equal(file.redacted, true)
    assert.ok(!file.content.includes('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
    assert.equal(file.truncated, true)
    assert.ok(batch.totalChars <= 14_000)
    assert.equal(batch.totalChars, renderBatch(built.headerText, built.treeText, batch).length)
    assert.equal(built.selection?.strategy, 'structure-v1')
    assert.ok((built.selection?.selectedRegions ?? 0) >= 1)
    assert.ok((built.selection?.providedChars ?? Infinity) < source.length)
    assert.ok(built.eligibleFilePaths?.includes('src/core.ts'))
    assert.equal(built.selection?.providedChars, batch.files.reduce((sum, item) => sum + item.content.length, 0))
    assert.equal(built.selection?.selectedFiles, new Set(built.batches.flatMap((item) => item.files.map((entry) => entry.relPath))).size)
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('real Python scan uses indentation regions and ignores fake methods inside a docstring', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    const prefix = `${'# early module documentation that should not dominate context\n'.repeat(2600)}`
    const fakeDocstringBody = `    def fake_method():\n        return 'FAKE_DOCSTRING_METHOD_MARKER'\n${'    explanatory text inside a Python docstring\n'.repeat(1800)}`
    const source = `${prefix}class OversizedService:\n    \"\"\"\n${fakeDocstringBody}    \"\"\"\n    def read_late(self):\n        return 'REAL_LATE_PYTHON_METHOD_MARKER'\n`
    await fs.writeFile(path.join(root, 'service.py'), source)
    const scan = await scanProject(root)
    const scanned = scan.files.find((file) => file.relPath === 'service.py')
    assert.equal(scanned?.ext, 'py', 'exercise the scanner extension value without normalizing the fixture')
    const built = await buildContext(scan, 'medium', { maxChars: 14_000 })
    const rendered = built.batches.flatMap((batch) => batch.files).find((file) => file.relPath === 'service.py')
    assert.ok(rendered?.content.includes('REAL_LATE_PYTHON_METHOD_MARKER'))
    assert.ok(rendered?.content.includes('def read_late'))
    assert.ok(!rendered?.selectionRegions?.some((region) => region.label === 'fake_method'))
    assert.ok(!rendered?.content.includes('FAKE_DOCSTRING_METHOD_MARKER'))
    assert.ok(rendered?.truncated)
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('real README survives final second-fit through a budgeted head and tail excerpt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    const readme = `README-IMPORTANT-START\n${'project documentation details\n'.repeat(4500)}\nREADME_KEEP_END`
    await fs.writeFile(path.join(root, 'README.md'), readme)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'document-second-fit' }))
    const built = await buildContext(await scanProject(root), 'medium')
    const batch = built.batches[0]
    const fullReadme = batch.files.find((file) => file.relPath === 'README.md')
    assert.ok(fullReadme?.content.includes('README_KEEP_END'), 'the first build has room for the complete README')
    const final = renderBatchWithinBudget(built.headerText, built.treeText, batch, 18_000)
    assert.ok(final.truncated)
    assert.ok(final.text.includes('README-IMPORTANT-START'))
    assert.ok(final.text.includes('README_KEEP_END'))
    assert.ok(final.text.includes('文档片段已截断'))
    assert.ok(final.text.length <= 18_000)
    assert.ok(final.selection?.filePaths.includes('README.md'))
    const newline = String.fromCharCode(10)
    const readmeBody = final.text.split('### 文件：README.md（内容过长已截断）' + newline + '```' + newline)[1]?.split(newline + '```')[0] ?? ''
    const manifestBody = final.text.split('### 文件：package.json' + newline + '```' + newline)[1]?.split(newline + '```')[0] ?? ''
    assert.equal(final.selection?.providedChars, readmeBody.length + manifestBody.length)
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('an already-aborted context build stops before reading project contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    await fs.writeFile(path.join(root, 'index.ts'), 'export const value = 1')
    const scan = await scanProject(root)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(buildContext(scan, 'medium', { signal: controller.signal }), (error: unknown) =>
      error instanceof Error && error.name === 'AbortError'
    )
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('context build observes cancellation after yielding to the event loop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    await fs.writeFile(path.join(root, 'index.ts'), `export function work() { return 1 }\n${'// bounded input\n'.repeat(5000)}`)
    const scan = await scanProject(root)
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 0)
    await assert.rejects(buildContext(scan, 'medium', { signal: controller.signal }), (error: unknown) =>
      error instanceof Error && error.name === 'AbortError'
    )
    clearTimeout(abortTimer)
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})
