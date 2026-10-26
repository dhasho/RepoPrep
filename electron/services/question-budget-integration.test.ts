// 细粒度题量预算的端到端测试（issue #9）
//
// 用真实的 buildContext（真实临时文件 + 真实文件树分组）配合伪造的模型响应，
// 覆盖「小项目」与「超过 10 个顶层模块」两种情形，并让模型**故意超额输出**，
// 验证最终题量被严格约束在承诺区间内。
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { afterEach } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { GRANULARITY_QUESTION_BUDGET, type Granularity, type LlmProfile } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { buildContext } from './context-builder.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { validateIpcArgs } from './ipc-validation.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { generateInterview, capSectionsToMax } from './generator.ts'

const tempDirs: string[] = []
const profile: LlmProfile = { id: 'p1', name: 'Mock', baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'mock-model' }

/** 造一个项目：rootFiles 个根文件 + modules 个顶层模块，每个模块 filesPerModule 个源文件 */
async function makeProject(modules: number, filesPerModule: number): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue9-fixture-'))
  tempDirs.push(root)
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n\n' + '项目说明。'.repeat(60) + '\n')
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { express: '^4.0.0' } }, null, 2)
  )
  for (let m = 0; m < modules; m++) {
    const dir = path.join(root, `mod${String(m).padStart(2, '0')}`)
    await fs.mkdir(dir, { recursive: true })
    for (let f = 0; f < filesPerModule; f++) {
      await fs.writeFile(
        path.join(dir, `file${f}.ts`),
        `export function fn${f}(x: number): number {\n  // 模块 ${m} 的第 ${f} 个文件\n  return x * ${f + 2}\n}\n`
      )
    }
  }
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/**
 * 从提示词里解析出本批要求的题量，然后**故意多出 6 题**返回，
 * 以此验证后置裁剪确实生效（而不是靠模型守规矩）。
 *
 * 每个批次使用**独立的**名词（由提示词内容派生），这样"裁剪是否会丢掉
 * 被后续题引用的词条"这类问题才会暴露——若所有批次共用同一份 glossary，
 * 该缺陷会被掩盖。
 */
function mockReplyForPrompt(prompt: string, callNo: number, titleMode: 'present' | 'missing' = 'present'): string {
  const strict = prompt.match(/严格\s*(\d+)\s*题/)
  const approx = prompt.match(/约\s*(\d+)\s*题/)
  const requested = Number(strict?.[1] ?? approx?.[1] ?? 5)
  const count = requested + 6
  // 用提示词里的批次名派生一个稳定前缀，保证各批术语互不相同
  const batchMatch = prompt.match(/模块「([^」]+)」/)
  const prefix = `${batchMatch ? `模块${batchMatch[1]}` : '全局'}请求${callNo}`

  const questions = Array.from({ length: count }, (_, i) => ({
    ...(titleMode === 'present' ? { title: `${prefix}要点${i + 1}` } : {}),
    question: `第 ${i + 1} 题（${prefix}）：这里的实现为什么这样写？`,
    answer: `参考答案 ${i + 1}，涉及 [[${prefix}术语${i + 1}]] 与 [[共用术语]]。`,
    followUps: [{ question: `追问 ${i + 1}`, answer: '追问答案', followUps: [] }]
  }))
  const glossary: Record<string, string> = { 共用术语: '各批次都会用到的名词' }
  for (let i = 1; i <= count; i++) glossary[`${prefix}术语${i}`] = `第 ${i} 个名词的解释`
  return JSON.stringify({
    projectSummary: '这是一个用于测试的项目。',
    sections: [{ title: '主题', summary: '考察点', questions }],
    glossary
  })
}

