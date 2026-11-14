import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateHoldoutSources } from './holdout-contract.mjs'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const labelsPath = path.join(projectRoot, 'scripts/agentic/assets/holdout-labels.v1.json')
const commonGitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: projectRoot, encoding: 'utf8' }).trim()
const primaryRoot = path.dirname(commonGitDir)
const reposRoot = path.join(primaryRoot, '.validation/agentic-holdout-sources')
const labels = JSON.parse(await readFile(labelsPath, 'utf8'))
const copy = () => structuredClone(labels)

test('frozen holdout labels match all pinned local source checkouts', async () => {
  const result = await validateHoldoutSources(labels, reposRoot)
  assert.deepEqual(result, { valid: true, issues: [], repositories: 4, facts: 48 })
})

test('missing repository fails closed', async () => {
  const changed = copy()
  changed.repositories.pop()
  const result = await validateHoldoutSources(changed, reposRoot)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some((item) => item.includes('expected exactly four repositories')))
  assert.ok(result.issues.some((item) => item.includes('required repository missing')))
})

test('pinned commit and whole-file hash mutations fail closed', async () => {
  const changedCommit = copy()
  changedCommit.repositories[0].commit = '0'.repeat(40)
  assert.equal((await validateHoldoutSources(changedCommit, reposRoot)).valid, false)

  const changedHash = copy()
  changedHash.repositories[0].files[0].sha256 = '0'.repeat(64)
  const result = await validateHoldoutSources(changedHash, reposRoot)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some((item) => item.includes('source file hash mismatch')))
})

test('evidence hash and traversal mutations fail closed without echoing source', async () => {
  const changedEvidence = copy()
  changedEvidence.repositories[0].facts[0].evidence[0].sha256 = '0'.repeat(64)
  const evidenceResult = await validateHoldoutSources(changedEvidence, reposRoot)
  assert.equal(evidenceResult.valid, false)
  assert.ok(evidenceResult.issues.some((item) => item.includes('evidence hash mismatch')))

  const changedPath = copy()
  changedPath.repositories[0].files[0].path = '../outside.py'
  const pathResult = await validateHoldoutSources(changedPath, reposRoot)
  assert.equal(pathResult.valid, false)
  assert.ok(pathResult.issues.some((item) => item.includes('unsafe source file path')))
  assert.equal(JSON.stringify(pathResult).includes('class Client'), false)
})

test('symlinked repository is rejected before reading through the link', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'holdout-symlink-'))
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'holdout-outside-'))
  try {
    try {
      await symlink(externalDir, path.join(fixtureRoot, 'httpx'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory symlinks are unavailable')
      throw error
    }
    const result = await validateHoldoutSources(labels, fixtureRoot)
    assert.ok(result.issues.includes('repository path is a symlink: encode/httpx'))
    assert.equal(result.issues.some((item) => item.includes('source file is unavailable or not UTF-8: encode/httpx')), false)
    assert.equal(result.issues.some((item) => item.includes('source file hash mismatch: encode/httpx')), false)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
    await rm(externalDir, { recursive: true, force: true })
  }
})

test('each granularity must be represented by at least two facts', async () => {
  const changed = copy()
  const repo = changed.repositories[0]
  let retainedOne = false
  for (const fact of repo.facts) {
    if (fact.granularities.includes('coarse')) {
      if (retainedOne) fact.granularities = fact.granularities.filter((item) => item !== 'coarse')
      else retainedOne = true
    }
  }
  const result = await validateHoldoutSources(changed, reposRoot)
  assert.equal(result.valid, false)
  assert.ok(result.issues.includes('granularity coverage below two facts: encode/httpx'))
})

test('control characters, traversal, backslashes, and Windows alternate streams are unsafe paths', async () => {
  for (const unsafePath of ['../outside.py', 'httpx\\..\\outside.py', 'httpx/_client.py:stream', 'httpx/name\u0000.py']) {
    const changed = copy()
    changed.repositories[0].files[0].path = unsafePath
    const result = await validateHoldoutSources(changed, reposRoot)
    assert.equal(result.valid, false)
    assert.ok(result.issues.includes('unsafe source file path: encode/httpx'), unsafePath)
  }
})
