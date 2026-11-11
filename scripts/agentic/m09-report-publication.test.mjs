import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { captureM09QualitySession, preflightM09Gate } from './m09-quality-host.mjs'
import { fixture, executionBytes, copy } from './m09-e4-test-fixture.mjs'

// These tests exercise the same private publisher used by the canonical host.
// Their phase/checker/tail seams are synthetic, not native/E1 gate authority.
// Every successful fixture report is explicitly synthetic and never pass.
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function reportAt(directory) {
  return { schemaVersion: 1, kind: 'synthetic-m09-gate-report', module: 'M09', mode: 'synthetic', status: 'synthetic-complete', checks: [{ id: 'synthetic-checker-only', status: 'pass' }], reportPath: path.join(directory, 'M09.synthetic.json') }
}
async function noPublishedPass(directory) {
  const names = await readdir(directory)
  for (const name of names) if (name.endsWith('.json')) assert.notEqual(JSON.parse(await readFile(path.join(directory, name), 'utf8')).status, 'pass')
  assert.equal(names.some(name => name.endsWith('.pending')), false)
}

for (const tail of ['final-source-hash', 'report-directory-create']) test(`cancel after synthetic checker during ${tail} seam publishes no report`, async t => {
  const entered = deferred(); const release = deferred()
  let candidate; let checkerFinished = false
  const f = await fixture(t, { syntheticGate: async ({ publishReport }) => {
    checkerFinished = true
    entered.resolve()
    // Model the awaited runner tail after its checker, without a tree/key read.
    await release.promise
    return publishReport(candidate)
  } })
  const directory = path.join(f.root, 'synthetic-report'); await mkdir(directory)
  candidate = reportAt(directory)
  await f.throughJudgments(); await f.driver.score()
  const gating = f.driver.gate(); await entered.promise
  assert.equal(checkerFinished, true); assert.equal(f.driver.snapshot().phase, 'scored')
  f.driver.cancel(); release.resolve()
  await assert.rejects(gating, /M09_[A-Z0-9_]+/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  assert.equal(f.driver.snapshot().diagnostics[0].code, 'M09_SESSION_CANCELLED')
  await assert.rejects(access(candidate.reportPath))
  await noPublishedPass(directory)
})

for (const invalidation of ['cancel', 'rejected-native-observation']) test(`${invalidation} during last awaited verification cannot reach atomic publication`, async t => {
  const entered = deferred(); const release = deferred()
  let candidate; let pauseVerification = false; let f
  f = await fixture(t, {
    reverify: async bytes => {
      assert.deepEqual(bytes, executionBytes)
      if (pauseVerification) { entered.resolve(); await release.promise }
      return copy(f.verified)
    },
    syntheticGate: async ({ publishReport }) => {
      // The synthetic checker is complete; now the actual shared publisher
      // performs its last awaited execution/judgment verification.
      pauseVerification = true
      return publishReport(candidate)
    }
  })
  const directory = path.join(f.root, 'synthetic-report'); await mkdir(directory); candidate = reportAt(directory)
  await f.throughJudgments(); await f.driver.score()
  const gating = f.driver.gate(); await entered.promise
  if (invalidation === 'cancel') f.driver.cancel()
  else assert.throws(() => f.external.observeCompletion({}, { task_name: '/root/unknown', model: 'gpt-6.1-sol', fork_turns: 'none', inputBytes: Buffer.from('unknown'), status: 'completed', rawFinal: '{}' }), /M09_NATIVE_OBSERVATION_INVALID/u)
  release.resolve()
  await assert.rejects(gating, /M09_[A-Z0-9_]+/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  const expected = invalidation === 'cancel' ? 'M09_SESSION_CANCELLED' : 'M09_NATIVE_OBSERVATION_INVALID'
  assert.equal(f.driver.snapshot().diagnostics[0].code, expected)
  await assert.rejects(access(candidate.reportPath))
  await noPublishedPass(directory)
})

test('live shared publisher commits only synthetic evidence and grants no production session', async t => {
  let candidate
  const f = await fixture(t, { syntheticGate: async ({ publishReport }) => publishReport(candidate) })
  const directory = path.join(f.root, 'synthetic-report'); await mkdir(directory); candidate = reportAt(directory)
  await f.throughJudgments(); await f.driver.score(); const result = await f.driver.gate()
  assert.equal(result.status, 'synthetic-complete'); assert.equal(result.formalGate, false)
  assert.equal(f.driver.snapshot().phase, 'gated')
  assert.deepEqual(JSON.parse(await readFile(candidate.reportPath, 'utf8')), candidate)
  await noPublishedPass(directory)
  await assert.rejects(captureM09QualitySession(f.driver), /M09_SAME_HOST_SCORED_SESSION_REQUIRED/u)
  await assert.rejects(preflightM09Gate(f.driver, {}), /M09_SAME_HOST_GATE_REQUIRED/u)
  // Cancellation after a legitimate publication does not rewrite history.
  f.driver.cancel(); assert.equal(f.driver.snapshot().phase, 'failed')
  assert.deepEqual(JSON.parse(await readFile(candidate.reportPath, 'utf8')), candidate)
})

for (const changed of ['real-mode', 'pass-status']) test(`synthetic publication rejects ${changed} instead of minting formal authority`, async t => {
  let candidate
  const f = await fixture(t, { syntheticGate: async ({ publishReport }) => publishReport(candidate) })
  const directory = path.join(f.root, 'synthetic-report'); await mkdir(directory); candidate = reportAt(directory)
  if (changed === 'real-mode') { candidate.mode = 'real'; candidate.reportPath = path.join(directory, 'M09.json') }
  else candidate.status = 'pass'
  await f.throughJudgments(); await f.driver.score()
  await assert.rejects(f.driver.gate(), /M09_SYNTHETIC_CANNOT_AUTHORIZE/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  await assert.rejects(access(candidate.reportPath)); await noPublishedPass(directory)
})

test('exclusive publication preserves existing incomplete diagnostics and never overwrites them', async t => {
  let candidate
  const f = await fixture(t, { syntheticGate: async ({ publishReport }) => publishReport(candidate) })
  const directory = path.join(f.root, 'synthetic-report'); await mkdir(directory); candidate = reportAt(directory)
  const incomplete = { module: 'M09', status: 'incomplete', errorCode: 'SYNTHETIC_EXISTING_DIAGNOSTIC' }
  await writeFile(candidate.reportPath, JSON.stringify(incomplete))
  await f.throughJudgments(); await f.driver.score()
  await assert.rejects(f.driver.gate(), /M09_REPORT_PUBLICATION_INVALID/u)
  assert.equal(f.driver.snapshot().phase, 'failed')
  assert.deepEqual(JSON.parse(await readFile(candidate.reportPath, 'utf8')), incomplete)
  await noPublishedPass(directory)
})
