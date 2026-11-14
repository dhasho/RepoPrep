import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { M09_MANIFEST_PATH, M09_LOCK_PATH, loadM09ScopedManifest } from './m09-manifest.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function sourceFixture(t, sources) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'repoprep-m09-source-bindings-'))
  const original = await lstat(root)
  t.after(async () => {
    const actual = await lstat(root)
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith('repoprep-m09-source-bindings-'))
    assert.equal(actual.isSymbolicLink(), false)
    assert.equal(actual.ino, original.ino)
    await rm(root, { recursive: true })
  })
  for (const name of [M09_MANIFEST_PATH, M09_LOCK_PATH, 'scripts/agentic/manifest.v2.json', ...sources]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await copyFile(path.join(sourceRoot, name), path.join(root, name))
  }
  return root
}

test('M09 real checkout passes exact source bindings with LF on all locked paths', async () => {
  const { lock } = await loadM09ScopedManifest(sourceRoot)
  assert.equal(Object.keys(lock.m09.sourceFiles).length, 17)
  for (const name of Object.keys(lock.m09.sourceFiles)) {
    const bytes = await readFile(path.join(sourceRoot, name))
    assert.equal(bytes.includes(13), false, name)
  }
})

test('M09 source reader rejects full CRLF and mixed newline tampering on every locked path', async t => {
  const { lock } = await loadM09ScopedManifest(sourceRoot)
  const sources = Object.keys(lock.m09.sourceFiles)
  const root = await sourceFixture(t, sources)
  await loadM09ScopedManifest(root)
  for (const name of sources) {
    const filename = path.join(root, name)
    const original = await readFile(filename, 'utf8')
    assert.ok(original.split('\n').length > 2, name)
    for (const [kind, tampered] of [
      ['CRLF', original.replaceAll('\n', '\r\n')],
      ['mixed', original.replace('\n', '\r\n')]
    ]) {
      await t.test(name + ' ' + kind, async () => {
        try {
          await writeFile(filename, tampered)
          await assert.rejects(loadM09ScopedManifest(root), { message: 'M09_SCOPED_SOURCE_CHANGED' })
        } finally {
          await writeFile(filename, original)
        }
      })
    }
  }
  await loadM09ScopedManifest(root)
})
