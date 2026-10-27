// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { InterviewJsonStream } from './interview-json-stream.ts'

const report = JSON.stringify({
  projectSummary: 'summary 世界',
  sections: [{ title: 'Topic', summary: 'Section summary', questions: [
    { title: 'Q1', question: 'A {brace} and \\"quote', answer: 'json: {"x":[1,{"y":"}\\\""}]}', followUps: [{ question: 'nested', answer: { deep: [1, 2] } }] },
    { question: 'Second', answer: 'tail', followUps: [] }
  ] }],
  glossary: { Alpha: 'one', 世界: 'term two' }
})

function collect(chunks: string[]): { questions: unknown[]; final: unknown; metadata: unknown } {
  const parser = new InterviewJsonStream()
  const questions = chunks.flatMap((chunk) => parser.push(chunk))
  return { questions, final: parser.finish(), metadata: parser.metadata() }
}

test('emits complete root questions exactly once across every split point', () => {
  const expected = JSON.parse(report)
  for (let split = 0; split <= report.length; split++) {
    const result = collect([report.slice(0, split), report.slice(split)])
    assert.equal(result.questions.length, 2, `split ${split}`)
    assert.deepEqual(result.questions.map((item: any) => item.question), expected.sections[0].questions, `split ${split}`)
    assert.deepEqual(result.questions.map((item: any) => [item.sectionIndex, item.questionIndex]), [[0, 0], [0, 1]])
    assert.deepEqual((result.questions[0] as any).section, { title: 'Topic', summary: 'Section summary' })
    assert.deepEqual(result.final, expected)
  }
})

test('does not emit a partial question and exposes only completed metadata values', () => {
  const parser = new InterviewJsonStream()
  assert.deepEqual(parser.push('{"projectSummary":"done","sections":[{"title":"T","questions":[{"question":"unfinished'), [])
  assert.deepEqual(parser.metadata(), { projectSummary: 'done', glossary: {} })
  assert.throws(() => parser.finish())

  const other = new InterviewJsonStream()
  other.push('{"glossary":{"complete":"ready","partial":"still')
  assert.deepEqual(other.metadata(), { projectSummary: '', glossary: { complete: 'ready' } })
})

test('supports unicode, escaped strings and all nested delimiters without confusing answer content', () => {
  const result = collect(Array.from(report, (char) => char))
  assert.equal(result.questions.length, 2)
  assert.equal((result.questions[0] as any).question.answer, JSON.parse(report).sections[0].questions[0].answer)
  assert.equal((result.metadata as any).glossary['世界'], 'term two')
})

test('rejects duplicate keys, invalid endings, extra text, excessive depth, and size overrun', () => {
  for (const invalid of [
    '{"sections":[],"sections":[]}',
    '{"sections":[{"questions":[{"question":"a","question":"b"}]}]}',
    '{"sections":[]} trailing',
    '{"sections":[{"questions":[{"question":"partial"}]}]'
  ]) {
    const parser = new InterviewJsonStream()
    assert.throws(() => { parser.push(invalid); parser.finish() })
  }
  const deep = new InterviewJsonStream()
  assert.throws(() => deep.push('{"x":' + '['.repeat(130)))
  const large = new InterviewJsonStream()
  assert.throws(() => large.push(' '.repeat(1_000_001)))
})

test('a completed question can be drained when the same delta later fails; finish still rejects', () => {
  const parser = new InterviewJsonStream()
  assert.throws(() => parser.push('{"sections":[{"questions":[{"question":"saved"}]}],"sections":[]}'))
  const pending = parser.drain()
  assert.equal(pending.length, 1)
  assert.equal((pending[0].question as any).question, 'saved')
  assert.deepEqual(parser.drain(), [])
  assert.throws(() => parser.finish())
})

