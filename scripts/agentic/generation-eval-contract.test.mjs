import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GENERATION_PER_RUN,
  GENERATION_OUTPUT_CAPS,
  GENERATION_PURPOSE,
  createGenerationMatrix,
  deriveGenerationBudgets,
  loadGenerationEvaluationBundle,
  projectGenerationData,
  validateGenerationAuthorization,
  validateGenerationProjection
} from './generation-eval-contract.mjs'
import { canonicalJson, sha256 } from './dataset-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = path.join(root, 'scripts/agentic/datasets/v1')
const hash = (character) => character.repeat(64)
const commit = 'a'.repeat(40)

async function loadBundle() { return loadGenerationEvaluationBundle(dataDir) }

function validAuthorization(bundle) {
  const budget = deriveGenerationBudgets(bundle)
  return {
    purpose: GENERATION_PURPOSE,
    reference: 'offline-review-approval',
    sourceCommit: commit,
    generationDataHash: bundle.generationDataHash,
    endpointFingerprint: hash('b'),
    model: 'synthetic-model-name',
    protocol: 'openai',
    temperature: 0.4,
    reasoningEffort: null,
    contextWindowTokens: 49_152,
    maxOutputTokens: GENERATION_PER_RUN.maxOutputTokensPerRequest,
    maxRuns: budget.matrix.runs,
    maxRequests: budget.matrix.maxRequests,
    maxInputTokens: budget.matrix.maxInputTokens,
    maxOutputTokensTotal: budget.matrix.maxOutputTokensTotal
  }
}

test('public projection contains source and task inputs plus evidence references, never label prose', async () => {
  const bundle = await loadBundle()
  assert.equal(bundle.projects.length, 12)
  assert.equal(bundle.tasks.length, 12)
  assert.equal(bundle.fixedEvidenceInputs.length, 12)
  assert.deepEqual(Object.keys(bundle.sourceHashes).sort(), ['generation-labels.json', 'generation-tasks.json', 'projects.json'])
  const rawHashes = {}
  for (const name of ['projects.json', 'generation-tasks.json', 'generation-labels.json']) {
    rawHashes[name] = createHash('sha256').update(await readFile(path.join(dataDir, name))).digest('hex')
  }
  assert.deepEqual(bundle.sourceHashes, rawHashes, 'source binding hashes each raw frozen file, including labels')
  assert.equal(bundle.generationDataHash, sha256(Buffer.from(canonicalJson(rawHashes), 'utf8')))
  const publicText = JSON.stringify(bundle)
  assert.doesNotMatch(publicText, /expectedFacts|pitfalls|PRIVATE_ORACLE_SENTINEL|answerKey/iu)

  // Build synthetic private fields only; the projection must discard them without inspecting their values.
  const projectsDocument = JSON.parse(await readFile(path.join(dataDir, 'projects.json'), 'utf8'))
  const generationTasksDocument = JSON.parse(await readFile(path.join(dataDir, 'generation-tasks.json'), 'utf8'))
  const generationLabelsDocument = {
    schemaVersion: 1,
    labels: bundle.fixedEvidenceInputs.map(({ taskId, evidence }) => ({
      taskId,
      evidence,
      expectedFacts: [{ claim: 'PRIVATE_ORACLE_SENTINEL' }],
      pitfalls: ['PRIVATE_ORACLE_SENTINEL']
    }))
  }
  const projected = projectGenerationData({
    projectsDocument,
    generationTasksDocument,
    generationLabelsDocument,
    sourceHashes: bundle.sourceHashes
  })
  assert.equal(JSON.stringify(projected).includes('PRIVATE_ORACLE_SENTINEL'), false)
  assert.equal(JSON.stringify(projected).includes('expectedFacts'), false)
  assert.equal(JSON.stringify(projected).includes('pitfalls'), false)
})

