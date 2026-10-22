// Render the actual ResultPage bundle so both warning paths are covered on the result/history UI path.
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type React from 'react'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { summarizeQuestion, summarizeQuestions } from '../lib/question-summary.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import type { InterviewResult, Settings } from '../../shared/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '..', '..', '.render-test', 'result-page.cjs')
const contextWarning = '部分项目信息未参与分析，结果可能遗漏相关内容。'

type ResultPageProps = {
  result: InterviewResult
  settings: Settings
  onRegenerate: () => void
  initialSearch?: string
}

function makeResult(overrides: Partial<InterviewResult> = {}): InterviewResult {
  return {
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    projectName: 'Synthetic project',
    projectPath: 'C:\\synthetic',
    granularity: 'medium',
    roleFocus: 'backend',
    profileId: 'p1',
    modelUsed: 'mock-model',
    projectSummary: 'Synthetic summary',
    sections: [{ id: 's1', title: 'Section', questions: [{ id: 'q1', question: 'Question?', answer: 'Answer.', followUps: [] }] }],
    glossary: {},
    ...overrides
  }
}

test('导航摘要覆盖 12 个真实技术问题并保留其核心意图', () => {
  const questions = [
    '请介绍 RepoPrep 的整体架构，主进程、preload、渲染进程各自负责什么？',
    'preload 暴露的 window.api 是如何设计的？IPC 通道契约如何保证两端一致？',
    '渲染进程的页面状态流转如何管理？navigationEpoch 和组件状态如何协作？',
    '后台生成任务在渲染进程如何建模？GenerationSession 如何隔离不同任务？',
    'scanner 扫描本地项目时如何处理 .gitignore、构建产物和嵌套 worktree？',
    'ProjectScanCache 的缓存键与失效策略是什么？为什么 removeRecent 需要同步失效？',
    'project-content-reader 读取内容时如何防止路径穿越和超大文件？读取失败如何汇总给用户和模型？',
    'sensitive 模块的敏感信息脱敏流程是怎样的？脱敏统计如何进入结果？',
    '一次生成请求从 IPC.generateRun 到 saveResult 时的完整数据流是怎样的？',
    'context-builder 如何按粒度组装上下文？CONTEXT_CHAR_BUDGETS 如何限制整体请求？',
    'question-budget 如何保证题量落在目标区间？它与补偿请求如何协作？',
    'llm.ts 与 sse-parser 如何消费流式响应？如何处理 DONE、错误事件和读取中断？'
  ]
  assert.deepEqual(summarizeQuestions(questions), [
    '整体架构与进程协作',
    'preload接口与IPC契约',
    '页面状态流转',
    '后台生成任务建模与隔离',
    '项目扫描与忽略规则',
    '缓存键与失效策略',
    '内容读取边界与错误处理',
    '敏感信息脱敏流程',
    '生成请求数据流',
    '上下文组装与预算',
    '题量分配与补偿',
    '流式响应与异常处理'
  ])
})

test('通用摘要压缩礼貌语、英文问句框架和文件名，但不硬截断长标识符', () => {
  assert.equal(summarizeQuestion('请介绍RepoPrep的整体架构'), 'RepoPrep整体架构')
  assert.equal(summarizeQuestion('Could you explain .gitignore rule handling?'), '.gitignore rule handling')
  assert.equal(summarizeQuestion('How does the cache invalidation strategy work?'), 'cache invalidation strategy')
  assert.equal(summarizeQuestion('扫描缓存的缓存键与失效策略是什么'), '缓存键与失效策略')
})

test('导航摘要长度有界且相同主题的问题会带上区分信息', () => {
  const longIdentifier = 'How does ExtremelyLongProjectConfigurationManager handle invalidation and cache refresh strategies?'
  const longSummary = summarizeQuestion(longIdentifier)
  assert.ok(Array.from(longSummary).length <= 32)
  assert.ok(longSummary.endsWith('Project'), 'a long identifier is compacted at a whole-word boundary')

  const labels = summarizeQuestions([
    '系统扫描缓存失效原因如何快速查找',
    '系统扫描缓存失效时机如何快速定位'
  ], 14)
  assert.notEqual(labels[0], labels[1])
  assert.ok(labels.every((label) => Array.from(label).length <= 14))

  const longDescriptors = summarizeQuestions([
    `同一主题 ${'d'.repeat(500)}`,
    `同一主题 ${'e'.repeat(500)}`
  ], 14)
  assert.ok(longDescriptors.every((label) => Array.from(label).length <= 14))
})

