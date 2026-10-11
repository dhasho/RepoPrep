// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { assertInterviewResultContract, EXPLAIN_CONTEXT_LIMITS, LLM_PROFILE_LIMITS, RESULT_LIMITS, ResultContractError } from './result-contract.ts'

function makeResult(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectName: 'fixture',
    projectPath: 'C:\\fixture',
    granularity: 'medium',
    roleFocus: 'backend',
    profileId: 'p1',
    modelUsed: 'Mock / fixture',
    projectSummary: '',
    sections: [{
      id: 's1', title: 'Section', questions: [{
        id: 'q1', question: 'Question', answer: '', followUps: [{ question: 'Follow-up', answer: '' }]
      }]
    }],
    glossary: {},
    ...overrides
  }
}

function makeContentReadSummary(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    attemptedReads: 2,
    successfulReads: 1,
    failedReads: 1,
    failuresByReason: { permission: 1, missing: 0, io: 0 },
    failures: [{ path: 'src/locked.ts', reason: 'permission' }],
    ...overrides
  }
}
function assertValid(value: unknown): void {
  assert.doesNotThrow(() => assertInterviewResultContract(value, (candidate) => candidate.startsWith('C:\\')))
}

function assertKind(value: unknown, kind: 'invalid' | 'oversized'): void {
  assert.throws(
    () => assertInterviewResultContract(value, (candidate) => candidate.startsWith('C:\\')),
    (error: unknown) => error instanceof ResultContractError && error.kind === kind
  )
}

function treeChars(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + treeChars(child), 0)
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((sum, [key, child]) => sum + key.length + treeChars(child), 0)
  }
  return 0
}

function fillGlossaryToChars(result: Record<string, any>, target: number): void {
  let remaining = target - treeChars(result)
  let index = 0
  while (remaining > 0) {
    let key = `g${index++}`
    if (remaining < key.length) key = 'z'.repeat(remaining)
    const roomAfterKey = remaining - key.length
    const take = Math.min(RESULT_LIMITS.glossaryValue, roomAfterKey)
    result.glossary[key] = 'x'.repeat(take)
    remaining -= key.length + take
    if (take === 0 && remaining > 0) throw new Error('unable to fill target')
  }
}

test('shared result contract permits profile-composed modelUsed and 256/257/2000 root glossary entries', () => {
  const modelUsed = `${'n'.repeat(LLM_PROFILE_LIMITS.name)} / ${'m'.repeat(LLM_PROFILE_LIMITS.model)}`
  assert.equal(modelUsed.length, 515)
  for (const count of [256, 257, RESULT_LIMITS.glossaryEntries]) {
    assertValid(makeResult({
      modelUsed,
      glossary: Object.fromEntries(Array.from({ length: count }, (_, i) => [`term${i}`, 'definition']))
    }))
  }
  assertKind(makeResult({ modelUsed: `${modelUsed}x` }), 'invalid')
  assertKind(makeResult({ glossary: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`t${i}`, 'd'])) }), 'oversized')
})

