import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fingerprintQuestion } from './scorer.mjs'

const dimensions = ['factualCorrectness', 'projectRelevance', 'semanticDuplication']
export function calculateReportDigest(report) {
  return `sha256:${createHash('sha256').update(JSON.stringify({ runId: report.runId, corpusVersion: report.corpusVersion, configHash: report.configHash, sourceHashes: report.sourceHashes, fixtureHashes: report.fixtureHashes, cases: report.cases.map(c => ({ id: c.id, output: c.output, baseline: c.baseline })) })).digest('hex')}`
}
export const RUBRIC = Object.freeze({
  factualCorrectness: '1 unsupported/false; 2 mostly unsupported; 3 mixed or uncertain; 4 supported with minor issue; 5 every material claim supported by fixture.',
  projectRelevance: '1 unrelated; 2 weak relation; 3 generic but applicable; 4 clearly tied to this project; 5 targets a central implementation decision.',
  semanticDuplication: '1 duplicates another question; 2 near duplicate; 3 partial overlap; 4 distinct with minor overlap; 5 clearly distinct.'
})

export function makeReviewTemplate(run) {
  const entries = run.questions.map(q => ({
    fingerprint: fingerprintQuestion(q.question, { caseId: q.caseId, variant: q.variant, answer: q.answer }), caseId: q.caseId, variant: q.variant, question: q.question, answer: q.answer,
    factualCorrectness: null, projectRelevance: null, semanticDuplication: null, note: ''
  }))
  return { schemaVersion: 'repoprep-human-review-v1', runId: run.runId, corpusVersion: run.corpusVersion, configHash: run.configHash, reportDigest: run.reportDigest, rubric: RUBRIC, ratings: entries }
}

export function validateReview(review, manifest) {
  if (calculateReportDigest(manifest) !== manifest.reportDigest) throw new Error('report content does not match its bound digest')
  if (review?.schemaVersion !== 'repoprep-human-review-v1' || review.runId !== manifest.runId || review.corpusVersion !== manifest.corpusVersion || review.configHash !== manifest.configHash || review.reportDigest !== manifest.reportDigest) throw new Error('review is bound to a different or unknown run')
  if (!Array.isArray(review.ratings)) throw new Error('ratings must be an array')
  const expected = new Map(manifest.questions.map(q => [fingerprintQuestion(q.question, { caseId: q.caseId, variant: q.variant, answer: q.answer }), q]))
  const seen = new Set()
  for (const entry of review.ratings) {
    const bound = expected.get(entry.fingerprint)
    if (!bound || entry.caseId !== bound.caseId || entry.variant !== bound.variant || entry.question !== bound.question || entry.answer !== bound.answer) throw new Error(`unknown question fingerprint: ${entry.fingerprint}`)
    if (seen.has(entry.fingerprint)) throw new Error(`duplicate question fingerprint: ${entry.fingerprint}`)
    seen.add(entry.fingerprint)
    for (const dimension of dimensions) if (entry[dimension] !== null && (!Number.isInteger(entry[dimension]) || entry[dimension] < 1 || entry[dimension] > 5)) throw new Error(`rating out of range for ${dimension}`)
  }
  const completed = review.ratings.filter(entry => dimensions.every(d => Number.isInteger(entry[d]))).length
  return { reviewedCount: completed, pendingCount: manifest.questions.length - completed, coverage: manifest.questions.length ? completed / manifest.questions.length : 0, status: completed === manifest.questions.length ? 'reviewed' : 'pending' }
}

if (process.argv[1]?.endsWith('review.mjs') && process.argv[2] === 'template') {
  const run = JSON.parse(await readFile(process.argv[3], 'utf8'))
  await writeFile(process.argv[4], `${JSON.stringify(makeReviewTemplate(run), null, 2)}\n`)
}

if (process.argv[1]?.endsWith('review.mjs') && process.argv[2] === 'import') {
  const reportPath = process.argv[3]
  const reviewPath = process.argv[4]
  if (!reportPath || !reviewPath) throw new Error('usage: review.mjs import <report.json> <filled-review.json>')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const review = JSON.parse(await readFile(reviewPath, 'utf8'))
  const summary = validateReview(review, report)
  const completed = review.ratings.filter(entry => dimensions.every(d => Number.isInteger(entry[d])))
  const averages = Object.fromEntries(dimensions.map(dimension => [dimension, completed.length ? completed.reduce((sum, entry) => sum + entry[dimension], 0) / completed.length : null]))
  report.humanReview = { ...summary, ratingAverages: averages, importedFile: path.basename(reviewPath) }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const markdownPath = path.join(path.dirname(reportPath), 'review-report.md')
  const reviewMarkdown = [
    '# Human review results', '', `- Run: ${report.runId}`, `- Corpus: ${report.corpusVersion}`, `- Config hash: ${report.configHash}`,
    `- Coverage: ${summary.reviewedCount}/${report.questions.length} (${(summary.coverage * 100).toFixed(1)}%)`, `- Status: ${summary.status}`,
    '', '| Dimension | Mean (complete ratings only) |', '|---|---:|', ...dimensions.map(d => `| ${d} | ${averages[d] === null ? 'pending' : averages[d].toFixed(2)} |`),
    '', 'Pending questions and partial scores are excluded from means; pending is not a pass.'
  ].join('\n')
  await writeFile(markdownPath, `${reviewMarkdown}\n`)
  const reportMarkdownPath = path.join(path.dirname(reportPath), 'report.md')
  try {
    const existing = await readFile(reportMarkdownPath, 'utf8')
    const section = `\n## Human review\n\nStatus: ${summary.status}; coverage ${summary.reviewedCount}/${report.questions.length} (${(summary.coverage * 100).toFixed(1)}%). Means over fully rated questions: ${dimensions.map(d => `${d} ${averages[d] === null ? 'pending' : averages[d].toFixed(2)}`).join(', ')}.\n`
    await writeFile(reportMarkdownPath, `${existing.replace(/\n## Human review[\s\S]*$/u, '').trimEnd()}\n${section}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  console.log(JSON.stringify(report.humanReview))
}
