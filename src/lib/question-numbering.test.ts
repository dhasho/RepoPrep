// 题号计算的回归测试（issue #11）
//
// 复现的原始缺陷：结果页用**过滤后**的 section 下标去查**原始** sections，
// 于是题号随搜索词变化，并在错位时返回 0 显示成 Q0。
// 这里把同一套"过滤"逻辑与稳定序号做对照，覆盖验收标准要求的三种情形。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type React from 'react'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { stripTermMarks, type InterviewResult, type QuestionItem, type Section } from '../../shared/types.ts'
import {
  buildQuestionNumbers,
  formatQuestionNumber,
  numberOf,
  sectionNumberOf
  // @ts-expect-error Node strip-types requires the explicit extension; project bundler resolution does not.
} from './question-numbering.ts'

function question(id: string, text: string): QuestionItem {
  return { id, question: text, answer: `答案 ${text}`, followUps: [] }
}

/** 3 个 section，题量分别为 2 / 3 / 1，全局序号 1..6 */
function makeResult(): InterviewResult {
  const sections: Section[] = [
    { id: 's1', title: '架构', questions: [question('q1', '架构如何分层'), question('q2', '选型理由')] },
    {
      id: 's2',
      title: '模块',
      questions: [question('q3', '模块边界'), question('q4', '数据流'), question('q5', '状态管理')]
    },
    { id: 's3', title: '性能', questions: [question('q6', '性能瓶颈')] }
  ]
  return {
    version: 1,
    createdAt: '2026-10-06T00:00:00.000Z',
    projectName: 'demo',
    projectPath: 'C:\\demo',
    granularity: 'fine',
    roleFocus: 'backend',
    profileId: 'p1',
    modelUsed: 'm',
    projectSummary: '',
    sections,
    glossary: {}
  }
}

/** 与 ResultPage 的 filtered useMemo 保持一致的过滤逻辑（含跨 section 过滤） */
function filterSections(result: InterviewResult, search: string): Section[] {
  const query = search.trim().toLowerCase()
  if (!query) return result.sections
  return result.sections
    .map((s) => ({
      ...s,
      questions: s.questions.filter((q) => {
        const text = [q.question, q.answer, ...q.followUps.flatMap((f) => [f.question, f.answer])]
          .map(stripTermMarks)
          .join('\n')
        return text.toLowerCase().includes(query)
      })
    }))
    .filter((s) => s.questions.length > 0)
}

test('稳定序号：与原始顺序一致，且连续跨 section', () => {
  const result = makeResult()
  const map = buildQuestionNumbers(result.sections)
  // 6 个位置键 + 6 个 id 键
  assert.equal(map.size, 12)
  assert.deepEqual(
    ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map((id) => numberOf(map, id)),
    [1, 2, 3, 4, 5, 6]
  )
  // section 序号
  assert.deepEqual(
    ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map((id) => sectionNumberOf(map, id)),
    [1, 1, 2, 2, 2, 3]
  )
})

test('任意搜索条件下题号都与未过滤一致（验收标准 1）', () => {
  const result = makeResult()
  const map = buildQuestionNumbers(result.sections)
  const searches = ['', '架构', '模块', '性能', '数据流', '答案', '状态', '不存在的词']

  for (const search of searches) {
    const filtered = filterSections(result, search)
    for (const section of filtered) {
      for (const q of section.questions) {
        const boundId = q.id
        const expected = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].indexOf(boundId) + 1
        assert.equal(
          numberOf(map, boundId),
          expected,
          `搜索「${search}」时 ${boundId} 的题号应恒为 ${expected}`
        )
      }
    }
  }
})

test('移除前置 section 后，剩余问题的题号不变且不出现 0（验收标准 2）', () => {
  const result = makeResult()
  const map = buildQuestionNumbers(result.sections)

  // 只保留第 3 个 section：过滤后 si=0，但 q6 的题号必须仍是 6、section 序号仍是 3
  const filtered = filterSections(result, '性能')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, 's3')

  for (const q of filtered[0].questions) {
    assert.equal(numberOf(map, q.id), 6, '题号不应因前面的 section 被过滤而改变')
    assert.notEqual(numberOf(map, q.id), 0, '不得出现 Q0')
    assert.equal(sectionNumberOf(map, q.id), 3, 'section 序号应保持原始值 3，而不是过滤后的 1')
  }
})

