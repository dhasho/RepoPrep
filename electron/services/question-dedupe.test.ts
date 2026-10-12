// Question normalization and end-to-end compensation regressions for issue #91.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { afterEach } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { CONTEXT_CHAR_BUDGETS, CONTEXT_TRUNCATION_WARNING } from '../../shared/context-budget.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { GRANULARITY_QUESTION_BUDGET, type Section, type LlmProfile } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { generateInterview } from './generator.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { mergeWithCompensation } from './generator.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { resultToMarkdown } from './markdown-export.ts'
import {
  MAX_COMPENSATION_INSTRUCTION_CHARS,
  buildCompensationInstruction,
  normalizeQuestionKey,
  selectUniqueQuestions
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
} from './question-dedupe.ts'

const tempDirs: string[] = []
const profile: LlmProfile = {
  id: 'issue91-profile',
  name: 'Mock',
  baseUrl: 'https://mock.example/v1',
  apiKey: 'fake-key-issue91-must-not-leak',
  model: 'mock-model'
}

function makeSection(title: string, questions: Section['questions']): Section {
  return { id: `section-${title}`, title, questions }
}

function question(text: string, id = text, answer = `Answer for ${text}`): Section['questions'][number] {
  return { id, question: text, answer, followUps: [] }
}

async function mergeGlossaryCases(responses: Array<{
  sections: Section[]
  glossary: Record<string, string>
}>, quotas: number[]) {
  return mergeWithCompensation({
    budget: { min: quotas.reduce((sum, quota) => sum + quota, 0), target: quotas.reduce((sum, quota) => sum + quota, 0), max: 40 },
    batches: quotas.map((_quota, index) => ({ label: `batch ${index}` })),
    quotas,
    total: quotas.reduce((sum, quota) => sum + quota, 0),
    requestBatch: async (index) => ({ projectSummary: '', ...responses[index] })
  })
}

test('glossary follows retained questions across duplicates, quotas, and nested follow-ups', async () => {
  const mixed = await mergeGlossaryCases([
    {
      sections: [makeSection('first', [question('Original question [[Shared]]', 'original', 'Original answer [[Shared]]')])],
      glossary: { Shared: 'Original definition' }
    },
    {
      sections: [makeSection('second', [
        question('Original question [[Shared]]', 'duplicate', 'Changed answer [[DiscardedOnly]]'),
        question('New question [[Shared]]', 'new', 'New answer [[NewTerm]]')
      ])],
      glossary: { Shared: 'Later definition', DiscardedOnly: 'Discarded definition', NewTerm: 'New definition' }
    }
  ], [1, 1])
  const mixedQuestions = mixed.sections.flatMap((section) => section.questions)
  assert.equal(mixedQuestions.find((item) => item.id === 'original')?.answer, 'Original answer [[Shared]]')
  assert.equal(mixedQuestions.some((item) => item.id === 'duplicate'), false)
  assert.equal(mixed.glossary.Shared, 'Original definition')
  assert.equal(mixed.glossary.NewTerm, 'New definition')
  assert.equal(Object.hasOwn(mixed.glossary, 'DiscardedOnly'), false)

  const quotaDropped = await mergeGlossaryCases([
    {
      sections: [makeSection('quota', [question('Kept without term'), question('Dropped question [[QuotaTerm]]')])],
      glossary: { QuotaTerm: 'Dropped-only definition' }
    },
    {
      sections: [makeSection('later', [question('Later retained [[QuotaTerm]]')])],
      glossary: { QuotaTerm: 'Later retained definition' }
    }
  ], [1, 1])
  assert.equal(quotaDropped.glossary.QuotaTerm, 'Later retained definition')

  const nestedQuestion = question('Top-level question', 'nested')
  nestedQuestion.followUps = [{
    question: 'Nested follow-up [[NestedTerm]]',
    answer: 'Nested answer',
    followUps: [{ question: 'Second level [[DeepTerm]]', answer: 'Deep answer', followUps: [] }]
  }]
  const nested = await mergeGlossaryCases([
    { sections: [makeSection('nested', [nestedQuestion])], glossary: { NestedTerm: 'Nested definition', DeepTerm: 'Deep definition' } }
  ], [1])
  assert.equal(nested.glossary.NestedTerm, 'Nested definition')
  assert.equal(nested.glossary.DeepTerm, 'Deep definition')
})

