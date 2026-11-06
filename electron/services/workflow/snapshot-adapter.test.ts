// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { test } from 'node:test'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import os from 'node:os'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createWorkflowSnapshot } from './snapshot-adapter.ts'

async function fixture(files: Record<string, string> = { 'src/a.ts': 'export const value = 1\n' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm02-snapshot-'))
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return { root, scan: await scanProject(root) }
}

test('snapshot exposes only approved relative paths and immutable redacted reads', async (t) => {
  const { root, scan } = await fixture({ 'src/a.ts': 'const token = "sk-proj-abcdefghijklmnop"\n' })
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-1' })
  assert.equal(snapshot.files.length, 1)
  assert.equal(snapshot.files[0].relPath, 'src/a.ts')
  assert.ok(!JSON.stringify(snapshot).includes(root))
  const first = await snapshot.readFile(snapshot.files[0].fileId)
  assert.match(first.read.text, /REDACTED/)
  assert.equal(first.read.indexStatus, 'available')
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.read))
  assert.equal(snapshot.ownsRead(first.read), true)
  assert.equal(snapshot.ownsRead({ ...first.read }), false)
  const cached = await snapshot.readFile(snapshot.files[0].fileId)
  assert.equal(cached.cacheHit, true)
  assert.equal(cached.consumedBytes, 0)
  assert.equal(cached.read, first.read)
})

test('changed snapshot invalidates reads and prior capabilities', async (t) => {
  const { root, scan } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-1' })
  const read = await snapshot.readFile(snapshot.files[0].fileId)
  await writeFile(path.join(root, 'src/a.ts'), 'export const value = 2\n')
  await assert.rejects(snapshot.readFile(snapshot.files[0].fileId), (error: unknown) => (error as { code?: string }).code === 'stale-snapshot')
  assert.equal(snapshot.ownsRead(read.read), false)
})

test('unsupported parser keeps plain redacted text available', async (t) => {
  const { root, scan } = await fixture({ 'README.md': 'hello\n' })
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-1' })
  const read = await snapshot.readFile(snapshot.files[0].fileId)
  assert.equal(read.read.text, 'hello\n')
  assert.equal(read.read.analysis, null)
  assert.equal(read.read.indexStatus, 'unavailable')
})

test('rejects invalid options and unknown file IDs with static workflow errors', async (t) => {
  const { root, scan } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(createWorkflowSnapshot(scan, { projectId: '../bad' }), (error: unknown) => (error as { code?: string }).code === 'invalid-argument')
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-1' })
  await assert.rejects(snapshot.readFile('../outside'), (error: unknown) => {
    const result = error as { code?: string; message?: string }
    return result.code === 'permission-denied' && result.message === 'Workflow operation rejected.'
  })
})
