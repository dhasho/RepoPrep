import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createEvidenceStore } from '../../electron/services/workflow/evidence-store.ts'
import { packEvidence } from '../../electron/services/workflow/evidence-packer.ts'
import { createQuestionEvidenceRegistry } from '../../electron/services/workflow/question-evidence.ts'
import { createRunSpec } from '../../electron/services/workflow/run-spec.ts'
import { normalizeBaseUrl } from '../../electron/services/llm.ts'
import { canonicalJson, hashEvidenceRange, sha256 } from './dataset-contract.mjs'
import { createGenerationMatrix } from './generation-eval-contract.mjs'
import {
  adjudicationInputSha256,
  GENERATION_MATERIAL_ERROR_CATEGORIES,
  GENERATION_REVIEW_DIMENSIONS,
  analyzeSyntheticReviewGrades,
  buildBlindedReviewPackets,
  deriveReviewDisagreements,
  validateBlindedPacketSet,
  validateGenerationReviewBundle,
  verifyBlindedReviewPackets
} from './generation-review.mjs'

const languages = ['Python', 'JavaScript', 'TypeScript']
const profile = { id: 'review-synthetic-profile', name: 'Synthetic', baseUrl: 'https://review.invalid/v1', apiKey: 'SYNTHETIC_ONLY', model: 'review-fixture-model', protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 4096 }
const digest = value => sha256(Buffer.from(value, 'utf8'))

function syntheticBundle() {
  const projects = languages.map((language, projectIndex) => {
    const id = 'project-' + projectIndex
    const path = 'src/main-' + projectIndex + '.ts'
    const content = 'export function inspect() {\n  return ' + (projectIndex + 1) + '\n}\n'
    const fileHash = sha256(Buffer.from(content, 'utf8'))
    const files = [{ path, content, sha256: fileHash }]
    const summary = { id, language, files: [{ path, sha256: fileHash }] }
    return { id, language, files, contentSha256: sha256(Buffer.from(canonicalJson(summary), 'utf8')) }
  })
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: 'task-' + String(index + 1).padStart(2, '0'),
    projectId: projects[Math.floor(index / 4)].id,
    objective: 'Explore public source mechanisms for synthetic task ' + (index + 1),
    roleFocus: 'backend',
    granularity: index < 7 ? 'medium' : 'fine',
    topic: 'Public source mechanism ' + (index + 1)
  }))
  const fixedEvidenceInputs = tasks.map(task => {
    const project = projects.find(item => item.id === task.projectId)
    const file = project.files[0]
    return { taskId: task.id, evidence: [{ path: file.path, startLine: 1, endLine: 3, sha256: hashEvidenceRange(file.content, 1, 3) }] }
  })
  const sourceHashes = { 'projects.json': 'a'.repeat(64), 'generation-tasks.json': 'b'.repeat(64), 'generation-labels.json': 'c'.repeat(64) }
  return {
    schemaVersion: 1,
    split: 'development-synthetic',
    projects,
    tasks,
    fixedEvidenceInputs,
    sourceHashes,
    generationDataHash: sha256(Buffer.from(canonicalJson(sourceHashes), 'utf8'))
  }
}

async function makeStores(bundle) {
  const byProject = new Map()
  for (const project of bundle.projects) {
    const owned = new WeakSet()
    const file = project.files[0]
    const snapshot = {
      projectId: project.id,
      snapshotId: 'snapshot-' + project.id,
      policyVersion: 'review-fixture-policy-v1',
      files: Object.freeze([{ fileId: 'file-' + project.id, relPath: file.path, byteLength: Buffer.byteLength(file.content), sourceKind: 'code' }]),
      summary: Object.freeze({ name: project.id, totalFiles: 1, contentFileCount: 1, truncated: false }),
      async assertCurrent() {},
      async readFile() { throw new Error('not-used') },
      ownsRead(value) { return typeof value === 'object' && value !== null && owned.has(value) }
    }
    const store = createEvidenceStore(snapshot)
    const read = Object.freeze({
      snapshotId: snapshot.snapshotId, fileId: snapshot.files[0].fileId, relPath: file.path, sourceKind: 'code',
      text: file.content, contentHash: sha256(Buffer.from(file.content, 'utf8')), readBytes: Buffer.byteLength(file.content),
      lineMapping: 'preserved', redactionVersion: 'review-fixture-redaction-v1',
      parserVersion: 'review-fixture-parser-v1', analysis: null, indexStatus: 'unavailable'
    })
    owned.add(read)
    const evidence = (await store.issue(read, { startLine: 1, endLine: 3 }))[0]
    byProject.set(project.id, { snapshot, store, read, evidenceId: evidence.id })
  }
  return byProject
}