test('normalization folds NFKC, term marks, case, and whitespace', () => {
  assert.equal(normalizeQuestionKey('  ＡPI [[Ｓｅｒｖｅｒ]]\t STATUS  '), 'api server status')
  assert.equal(normalizeQuestionKey('API server status'), normalizeQuestionKey('api   server\nstatus'))
  assert.notEqual(normalizeQuestionKey('What is [[Redis]]?'), normalizeQuestionKey('What is [[Kafka]]?'))
})

test('duplicates do not spend quota, and quota-dropped keys remain eligible later', () => {
  const seen = new Set(['already kept'])
  const selected = selectUniqueQuestions(
    [makeSection('first', [question('Already kept'), question('New question'), question('Beyond quota')])],
    1,
    seen
  )
  assert.equal(selected.kept, 1)
  assert.equal(selected.dropped, 1)
  assert.equal(selected.duplicates, 1)
  assert.deepEqual(selected.sections.flatMap((s) => s.questions.map((q) => q.question)), ['New question'])
  assert.ok(!seen.has(normalizeQuestionKey('Beyond quota')))

  const later = selectUniqueQuestions(
    [makeSection('later', [question('Beyond quota')])],
    1,
    seen
  )
  assert.equal(later.kept, 1)
  assert.equal(later.sections[0].questions[0].question, 'Beyond quota')
})

test('the first retained question object wins across initial batches', () => {
  const first = question('ＡPI [[Server]] status', 'original-id', 'original answer')
  const seen = new Set<string>()
  const initial = selectUniqueQuestions([makeSection('global', [first])], 1, seen)
  const next = selectUniqueQuestions(
    [makeSection('module', [question('api server STATUS', 'later-id', 'later answer')])],
    1,
    seen
  )
  assert.equal(initial.sections[0].questions[0].id, 'original-id')
  assert.equal(next.kept, 0)
  assert.equal(next.duplicates, 1)
})

test('compensation context is bounded and clips at a Unicode code point boundary', () => {
  const delivered = 1
  const gap = 24
  const ask = 24
  const prefix =
    `这是补充请求：此前该部分已保留 ${delivered} 题，总量还差 ${gap} 题。` +
    `请再补充 ${ask} 个此前没有覆盖到的考察点，不要重复已有问题。\n` +
    '以下是已保留的问题，请避开这些问题：\n'
  const omission = '…（其余问题省略）'
  const clippedQuestionChars = MAX_COMPENSATION_INSTRUCTION_CHARS - prefix.length - omission.length - 4
  const assertValidUnicode = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1)
        assert.ok(next >= 0xdc00 && next <= 0xdfff, `isolated high surrogate at ${index}`)
        index++
      } else {
        assert.ok(code < 0xdc00 || code > 0xdfff, `isolated low surrogate at ${index}`)
      }
    }
  }

  for (const prefixLength of [clippedQuestionChars - 1, clippedQuestionChars]) {
    const instruction = buildCompensationInstruction({
      delivered,
      gap,
      ask,
      sections: [makeSection('module', [question(`${'Q'.repeat(prefixLength)}😀${'界'.repeat(9000)}`)])]
    })
    assert.ok(instruction.length <= MAX_COMPENSATION_INSTRUCTION_CHARS)
    assert.ok(instruction.includes(omission))
    assertValidUnicode(instruction)
  }
})

async function makeProject(readmeChars = 0): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-issue91-'))
  tempDirs.push(root)
  const readme = readmeChars
    ? `# Issue 91 fixture\n\n${'R'.repeat(readmeChars)}\n`
    : '# Issue 91 fixture\n\nA small test project.\n'
  await fs.writeFile(path.join(root, 'README.md'), readme)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'main.ts'), 'export const answer = 42\n')
  return root
}

afterEach(async () => {
  const tempRoot = path.resolve(os.tmpdir())
  for (const dir of tempDirs.splice(0)) {
    const absolute = path.resolve(dir)
    assert.equal(path.dirname(absolute), tempRoot, 'temporary fixture must be a direct child of the OS temp directory')
    assert.ok(path.basename(absolute).startsWith('projectlens-issue91-'), 'temporary fixture must use its dedicated prefix')
    await fs.rm(absolute, { recursive: true, force: true })
  }
})

