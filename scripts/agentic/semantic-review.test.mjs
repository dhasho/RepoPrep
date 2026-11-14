import test from 'node:test'
import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  SEMANTIC_JUDGMENT_PROTOCOL, SEMANTIC_REVIEW_PROTOCOL,
  buildSemanticReviewPackets, createSemanticAdjudicatorInput, createSemanticJudgeInput,
  describeSemanticDisputes, freezeSemanticScoringProjection, parseSemanticJsonBytes,
  scoreSemanticQuality, semanticAnswerPaths, semanticCanonicalJson, semanticInvocationInputs,
  semanticJsonBytes, semanticSha256, validateSemanticJudgments, validateSemanticReviewPackets
} from './semantic-review.mjs'
import { createSemanticScoringOnlyAdapter } from './semantic-review-score.mjs'

const copy = (value) => JSON.parse(JSON.stringify(value))
const h = (value) => semanticSha256(typeof value === 'string' || value instanceof Uint8Array ? value : semanticJsonBytes(value))
const executionBytes = Buffer.from('synthetic immutable execution freeze for E2 only')
function fixture() {
  const reviews = Array.from({ length: 80 }, (_, index) => ({ unitId: `review-unit-${index}`, sampleId: `review-sample-${index}`, assessment: index < 40 ? 'material-risk' : 'no-material-risk' }))
  const repairs = Array.from({ length: 20 }, (_, index) => {
    const question = { title: 'Navigation topic', question: `What does operation ${index} return?`, answer: `Incorrect operation claim ${index}.`, followUps: [{ question: 'Which branch?', answer: 'The guarded branch.', followUps: [{ question: 'Which return?', answer: 'The guarded return.' }] }] }
    const before = { question, glossary: { branch: 'A conditional code path.' } }
    const after = copy(before); after.question.answer = `Operation returns ${index}.`
    const source = `export const result = ${index}\nexport const guarded = true`
    return { unitId: `repair-unit-${index}`, sampleId: `repair-sample-${index}`, status: 'applied', before, after, sources: [{ path: `src/operation-${index}.js`, startLine: 1, endLine: 2, sha256: h(source), text: source }] }
  })
  return {
    projection: { schemaVersion: 1, executionHash: h(executionBytes), publicDataHash: h('synthetic public data'), reviews, repairs },
    reviewKey: { schemaVersion: 1, labels: reviews.map(({ sampleId }, index) => ({ sampleId, materialError: index < 40, errors: index < 40 ? [{ claim: `incorrect ${index}`, explanation: 'Synthetic source contradicts the claim.' }] : [], facts: ['Synthetic private fact.'] })) },
    repairKey: { schemaVersion: 1, labels: repairs.map(({ sampleId }, index) => ({ sampleId, expectedRepairFacts: [`private repair fact ${index}`], errorExplanation: 'Synthetic original error.' })) }
  }
}
const memberKey = (member) => `${member.side}:${member.path}`
function assessment(packet, entry) {
  const witness = [{ sourceId: packet.sources[0].sourceId, startLine: packet.sources[0].startLine, endLine: packet.sources[0].endLine }]
  const issue = { issueId: 'original-issue', sides: entry.beforeSide, members: [{ side: entry.beforeSide, path: 'answer' }], witnesses: witness, explanation: 'The source contradicts this claim.' }
  return { packetId: packet.packetId,
    paths: ['U', 'V'].flatMap((side) => semanticAnswerPaths(packet.sides[side]).map((answerPath) => ({ side, path: answerPath, assessment: side === entry.beforeSide && answerPath === 'answer' ? 'material' : 'clear', issueIds: side === entry.beforeSide && answerPath === 'answer' ? [issue.issueId] : [] }))),
    issues: [issue], scope: { assessment: 'equivalent', witnesses: witness, explanation: 'Both questions ask the same bounded operation.' },
    usefulness: { U: { assessment: 'useful', witnesses: witness, explanation: 'Concrete source-related content.' }, V: { assessment: 'useful', witnesses: witness, explanation: 'Concrete source-related content.' } }
  }
}
function setIssues(item, issues) {
  item.issues = issues
  for (const answerPath of item.paths) {
    answerPath.issueIds = issues.filter((issue) => issue.members.some((member) => memberKey(member) === memberKey(answerPath))).map((issue) => issue.issueId)
    answerPath.assessment = answerPath.issueIds.length ? 'material' : 'clear'
  }
}
function makeJudgments(bundle, edit) {
  const entries = new Map(bundle.privateMap.entries.map((entry) => [entry.packetId, entry]))
  const a = { protocol: SEMANTIC_JUDGMENT_PROTOCOL, packets: bundle.publicPackets.packets.map((packet) => assessment(packet, entries.get(packet.packetId))) }
  const b = copy(a); const final = copy(a)
  for (const item of final.packets) item.resolution = { state: 'resolved', reviewerA: 'accepted', reviewerB: 'accepted', explanation: 'Independently checked the grouping, source witnesses and scope.' }
  edit?.({ a, b, final, entries })
  const document = { schemaVersion: 1, submissions: [{ role: 'A', output: semanticCanonicalJson(a) }, { role: 'B', output: semanticCanonicalJson(b) }, { role: 'adjudicator', output: semanticCanonicalJson(final) }] }
  const inputs = semanticInvocationInputs(bundle.publicPackets, document.submissions)
  const invocations = document.submissions.map(({ role, output }) => ({ role, model: 'gpt-6.1-sol', agentId: `fresh-agent-${role}`, taskId: `fresh-task-${role}`, contextId: `fresh-context-${role}`, contextMode: 'fresh-isolated', inputSha256: h(inputs[role]), outputSha256: h(output), serviceUsage: { availability: 'unavailable' } }))
  return { document, judgmentBytes: semanticJsonBytes(document), invocations }
}
function caseData(editProjection, editJudgments) {
  const data = fixture(); editProjection?.(data.projection)
  const bundle = buildSemanticReviewPackets(data.projection)
  return { ...data, bundle, ...makeJudgments(bundle, editJudgments) }
}
const score = (data) => scoreSemanticQuality(data)
const resealMap = (bundle) => { bundle.privateMap.packetHash = h(bundle.publicPackets); bundle.sideMapHash = h(bundle.privateMap) }
function changedFinal({ final }, index, change) {
  const item = final.packets[index]; change(item)
  item.resolution.reviewerA = 'revised'; item.resolution.reviewerB = 'revised'
}

