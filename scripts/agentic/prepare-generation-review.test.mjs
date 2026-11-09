import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createReviewerTemplate, parsePreparationArgs, prepareGenerationReview } from './prepare-generation-review.mjs'
import { captureM08CheckerBinding, m08CheckerRawReference, verifyM08CheckerBinding } from './checks/m08.mjs'

test('review preparation CLI accepts only its three required public arguments', () => {
  assert.deepEqual(parsePreparationArgs(['--source-root', 'src', '--report-file', 'report.json', '--authorization-file', 'auth.json']), {
    sourceRoot: 'src', reportPath: 'report.json', authorizationPath: 'auth.json'
  })
  for (const args of [[], ['--source-root', 'src'], ['--source-root', 'src', '--report-file', 'r', '--authorization-file', 'a', '--mode', 'synthetic']]) {
    assert.throws(() => parsePreparationArgs(args), /PREPARE_ARGUMENTS_INVALID/u)
  }
})

test('templates cover every answer unit recursively and remain explicitly ungraded', () => {
  const packetSet = {
    rubricSha256: 'a'.repeat(64), packetSetSha256: 'b'.repeat(64),
    packets: [{ packetId: 'packet_opaque', packetSha256: 'c'.repeat(64), questions: [{
      questionSetId: 'question_opaque', answerUnitId: 'answer_main', followUps: [{ answerUnitId: 'answer_followup_1', followUps: [{ answerUnitId: 'answer_followup_2', followUps: [] }] }]
    }] }]
  }
  for (const role of ['A', 'B']) {
    const template = createReviewerTemplate(packetSet, role)
    assert.equal(template.reviewerId, role)
    assert.equal(template.agentIdentity, '')
    assert.deepEqual(template.packets[0].answers.map(row => row.answerUnitId), ['answer_main', 'answer_followup_1', 'answer_followup_2'])
    assert.ok(template.packets[0].answers.every(row => row.materialError === 'unknown' && row.reason === '' && row.sourceSupport.length === 0))
    assert.ok(template.packets[0].topicValues.every(row => row.reason === '' && Object.values(row.scores).every(score => score === null)))
  }
})

test('missing authorization is rejected before any review output exists', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm08-review-prep-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const reportPath = path.join(temp, 'generation-evaluation.json')
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', 'scripts/agentic/prepare-generation-review.mjs',
    '--source-root', process.cwd(), '--report-file', reportPath, '--authorization-file', path.join(temp, 'missing-auth.json')
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  await assert.rejects(access(path.join(temp, 'review')))
})

test('public real CLI refuses synthetic reports without fallback or output', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm08-review-synthetic-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const reportPath = path.join(temp, 'generation-evaluation.json')
  await writeFile(reportPath, JSON.stringify({ mode: 'synthetic' }))
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', 'scripts/agentic/prepare-generation-review.mjs',
    '--source-root', process.cwd(), '--report-file', reportPath, '--authorization-file', path.join(temp, 'missing-auth.json')
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /M08_REPORT_MODE_INVALID/u)
  await assert.rejects(access(path.join(temp, 'review')))
})

test('checker binding resolves from the loaded module when the caller cwd differs', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm08-checker-cwd-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const expected = await captureM08CheckerBinding()
  const moduleUrl = new URL('./checks/m08.mjs', import.meta.url).href
  const source = `const { captureM08CheckerBinding } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(await captureM08CheckerBinding()))`
  const aliasLoader = new URL('../../tests/register-shared-alias.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', aliasLoader, '--input-type=module', '-e', source], {
    cwd: temp, encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), expected)
  assert.equal(await verifyM08CheckerBinding(expected).then(value => value.commit), expected.commit)
  assert.match(m08CheckerRawReference(expected), /^m08-checker-source:[a-f0-9]{64}:[a-f0-9]{40}$/u)
  await assert.rejects(verifyM08CheckerBinding({ ...expected, sourceTreeHash: '0'.repeat(64) }), /M08_CHECKER_CHANGED_DURING_VERIFICATION/u)
})

test('prepare API rejects requireComplete bypasses and unknown argument keys before IO', async () => {
  const args = { sourceRoot: 'source', reportPath: 'report', authorizationPath: 'authorization' }
  await assert.rejects(prepareGenerationReview({ ...args, requireComplete: false }), /PREPARE_ARGUMENTS_INVALID/u)
  await assert.rejects(prepareGenerationReview({ ...args, extra: true }), /PREPARE_ARGUMENTS_INVALID/u)
})