test('special property names remain own JSON data without changing prototypes or inventing questions', () => {
  const source = '{"__proto__":{"sections":[{"questions":[{"question":"fake"}]}]},"sections":[{"questions":[{"__proto__":{"question":"hidden"},"question":"real","constructor":"own"}]}],"glossary":{"__proto__":"safe","constructor":"also"}}'
  const parser = new InterviewJsonStream()
  const questions = parser.push(source)
  const final = parser.finish() as any
  assert.equal(questions.length, 1)
  assert.equal((questions[0].question as any).question, 'real')
  assert.equal(Object.getPrototypeOf(questions[0].question), Object.prototype)
  assert.equal(Object.hasOwn(questions[0].question as object, '__proto__'), true)
  assert.equal((questions[0].question as any).__proto__.question, 'hidden')
  assert.equal((questions[0].question as any).constructor, 'own')
  assert.equal(Object.getPrototypeOf(final), Object.prototype)
  assert.deepEqual(parser.metadata().glossary, JSON.parse('{"__proto__":"safe","constructor":"also"}'))
  assert.equal(Object.getPrototypeOf(parser.metadata().glossary), Object.prototype)
})

test('uses a stable placeholder section when the question arrives before section title', () => {
  const parser = new InterviewJsonStream()
  const emitted = parser.push('{"sections":[{"questions":[{"question":"x"}],"title":"late"}]}')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].section.title, '未命名主题')
})

test('preview safely decodes an open report field and clears it when the question closes', () => {
  const head = JSON.stringify({ projectSummary: '概述\n世界 "quote" 中文', reasoning_content: 'private' }).slice(0, -1)
  const answer = JSON.stringify('答案\n"引号" 😀').slice(0, -1)
  const source = `${head},"sections":[{"title":"主题","questions":[{"title":"标题","question":"问题 世界","answer":${answer}`
  const parser = new InterviewJsonStream()
  for (const char of source) parser.push(char)
  const preview = parser.preview()
  assert.equal(preview.projectSummary, '概述\n世界 "quote" 中文')
  assert.deepEqual(preview.activeQuestion, {
    sectionIndex: 0,
    questionIndex: 0,
    sectionTitle: '主题',
    title: '标题',
    question: '问题 世界',
    answer: '答案\n"引号" 😀',
    followUps: []
  })
  assert.equal(JSON.stringify(preview).includes('hidden'), false)
  assert.equal(JSON.stringify(preview).includes('private'), false)
  parser.push('","apiKey":"hidden","raw":"hidden","followUps":[{"question":"追问","answer":"追答"}]}]}],"glossary":{}}')
  assert.equal(parser.preview().activeQuestion, undefined)
})

test('preview withholds incomplete escapes and never emits an unpaired surrogate', () => {
  const parser = new InterviewJsonStream()
  parser.push('{"projectSummary":"ready","sections":[{"questions":[{"question":"Q","answer":"visible\\uD83D')
  assert.equal(parser.preview().activeQuestion?.answer, 'visible')
  parser.push('\\uDE00tail')
  assert.equal(parser.preview().activeQuestion?.answer, 'visible😀tail')
})

test('preview enforces its aggregate text budget across summary and active answer', () => {
  const parser = new InterviewJsonStream()
  parser.push(`{"projectSummary":"${'概'.repeat(60_000)}","sections":[{"title":"主题","questions":[{"question":"问题","answer":"${'答'.repeat(60_000)}`)
  const preview = parser.preview()
  const active = preview.activeQuestion!
  const chars = preview.projectSummary.length + (active.sectionTitle?.length ?? 0) + (active.question?.length ?? 0) + (active.answer?.length ?? 0)
  assert.ok(chars <= 750_000, `preview text budget exceeded: ${chars}`)
})

test('preview streams only recognized partial follow-up fields', () => {
  const parser = new InterviewJsonStream()
  parser.push('{"sections":[{"title":"主题","questions":[{"question":"主问题","answer":"主答案","followUps":[{"question":"追问已到","answer":"追答正在到')
  assert.deepEqual(parser.preview().activeQuestion?.followUps, [{ question: '追问已到', answer: '追答正在到', followUps: [] }])
  parser.push('达","apiKey":"hidden"}]}]}],"glossary":{}}')
  assert.deepEqual(parser.preview().activeQuestion, undefined)
})
