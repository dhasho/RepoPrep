import { randomUUID } from 'node:crypto'
import { redactSensitiveContent } from '../../electron/services/sensitive.ts'
import { canonicalJson, sha256 } from './dataset-contract.mjs'
import { createGenerationMatrix, validateGenerationProjection } from './generation-eval-contract.mjs'

export const GENERATION_REVIEW_PROTOCOL = 'm08-blind-review-v1'
export const GENERATION_REVIEW_SCHEMA_VERSION = 1
export const GENERATION_REVIEWER_ROLES = Object.freeze(['A', 'B'])
export const GENERATION_REVIEW_DIMENSIONS = Object.freeze([
  'relevance', 'mechanism-depth', 'evidence-specificity', 'follow-up-progression'
])
export const GENERATION_MATERIAL_ERROR_CATEGORIES = Object.freeze([
  'contradicted-source', 'unsupported-claim', 'misleading-omission', 'other'
])
export const GENERATION_REVIEW_FILES = Object.freeze({
  packets: 'packets.json',
  privateMap: 'private-map.json',
  reviewerA: 'reviewer-a.json',
  reviewerB: 'reviewer-b.json',
  adjudication: 'adjudication.json',
  invocations: 'invocations.json'
})

const HASH = /^[a-f0-9]{64}$/u
const EVIDENCE_ID = /^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_PACKETS = 48
const MAX_PACKET_BYTES = 2 * 1024 * 1024
const MAX_PACKET_SET_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_REFS_PER_ANSWER = 16
const MAX_REVIEW_REASON_CHARS = 2400
const REVIEWER_OUTPUTS = Object.freeze({ A: 'reviewer-a.json', B: 'reviewer-b.json' })
const FORBIDDEN_PACKET_KEYS = new Set([
  'strategy', 'strategyVersion', 'profile', 'profileId', 'model', 'modelUsed', 'runId',
  'projectId', 'snapshotId', 'requestId', 'questionId', 'questionFingerprint',
  'manifestHash', 'workflowTrace', 'trace', 'expectedFacts', 'pitfalls', 'labels',
  'materialError', 'topicValue', 'sidecar', 'prompt', 'reasoning', 'cot', 'apiKey'
])

const fail = code => { throw new Error(code || 'generation-review-invalid') }
const isRecord = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
const exact = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const hash = value => sha256(Buffer.from(value, 'utf8'))
const hashJson = value => hash(canonicalJson(value))
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !value.includes(String.fromCharCode(0))
const safeOpaqueId = value => typeof value === 'string' && /^(?:packet|src|qset|unit)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const safeText = (value, max = 256_000) => typeof value === 'string' && value.length <= max && !value.includes(String.fromCharCode(0))
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
  !value.includes('\\') && !value.includes(String.fromCharCode(0)) && !value.includes(':') && !value.startsWith('/') &&
  value.split('/').every(part => part && part !== '.' && part !== '..')
const normalizeText = value => value.replace(/\r\n?/gu, '\n')
const opaqueId = prefix => prefix + '_' + randomUUID()

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

/** Mirrors the sidecar fingerprint algorithm; question IDs and other ephemeral metadata are excluded. */
export function fingerprintGenerationQuestion(question) {
  let nodes = 0
  let chars = 0
  const followUp = (value, depth) => {
    if (depth > 8 || nodes >= 64 || !isRecord(value) || typeof value.question !== 'string' || typeof value.answer !== 'string') fail('question-fingerprint-invalid')
    nodes++
    chars += value.question.length + value.answer.length
    if (chars > 256_000) fail('question-fingerprint-invalid')
    let children = []
    if (value.followUps !== undefined) {
      if (!Array.isArray(value.followUps) || value.followUps.length > 32) fail('question-fingerprint-invalid')
      children = value.followUps.map(child => followUp(child, depth + 1))
    }
    return { question: value.question, answer: value.answer, followUps: children }
  }
  if (!isRecord(question) || typeof question.question !== 'string' || typeof question.answer !== 'string' ||
    !Array.isArray(question.followUps) || question.followUps.length > 32 ||
    (question.title !== undefined && typeof question.title !== 'string')) fail('question-fingerprint-invalid')
  chars = question.question.length + question.answer.length + (typeof question.title === 'string' ? question.title.length : 0)
  if (chars > 256_000) fail('question-fingerprint-invalid')
  return hashJson({
    title: typeof question.title === 'string' ? question.title : null,
    question: question.question,
    answer: question.answer,
    followUps: question.followUps.map(item => followUp(item, 0))
  })
}

function m07ManifestHash(manifest) {
  // M07 commits JSON.stringify of this fixed-order object, not canonicalJson sorting.
  const payload = {
    version: manifest.version,
    runId: manifest.runId,
    projectId: manifest.projectId,
    snapshotId: manifest.snapshotId,
    selectedIds: manifest.selectedIds,
    requiredIds: manifest.requiredIds,
    packedIds: manifest.packedIds,
    omitted: manifest.omitted,
    sources: manifest.sources,
    requestHash: manifest.requestHash,
    estimatedInputTokens: manifest.estimatedInputTokens,
    serializedChars: manifest.serializedChars,
    contextChars: manifest.contextChars,
    serializationOverheadTokens: manifest.serializationOverheadTokens,
    maxInputTokens: manifest.maxInputTokens,
    maxChars: manifest.maxChars
  }
  return hash(JSON.stringify(payload))
}

function validatePackedManifest(manifest) {
  if (!isRecord(manifest) || manifest.version !== 1 || !safeId(manifest.runId) ||
    !safeId(manifest.projectId) || !safeId(manifest.snapshotId) ||
    !HASH.test(manifest.requestHash || '') || !HASH.test(manifest.manifestHash || '') ||
    !Array.isArray(manifest.selectedIds) || !Array.isArray(manifest.requiredIds) ||
    !Array.isArray(manifest.packedIds) || !Array.isArray(manifest.omitted) || !Array.isArray(manifest.sources)) fail('m07-manifest-invalid')
  const { selectedIds, requiredIds, packedIds, omitted, sources } = manifest
  if (selectedIds.length > 4096 || packedIds.length < 1 || packedIds.length > 4096 ||
    requiredIds.length > 4096 || omitted.length > 4096 || sources.length > 4096 ||
    selectedIds.some(value => !EVIDENCE_ID.test(value)) || packedIds.some(value => !EVIDENCE_ID.test(value)) ||
    requiredIds.some(value => !EVIDENCE_ID.test(value)) || new Set(selectedIds).size !== selectedIds.length ||
    new Set(packedIds).size !== packedIds.length || new Set(requiredIds).size !== requiredIds.length) fail('m07-manifest-invalid')
  if (packedIds.some(value => !selectedIds.includes(value)) || requiredIds.some(value => !packedIds.includes(value)) ||
    omitted.some(item => !exact(item, ['id', 'reason']) || !selectedIds.includes(item.id) || item.reason !== 'budget' || packedIds.includes(item.id)) ||
    selectedIds.some(value => !packedIds.includes(value) && !omitted.some(item => item.id === value))) fail('m07-manifest-invalid')
  for (const key of ['estimatedInputTokens', 'serializedChars', 'contextChars', 'serializationOverheadTokens', 'maxInputTokens', 'maxChars']) {
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) fail('m07-manifest-invalid')
  }
  const sourceIds = new Set()
  for (const source of sources) {
    if (!exact(source, ['ids', 'fileId', 'relPath', 'displayRange', 'originalRange', 'hash', 'sourceKind']) ||
      !Array.isArray(source.ids) || source.ids.length < 1 || !safeId(source.fileId) || !safePath(source.relPath) ||
      !validRange(source.displayRange) || !(source.originalRange === null || validRange(source.originalRange)) ||
      !HASH.test(source.hash || '') || !['code', 'documentation', 'configuration', 'other'].includes(source.sourceKind)) fail('m07-manifest-invalid')
    for (const evidenceId of source.ids) {
      if (!EVIDENCE_ID.test(evidenceId) || !packedIds.includes(evidenceId) || sourceIds.has(evidenceId)) fail('m07-manifest-invalid')
      sourceIds.add(evidenceId)
    }
  }
  if (sourceIds.size !== packedIds.length || packedIds.some(value => !sourceIds.has(value)) ||
    m07ManifestHash(manifest) !== manifest.manifestHash) fail('m07-manifest-invalid')
}

