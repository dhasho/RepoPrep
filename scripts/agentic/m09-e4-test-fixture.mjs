import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, lstat, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRootSupervisedM09NativeBridge } from './m09-native-collaboration.mjs'
import { createSyntheticM09QualityDriver } from './m09-quality-host.mjs'
import { SEMANTIC_JUDGMENT_PROTOCOL, semanticJsonBytes, semanticSha256, semanticAnswerPaths } from './semantic-review.mjs'

export const copy = value => structuredClone(value)
export const executionBytes = Buffer.from('OFFLINE SYNTHETIC M09 E4 freeze; no native/provider execution')
let serial = 0
export function documents() {
  const reviews = Array.from({ length: 80 }, (_, index) => ({ unitId: `review-${index}`, sampleId: `review-sample-${index}`, assessment: index < 40 ? 'material-risk' : 'no-material-risk' }))
  const repairs = Array.from({ length: 20 }, (_, index) => {
    const before = { question: { question: `Which value does synthetic operation ${index} return?`, answer: 'Broken claim.', followUps: [{ question: 'Which branch?', answer: 'The guarded branch.' }] }, glossary: { branch: 'Conditional path.' } }
    const after = copy(before); after.question.answer = `Returns synthetic value ${index}.`
    const text = `export const result = ${index}`
    return { unitId: `repair-${index}`, sampleId: `repair-sample-${index}`, status: 'applied', before, after, sources: [{ path: `src/synthetic-${index}.js`, startLine: 1, endLine: 1, sha256: semanticSha256(text), text }] }
  })
  const projection = { schemaVersion: 1, executionHash: semanticSha256(executionBytes), publicDataHash: semanticSha256('offline synthetic public'), reviews, repairs }
  const reviewKey = { schemaVersion: 1, labels: reviews.map(({ sampleId }, index) => ({ sampleId, materialError: index < 40, errors: index < 40 ? [{ claim: 'Wrong synthetic claim.', explanation: 'Contradicted by the synthetic source.' }] : [], facts: ['Synthetic fact.'] })) }
  const repairKey = { schemaVersion: 1, labels: repairs.map(({ sampleId }) => ({ sampleId, expectedRepairFacts: ['Synthetic repair.'], errorExplanation: 'Original synthetic error.' })) }
  return { projection, reviewKey, repairKey }
}
export function syntheticJudgment(inputBytes, adjudication = false) {
  const input = JSON.parse(Buffer.from(inputBytes).toString('utf8'))
  return { protocol: SEMANTIC_JUDGMENT_PROTOCOL, packets: input.publicPackets.packets.map(packet => {
    const side = ['U', 'V'].find(name => packet.sides[name].question.answer === 'Broken claim.')
    const witness = [{ sourceId: packet.sources[0].sourceId, startLine: 1, endLine: 1 }]
    const issue = { issueId: 'synthetic-issue', sides: side, members: [{ side, path: 'answer' }], witnesses: witness, explanation: 'The supplied synthetic source contradicts this answer.' }
    const item = { packetId: packet.packetId,
      paths: ['U', 'V'].flatMap(name => semanticAnswerPaths(packet.sides[name]).map(answerPath => ({ side: name, path: answerPath, assessment: name === side && answerPath === 'answer' ? 'material' : 'clear', issueIds: name === side && answerPath === 'answer' ? [issue.issueId] : [] }))),
      issues: [issue], scope: { assessment: 'equivalent', witnesses: witness, explanation: 'Same bounded question.' }, usefulness: { U: { assessment: 'useful', witnesses: witness, explanation: 'Concrete source context.' }, V: { assessment: 'useful', witnesses: witness, explanation: 'Concrete source context.' } } }
    if (adjudication) item.resolution = { state: 'resolved', reviewerA: 'accepted', reviewerB: 'accepted', explanation: 'Independently checked all paths and source witnesses.' }
    return item
  }) }
}
export async function temporaryRoot(t) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'repoprep-m09-e4-offline-'))
  const original = await lstat(root)
  t.after(async () => {
    const actual = await lstat(root)
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith('repoprep-m09-e4-offline-'))
    assert.equal(actual.isSymbolicLink(), false)
    assert.equal(actual.ino, original.ino)
    await rm(root, { recursive: true })
  })
  return root
}
export async function fixture(t, { writeKeys = true, reverify, execute, afterPrivateScore, syntheticGate, keyCRLF = false, normalizedHashMismatch = false } = {}) {
  const root = await temporaryRoot(t); const data = documents(); const external = createRootSupervisedM09NativeBridge()
  const privateKeyBindings = { rootDir: root }
  const keyBytes = {}; const normalizedPrivateKeyHashes = {}
  for (const [key, filename] of [['reviewKey', 'review-key.json'], ['repairKey', 'repair-key.json']]) {
    const bytes = keyCRLF ? Buffer.from(JSON.stringify(data[key], null, 2).replaceAll('\n', '\r\n') + '\r\n') : semanticJsonBytes(data[key])
    keyBytes[key] = bytes; normalizedPrivateKeyHashes[key] = semanticSha256(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')))
    privateKeyBindings[key] = { path: filename, byteLength: bytes.length, sha256: semanticSha256(bytes) }
  }
  if (normalizedHashMismatch) normalizedPrivateKeyHashes.reviewKey = semanticSha256('wrong normalized binding')
  const writePrivateKeys = async () => { for (const key of ['reviewKey', 'repairKey']) await writeFile(path.join(root, privateKeyBindings[key].path), keyBytes[key]) }
  if (writeKeys) await writePrivateKeys()
  const verified = { projection: data.projection, execution: { mode: 'synthetic', executionComplete: true, cases: 100, quality: 'not-evaluated', executionHash: data.projection.executionHash, publicDataHash: data.projection.publicDataHash }, budget: { compliant: true, cases: 100, reviews: 80, repairs: 20, accounting: { unknownRequests: 0 } } }
  const driver = createSyntheticM09QualityDriver({ nativeBridge: external.bridge, privateKeyBindings, afterPrivateScore, syntheticGate, normalizedPrivateKeyHashes,
    execute: execute ?? (async () => ({ executionBytes: Buffer.from(executionBytes), ...copy(verified) })),
    reverify: reverify ?? (async bytes => { assert.deepEqual(bytes, executionBytes); return copy(verified) }) })
  const complete = (request, { rawFinal, suffix = '\n \t' } = {}) => {
    const task_name = `/root/offline_e4_${++serial}_${request.role}`
    const inputBytes = request.inputBytes
    external.observeSpawn(request, { task_name, model: 'gpt-6.1-sol', fork_turns: 'none', inputBytes })
    const final = rawFinal ?? semanticJsonBytes(syntheticJudgment(inputBytes, request.role === 'adjudicator')).toString('utf8') + suffix
    const receipt = external.observeCompletion(request, { task_name, model: 'gpt-6.1-sol', fork_turns: 'none', inputBytes, status: 'completed', rawFinal: final, finalBytes: Buffer.from(final, 'utf8') })
    return { receipt, rawFinal: final, inputBytes }
  }
  const throughJudgments = async () => {
    await driver.execute(); const ab = external.pendingRequests(); const a = complete(ab.find(item => item.role === 'A')); const b = complete(ab.find(item => item.role === 'B'))
    await driver.adjudicate(); const adjudicator = complete(external.pendingRequests()[0]); await driver.freezeJudgments()
    return { a, b, adjudicator }
  }
  return { ...data, root, external, driver, privateKeyBindings, verified, complete, throughJudgments, writePrivateKeys }
}
