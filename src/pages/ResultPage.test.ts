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

test('历史报告的通用摘要保留不同技术问题的考察主题', () => {
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
  const concerns = [/架构|进程/u, /preload|接口|IPC|契约/iu, /页面|状态/u,
    /生成任务|后台|隔离/u, /扫描|忽略|gitignore/iu, /缓存键|失效/u,
    /内容|读取|路径穿越/u, /敏感信息|脱敏/u, /请求|数据流|生成/u,
    /上下文|预算/u, /题量|补偿/u, /流式|异常|响应/u]
  const labels = summarizeQuestions(questions)
  labels.forEach((label, index) => {
    assert.match(label, concerns[index], questions[index])
    assert.notEqual(label, '问题摘要')
  })
})

test('通用摘要压缩礼貌语、英文问句框架和文件名，但不硬截断长标识符', () => {
  assert.match(summarizeQuestion('请介绍RepoPrep的整体架构'), /整体架构/u)
  assert.equal(summarizeQuestion('Could you explain .gitignore rule handling?'), '.gitignore rule handling')
  assert.equal(summarizeQuestion('How does the cache invalidation strategy work?'), 'cache invalidation strategy')
  assert.match(summarizeQuestion('扫描缓存的缓存键与失效策略是什么'), /缓存.*失效|缓存键|失效策略/u)
})