test('builds20 randomized source-grounded U/V packets with a separately bound private bijection', () => {
  const data = caseData(); const { publicPackets, privateMap } = data.bundle
  assert.deepEqual(Object.keys(publicPackets).sort(), ['packets', 'protocol']); assert.equal(publicPackets.protocol, SEMANTIC_REVIEW_PROTOCOL)
  assert.equal(publicPackets.packets.length, 20); assert.equal(validateSemanticReviewPackets(data.projection, data.bundle), true)
  for (const packet of publicPackets.packets) {
    assert.match(packet.packetId, /^p_[0-9a-f]{32}$/)
    assert.deepEqual(Object.keys(packet).sort(), ['packetId', 'sides', 'sources'])
    assert.deepEqual(Object.keys(packet.sides).sort(), ['U', 'V']); assert.match(packet.sources[0].sourceId, /^s_[0-9a-f]{32}$/)
    assert.deepEqual(Object.keys(packet.sides.U).sort(), ['glossary', 'question'])
  }
  const serialized = semanticCanonicalJson(publicPackets)
  for (const sample of [...data.projection.reviews, ...data.projection.repairs]) { assert.equal(serialized.includes(sample.sampleId), false); assert.equal(serialized.includes(sample.unitId), false) }
  for (const field of ['sampleId', 'unitId', 'before', 'after', 'status', 'strategy', 'provider', 'reviewer', 'findings', 'expectedRepairFacts', 'executionHash', 'publicDataHash']) assert.equal(serialized.includes(`"${field}"`), false)
  assert.equal(privateMap.executionHash, data.projection.executionHash); assert.equal(privateMap.publicDataHash, data.projection.publicDataHash)
  assert.equal(h(publicPackets), privateMap.packetHash); assert.equal(h(privateMap), data.bundle.sideMapHash)
})

test('fresh calls use cryptographic opaque IDs, shuffled samples and randomized sides', () => {
  const { projection } = fixture(); const builds = Array.from({ length: 4 }, () => buildSemanticReviewPackets(projection))
  assert.equal(new Set(builds.flatMap((bundle) => bundle.publicPackets.packets.map(({ packetId }) => packetId))).size, 80)
  assert.equal(new Set(builds.map((bundle) => bundle.privateMap.entries.map(({ sampleId }) => sampleId).join(','))).size, 4)
  assert.equal(builds.some((bundle) => bundle.privateMap.entries.some(({ beforeSide }) => beforeSide === 'U')), true)
  assert.equal(builds.some((bundle) => bundle.privateMap.entries.some(({ beforeSide }) => beforeSide === 'V')), true)
})

test('uses the actual nested answer grammar and includes both complete path sets', () => {
  const data = caseData(); const packet = data.bundle.publicPackets.packets[0]
  assert.deepEqual(semanticAnswerPaths(packet.sides.U), ['answer', 'followUps.0.answer', 'followUps.0.followUps.0.answer'])
  const result = score(data); assert.equal(result.repair.correct, 20); assert.equal(result.review.recall, 1); assert.equal(result.review.falsePositiveRate, 0); assert.equal(result.completeness.complete, true)
  assert.equal(Object.hasOwn(result, 'budgetCompliant'), false); assert.equal(Object.hasOwn(result, 'pass'), false); assert.equal(result.kind, 'semantic-quality-only')
})