function validRange(value) {
  return exact(value, ['startLine', 'endLine']) && Number.isSafeInteger(value.startLine) &&
    Number.isSafeInteger(value.endLine) && value.startLine >= 1 && value.endLine >= value.startLine
}

function descriptorFromSource(source) {
  return {
    path: source.relPath,
    displayRange: { startLine: source.displayRange.startLine, endLine: source.displayRange.endLine },
    originalRange: source.originalRange === null ? null : { startLine: source.originalRange.startLine, endLine: source.originalRange.endLine },
    hash: source.hash,
    sourceKind: source.sourceKind
  }
}

function descriptorMatches(actual, expected) {
  return isRecord(actual) && actual.path === expected.path &&
    canonicalJson(actual.displayRange) === canonicalJson(expected.displayRange) &&
    canonicalJson(actual.originalRange) === canonicalJson(expected.originalRange) &&
    actual.hash === expected.hash && actual.sourceKind === expected.sourceKind
}

function sourceExcerpt(project, source) {
  const file = project.files.find(candidate => candidate.path === source.relPath)
  if (!file) fail('source-range-invalid')
  const sanitized = redactSensitiveContent(normalizeText(file.content)).content
  const lines = sanitized.split('\n')
  if (source.displayRange.endLine > lines.length) fail('source-range-invalid')
  const content = lines.slice(source.displayRange.startLine - 1, source.displayRange.endLine).join('\n')
  if (hash(content) !== source.hash) fail('source-hash-mismatch')
  return content
}