async function syntheticExecution() {
  const bundle = syntheticBundle()
  const stores = makeStores(bundle)
  const sourceBindings = Object.create(null)
  const cells = []
  const sourceHashes = new Map()
  let actualOrder = 0
  for (const task of bundle.tasks) {
    const sourceProject = bundle.projects.find(item => item.id === task.projectId)
    const { snapshot, store, read } = stores.get(task.projectId)
    const evidenceId = (await store.issue(read, { startLine: 1, endLine: 3 }))[0].id
    for (const strategy of ['static-control', 'agentic']) for (const repeat of [1, 2]) {
      actualOrder++
      const id = task.id + ':' + strategy + ':repeat-' + repeat
      const strategyKind = strategy === 'static-control' ? 'static' : 'agentic'
      const model = {
        profileId: profile.id,
        endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'),
        model: profile.model,
        protocol: profile.protocol,
        contextWindowTokens: profile.contextWindowTokens,
        maxOutputTokens: profile.maxOutputTokens
      }
      const spec = createRunSpec({
        version: 1, runId: id, projectId: task.projectId, snapshotId: snapshot.snapshotId,
        strategy: strategyKind, strategyVersion: strategyKind + '-v1',
        roleFocus: task.roleFocus, granularity: task.granularity, model,
        promptVersion: 'review-fixture-prompt-v1', toolVersion: 'review-fixture-tool-v1', policyVersion: 'review-fixture-policy-v1'
      })
      const requestId = 'request-' + String(actualOrder).padStart(3, '0')
      const packed = await packEvidence({
        spec, store, selection: { selectedIds: [evidenceId], requiredBundles: [{ id: 'fixed-source', evidenceIds: [evidenceId] }], unresolved: [] },
        buildMessages: contextText => [{ role: 'system', content: 'Synthetic reviewer fixture.' }, { role: 'user', content: 'Use this exact source only:\n' + contextText }]
      })
      assert.equal(packed.status, 'packed')
      const question = {
        id: 'question-' + String(actualOrder).padStart(3, '0'),
        title: 'Synthetic question ' + actualOrder,
        question: 'What does the selected function return?',
        answer: 'It returns a constant value shown in the cited source.',
        followUps: [{
          question: 'What condition changes that value?',
          answer: 'The current implementation has no conditional branch in this excerpt.',
          followUps: [{ question: 'What is not established?', answer: 'Behavior outside this excerpt is unknown.', followUps: [] }]
        }]
      }
      const result = {
        version: 1, createdAt: '2026-11-08T00:00:00.000Z', projectName: sourceProject.id, projectPath: 'source-fixture',
        granularity: task.granularity, roleFocus: task.roleFocus, profileId: profile.id, modelUsed: 'Synthetic fixture',
        projectSummary: 'Synthetic source fixture.', sections: [{ id: 'section-1', title: 'Behavior', questions: [question] }], glossary: {}
      }
      const registry = createQuestionEvidenceRegistry(spec)
      registry.registerRequest(requestId, packed.context)
      registry.capture({ requestId, rawQuestion: { evidenceIds: [evidenceId] }, question })
      const sidecar = registry.finalize(result)
      const manifest = packed.context.manifest
      for (const source of manifest.sources) {
        for (const id of source.ids) sourceHashes.set(id, {
          path: source.relPath, displayRange: source.displayRange, originalRange: source.originalRange,
          hash: source.hash, sourceKind: source.sourceKind
        })
      }
      const metadataRequest = {
        requestId, stage: 'generation', completion: 'completed',
        usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
        reservation: { state: 'settled', inputTokens: 256, outputTokens: 4096 },
        manifest
      }
      cells.push({
        cell: { id, taskId: task.id, strategy, repeat, actualOrder, granularity: task.granularity },
        result,
        sidecar,
        requests: [metadataRequest]
      })
    }
  }
  for (const [evidenceId, source] of sourceHashes) sourceBindings[evidenceId] = source
  return { bundle, cells, sourceBindings }
}

function units(packet) {
  const output = []
  const visit = unit => {
    output.push(unit)
    for (const child of unit.followUps ?? []) visit(child)
  }
  for (const question of packet.questions) {
    visit({ answerUnitId: question.answerUnitId, sourceIds: question.sourceIds })
    question.followUps.forEach(visit)
  }
  return output
}

