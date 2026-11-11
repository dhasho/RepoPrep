import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { InterviewResult, QuestionItem } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { fingerprintQuestion } from './question-evidence.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { normalizeQuestionPatch, validateQuestionReplacement, validateSingleQuestionEvaluationInput, validateSingleQuestionReplacement } from './question-patch.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { normalizeParsed } from '../generator.ts'

const ev = 'ev_00000000-0000-4000-8000-000000000001'
const otherEv = 'ev_00000000-0000-4000-8000-000000000002'
function question(index = 0): QuestionItem { return { id: `question-${index}`, title: `Title ${index}`, question: `How does module ${index} work?`, answer: 'It returns a value.', followUps: [] } }
function result(count = 10): InterviewResult {
  return { version: 1, createdAt: '2026-11-10T00:00:00.000Z', projectName: 'Synthetic', projectPath: 'C:/synthetic/project', granularity: 'coarse', roleFocus: 'backend', profileId: 'synthetic-profile', modelUsed: 'Synthetic / synthetic-model', projectSummary: 'Synthetic project.', sections: [{ id: 'section-1', title: 'First', summary: 'Keep summary.', questions: Array.from({ length: count }, (_, index) => question(index)) }], glossary: {} }
}
function proposal(content: unknown = { title: ' New\r\nTitle ', question: ' What is the new module behavior? ', answer: ' It returns a new value. ', followUps: [{ question: ' Why? ', answer: ' To expose a value. ', followUps: [{ question: ' How? ', answer: ' With a return. ' }] }] }) { return { question: content, evidenceIds: [ev], glossary: {} } }
function replace(value: InterviewResult, patch: unknown = proposal()) { return validateQuestionReplacement({ result: value, questionId: value.sections[0].questions[0].id, expectedFingerprint: fingerprintQuestion(value.sections[0].questions[0]), proposal: patch, allowedEvidenceIds: [ev] }) }

test('normalization reuses generator semantics while retaining the original ID and freezing the proposal', () => {
  const raw = proposal()
  const normalized = normalizeQuestionPatch(raw, question(), [ev])
  const existing = normalizeParsed({ sections: [{ questions: [raw.question] }] }).sections[0].questions[0]
  assert.deepEqual(normalized.question, { ...existing, id: question().id })
  assert.equal(normalized.question.title, 'New Title')
  assert.equal(Object.isFrozen(normalized.question.followUps[0].followUps), true)
  assert.equal(Object.isFrozen(raw), false)
})

test('rejects unknown fields, hidden getters, IDs, dropped titles, empty content and deeper follow-ups', () => {
  const invalid = [
    { ...proposal(), budget: 1 },
    proposal({ ...question(), id: 'model-controlled' }),
    proposal({ question: 'Valid?', answer: '', followUps: [] }),
    proposal({ title: ' ', question: 'Valid?', answer: 'Valid.', followUps: [] }),
    proposal({ title: 'x'.repeat(121), question: 'Valid?', answer: 'Valid.', followUps: [] }),
    proposal({ question: 'Valid?', answer: 'Valid.', followUps: [{ question: 'One?', answer: 'One.', command: 'execute' }] }),
    proposal({ question: 'Valid?', answer: 'Valid.', followUps: [{ question: 'One?', answer: 'One.', followUps: [{ question: 'Two?', answer: 'Two.', followUps: [{ question: 'Lost?', answer: 'Lost.' }] }] }] }),
    proposal({ question: 'Valid?', answer: 'Valid.', followUps: [{ question: ' ', answer: 'Dropped.' }] }),
    { ...proposal(), evidenceIds: [ev, ev] },
    { ...proposal(), evidenceIds: [otherEv] }
  ]
  const getter = Object.defineProperty(proposal(), 'glossary', { get() { throw new Error('must not execute') }, enumerable: true })
  invalid.push(getter)
  for (const value of invalid) assert.throws(() => normalizeQuestionPatch(value, question(), [ev]), { code: 'invalid-argument' })
})

test('atomic prospective result preserves every unrelated value and does not freeze or mutate input', () => {
  const original = result()
  original.glossary['unused term'] = ' Preserve existing definition exactly. '
  const before = structuredClone(original)
  const changed = replace(original)
  assert.deepEqual(original, before)
  assert.equal(Object.isFrozen(original.sections[0].questions[1]), false)
  assert.equal(changed.result.sections[0].id, original.sections[0].id)
  assert.equal(changed.result.sections[0].summary, original.sections[0].summary)
  assert.deepEqual(changed.result.sections[0].questions.slice(1), original.sections[0].questions.slice(1))
  assert.deepEqual({ ...changed.result, sections: [] }, { ...original, sections: [] })
  assert.equal(changed.question.id, original.sections[0].questions[0].id)
  assert.equal(Object.isFrozen(changed.result.sections[0].questions[1]), true)
  assert.notEqual(changed.afterFingerprint, changed.beforeFingerprint)
  assert.throws(() => { changed.result.sections[0].questions[0].answer = 'mutated' }, TypeError)
})