test('all result text field ceilings accept exact values and reject one character over', () => {
  const limits = RESULT_LIMITS
  const base = makeResult({
    projectName: 'p'.repeat(limits.projectName),
    projectPath: `C:\\${'p'.repeat(limits.projectPath - 3)}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    profileId: 'p'.repeat(limits.profileId),
    modelUsed: 'm'.repeat(limits.modelUsed),
    projectSummary: 's'.repeat(limits.projectSummary),
    sections: [{
      id: 'i'.repeat(limits.profileId),
      title: 't'.repeat(limits.sectionTitle),
      summary: 's'.repeat(limits.sectionSummary),
      questions: [{
        id: 'q'.repeat(limits.profileId),
        question: 'q'.repeat(limits.question),
        answer: 'a'.repeat(limits.answer),
        followUps: [{ question: 'f', answer: 'a'.repeat(limits.answer) }]
      }]
    }],
    glossary: { ['k'.repeat(limits.glossaryKey)]: 'v'.repeat(limits.glossaryValue) },
    security: {
      excludedFiles: 0, redactedFiles: 0, redactionMatches: 0,
      categories: { ['c'.repeat(limits.categoryKey)]: 1 }
    }
  })
  assertValid(base)

  const cases: Array<[string, (value: Record<string, any>, text: string) => void, number]> = [
    ['projectName', (v, text) => { v.projectName = text }, limits.projectName],
    ['projectPath', (v, text) => { v.projectPath = `C:\\${text}` }, limits.projectPath - 3],
    ['profileId', (v, text) => { v.profileId = text }, limits.profileId],
    ['modelUsed', (v, text) => { v.modelUsed = text }, limits.modelUsed],
    ['projectSummary', (v, text) => { v.projectSummary = text }, limits.projectSummary],
    ['section id', (v, text) => { v.sections[0].id = text }, limits.profileId],
    ['section title', (v, text) => { v.sections[0].title = text }, limits.sectionTitle],
    ['section summary', (v, text) => { v.sections[0].summary = text }, limits.sectionSummary],
    ['question id', (v, text) => { v.sections[0].questions[0].id = text }, limits.profileId],
    ['question text', (v, text) => { v.sections[0].questions[0].question = text }, limits.question],
    ['answer', (v, text) => { v.sections[0].questions[0].answer = text }, limits.answer],
    ['follow-up question', (v, text) => { v.sections[0].questions[0].followUps[0].question = text }, limits.question],
    ['follow-up answer', (v, text) => { v.sections[0].questions[0].followUps[0].answer = text }, limits.answer],
    ['glossary key', (v, text) => { v.glossary = { [text]: 'v' } }, limits.glossaryKey],
    ['glossary value', (v, text) => { v.glossary = { k: text } }, limits.glossaryValue],
    ['security category', (v, text) => { v.security.categories = { [text]: 1 } }, limits.categoryKey]
  ]
  for (const [label, assign, max] of cases) {
    const accepted = makeResult({ security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} } })
    assign(accepted, 'x'.repeat(max))
    assertValid(accepted)
    const rejected = makeResult({ security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} } })
    assign(rejected, 'x'.repeat(max + 1))
    assertKind(rejected, 'invalid')
    assert.ok(label.length > 0)
  }
  const overlongDate = makeResult({ createdAt: `${'2026-01-01T00:00:00.000Z'}${' '.repeat(limits.createdAt)}` })
  assertKind(overlongDate, 'invalid')
})

test('question, follow-up, section, glossary, category and tree count ceilings are enforced', () => {
  const q = (i: number) => ({ id: `q${i}`, question: 'q', answer: '', followUps: [] })
  assert.throws(() => assertInterviewResultContract(makeResult({ sections: Array.from({ length: RESULT_LIMITS.sections + 1 }, (_, i) => ({ id: `s${i}`, title: 's', questions: [q(i)] })) }), (candidate) => candidate.startsWith('C:\\')))
  assert.throws(() => assertInterviewResultContract(makeResult({ sections: [{ id: 's', title: 's', questions: Array.from({ length: RESULT_LIMITS.questionsPerSection + 1 }, (_, i) => q(i)) }] }), (candidate) => candidate.startsWith('C:\\')))
  assertKind(makeResult({ sections: Array.from({ length: RESULT_LIMITS.questions / RESULT_LIMITS.questionsPerSection + 1 }, (_, i) => ({ id: `s${i}`, title: 's', questions: Array.from({ length: RESULT_LIMITS.questionsPerSection }, (_, n) => q(i * 500 + n)) })) }), 'oversized')
  assertKind(makeResult({ sections: [{ id: 's', title: 's', questions: [{ ...q(1), followUps: Array.from({ length: RESULT_LIMITS.followUpsPerItem + 1 }, () => ({ question: 'q', answer: '' })) }] }] }), 'oversized')
  assertKind(makeResult({ sections: [{ id: 's', title: 's', questions: Array.from({ length: 51 }, (_, i) => ({
    ...q(i), followUps: Array.from({ length: RESULT_LIMITS.followUpsPerItem }, () => ({ question: 'q', answer: '' }))
  })) }] }), 'oversized')
  assertKind(makeResult({ glossary: Object.fromEntries(Array.from({ length: RESULT_LIMITS.glossaryEntries + 1 }, (_, i) => [`k${i}`, 'v'])) }), 'oversized')
  assertKind(makeResult({ security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: Object.fromEntries(Array.from({ length: RESULT_LIMITS.categoryKeys + 1 }, (_, i) => [`k${i}`, 1])) } }), 'oversized')
  assertKind(makeResult({ projectSummary: 'x'.repeat(RESULT_LIMITS.totalChars + 1) }), 'oversized')
})

test('exact one-million-character tree is accepted and one more character is rejected', () => {
  const exact = makeResult()
  fillGlossaryToChars(exact, RESULT_LIMITS.totalChars)
  assert.equal(treeChars(exact), RESULT_LIMITS.totalChars)
  assertValid(exact)
  exact.glossary.extra = 'x'
  assertKind(exact, 'oversized')
})

test('content-read summary accepts valid optional metadata and rejects mismatched or extended shapes', () => {
  assertValid(makeResult({ contentReadSummary: makeContentReadSummary() }))
  assertValid(makeResult())
  assertKind(makeResult({ contentReadSummary: makeContentReadSummary({ attemptedReads: 3 }) }), 'invalid')
  assertKind(makeResult({ contentReadSummary: makeContentReadSummary({ failuresByReason: { permission: 0, missing: 0, io: 1 } }) }), 'invalid')
  assertKind(makeResult({ contentReadSummary: makeContentReadSummary({ extra: true }) }), 'invalid')
  assertKind(makeResult({ contentReadSummary: makeContentReadSummary({ failuresByReason: { permission: 1, missing: 0, io: 0, unknown: 0 } }) }), 'invalid')
})

test('content-read summary rejects unsafe paths, excessive samples, cycles and oversized values', () => {
  for (const unsafePath of ['/etc/passwd', 'C:/private/file.ts', 'src\\private.ts', 'src/../private.ts', 'src/./file.ts', 'src/line\\nbreak.ts']) {
    assertKind(makeResult({ contentReadSummary: makeContentReadSummary({ failures: [{ path: unsafePath, reason: 'permission' }] }) }), 'invalid')
  }
  const tooManySamples = makeContentReadSummary({ attemptedReads: 51, successfulReads: 0, failedReads: 51,
    failuresByReason: { permission: 51, missing: 0, io: 0 },
    failures: Array.from({ length: 51 }, (_, index) => ({ path: `src/file-${index}.ts`, reason: 'permission' })) })
  assertKind(makeResult({ contentReadSummary: tooManySamples }), 'invalid')
  const cycle = makeContentReadSummary()
  cycle.failures[0] = cycle
  assertKind(makeResult({ contentReadSummary: cycle }), 'invalid')
  assertKind(makeResult({ contentReadSummary: makeContentReadSummary({ failures: [{ path: `src/${'x'.repeat(2048)}.ts`, reason: 'permission' }] }) }), 'oversized')
  assertKind(makeResult({ contentReadSummary: makeContentReadSummary({ attemptedReads: 100_001, successfulReads: 100_000 }) }), 'invalid')
})
test('compact JSON UTF-8 budget includes repeated tiny keys and escaping overhead', () => {
  const escaped = makeResult()
  // A control character consumes one tree character but six bytes in compact JSON.
  // Keep values below their per-field limit and use many small dictionary keys.
  const valueCount = 60
  for (let i = 0; i < valueCount; i++) escaped.glossary[`g${i}`] = '\u0001'.repeat(10_000)
  const chars = treeChars(escaped)
  assert.ok(chars < RESULT_LIMITS.totalChars)
  let currentBytes = Buffer.byteLength(JSON.stringify(escaped), 'utf8')
  let nextIndex = valueCount
  while (currentBytes + 10_000 * 6 + 16 < RESULT_LIMITS.totalBytes) {
    escaped.glossary[`g${nextIndex++}`] = '\u0001'.repeat(10_000)
    currentBytes = Buffer.byteLength(JSON.stringify(escaped), 'utf8')
  }
  const finalKey = `g${nextIndex++}`
  escaped.glossary[finalKey] = ''
  const emptyEntryBytes = Buffer.byteLength(JSON.stringify(escaped), 'utf8')
  const controlCount = Math.floor((RESULT_LIMITS.totalBytes - emptyEntryBytes) / 6)
  escaped.glossary[finalKey] = '\u0001'.repeat(controlCount)
  const escapedEntryBytes = Buffer.byteLength(JSON.stringify(escaped), 'utf8')
  const padding = RESULT_LIMITS.totalBytes - escapedEntryBytes
  if (padding > 0) escaped.glossary[finalKey] += 'x'.repeat(padding)
  assert.equal(Buffer.byteLength(JSON.stringify(escaped), 'utf8'), RESULT_LIMITS.totalBytes)
  assert.ok(treeChars(escaped) <= RESULT_LIMITS.totalChars)
  assertValid(escaped)
  escaped.glossary.g0 += '\u0001'
  assertKind(escaped, 'oversized')
})

test('rejects excessive depth/nodes, cycles, unsafe shapes, sparse arrays and executable properties safely', () => {
  const manyQuestions = makeResult({ sections: Array.from({ length: 10 }, (_, section) => ({
    id: `s${section}`, title: 's', questions: Array.from({ length: 500 }, (_, i) => ({
      id: `q${section}-${i}`, question: 'q', answer: '', followUps: []
    }))
  })) })
  assertKind(manyQuestions, 'oversized')

  const deep = makeResult()
  let nested: Record<string, unknown> = {}
  const root = nested
  for (let i = 0; i < RESULT_LIMITS.treeDepth + 1; i++) nested = (nested.child = {}) as Record<string, unknown>
  Object.assign(deep, { extra: root })
  assertKind(deep, 'oversized')

  const cycle = makeResult() as Record<string, any>
  cycle.extra = cycle
  assertKind(cycle, 'invalid')

  const withGetter = makeResult() as Record<string, any>
  let getterCalls = 0
  Object.defineProperty(withGetter, 'extra', { enumerable: true, get() { getterCalls++; return 'x' } })
  assertKind(withGetter, 'invalid')
  assert.equal(getterCalls, 0)

  const withToJson = makeResult() as Record<string, any>
  let toJsonCalls = 0
  Object.defineProperty(withToJson, 'toJSON', { enumerable: true, value() { toJsonCalls++; return {} } })
  assertKind(withToJson, 'invalid')
  assert.equal(toJsonCalls, 0)

  assertKind(makeResult({ glossary: Object.assign(Object.create({ inherited: 'x' }), { own: 'x' }) }), 'invalid')
  const holes = makeResult({ sections: new Array(1) })
  assertKind(holes, 'invalid')
  assertKind(makeResult({ sections: [Object.assign([{ id: 's', title: 's', questions: [] }], { extra: true })] }), 'invalid')
  assertKind(makeResult({ sections: [{ id: 's', title: 's', questions: [{ id: 'q', question: 'q', answer: '', followUps: [() => undefined] }] }] }), 'invalid')
})

test('optional summary undefined stays compatible and explain context ceilings are shared constants', () => {
  const result = makeResult({ sections: [{ id: 's1', title: 'Section', summary: undefined, questions: [{ id: 'q1', question: 'Question', answer: '', followUps: [] }] }] })
  assertValid(result)
  assert.equal(EXPLAIN_CONTEXT_LIMITS.projectSummary, 20_000)
  assert.equal(EXPLAIN_CONTEXT_LIMITS.glossaryHint, 4000)
})