for (const [name, tamper] of [
  ['execution hash', (projection, bundle) => { bundle.privateMap.executionHash = h('other execution') }],
  ['public hash', (projection, bundle) => { bundle.privateMap.publicDataHash = h('other data') }],
  ['packet bytes', (projection, bundle) => { bundle.publicPackets.packets[0].sides.U.question.answer = 'Tampered answer.' }],
  ['private hash', (projection, bundle) => { bundle.sideMapHash = h('other map') }],
  ['sample reassignment with recomputed hashes', (projection, bundle) => { [bundle.privateMap.entries[0].sampleId, bundle.privateMap.entries[1].sampleId] = [bundle.privateMap.entries[1].sampleId, bundle.privateMap.entries[0].sampleId]; resealMap(bundle) }],
  ['unit reassignment with recomputed hashes', (projection, bundle) => { bundle.privateMap.entries[0].unitId = 'unknown-unit'; resealMap(bundle) }],
  ['side role swap with recomputed hashes', (projection, bundle) => { const item = bundle.privateMap.entries[0]; item.beforeSide = item.beforeSide === 'U' ? 'V' : 'U'; resealMap(bundle) }],
  ['duplicate mapping', (projection, bundle) => { bundle.privateMap.entries[1] = copy(bundle.privateMap.entries[0]); resealMap(bundle) }],
  ['missing packet', (projection, bundle) => { bundle.publicPackets.packets.pop(); resealMap(bundle) }],
  ['source reassignment', (projection, bundle) => { bundle.privateMap.entries[0].sources[0].sourceHash = h('other source'); resealMap(bundle) }],
  ['private status field', (projection, bundle) => { bundle.publicPackets.packets[0].status = 'applied'; resealMap(bundle) }],
  ['private nested field', (projection, bundle) => { bundle.publicPackets.packets[0].sides.U.question.materialError = true; resealMap(bundle) }]
]) test(`rejects tampered ${name}`, () => {
  const { projection } = fixture(); const bundle = copy(buildSemanticReviewPackets(projection)); tamper(projection, bundle)
  assert.throws(() => validateSemanticReviewPackets(projection, bundle), /SEMANTIC_REVIEW_INVALID/)
})

for (const [name, tamper] of [
  ['extra review', (projection) => projection.reviews.push(copy(projection.reviews[0]))],
  ['missing repair', (projection) => projection.repairs.pop()],
  ['unknown assessment', (projection) => { projection.reviews[0].assessment = 'passed' }],
  ['duplicate unit across sets', (projection) => { projection.repairs[0].unitId = projection.reviews[0].unitId }],
  ['duplicate sample across sets', (projection) => { projection.repairs[0].sampleId = projection.reviews[0].sampleId }],
  ['content ID', (projection) => { projection.repairs[0].before.question.id = 'private' }],
  ['private extra projection field', (projection) => { projection.pass = true }],
  ['source path traversal', (projection) => { projection.repairs[0].sources[0].path = '../private.js' }],
  ['source wrong range hash', (projection) => { projection.repairs[0].sources[0].sha256 = h('wrong') }],
  ['source wrong line count', (projection) => { projection.repairs[0].sources[0].endLine += 1 }],
  ['CRLF source text', (projection) => { const source = projection.repairs[0].sources[0]; source.text = source.text.replace('\n', '\r\n'); source.sha256 = h(source.text) }],
  ['duplicate source', (projection) => { projection.repairs[0].sources.push(copy(projection.repairs[0].sources[0])) }],
  ['third follow-up depth', (projection) => { projection.repairs[0].before.question.followUps[0].followUps[0].followUps = [{ question: 'Deep?', answer: 'Too deep.' }] }],
  ['changed failed repair', (projection) => { projection.repairs[0].status = 'not-run' }],
  ['literal sample identifier leak', (projection) => { projection.repairs[0].after.question.answer = projection.repairs[0].sampleId }],
  ['credential text', (projection) => { projection.repairs[0].after.question.answer = `Bearer ${'A'.repeat(40)}` }]
]) test(`rejects invalid shared projection: ${name}`, () => {
  const { projection } = fixture(); tamper(projection)
  assert.throws(() => buildSemanticReviewPackets(projection), /SEMANTIC_REVIEW_INVALID/)
})

test('freezes canonical scoring projection independently of caller object mutations', () => {
  const { projection } = fixture(); const frozen = freezeSemanticScoringProjection(projection)
  projection.repairs[0].before.question.answer = 'later mutation'
  assert.notEqual(frozen.repairs[0].before.question.answer, projection.repairs[0].before.question.answer)
  assert.equal(Object.isFrozen(frozen.repairs[0].before.question), true)
})

