import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
// @ts-ignore TS5097 -- direct Node tests require explicit TypeScript extensions.
import { GENERATION_OUTPUT_POLICY_VERSION, inspectGenerationOutputText, normalizeParsed, validateCheckpointBatch, type ParsedGenerationBatch } from './generation-output-policy.ts'
// @ts-ignore TS5097 -- direct Node tests require explicit TypeScript extensions.
import { InterviewJsonStream } from './interview-json-stream.ts'
// @ts-ignore TS5097 -- direct Node tests require explicit TypeScript extensions.
import { normalizeParsed as compatibilityNormalizeParsed } from './generator.ts'
import { RESULT_LIMITS } from '@shared/result-contract'
import { GENERATION_DRAFT_MESSAGES } from '@shared/generation-checkpoint'

function withoutIds(batch: ParsedGenerationBatch): unknown {
  return {
    ...batch,
    sections: batch.sections.map(({ id: _sectionId, ...section }) => ({
      ...section,
      questions: section.questions.map(({ id: _questionId, ...question }) => question)
    }))
  }
}

function checkpoint(): ParsedGenerationBatch {
  return {
    projectSummary: 'Project',
    sections: [{ id: 'section-1', title: 'Topic', summary: 'Summary', questions: [{
      id: 'question-1', title: 'Mechanism', question: 'Why [[Term]]?', answer: 'Answer',
      followUps: [{ question: 'How?', answer: 'Detail', followUps: [] }]
    }] }],
    glossary: { Term: 'Definition' }
  }
}

function complete(reply: string) {
  const inspection = inspectGenerationOutputText(reply)
  assert.equal(inspection.kind, 'complete')
  if (inspection.kind !== 'complete') throw new Error('Expected complete inspection')
  return inspection
}

function syntaxFailure(reply: string) {
  const inspection = inspectGenerationOutputText(reply)
  assert.equal(inspection.kind, 'format-failure')
  if (inspection.kind !== 'format-failure') throw new Error('Expected format failure')
  assert.equal(inspection.reason, 'json-syntax')
  assert.deepEqual(Object.keys(inspection).sort(), ['closed', 'kind', 'reason'])
  return inspection
}

test('O01 explicit pre-extraction fields, nested follow-ups, unique UUIDs and compatibility export', () => {
  const result = normalizeParsed({
    projectSummary: '  Project  ',
    sections: [{ title: '  Architecture ', summary: ' Section summary ', questions: [{
      title: '  Stream\nordering ', question: ' Why [[Stream]]? ', answer: ' Main answer ',
      followUps: [{ question: ' First? ', answer: ' First answer ', followUps: [{
        question: ' Second? ', answer: ' Second answer ',
        followUps: [{ question: ' Third? ', answer: ' Dropped ' }]
      }] }]
    }, { question: 'Another?', answer: 'Another answer' }] }],
    glossary: { Stream: '  A stream. It delivers ordered values. ' }
  })
  assert.deepEqual(withoutIds(result), {
    projectSummary: 'Project',
    sections: [{ title: 'Architecture', summary: 'Section summary', questions: [{
      title: 'Stream ordering', question: 'Why [[Stream]]?', answer: 'Main answer',
      followUps: [{ question: 'First?', answer: 'First answer', followUps: [{
        question: 'Second?', answer: 'Second answer', followUps: []
      }] }]
    }, { question: 'Another?', answer: 'Another answer', followUps: [] }] }],
    glossary: { Stream: 'A stream. It delivers ordered values.' }
  })
  const ids = result.sections.flatMap(section => [section.id, ...section.questions.map(question => question.id)])
  assert.equal(new Set(ids).size, 3)
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(compatibilityNormalizeParsed, normalizeParsed)
})

test('O01 UUID allocation stays question-first, section-next and skips invalid entries', (t) => {
  const ids = [
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005'
  ] as const
  let next = 0
  const allocation = t.mock.method(crypto, 'randomUUID', () => ids[next++]!)
  syncBuiltinESMExports()
  try {
    const batch = normalizeParsed({ sections: [
      { questions: [null, { question: 'skip' }] },
      { questions: [{ question: 'one', answer: 'a' }, {}, { question: 'two', answer: 'b' }] },
      { questions: [{ question: 'three', answer: 'c' }] }
    ] })
    assert.deepEqual(batch.sections.map(section => [section.id, ...section.questions.map(question => question.id)]), [
      [ids[2], ids[0], ids[1]], [ids[4], ids[3]]
    ])
    assert.equal(next, 5)
  } finally {
    allocation.mock.restore()
    syncBuiltinESMExports()
  }
})