test('无词边界的超长文本使用短中性摘要', () => {
  const labels = [summarizeQuestion('w'.repeat(500)), summarizeQuestion('😀'.repeat(100))]
  assert.deepEqual(labels, ['问题摘要', '问题摘要'])
  assert.ok(labels.every((label) => Array.from(label).length <= 32))
})

async function render(result: InterviewResult, initialSearch = ''): Promise<string> {
  await fs.access(bundlePath)

  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { exportMarkdown: async () => ({ ok: true, message: 'ok' }) } }
  })
  try {
    const requireBundle = createRequire(import.meta.url)
    const resolved = requireBundle.resolve(bundlePath)
    if (requireBundle.cache?.[resolved]) delete requireBundle.cache[resolved]
    const { default: ResultPage } = requireBundle(bundlePath) as { default: React.ComponentType<ResultPageProps> }
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const settings: Settings = { profiles: [], defaultProfileId: null }
    return renderToStaticMarkup(React.createElement(ResultPage, {
      result,
      settings,
      onRegenerate: () => undefined,
      initialSearch
    }))
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    dom.window.close()
  }
}

test('真实 ResultPage 显示截断提示，普通结果和缺省元数据的旧结果不显示', async () => {
  const truncated = await render(makeResult({
    contextTruncation: { treeTruncated: true, contentTruncated: false, requestTruncated: false }
  }))
  assert.ok(truncated.includes(contextWarning), 'truncated results show the shared static warning')

  const ordinary = await render(makeResult())
  assert.ok(!ordinary.includes(contextWarning), 'ordinary results do not show a truncation warning')

  const legacyResult = makeResult()
  delete legacyResult.contextTruncation
  assert.ok(!(await render(legacyResult)).includes(contextWarning), 'legacy results without metadata do not show a warning')
})

test('导航展示紧凑摘要但保留完整问题，结果头部不显示统计数和模型名', async () => {
  const originalQuestion = '请介绍RepoPrep的整体架构，主进程、preload、渲染进程各自负责什么'
  const html = await render(makeResult({
    modelUsed: 'secret-model-label',
    sections: [{ id: 's1', title: '系统架构', questions: [{ id: 'q1', question: originalQuestion, answer: '完整答案内容。', followUps: [] }] }],
    glossary: { IPC: '进程通信' }
  }))

  assert.ok(html.includes('整体架构与进程协作'))
  assert.ok(html.includes(`title="${originalQuestion}"`), 'full source question remains available on the navigation control')
  assert.ok(html.includes(`aria-label="跳转到问题：${originalQuestion}"`))
  assert.ok(html.includes(originalQuestion), 'the original question remains in the result card')
  assert.ok(!html.includes('secret-model-label'))
  assert.ok(!html.includes('1 题'))
  assert.ok(!html.includes('1 个名词'))
  assert.ok(html.includes('中粒度') && html.includes('后端方向'), 'granularity and role remain in the result header')
})

test('搜索也能命中导航摘要，过滤不改变原题编号或完整内容', async () => {
  const originalQuestion = 'scanner 扫描本地项目时如何处理 .gitignore、构建产物和嵌套 worktree？'
  const html = await render(makeResult({
    sections: [{ id: 's1', title: '扫描', questions: [
      { id: 'q1', question: originalQuestion, answer: '扫描答案。', followUps: [] },
      { id: 'q2', question: '缓存键与失效策略是什么？', answer: '缓存答案。', followUps: [] }
    ] }]
  }), '忽略规则')

  assert.ok(html.includes('value="忽略规则"'))
  assert.ok(html.includes('项目扫描与忽略规则'))
  assert.ok(html.includes(`aria-label="跳转到问题：${originalQuestion}"`))
  assert.ok(html.includes(originalQuestion), 'the card still shows the full original question')
  assert.ok(!html.includes('缓存键与失效策略是什么？'), 'only the question matching its summary remains visible')
  assert.ok(html.includes('Q01') && !html.includes('Q02'), 'the filtered question retains its original stable number')
})