function validateRequest(request, sourceBindings) {
  if (!exact(request, ['requestId', 'stage', 'completion', 'usage', 'reservation', 'manifest']) ||
    !safeId(request.requestId) || !['generation', 'repair', 'compensation'].includes(request.stage) ||
    request.completion !== 'completed' || !isRecord(request.reservation) ||
    request.reservation.state !== 'settled' || !isRecord(request.usage)) fail('request-usage-invalid')
  const usage = request.usage
  if (![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(Number.isSafeInteger) ||
    usage.inputTokens < 0 || usage.outputTokens < 0 || usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    !Number.isSafeInteger(request.reservation.inputTokens) || !Number.isSafeInteger(request.reservation.outputTokens) ||
    usage.inputTokens > request.reservation.inputTokens || usage.outputTokens > request.reservation.outputTokens ||
    usage.outputTokens > 16_384) fail('request-usage-invalid')
  validatePackedManifest(request.manifest)
  for (const source of request.manifest.sources) {
    const descriptor = descriptorFromSource(source)
    for (const evidenceId of source.ids) if (!descriptorMatches(sourceBindings[evidenceId], descriptor)) fail('source-binding-invalid')
  }
}

function walkQuestion(question, visitor, pathParts = [], depth = 0, state = { count: 0 }) {
  if (depth > 8 || state.count >= 64 || !isRecord(question) || typeof question.question !== 'string' ||
    typeof question.answer !== 'string' || !Array.isArray(question.followUps) || question.followUps.length > 32) fail('result-question-invalid')
  state.count++
  visitor(question, pathParts, depth)
  question.followUps.forEach((child, index) => walkQuestion(child, visitor, [...pathParts, index], depth + 1, state))
}

function buildCellPacket({ bundle, cell, result, sidecar, requests, sourceBindings, opaqueIdFactory }) {
  if (!isRecord(cell) || !safeText(cell.id, 512) || !safeText(cell.taskId, 512) ||
    !['agentic', 'static-control'].includes(cell.strategy) || !Number.isInteger(cell.repeat) ||
    cell.repeat < 1 || cell.repeat > 2 || !Array.isArray(requests) ||
    !isRecord(result) || !exact(sidecar, ['version', 'runId', 'projectId', 'snapshotId', 'questions']) ||
    sidecar.version !== 1 || !Array.isArray(sidecar.questions)) fail('cell-artifact-invalid')
  const task = bundle.tasks.find(item => item.id === cell.taskId)
  if (!task || result.granularity !== task.granularity || result.roleFocus !== task.roleFocus || !Array.isArray(result.sections)) fail('cell-task-mismatch')
  const project = bundle.projects.find(item => item.id === task.projectId)
  if (!project) fail('source-project-missing')

  const requestMap = new Map()
  for (const request of requests) {
    validateRequest(request, sourceBindings)
    if (requestMap.has(request.requestId)) fail('request-id-duplicate')
    if (request.manifest.projectId !== sidecar.projectId || request.manifest.snapshotId !== sidecar.snapshotId ||
      request.manifest.runId !== sidecar.runId) fail('run-identity-mismatch')
    requestMap.set(request.requestId, request)
  }
  if (requestMap.size === 0) fail('requests-missing')

  const sidecarMap = new Map()
  for (const entry of sidecar.questions) {
    if (!exact(entry, ['questionId', 'questionFingerprint', 'requestId', 'manifestHash', 'evidenceIds', 'verification']) ||
      !safeId(entry.questionId) || !HASH.test(entry.questionFingerprint || '') || !safeId(entry.requestId) ||
      !HASH.test(entry.manifestHash || '') || !Array.isArray(entry.evidenceIds) || entry.evidenceIds.length < 1 ||
      entry.evidenceIds.length > 16 || new Set(entry.evidenceIds).size !== entry.evidenceIds.length ||
      entry.evidenceIds.some(value => !EVIDENCE_ID.test(value)) || entry.verification !== 'source-bound-unverified' ||
      sidecarMap.has(entry.questionId)) fail('sidecar-entry-invalid')
    const request = requestMap.get(entry.requestId)
    if (!request || request.manifest.manifestHash !== entry.manifestHash ||
      entry.evidenceIds.some(value => !request.manifest.packedIds.includes(value))) fail('sidecar-citation-invalid')
    sidecarMap.set(entry.questionId, entry)
  }

  const sourceRefByDescriptor = new Map()
  const publicSources = []
  const privateSourceMap = new Map()
  const sourceRefByEvidence = new Map()
  for (const request of requests) {
    for (const source of request.manifest.sources) {
      const descriptor = descriptorFromSource(source)
      const key = canonicalJson(descriptor)
      let sourceRef = sourceRefByDescriptor.get(key)
      if (!sourceRef) {
        sourceRef = opaqueIdFactory('src')
        sourceRefByDescriptor.set(key, sourceRef)
        publicSources.push({
          sourceId: sourceRef,
          path: source.relPath,
          startLine: source.displayRange.startLine,
          endLine: source.displayRange.endLine,
          sourceHash: source.hash,
          sourceKind: source.sourceKind,
          text: normalizeText(sourceExcerpt(project, source))
        })
        privateSourceMap.set(sourceRef, { sourceId: sourceRef, ...descriptor, evidenceIds: [] })
      }
      for (const evidenceId of source.ids) {
        const prior = sourceRefByEvidence.get(evidenceId)
        if (prior && prior !== sourceRef) fail('source-binding-conflict')
        sourceRefByEvidence.set(evidenceId, sourceRef)
        const privateSource = privateSourceMap.get(sourceRef)
        if (!privateSource.evidenceIds.includes(evidenceId)) privateSource.evidenceIds.push(evidenceId)
      }
    }
  }

  const questionSets = []
  const privateQuestionSets = []
  const resultQuestionIds = new Set()
  const answerUnitIds = new Set()
  let mainQuestions = 0
  let answerUnits = 0
  for (const section of result.sections) {
    if (!isRecord(section) || !Array.isArray(section.questions)) fail('result-question-invalid')
    for (const question of section.questions) {
      if (!safeId(question.id) || resultQuestionIds.has(question.id)) fail('result-question-id-duplicate')
      resultQuestionIds.add(question.id)
      const fingerprint = fingerprintGenerationQuestion(question)
      const sidecarEntry = sidecarMap.get(question.id)
      if (!sidecarEntry || sidecarEntry.questionFingerprint !== fingerprint) fail('question-fingerprint-mismatch')
      const sourceRefs = [...new Set(sidecarEntry.evidenceIds.map(evidenceId => sourceRefByEvidence.get(evidenceId)))]
      if (sourceRefs.length === 0 || sourceRefs.some(value => !value)) fail('source-binding-invalid')
      const questionSetId = opaqueIdFactory('qset')
      const privateUnits = []
      const buildUnit = (value, pathParts, depth, kind, isMain = false) => {
        if (!safeText(value.question) || !safeText(value.answer) || depth > 8 || answerUnits >= 2048) fail('result-question-invalid')
        const answerUnitId = opaqueIdFactory('unit')
        if (answerUnitIds.has(answerUnitId)) fail('opaque-id-duplicate')
        answerUnitIds.add(answerUnitId)
        answerUnits++
        const unit = {
          answerUnitId,
          kind,
          depth,
          ...(isMain && typeof value.title === 'string' ? { title: normalizeText(value.title) } : {}),
          question: normalizeText(value.question),
          answer: normalizeText(value.answer),
          sourceIds: sourceRefs,
          followUps: []
        }
        privateUnits.push({ answerUnitId, questionId: question.id, path: pathParts, kind })
        if (isMain) walkQuestion(value, () => {}, [], 0, { count: 0 })
        const children = value.followUps ?? []
        if (!Array.isArray(children) || children.length > 32) fail('result-question-invalid')
        children.forEach((child, index) => unit.followUps.push(buildUnit(child, [...pathParts, index], depth + 1, 'followup')))
        return unit
      }
      const main = buildUnit(question, [], 0, 'main', true)
      questionSets.push({
        questionSetId,
        title: typeof question.title === 'string' ? normalizeText(question.title) : null,
        question: main.question,
        answer: main.answer,
        sourceIds: sourceRefs,
        answerUnitId: main.answerUnitId,
        followUps: main.followUps
      })
      privateQuestionSets.push({
        questionSetId,
        questionId: question.id,
        questionFingerprint: fingerprint,
        evidenceIds: [...sidecarEntry.evidenceIds],
        sourceRefs,
        answerUnits: privateUnits
      })
      mainQuestions++
    }
  }
  if (sidecarMap.size !== resultQuestionIds.size || [...sidecarMap.keys()].some(key => !resultQuestionIds.has(key))) fail('sidecar-question-coverage-invalid')
  if (mainQuestions === 0 || answerUnits > 2048) fail('answer-unit-count-invalid')

  const packetId = opaqueIdFactory('packet')
  const packetPayload = {
    schemaVersion: GENERATION_REVIEW_SCHEMA_VERSION,
    rubricVersion: 2,
    packetId,
    publicTask: { objective: normalizeText(task.objective), roleFocus: task.roleFocus, granularity: task.granularity, topic: normalizeText(task.topic) },
    sources: publicSources,
    questions: questionSets
  }
  if (containsForbiddenKey(packetPayload)) fail('blind-packet-private-field')
  const packet = freezeDeep({ ...packetPayload, packetSha256: hashJson(packetPayload) })
  if (Buffer.byteLength(canonicalJson(packet), 'utf8') > MAX_PACKET_BYTES) fail('blind-packet-too-large')
  const privatePacket = {
    packetId,
    packetSha256: packet.packetSha256,
    cellId: cell.id,
    taskId: cell.taskId,
    strategy: cell.strategy,
    repeat: cell.repeat,
    actualOrder: cell.actualOrder,
    questionSets: privateQuestionSets,
    sources: [...privateSourceMap.values()]
  }
  return { packet, privatePacket, answerUnits, mainQuestions }
}

function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => FORBIDDEN_PACKET_KEYS.has(key) || containsForbiddenKey(child))
}

export function buildBlindedReviewPackets({ bundle, cells, sourceBindings, rubricSha256, opaqueIdFactory = opaqueId }) {
  const projection = validateGenerationProjection(bundle)
  if (!projection.valid) fail('generation-projection-invalid')
  if (!Array.isArray(cells) || cells.length !== MAX_PACKETS || !isRecord(sourceBindings) || !HASH.test(rubricSha256 || '')) fail('generation-matrix-incomplete')
  const expectedCells = createGenerationMatrix(bundle)
  const expectedById = new Map(expectedCells.map(cell => [cell.id, cell]))
  const seen = new Set()
  const packets = []
  const privatePackets = []
  let answerUnits = 0
  let mainQuestions = 0
  let totalBytes = 0
  for (const [index, input] of cells.entries()) {
    if (!isRecord(input) || !isRecord(input.cell) || !expectedById.has(input.cell.id) || seen.has(input.cell.id)) fail('generation-matrix-invalid')
    const expected = expectedById.get(input.cell.id)
    if (input.cell.taskId !== expected.taskId || input.cell.strategy !== expected.strategy ||
      input.cell.repeat !== expected.repeat || input.cell.granularity !== expected.granularity ||
      input.cell.actualOrder !== index + 1) fail('generation-matrix-invalid')
    seen.add(input.cell.id)
    const built = buildCellPacket({ ...input, bundle, sourceBindings, opaqueIdFactory })
    packets.push(built.packet)
    privatePackets.push(built.privatePacket)
    answerUnits += built.answerUnits
    mainQuestions += built.mainQuestions
    totalBytes += Buffer.byteLength(canonicalJson(built.packet), 'utf8')
    if (totalBytes > MAX_PACKET_SET_BYTES) fail('blind-packet-set-too-large')
  }
  if (seen.size !== expectedById.size) fail('generation-matrix-incomplete')
  packets.sort((a, b) => a.packetId.localeCompare(b.packetId))
  privatePackets.sort((a, b) => a.packetId.localeCompare(b.packetId))
  const packetSetPayload = { schemaVersion: GENERATION_REVIEW_SCHEMA_VERSION, rubricVersion: 2, rubricSha256, protocol: GENERATION_REVIEW_PROTOCOL, packets }
  const packetSet = freezeDeep({ ...packetSetPayload, packetSetSha256: hashJson(packetSetPayload) })
  const privateMapPayload = { schemaVersion: GENERATION_REVIEW_SCHEMA_VERSION, packetSetSha256: packetSet.packetSetSha256, packets: privatePackets }
  const privateMap = freezeDeep({ ...privateMapPayload, privateMapSha256: hashJson(privateMapPayload) })
  return freezeDeep({ packetSet, privateMap, answerUnits, mainQuestions })
}