/** 用 fetch 层伪造模型响应；同时记录每次请求的提示词，便于断言配额确实下达给了模型 */
async function withMockLlm<T>(run: (prompts: string[]) => Promise<T>, titleMode: 'present' | 'missing' = 'present'): Promise<T> {
  const originalFetch = globalThis.fetch
  const prompts: string[] = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const prompt = Array.isArray(body.messages)
      ? body.messages.map((m: { content?: string }) => m.content ?? '').join('\n')
      : ''
    prompts.push(prompt)
    return new Response(JSON.stringify({ choices: [{ message: { content: mockReplyForPrompt(prompt, prompts.length, titleMode) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  try {
    return await run(prompts)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function generateFor(root: string, granularity: Granularity, titleMode: 'present' | 'missing' = 'present') {
  const scan = await scanProject(root)
  return withMockLlm(async (prompts) => {
    const result = await generateInterview({
      scan,
      granularity,
      roleFocus: 'backend',
      profile,
      signal: new AbortController().signal,
      onProgress: () => undefined
    })
    return { result, prompts }
  }, titleMode)
}

const countQuestions = (result: { sections: Array<{ questions: unknown[] }> }) =>
  result.sections.reduce((a, s) => a + s.questions.length, 0)

test('小项目：细粒度最终题量落在 25–40（模型超额输出也会被裁剪）', async () => {
  const root = await makeProject(2, 3)
  const { result, prompts } = await generateFor(root, 'fine')
  const total = countQuestions(result)
  const budget = GRANULARITY_QUESTION_BUDGET.fine
  assert.ok(total >= budget.min && total <= budget.max, `细粒度题量 ${total} 越界（应为 ${budget.min}–${budget.max}）`)
  // 提示词确实下达了配额，而不是让模型自由发挥
  assert.ok(prompts.length >= 2, `应有全局批 + 模块批，实际 ${prompts.length} 批`)
  assert.ok(prompts.every((p) => /严格\s*\d+\s*题/.test(p)), '每个批次的提示词都应带明确题量')
})

test('超过 10 个顶层模块：细粒度题量仍落在 25–40，且模块批不超过 10 个', async () => {
  const root = await makeProject(14, 2)
  const { result, prompts } = await generateFor(root, 'fine')
  const total = countQuestions(result)
  const budget = GRANULARITY_QUESTION_BUDGET.fine
  assert.ok(total >= budget.min && total <= budget.max, `细粒度题量 ${total} 越界（应为 ${budget.min}–${budget.max}）`)
  // 1 个全局批 + 最多 10 个模块批
  assert.ok(prompts.length <= 11, `批次数 ${prompts.length} 超过 1+10 上限`)
  assert.ok(prompts.length >= 2)
})

test('粗粒度与中粒度遵守各自题量区间', async () => {
  const root = await makeProject(3, 2)
  for (const granularity of ['coarse', 'medium'] as const) {
    const { result, prompts } = await generateFor(root, granularity)
    const total = countQuestions(result)
    const budget = GRANULARITY_QUESTION_BUDGET[granularity]
    assert.ok(
      total >= budget.min && total <= budget.max,
      `${granularity} 题量 ${total} 越界（应为 ${budget.min}–${budget.max}）`
    )
    assert.equal(prompts.length, 1, `${granularity} 应为单批`)
  }
})

test('生产生成链路保留标题与题目配对；缺失标题仍成功且不增加传输请求', async () => {
  const root = await makeProject(2, 3)
  const titled = await generateFor(root, 'fine', 'present')
  const untitled = await generateFor(root, 'fine', 'missing')

  assert.ok(titled.prompts.length > 1, '细粒度真实生成链路应覆盖多批合并')
  assert.equal(untitled.prompts.length, titled.prompts.length, '缺少可选标题不得触发额外请求')
  assert.equal(untitled.result.generationDiagnostics?.requestCount, titled.result.generationDiagnostics?.requestCount)
  assert.ok(countQuestions(titled.result) > 0)
  assert.ok(countQuestions(untitled.result) > 0)

  for (const section of titled.result.sections) {
    for (const question of section.questions) {
      const match = /^第 (\d+) 题（(.+)）：/.exec(question.question)
      assert.ok(match, `预期保留合成题干，实际为 ${question.question}`)
      assert.equal(question.title, `${match[2]}要点${match[1]}`, '合并或按配额裁剪后标题仍应属于原题')
    }
  }
  assert.ok(untitled.result.sections.every((section) => section.questions.every((question) => question.title === undefined)))
})

test('两个主题里的 glossary 被合并，且裁剪后不残留空 section', async () => {
  const root = await makeProject(3, 3)
  const { result } = await generateFor(root, 'fine')
  assert.ok(Object.keys(result.glossary).length > 0, 'glossary 应被合并')
  assert.ok('共用术语' in result.glossary, '各批次共用的名词应存在')
  for (const section of result.sections) {
    assert.ok(section.questions.length > 0, `不应残留空 section：${section.title}`)
  }
})

test('裁剪后：保留下来的题所引用的名词都能在 glossary 中找到（渲染不会取不到解释）', async () => {
  const root = await makeProject(4, 3)
  const { result } = await generateFor(root, 'fine')

  // 收集保留下来的题/追问文本里所有 [[名词]] 标记
  const marked = new Set<string>()
  const collect = (text: string): void => {
    for (const m of text.matchAll(/\[\[([^\[\]]+)\]\]/g)) marked.add(m[1])
  }
  const walkFollowUps = (list: Array<{ question: string; answer: string; followUps?: unknown[] }>): void => {
    for (const f of list) {
      collect(f.question)
      collect(f.answer)
      if (Array.isArray(f.followUps)) walkFollowUps(f.followUps as typeof list)
    }
  }
  for (const section of result.sections) {
    for (const q of section.questions) {
      collect(q.question)
      collect(q.answer)
      walkFollowUps(q.followUps)
    }
  }

  assert.ok(marked.size > 0, '保留下来的题里应当有名词标记')
  const missing = [...marked].filter((term) => !(term in result.glossary))
  assert.deepEqual(missing, [], `以下名词被引用但 glossary 中没有解释：${missing.join('、')}`)
})

test('产出的结果能通过 IPC 运行时校验（导出不会被拒），且 glossary 无孤儿词条', async () => {
  // 这是一条跨模块的回归约束：IPC 校验里 boundedTree 对任意对象的键数上限是 256
  // （实测边界值就是 256，glossary 自己的 maxKeys=2000 根本达不到）。
  // 旧行为下细粒度可产出 115 题、上千词条，exportMarkdown 会被判"请求内容超出允许范围"。
  const root = await makeProject(4, 3)
  const { result } = await generateFor(root, 'fine')

  // 1) 必须能通过 export:markdown 的运行时校验（否则结果页导出必失败）
  assert.doesNotThrow(() => validateIpcArgs('export:markdown', [result]), '结果应能通过 IPC 校验')

  // 2) glossary 不应残留孤儿词条：每个词条都要被保留下来的题真正引用
  const referenced = new Set<string>()
  const fromText = (text: string): void => {
    for (const m of text.matchAll(/\[\[([^\[\]]+)\]\]/g)) referenced.add(m[1])
  }
  const walk = (list: Array<{ question: string; answer: string; followUps?: unknown[] }>): void => {
    for (const f of list) {
      fromText(f.question)
      fromText(f.answer)
      if (Array.isArray(f.followUps)) walk(f.followUps as typeof list)
    }
  }
  for (const s of result.sections) {
    for (const q of s.questions) {
      fromText(q.question)
      fromText(q.answer)
      walk(q.followUps)
    }
  }
  const orphans = Object.keys(result.glossary).filter((term) => !referenced.has(term))
  assert.deepEqual(orphans, [], `不应残留孤儿词条：${orphans.slice(0, 5).join('、')}`)
  assert.ok(Object.keys(result.glossary).length > 0, 'glossary 不应被清空')
})

test('批次数必须留在预算可行区间内（钉住 MAX_MODULE_BATCHES 与 25–40 的隐式耦合）', async () => {
  // planQuestionQuotas 的区间保证只在「预算可行」时成立：
  //   下限之和 = 全局批 6 + 每模块批 2 = 6 + 2×(n-1)
  // 因此 6 + 2×(n-1) ≤ max(40) ⇒ n ≤ 18 才可能落在区间内。
  // 这里用**真实** buildContext 验证实际批次数远小于该边界；
  // 若将来有人调大 context-builder 的 MAX_MODULE_BATCHES，这条会立刻失败。
  const MAX_FEASIBLE_BATCHES = Math.floor((GRANULARITY_QUESTION_BUDGET.fine.max - 6) / 2) + 1

  for (const modules of [1, 6, 14, 30]) {
    const root = await makeProject(modules, 2)
    const scan = await scanProject(root)
    const built = await buildContext(scan, 'fine')
    assert.ok(
      built.batches.length <= MAX_FEASIBLE_BATCHES,
      `顶层模块 ${modules} 个时批次数 ${built.batches.length} 已超过可行上限 ${MAX_FEASIBLE_BATCHES}，` +
        `细粒度将无法把总量控制在 ${GRANULARITY_QUESTION_BUDGET.fine.min}–${GRANULARITY_QUESTION_BUDGET.fine.max}`
    )
  }

  // 同时验证：即便模块数远超 10，批次数也因 MAX_MODULE_BATCHES 被截断
  const root = await makeProject(30, 1)
  const built = await buildContext(await scanProject(root), 'fine')
  assert.ok(built.moduleCount <= 10, `模块批应被截断到 10，实际 ${built.moduleCount}`)
})

test('两张卡片：真实产出在极端模块数下仍落在 25–40（端到端）', async () => {
  for (const modules of [0, 1, 14, 30]) {
    const root = await makeProject(modules, 2)
    const { result } = await generateFor(root, 'fine')
    const total = result.sections.reduce((a, s) => a + s.questions.length, 0)
    const budget = GRANULARITY_QUESTION_BUDGET.fine
    assert.ok(
      total >= budget.min && total <= budget.max,
      `顶层模块 ${modules} 个时细粒度产出 ${total} 题，越界（应为 ${budget.min}–${budget.max}）`
    )
    assert.doesNotThrow(() => validateIpcArgs('export:markdown', [result]), `模块数 ${modules} 时结果应能通过 IPC 校验`)
  }
})

test('capSectionsToMax：超出上限时整段移除最小的 section，不删单题', () => {
  const q = (id: string) => ({ id, question: `q${id}`, answer: 'a', followUps: [] })
  const sections = [
    { id: 'a', title: 'A', questions: [q('1'), q('2'), q('3')] },
    { id: 'b', title: 'B', questions: [q('4')] },
    { id: 'c', title: 'C', questions: [q('5'), q('6')] }
  ] as never

  const noop = capSectionsToMax(sections, 10)
  assert.equal(noop.dropped, 0)
  assert.equal(noop.sections.length, 3)

  // 上限 5：最小的 B(1) 先被移除 → 剩 5 题，达标
  const one = capSectionsToMax(sections, 5)
  assert.equal(one.dropped, 1)
  assert.deepEqual(one.sections.map((s) => s.title), ['A', 'C'])

  // 上限 3：B(1)、C(2) 依次移除 → 只剩 A
  const two = capSectionsToMax(sections, 3)
  assert.equal(two.dropped, 3)
  assert.deepEqual(two.sections.map((s) => s.title), ['A'])

  // 上限 2：连 A 也放不下 → 全部移除
  const all = capSectionsToMax(sections, 2)
  assert.equal(all.sections.length, 0)
  assert.equal(all.dropped, 6)

  // 不修改入参
  assert.equal((sections as unknown as unknown[]).length, 3)
})

test('buildContext 为每个批次标注类型与权重，且模块批权重与体量相关', async () => {
  const root = await makeProject(3, 3)
  const scan = await scanProject(root)
  const built = await buildContext(scan, 'fine')
  const global = built.batches.filter((b) => b.kind === 'global')
  const modules = built.batches.filter((b) => b.kind === 'module')
  assert.equal(global.length, 1, '应恰好一个全局批')
  assert.equal(modules.length, built.moduleCount)
  assert.ok(modules.length >= 1)
  for (const batch of built.batches) {
    assert.ok(batch.weight > 0 && Number.isFinite(batch.weight), `${batch.label} 权重非法：${batch.weight}`)
  }
})
