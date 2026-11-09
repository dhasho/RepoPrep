import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 } from './dataset-contract.mjs'
import { GENERATION_REVIEW_DIMENSIONS, buildBlindedReviewPackets, verifyBlindedReviewPackets } from './generation-review.mjs'
import { loadVerifiedGenerationExecution, validateM08SyntheticRawArtifactsForTest } from './checks/m08.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const HASH = /^[a-f0-9]{64}$/u
const fail = code => { throw new Error(code) }

export function parsePreparationArgs(args) {
  const result = Object.create(null)
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!['--source-root', '--report-file', '--authorization-file'].includes(key) || result[key] || !args[index + 1] || args[index + 1].startsWith('--')) fail('PREPARE_ARGUMENTS_INVALID')
    result[key] = args[++index]
  }
  if (Object.keys(result).length !== 3) fail('PREPARE_ARGUMENTS_INVALID')
  return { sourceRoot: result['--source-root'], reportPath: result['--report-file'], authorizationPath: result['--authorization-file'] }
}

export function createReviewerTemplate(packetSet, role) {
  if (!['A', 'B'].includes(role)) fail('PREPARE_REVIEWER_ROLE_INVALID')
  return {
    schemaVersion: 1,
    protocol: 'm08-blind-review-v1',
    rubricSha256: packetSet.rubricSha256,
    reviewerId: role,
    agentIdentity: '',
    packetSetSha256: packetSet.packetSetSha256,
    packets: packetSet.packets.map(packet => ({
      packetId: packet.packetId,
      packetSha256: packet.packetSha256,
      answers: collectUnits(packet.questions).map(answerUnitId => ({
        answerUnitId, materialError: 'unknown', errorCategories: [], reason: '', sourceSupport: []
      })),
      topicValues: packet.questions.map(question => ({
        questionSetId: question.questionSetId,
        scores: Object.fromEntries(GENERATION_REVIEW_DIMENSIONS.map(dimension => [dimension, null])),
        reason: ''
      }))
    }))
  }
}

function collectUnits(questions) {
  const ids = []
  const visit = unit => { ids.push(unit.answerUnitId); unit.followUps.forEach(visit) }
  for (const question of questions) { ids.push(question.answerUnitId); question.followUps.forEach(visit) }
  return ids
}

async function exclusiveWrite(directory, name, value) {
  const file = path.join(directory, name)
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally { await handle.close() }
}

async function writeReviewArtifacts({ report, outputRoot, bundle, cells, rubricBytes, rubricSha256, checker }) {
  outputRoot = await realpath(outputRoot)
  const reviewDir = path.join(outputRoot, 'review')
  const built = buildBlindedReviewPackets({ bundle, cells, sourceBindings: report.sourceBindings, rubricSha256 })
  const reconstructed = verifyBlindedReviewPackets({
    bundle, cells, sourceBindings: report.sourceBindings, rubricSha256,
    packetSet: built.packetSet, privateMap: built.privateMap
  })
  if (built.packetSet.packets.length !== 48 || !HASH.test(reconstructed.packetSetSha256)) fail('PREPARE_PACKET_RECONSTRUCTION_FAILED')
  const reviewerA = createReviewerTemplate(built.packetSet, 'A')
  const reviewerB = createReviewerTemplate(built.packetSet, 'B')
  const metadata = {
    schemaVersion: 1,
    status: 'quality-pending',
    providerRequests: 0,
    checker: checker ? { sourceTreeHash: checker.sourceTreeHash, commit: checker.commit } : null,
    measuredSource: { commit: report.sourceBinding?.sourceCommit ?? null,
      generationDataHash: report.sourceBinding?.generationDataHash ?? bundle.generationDataHash,
      sourceHashes: report.sourceBinding?.sourceHashes ?? bundle.sourceHashes },
    rubricSha256,
    packetSetSha256: built.packetSet.packetSetSha256,
    privateMapSha256: built.privateMap.privateMapSha256,
    packetCount: built.packetSet.packets.length,
    answerUnits: built.answerUnits,
    mainQuestions: built.mainQuestions,
    sourceBindingHash: sha256(canonicalJson(report.sourceBindings))
  }
  await mkdir(reviewDir, { mode: 0o700 })
  await exclusiveWrite(reviewDir, 'packets.json', JSON.stringify(built.packetSet, null, 2) + '\n')
  await exclusiveWrite(reviewDir, 'private-map.json', JSON.stringify(built.privateMap, null, 2) + '\n')
  await exclusiveWrite(reviewDir, 'rubric.v2.json', rubricBytes)
  await exclusiveWrite(reviewDir, 'preparation-metadata.json', JSON.stringify(metadata, null, 2) + '\n')
  const templatesDir = path.join(reviewDir, 'templates')
  await mkdir(templatesDir, { mode: 0o700 })
  await exclusiveWrite(templatesDir, 'reviewer-a.json', JSON.stringify(reviewerA, null, 2) + '\n')
  await exclusiveWrite(templatesDir, 'reviewer-b.json', JSON.stringify(reviewerB, null, 2) + '\n')
  return Object.freeze({ reviewDir, packetSetSha256: built.packetSet.packetSetSha256, packets: 48, status: 'quality-pending', providerRequests: 0 })
}

export async function prepareGenerationReview(args) {
  return writeReviewArtifacts(await loadVerifiedGenerationExecution(args))
}

/** Synthetic-only preparation hook for fixtures. The public CLI never calls this function. */
export async function prepareSyntheticGenerationReviewForTest({ report, outputRoot, bundle, authorization }) {
  const verified = await validateM08SyntheticRawArtifactsForTest({ report, outputRoot, bundle, authorization })
  const rubricBytes = await readFile(path.join(here, 'assets/review-rubric.v2.json'))
  const outputRootResolved = path.resolve(outputRoot)
  return writeReviewArtifacts({
    report, outputRoot: outputRootResolved, bundle, cells: verified.verifiedCells,
    rubricBytes, rubricSha256: sha256(rubricBytes), checker: null
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareGenerationReview(parsePreparationArgs(process.argv.slice(2)))
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    process.stderr.write((typeof error?.message === 'string' && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'PREPARE_FAILED') + '\n')
    process.exitCode = 1
  }
}
