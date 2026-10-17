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
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import type { InterviewResult, Settings } from '../../shared/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '..', '..', '.render-test', 'result-page.cjs')
const contextWarning = '部分项目信息未参与分析，结果可能遗漏相关内容。'

type ResultPageProps = {
  result: InterviewResult
  settings: Settings
  onRegenerate: () => void
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

async function render(result: InterviewResult): Promise<string> {
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
      onRegenerate: () => undefined
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
      sections: [{ id: 's1', title: 'Section A', questions: [{ id: 'qa', question: 'QUESTION_A [[TermA]]', answer: 'ANSWER_A [[TermA]] context', followUps: [] }] }],
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
    const questionA = [...container.querySelectorAll('aside button')].find((button) => button.textContent?.includes('QUESTION_A'))
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
    setInputValue?.call(search, 'no matching question')
    await act(async () => {
      Simulate.change(search, { target: search })
    })
    assert.equal((search as HTMLInputElement).value, 'no matching question', 'A search state changed before replacement')
    assert.ok(container.textContent?.includes('没有匹配的问题'), 'A filter is active before replacement')

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
    const navB = [...container.querySelectorAll('aside button')].find((button) => button.textContent?.includes('QUESTION_B'))
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