test('fixed evaluation matrix has exactly 48 unique stable cells and no quality oracle', async () => {
  const bundle = await loadBundle()
  const first = createGenerationMatrix(bundle)
  const second = createGenerationMatrix(bundle)
  assert.equal(first.length, 48)
  assert.deepEqual(first, second)
  assert.equal(new Set(first.map((cell) => cell.id)).size, 48)
  assert.deepEqual(new Set(first.map((cell) => cell.strategy)), new Set(['static-control', 'agentic']))
  assert.deepEqual(new Set(first.map((cell) => cell.repeat)), new Set([1, 2]))
  for (const task of bundle.tasks) {
    const taskCells = first.filter((cell) => cell.taskId === task.id)
    assert.deepEqual(taskCells.map(({ strategy, repeat }) => `${repeat}:${strategy}`), ['1:static-control', '1:agentic', '2:agentic', '2:static-control'])
    for (const strategy of ['static-control', 'agentic']) {
      for (const repeat of [1, 2]) assert.ok(taskCells.some((cell) => cell.strategy === strategy && cell.repeat === repeat))
    }
  }
  assert.doesNotMatch(JSON.stringify(first), /expectedFacts|pitfalls|PRIVATE_ORACLE_SENTINEL/iu)
})

test('real corpus granularity derives the planned request and token ceilings', async () => {
  const bundle = await loadBundle()
  const budgets = deriveGenerationBudgets(bundle)
  assert.deepEqual(budgets.taskCounts, { medium: 7, fine: 5 })
  assert.deepEqual(budgets.matrix, {
    runs: 48,
    maxRequests: 420,
    maxInputTokens: 6_144_000,
    maxOutputTokensTotal: 3_145_728,
    maxWallClockMsTotal: 28_800_000
  })
  assert.equal(budgets.perRun.maxOutputTokensPerRequest, 32_768)
  assert.deepEqual(GENERATION_OUTPUT_CAPS, [16_384, 32_768])
  assert.deepEqual(budgets.perRun.maxRequestsByGranularity, { medium: 5, fine: 14 })
})

test('projection rejects missing, duplicate, out-of-range, and stale source evidence', async () => {
  const bundle = await loadBundle()
  assert.equal(validateGenerationProjection(bundle).valid, true)

  const missing = structuredClone(bundle)
  missing.fixedEvidenceInputs[0].evidence = []
  assert.ok(validateGenerationProjection(missing).issues.includes('fixed-evidence-empty'))

  const duplicate = structuredClone(bundle)
  duplicate.fixedEvidenceInputs[0].evidence.push(structuredClone(duplicate.fixedEvidenceInputs[0].evidence[0]))
  assert.ok(validateGenerationProjection(duplicate).issues.includes('fixed-evidence-ref-duplicate'))

  const wrongRange = structuredClone(bundle)
  wrongRange.fixedEvidenceInputs[0].evidence[0].endLine += 10_000
  assert.ok(validateGenerationProjection(wrongRange).issues.includes('fixed-evidence-range-invalid'))

  const staleSource = structuredClone(bundle)
  staleSource.sourceHashes['projects.json'] = hash('c')
  assert.ok(validateGenerationProjection(staleSource).issues.includes('generation-data-hash-invalid'))
})

test('authorization validation is strict, source-bound, and capped by the derived 48-run matrix', async () => {
  const bundle = await loadBundle()
  const expected = { bundle, sourceCommit: commit, generationDataHash: bundle.generationDataHash }
  const authorization = validAuthorization(bundle)
  assert.equal(validateGenerationAuthorization(authorization, expected), authorization)
  assert.equal(validateGenerationAuthorization({ ...authorization, maxOutputTokens: 16_384 }, expected).maxOutputTokens, 16_384)

  assert.throws(() => validateGenerationAuthorization(null, expected), { message: 'authorization-invalid' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, unexpected: 'field' }, expected), { message: 'authorization-invalid' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, sourceCommit: 'd'.repeat(40) }, expected), { message: 'authorization-binding-mismatch' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, generationDataHash: hash('d') }, expected), { message: 'authorization-binding-mismatch' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, maxRequests: 421 }, expected), { message: 'authorization-invalid' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, maxInputTokens: 6_144_001 }, expected), { message: 'authorization-invalid' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, maxOutputTokensTotal: 3_145_729 }, expected), { message: 'authorization-invalid' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, maxOutputTokens: 16_383 }, expected), { message: 'authorization-invalid' })
  assert.throws(() => validateGenerationAuthorization({ ...authorization, contextWindowTokens: 32_768 }, expected), { message: 'authorization-invalid' })
})