function syntheticReview(packetSet, reviewerId, agentIdentity, overrides = {}) {
  return {
    schemaVersion: 1,
    protocol: 'm08-blind-review-v1',
    reviewerId,
    agentIdentity,
    packetSetSha256: packetSet.packetSetSha256,
    packets: packetSet.packets.map(packet => ({
      packetId: packet.packetId,
      packetSha256: packet.packetSha256,
      answers: units(packet).map(unit => {
        const override = overrides.answerUnitId === unit.answerUnitId ? overrides.answer : {}
        const source = packet.sources.find(value => unit.sourceIds.includes(value.sourceId))
        return {
          answerUnitId: unit.answerUnitId,
          materialError: override.materialError ?? false,
          errorCategories: override.errorCategories ?? [],
          reason: 'This is a synthetic structured review rationale.',
          sourceSupport: [{ sourceId: source.sourceId, path: source.path, startLine: source.startLine, endLine: source.endLine, sha256: source.sourceHash }]
        }
      }),
      topicValues: packet.questions.map(question => ({
        questionSetId: question.questionSetId,
        scores: { relevance: 3, 'mechanism-depth': 3, 'evidence-specificity': 3, 'follow-up-progression': 3 },
        reason: 'This is a synthetic structured topic-value rationale.'
      }))
    }))
  }
}

function reviewScore(scores = {}) {
  return Object.fromEntries(GENERATION_REVIEW_DIMENSIONS.map(dimension => [dimension, scores[dimension] ?? 3]))
}

function sourceSupport(packet, unit) {
  const source = packet.sources.find(item => unit.sourceIds.includes(item.sourceId))
  return [{ sourceId: source.sourceId, path: source.path, startLine: source.startLine, endLine: source.endLine, sha256: source.sourceHash }]
}

function reviewerRecord(packetSet, reviewerId, agentIdentity, changes = {}) {
  return {
    schemaVersion: 1, protocol: 'm08-blind-review-v1', rubricSha256: packetSet.rubricSha256, reviewerId, agentIdentity, packetSetSha256: packetSet.packetSetSha256,
    packets: packetSet.packets.map(packet => ({
      packetId: packet.packetId, packetSha256: packet.packetSha256,
      answers: units(packet).map(unit => ({
        answerUnitId: unit.answerUnitId,
        materialError: changes.answerUnitId === unit.answerUnitId ? changes.materialError : false,
        errorCategories: changes.answerUnitId === unit.answerUnitId ? changes.errorCategories ?? [] : [],
        reason: 'Synthetic review note grounded in the displayed source excerpt.',
        sourceSupport: sourceSupport(packet, unit)
      })),
      topicValues: packet.questions.map(question => ({
        questionSetId: question.questionSetId,
        scores: reviewScore(changes.questionSetId === question.questionSetId ? changes.scores : {}),
        reason: 'Synthetic topic-value note tied to the public goal and source.'
      }))
    }))
  }
}