test('真实 ResultPage 显示读取失败原因、相对路径和样本省略次数', async () => {
  const html = await render(makeResult({
    contentReadSummary: {
      attemptedReads: 4,
      successfulReads: 1,
      failedReads: 3,
      failuresByReason: { permission: 1, missing: 1, io: 1 },
      failures: [
        { path: 'src/denied.ts', reason: 'permission' },
        { path: 'docs/<unsafe>.md', reason: 'missing' }
      ]
    }
  }))
  assert.ok(html.includes('role="alert"'))
  assert.ok(html.includes('尝试读取 4 次，成功 1 次，失败 3 次'))
  assert.ok(html.includes('权限不足 1 次、文件不存在 1 次、读取异常 1 次'))
  assert.ok(html.includes('&quot;src/denied.ts&quot;'), 'React text safely displays the relative path')
  assert.ok(html.includes('&lt;unsafe&gt;'), 'React escapes markup in the relative path')
  assert.ok(html.includes('另有 1 次读取失败未列出'))
  assert.ok(!html.includes('C:\\synthetic'), 'project absolute path is not exposed in the warning')
})

test('旧结果仍显示答案，但不再显示源码依据或空状态占位', async () => {
  const legacy = await render(makeResult({
    sections: [{ id: 's1', title: 'Section', questions: [{
      id: 'q1', question: 'Question?', answer: 'Answer.', followUps: [], sourceEvidence: [{
        sourceId: 'source-1', snapshotHash: 'a'.repeat(64), path: 'src/legacy.ts', startLine: 7, endLine: 8,
        excerpt: 'LEGACY_SOURCE_EXCERPT'
      }]
    }] }],
    sourceEvidenceSummary: { asked: 1, accepted: 1, rejected: 0, retained: 1 }
  }))

  assert.ok(legacy.includes('Question?'))
  assert.ok(!legacy.includes('源码依据'))
  assert.ok(!legacy.includes('LEGACY_SOURCE_EXCERPT'))
  assert.ok(!legacy.includes('暂无源码依据'))
})
test('真实 ResultPage 可同时显示两类警告，正常结果与旧结果不会误报', async () => {
  const both = await render(makeResult({
    contextTruncation: { treeTruncated: false, contentTruncated: true, requestTruncated: false },
    contentReadSummary: {
      attemptedReads: 2,
      successfulReads: 1,
      failedReads: 1,
      failuresByReason: { permission: 1, missing: 0, io: 0 },
      failures: [{ path: 'src/denied.ts', reason: 'permission' }]
    }
  }))
  assert.ok(both.includes(contextWarning))
  assert.ok(both.includes('内容读取不完整'))

  const normal = await render(makeResult({
    contentReadSummary: {
      attemptedReads: 1,
      successfulReads: 1,
      failedReads: 0,
      failuresByReason: { permission: 0, missing: 0, io: 0 },
      failures: []
    }
  }))
  assert.ok(!normal.includes('内容读取不完整'))
  assert.ok(!normal.includes(contextWarning))

  const old = await render(makeResult())
  assert.ok(!old.includes('内容读取不完整'))
  assert.ok(!old.includes(contextWarning))
})