test('section 内前置问题被过滤后，剩余问题的题号不变（验收标准 2）', () => {
  const result = makeResult()
  const map = buildQuestionNumbers(result.sections)

  // 只匹配 s2 里的 "状态管理"（原始题号 5），其前面的 q3/q4 都被过滤掉
  const filtered = filterSections(result, '状态管理')
  assert.equal(filtered.length, 1)
  const ids = filtered[0].questions.map((q) => q.id)
  assert.deepEqual(ids, ['q5'])
  assert.equal(numberOf(map, 'q5'), 5)
  assert.notEqual(numberOf(map, 'q5'), 0)
})

test('跨 section 过滤：命中的问题分散在多个 section 时题号各自正确（验收标准 3）', () => {
  const result = makeResult()
  const map = buildQuestionNumbers(result.sections)

  // 「模块」同时出现在 s2 的标题与 q3 的题干，构造跨 section 命中：用不会命中的词逐个验证
  for (const [search, expected] of [
    ['架构', { q1: 1 }],
    ['数据流', { q4: 4 }],
    ['性能瓶颈', { q6: 6 }],
    ['选型理由', { q2: 2 }],
    ['模块边界', { q3: 3 }]
  ] as Array<[string, Record<string, number>]>) {
    const filtered = filterSections(result, search)
    const visible = filtered.flatMap((s) => s.questions.map((q) => q.id))
    assert.deepEqual(visible, Object.keys(expected), `搜索「${search}」的可见集合`)
    for (const [id, n] of Object.entries(expected)) {
      assert.equal(numberOf(map, id), n)
    }
  }

  // 真正跨 section：让两个 section 各命中一题
  const crossQuery = '答案'
  const cross = filterSections(result, crossQuery)
  assert.ok(cross.length >= 2, '应命中多个 section')
  const allNumbers = cross.flatMap((s) => s.questions.map((q) => numberOf(map, q.id)))
  assert.deepEqual(allNumbers, [1, 2, 3, 4, 5, 6], '跨 section 时题号应保持原始顺序')
  assert.ok(allNumbers.every((n) => n > 0), '不得出现 0')
})

test('formatQuestionNumber：两位补零，未知序号显示 Q--', () => {
  assert.equal(formatQuestionNumber(1), 'Q01')
  assert.equal(formatQuestionNumber(6), 'Q06')
  assert.equal(formatQuestionNumber(12), 'Q12')
  assert.equal(formatQuestionNumber(123), 'Q123')
  assert.equal(formatQuestionNumber(0), 'Q--')
  assert.equal(formatQuestionNumber(-1), 'Q--')
})

test('查不到的问题返回 0，由调用方显示 Q--（不伪造编号）', () => {
  const result = makeResult()
  const map = buildQuestionNumbers(result.sections)
  assert.equal(numberOf(map, 'not-exist'), 0)
  assert.equal(formatQuestionNumber(numberOf(map, 'not-exist')), 'Q--')
  assert.equal(sectionNumberOf(map, 'not-exist', undefined, 9), 9, 'section 序号应使用兜底值')
})

test('位置键是权威来源：重复 id 时各位置仍拿到各自正确的题号', () => {
  const dup: Section[] = [
    { id: 's1', title: 'a', questions: [question('same', '第一个'), question('q2', '第二个')] },
    { id: 's2', title: 'b', questions: [question('same', '第三个')] }
  ]
  const map = buildQuestionNumbers(dup)
  // 位置键：每个位置都有唯一且正确的题号
  assert.equal(numberOf(map, 'same', { sectionIndex: 0, questionIndex: 0 }), 1)
  assert.equal(numberOf(map, 'same', { sectionIndex: 1, questionIndex: 0 }), 3, '第二个 same 的题号应为 3')
  assert.equal(numberOf(map, 'q2', { sectionIndex: 0, questionIndex: 1 }), 2)
  // id 快路径保留首次出现的位置，不会被子句覆盖
  assert.equal(numberOf(map, 'same'), 1)
  assert.equal(map.size, 5, '3 个位置键 + 2 个 id 键（重复 id 只记一次）')
})