test('O02 invalid entries, title rules, own glossary keys and permissive empty normalization remain unchanged', () => {
  const glossary = Object.create({ inherited: 'Must not appear' }) as Record<string, unknown>
  for (const [key, value] of [['__proto__', ' Proto definition '], ['constructor', ' Constructor definition '], [' spaced ', ' Value '], ['empty', '  '], ['numeric', 7]] as const) {
    Object.defineProperty(glossary, key, { value, enumerable: true })
  }
  const batch = normalizeParsed({ projectSummary: 1, sections: [null, 2, {}, { title: ' ', summary: 9, questions: [
    null, { question: '  ', answer: 'discard' }, { question: 'missing answer' },
    { title: 'x'.repeat(RESULT_LIMITS.questionTitle + 1), question: ' First ', answer: ' Answer ', followUps: [
      null, {}, { question: 'bad', answer: 1 }, { question: ' okay ', answer: ' yes ', followUps: 'invalid' }
    ] },
    { title: '  Short\r\nheading\nname ', question: ' Second ', answer: ' Answer two ', followUps: {} }
  ] }], glossary })
  assert.deepEqual(withoutIds(batch), {
    projectSummary: '', sections: [{ title: '未命名主题', summary: undefined, questions: [
      { question: 'First', answer: 'Answer', followUps: [{ question: 'okay', answer: 'yes', followUps: [] }] },
      { title: 'Short heading name', question: 'Second', answer: 'Answer two', followUps: [] }
    ] }], glossary: JSON.parse('{"__proto__":"Proto definition","constructor":"Constructor definition"," spaced ":"Value"}')
  })
  assert.equal(Object.getPrototypeOf(batch.glossary), Object.prototype)
  assert.equal(Object.hasOwn(batch.glossary, '__proto__'), true)
  assert.equal(Object.hasOwn(batch.glossary, 'inherited'), false)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  for (const value of [null, 1, 'text']) assert.throws(() => normalizeParsed(value), { message: '模型输出不是 JSON 对象' })
  for (const value of [{}, [], { sections: [] }]) {
    assert.throws(() => normalizeParsed(value), { message: '模型输出中没有有效的问题（sections 为空）' })
    assert.deepEqual(normalizeParsed(value, true), { projectSummary: '', sections: [], glossary: {} })
  }
})

test('O03 checkpoint keys, fields, counts and nested contract retain mapped rejection and defensive clone', () => {
  const original = checkpoint()
  const result = validateCheckpointBatch(original)
  assert.deepEqual(result, checkpoint())
  assert.notEqual(result, original)
  assert.notEqual(result.sections[0].questions[0].followUps, original.sections[0].questions[0].followUps)
  original.projectSummary = 'mutated'
  original.sections[0].questions[0].followUps[0].answer = 'mutated'
  original.glossary.Term = 'mutated'
  assert.deepEqual(result, checkpoint())
  const base = checkpoint()
  const section = base.sections[0]
  const question = section.questions[0]
  const invalid: unknown[] = [
    null, [], { ...base, extra: true }, { sections: [], glossary: {} },
    { ...base, projectSummary: 'x'.repeat(RESULT_LIMITS.projectSummary + 1) },
    { ...base, sections: Array.from({ length: RESULT_LIMITS.sections + 1 }, () => structuredClone(section)) },
    { ...base, sections: [{ ...section, questions: Array.from({ length: RESULT_LIMITS.questionsPerSection + 1 }, () => structuredClone(question)) }] },
    { ...base, sections: [{ ...section, questions: [{ ...question, answer: 'x'.repeat(RESULT_LIMITS.answer + 1) }] }] },
    { ...base, sections: [{ ...section, questions: [{ ...question, title: 'x'.repeat(RESULT_LIMITS.questionTitle + 1) }] }] },
    { ...base, sections: [{ ...section, questions: [{ ...question, extra: true }] }] },
    { ...base, sections: [{ ...section, questions: [{ ...question, followUps: [{ question: 'nested', answer: 1 }] }] }] },
    { ...base, glossary: Object.fromEntries(Array.from({ length: RESULT_LIMITS.glossaryEntries + 1 }, (_, index) => ['term' + index, 'definition'])) },
    { ...base, glossary: { ['x'.repeat(RESULT_LIMITS.glossaryKey + 1)]: 'definition' } }
  ]
  for (const value of invalid) assert.throws(() => validateCheckpointBatch(value), { message: GENERATION_DRAFT_MESSAGES.changed })
  const undefinedSummary = checkpoint()
  undefinedSummary.sections[0].summary = undefined
  assert.equal(Object.hasOwn(validateCheckpointBatch(undefinedSummary).sections[0], 'summary'), false)
})

