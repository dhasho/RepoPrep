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

test('real Python scan keeps decorated multi-line headers whole through build and final fitting', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    const padding = `${'# module background notes that should not dominate context\n'.repeat(2600)}`
    const source = `${padding}def plain_helper():\n${'    # plain helper detail\n'.repeat(48)}    return 'PLAIN_BODY'\n\n@retry(times=3)\n@app.route(\n    '/late',\n    methods=['GET'],\n)\nasync def late_handler():\n    return 'LATE_DECORATED_BODY'\n\ndef tail_sibling():\n${'    # tail sibling detail\n'.repeat(48)}    return 'TAIL_BODY'\n`
    await fs.writeFile(path.join(root, 'service.py'), source)
    const scan = await scanProject(root)
    const built = await buildContext(scan, 'medium', { maxChars: 14_000, roleFocus: 'backend' })
    const rendered = built.batches.flatMap((batch) => batch.files).find((file) => file.relPath === 'service.py')
    assert.ok(rendered?.truncated)
    const regions = rendered?.selectionRegions ?? []
    const plain = regions.find((region) => region.label === 'plain_helper')
    const handler = regions.find((region) => region.label === 'late_handler')
    const tail = regions.find((region) => region.label === 'tail_sibling')
    assert.ok(plain && handler && tail, 'every Python declaration survives as a selection region')
    assert.ok(handler.complete)
    assert.ok(handler.text.includes('@retry(times=3)'))
    assert.ok(handler.text.includes("methods=['GET']"))
    assert.ok(handler.text.includes('async def late_handler'))
    assert.ok(handler.text.includes('LATE_DECORATED_BODY'))
    assert.ok(!handler.text.includes('PLAIN_BODY'))
    assert.ok(!handler.text.includes('tail_sibling'))
    assert.ok(plain.complete)
    assert.ok(plain.text.includes('PLAIN_BODY'))
    assert.ok(!plain.text.includes('@retry'), 'the previous sibling must not swallow the next decorator block')
    assert.ok(tail.complete)
    assert.ok(tail.text.includes('TAIL_BODY'))
    assert.ok(!tail.text.includes('@'))
    const base = renderBatchWithinBudget(built.headerText, built.treeText, { ...built.batches[0], files: [] }, 100_000).text
    const final = renderBatchWithinBudget(built.headerText, built.treeText, built.batches[0], base.length + 420)
    assert.ok(final.text.includes('@retry(times=3)'))
    assert.ok(final.text.includes('async def late_handler'))
    assert.ok(final.text.includes('LATE_DECORATED_BODY'))
    assert.ok(!final.text.includes('PLAIN_BODY'), 'final fitting keeps the decorated handler over the larger plain sibling')
    assert.ok(final.selection?.filePaths.includes('service.py'))
    assert.equal(final.selection?.selectedRegions, 1)
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('real Python build prefers the complete implementation over overload stubs, closures and late helpers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    const padding = `${'# module background notes that force structural selection\n'.repeat(2600)}`
    const source = `${padding}class Downloader:
    @overload
    def fetch(self, url: str) -> bytes: ...
    def fetch(self, url=None):
        def retry_once():
            return 'NESTED_RETRY_BODY'
        value = retry_once()
        self.adapter(url)
        self.validate(value)
        return 'REAL_FETCH_IMPLEMENTATION_BODY'
    def adapter(self, url):
        return 'ADAPTER_BODY'
    def validate(self, value):
        return 'VALIDATE_BODY'
    def late_helper_a(self):
        return 1
    def late_helper_b(self):
        return 2
    def late_helper_c(self):
        return 3
    def late_helper_d(self):
        return 4
`
    await fs.writeFile(path.join(root, 'service.py'), source)
    const scan = await scanProject(root)
    const built = await buildContext(scan, 'medium', { maxChars: 8_000 })
    const rendered = built.batches.flatMap((batch) => batch.files).find((file) => file.relPath === 'service.py')
    assert.ok(rendered?.truncated)
    assert.ok(rendered.content.includes('def fetch(self, url=None):'))
    assert.ok(rendered.content.includes('REAL_FETCH_IMPLEMENTATION_BODY'))
    const fetchRegions = (rendered.selectionRegions ?? []).filter((region) => region.label === 'fetch' && region.text.includes('REAL_FETCH_IMPLEMENTATION_BODY'))
    assert.ok(fetchRegions.length >= 1 && fetchRegions.every((region) => region.complete), 'the real implementation survives the build as a complete unit')
    assert.ok(!(rendered.selectionRegions ?? []).some((region) => region.label === 'retry_once'), 'a fitting parent keeps its closure out via overlap')
    const base = renderBatchWithinBudget(built.headerText, built.treeText, { ...built.batches[0], files: [] }, 100_000).text
    const final = renderBatchWithinBudget(built.headerText, built.treeText, built.batches[0], base.length + 320)
    assert.ok(final.truncated)
    assert.ok(final.text.includes('REAL_FETCH_IMPLEMENTATION_BODY'), 'final fitting keeps the complete parent implementation')
    assert.ok(!final.text.includes('ADAPTER_BODY'), 'under scarcity the orchestrating implementation outranks single-step helpers')
    assert.ok(final.selection?.filePaths.includes('service.py'))
    assert.equal(final.selection?.selectedRegions, 1)
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

test('README excerpt remains visible when both build and final fitting tighten the budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    const readme = `README-IMPORTANT-START\n${'second-stage documentation detail\n'.repeat(4200)}\nREADME_KEEP_END`
    await fs.writeFile(path.join(root, 'README.md'), readme)
    const scan = await scanProject(root)
    const built = await buildContext(scan, 'medium', { maxChars: 16_000 })
    const batch = built.batches[0]
    const firstFitFile = batch.files.find((file) => file.relPath === 'README.md')
    assert.ok(firstFitFile?.truncated, 'the initial build should honestly mark its partial README')
    assert.ok(firstFitFile.content.includes('README-IMPORTANT-START'))
    assert.ok(firstFitFile.content.includes('README_KEEP_END'))
    const final = renderBatchWithinBudget(built.headerText, built.treeText, batch, 9_000)
    assert.ok(final.truncated)
    assert.ok(final.text.includes('README-IMPORTANT-START'))
    assert.ok(final.text.includes('README_KEEP_END'))
    assert.ok(final.text.includes('文档片段已截断'))
    assert.ok(final.text.length <= 9_000)
    assert.ok(final.selection?.filePaths.includes('README.md'))
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('fair final fitting keeps an important entry point beside an oversized README', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'README.md'), `README-IMPORTANT-START\n${'project architecture and design notes\n'.repeat(6500)}\nREADME_KEEP_END`)
    await fs.writeFile(path.join(root, 'src', 'entry.ts'), "export const CORE_SOURCE_KEEP = 'core-entry-marker'\n")
    const built = await buildContext(await scanProject(root), 'medium')
    const batch = built.batches[0]
    const final = renderBatchWithinBudget(built.headerText, built.treeText, batch, 24_000)
    assert.ok(final.truncated)
    assert.ok(final.text.includes('README-IMPORTANT-START'))
    assert.ok(final.text.includes('README_KEEP_END'))
    assert.ok(final.text.includes('CORE_SOURCE_KEEP'))
    assert.ok(final.text.includes('core-entry-marker'))
    assert.ok(final.text.length <= 24_000)
    assert.ok(final.selection?.filePaths.includes('README.md'))
    assert.ok(final.selection?.filePaths.includes('src/entry.ts'))
  } finally {
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('repoprep-structure-selection-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('final token-style fitting extracts a late complete function from a full CJK-heavy file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repoprep-structure-selection-'))
  try {
    const comments = `${'// 这是位于文件前部的中文说明，帮助解释模块背景和历史设计。\n'.repeat(1500)}`
    const functionSource = `export function processJob(input: string) {\n  const normalized = input.trim()\n  return { status: 'done', value: normalized, marker: 'LATE_CJK_CORE_FUNCTION' }\n}\n`
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'main.ts'), `${comments}${functionSource}`)
    const built = await buildContext(await scanProject(root), 'medium')
    const batch = built.batches[0]
    const wholeFile = batch.files.find((file) => file.relPath === 'src/main.ts')
    assert.ok(wholeFile)
    assert.equal(wholeFile.truncated, false, 'the complete file fits in the build character budget')
    assert.equal(wholeFile.selectionRegions, undefined)
    assert.ok((wholeFile.selectionCandidates?.length ?? 0) > 0, 'the redacted AST candidates are cached for final fitting')
    const final = renderBatchWithinBudget(built.headerText, built.treeText, batch, 15_000)
    assert.ok(final.truncated)
    assert.ok(final.text.includes('export function processJob(input: string)'))
    assert.ok(final.text.includes('LATE_CJK_CORE_FUNCTION'))
    assert.ok(final.text.includes("return { status: 'done', value: normalized, marker: 'LATE_CJK_CORE_FUNCTION' }"))
    assert.ok(final.selection?.filePaths.includes('src/main.ts'))
    assert.ok((final.selection?.selectedRegions ?? 0) >= 1)
    assert.ok(final.text.length <= 15_000)
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
