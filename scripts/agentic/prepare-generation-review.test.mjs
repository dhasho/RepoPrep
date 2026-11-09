import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createReviewerTemplate, parsePreparationArgs } from './prepare-generation-review.mjs'

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