test('rejects duplicate and conflicting identities, normalized duplicate keys and unchanged replacements', () => {
  const value = result()
  value.glossary.module = 'A component. It contains code.'
  const duplicate = { ...question(1), question: '  HOW does [[module]] １ work? ' }
  const { id: _id, ...content } = duplicate
  assert.throws(() => replace(value, proposal(content)))
  const unchanged = value.sections[0].questions[0]
  const { id: _originalId, ...same } = unchanged
  assert.throws(() => replace(value, proposal(same)))
  const duplicateId = result()
  duplicateId.sections[0].questions[1].id = duplicateId.sections[0].questions[0].id
  assert.throws(() => replace(duplicateId))
  const duplicateSection = result()
  duplicateSection.sections.push({ id: duplicateSection.sections[0].id, title: 'Other', questions: [] })
  assert.throws(() => replace(duplicateSection))
  assert.throws(() => validateQuestionReplacement({ result: value, questionId: unchanged.id, expectedFingerprint: '0'.repeat(64), proposal: proposal(), allowedEvidenceIds: [ev] }))
})

test('whole-result validation uses the shared granularity budget and checks the existing contract', () => {
  for (const count of [0, 7, 13]) {
    const value = result(count)
    assert.throws(() => validateQuestionReplacement({ result: value, questionId: 'question-0', expectedFingerprint: fingerprintQuestion(question()), proposal: proposal(), allowedEvidenceIds: [ev] }))
  }
  for (const count of [8, 12]) assert.equal(replace(result(count)).result.sections[0].questions.length, count)
  const value = result()
  value.sections[0].questions[1].title = 'x'.repeat(121)
  assert.throws(() => replace(value))
})

test('glossary coverage is validated across all prospective questions and conflicts do not escape', () => {
  const value = result()
  value.glossary = { TCP: 'A protocol. It carries bytes.' }
  value.sections[0].questions[1].answer = 'Uses [[TCP]].'
  const patch = proposal({ question: 'Why use [[UDP]]?', answer: 'The protocol sends datagrams.', followUps: [] })
  assert.throws(() => replace(value, patch))
  assert.equal(replace(value, { ...patch, glossary: { UDP: 'A protocol. It sends datagrams.' } }).result.glossary.TCP, value.glossary.TCP)
  assert.throws(() => replace(value, { ...patch, glossary: { UDP: 'A protocol.', TCP: 'Conflicting meaning.' } }))
  assert.throws(() => replace(value, { ...patch, glossary: { UDP: ' ' } }))
  assert.throws(() => replace(value, { ...patch, glossary: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`Term${i}`, 'Definition.'])) }))
  const uncovered = result()
  uncovered.sections[0].questions[2].answer = 'Uses [[Missing]].'
  assert.throws(() => replace(uncovered))
  assert.throws(() => replace(value, proposal({ question: 'Malformed [[term?', answer: 'Content.', followUps: [] })))
})

test('single-question evaluation validates one real unit without a fake granularity result', () => {
  const original = question()
  const validated = validateSingleQuestionEvaluationInput(original, {})
  assert.equal(validated.question.id, original.id)
  const changed = validateSingleQuestionReplacement({ question: original, glossary: {}, expectedFingerprint: fingerprintQuestion(original), proposal: proposal(), allowedEvidenceIds: [ev] })
  assert.equal(changed.question.id, original.id)
  assert.equal('result' in changed, false)
  assert.equal(Object.isFrozen(changed.glossary), true)
  assert.throws(() => validateSingleQuestionReplacement({ question: original, glossary: {}, expectedFingerprint: 'f'.repeat(64), proposal: proposal(), allowedEvidenceIds: [ev] }))
})


test('array accessors, sparse arrays, extra keys and nonstandard prototypes are rejected without executing getters', () => {
  let reads = 0
  const accessorFollowUps = Object.defineProperty([], '0', { get() { reads++; throw new Error('must not execute') }, enumerable: true })
  assert.throws(() => normalizeQuestionPatch(proposal({ question: 'Valid?', answer: 'Valid.', followUps: accessorFollowUps }), question(), [ev]), { code: 'invalid-argument' })
  const accessorIds = Object.defineProperty([], '0', { get() { reads++; throw new Error('must not execute') }, enumerable: true })
  assert.throws(() => normalizeQuestionPatch({ ...proposal(), evidenceIds: accessorIds }, question(), [ev]), { code: 'invalid-argument' })
  const sparse = new Array(1)
  const extra = Object.assign([], { command: 'execute' })
  const symbol = Object.assign([], { [Symbol('hidden')]: 'value' })
  const nonstandard = Object.setPrototypeOf([], null)
  for (const followUps of [sparse, extra, symbol, nonstandard]) {
    assert.throws(() => normalizeQuestionPatch(proposal({ question: 'Valid?', answer: 'Valid.', followUps }), question(), [ev]), { code: 'invalid-argument' })
  }
  assert.equal(reads, 0)
})
