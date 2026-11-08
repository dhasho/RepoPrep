import assert from 'node:assert/strict'
import test from 'node:test'
import { createChecks } from './m08.mjs'

test('M08 verifier cannot certify synthetic runs or missing execution artifacts', async () => {
  const check = createChecks().get('m08:frozen-sufficient-evidence-tasks')
  const context = { mode: 'synthetic', recordMetric() { assert.fail('synthetic verification must not emit metrics') } }
  const synthetic = await check(context)
  assert.equal(synthetic.reason, 'real-report-required')

  const realWithoutArtifacts = await check({ ...context, mode: 'real' })
  assert.match(realWithoutArtifacts.reason, /^m08_/u)
})