test('真实 ResultPage 在结果对象替换时同步隔离弹卡、请求和页面局部状态', async () => {
  await fs.access(bundlePath)
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const requests: Array<Record<string, unknown>> = []
  const cancelled: string[] = []
  const eventHandlers: Array<(event: { requestId: string; type: 'delta' | 'done' | 'error'; data: string }) => void> = []
  const globalDescriptors = new Map<string, PropertyDescriptor | undefined>()
  const bindGlobal = (name: string, value: unknown) => {
    globalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'scrollIntoView')
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined
  ;(dom.window as unknown as Record<string, unknown>).api = {
    exportMarkdown: async () => ({ ok: true, message: 'ok' }),
    explain: (request: Record<string, unknown>) => {
      requests.push(request)
      return new Promise<void>(() => {})
    },
    cancelExplain: (requestId: string) => { cancelled.push(requestId) },
    onExplainEvent: (handler: (event: { requestId: string; type: 'delta' | 'done' | 'error'; data: string }) => void) => {
      eventHandlers.push(handler)
      return () => undefined
    }
  }
  bindGlobal('window', dom.window)
  bindGlobal('document', dom.window.document)
  bindGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  bindGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window))
  bindGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))

  try {
    const requireBundle = createRequire(import.meta.url)
    const resolved = requireBundle.resolve(bundlePath)
    if (requireBundle.cache?.[resolved]) delete requireBundle.cache[resolved]
    const { default: ResultPage } = requireBundle(bundlePath) as { default: React.ComponentType<ResultPageProps & { initialSearch?: string }> }
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Simulate } = await import('react-dom/test-utils')
    const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const settingsA: Settings = { profiles: [], defaultProfileId: 'profile-A' }
    const settingsB: Settings = { profiles: [], defaultProfileId: 'profile-B' }
    const resultA = makeResult({
      projectPath: 'C:\\same-project',
      profileId: 'profile-A',
      projectSummary: 'SUMMARY_A',
      sections: [{ id: 's1', title: 'Section A', questions: [
        { id: 'qa', question: 'QUESTION_A [[TermA]]', answer: 'ANSWER_A [[TermA]] context', followUps: [] },
        { id: 'qb', question: 'QUESTION_B', answer: 'needle answer', followUps: [] }
      ] }],
      glossary: { TermA: 'GLOSSARY_A' }
    })

    await act(async () => { root.render(React.createElement(ResultPage, { result: resultA, settings: settingsA, onRegenerate: () => undefined })) })
    const termA = [...container.querySelectorAll('.term-link')].find((item) => item.textContent === 'TermA')
    assert.ok(termA)
    const enterA = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { termA.dispatchEvent(enterA) })
    assert.equal(enterA.defaultPrevented, true, 'Enter is consumed so the enclosing question button cannot activate')
    assert.ok(!container.textContent?.includes('ANSWER_A TermA context'), 'the enclosing question did not expand')
    assert.ok(container.textContent?.includes('GLOSSARY_A'), 'the title term popover remains open')
    const closeA = container.querySelector<HTMLButtonElement>('button[title="关闭"]')
    assert.ok(closeA)
    await act(async () => { closeA.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const questionA = [...container.querySelectorAll('aside button')].find((button) => button.getAttribute('aria-label')?.includes('QUESTION_A'))
    assert.ok(questionA)
    await act(async () => { questionA.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.ok(container.textContent?.includes('ANSWER_A TermA context'), 'A question is expanded before the identity change')
    assert.ok(questionA.className.includes('bg-indigo-50'), 'A question is active before the identity change')
    const titleTermA = [...container.querySelectorAll('.term-link')].find((item) => item.textContent === 'TermA')
    assert.ok(titleTermA)
    const secondEnterA = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { titleTermA.dispatchEvent(secondEnterA) })
    assert.equal(secondEnterA.defaultPrevented, true)
    assert.ok(container.textContent?.includes('GLOSSARY_A'))
    const explainA = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('让 AI 结合本项目详细解释'))
    assert.ok(explainA)
    await act(async () => { explainA.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].question, 'QUESTION_A TermA')
    assert.equal(requests[0].snippet, 'ANSWER_A TermA context')
    assert.equal(requests[0].glossaryHint, 'GLOSSARY_A')
    assert.equal(requests[0].projectSummary, 'SUMMARY_A')
    assert.equal(requests[0].profileId, 'profile-A')
    const requestA = String(requests[0].requestId)
    const emitLateA = eventHandlers[0]

    const search = container.querySelector('input')
    assert.ok(search)
    const setInputValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    setInputValue?.call(search, 'needle')
    await act(async () => {
      Simulate.change(search, { target: search })
    })
    assert.equal((search as HTMLInputElement).value, 'needle', 'the input keeps its live query')
    assert.ok(container.textContent?.includes('QUESTION_B'), 'the answer match is filtered into view')
    assert.ok(container.textContent?.includes('Q02'), 'filtering keeps the original question number')
    assert.ok(!container.textContent?.includes('QUESTION_A'), 'non-matching questions are filtered out')

    const searchForm = container.querySelector<HTMLFormElement>('form[role="search"]')
    const searchButton = container.querySelector<HTMLButtonElement>('button[aria-label="搜索"]')
    assert.ok(searchForm && searchButton)
    assert.equal(search.getAttribute('role'), 'searchbox')
    assert.equal(search.getAttribute('aria-label'), '搜索问题、答案或名词')
    assert.equal(searchButton.type, 'submit')
    await act(async () => { searchButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
    assert.equal((search as HTMLInputElement).value, 'needle', 'button submission retains the query')
    assert.ok(container.textContent?.includes('Q02'), 'button submission keeps the live filter')

    const enterSubmit = new dom.window.Event('submit', { bubbles: true, cancelable: true })
    await act(async () => { searchForm.dispatchEvent(enterSubmit) })
    assert.equal(enterSubmit.defaultPrevented, true, 'form submission is prevented from navigating or reloading')
    assert.equal((search as HTMLInputElement).value, 'needle', 'Enter submission retains the query')
    assert.equal(dom.window.document.activeElement, search, 'submission returns focus to the search field')
    assert.ok(container.textContent?.includes('Q02'), 'Enter submission keeps the live filter')

    // Same project path and timestamp, but this is a replaced generation snapshot.
    const resultB = makeResult({
      projectPath: resultA.projectPath,
      createdAt: resultA.createdAt,
      profileId: 'profile-B',
      projectSummary: 'SUMMARY_B',
      sections: [{ id: 's1', title: 'Section B', questions: [{ id: 'qa', question: 'QUESTION_B [[TermB]]', answer: 'ANSWER_B [[TermB]] context', followUps: [] }] }],
      glossary: { TermB: 'GLOSSARY_B' }
    })
    await act(async () => { root.render(React.createElement(ResultPage, { result: resultB, settings: settingsB, onRegenerate: () => undefined })) })
    assert.deepEqual(cancelled, [requestA], 'replacing the owning result unmounts and cancels its pending request once')
    assert.ok(!container.textContent?.includes('GLOSSARY_A'), 'A popover is gone before B can be interacted with')
    assert.equal((container.querySelector('input') as HTMLInputElement).value, '', 'search resets for the new result')
    assert.ok(!container.textContent?.includes('ANSWER_B TermB context'), 'expanded state resets')
    const navB = [...container.querySelectorAll('aside button')].find((button) => button.getAttribute('aria-label')?.includes('QUESTION_B'))
    assert.ok(navB && !navB.className.includes('bg-indigo-50'), 'active question resets even with the same question id')

    await act(async () => { navB!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const termB = [...container.querySelectorAll('.term-link')].find((item) => item.textContent === 'TermB')
    assert.ok(termB)
    const spaceB = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    await act(async () => { termB.dispatchEvent(spaceB) })
    assert.equal(spaceB.defaultPrevented, true, 'Space is consumed so it cannot activate the enclosing question button')
    assert.ok(container.textContent?.includes('GLOSSARY_B'), 'Space opens the title term popover')
    const explainB = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('让 AI 结合本项目详细解释'))
    assert.ok(explainB)
    await act(async () => { explainB.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(requests.length, 2)
    assert.deepEqual(
      Object.fromEntries(['term', 'question', 'snippet', 'glossaryHint', 'projectSummary', 'profileId'].map((key) => [key, requests[1][key]])),
      { term: 'TermB', question: 'QUESTION_B TermB', snippet: 'ANSWER_B TermB context', glossaryHint: 'GLOSSARY_B', projectSummary: 'SUMMARY_B', profileId: 'profile-B' }
    )

    for (const event of [
      { requestId: requestA, type: 'delta' as const, data: 'LATE_A_DELTA' },
      { requestId: requestA, type: 'done' as const, data: '' },
      { requestId: requestA, type: 'error' as const, data: 'LATE_A_ERROR' }
    ]) {
      await act(async () => { emitLateA(event) })
    }
    assert.ok(!container.textContent?.includes('LATE_A_DELTA'))
    assert.ok(!container.textContent?.includes('LATE_A_ERROR'))
    assert.ok(container.textContent?.includes('生成中'), 'late A events do not change B request state')
    await act(async () => { root.unmount() })
  } finally {
    for (const [name, descriptor] of globalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    if (scrollIntoViewDescriptor) Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
    else Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'scrollIntoView')
    dom.window.close()
  }
})
