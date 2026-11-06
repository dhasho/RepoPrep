import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, link } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { freezeManifest } from './freeze-manifest.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentic-freeze-'))
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.match(path.basename(root), /^agentic-freeze-/)
    await rm(root, { recursive: true, force: true })
  })
  const folder = path.join(root, 'scripts', 'agentic')
  await mkdir(folder, { recursive: true })
  const manifest = {
    manifestVersion: 2, baselineSourceCommit: 'a'.repeat(40), configuration: { fixed: 7 },
    modules: { P0: { requiredCheckIds: ['asserted'], requiredMetricIds: [], assets: [
      { id: 'data', path: 'scripts/agentic/data.json', status: 'available', sha256: null },
      { id: 'pending', path: 'scripts/agentic/pending.json', status: 'not-materialized', sha256: null }
    ] } }
  }
  await writeFile(path.join(folder, 'manifest.v2.json'), JSON.stringify(manifest))
  await writeFile(path.join(folder, 'data.json'), '{\r\n  "sample": 1\r\n}\r\n')
  return { root, folder, manifest }
}

test('explicit freezing pins normalized asset bytes and a separate v2 lock without inventing missing data', async t => {
  const { root, folder } = await fixture(t)
  const result = await freezeManifest(root)
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
  assert.equal(manifest.modules.P0.assets[0].sha256, createHash('sha256').update('{\n  "sample": 1\n}\n').digest('hex'))
  assert.equal(manifest.modules.P0.assets[1].sha256, null)
  assert.equal(manifest.modules.P0.assets[1].status, 'not-materialized')
  assert.equal(result.lockPath, path.join(folder, 'manifest.v2.lock.json'))
  const lock = JSON.parse(await readFile(result.lockPath, 'utf8'))
  assert.equal(lock.manifestSha256, createHash('sha256').update(await readFile(result.manifestPath)).digest('hex'))
  assert.equal((await freezeManifest(root)).manifestSha256, result.manifestSha256)
})

test('freezing rejects an asset outside the selected source root', async t => {
  const { root, folder, manifest } = await fixture(t)
  manifest.modules.P0.assets[0].path = '../outside.json'
  await writeFile(path.join(folder, 'manifest.v2.json'), JSON.stringify(manifest))
  await assert.rejects(freezeManifest(root), { message: 'INVALID_FREEZE_PATH' })
})

test('freezing rejects a hard-linked destination without changing its other name', async t => {
  const { root, folder } = await fixture(t)
  const manifestPath = path.join(folder, 'manifest.v2.json')
  const original = await readFile(manifestPath)
  const secondName = path.join(root, 'preserved.json')
  await link(manifestPath, secondName)
  await assert.rejects(freezeManifest(root), { message: 'INVALID_FREEZE_PATH' })
  assert.deepEqual(await readFile(secondName), original)
  assert.deepEqual(await readFile(manifestPath), original)
})