for (const [name, tamper] of [
  ['missing packet', (a) => a.packets.pop()],
  ['extra packet', (a) => a.packets.push(copy(a.packets[0]))],
  ['unknown packet', (a) => { a.packets[0].packetId = `p_${'0'.repeat(32)}` }],
  ['missing side path', (a) => a.packets[0].paths.pop()],
  ['duplicate path', (a) => { a.packets[0].paths[1] = copy(a.packets[0].paths[0]) }],
  ['unknown answer path', (a) => { a.packets[0].paths[0].path = 'followUps.9.answer' }],
  ['missing source witness', (a) => { a.packets[0].issues[0].witnesses = [] }],
  ['unknown witness source', (a) => { a.packets[0].issues[0].witnesses[0].sourceId = `s_${'0'.repeat(32)}` }],
  ['out-of-range witness', (a) => { a.packets[0].scope.witnesses[0].endLine = 10000 }],
  ['duplicate source witness', (a) => a.packets[0].issues[0].witnesses.push(copy(a.packets[0].issues[0].witnesses[0]))],
  ['group with unstated side', (a) => { a.packets[0].issues[0].sides = 'both' }],
  ['group with invalid path', (a) => { a.packets[0].issues[0].members[0].path = 'not-an-answer' }],
  ['unknown issue reference', (a) => { a.packets[0].paths.find((item) => item.assessment === 'material').issueIds = ['missing-issue'] }],
  ['unreferenced material group', (a) => { const item = a.packets[0].paths.find((item) => item.assessment === 'material'); item.assessment = 'clear'; item.issueIds = [] }],
  ['duplicate issue group ID', (a) => a.packets[0].issues.push(copy(a.packets[0].issues[0]))],
  ['raw trace', (a) => { a.rawTrace = 'opaque internal trace' }],
  ['self-declared pass', (a) => { a.packets[0].pass = true }],
  ['oversized explanation', (a) => { a.packets[0].issues[0].explanation = 'x'.repeat(2001) }],
  ['secret in explanation', (a) => { a.packets[0].issues[0].explanation = `sk-${'a'.repeat(32)}` }]
]) test(`judgment validation rejects ${name}`, () => {
  const data = caseData(); const doc = copy(data.document); const a = JSON.parse(doc.submissions[0].output); tamper(a); doc.submissions[0].output = semanticCanonicalJson(a)
  assert.throws(() => validateSemanticJudgments(data.projection, data.bundle, semanticJsonBytes(doc), data.invocations), /SEMANTIC_REVIEW_INVALID/)
})

for (const [name, tamper] of [
  ['copied agent', (receipts) => { receipts[1].agentId = receipts[0].agentId }],
  ['copied task', (receipts) => { receipts[1].taskId = receipts[0].taskId }],
  ['copied context', (receipts) => { receipts[2].contextId = receipts[0].contextId }],
  ['reused context mode', (receipts) => { receipts[0].contextMode = 'continued' }],
  ['historic Luna model', (receipts) => { receipts[0].model = 'gpt6-luna' }],
  ['wrong input hash', (receipts) => { receipts[0].inputSha256 = h('wrong input') }],
  ['wrong output hash', (receipts) => { receipts[0].outputSha256 = h('wrong output') }],
  ['missing receipt', (receipts) => receipts.pop()],
  ['duplicate role', (receipts) => { receipts[1].role = 'A' }],
  ['missing usage availability', (receipts) => { receipts[0].serviceUsage = {} }],
  ['unknown receipt trace', (receipts) => { receipts[0].rawTrace = 'secret' }]
]) test(`requires distinct bounded role provenance: ${name}`, () => {
  const data = caseData(); data.invocations = copy(data.invocations); tamper(data.invocations)
  assert.throws(() => score(data), /SEMANTIC_REVIEW_INVALID/)
})

test('retains explicit unavailable service usage and never derives budget compliance', () => {
  const data = caseData(); data.invocations[0].serviceUsage = { availability: 'available', inputTokens: 123, outputTokens: 45 }
  const result = score(data)
  assert.deepEqual(result.invocations[0].serviceUsage, data.invocations[0].serviceUsage)
  assert.deepEqual(result.invocations[1].serviceUsage, { availability: 'unavailable' })
  assert.equal(semanticCanonicalJson(result).includes('budgetCompliant'), false)
})

test('requires fresh adjudication of all20 even when A/B phrases and structure match', () => {
  const data = caseData(); const a = Buffer.from(data.document.submissions[0].output); const b = Buffer.from(data.document.submissions[1].output)
  const disputes = describeSemanticDisputes(data.bundle.publicPackets, a, b)
  assert.equal(disputes.length, 20); assert.equal(disputes.every((dispute) => dispute.required && dispute.reasons.includes('semantic-equivalence-unproven')), true)
  const doc = copy(data.document); doc.submissions.pop()
  assert.throws(() => validateSemanticJudgments(data.projection, data.bundle, semanticJsonBytes(doc), data.invocations), /SEMANTIC_REVIEW_INVALID/)
  const adjudication = createSemanticAdjudicatorInput(data.bundle.publicPackets, a, b).toString('utf8')
  for (const field of ['sampleId', 'unitId', 'beforeSide', 'expectedRepairFacts', 'materialError', 'status']) assert.equal(adjudication.includes(`"${field}"`), false)
})

