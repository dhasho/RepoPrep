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