async function syntheticData() {
  const bundle = syntheticBundle()
  const stores = await makeStores(bundle)
  const sourceBindings = Object.create(null)
  const cells = []
  let actualOrder = 0
  for (const expectedCell of createGenerationMatrix(bundle)) {
    const task = bundle.tasks.find(item => item.id === expectedCell.taskId)
    const project = bundle.projects.find(item => item.id === task.projectId)
    const { snapshot, store, evidenceId } = stores.get(task.projectId)
    const strategy = expectedCell.strategy === 'static-control' ? 'static' : 'agentic'
    const spec = createRunSpec({
      version: 1, runId: expectedCell.id, projectId: task.projectId, snapshotId: snapshot.snapshotId,
      strategy, strategyVersion: strategy + '-v1', roleFocus: task.roleFocus, granularity: task.granularity,
      model: { profileId: profile.id, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), model: profile.model, protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens },
      promptVersion: 'review-fixture-prompt-v1', toolVersion: 'review-fixture-tool-v1', policyVersion: 'review-fixture-policy-v1'
    })
    const requestId = 'request-' + String(actualOrder + 1).padStart(3, '0')
    const result = await packEvidence({ spec, store, selection: { selectedIds: [evidenceId], requiredBundles: [{ id: 'source-bundle', evidenceIds: [evidenceId] }], unresolved: [] }, buildMessages: contextText => [{ role: 'system', content: 'Fixture interviewer.' }, { role: 'user', content: 'Quoted source:\n' + contextText }] })
    if (result.status !== 'packed') throw new Error('synthetic-packing-failed')
    const question = {
        id: 'question-' + String(actualOrder + 1).padStart(3, '0'),
        title: 'Synthetic source behavior',
        question: 'What does the selected function return?',
        answer: 'It returns the constant shown in the source excerpt.',
        followUps: [{ question: 'What assumption changes the result?', answer: 'The excerpt shows no branch for that assumption.', followUps: [{ question: 'What behavior remains unknown?', answer: 'Other call sites are outside this excerpt.', followUps: [] }] }]
      }
    const interview = { version: 1, createdAt: '2026-11-08T00:00:00.000Z', projectName: project.id, projectPath: 'source-fixture', granularity: task.granularity, roleFocus: task.roleFocus, profileId: profile.id, modelUsed: 'Synthetic fixture', projectSummary: 'Synthetic project.', sections: [{ id: 'section-1', title: 'Behavior', questions: [question] }], glossary: {} }
    const registry = createQuestionEvidenceRegistry(spec)
    registry.registerRequest(requestId, result.context)
    registry.capture({ requestId, rawQuestion: { evidenceIds: [evidenceId] }, question })
    const sidecar = registry.finalize(interview)
    const manifest = result.context.manifest
    for (const source of manifest.sources) for (const id of source.ids) sourceBindings[id] = {
      path: source.relPath, displayRange: source.displayRange, originalRange: source.originalRange, hash: source.hash, sourceKind: source.sourceKind
    }
    const request = { requestId, stage: 'generation', completion: 'completed', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, reservation: { state: 'settled', inputTokens: 256, outputTokens: 4096 }, manifest }
    cells.push({ cell: { ...expectedCell, actualOrder: actualOrder + 1 }, result: interview, sidecar, requests: [request] })
    actualOrder++
  }
  return { bundle, cells, sourceBindings, rubricSha256: 'd'.repeat(64) }
}

