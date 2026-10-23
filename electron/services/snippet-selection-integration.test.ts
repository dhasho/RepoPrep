import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { buildContext, renderBatch } from './context-builder.ts'

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