function replayOpaqueIdFactory(privateMap) {
  const queue = []
  const ordered = [...privateMap.packets].sort((left, right) => left.actualOrder - right.actualOrder)
  for (const item of ordered) {
    for (const source of item.sources) queue.push(source.sourceId)
    for (const question of item.questionSets) {
      queue.push(question.questionSetId)
      for (const unit of question.answerUnits) queue.push(unit.answerUnitId)
    }
    queue.push(item.packetId)
  }
  let cursor = 0
  return prefix => {
    const value = queue[cursor++]
    if (typeof value !== 'string' || !value.startsWith(prefix + '_')) fail('private-review-map-invalid')
    return value
  }
}

/** Independently rebuild the blinded packet and private mapping from execution artifacts. */
export function verifyBlindedReviewPackets({ bundle, cells, sourceBindings, rubricSha256, packetSet, privateMap }) {
  validateBlindedPacketSet(packetSet, privateMap)
  const rebuilt = buildBlindedReviewPackets({
    bundle,
    cells,
    sourceBindings,
    rubricSha256,
    opaqueIdFactory: replayOpaqueIdFactory(privateMap)
  })
  if (canonicalJson(rebuilt.packetSet) !== canonicalJson(packetSet) ||
    canonicalJson(rebuilt.privateMap) !== canonicalJson(privateMap)) fail('blind-packet-rebuild-mismatch')
  return {
    packetSetSha256: rebuilt.packetSet.packetSetSha256,
    privateMapSha256: rebuilt.privateMap.privateMapSha256,
    answerUnits: rebuilt.answerUnits,
    mainQuestions: rebuilt.mainQuestions
  }
}

function stripHash(value, key) {
  const copy = { ...value }
  delete copy[key]
  return copy
}

function collectPublicUnits(questionSets) {
  const result = new Map()
  const visit = (unit, pathParts, kind) => {
    if (!isRecord(unit) || !safeOpaqueId(unit.answerUnitId) || result.has(unit.answerUnitId) ||
      unit.kind !== kind || !Array.isArray(unit.followUps)) fail('blind-packet-unit-invalid')
    if (!Array.isArray(unit.sourceIds) || unit.sourceIds.length === 0 || unit.sourceIds.some(value => typeof value !== 'string')) fail('blind-packet-unit-invalid')
    result.set(unit.answerUnitId, { kind, path: pathParts, sourceIds: [...unit.sourceIds] })
    unit.followUps.forEach((child, index) => visit(child, [...pathParts, index], 'followup'))
  }
  for (const question of questionSets) {
    if (!isRecord(question) || !safeOpaqueId(question.questionSetId) || !Array.isArray(question.followUps) ||
      !Array.isArray(question.sourceIds) || question.sourceIds.length === 0) fail('blind-packet-question-invalid')
    const main = { answerUnitId: question.answerUnitId, kind: 'main', sourceIds: question.sourceIds, followUps: question.followUps }
    visit(main, [], 'main')
  }
  return result
}