type CapturedCall = { contents: string[]; prompt: string }

async function generateCompensationCase(replacement: 'duplicates' | 'new' | 'mixed') {
  const root = await makeProject()
  const scan = await scanProject(root)
  const originalFetch = globalThis.fetch
  const calls: CapturedCall[] = []
  const progress: Array<{ step: string; detail?: string }> = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const messages = Array.isArray(body.messages) ? body.messages as Array<{ content?: string }> : []
    const contents = messages.map((message) => message.content ?? '')
    const prompt = contents.join('\n')
    calls.push({ contents, prompt })

    let questions: Array<{ question: string; answer: string; followUps: unknown[] }>
    const projectSummary = calls.length <= 2 ? 'Initial summary' : 'Duplicate response summary must not replace it'
    let glossary: Record<string, string> = {}
    if (calls.length === 1) {
      questions = Array.from({ length: 12 }, (_, index) => ({
        question: `Global question ${String(index + 1).padStart(2, '0')}`,
        answer: `Global answer ${index + 1}`,
        followUps: []
      }))
    } else if (calls.length === 2) {
      questions = Array.from({ length: 11 }, (_, index) => ({
        question: `Module question ${String(index + 1).padStart(2, '0')}`,
        answer: index === 0 ? 'Original answer [[kept-term]]' : `Module answer ${index + 1}`,
        followUps: []
      }))
      glossary = { 'kept-term': 'A retained definition' }
    } else if (replacement === 'duplicates') {
      questions = [
        { question: 'Module question 01', answer: 'Changed answer [[orphan-term]]', followUps: [] },
        { question: 'Module question 02', answer: 'Changed answer two', followUps: [] }
      ]
      glossary = { 'orphan-term': 'This duplicate-only glossary entry must be discarded' }
    } else if (replacement === 'mixed' && calls.length === 3) {
      questions = [
        { question: 'Module question 01', answer: 'Changed answer [[orphan-term]]', followUps: [] },
        { question: 'A retained mixed compensation question', answer: 'A new answer [[new-term]]', followUps: [] }
      ]
      glossary = {
        'kept-term': 'A conflicting definition from a discarded duplicate',
        'new-term': 'Definition for the retained mixed question',
        'orphan-term': 'Definition referenced only by the discarded duplicate'
      }
    } else if (replacement === 'mixed') {
      questions = [{ question: 'The final mixed compensation question', answer: 'Final answer', followUps: [] }]
    } else {
      questions = [
        { question: 'A genuinely new compensation question 01', answer: 'A new answer', followUps: [] },
        { question: 'A genuinely new compensation question 02', answer: 'Another new answer', followUps: [] }
      ]
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        projectSummary,
        sections: [{ title: 'Test questions', summary: 'Initial section summary', questions }],
        glossary
      }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    const result = await generateInterview({
      scan,
      granularity: 'fine',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
    return { result, calls, progress }
  } finally {
    globalThis.fetch = originalFetch
  }
}

function questionList(sections: Section[]): Section['questions'] {
  return sections.flatMap((section) => section.questions)
}

test('generateInterview keeps the true shortfall after two duplicate-only compensations', async () => {
  const { result, calls, progress } = await generateCompensationCase('duplicates')
  const questions = questionList(result.sections)
  const budget = GRANULARITY_QUESTION_BUDGET.fine
  assert.equal(calls.length, 4, 'one global, one module, and at most two compensation requests')
  assert.equal(questions.length, 23)
  assert.ok(questions.length <= budget.max)
  assert.equal(new Set(questions.map((item) => normalizeQuestionKey(item.question))).size, 23)
  assert.equal(questions.length, budget.min - 2)
  assert.ok(progress.some(({ step, detail }) => step === '整理结果' && detail?.includes('少 2 题')))
  assert.ok(!result.projectSummary.includes('Duplicate response'))
  assert.ok(!('orphan-term' in result.glossary))

  const first = questions.find((item) => item.question === 'Module question 01')
  assert.ok(first)
  assert.equal(first.answer, 'Original answer [[kept-term]]')
  assert.ok(first.id)
  assert.ok('kept-term' in result.glossary)
  assert.ok(!JSON.stringify(result).includes('fake-key-issue91-must-not-leak'))
  assert.ok(!JSON.stringify(progress).includes('fake-key-issue91-must-not-leak'))
  assert.ok(calls.every((call) => !call.prompt.includes('fake-key-issue91-must-not-leak')))

  const compensation = calls[2]
  assert.ok(compensation.prompt.includes('Module question 01'))
  assert.ok(compensation.prompt.includes('Module question 02'))
  const userPrompt = compensation.contents[1] ?? ''
  const extraStart = userPrompt.indexOf('- 补充说明：')
  const extraEnd = userPrompt.indexOf('\n## 输出 JSON 结构', extraStart)
  assert.ok(extraStart >= 0)
  assert.ok(extraEnd > extraStart)
  assert.ok(userPrompt.slice(extraStart + '- 补充说明：'.length, extraEnd).length <= MAX_COMPENSATION_INSTRUCTION_CHARS)
  assert.ok(calls.every((call) => call.contents.reduce((sum, content) => sum + content.length, 0) <= CONTEXT_CHAR_BUDGETS.fine))

  const markdown = resultToMarkdown(result)
  const markdownQuestionNumbers = [...markdown.matchAll(/^### Q(\d+)\./gm)].map((match) => Number(match[1]))
  assert.equal(markdownQuestionNumbers.length, 23)
  assert.ok(markdown.includes('### Q23.'))
  assert.ok(!markdown.includes('### Q24.'))
})

test('two new compensation questions reach the 25-question minimum', async () => {
  const { result, calls } = await generateCompensationCase('new')
  const questions = questionList(result.sections)
  assert.equal(calls.length, 3)
  assert.equal(questions.length, GRANULARITY_QUESTION_BUDGET.fine.min)
  assert.ok(questions.length <= GRANULARITY_QUESTION_BUDGET.fine.max)
  assert.ok(questions.some((item) => item.question === 'A genuinely new compensation question 01'))
})

test('mixed duplicate and retained compensation questions preserve first glossary ownership through Markdown', async () => {
  const { result, calls } = await generateCompensationCase('mixed')
  const questions = questionList(result.sections)
  assert.equal(calls.length, 4, 'the mixed compensation response leaves one question for the second round')
  assert.equal(questions.length, GRANULARITY_QUESTION_BUDGET.fine.min)
  assert.equal(new Set(questions.map((item) => normalizeQuestionKey(item.question))).size, questions.length)

  const original = questions.find((item) => item.question === 'Module question 01')
  assert.equal(original?.answer, 'Original answer [[kept-term]]')
  assert.equal(result.glossary['kept-term'], 'A retained definition')
  assert.equal(result.glossary['new-term'], 'Definition for the retained mixed question')
  assert.equal(Object.hasOwn(result.glossary, 'orphan-term'), false)

  const markdown = resultToMarkdown(result)
  assert.ok(markdown.includes('| kept-term | A retained definition |'))
  assert.ok(markdown.includes('| new-term | Definition for the retained mixed question |'))
  assert.ok(!markdown.includes('discarded duplicate'))
})

test('large invalid reply is clipped for repair without marking complete project context truncated', async () => {
  const root = await makeProject()
  const scan = await scanProject(root)
  const originalFetch = globalThis.fetch
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const progress: Array<{ step: string; detail?: string }> = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : []
    requests.push({ messages })
    const content = requests.length === 1
      ? `invalid reply ${'x'.repeat(20_100)}`
      : JSON.stringify({
        projectSummary: 'Complete project summary',
        sections: [{ title: 'Project questions', questions: Array.from({ length: 30 }, (_, index) => ({
          question: `Project question ${index + 1}`,
          answer: `Project answer ${index + 1}`,
          followUps: []
        })) }],
        glossary: {}
      })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch

  try {
    const result = await generateInterview({
      scan,
      granularity: 'fine',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
    assert.equal(requests.length, 3, 'the initial global call is repaired before the module request')
    const initialProjectPrompt = requests[0].messages.find((message) => message.role === 'user')?.content
    const repairProjectPrompt = requests[1].messages.find((message) => message.role === 'user')?.content
    assert.ok(initialProjectPrompt)
    assert.equal(Buffer.from(repairProjectPrompt ?? '').toString('hex'), Buffer.from(initialProjectPrompt).toString('hex'))
    const repairedReply = requests[1].messages.find((message) => message.role === 'assistant')?.content ?? ''
    assert.equal(repairedReply.length, 20_000)
    assert.ok(repairedReply.endsWith('…（已截断）'))
    assert.equal(result.contextTruncation, undefined)
    assert.equal(JSON.stringify(progress).includes(CONTEXT_TRUNCATION_WARNING), false)
    assert.equal(JSON.stringify(result).includes(CONTEXT_TRUNCATION_WARNING), false)
    assert.equal(resultToMarkdown(result).includes(CONTEXT_TRUNCATION_WARNING), false)
    assert.ok(requests.every(({ messages }) => messages.reduce((sum, message) => sum + message.content.length, 0) <= CONTEXT_CHAR_BUDGETS.fine))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('near-budget project context still fits bounded duplicate history through the final message fitter', async () => {
  const root = await makeProject(225_000)
  assert.ok(Buffer.byteLength(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'utf8') < 256 * 1024)
  const scan = await scanProject(root)
  const originalFetch = globalThis.fetch
  const calls: CapturedCall[] = []
  const progress: Array<{ step: string; detail?: string }> = []
  const longGlobalQuestion = (index: number) => `Global question ${String(index).padStart(2, '0')} ${'G'.repeat(1400)}`
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const messages = Array.isArray(body.messages) ? body.messages as Array<{ content?: string }> : []
    const contents = messages.map((message) => message.content ?? '')
    const prompt = contents.join('\n')
    calls.push({ contents, prompt })
    const isCompensation = prompt.includes('- 补充说明：')
    const isModule = prompt.includes('本次只分析项目的单个模块')
    const questions = isCompensation
      ? [longGlobalQuestion(1), longGlobalQuestion(2)].map((text) => ({ question: text, answer: 'Duplicate answer', followUps: [] }))
      : isModule
        ? Array.from({ length: 12 }, (_, index) => ({ question: `Module question ${String(index + 1).padStart(2, '0')}`, answer: 'Module answer', followUps: [] }))
        : Array.from({ length: 11 }, (_, index) => ({ question: longGlobalQuestion(index + 1), answer: 'Global answer', followUps: [] }))
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        projectSummary: isCompensation ? 'Duplicate summary' : 'Initial summary',
        sections: [{ title: isModule ? 'Module questions' : 'Global questions', questions }],
        glossary: {}
      }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    const result = await generateInterview({
      scan,
      granularity: 'fine',
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
    assert.equal(calls.length, 4, 'duplicate-only compensation remains bounded to two rounds')
    assert.equal(questionList(result.sections).length, 23)
    assert.equal(new Set(questionList(result.sections).map((item) => normalizeQuestionKey(item.question))).size, 23)
    assert.ok(progress.some(({ step, detail }) => step === '整理结果' && detail?.includes('少 2 题')))
    assert.ok(questionList(result.sections).length <= GRANULARITY_QUESTION_BUDGET.fine.max)
    assert.ok(result.contextTruncation?.requestTruncated, 'the large README must exercise the final message fitter')
    assert.ok(calls.every((call) => call.contents.reduce((sum, content) => sum + content.length, 0) <= CONTEXT_CHAR_BUDGETS.fine))

    const compensationPrompt = calls[2].contents[1] ?? ''
    const extraStart = compensationPrompt.indexOf('- 补充说明：')
    const extraEnd = compensationPrompt.indexOf('\n## 输出 JSON 结构', extraStart)
    assert.ok(extraStart >= 0 && extraEnd > extraStart)
    const extra = compensationPrompt.slice(extraStart + '- 补充说明：'.length, extraEnd)
    assert.ok(extra.length <= MAX_COMPENSATION_INSTRUCTION_CHARS)
    assert.ok(extra.length >= 7900, `large retained history should approach the 8k cap, got ${extra.length}`)
    assert.ok(extra.includes('Global question 01'))
    assert.ok(extra.includes('（其余问题省略）'), 'the prompt must state where prior-question history was omitted')
  } finally {
    globalThis.fetch = originalFetch
  }
})
