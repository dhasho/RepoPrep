import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scanProject } from '../../../electron/services/scanner.ts'
import { createWorkflowSnapshot } from '../../../electron/services/workflow/snapshot-adapter.ts'
import { readProjectContent } from '../../../electron/services/project-content-reader.ts'

const metrics = { unauthorizedReads: 0, staleSnapshotAccepted: 0, cacheInvalidationPassed: false, textFallbackPassed: false }
async function project(entries = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repoprep-m02-'))
  for (const [relative, body] of Object.entries(entries)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return { root, scan: await scanProject(root) }
}
async function withProject(entries, callback) {
  const value = await project(entries)
  try { await callback(value) } finally { await rm(value.root, { recursive: true, force: true }) }
}
function byPath(snapshot, relPath) { return snapshot.files.find(file => file.relPath === relPath) }

export function createChecks() {
  const checks = new Map()
  checks.set('m02:ordinary-project', async ctx => withProject({ 'src/main.ts': 'export const answer = 42\n' }, async ({ scan }) => {
    let readerCalls = 0
    const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-ordinary', reader: async (...args) => {
      readerCalls++
      if (!args[0].files.includes(args[1]) || !args[1].isContentCandidate) metrics.unauthorizedReads++
      return readProjectContent(...args)
    } })
    const item = byPath(snapshot, 'src/main.ts')
    assert.ok(item)
    assert.equal((await snapshot.readFile(item.fileId)).read.text, 'export const answer = 42\n')
    const denied = await snapshot.readFile('not-an-approved-id').then(() => false, error => error?.code === 'permission-denied')
    assert.equal(denied, true)
    assert.equal(readerCalls, 1, 'only the approved read may reach the reader')
    ctx.addRawReference('assertion:m02:ordinary-relative-approved-read-and-denial')
    return { approved: true, denied: true }
  }))
  checks.set('m02:nested-ignore', async ctx => withProject({ '.gitignore': 'nested/private/\n', 'nested/private/hidden.ts': 'secret source', 'nested/public.ts': 'export const visible = true' }, async ({ scan }) => {
    const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-ignore' })
    assert.ok(byPath(snapshot, 'nested/public.ts'))
    assert.equal(byPath(snapshot, 'nested/private/hidden.ts'), undefined)
    ctx.addRawReference('assertion:m02:nested-gitignore-excluded')
    return { ignored: true }
  }))
  checks.set('m02:sensitive-path', async ctx => withProject({ '.env': 'TOKEN=synthetic-secret', 'src/app.ts': 'export const app = 1' }, async ({ scan }) => {
    const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-sensitive' })
    assert.equal(byPath(snapshot, '.env'), undefined)
    assert.ok(byPath(snapshot, 'src/app.ts'))
    ctx.addRawReference('assertion:m02:sensitive-path-never-approved')
    return { sensitiveExcluded: true }
  }))
  checks.set('m02:symlink-escape', async ctx => {
    const outer = await mkdtemp(path.join(os.tmpdir(), 'repoprep-m02-outside-'))
    try {
      await writeFile(path.join(outer, 'outside.ts'), 'outside synthetic marker')
      await withProject({ 'inside.ts': 'export const inside = 1' }, async ({ root }) => {
        try { await symlink(outer, path.join(root, 'escape'), 'junction') } catch { throw new Error('M02 junction fixture creation failed') }
        const scan = await scanProject(root)
        const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-symlink', reader: async (...args) => {
          if (!args[0].files.includes(args[1]) || !args[1].isContentCandidate) metrics.unauthorizedReads++
          return readProjectContent(...args)
        } })
        assert.equal(snapshot.files.some(file => file.relPath.startsWith('escape/')), false)
        ctx.addRawReference('assertion:m02:real-junction-escape-not-traversed')
        return { junctionRejected: true }
      })
    } finally { await rm(outer, { recursive: true, force: true }) }
  })
  checks.set('m02:read-time-change', async ctx => withProject({ 'src/change.ts': 'export const before = 1' }, async ({ root, scan }) => {
    const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-stale' })
    const oldRead = await snapshot.readFile(snapshot.files[0].fileId)
    await writeFile(path.join(root, 'src/change.ts'), 'export const after = 2 and longer')
    const accepted = await snapshot.readFile(snapshot.files[0].fileId).then(() => true, error => error?.code !== 'stale-snapshot')
    metrics.staleSnapshotAccepted += Number(accepted)
    metrics.cacheInvalidationPassed = !accepted && !snapshot.ownsRead(oldRead.read)
    assert.equal(accepted, false)
    assert.equal(snapshot.ownsRead(oldRead.read), false)
    ctx.addRawReference('assertion:m02:read-after-snapshot-change-rejected')
    return { staleReadRejected: true }
  }))
  checks.set('m02:unreadable-file', async ctx => withProject({ 'src/denied.ts': 'export const denied = true' }, async ({ scan }) => {
    let reads = 0
    const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-unreadable', reader: async () => { reads++; const error = new Error('private native detail'); error.code = 'EACCES'; throw error } })
    const outcome = await snapshot.readFile(snapshot.files[0].fileId).then(() => null, error => error)
    assert.equal(outcome?.code, 'unreadable')
    assert.equal(outcome?.message, 'Workflow operation rejected.')
    assert.equal(reads, 1)
    ctx.addRawReference('assertion:m02:injected-os-eacces-through-reader-factory')
    return { unreadableMapped: true }
  }))
  checks.set('m02:file-size-limit', async ctx => withProject({ 'src/large.ts': `export const large = '${'x'.repeat(2048)}'` }, async ({ root }) => {
    const scan = await scanProject(root, { maxContentFileBytes: 1024 })
    const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-size' })
    assert.equal(byPath(snapshot, 'src/large.ts'), undefined)
    return { oversizedNotApproved: true }
  }))
  checks.set('m02:text-fallback', async ctx => withProject({ 'README.md': '# Plain text\nA fallback body.' }, async ({ scan }) => {
    const snapshot = await createWorkflowSnapshot(scan, { projectId: 'm02-text' })
    const item = byPath(snapshot, 'README.md')
    assert.ok(item)
    const read = await snapshot.readFile(item.fileId)
    assert.match(read.read.text, /Plain text/)
    assert.equal(read.read.indexStatus, 'unavailable')
    metrics.textFallbackPassed = true
    ctx.addRawReference('assertion:m02:unsupported-parser-preserves-plain-text')
    for (const [id, value] of Object.entries(metrics)) ctx.recordMetric(id, value, `assertion:m02:observed-${id}`)
    return { fallback: true }
  }))
  return checks
}

export const checks = createChecks()