export function validateBlindedPacketSet(packetSet, privateMap) {
  if (!exact(packetSet, ['schemaVersion', 'rubricVersion', 'rubricSha256', 'protocol', 'packets', 'packetSetSha256']) ||
    packetSet.schemaVersion !== GENERATION_REVIEW_SCHEMA_VERSION || packetSet.rubricVersion !== 2 ||
    !HASH.test(packetSet.rubricSha256 || '') ||
    packetSet.protocol !== GENERATION_REVIEW_PROTOCOL || !Array.isArray(packetSet.packets) ||
    packetSet.packets.length !== MAX_PACKETS || !HASH.test(packetSet.packetSetSha256 || '') ||
    hashJson(stripHash(packetSet, 'packetSetSha256')) !== packetSet.packetSetSha256) fail('blind-packet-set-invalid')
  if (!exact(privateMap, ['schemaVersion', 'packetSetSha256', 'packets', 'privateMapSha256']) ||
    privateMap.schemaVersion !== GENERATION_REVIEW_SCHEMA_VERSION ||
    privateMap.packetSetSha256 !== packetSet.packetSetSha256 || !Array.isArray(privateMap.packets) ||
    privateMap.packets.length !== packetSet.packets.length || !HASH.test(privateMap.privateMapSha256 || '') ||
    hashJson(stripHash(privateMap, 'privateMapSha256')) !== privateMap.privateMapSha256) fail('private-review-map-invalid')

  const packetById = new Map()
  const privateById = new Map()
  for (const packet of packetSet.packets) {
    if (!exact(packet, ['schemaVersion', 'rubricVersion', 'packetId', 'publicTask', 'sources', 'questions', 'packetSha256']) ||
      packet.schemaVersion !== GENERATION_REVIEW_SCHEMA_VERSION || packet.rubricVersion !== 2 ||
      !safeOpaqueId(packet.packetId) || !HASH.test(packet.packetSha256 || '') || !Array.isArray(packet.sources) ||
      !Array.isArray(packet.questions) || packetById.has(packet.packetId) ||
      hashJson(stripHash(packet, 'packetSha256')) !== packet.packetSha256 || containsForbiddenKey(packet)) fail('blind-packet-invalid')
    if (!exact(packet.publicTask, ['objective', 'roleFocus', 'granularity', 'topic']) ||
      !safeText(packet.publicTask.objective) || !['general', 'frontend', 'backend', 'algorithm'].includes(packet.publicTask.roleFocus) ||
      !['medium', 'fine'].includes(packet.publicTask.granularity) || !safeText(packet.publicTask.topic)) fail('blind-packet-task-invalid')
    const sourceIds = new Set()
    for (const source of packet.sources) {
      if (!exact(source, ['sourceId', 'path', 'startLine', 'endLine', 'sourceHash', 'sourceKind', 'text']) ||
        !safeOpaqueId(source.sourceId) || sourceIds.has(source.sourceId) || !safePath(source.path) ||
        !Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine) ||
        source.startLine < 1 || source.endLine < source.startLine || !HASH.test(source.sourceHash || '') ||
        !['code', 'documentation', 'configuration', 'other'].includes(source.sourceKind) || !safeText(source.text)) fail('blind-packet-source-invalid')
      if (hash(source.text) !== source.sourceHash) fail('blind-packet-source-hash-invalid')
      sourceIds.add(source.sourceId)
    }
    for (const question of packet.questions) {
      if (!exact(question, ['questionSetId', 'title', 'question', 'answer', 'sourceIds', 'answerUnitId', 'followUps']) ||
        !safeOpaqueId(question.questionSetId) || (question.title !== null && !safeText(question.title)) ||
        !safeText(question.question) || !safeText(question.answer) ||
        !Array.isArray(question.sourceIds) || question.sourceIds.length === 0 ||
        question.sourceIds.some(value => !sourceIds.has(value)) || !safeOpaqueId(question.answerUnitId) ||
        !Array.isArray(question.followUps)) fail('blind-packet-question-invalid')
      for (const child of question.followUps) {
        const checkChildren = (node, depth) => {
          if (depth > 8 || !exact(node, ['answerUnitId', 'kind', 'depth', 'question', 'answer', 'sourceIds', 'followUps']) ||
            !safeOpaqueId(node.answerUnitId) || node.kind !== 'followup' || node.depth !== depth ||
            !safeText(node.question) || !safeText(node.answer) || !Array.isArray(node.sourceIds) ||
            node.sourceIds.some(value => !sourceIds.has(value)) || !Array.isArray(node.followUps)) fail('blind-packet-followup-invalid')
          node.followUps.forEach(childNode => checkChildren(childNode, depth + 1))
        }
        checkChildren(child, 1)
      }
    }
    collectPublicUnits(packet.questions)
    packetById.set(packet.packetId, packet)
  }
  for (const item of privateMap.packets) {
    if (!exact(item, ['packetId', 'packetSha256', 'cellId', 'taskId', 'strategy', 'repeat', 'actualOrder', 'questionSets', 'sources']) ||
      !safeOpaqueId(item.packetId) || privateById.has(item.packetId) || !HASH.test(item.packetSha256 || '') ||
      !safeText(item.cellId, 512) || !safeText(item.taskId, 512) || !['agentic', 'static-control'].includes(item.strategy) ||
      !Number.isInteger(item.repeat) || !Number.isInteger(item.actualOrder) ||
      !Array.isArray(item.questionSets) || !Array.isArray(item.sources)) fail('private-review-map-invalid')
    const packet = packetById.get(item.packetId)
    if (!packet || packet.packetSha256 !== item.packetSha256) fail('private-review-map-invalid')
    const publicQuestions = new Map(packet.questions.map(value => [value.questionSetId, value]))
    if (item.questionSets.length !== publicQuestions.size) fail('private-question-map-invalid')
    const privateQuestionIds = new Set()
    const privateResultQuestionIds = new Set()
    for (const question of item.questionSets) {
      if (!exact(question, ['questionSetId', 'questionId', 'questionFingerprint', 'evidenceIds', 'sourceRefs', 'answerUnits']) ||
        !publicQuestions.has(question.questionSetId) || privateQuestionIds.has(question.questionSetId) ||
        !safeOpaqueId(question.questionSetId) || !safeId(question.questionId) || privateResultQuestionIds.has(question.questionId) || !HASH.test(question.questionFingerprint || '') ||
        !Array.isArray(question.evidenceIds) || question.evidenceIds.length === 0 ||
        question.evidenceIds.some(value => !EVIDENCE_ID.test(value)) || !Array.isArray(question.sourceRefs) ||
        !Array.isArray(question.answerUnits)) fail('private-question-map-invalid')
      privateQuestionIds.add(question.questionSetId)
      privateResultQuestionIds.add(question.questionId)
      const publicQuestion = publicQuestions.get(question.questionSetId)
      if (canonicalJson(question.sourceRefs) !== canonicalJson(publicQuestion.sourceIds)) fail('private-citation-map-invalid')
      const publicUnits = collectPublicUnits([publicQuestion])
      if (question.answerUnits.length !== publicUnits.size) fail('private-answer-map-invalid')
      const privateUnits = new Set()
      for (const unit of question.answerUnits) {
        if (!exact(unit, ['answerUnitId', 'questionId', 'path', 'kind']) || !safeOpaqueId(unit.answerUnitId) ||
          unit.questionId !== question.questionId || !Array.isArray(unit.path) ||
          unit.path.some(index => !Number.isSafeInteger(index) || index < 0) ||
          !['main', 'followup'].includes(unit.kind) || privateUnits.has(unit.answerUnitId)) fail('private-answer-map-invalid')
        const publicUnit = publicUnits.get(unit.answerUnitId)
        if (!publicUnit || publicUnit.kind !== unit.kind || canonicalJson(publicUnit.path) !== canonicalJson(unit.path)) fail('private-answer-map-invalid')
        privateUnits.add(unit.answerUnitId)
      }
    }
    const publicSources = new Map(packet.sources.map(value => [value.sourceId, value]))
    const privateSourceIds = new Set()
    const privateEvidenceIds = new Set()
    const privateEvidenceSource = new Map()
    for (const source of item.sources) {
      if (!exact(source, ['sourceId', 'path', 'displayRange', 'originalRange', 'hash', 'sourceKind', 'evidenceIds']) ||
        !safeOpaqueId(source.sourceId) || !publicSources.has(source.sourceId) || privateSourceIds.has(source.sourceId) || !safePath(source.path) ||
        !validRange(source.displayRange) || !(source.originalRange === null || validRange(source.originalRange)) ||
        !HASH.test(source.hash || '') || !Array.isArray(source.evidenceIds) ||
        source.evidenceIds.some(value => !EVIDENCE_ID.test(value) || privateEvidenceIds.has(value))) fail('private-source-map-invalid')
      const publicSource = publicSources.get(source.sourceId)
      if (publicSource.path !== source.path || publicSource.startLine !== source.displayRange.startLine ||
        publicSource.endLine !== source.displayRange.endLine || publicSource.sourceHash !== source.hash ||
        publicSource.sourceKind !== source.sourceKind) fail('private-source-map-invalid')
      privateSourceIds.add(source.sourceId)
      source.evidenceIds.forEach(value => {
        privateEvidenceIds.add(value)
        privateEvidenceSource.set(value, source.sourceId)
      })
    }
    if (privateSourceIds.size !== publicSources.size) fail('private-source-map-invalid')
    for (const question of item.questionSets) if (question.evidenceIds.some(value => !privateEvidenceIds.has(value) || !question.sourceRefs.includes(privateEvidenceSource.get(value)))) fail('private-citation-map-invalid')
    privateById.set(item.packetId, item)
  }
  if (packetById.size !== privateById.size || [...packetById.keys()].some(key => !privateById.has(key))) fail('private-review-map-invalid')
  const packetBytes = Buffer.byteLength(canonicalJson(packetSet), 'utf8')
  const privateBytes = Buffer.byteLength(canonicalJson(privateMap), 'utf8')
  if (packetBytes > MAX_PACKET_SET_BYTES || privateBytes > 16 * 1024 * 1024) fail('blind-artifact-too-large')
  return { packetById, privateById, packetSetSha256: packetSet.packetSetSha256, privateMapSha256: privateMap.privateMapSha256 }
}