test('缺 id 的历史结果：按位置仍能算出正确题号，不会退化成 Q--', () => {
  // loadResult 直接把磁盘 JSON 当 InterviewResult 用，不校验也不迁移，
  // 因此历史/手工编辑的结果可能缺少 question.id。此时位置键保证编号仍然正确。
  const legacy = [
    {
      id: 's1',
      title: 'A',
      questions: [
        { question: '旧题一', answer: 'a', followUps: [] },
        { question: '旧题二', answer: 'a', followUps: [] }
      ]
    },
    {
      id: 's2',
      title: 'B',
      questions: [{ question: '旧题三', answer: 'a', followUps: [] }]
    }
  ] as unknown as Section[]

  const map = buildQuestionNumbers(legacy)
  assert.equal(numberOf(map, undefined, { sectionIndex: 0, questionIndex: 0 }), 1)
  assert.equal(numberOf(map, undefined, { sectionIndex: 0, questionIndex: 1 }), 2)
  assert.equal(numberOf(map, undefined, { sectionIndex: 1, questionIndex: 0 }), 3)
  assert.equal(sectionNumberOf(map, undefined, { sectionIndex: 1, questionIndex: 0 }), 2)
  // 只给 id（没有位置）时才是 Q--，这是预期的降级
  assert.equal(formatQuestionNumber(numberOf(map, undefined)), 'Q--')
})

test('空结果与空 section 不会抛错', () => {
  assert.equal(buildQuestionNumbers([]).size, 0)
  const empty: Section[] = [{ id: 's', title: 't', questions: [] }]
  const map = buildQuestionNumbers(empty)
  assert.equal(map.size, 0)
})

test('重复 id 只记首次出现的位置（id 快路径不被子句覆盖）', () => {
  const dup: Section[] = [
    { id: 's1', title: 'a', questions: [question('same', '第一个'), question('q2', '第二个')] },
    { id: 's2', title: 'b', questions: [question('same', '第三个')] }
  ]
  const map = buildQuestionNumbers(dup)
  assert.equal(numberOf(map, 'same'), 1, '重复 id 应保持首次出现的题号')
  // 3 个位置键 + 2 个 id 键（重复的那个只记一次）
  assert.equal(map.size, 5)
})

// ---------- 组件级断言 ----------
//
// 上半部分的测试只验证"序号映射"本身。若 ResultPage 内部把
// `buildQuestionNumbers(result.sections)` 误写成 `filtered`（正是 issue #11 的缺陷类别），
// 那些测试仍然全绿。下面通过渲染**真实组件**来覆盖这一层。
// 产物由 scripts/build-render-test.mjs 预先生成（见 package.json 的 test:renderer）。

interface RenderHarness {
  render: (result: unknown, search: string) => string
}

async function loadRenderHarness(): Promise<RenderHarness | null> {
  // 产物路径固定（见 package.json 的 test:renderer），不依赖环境变量，跨平台一致
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundlePath = path.join(here, '..', '..', '.render-test', 'result-page.cjs')
  const fs = await import('node:fs/promises')
  try {
    await fs.access(bundlePath)
  } catch {
    return null
  }
  // 产物是 CJS（react/react-dom 为 external，必须由 Node 自己解析）。
  // 组件里会引用 window（模块级的 window.api 与 useLayoutEffect 的尺寸读取），
  // Node 渲染时用一个最小桩满足它；只做静态渲染，不会真正调用这些分支。
  const { createRequire } = await import('node:module')
  const requireBundle = createRequire(import.meta.url)
  const g = globalThis as unknown as { window?: unknown }
  const previousWindow = g.window
  let mod: { default?: unknown }
  try {
    g.window = { innerWidth: 1280, innerHeight: 800, api: undefined }
    mod = requireBundle(bundlePath) as { default?: unknown }
  } finally {
    g.window = previousWindow
  }
  const ResultPage = mod?.default as React.ComponentType<Record<string, unknown>> | undefined
  if (!ResultPage) return null
  const React = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  return {
    render: (result, search) =>
      renderToStaticMarkup(
        React.createElement(ResultPage, {
          result,
          settings: { profiles: [], defaultProfileId: null },
          onRegenerate: () => undefined,
          initialSearch: search
        })
      )
  }
}

/** 从渲染出的 HTML 里取出题号徽标（卡片与大纲都会渲染 Qxx） */
function badges(html: string): string[] {
  return [...html.matchAll(/Q\d{2}/g)].map((m) => m[0])
}