test('O04 actual whole reply succeeds without deltas and yields only structural information', () => {
  const inspection = complete(JSON.stringify({
    projectSummary: 'Whole reply', sections: [{ title: 'Topic', questions: [{ question: 'Question?', answer: 'Answer' }] }], glossary: {}
  }))
  assert.equal(GENERATION_OUTPUT_POLICY_VERSION, 'generation-output-policy-v1')
  assert.deepEqual(Object.keys(inspection).sort(), ['batch', 'closed', 'kind'])
  assert.deepEqual(withoutIds(inspection.batch), {
    projectSummary: 'Whole reply', sections: [{ title: 'Topic', questions: [{ question: 'Question?', answer: 'Answer', followUps: [] }] }], glossary: {}
  })
  assert.deepEqual(inspection.closed, [{ sectionIndex: 0, questionIndex: 0, section: { title: 'Topic' }, rawQuestion: { question: 'Question?', answer: 'Answer' } }])
  assert.equal(Object.hasOwn(inspection.closed[0].rawQuestion as object, 'id'), false)
})

test('O05 closed prefix positions survive both finish truncation and same-push syntax failure', () => {
  const prefix = '{"sections":[null,{"title":"Topic","questions":[null,{"question":"Closed?","answer":"Yes"},'
  for (const suffix of ['{"question":"Unfinished', 'BAD']) {
    assert.deepEqual(syntaxFailure(prefix + suffix).closed, [{
      sectionIndex: 1, questionIndex: 1, section: { title: 'Topic' }, rawQuestion: { question: 'Closed?', answer: 'Yes' }
    }])
  }
})

test('O06 duplicate root, section and question keys, extra roots and code fences reject', () => {
  for (const reply of [
    '{"sections":[],"sections":[]}',
    '{"sections":[{"title":"one","title":"two","questions":[]}]}',
    '{"sections":[{"questions":[{"question":"one","question":"two","answer":"A"}]}]}',
    '{"sections":[]}{}',
    '~~~json\n{"sections":[]}\n~~~'.replaceAll('~', String.fromCharCode(96))
  ]) syntaxFailure(reply)
})

test('O07 existing character/depth bounds and whole UTF-8 accounting stay independent of deltas', (t) => {
  const empty = '{"sections":[]}'
  complete(empty + ' '.repeat(1_000_000 - empty.length))
  assert.deepEqual(syntaxFailure(empty + ' '.repeat(1_000_001 - empty.length)).closed, [])
  complete('{"ignored":' + '['.repeat(127) + '0' + ']'.repeat(127) + '}')
  syntaxFailure('{"ignored":' + '['.repeat(128) + '0' + ']'.repeat(128) + '}')
  assert.equal(Buffer.byteLength('界'.repeat(1_000_000), 'utf8'), 3_000_000)
  assert.equal(Buffer.byteLength('\ud800'.repeat(1_000_000), 'utf8'), 3_000_000)
  assert.equal(Buffer.byteLength('😀'.repeat(500_000), 'utf8'), 2_000_000)
  assert.ok(3 * 1_000_000 < 4 * 1024 * 1024, '4 MiB cannot independently be reached below the UTF-16 character ceiling')
  const reply = JSON.stringify({ projectSummary: '界😀\ud800', sections: [] })
  const pushes: string[] = []
  const byteCounts: number[] = []
  const push = InterviewJsonStream.prototype.push
  const observed = t.mock.method(InterviewJsonStream.prototype, 'push', function (this: InterviewJsonStream, delta: string) {
    pushes.push(delta)
    const closed = push.call(this, delta)
    byteCounts.push(Object.getOwnPropertyDescriptor(this, 'sourceBytes')!.value as number)
    return closed
  })
  try {
    complete(reply)
    assert.deepEqual(pushes, [reply])
    assert.deepEqual(byteCounts, [Buffer.byteLength(reply, 'utf8')])
  } finally { observed.mock.restore() }
})

test('O08 structurally empty and metadata-only output grants no invented empty-output failure', () => {
  const inspection = complete('{"projectSummary":" Summary ","sections":[],"glossary":{"Term":" Definition "}}')
  assert.deepEqual(inspection.batch, { projectSummary: 'Summary', sections: [], glossary: { Term: 'Definition' } })
  assert.deepEqual(inspection.closed, [])
  assert.deepEqual(complete('{}').batch, { projectSummary: '', sections: [], glossary: {} })
})