test('records membership/scope disputes and accepts independently revised final grouping', () => {
  const data = caseData(undefined, ({ b, final }) => {
    setIssues(b.packets[0], []); b.packets[0].scope.assessment = 'changed'; final.packets[0].resolution.reviewerB = 'revised'
  })
  const result = score(data); const dispute = result.disputes[0]
  assert.equal(dispute.reasons.includes('material-membership-disagreement'), true); assert.equal(dispute.reasons.includes('scope-disagreement'), true); assert.equal(dispute.reasons.includes('path-assessment-disagreement'), true)
  assert.equal(result.repair.correct, 20)
})

test('rejects structurally changed final assessment falsely labeled accepted', () => {
  const data = caseData(undefined, ({ final }) => { setIssues(final.packets[0], []) })
  assert.throws(() => score(data), /SEMANTIC_REVIEW_INVALID/)
})

test('unresolved adjudication remains explicit and prevents completeness', () => {
  const data = caseData(undefined, ({ final }) => { final.packets[0].resolution.state = 'unresolved' })
  const result = score(data); assert.equal(result.completeness.complete, false); assert.equal(result.repair.correct, 19)
  assert.equal(result.completeness.issues.some((issue) => issue.kind === 'repair-judgment-unresolved'), true)
})

test('issue IDs/order are presentation only; membership survives renumbering', () => {
  const data = caseData(undefined, ({ b }) => {
    b.packets.reverse()
    for (const item of b.packets) { item.issues[0].issueId = 'renumbered-77'; for (const answerPath of item.paths) if (answerPath.assessment === 'material') answerPath.issueIds = ['renumbered-77']; item.paths.reverse(); item.issues[0].members.reverse() }
  })
  assert.equal(score(data).repair.correct, 20)
})

test('shared original error remains material but is not introduced material', () => {
  const data = caseData(undefined, (context) => changedFinal(context, 0, (item) => {
    const group = copy(item.issues[0]); group.sides = 'both'; group.members = [{ side: 'U', path: 'answer' }, { side: 'V', path: 'answer' }]; setIssues(item, [group])
  }))
  const result = score(data); assert.equal(result.repair.correct, 19); assert.equal(result.repair.introducedIssues, 0)
  assert.equal(result.repair.outcomes.find((outcome) => outcome.packetId === data.bundle.publicPackets.packets[0].packetId).afterIssues, 1)
})

test('counts every distinct after-only group across20 without counting before/shared groups', () => {
  const data = caseData(undefined, (context) => {
    for (const index of [0, 1]) changedFinal(context, index, (item) => {
      const beforeSide = context.entries.get(item.packetId).beforeSide; const afterSide = beforeSide === 'U' ? 'V' : 'U'
      const groups = [copy(item.issues[0]), ...['answer', 'followUps.0.answer'].map((answerPath, i) => ({ ...copy(item.issues[0]), issueId: `introduced-${i}`, sides: afterSide, members: [{ side: afterSide, path: answerPath }] }))]
      setIssues(item, groups)
    })
  })
  const result = score(data); assert.equal(result.repair.correct, 18); assert.equal(result.repair.introducedIssues, 4); assert.equal(result.repair.introducedPackets, 2); assert.equal(result.repair.introducedThresholdMet, false)
})

test('clean sides without source-grounded original material cannot prove repair', () => {
  const data = caseData(undefined, ({ a, b, final }) => { for (const item of [a.packets[0], b.packets[0], final.packets[0]]) setIssues(item, []) })
  assert.equal(score(data).repair.correct, 19)
})

test('scope deletion and low usefulness prevent repair credit', () => {
  const data = caseData(undefined, (context) => {
    changedFinal(context, 0, (item) => { item.scope.assessment = 'changed' })
    changedFinal(context, 1, (item) => { const beforeSide = context.entries.get(item.packetId).beforeSide; item.usefulness[beforeSide === 'U' ? 'V' : 'U'].assessment = 'not-useful' })
  })
  assert.equal(score(data).repair.correct, 18)
})

test('applied-unchanged/rejected/unattempted stay20 denominator and zero credit with complete evidence', () => {
  const data = caseData((projection) => {
    for (const [index, status] of [[0, 'applied'], [1, 'incomplete'], [2, 'not-run']]) { projection.repairs[index].status = status; projection.repairs[index].after = copy(projection.repairs[index].before) }
  })
  const result = score(data); assert.equal(result.repair.denominator, 20); assert.equal(result.repair.correct, 17); assert.equal(result.completeness.complete, true)
  assert.equal(result.repair.incomplete, 1); assert.equal(result.repair.notRun, 1); assert.equal(result.repair.failed, 3)
  assert.equal(result.repair.outcomes.filter((outcome) => outcome.changed === false && outcome.correctRepair === false).length, 3)
  assert.equal(result.repair.outcomes.some((outcome) => outcome.status === 'not-run'), true)
})