function validateReason(value) {
  return typeof value === 'string' && value.trim().length >= 10 && value.length <= MAX_REVIEW_REASON_CHARS
}

function validateAnswerGrade(grade, unit, packet) {
  if (!exact(grade, ['answerUnitId', 'materialError', 'errorCategories', 'reason', 'sourceSupport']) ||
    grade.answerUnitId !== unit.answerUnitId ||
    !(typeof grade.materialError === 'boolean' || grade.materialError === 'unknown') ||
    grade.materialError === 'unknown' || !Array.isArray(grade.errorCategories) ||
    !validateReason(grade.reason) || !Array.isArray(grade.sourceSupport) ||
    grade.sourceSupport.length < 1 || grade.sourceSupport.length > MAX_SOURCE_REFS_PER_ANSWER) fail('review-answer-grade-invalid')
  const categories = grade.errorCategories
  if (categories.some(value => !GENERATION_MATERIAL_ERROR_CATEGORIES.includes(value)) ||
    new Set(categories).size !== categories.length ||
    grade.materialError && categories.length === 0 ||
    !grade.materialError && categories.length !== 0) fail('review-answer-category-invalid')
  const sources = new Map(packet.sources.map(source => [source.sourceId, source]))
  const allowedSources = new Set(unit.sourceIds)
  const supportIds = new Set()
  for (const support of grade.sourceSupport) {
    if (!exact(support, ['sourceId', 'path', 'startLine', 'endLine', 'sha256']) ||
      !safeOpaqueId(support.sourceId) || !allowedSources.has(support.sourceId) || supportIds.has(support.sourceId) ||
      !safePath(support.path) || !Number.isSafeInteger(support.startLine) || !Number.isSafeInteger(support.endLine) ||
      support.startLine < 1 || support.endLine < support.startLine || !HASH.test(support.sha256 || '')) fail('review-source-support-invalid')
    const source = sources.get(support.sourceId)
    if (!source || support.path !== source.path || support.startLine !== source.startLine ||
      support.endLine !== source.endLine || support.sha256 !== source.sourceHash) fail('review-source-support-invalid')
    supportIds.add(support.sourceId)
  }
  return {
    answerUnitId: grade.answerUnitId,
    materialError: grade.materialError,
    errorCategories: [...categories].sort(),
    sourceSupport: [...supportIds].sort()
  }
}

function validateScores(value) {
  if (!exact(value, GENERATION_REVIEW_DIMENSIONS)) fail('review-topic-score-invalid')
  const output = {}
  for (const dimension of GENERATION_REVIEW_DIMENSIONS) {
    if (!Number.isInteger(value[dimension]) || value[dimension] < 1 || value[dimension] > 5) fail('review-topic-score-invalid')
    output[dimension] = value[dimension]
  }
  return output
}

function validateReviewerRecord(reviewer, role, packetSet, invocation, outputHash) {
  if (!exact(reviewer, ['schemaVersion', 'protocol', 'rubricSha256', 'reviewerId', 'agentIdentity', 'packetSetSha256', 'packets']) ||
    reviewer.schemaVersion !== GENERATION_REVIEW_SCHEMA_VERSION || reviewer.protocol !== GENERATION_REVIEW_PROTOCOL ||
    reviewer.rubricSha256 !== packetSet.rubricSha256 ||
    reviewer.reviewerId !== role || !safeText(reviewer.agentIdentity, 200) ||
    reviewer.packetSetSha256 !== packetSet.packetSetSha256 || !Array.isArray(reviewer.packets) ||
    reviewer.packets.length !== packetSet.packets.length) fail('reviewer-record-invalid')
  if (invocation !== null && (!invocation || invocation.role !== role || invocation.agentIdentity !== reviewer.agentIdentity ||
    invocation.inputPacketSha256 !== packetSet.packetSetSha256 || invocation.outputSha256 !== outputHash ||
    invocation.outputFile !== REVIEWER_OUTPUTS[role])) fail('reviewer-invocation-binding-invalid')
  const packetInput = new Map(packetSet.packets.map(packet => [packet.packetId, packet]))
  const records = new Map()
  for (const row of reviewer.packets) {
    if (!exact(row, ['packetId', 'packetSha256', 'answers', 'topicValues']) ||
      !safeOpaqueId(row.packetId) || records.has(row.packetId) || !HASH.test(row.packetSha256 || '') ||
      !Array.isArray(row.answers) || !Array.isArray(row.topicValues)) fail('reviewer-packet-record-invalid')
    const packet = packetInput.get(row.packetId)
    if (!packet || packet.packetSha256 !== row.packetSha256) fail('reviewer-packet-hash-invalid')
    const units = collectPublicUnits(packet.questions)
    if (row.answers.length !== units.size) fail('review-answer-coverage-invalid')
    const answers = new Map()
    for (const grade of row.answers) {
      const unit = units.get(grade?.answerUnitId)
      if (!unit || answers.has(grade.answerUnitId)) fail('review-answer-coverage-invalid')
      answers.set(grade.answerUnitId, validateAnswerGrade(grade, { answerUnitId: grade.answerUnitId, sourceIds: unit.sourceIds }, packet))
    }
    if (answers.size !== units.size || [...units.keys()].some(key => !answers.has(key))) fail('review-answer-coverage-invalid')
    const mainQuestions = new Set(packet.questions.map(question => question.questionSetId))
    if (row.topicValues.length !== mainQuestions.size) fail('review-topic-coverage-invalid')
    const topicValues = new Map()
    for (const value of row.topicValues) {
      if (!exact(value, ['questionSetId', 'scores', 'reason']) || !mainQuestions.has(value.questionSetId) ||
        topicValues.has(value.questionSetId) || !validateReason(value.reason)) fail('review-topic-coverage-invalid')
      topicValues.set(value.questionSetId, validateScores(value.scores))
    }
    if (topicValues.size !== mainQuestions.size || [...mainQuestions].some(key => !topicValues.has(key))) fail('review-topic-coverage-invalid')
    records.set(row.packetId, { answers, topicValues })
  }
  if (records.size !== packetInput.size || [...packetInput.keys()].some(key => !records.has(key))) fail('review-packet-coverage-invalid')
  return records
}

export function deriveReviewDisagreements({ packetSet, privateMap, reviewerA, reviewerB }) {
  validateBlindedPacketSet(packetSet, privateMap)
  const a = validateReviewerRecord(reviewerA, 'A', packetSet, null, null)
  const b = validateReviewerRecord(reviewerB, 'B', packetSet, null, null)
  if (reviewerA.agentIdentity === reviewerB.agentIdentity) fail('reviewers-not-independent')
  const disagreements = answerDisagreements(packetSet, a, b)
  return freezeDeep({
    packetSetSha256: packetSet.packetSetSha256,
    inputPacketSha256: adjudicationInputSha256(packetSet.packetSetSha256, disagreements),
    disagreements
  })
}

