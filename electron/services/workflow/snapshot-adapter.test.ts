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
import { captureProjectSnapshot } from '../project-snapshot.ts'
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

test('snapshot identity accepts the same bounded identity syntax as RunSpec', async t => {
  const { root, scan } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project:authorized-1' })
  assert.equal(snapshot.projectId, 'project:authorized-1')
  const read = await snapshot.readFile(snapshot.files[0].fileId)
  assert.equal(read.read.snapshotId, snapshot.snapshotId)
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

test('file IDs stay bound to captured file metadata after caller mutation', async (t) => {
  const { root, scan } = await fixture({ 'src/a.ts': "export const marker = 'A'\n", 'src/b.js': "export const marker = 'B'\n" })
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-1' })
  const a = snapshot.files.find(file => file.relPath === 'src/a.ts')!
  const originalA = scan.files.find(file => file.relPath === 'src/a.ts')!
  const originalB = scan.files.find(file => file.relPath === 'src/b.js')!
  assert.equal(originalA.size, originalB.size)
  originalA.relPath = 'src/b.js'
  originalA.size = originalB.size
  originalA.ext = 'js'
  originalA.isContentCandidate = true
  const read = await snapshot.readFile(a.fileId)
  assert.equal(read.read.relPath, 'src/a.ts')
  assert.match(read.read.text, /marker = 'A'/)
})

test('captured snapshot metadata is isolated from later capture-object mutation', async (t) => {
  const { root, scan } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = await createWorkflowSnapshot(scan, { projectId: 'project-1' })
  const externalCapture = await captureProjectSnapshot(scan)
  const entry = externalCapture.entries.find(item => item.path === 'src/a.ts')!
  entry.path = 'tampered.ts'
  await snapshot.assertCurrent()
})

test('normalizes CRLF and CR before redaction and marks transformed line mapping unknown', async (t) => {
  const { root, scan } = await fixture({ 'src/lines.ts': 'placeholder\n' })
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = 'const first = 1\r\nconst token = "sk-proj-abcdefghijklmnop"\rconst last = 3\r'
  let analyzedText = ''
  const snapshot = await createWorkflowSnapshot(scan, {
    projectId: 'project-1',
    reader: async () => source,
    analyzer: (relPath, text) => {
      analyzedText = text
      return { parseable: true, imports: [], symbols: [] }
    }
  })
  const read = await snapshot.readFile(snapshot.files[0].fileId)
  assert.equal(read.read.text.includes('\r'), false)
  assert.equal((read.read.text.match(/\n/g) ?? []).length, 3)
  assert.equal(analyzedText, read.read.text)
  assert.equal(read.read.lineMapping, 'unknown')
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