test('导航摘要长度有界且相同主题的问题会带上区分信息', () => {
  const longIdentifier = 'How does ExtremelyLongProjectConfigurationManager handle invalidation and cache refresh strategies?'
  const longSummary = summarizeQuestion(longIdentifier)
  assert.ok(Array.from(longSummary).length <= 32)
  assert.match(longSummary, /invalidation|cache refresh/u, 'the caption describes the question instead of truncating its identifier')
  assert.doesNotMatch(longSummary, /ExtremelyLong|ConfigurationManager/u)

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

test('新生成和历史报告都从原题提炼主题，不依赖某一份已修复的数据', async () => {
  const questions = [
    '`OpenAICompatibleSemanticEncoder.encode_many` 对 embedding 批处理做了哪些输入和响应约束？哪些保证无法从片段确认？',
    '从现有代码看，`BasicMediaInspector` 和 `QualityPolicy` 能提供多强的质量保证？哪些结论不能下？'
  ]
  const { JSDOM } = await import('jsdom')
  const captions: string[][] = []
  for (const createdAt of ['2026-10-17T10:00:00.000Z', '2026-10-26T13:13:53.828Z']) {
    const result = makeResult({
      createdAt,
      projectName: 'Another project',
      sections: [{ id: 's1', title: '核心实现', questions: questions.map((question, index) => ({
        id: `q${index}`, question, answer: `保留完整答案 ${index}。`,
        followUps: [{ question: `保留追问 ${index}？`, answer: `保留追问答案 ${index}。` }]
      })) }]
    })
    const original = JSON.stringify(result)
    const dom = new JSDOM(await render(result))
    try {
      const buttons = Array.from(dom.window.document.querySelectorAll('nav button'))
      const labels = buttons.map(button => button.lastElementChild?.textContent ?? '')
      assert.equal(labels.length, 2)
      assert.match(labels[0], /批处理|输入.*响应/u)
      assert.match(labels[1], /质量保证/u)
      assert.ok(labels.every(label => !/问题摘要|从现有代码看|OpenAICompatible|BasicMediaInspector/u.test(label)))
      assert.deepEqual(buttons.map(button => button.getAttribute('title')), questions, 'navigation retains full original questions')
      const cards = Array.from(dom.window.document.querySelectorAll('[data-report-question]'))
      questions.forEach((question, index) => assert.ok(cards[index].textContent?.includes(question), 'cards retain full original questions'))
      assert.equal(JSON.stringify(result), original, 'caption rendering never modifies a report')
      captions.push(labels)
    } finally {
      dom.window.close()
    }
  }
  assert.deepEqual(captions[0], captions[1], 'fresh and historical reports share the same summary path')
})

test('不同项目与话题都直接使用随题生成的短标题，保留完整问答', async () => {
  const questions = [
    { id: 'q1', title: '库存流水幂等校验', question: '`InventoryJournal.reconcile` 如何校验重复流水？', answer: '原始库存答案。', followUps: [] },
    { id: 'q2', title: '余额冻结与扣款确认', question: '`PaymentGateway.confirm` 为什么先冻结余额再确认扣款？', answer: '原始支付答案。', followUps: [] }
  ]
  const { JSDOM } = await import('jsdom')
  const result = makeResult({ sections: [{ id: 's1', title: '未知项目的新话题', questions }] })
  const original = JSON.stringify(result)
  const dom = new JSDOM(await render(result))
  try {
    const buttons = Array.from(dom.window.document.querySelectorAll('nav button'))
    assert.deepEqual(buttons.map(button => button.lastElementChild?.textContent), questions.map(question => question.title))
    assert.deepEqual(buttons.map(button => button.getAttribute('title')), questions.map(question => question.question))
    const cards = Array.from(dom.window.document.querySelectorAll('[data-report-question]'))
    questions.forEach((question, index) => assert.ok(cards[index].textContent?.includes(question.question), 'cards retain full original questions'))
    assert.equal(JSON.stringify(result), original)
  } finally {
    dom.window.close()
  }
})

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
    sections: [{ id: 's1', title: '系统架构', questions: [{ id: 'q1', title: '整体架构与进程协作', question: originalQuestion, answer: '完整答案内容。', followUps: [] }] }],
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
      { id: 'q1', title: '项目扫描与忽略规则', question: originalQuestion, answer: '扫描答案。', followUps: [] },
      { id: 'q2', title: '缓存键与失效策略', question: '缓存键与失效策略是什么？', answer: '缓存答案。', followUps: [] }
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

test('问答结果不展示内部用量诊断，含诊断和旧格式都正常展示内容', async () => {
  const diagnostics = {
    version: 1 as const,
    status: 'succeeded' as const,
    contextStrategy: 'structure-v1' as const,
    tokenEstimateMethod: 'mixed-text-v1' as const,
    estimatedInputTokens: 1200,
    inputTokenBudget: 16_000,
    reservedOutputTokens: 16_384,
    actualUsage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    usageComplete: false,
    requestCount: 2,
    repairRequestCount: 1,
    compensationRequestCount: 0,
    contextBuildMs: 15,
    modelMs: 800,
    totalMs: 820,
    selectedFiles: 4,
    selectedRegions: 7,
    omittedFiles: 2
  }
  const partial = await render(makeResult({ generationDiagnostics: diagnostics }))
  assert.ok(!partial.includes('分析范围与用量'))
  assert.ok(!partial.includes('实际提供 4 个文件、7 个片段；省略 2 个候选文件'))
  assert.ok(!partial.includes('服务商部分回执：输入 1,000、输出 200、合计 1,200 token'))
  assert.ok(!partial.includes('系统估算输入 1,200 token'))
  assert.ok(!partial.includes('mixed-text-v1'))
  assert.ok(!partial.includes('C:\\synthetic'))

  const complete = await render(makeResult({ generationDiagnostics: { ...diagnostics, usageComplete: true } }))
  assert.ok(!complete.includes('服务商回执：输入 1,000'))
  const legacy = await render(makeResult())
  assert.ok(!legacy.includes('分析范围与用量'))
  assert.ok(!legacy.includes('服务商用量'))
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
  // React was loaded by the SSR cases without a document and enables its legacy
  // input event shim; these obsolete methods are only needed in this jsdom host.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: () => undefined, detachEvent: () => undefined })
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
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    assert.equal(requests.length, 0, 'title terms only read the glossary')
    const closeA = container.querySelector<HTMLButtonElement>('button[title="关闭"]')
    assert.ok(closeA)
    await act(async () => { closeA.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.deepEqual(cancelled, [])
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
    assert.equal(requests.length, 0)
    const selectAndAsk = async (element: Element) => {
      const range = dom.window.document.createRange()
      range.selectNodeContents(element)
      dom.window.document.getSelection()!.removeAllRanges()
      dom.window.document.getSelection()!.addRange(range)
      await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 30, clientY: 50 })) })
      const ask = [...container.querySelectorAll('button')].find((button) => button.textContent === '向 AI 提问')
      assert.ok(ask, 'dragging report text offers an explicit AI action')
      const count = requests.length
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
      assert.equal(requests.length, count, 'selecting text alone never requests AI')
      await act(async () => { ask.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    }
    await selectAndAsk(titleTermA)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].question, 'QUESTION_A TermA')
    assert.match(String(requests[0].snippet), /选中的原文：\nTermA/)
    assert.match(String(requests[0].snippet), /ANSWER_A TermA context/)
    assert.equal(requests[0].glossaryHint, '')
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
    assert.deepEqual(cancelled, [requestA], 'replacing the owning result cancels its pending request once')
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
    await selectAndAsk(termB)
    assert.equal(requests.length, 2)
    assert.deepEqual(
      Object.fromEntries(['term', 'question', 'glossaryHint', 'projectSummary', 'profileId'].map((key) => [key, requests[1][key]])),
      { term: 'TermB', question: 'QUESTION_B TermB', glossaryHint: '', projectSummary: 'SUMMARY_B', profileId: 'profile-B' }
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


test('glossary lookup, selection, copy and select-all stay local; only Ask starts a contextual request', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
  const g = globalThis as unknown as Record<string, unknown>
  const previous = [g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT]
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true
  const requests: Array<Record<string, string>> = []
  const cancelled: string[] = []
  const copied: string[] = []
  ;(dom.window as unknown as Record<string, unknown>).api = {
    explain: async (request: Record<string, string>) => { requests.push(request) },
    cancelExplain: (id: string) => { cancelled.push(id) }, onExplainEvent: () => () => undefined
  }
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text: string) => { copied.push(text) } } })
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const require = createRequire(import.meta.url)
  delete require.cache[require.resolve(bundlePath)]
  const Page = require(bundlePath).default
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  const click = async (text: string, scope: Element = container) => {
    const target = [...scope.querySelectorAll('button')].find((item) => item.textContent === text || item.getAttribute('aria-label') === text)
    assert.ok(target, text)
    await React.act(async () => { target.click() })
  }
  const select = async (element: Element) => {
    const range = dom.window.document.createRange()
    range.selectNodeContents(element)
    dom.window.document.getSelection()!.removeAllRanges()
    dom.window.document.getSelection()!.addRange(range)
    await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: 80 })) })
  }
  try {
    await React.act(async () => { root.render(React.createElement(Page, {
      result: makeResult({ projectSummary: '报告概览', sections: [{ id: 's1', title: 'Section', questions: [{ id: 'q1', question: 'Question [[Electron]]?', answer: 'shared 契约分层来自报告。', followUps: [] }] }], glossary: { Electron: '短定义' } }),
      settings: { profiles: [{ id: 'p1' }], defaultProfileId: 'p1' }, onRegenerate: () => undefined
    })) })
    const term = [...container.querySelectorAll<HTMLElement>('.term-link')].find((item) => item.textContent === 'Electron')!
    await React.act(async () => { term.click() })
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    const lookup = container.querySelector('[role="dialog"]')!
    assert.ok(lookup.textContent?.includes('术语表'))
    assert.ok(lookup.textContent?.includes('Chromium'))
    assert.ok(!lookup.textContent?.includes('短定义'))
    assert.equal(requests.length, 0)
    await click('', lookup)
    await React.act(async () => { container.querySelector<HTMLButtonElement>('#q-q1 > button')!.click() })
    const paragraph = container.querySelector('#q-q1 .md-body p')!
    await select(paragraph)
    assert.equal(dom.window.document.getSelection()?.toString(), 'shared 契约分层来自报告。', 'opening the toolbar preserves the native selection and its DOM nodes')
    await click('复制')
    assert.deepEqual(copied, ['shared 契约分层来自报告。'])
    assert.equal(requests.length, 0)
    await select(paragraph)
    await click('全选')
    const all = dom.window.document.getSelection()!.toString()
    assert.ok(all.includes('报告概览'))
    assert.ok(!all.includes('导出 Markdown'))
    assert.ok(!all.includes('向 AI 提问'))
    await click('复制')
    assert.equal(copied[1], all.trim())
    assert.equal(requests.length, 0)
    await select(paragraph)
    await click('向 AI 提问')
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].term, 'shared 契约分层来自报告。')
    assert.equal(requests[0].question, 'Question Electron?')
    assert.ok(requests[0].snippet.includes('选中的原文：\nshared 契约分层来自报告。'))
    const panel = container.querySelector('[role="complementary"][aria-label="AI 解释"]')!
    assert.ok(panel)
    assert.equal(container.querySelector('[aria-modal="true"]'), null, 'AI explanation is an inline reading pane')
    assert.ok(container.querySelector('[role="separator"]'))
    await click('收起 AI 解释', panel)
    assert.ok(container.querySelector('[data-reading-secondary] > [hidden]')?.contains(panel))
    assert.equal(requests.length, 1)
    assert.deepEqual(cancelled, [], 'collapsing does not cancel the active explanation')
    await click('展开 AI 解释')
    assert.equal(container.querySelector('[role="complementary"][aria-label="AI 解释"]'), panel, 'expanding preserves the mounted request owner')
    assert.equal(requests.length, 1)
    assert.deepEqual(cancelled, [])
    await click('关闭 AI 解释', panel)
    assert.deepEqual(cancelled, [requests[0].requestId])
  } finally {
    await React.act(async () => { root.unmount() })
    ;[g.window, g.document, g.IS_REACT_ACT_ENVIRONMENT] = previous
    dom.window.close()
  }
})

test('新问句提炼主题，不把代码路径或完整描述塞入导航', () => {
  const labels = summarizeQuestions([
    '请从 `worker/main.ts` 和 `ui.tsx` 说明程序的进程分层与模块职责。',
    '主进程如何确认 IPC 请求来自可信页面，并限制项目路径？',
    '文件树如何保证不会撑爆上下文？',
    '问题去重和补偿请求是怎么设计的？',
    '页面导航历史如何保证前进、后退和生成状态一致？'
  ])
  const concerns = [/进程|分层|职责/u, /可信|来源|授权|IPC/u, /文件树|上下文/u, /去重|补偿/u, /导航|历史|状态/u]
  labels.forEach((label, index) => assert.match(label, concerns[index]))
})

test('未知主题也保留技术标点、下划线和英文词间距', () => {
  for (const term of ['.gitignore', 'window.api', 'node:fs', 'C++/C#', 'src/cache.ts', 'cache_key', '#include']) {
    assert.ok(summarizeQuestion(`Please explain ${term} behavior?`).includes(term), term)
  }
  assert.equal(summarizeQuestion('How does React state synchronization work?'), 'React state synchronization')
  assert.match(summarizeQuestion('Python CSV 列映射如何设计？'), /Python|CSV|列映射/)
})
