import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { captureProjectSnapshot, isProjectSnapshotCurrent, resolveProjectIdentity } from './project-snapshot.ts'

const tempDirs: string[] = []

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-snapshot-'))
  tempDirs.push(root)
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one')
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n')
  return root
}

const makeScan = scanProject

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('project snapshot', () => {
  it('resolves directory aliases to the same identity', async () => {
    const root = await makeProject()
    const direct = await resolveProjectIdentity(root)
    const viaDot = await resolveProjectIdentity(path.join(root, '.', 'src', '..'))
    assert.equal(direct.realPath, viaDot.realPath)
    assert.equal(direct.key, viaDot.key)
  })

  it('stays current until a scanned file changes', async () => {
    const root = await makeProject()
    const snapshot = await captureProjectSnapshot(await makeScan(root))
    assert.equal(await isProjectSnapshotCurrent(snapshot), true)
    await fs.writeFile(path.join(root, 'src', 'one.ts'), 'changed-size')
    assert.equal(await isProjectSnapshotCurrent(snapshot), false)
  })

  it('detects same-size edits and changes made after scan before capture', async () => {
    const root = await makeProject()
    const scan = await makeScan(root)
    await fs.writeFile(path.join(root, 'src', 'one.ts'), 'two')
    const snapshot = await captureProjectSnapshot(scan)
    assert.equal(await isProjectSnapshotCurrent(snapshot), false)

    const scan2 = await makeScan(root)
    const snapshot2 = await captureProjectSnapshot(scan2)
    await fs.writeFile(path.join(root, 'src', 'one.ts'), 'six')
    assert.equal(await isProjectSnapshotCurrent(snapshot2), false)
  })

  it('detects additions, removals, and renames from directory names', async () => {
    const root = await makeProject()
    const added = await captureProjectSnapshot(await makeScan(root))
    await fs.writeFile(path.join(root, 'src', 'new.ts'), 'new')
    assert.equal(await isProjectSnapshotCurrent(added), false)

    await fs.rm(path.join(root, 'src', 'new.ts'))
    const removed = await captureProjectSnapshot(await makeScan(root))
    await fs.rm(path.join(root, 'src', 'one.ts'))
    assert.equal(await isProjectSnapshotCurrent(removed), false)

    await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one')
    const renamed = await captureProjectSnapshot(await makeScan(root))
    await fs.rename(path.join(root, 'src', 'one.ts'), path.join(root, 'src', 'renamed.ts'))
    assert.equal(await isProjectSnapshotCurrent(renamed), false)
  })

  it('detects edits inside the deepest directory the scan materialised', async () => {
    // 快照的边界是扫描真正物化出来的那棵子树：越深的目录也要被校验到，
    // 否则深层文件被改写后会错误地复用陈旧缓存。
    const root = await makeProject()
    await fs.mkdir(path.join(root, 'src', 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'a', 'b', 'deep.ts'), 'deep one\n')
    const snapshot = await captureProjectSnapshot(await makeScan(root))
    assert.equal(await isProjectSnapshotCurrent(snapshot), true)

    await fs.writeFile(path.join(root, 'src', 'a', 'b', 'deep.ts'), 'deep two\n')
    assert.equal(await isProjectSnapshotCurrent(snapshot), false)
  })

  it('detects .gitignore changes and missing or type-changed entries', async () => {
    const root = await makeProject()
    const gitignoreSnapshot = await captureProjectSnapshot(await makeScan(root))
    // Explicit mtime makes this reliable on filesystems with coarse timestamp precision.
    const ignorePath = path.join(root, '.gitignore')
    await fs.writeFile(ignorePath, 'ignored/\nother/\n')
    await fs.utimes(ignorePath, new Date('2020-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'))
    assert.equal(await isProjectSnapshotCurrent(gitignoreSnapshot), false)

    const missingSnapshot = await captureProjectSnapshot(await makeScan(root))
    await fs.rm(path.join(root, 'src', 'one.ts'))
    assert.equal(await isProjectSnapshotCurrent(missingSnapshot), false)

    await fs.rm(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src'), 'now a file')
    assert.equal(await isProjectSnapshotCurrent(missingSnapshot), false)
  })

  it('tracks .gitignore even when it ignores itself', async () => {
    const root = await makeProject()
    const ignorePath = path.join(root, '.gitignore')
    await fs.writeFile(ignorePath, '.gitignore\n')
    const snapshot = await captureProjectSnapshot(await makeScan(root))
    await fs.writeFile(ignorePath, 'different\n')
    assert.equal(await isProjectSnapshotCurrent(snapshot), false)
  })

  it('tracks a .gitignore created after scan-time policy capture', async () => {
    const root = await makeProject()
    await fs.rm(path.join(root, '.gitignore'))
    const scan = await makeScan(root)
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n')
    const snapshot = await captureProjectSnapshot(scan)
    assert.equal(await isProjectSnapshotCurrent(snapshot), false)
  })

  it('returns a scan but marks its snapshot invalid when reading .gitignore fails', async () => {
    const root = await makeProject()
    const originalReadFile = fs.readFile
    fs.readFile = (async (filePath: string, ...args: unknown[]) => {
      if (String(filePath) === path.join(root, '.gitignore')) {
        const error = Object.assign(new Error('mock EACCES'), { code: 'EACCES' })
        throw error
      }
      return (originalReadFile as (...params: unknown[]) => Promise<Buffer>)(filePath, ...args)
    }) as typeof fs.readFile
    try {
      const scan = await makeScan(root)
      const snapshot = await captureProjectSnapshot(scan)
      assert.equal(scan.root, root)
      assert.equal(await isProjectSnapshotCurrent(snapshot), false)
    } finally {
      fs.readFile = originalReadFile
    }
  })
})