test('synthetic contract fixtures bind blinded packets to raw M07 artifacts and score disagreement without asserting real review', async () => {
  const data = await syntheticData()
  const built = buildBlindedReviewPackets(data)
  assert.equal(built.packetSet.packets.length, 48)
  assert.equal(built.answerUnits, 144)
  assert.equal(built.mainQuestions, 48)
  assert.equal(JSON.stringify(built.packetSet).includes('static-control'), false)
  assert.equal(JSON.stringify(built.packetSet).includes('question-001'), false)
  assert.ok(built.privateMap.packets.some(item => item.strategy === 'static-control'))
  assert.ok(built.privateMap.packets.some(item => item.strategy === 'agentic'))
  assert.deepEqual(verifyBlindedReviewPackets({ ...data, packetSet: built.packetSet, privateMap: built.privateMap }), {
    packetSetSha256: built.packetSet.packetSetSha256,
    privateMapSha256: built.privateMap.privateMapSha256,
    answerUnits: 144,
    mainQuestions: 48
  })

  const candidate = built.privateMap.packets.find(item => item.strategy === 'agentic')
  const candidatePacket = built.packetSet.packets.find(item => item.packetId === candidate.packetId)
  const answerUnit = candidate.questionSets[0].answerUnits[0]
  const questionSetId = candidate.questionSets[0].questionSetId
  const reviewerA = reviewerRecord(built.packetSet, 'A', 'synthetic-fixture-reviewer-a')
  const reviewerB = reviewerRecord(built.packetSet, 'B', 'synthetic-fixture-reviewer-b', {
    answerUnitId: answerUnit.answerUnitId,
    materialError: true,
    errorCategories: ['unsupported-claim'],
    questionSetId,
    scores: { relevance: 4 }
  })
  const difference = deriveReviewDisagreements({ packetSet: built.packetSet, privateMap: built.privateMap, reviewerA, reviewerB })
  assert.equal(difference.disagreements.length, 2)
  const packetQuestion = candidatePacket.questions.find(item => item.questionSetId === questionSetId)
  const mainPacketUnit = units(candidatePacket).find(item => item.answerUnitId === answerUnit.answerUnitId)
  const adjudication = {
    schemaVersion: 1,
    protocol: 'm08-blind-review-v1',
    rubricSha256: built.packetSet.rubricSha256,
    packetSetSha256: built.packetSet.packetSetSha256,
    inputPacketSha256: difference.inputPacketSha256,
    resolutions: [
      {
        kind: 'answer',
        packetId: candidate.packetId,
        answerUnitId: answerUnit.answerUnitId,
        materialError: true,
        errorCategories: ['contradicted-source', 'unsupported-claim'],
        reason: 'The source-backed claim remains materially unsupported.',
        sourceSupport: sourceSupport(candidatePacket, mainPacketUnit)[0] ? [sourceSupport(candidatePacket, mainPacketUnit)[0]] : []
      },
      {
        kind: 'topic-value',
        packetId: candidate.packetId,
        questionSetId,
        scores: { relevance: 5, 'mechanism-depth': 3, 'evidence-specificity': 3, 'follow-up-progression': 3 },
        reason: 'The question directly tests the stated public objective.'
      }
    ]
  }
  const analysed = analyzeSyntheticReviewGrades({ packetSet: built.packetSet, privateMap: built.privateMap, reviewerA, reviewerB, adjudication })
  assert.equal(analysed.answerUnits, 144)
  assert.equal(analysed.mainQuestions, 48)
  assert.equal(analysed.metrics.unpackedEvidenceCited, 0)
  assert.equal(analysed.metrics.materialErrorRate, 1 / 72)
  assert.equal(analysed.metrics.staticControlMaterialErrorRate, 0)
  assert.ok(analysed.metrics.topicValueMean > analysed.metrics.staticControlTopicValueMean)
  assert.equal(analysed.categoryCounts.agentic['contradicted-source'], 1)
  assert.equal(analysed.categoryCounts.agentic['unsupported-claim'], 1)

  const extraAnswerResolution = structuredClone(adjudication)
  extraAnswerResolution.resolutions[0].unexpected = 'rejected'
  assert.throws(() => analyzeSyntheticReviewGrades({
    packetSet: built.packetSet, privateMap: built.privateMap, reviewerA, reviewerB, adjudication: extraAnswerResolution
  }), /adjudication-resolution-invalid/u)

  const incomplete = structuredClone(reviewerA)
  incomplete.packets[0].answers.pop()
  assert.throws(() => analyzeSyntheticReviewGrades({ packetSet: built.packetSet, privateMap: built.privateMap, reviewerA: incomplete, reviewerB, adjudication }), /review-answer-coverage-invalid/u)
  const unknown = structuredClone(reviewerA)
  unknown.packets[0].answers[0].materialError = 'unknown'
  assert.throws(() => analyzeSyntheticReviewGrades({ packetSet: built.packetSet, privateMap: built.privateMap, reviewerA: unknown, reviewerB, adjudication }), /review-answer-grade-invalid/u)
  assert.throws(() => deriveReviewDisagreements({ packetSet: built.packetSet, privateMap: built.privateMap, reviewerA, reviewerB: { ...reviewerB, agentIdentity: reviewerA.agentIdentity } }), /reviewers-not-independent/u)
  assert.throws(() => validateGenerationReviewBundle({
    packetSet: built.packetSet, privateMap: built.privateMap, reviewerA, reviewerB, adjudication,
    invocations: null, outputHashes: null, usageComplete: true
  }), /review-invocation-bundle-invalid/u)
  assert.throws(() => validateGenerationReviewBundle({
    packetSet: built.packetSet, privateMap: built.privateMap,
    reviewerA: { ...reviewerA, agentIdentity: 'x'.repeat(201) }, reviewerB, adjudication,
    invocations: null, outputHashes: null, usageComplete: true
  }), /review-invocation-bundle-invalid/u)
  assert.throws(() => analyzeSyntheticReviewGrades({
    packetSet: built.packetSet, privateMap: built.privateMap,
    reviewerA: { ...reviewerA, agentIdentity: 'x'.repeat(201) }, reviewerB, adjudication
  }), /reviewer-record-invalid/u)

  const badManifest = structuredClone(data)
  badManifest.cells[0].requests[0].manifest.manifestHash = '0'.repeat(64)
  assert.throws(() => buildBlindedReviewPackets(badManifest), /m07-manifest-invalid/u)
  const changedExecution = structuredClone(data)
  changedExecution.cells[0].result.sections[0].questions[0].answer += ' changed after review'
  assert.throws(() => verifyBlindedReviewPackets({ ...changedExecution, packetSet: built.packetSet, privateMap: built.privateMap }), /question-fingerprint-mismatch/u)
  assert.ok(packetQuestion)
})