/**
 * 取出 section 标题里的两位序号。
 * 必须精确定位到那个 span（class 为 mr-2 text-slate-300），
 * 不能用「整页找 00」这种宽泛断言 —— 页面上的时间戳 `08:00:00` 会误报。
 */
function sectionNumbers(html: string): string[] {
  return [...html.matchAll(/class="mr-2 text-slate-300">(\d{2})</g)].map((m) => m[1])
}

test('组件级：真实渲染 ResultPage，题号不随过滤变化（验收标准 1+2）', async (t) => {
  const harness = await loadRenderHarness()
  if (!harness) {
    t.skip('未提供 RENDER_PAGE_BUNDLE（请用 npm run test:renderer 运行）')
    return
  }
  const result = makeResult() as unknown

  // 未过滤：6 题连续编号，且大纲与卡片一致
  const plain = badges(harness.render(result, ''))
  for (const n of ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06']) {
    assert.ok(plain.includes(n), `未过滤时应渲染出 ${n}`)
  }
  assert.ok(!plain.includes('Q00'), '不应出现 Q00')

  // 只命中第 3 个 section：题号必须仍是原序号，而不是被重排成 Q01
  const tail = badges(harness.render(result, '性能瓶颈'))
  assert.ok(tail.includes('Q06'), `只保留最后一个 section 时应显示 Q06，实际 ${JSON.stringify(tail)}`)
  assert.ok(!tail.includes('Q01'), '被过滤后不应把最后一个 section 的题重排为 Q01')
  assert.ok(!tail.includes('Q00'), '不得出现 Q00')

  // 只命中中间 section 的第 2 题（section 内前置问题被过滤）
  const mid = badges(harness.render(result, '数据流'))
  assert.ok(mid.includes('Q04'), `应显示 Q04，实际 ${JSON.stringify(mid)}`)
  assert.ok(!mid.includes('Q01'), '不应把 section 内第 2 题重排为 Q01')
  assert.ok(!mid.includes('Q00'), '不得出现 Q00')

  // 大纲（左侧）与卡片（右侧）的题号序列应完全一致
  const html = harness.render(result, '')
  const nav = html.split('</aside>')[0]
  const body = html.split('</aside>')[1] ?? ''
  assert.deepEqual(badges(nav).slice(0, 6), badges(body).slice(0, 6), '大纲与正文题号应一致')
})

test('组件级：结果里含空 section 时不出现 00（旧实现会渲染成 00）', async (t) => {
  const harness = await loadRenderHarness()
  if (!harness) {
    t.skip('未提供 RENDER_PAGE_BUNDLE（请用 npm run test:renderer 运行）')
    return
  }
  const withEmpty = makeResult()
  // 在开头插入一个没有问题的 section：无搜索时旧实现会把它连同 "00" 一起渲染出来
  withEmpty.sections = [{ id: 'empty', title: '空主题', questions: [] }, ...withEmpty.sections]

  const html = harness.render(withEmpty as unknown, '')
  // 空 section 不应被渲染
  assert.ok(!html.includes('空主题'), '空 section 不应渲染出来')
  // section 序号必须来自原始下标（空 section 占位 1，因此可见的是 02/03/04），绝不能是 00
  const sections = sectionNumbers(html)
  assert.ok(sections.length > 0, '应渲染出 section 序号')
  assert.deepEqual(sections, ['02', '03', '04'], `section 序号应保持原始编号，实际 ${JSON.stringify(sections)}`)
  assert.ok(!sections.includes('00'), '不得出现 00 序号')
  // 题号仍是 1..6
  const labels = badges(html)
  for (const n of ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06']) {
    assert.ok(labels.includes(n), `应包含 ${n}`)
  }
  assert.ok(!labels.includes('Q00'), '不得出现 Q00')
})

test('组件级：搜索无命中时显示空态且不报错', async (t) => {
  const harness = await loadRenderHarness()
  if (!harness) {
    t.skip('未提供 RENDER_PAGE_BUNDLE（请用 npm run test:renderer 运行）')
    return
  }
  const html = harness.render(makeResult() as unknown, '绝对不存在的关键词')
  assert.ok(html.includes('没有匹配的问题'), '应显示无匹配提示')
  assert.ok(!html.includes('Q00'), '不得出现 Q00')
})
