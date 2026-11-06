import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runGate, skippedCheck, unknownCheck } from './gate-runner.mjs'

const makeManifest = () => ({
  manifestVersion: 1,
  planVersion: 'test',
  baselineSourceCommit: '9ef10caae918a2b86c27afdd8b19cbe5ad40869c',
  freezeStatus: 'test-only',
  configuration: { limit: 7 },
  modules: { M01: { requiredCheckIds: ['one', 'two'], requiredMetricIds: ['metric'], assets: [] } },
  realOnlyModules: ['M01']
})

async function withOutput(callback) {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), 'agentic-gate-'))
  try {
    return await callback(outRoot)
  } finally {
    await rm(outRoot, { recursive: true, force: true })
  }
}

const passingChecks = () => ({
  one: () => assert.equal(2 + 2, 4),
  two: () => assert.ok(true)
})

test('runs assertion functions and writes a fresh hash-bound report', async () => {
  await withOutput(async (outRoot) => {
    const checks = passingChecks()
    checks.one = (ctx) => {
      assert.equal(2 + 2, 4)
      ctx.recordMetric('metric', true, 'node:test:assertion-one')
    }
    const result = await runGate({ module: 'M01', manifest: makeManifest(), checks, sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'pass')
    assert.match(result.hashes.sourceSha256, /^[0-9a-f]{64}$/)
    assert.match(result.hashes.configurationSha256, /^[0-9a-f]{64}$/)
    assert.match(result.hashes.dataSha256, /^[0-9a-f]{64}$/)
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
    assert.equal(report.checks.filter((item) => item.status === 'pass').length, 2)
    assert.equal(report.rawReferences[0].reference, 'node:test:assertion-one')
    const second = await runGate({ module: 'M01', manifest: makeManifest(), checks, sourceRoot: process.cwd(), outRoot })
    assert.notEqual(second.runId, result.runId)
    assert.notEqual(second.reportPath, result.reportPath)
  })
})

test('missing check IDs and missing metrics remain incomplete', async () => {
  await withOutput(async (outRoot) => {
    const result = await runGate({ module: 'M01', manifest: makeManifest(), checks: { one: () => {} }, sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'incomplete')
    assert.equal(result.counts.missing, 2)
    assert.equal(result.counts.failed, 0)
  })
})

test('skipped, unknown, and non-function implementations cannot pass', async () => {
  await withOutput(async (outRoot) => {
    const checks = { one: () => skippedCheck('no fixture'), two: () => unknownCheck('unrecognized result') }
    const result = await runGate({ module: 'M01', manifest: makeManifest(), checks, sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'failed')
    assert.equal(result.counts.skipped, 1)
    assert.equal(result.counts.unknown, 1)
    const invalid = await runGate({ module: 'M01', manifest: makeManifest(), checks: { one: { status: 'pass' }, two: () => {} }, sourceRoot: process.cwd(), outRoot })
    assert.equal(invalid.counts.unknown, 1)
  })
})

test('failed assertions and duplicate or unexpected IDs fail closed', async () => {
  await withOutput(async (outRoot) => {
    const checks = [['one', () => assert.fail('tampered assertion')], ['one', () => {}], ['rogue', () => {}], ['two', () => {}]]
    const result = await runGate({ module: 'M01', manifest: makeManifest(), checks, sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'failed')
    assert.equal(result.counts.failed, 1)
    assert.equal(result.counts.unknown, 2)
  })
})

test('hash mismatch is a failed binding and never an accepted report', async () => {
  await withOutput(async (outRoot) => {
    const checks = passingChecks()
    checks.one = (ctx) => ctx.recordMetric('metric', 7)
    const result = await runGate({ module: 'M01', manifest: makeManifest(), checks, sourceRoot: process.cwd(), outRoot, expectedHashes: { configurationSha256: '0'.repeat(64) } })
    assert.equal(result.status, 'failed')
    assert.equal(result.counts.failed, 1)
    assert.equal(result.hashMismatches.length, 1)
  })
})

test('real-only modules are blocked without authorization and a reference', async () => {
  await withOutput(async (outRoot) => {
    const result = await runGate({ module: 'M01', mode: 'real', manifest: makeManifest(), checks: passingChecks(), sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'blocked')
    assert.equal(result.counts.unknown, 1)
  })
})

test('a callback cannot self-report status through a result JSON object', async () => {
  await withOutput(async (outRoot) => {
    const checks = { one: () => ({ status: 'pass' }), two: () => {} }
    const result = await runGate({ module: 'M01', manifest: makeManifest(), checks, sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'failed')
    assert.equal(result.counts.failed, 1)
  })
})

test('required data assets need verified content and an available status', async () => {
  await withOutput(async (outRoot) => {
    const manifest = makeManifest()
    manifest.modules.M01.assets = [{ id: 'dataset', status: 'frozen-metadata-only', required: true, path: 'README.md', sha256: '0'.repeat(64) }]
    const checks = passingChecks()
    checks.one = (ctx) => ctx.recordMetric('metric', true)
    const result = await runGate({ module: 'M01', manifest, checks, sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'failed')
    assert.equal(result.counts.failed, 1)
    assert.equal(result.counts.missing, 1)
    assert.ok(result.checks.some((item) => item.id === 'asset:dataset' && item.status === 'failed'))
  })
})

test('assertion failure reports never serialize a raw error message', async () => {
  await withOutput(async (outRoot) => {
    const checks = { one: () => assert.fail('SECRET-DO-NOT-WRITE'), two: () => {} }
    const result = await runGate({ module: 'M01', manifest: makeManifest(), checks, sourceRoot: process.cwd(), outRoot })
    const raw = await readFile(result.reportPath, 'utf8')
    assert.equal(raw.includes('SECRET-DO-NOT-WRITE'), false)
    assert.equal(result.checks.find((item) => item.id === 'one').errorCode, 'ASSERTION_FAILED')
  })
})

test('invalid module names cannot escape the fresh report directory', async () => {
  await withOutput(async (outRoot) => {
    const result = await runGate({ module: '../../outside', manifest: makeManifest(), checks: {}, sourceRoot: process.cwd(), outRoot })
    assert.equal(result.status, 'failed')
    assert.equal(result.module, null)
    assert.equal(path.dirname(path.dirname(result.reportPath)), outRoot)
    assert.match(path.basename(result.reportPath), /^unknown\.json$/)
  })
})