test('review uncertainty/incompleteness retain80/40/40 denominators and explicit evidence limits', () => {
  const data = caseData((projection) => {
    projection.reviews[0].assessment = 'uncertain'; projection.reviews[1].assessment = 'incomplete'; projection.reviews[40].assessment = 'material-risk'; projection.reviews[41].assessment = 'uncertain'
  })
  const result = score(data); assert.deepEqual(result.review, { denominator: 80, bad: 40, good: 40, detectedBad: 38, flaggedGood: 1, recall: 38 / 40, falsePositiveRate: 1 / 40, uncertain: 2, incomplete: 1 }); assert.equal(result.completeness.complete, false)
})

for (const correct of [13, 14]) test(`repair threshold is exactly14/20, boundary ${correct}`, () => {
  const data = caseData(undefined, (context) => { for (let index = correct; index < 20; index += 1) changedFinal(context, index, (item) => { item.scope.assessment = 'changed' }) })
  const result = score(data); assert.equal(result.repair.correct, correct); assert.equal(result.repair.correctThresholdMet, correct >= 14); assert.equal(result.repair.introducedThresholdMet, true)
})

test('six fully accounted failed repairs still permit14/20 quality threshold and complete evidence', () => {
  const data = caseData((projection) => { for (let index = 0; index < 6; index += 1) { projection.repairs[index].status = index < 3 ? 'incomplete' : 'not-run'; projection.repairs[index].after = copy(projection.repairs[index].before) } })
  const result = score(data); assert.equal(result.repair.correct, 14); assert.equal(result.repair.correctThresholdMet, true); assert.equal(result.completeness.complete, true)
})

test('private facts never become keyword matching or judge input', () => {
  const data = caseData(); const first = score(data)
  for (const label of data.repairKey.labels) { label.expectedRepairFacts = ['Unrelated synthetic private words.']; label.errorExplanation = 'Different private explanation.' }
  assert.deepEqual(score(data), first)
  assert.equal(createSemanticJudgeInput(data.bundle.publicPackets).toString('utf8').includes('private repair fact'), false)
})

for (const [name, change] of [
  ['wrong container', (data) => { data.reviewKey = { schemaVersion: 1, samples: data.reviewKey.labels } }],
  ['duplicate review label', (data) => { data.reviewKey.labels[1] = copy(data.reviewKey.labels[0]) }],
  ['extra repair label', (data) => { data.repairKey.labels.push(copy(data.repairKey.labels[0])) }],
  ['missing repair label', (data) => { data.repairKey.labels.pop() }],
  ['unknown repair sample', (data) => { data.repairKey.labels[0].sampleId = 'unknown' }],
  ['not40bad40good', (data) => { data.reviewKey.labels[0].materialError = false; data.reviewKey.labels[0].errors = [] }],
  ['private unknown field', (data) => { data.repairKey.labels[0].expectedPass = true }]
]) test(`private label schema rejects ${name}`, () => { const data = caseData(); change(data); assert.throws(() => score(data), /SEMANTIC_REVIEW_INVALID/) })