test('O09 actual repeated occurrences, omitted titles and distinct answers/evidence are not deduplicated', () => {
  const questions = [null,
    { question: ' Same? ', answer: 'First', sourceEvidence: [{ ref: 'source-one' }] },
    { question: 'Same?', answer: 'Second', sourceEvidence: [{ ref: 'source-two' }] },
    { question: 'Same?', answer: 'Second', sourceEvidence: [{ ref: 'source-two' }] },
    { question: 'No answer' }
  ]
  const inspection = complete(JSON.stringify({ sections: [null, { questions }] }))
  assert.deepEqual(inspection.closed.map(object => [object.sectionIndex, object.questionIndex]), [[1, 1], [1, 2], [1, 3], [1, 4]])
  assert.deepEqual(inspection.closed.map(object => object.rawQuestion), questions.slice(1))
  assert.deepEqual(inspection.closed.map(object => object.section), Array.from({ length: 4 }, () => ({ title: '未命名主题' })))
  assert.deepEqual(withoutIds(inspection.batch), { projectSummary: '', sections: [{ title: '未命名主题', questions: [
    { question: 'Same?', answer: 'First', followUps: [] },
    { question: 'Same?', answer: 'Second', followUps: [] },
    { question: 'Same?', answer: 'Second', followUps: [] }
  ] }], glossary: {} })
})

test('O10 failures contain safe static classification; raw canaries remain transient closed data', () => {
  const canary = 'CANARY_PROVIDER_SOURCE_SECRET_73'
  const malformed = syntaxFailure('{"sections":[{"questions":[{"question":"Q","answer":"' + canary + '"},"' + canary)
  const { closed, ...metadata } = malformed
  assert.equal(JSON.stringify(metadata).includes(canary), false)
  assert.equal((closed[0].rawQuestion as { answer: string }).answer, canary)
  const invalid = inspectGenerationOutputText(JSON.stringify({ sections: [{ questions: [{ question: 'Q', answer: canary + '\0' }] }] }))
  assert.equal(invalid.kind, 'format-failure')
  if (invalid.kind !== 'format-failure') throw new Error('Expected checkpoint rejection')
  assert.equal(invalid.reason, 'checkpoint-invalid')
  assert.deepEqual(Object.keys(invalid).sort(), ['closed', 'kind', 'reason'])
  assert.equal(JSON.stringify({ kind: invalid.kind, reason: invalid.reason }).includes(canary), false)
})

test('O10 nonstring misuse and unexpected parser, allocator and clone exceptions throw', (t) => {
  for (const input of [null, undefined, {}, 1, new String('{}')]) {
    assert.throws(() => inspectGenerationOutputText(input as string), TypeError)
  }
  const internal = new SyntaxError('Internal canary must not become json-syntax')
  const brokenParser = t.mock.method(InterviewJsonStream.prototype, 'push', () => { throw internal })
  try { assert.throws(() => inspectGenerationOutputText('{}'), error => error === internal) }
  finally { brokenParser.mock.restore() }
  for (const allocationError of [new Error('Allocator canary'), new Error('模型输出不是 JSON 对象'), new Error(GENERATION_DRAFT_MESSAGES.changed)]) {
    const brokenAllocator = t.mock.method(crypto, 'randomUUID', () => { throw allocationError })
    syncBuiltinESMExports()
    try {
      assert.throws(() => inspectGenerationOutputText('{"sections":[{"questions":[{"question":"Q","answer":"A"}]}]}'), error => error === allocationError)
    } finally { brokenAllocator.mock.restore(); syncBuiltinESMExports() }
  }
  const validationError = new Error('Internal contract canary')
  const brokenValidation = t.mock.method(Object, 'getOwnPropertyDescriptors', () => { throw validationError })
  try { assert.throws(() => inspectGenerationOutputText('{}'), error => error === validationError) }
  finally { brokenValidation.mock.restore() }
  const cloneError = new Error('Clone canary')
  const brokenClone = t.mock.method(JSON, 'stringify', () => { throw cloneError })
  try { assert.throws(() => inspectGenerationOutputText('{}'), error => error === cloneError) }
  finally { brokenClone.mock.restore() }
})

test('O11 section metadata is captured at each question close, before later summary/title fields', () => {
  const inspection = complete('{"sections":[{"questions":[{"question":"Q1","answer":"A1"}],"title":"Later title","summary":"Later summary"},{"title":"Known","questions":[{"question":"Q2","answer":"A2"}],"summary":"Later second summary"}]}')
  assert.deepEqual(inspection.closed.map(object => object.section), [{ title: '未命名主题' }, { title: 'Known' }])
  assert.deepEqual(inspection.batch.sections.map(section => ({ title: section.title, summary: section.summary })), [
    { title: 'Later title', summary: 'Later summary' }, { title: 'Known', summary: 'Later second summary' }
  ])
})
