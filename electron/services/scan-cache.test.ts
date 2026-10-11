import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { ProjectScanCache } from './scan-cache.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { buildContext, renderBatch } from './context-builder.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { treeToText } from './scanner.ts'

const roots: string[] = []
async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-cache-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

describe('ProjectScanCache', () => {
  it('reuses fresh scans and forces refresh on request', async () => {
    const root = await project({ 'README.md': '# first\n' })
    const cache = new ProjectScanCache()
    const first = await cache.getFresh(root)
    const hit = await cache.getFresh(root)
    assert.equal(first.status, 'scanned')
    assert.equal(first.reason, 'missing')
    assert.equal(hit.status, 'reused')
    assert.equal(hit.scan, first.scan)
    const refreshed = await cache.refresh(root)
    assert.equal(refreshed.reason, 'forced')
    assert.equal(refreshed.status, 'scanned')
    assert.notEqual(refreshed.scan, first.scan)
  })

  it('rescan propagates file changes into rendered model context', async () => {
    const root = await project({ 'README.md': '# Old README text\n', 'src/old.ts': 'export const old = true\n' })
    const cache = new ProjectScanCache()
    const first = await cache.getFresh(root)
    const oldContext = await buildContext(first.scan, 'medium')
    const oldRendered = oldContext.batches.flatMap((batch) => [
      ...batch.files.map((file) => file.content), renderBatch(oldContext.headerText, treeToText(first.scan.tree), batch)
    ]).join('\n')
    assert.match(oldRendered, /Old README text/)
    assert.match(oldRendered, /src\/old\.ts/)

    await fs.rm(path.join(root, 'src/old.ts'))
    await fs.writeFile(path.join(root, 'src/new.ts'), 'export const newValue = "new source content"\n')
    await fs.writeFile(path.join(root, 'README.md'), '# Updated README text\n')
    const updated = await cache.getFresh(root)
    assert.equal(updated.reason, 'changed')
    const context = await buildContext(updated.scan, 'medium')
    const rendered = context.batches.flatMap((batch) => [
      ...batch.files.map((file) => file.content), renderBatch(context.headerText, treeToText(updated.scan.tree), batch)
    ]).join('\n')
    assert.doesNotMatch(rendered, /src\/old\.ts|Old README text/)
    assert.match(rendered, /src\/new\.ts/)
    assert.match(rendered, /new source content/)
    assert.match(rendered, /Updated README text/)
  })

  it('detects same-size mtime edits and .gitignore changes', async () => {
    const root = await project({ 'README.md': 'aaaa\n', '.gitignore': 'ignored/\n' })
    const cache = new ProjectScanCache()
    const original = await cache.getFresh(root)
    const readme = path.join(root, 'README.md')
    await fs.writeFile(readme, 'bbbb\n')
    await fs.utimes(readme, new Date('2020-01-01'), new Date('2021-01-01'))
    assert.equal((await cache.getFresh(root)).reason, 'changed')
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\nmore/\n')
    assert.equal((await cache.getFresh(root)).reason, 'changed')
    assert.notEqual((await cache.getFresh(root)).scan, original.scan)
  })

  it('uses canonical identity for case, trailing separators and junction aliases', async (t) => {
    const root = await project({ 'README.md': 'alias fixture\n' })
    const cache = new ProjectScanCache()
    const first = await cache.getFresh(root)
    assert.equal((await cache.getFresh(`${root}${path.sep}`)).status, 'reused')
    if (process.platform === 'win32') {
      const caseAlias = root.replace(/[a-z]/gi, (letter) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase())
      assert.equal((await cache.getFresh(caseAlias)).status, 'reused')
    }
    const alias = `${root}-junction`
    try { await fs.symlink(root, alias, 'junction'); roots.push(alias) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') return t.skip('junction creation requires unavailable permission')
      throw error
    }
    assert.equal((await cache.getFresh(alias)).status, 'reused')
    assert.equal(cache.size, 1)
    assert.equal(first.status, 'scanned')
  })

  it('preserves protected-root filtering through cache reuse, refresh, and an ordinary directory alias', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-cache-protected-'))
    const protectedRoot = path.join(root, '.aws')
    const alias = path.join(root, 'ordinary-project')
    const cache = new ProjectScanCache()
    try {
      await fs.mkdir(path.join(protectedRoot, 'nested'), { recursive: true })
      await fs.writeFile(path.join(protectedRoot, 'config.json'), '{"apiKey":"cache-root-synthetic-secret"}')
      await fs.writeFile(path.join(protectedRoot, 'nested', 'source.ts'), 'export const token = "cache-child-synthetic-secret"\n')
      await fs.writeFile(path.join(protectedRoot, 'nested', 'vault.db'), Buffer.from([0, 1, 2]))
      try {
        await fs.symlink(protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
          return t.skip('directory link creation is unavailable on this platform')
        }
        throw error
      }

      const first = await cache.getFresh(alias)
      assert.equal(first.status, 'scanned')
      assert.ok(first.scan.files.length >= 2)
      assert.ok(first.scan.files.every((file) => !file.isContentCandidate))
      assert.equal(first.scan.tree.modelExcluded, true)
      assert.ok(first.scan.security.excludedFiles >= 3, 'binary credentials must also contribute to excluded counts')
      let context = await buildContext(first.scan, 'medium')
      assert.ok(context.batches.every((batch) => batch.files.length === 0))
      assert.doesNotMatch(`${context.headerText}\n${treeToText(first.scan.tree)}`, /\.aws|config\.json|source\.ts|vault\.db/)
      assert.doesNotMatch(JSON.stringify(context), /cache-root-synthetic-secret|cache-child-synthetic-secret/)

      const reused = await cache.getFresh(alias)
      assert.equal(reused.status, 'reused')
      assert.equal(reused.scan, first.scan)
      context = await buildContext(reused.scan, 'fine')
      assert.ok(context.batches.every((batch) => batch.files.length === 0), 'a cache hit must retain root exclusions')

      await fs.writeFile(path.join(protectedRoot, 'added.ts'), 'export const password = "cache-refresh-synthetic-secret"\n')
      const refreshed = await cache.refresh(alias)
      assert.equal(refreshed.status, 'scanned')
      assert.equal(refreshed.reason, 'forced')
      assert.ok(refreshed.scan.files.every((file) => !file.isContentCandidate), 'refresh must reapply protected-root policy')
      assert.ok(refreshed.scan.files.some((file) => file.relPath === 'added.ts'))
      context = await buildContext(refreshed.scan, 'fine')
      assert.ok(context.batches.every((batch) => batch.files.length === 0))
      assert.doesNotMatch(`${context.headerText}\n${treeToText(refreshed.scan.tree)}`, /\.aws|config\.json|source\.ts|vault\.db|added\.ts/)
      assert.doesNotMatch(JSON.stringify(context), /cache-root-synthetic-secret|cache-child-synthetic-secret|cache-refresh-synthetic-secret/)
    } finally {
      const resolvedRoot = path.resolve(root)
      assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()), 'cleanup target must be a direct child of the temporary directory')
      assert.match(path.basename(resolvedRoot), /^projectlens-cache-protected-/)
      try {
        const resolvedAlias = path.resolve(alias)
        assert.equal(path.dirname(resolvedAlias), resolvedRoot, 'alias cleanup must stay inside the fixture workspace')
        await fs.unlink(alias)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await fs.rm(resolvedRoot, { recursive: true, force: true })
    }
  })

  it('keeps the least recently used entries within capacity', async () => {
    const cache = new ProjectScanCache(2)
    const a = await project({ 'a.ts': 'a' })
    const b = await project({ 'b.ts': 'b' })
    const c = await project({ 'c.ts': 'c' })
    await cache.getFresh(a)
    await cache.getFresh(b)
    await cache.getFresh(a)
    await cache.getFresh(c)
    assert.equal(cache.size, 2)
    assert.equal((await cache.getFresh(a)).status, 'reused')
    assert.equal((await cache.getFresh(b)).reason, 'missing')
    assert.equal(cache.size, 2)
  })

  it('enforces capacity when a snapshot hit finishes after another key evicts it', async (t) => {
    const cache = new ProjectScanCache(1)
    const a = await project({ 'a.ts': 'a' })
    const b = await project({ 'b.ts': 'b' })
    await cache.getFresh(a)
    const readdir = fs.readdir.bind(fs)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let blocked = false
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === a && !blocked) {
        blocked = true
        entered()
        await gate
      }
      return readdir(...args)
    })
    const pendingHit = cache.getFresh(a)
    await reached
    const scannedB = await cache.getFresh(b)
    assert.equal(scannedB.status, 'scanned')
    assert.equal(cache.size, 1)
    release()
    const completedHit = await pendingHit
    assert.equal(completedHit.status, 'reused')
    assert.equal(cache.size, 1)
    assert.equal((await cache.getFresh(a)).status, 'reused')
  })

  it('clears a cached entry when invalidate is called', async () => {
    const cache = new ProjectScanCache()
    const root = await project({ 'file.ts': 'value' })
    await cache.getFresh(root)
    await cache.invalidate(root)
    assert.equal(cache.size, 0)
    const scanned = await cache.getFresh(root)
    assert.equal(scanned.status, 'scanned')
    assert.equal(scanned.reason, 'missing')
  })

  it('returns partial scans but does not cache when a directory cannot be read', async (t) => {
    const cache = new ProjectScanCache()
    const root = await project({ 'file.ts': 'value' })
    await fs.mkdir(path.join(root, 'private'))
    const readdir = fs.readdir.bind(fs)
    let deny = true
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === path.join(root, 'private') && deny) {
        deny = false
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return readdir(...args)
    })
    const partial = await cache.getFresh(root)
    assert.equal(partial.status, 'scanned')
    assert.equal(cache.size, 0)
    const subsequent = await cache.getFresh(root)
    assert.equal(subsequent.status, 'scanned')
    assert.equal(cache.size, 1)
  })

  it('keeps invalidate queued behind a successful in-flight refresh', async (t) => {
    const cache = new ProjectScanCache()
    const root = await project({ 'file.ts': 'value' })
    await fs.mkdir(path.join(root, 'private'))
    await cache.getFresh(root)
    const canonicalRoot = await fs.realpath(root)
    const readdir = fs.readdir.bind(fs)
    const realpath = fs.realpath.bind(fs)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let blocked = false
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === path.join(root, 'private') && !blocked) {
        blocked = true
        entered()
        await gate
      }
      return readdir(...args)
    })
    t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
      if (path.resolve(String(args[0])) === path.resolve(root)) return canonicalRoot
      return realpath(...args)
    })
    const pendingRefresh = cache.refresh(root)
    await reached
    const pendingInvalidate = cache.invalidate(root)
    await new Promise<void>((resolve) => setImmediate(resolve))
    release()
    await Promise.all([pendingRefresh, pendingInvalidate])
    assert.equal(cache.size, 0)
  })

  it('removes cached identities when their project directory is deleted', async () => {
    const cache = new ProjectScanCache()
    const root = await project({ 'file.ts': 'value' })
    await cache.getFresh(root)
    assert.equal(cache.size, 1)
    await fs.rm(root, { recursive: true, force: true })
    await assert.rejects(cache.getFresh(root))
    assert.equal(cache.size, 0)
  })

  it('clears missing paths without growing the cache', async () => {
    const cache = new ProjectScanCache()
    const missing = path.join(os.tmpdir(), `projectlens-missing-${Date.now()}`)
    await assert.rejects(cache.getFresh(missing))
    await cache.invalidate(missing)
    assert.equal(cache.size, 0)
  })

  it('bounds auxiliary alias indexes as more projects are scanned', async () => {
    const cache = new ProjectScanCache(2)
    for (let index = 0; index < 12; index++) {
      const root = await project({ [`${index}.ts`]: String(index) })
      await cache.getFresh(root)
    }
    assert.equal(cache.size, 2)
    const internals = cache as unknown as { aliases: Map<string, string>; queues: Map<string, Promise<void>> }
    assert.ok(internals.aliases.size <= 8)
    assert.equal(internals.queues.size, 0)
  })
})