test('strict JSON parser rejects duplicate keys, invalid UTF8 and excessive nesting', () => {
  for (const value of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', `${'['.repeat(34)}0${']'.repeat(34)}`, '{} trailing']) assert.throws(() => parseSemanticJsonBytes(Buffer.from(value)), /SEMANTIC_REVIEW_INVALID/)
  assert.throws(() => parseSemanticJsonBytes(Buffer.from([0xff])), /SEMANTIC_REVIEW_INVALID/)
  assert.deepEqual(parseSemanticJsonBytes(Buffer.from(' { "x" : [1, true, "a\\\"b"] } ')), { x: [1, true, 'a"b'] })
})

async function syntheticFiles(t, data) {
  const base = path.resolve(tmpdir()); const root = await mkdtemp(path.join(base, 'repoprep-e2-synthetic-'))
  t.after(async () => { const absolute = path.resolve(root); assert.equal(path.dirname(absolute), base); assert.match(path.basename(absolute), /^repoprep-e2-synthetic-/); const stats = await lstat(absolute); assert.equal(stats.isSymbolicLink(), false); await rm(absolute, { recursive: true }); await assert.rejects(lstat(absolute), { code: 'ENOENT' }) })
  const bindings = { rootDir: root }
  for (const [key, filename] of [['reviewKey', 'review-key.json'], ['repairKey', 'repair-key.json']]) {
    const bytes = semanticJsonBytes(data[key]); await writeFile(path.join(root, filename), bytes); bindings[key] = { path: filename, byteLength: bytes.length, sha256: h(bytes) }
  }
  return bindings
}
function adapterFor(data, bindings, overrides = {}) {
  return createSemanticScoringOnlyAdapter({ privateKeyBindings: bindings, verifyExecutionFreeze: async (bytes) => { assert.deepEqual(bytes, executionBytes); return data.projection }, verifyJudgeInvocation: async ({ role, inputBytes, outputBytes }) => {
    const receipt = data.invocations.find((item) => item.role === role); assert.equal(receipt.inputSha256, h(inputBytes)); assert.equal(receipt.outputSha256, h(outputBytes)); return receipt
  }, ...overrides })
}
async function frozenAdapter(data, bindings, overrides) {
  const adapter = adapterFor(data, bindings, overrides); const execution = await adapter.freezeExecution(executionBytes)
  const judgments = await adapter.freezeJudgments(execution, data.bundle, data.judgmentBytes)
  return { adapter, execution, judgments }
}

test('file adapter reads only synthetic keys after verified immutable execution and judgments', async (t) => {
  const data = caseData(); const bindings = await syntheticFiles(t, data); const { adapter, judgments } = await frozenAdapter(data, bindings)
  const result = await adapter.scorePrivateFiles(judgments); assert.equal(result.repair.correct, 20); assert.equal(result.review.recall, 1); assert.equal(Object.hasOwn(result, 'budgetCompliant'), false)
})

test('forged handles fail before any missing private root could be read', async () => {
  const data = caseData(); const bindings = { rootDir: path.join(tmpdir(), 'repoprep-e2-never-opened-root'), reviewKey: { path: 'review-key.json', byteLength: 12, sha256: h('none') }, repairKey: { path: 'repair-key.json', byteLength: 12, sha256: h('none') } }
  const adapter = adapterFor(data, bindings)
  await assert.rejects(adapter.scorePrivateFiles({ executionHash: data.projection.executionHash, judgmentsHash: h('fake'), pass: true }), /SEMANTIC_JUDGMENTS_NOT_FROZEN/)
  assert.throws(() => adapter.buildPackets({ ...data.projection }), /SEMANTIC_EXECUTION_NOT_FROZEN/)
  await assert.rejects(adapter.freezeJudgments({}, data.bundle, data.judgmentBytes), /SEMANTIC_EXECUTION_NOT_FROZEN/)
})

test('pass flags and unbound execution bytes cannot replace trusted verification', async (t) => {
  const data = caseData(); const bindings = await syntheticFiles(t, data)
  for (const verifyExecutionFreeze of [async () => ({ pass: true }), async () => ({ ...data.projection, executionHash: h('different execution') })]) {
    const adapter = adapterFor(data, bindings, { verifyExecutionFreeze }); await assert.rejects(adapter.freezeExecution(executionBytes), /SEMANTIC_EXECUTION_NOT_VERIFIED/)
  }
  assert.throws(() => createSemanticScoringOnlyAdapter({ privateKeyBindings: bindings, verifyExecutionFreeze: true, verifyJudgeInvocation: true }), /SEMANTIC_TRUSTED_VERIFIERS_REQUIRED/)
})

test('native invocation lookup must return full evidence, not a pass flag', async (t) => {
  const data = caseData(); const bindings = await syntheticFiles(t, data); const adapter = adapterFor(data, bindings, { verifyJudgeInvocation: async () => ({ pass: true }) })
  const execution = await adapter.freezeExecution(executionBytes)
  await assert.rejects(adapter.freezeJudgments(execution, data.bundle, data.judgmentBytes), /SEMANTIC_JUDGMENTS_NOT_FROZEN/)
})

test('freezes bytes, owned maps and native receipts before later caller mutations', async (t) => {
  const data = caseData(); const bindings = await syntheticFiles(t, data); const { adapter, judgments } = await frozenAdapter(data, bindings)
  data.projection.reviews[0].assessment = 'incomplete'; data.judgmentBytes.fill(0); data.invocations[0].model = 'forged'; bindings.reviewKey.sha256 = h('later override')
  const result = await adapter.scorePrivateFiles(judgments); assert.equal(result.review.incomplete, 0); assert.equal(result.repair.correct, 20); assert.equal(result.invocations[0].model, 'gpt-6.1-sol')
})

for (const [name, change] of [
  ['wrong expected hash', async (bindings) => { bindings.reviewKey.sha256 = h('wrong') }],
  ['file changed after binding', async (bindings) => { await writeFile(path.join(bindings.rootDir, 'review-key.json'), 'tampered') }],
  ['nonregular file', async (bindings) => { await rm(path.join(bindings.rootDir, 'review-key.json')); await mkdir(path.join(bindings.rootDir, 'review-key.json')) }],
  ['hardlinked key', async (bindings) => { await link(path.join(bindings.rootDir, 'review-key.json'), path.join(bindings.rootDir, 'duplicate-key.json')) }]
]) test(`private loader rejects ${name} with redacted error`, async (t) => {
  const data = caseData(); const bindings = await syntheticFiles(t, data); await change(bindings)
  const { adapter, judgments } = await frozenAdapter(data, bindings)
  await assert.rejects(adapter.scorePrivateFiles(judgments), (error) => { assert.equal(error.message, 'SEMANTIC_PRIVATE_KEYS_UNAVAILABLE'); assert.equal(error.message.includes(bindings.rootDir), false); return true })
})

test('private root junction/symlink is rejected and cleanup never follows it', async (t) => {
  const data = caseData(); const bindings = await syntheticFiles(t, data); const alias = `${bindings.rootDir}-junction`
  await symlink(bindings.rootDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(async () => { assert.equal((await lstat(alias)).isSymbolicLink(), true); await rm(alias, { recursive: true }) })
  const { adapter, judgments } = await frozenAdapter(data, { ...bindings, rootDir: alias })
  await assert.rejects(adapter.scorePrivateFiles(judgments), /SEMANTIC_PRIVATE_KEYS_UNAVAILABLE/)
})

test('bindings reject traversal, extra private files and oversized metadata before IO', async (t) => {
  const data = caseData(); const bindings = await syntheticFiles(t, data)
  for (const mutate of [(value) => { value.reviewKey.path = '../review-key.json' }, (value) => { value.reviewKey.byteLength = 1024 * 1024 + 1 }, (value) => { value.holdoutLabels = {} }, (value) => { value.reviewKey.path = 'retrieval-labels.json' }]) {
    const bad = copy(bindings); mutate(bad); assert.throws(() => adapterFor(data, bad), /SEMANTIC_PRIVATE_KEYS_UNAVAILABLE/)
  }
})

test('public dependency graph excludes filesystem, private loader, runtime and provider imports', async () => {
  const source = await readFile(new URL('./semantic-review.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gmu)].map((match) => match[1])
  assert.deepEqual(imports, ['node:crypto']); assert.equal(source.includes('loadDatasetBundle('), false)
})


for (const [name, mutate] of [
  ['sparse reviews', (projection) => { delete projection.reviews[3] }],
  ['private array property', (projection) => { projection.repairs.privateLabels = 'hidden' }],
  ['symbol array property', (projection) => { projection.repairs[Symbol('private')] = 'hidden' }],
  ['custom array prototype', (projection) => { Object.setPrototypeOf(projection.reviews, Object.create(Array.prototype)) }],
  ['nonenumerable required field', (projection) => { Object.defineProperty(projection.repairs[0], 'sampleId', { value: projection.repairs[0].sampleId, enumerable: false }) }],
  ['nonenumerable glossary data', (projection) => { Object.defineProperty(projection.repairs[0].before.glossary, 'privateLabels', { value: 'hidden', enumerable: false }) }]
]) test(`pure projection rejects ${name}`, () => {
  const { projection } = fixture(); mutate(projection); assert.throws(() => freezeSemanticScoringProjection(projection), /SEMANTIC_REVIEW_INVALID/)
})

test('pure validation and canonicalization reject object/array getters without executing them', () => {
  let reads = 0
  const { projection } = fixture(); Object.defineProperty(projection.repairs[0], 'sampleId', { enumerable: true, get() { reads += 1; return 'hidden' } })
  assert.throws(() => buildSemanticReviewPackets(projection), /SEMANTIC_REVIEW_INVALID/)
  const array = [1]; Object.defineProperty(array, '0', { enumerable: true, get() { reads += 1; return 1 } })
  assert.throws(() => semanticCanonicalJson(array), /SEMANTIC_REVIEW_INVALID/)
  const data = caseData(); const receipts = copy(data.invocations); Object.defineProperty(receipts[0], 'agentId', { enumerable: true, get() { reads += 1; return 'hidden' } })
  assert.throws(() => validateSemanticJudgments(data.projection, data.bundle, data.judgmentBytes, receipts), /SEMANTIC_REVIEW_INVALID/)
  assert.equal(reads, 0)
})

test('fresh adjudicator input includes complete base and required resolution output schema', () => {
  const data = caseData(); const a = Buffer.from(data.document.submissions[0].output); const b = Buffer.from(data.document.submissions[1].output)
  const input = parseSemanticJsonBytes(createSemanticAdjudicatorInput(data.bundle.publicPackets, a, b))
  assert.equal(input.outputSchema.protocol, SEMANTIC_JUDGMENT_PROTOCOL)
  const packet = input.outputSchema.packets[0]
  assert.deepEqual(Object.keys(packet.resolution).sort(), ['explanation', 'reviewerA', 'reviewerB', 'state'])
  assert.equal(packet.resolution.state, 'resolved | unresolved'); assert.equal(packet.resolution.reviewerA, 'accepted | revised')
  for (const field of ['packetId', 'paths', 'issues', 'scope', 'usefulness']) assert.equal(Object.hasOwn(packet, field), true)
})

test('quality evidence retains adjudicated final membership/witnesses and all disputes', () => {
  const result = score(caseData()); assert.equal(result.finalJudgments.packets.length, 20); assert.equal(result.disputes.length, 20)
  const first = result.finalJudgments.packets[0]; assert.equal(first.issues[0].members.length, 1); assert.equal(first.issues[0].witnesses.length, 1); assert.equal(first.resolution.state, 'resolved')
  assert.equal(Object.isFrozen(first.issues[0].members), true)
})