function validateInvocation(item, role, packetHash, rubricSha256, outputHash, expectedFile) {
  if (!exact(item, ['role', 'agentIdentity', 'taskName', 'invocationId', 'tool', 'model', 'forkTurns', 'rubricSha256', 'inputPacketSha256', 'outputFile', 'outputSha256', 'serviceUsage']) ||
    item.role !== role || !safeText(item.agentIdentity, 200) || !safeText(item.taskName, 200) ||
    !safeText(item.invocationId, 200) || item.tool !== 'collaboration.spawn_agent' ||
    item.model !== 'gpt-6-luna' || item.forkTurns !== 'none' ||
    item.rubricSha256 !== rubricSha256 ||
    item.inputPacketSha256 !== packetHash || item.outputFile !== expectedFile ||
    !HASH.test(item.outputSha256 || '') || item.outputSha256 !== outputHash ||
    !exact(item.serviceUsage, ['status']) || item.serviceUsage.status !== 'unknown') fail('review-invocation-invalid')
}

function answerDisagreements(packetSet, reviewA, reviewB) {
  const disagreements = []
  for (const packet of packetSet.packets) {
    const a = reviewA.get(packet.packetId)
    const b = reviewB.get(packet.packetId)
    for (const unit of collectPublicUnits(packet.questions).keys()) {
      const left = a.answers.get(unit)
      const right = b.answers.get(unit)
      if (left.materialError !== right.materialError ||
        canonicalJson(left.errorCategories) !== canonicalJson(right.errorCategories)) {
        disagreements.push({ kind: 'answer', packetId: packet.packetId, answerUnitId: unit,
          a: { materialError: left.materialError, errorCategories: left.errorCategories },
          b: { materialError: right.materialError, errorCategories: right.errorCategories } })
      }
    }
    for (const question of packet.questions) {
      const left = a.topicValues.get(question.questionSetId)
      const right = b.topicValues.get(question.questionSetId)
      if (GENERATION_REVIEW_DIMENSIONS.some(key => left[key] !== right[key])) {
        disagreements.push({ kind: 'topic-value', packetId: packet.packetId, questionSetId: question.questionSetId, a: left, b: right })
      }
    }
  }
  return disagreements.sort((left, right) => left.packetId.localeCompare(right.packetId) ||
    left.kind.localeCompare(right.kind) || (left.answerUnitId || left.questionSetId).localeCompare(right.answerUnitId || right.questionSetId))
}

export function adjudicationInputSha256(packetSetSha256, disagreements) {
  return hashJson({ protocol: GENERATION_REVIEW_PROTOCOL, packetSetSha256, disagreements })
}

function resolutionKey(value) {
  return value.kind === 'answer'
    ? 'answer:' + value.packetId + ':' + value.answerUnitId
    : value.kind === 'topic-value'
      ? 'topic-value:' + value.packetId + ':' + value.questionSetId
      : ''
}

function validateAdjudication({ adjudication, disagreements, packetSet }) {
  const inputHash = adjudicationInputSha256(packetSet.packetSetSha256, disagreements)
  if (!exact(adjudication, ['schemaVersion', 'protocol', 'rubricSha256', 'packetSetSha256', 'inputPacketSha256', 'resolutions']) ||
    adjudication.schemaVersion !== GENERATION_REVIEW_SCHEMA_VERSION || adjudication.protocol !== GENERATION_REVIEW_PROTOCOL ||
    adjudication.rubricSha256 !== packetSet.rubricSha256 ||
    adjudication.packetSetSha256 !== packetSet.packetSetSha256 || adjudication.inputPacketSha256 !== inputHash ||
    !Array.isArray(adjudication.resolutions)) fail('adjudication-record-invalid')
  if (disagreements.length === 0) {
    if (adjudication.resolutions.length !== 0) fail('unexpected-adjudication')
    return new Map()
  }
  if (adjudication.resolutions.length !== disagreements.length) fail('adjudication-incomplete')
  const expected = new Map(disagreements.map(item => [resolutionKey(item), item]))
  const resolutions = new Map()
  for (const resolution of adjudication.resolutions) {
    const key = resolutionKey(resolution)
    const expectedDisagreement = expected.get(key)
    if (!expectedDisagreement || resolutions.has(key) || !validateReason(resolution.reason)) fail('adjudication-resolution-invalid')
    if (resolution.kind === 'answer') {
      if (!exact(resolution, ['kind', 'packetId', 'answerUnitId', 'materialError', 'errorCategories', 'sourceSupport', 'reason'])) fail('adjudication-resolution-invalid')
      const packet = packetSet.packets.find(value => value.packetId === resolution.packetId)
      const units = collectPublicUnits(packet.questions)
      const unit = units.get(resolution.answerUnitId)
      const grade = validateAnswerGrade({
        answerUnitId: resolution.answerUnitId,
        materialError: resolution.materialError,
        errorCategories: resolution.errorCategories,
        sourceSupport: resolution.sourceSupport,
        reason: resolution.reason
      }, { answerUnitId: resolution.answerUnitId, sourceIds: unit.sourceIds }, packet)
      resolutions.set(key, grade)
    } else {
      const scores = validateScores(resolution.scores)
      if (!exact(resolution, ['kind', 'packetId', 'questionSetId', 'scores', 'reason'])) fail('adjudication-resolution-invalid')
      resolutions.set(key, scores)
    }
  }
  if (resolutions.size !== expected.size || [...expected.keys()].some(key => !resolutions.has(key))) fail('adjudication-incomplete')
  return resolutions
}

function validateInvocationBundle(invocations, packetSet, privateMap, reviewerA, reviewerB, disagreements, outputHashes) {
  if (!exact(invocations, ['schemaVersion', 'protocol', 'rubricSha256', 'packetSetSha256', 'privateMapSha256', 'reviewers', 'adjudicator']) ||
    invocations.schemaVersion !== GENERATION_REVIEW_SCHEMA_VERSION || invocations.protocol !== GENERATION_REVIEW_PROTOCOL ||
    invocations.rubricSha256 !== packetSet.rubricSha256 ||
    invocations.packetSetSha256 !== packetSet.packetSetSha256 || invocations.privateMapSha256 !== privateMap.privateMapSha256 ||
    !Array.isArray(invocations.reviewers) || invocations.reviewers.length !== 2 ||
    !isRecord(outputHashes) || !HASH.test(outputHashes.reviewerA || '') || !HASH.test(outputHashes.reviewerB || '') ||
    !HASH.test(outputHashes.adjudication || '') || invocations.reviewers.some(item => !isRecord(item))) fail('review-invocation-bundle-invalid')
  const records = new Map(invocations.reviewers.map(item => [item.role, item]))
  if (records.size !== 2 || !records.has('A') || !records.has('B')) fail('review-invocation-bundle-invalid')
  validateInvocation(records.get('A'), 'A', packetSet.packetSetSha256, packetSet.rubricSha256, outputHashes.reviewerA, GENERATION_REVIEW_FILES.reviewerA)
  validateInvocation(records.get('B'), 'B', packetSet.packetSetSha256, packetSet.rubricSha256, outputHashes.reviewerB, GENERATION_REVIEW_FILES.reviewerB)
  if (records.get('A').agentIdentity === records.get('B').agentIdentity ||
    records.get('A').taskName === records.get('B').taskName ||
    records.get('A').invocationId === records.get('B').invocationId) fail('reviewers-not-independent')
  if (disagreements.length === 0) {
    if (invocations.adjudicator !== null) fail('unexpected-adjudication')
  } else {
    validateInvocation(invocations.adjudicator, 'adjudicator',
      adjudicationInputSha256(packetSet.packetSetSha256, disagreements),
      packetSet.rubricSha256,
      outputHashes.adjudication,
      GENERATION_REVIEW_FILES.adjudication)
    const identities = [records.get('A'), records.get('B')]
    if (identities.some(item => item.agentIdentity === invocations.adjudicator.agentIdentity ||
      item.taskName === invocations.adjudicator.taskName || item.invocationId === invocations.adjudicator.invocationId)) fail('adjudicator-not-independent')
  }
  return records
}

