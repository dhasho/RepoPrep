import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { calculateReportDigest, makeReviewTemplate } from './review.mjs'
import { fingerprintQuestion } from './scorer.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(directory, '../..')
const cli = path.join(directory, 'review.mjs')

function buildReport() {
  const questions = [
    { caseId: 'synthetic', variant: 'generation', question: 'How does useState store a value?', answer: 'It stores the displayed value.', followUps: [{ question: 'What triggers a change?', answer: 'The shown setter.' }] },
    { caseId: 'synthetic', variant: 'baseline', question: 'How does filter select items?', answer: 'It selects visible items.', followUps: [] }
  ].map(q => ({ ...q, fingerprint: fingerprintQuestion(q.question, q) }))
  const report = { runId: 'review-cli-test-run', corpusVersion: 'test-v1', configHash: 'config-test', sourceHashes: {}, fixtureHashes: {}, cases: [{ id: 'synthetic', output: { safe: true }, baseline: { safe: true } }], questions, humanReview: { status: 'pending', reviewedCount: 0, coverage: 0 } }
  report.reportDigest = calculateReportDigest(report)
  return report
}

async function withRun(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repoprep-review-e2e-'))
  try { await callback(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function writeRun(root, review) {
  const report = buildReport()
  const reportPath = path.join(root, 'report.json')
  const reviewPath = path.join(root, 'filled-review.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(reviewPath, `${JSON.stringify(review ?? makeReviewTemplate(report), null, 2)}\n`)
  return { report, reportPath, reviewPath }
}

function invoke(reportPath, reviewPath) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', path.relative(repo, cli), 'import', reportPath, reviewPath], { cwd: repo, encoding: 'utf8' })
}

test('review import CLI writes pending, partial, and complete JSON and Markdown summaries', async () => {
  await withRun(async root => {
    const pendingRoot = path.join(root, 'pending')
    await mkdir(pendingRoot)
    const pendingFiles = await writeRun(pendingRoot)
    const pendingResult = invoke(pendingFiles.reportPath, pendingFiles.reviewPath)
    assert.equal(pendingResult.status, 0, pendingResult.stderr)
    const pending = JSON.parse(await readFile(pendingFiles.reportPath, 'utf8')).humanReview
    assert.equal(pending.status, 'pending')
    assert.equal(pending.reviewedCount, 0)
    assert.equal(pending.pendingCount, 2)
    assert.equal(pending.coverage, 0)
    assert.deepEqual(pending.ratingAverages, { factualCorrectness: null, projectRelevance: null, semanticDuplication: null })
    assert.match(await readFile(path.join(pendingRoot, 'review-report.md'), 'utf8'), /pending/)

    const partialRoot = path.join(root, 'partial')
    await mkdir(partialRoot)
    const partialFiles = await writeRun(partialRoot)
    const partialReview = JSON.parse(await readFile(partialFiles.reviewPath, 'utf8'))
    Object.assign(partialReview.ratings[0], { factualCorrectness: 4, projectRelevance: 3, semanticDuplication: 5 })
    partialReview.ratings[1].factualCorrectness = 1
    await writeFile(partialFiles.reviewPath, JSON.stringify(partialReview))
    const partialResult = invoke(partialFiles.reportPath, partialFiles.reviewPath)
    assert.equal(partialResult.status, 0, partialResult.stderr)
    const partial = JSON.parse(await readFile(partialFiles.reportPath, 'utf8')).humanReview
    assert.equal(partial.reviewedCount, 1)
    assert.equal(partial.pendingCount, 1)
    assert.equal(partial.coverage, 0.5)
    assert.deepEqual(partial.ratingAverages, { factualCorrectness: 4, projectRelevance: 3, semanticDuplication: 5 })

    const completeRoot = path.join(root, 'complete')
    await mkdir(completeRoot)
    const completeFiles = await writeRun(completeRoot)
    const completeReview = JSON.parse(await readFile(completeFiles.reviewPath, 'utf8'))
    Object.assign(completeReview.ratings[0], { factualCorrectness: 4, projectRelevance: 3, semanticDuplication: 5 })
    Object.assign(completeReview.ratings[1], { factualCorrectness: 2, projectRelevance: 5, semanticDuplication: 3 })
    await writeFile(completeFiles.reviewPath, JSON.stringify(completeReview))
    const completeResult = invoke(completeFiles.reportPath, completeFiles.reviewPath)
    assert.equal(completeResult.status, 0, completeResult.stderr)
    const complete = JSON.parse(await readFile(completeFiles.reportPath, 'utf8')).humanReview
    assert.equal(complete.status, 'reviewed')
    assert.equal(complete.reviewedCount, 2)
    assert.equal(complete.coverage, 1)
    assert.deepEqual(complete.ratingAverages, { factualCorrectness: 3, projectRelevance: 4, semanticDuplication: 4 })
    assert.match(await readFile(path.join(completeRoot, 'review-report.md'), 'utf8'), /factualCorrectness \| 3\.00/)
  })
})

test('review import CLI rejects a bad digest without changing the report', async () => {
  await withRun(async root => {
    const files = await writeRun(root)
    const review = JSON.parse(await readFile(files.reviewPath, 'utf8'))
    review.reportDigest = 'sha256:wrong'
    await writeFile(files.reviewPath, JSON.stringify(review))
    const before = await readFile(files.reportPath, 'utf8')
    const result = invoke(files.reportPath, files.reviewPath)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /different or unknown run/)
    assert.equal(await readFile(files.reportPath, 'utf8'), before)
  })
})
