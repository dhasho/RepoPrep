import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { validateHoldoutSources } from './holdout-contract.mjs'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const labelsPath = path.join(projectRoot, 'scripts/agentic/assets/holdout-labels.v1.json')
const reposRoot = path.resolve(projectRoot, '..', '..', '.validation/agentic-holdout-sources')
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