function finalResults(packetSet, reviewerA, disagreements, adjudicated) {
  const disputed = new Map(disagreements.map(item => [resolutionKey(item), item]))
  const answers = new Map()
  const topics = new Map()
  for (const packet of packetSet.packets) {
    const a = reviewerA.get(packet.packetId)
    for (const unitId of collectPublicUnits(packet.questions).keys()) {
      const key = 'answer:' + packet.packetId + ':' + unitId
      answers.set(packet.packetId + ':' + unitId, adjudicated.get(key) ?? a.answers.get(unitId))
    }
    for (const question of packet.questions) {
      const key = 'topic-value:' + packet.packetId + ':' + question.questionSetId
      topics.set(packet.packetId + ':' + question.questionSetId, adjudicated.get(key) ?? a.topicValues.get(question.questionSetId))
    }
  }
  return { answers, topics, disputed }
}

function emptyStrategyStats() {
  return { answerUnits: 0, materialErrors: 0, categoryCounts: Object.create(null), topicScoreTotal: 0, topicScoreCount: 0 }
}

function addFinalStats(stats, packetSet, privateMap, finals) {
  const privateById = new Map(privateMap.packets.map(item => [item.packetId, item]))
  const result = { agentic: emptyStrategyStats(), 'static-control': emptyStrategyStats() }
  for (const packet of packetSet.packets) {
    const strategy = privateById.get(packet.packetId)?.strategy
    const target = result[strategy]
    if (!target) fail('strategy-mapping-invalid')
    const units = collectPublicUnits(packet.questions)
    for (const unitId of units.keys()) {
      const grade = finals.answers.get(packet.packetId + ':' + unitId)
      if (!grade) fail('review-answer-coverage-invalid')
      target.answerUnits++
      if (grade.materialError) {
        target.materialErrors++
        for (const category of grade.errorCategories) target.categoryCounts[category] = (target.categoryCounts[category] || 0) + 1
      }
    }
    for (const question of packet.questions) {
      const scores = finals.topics.get(packet.packetId + ':' + question.questionSetId)
      if (!scores) fail('review-topic-coverage-invalid')
      for (const dimension of GENERATION_REVIEW_DIMENSIONS) {
        target.topicScoreTotal += scores[dimension]
        target.topicScoreCount++
      }
    }
  }
  return result
}

export function validateGenerationReviewBundle({ packetSet, privateMap, reviewerA, reviewerB, adjudication, invocations, outputHashes, usageComplete }) {
  const { packetSetSha256 } = validateBlindedPacketSet(packetSet, privateMap)
  if (usageComplete !== true) fail('execution-usage-incomplete')
  if (!isRecord(invocations) || !Array.isArray(invocations.reviewers)) fail('review-invocation-bundle-invalid')
  const reviewersA = validateReviewerRecord(reviewerA, 'A', packetSet, invocations.reviewers.find(item => item?.role === 'A'), outputHashes?.reviewerA)
  const reviewersB = validateReviewerRecord(reviewerB, 'B', packetSet, invocations.reviewers.find(item => item?.role === 'B'), outputHashes?.reviewerB)
  const disagreements = answerDisagreements(packetSet, reviewersA, reviewersB)
  const adjudicated = validateAdjudication({ adjudication, disagreements, packetSet })
  validateInvocationBundle(invocations, packetSet, privateMap, reviewersA, reviewersB, disagreements, outputHashes)
  const finals = finalResults(packetSet, reviewersA, disagreements, adjudicated)
  const stats = addFinalStats(null, packetSet, privateMap, finals)
  const candidate = stats.agentic
  const control = stats['static-control']
  if (candidate.answerUnits === 0 || control.answerUnits === 0 || candidate.topicScoreCount === 0 || control.topicScoreCount === 0) fail('review-metric-denominator-empty')
  return freezeDeep({
    packetSetSha256,
    privateMapSha256: privateMap.privateMapSha256,
    disagreements: disagreements.length,
    answerUnits: candidate.answerUnits + control.answerUnits,
    mainQuestions: candidate.topicScoreCount / GENERATION_REVIEW_DIMENSIONS.length + control.topicScoreCount / GENERATION_REVIEW_DIMENSIONS.length,
    categoryCounts: {
      agentic: candidate.categoryCounts,
      'static-control': control.categoryCounts
    },
    metrics: {
      unpackedEvidenceCited: 0,
      materialErrorRate: candidate.materialErrors / candidate.answerUnits,
      staticControlMaterialErrorRate: control.materialErrors / control.answerUnits,
      topicValueMean: candidate.topicScoreTotal / candidate.topicScoreCount,
      staticControlTopicValueMean: control.topicScoreTotal / control.topicScoreCount,
      usageComplete: true
    }
  })
}

/** Structural grade analysis for synthetic tests; this does not assert any real review invocation. */
export function analyzeSyntheticReviewGrades({ packetSet, privateMap, reviewerA, reviewerB, adjudication }) {
  validateBlindedPacketSet(packetSet, privateMap)
  const a = validateReviewerRecord(reviewerA, 'A', packetSet, null, null)
  const b = validateReviewerRecord(reviewerB, 'B', packetSet, null, null)
  if (reviewerA.agentIdentity === reviewerB.agentIdentity) fail('reviewers-not-independent')
  const disagreements = answerDisagreements(packetSet, a, b)
  const adjudicated = validateAdjudication({ adjudication, disagreements, packetSet })
  const finals = finalResults(packetSet, a, disagreements, adjudicated)
  const stats = addFinalStats(null, packetSet, privateMap, finals)
  const candidate = stats.agentic
  const control = stats['static-control']
  if (candidate.answerUnits === 0 || control.answerUnits === 0 || candidate.topicScoreCount === 0 || control.topicScoreCount === 0) fail('review-metric-denominator-empty')
  return freezeDeep({
    disagreements: disagreements.length,
    answerUnits: candidate.answerUnits + control.answerUnits,
    mainQuestions: candidate.topicScoreCount / GENERATION_REVIEW_DIMENSIONS.length + control.topicScoreCount / GENERATION_REVIEW_DIMENSIONS.length,
    categoryCounts: { agentic: candidate.categoryCounts, 'static-control': control.categoryCounts },
    metrics: {
      unpackedEvidenceCited: 0,
      materialErrorRate: candidate.materialErrors / candidate.answerUnits,
      staticControlMaterialErrorRate: control.materialErrors / control.answerUnits,
      topicValueMean: candidate.topicScoreTotal / candidate.topicScoreCount,
      staticControlTopicValueMean: control.topicScoreTotal / control.topicScoreCount
    }
  })
}
