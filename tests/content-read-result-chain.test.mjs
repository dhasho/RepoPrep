// Real generation result carried through contract validation, IPC, export and the built ResultPage.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { IPC } from '../shared/ipc.ts'
import { assertInterviewResultContract } from '../shared/result-contract.ts'
import { resultToMarkdown } from '../electron/services/markdown-export.ts'
import { validateIpcArgs } from '../electron/services/ipc-validation.ts'
import { generateInterview } from '../electron/services/generator.ts'
import { scanProject } from '../electron/services/scanner.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '..', '.render-test', 'result-page.cjs')

async function renderResultPage(result) {
  await fs.access(bundlePath)
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { exportMarkdown: async () => ({ ok: true, message: 'ok' }) } }
  })
  try {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const requireBundle = createRequire(import.meta.url)
    const resolved = requireBundle.resolve(bundlePath)
    if (requireBundle.cache?.[resolved]) delete requireBundle.cache[resolved]
    const { default: ResultPage } = requireBundle(bundlePath)
    return renderToStaticMarkup(React.createElement(ResultPage, {
      result,
      settings: { profiles: [], defaultProfileId: null },
      onRegenerate: () => undefined
    }))
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    dom.window.close()
  }
}

test('real generation warning flows through contract, IPC, Markdown and built ResultPage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue71-render-integration-'))
  const allowedRoot = path.resolve(os.tmpdir())
  const resolvedRoot = path.resolve(root)
  assert.ok(resolvedRoot.startsWith(`${allowedRoot}${path.sep}`), 'fixture is rooted below the operating system temp directory')
  assert.ok(path.basename(root).startsWith('issue71-render-integration-'))

  const readme = path.join(root, 'README.md')
  const originalOpen = fs.open
  const originalFetch = globalThis.fetch
  try {
    await fs.writeFile(readme, '# Synthetic project\n')
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"synthetic"}')
    const scan = await scanProject(root)
    const progressDetails = []
    const providerMessages = []
    fs.open = async (filePath, ...args) => {
      if (String(filePath) === readme) {
        throw Object.assign(new Error(`private-root ${root} synthetic secret`), { code: 'EACCES' })
      }
      return originalOpen(filePath, ...args)
    }
    globalThis.fetch = async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body))
      providerMessages.push(...(requestBody.messages ?? []).map((message) => message.content ?? ''))
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          projectSummary: 'Synthetic generated summary',
          sections: [{ title: 'Synthetic section', questions: Array.from({ length: 20 }, (_, index) => ({
            question: `Question ${index + 1}`,
            answer: `Answer ${index + 1}`,
            followUps: []
          })) }],
          glossary: {}
        }) } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const result = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'backend',
      profile: { id: 'p1', name: 'Mock', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic-key', model: 'mock' },
      signal: new AbortController().signal,
      onProgress: (_step, detail) => { if (detail) progressDetails.push(detail) }
    })

    assert.ok(result.contentReadSummary)
    assert.doesNotThrow(() => assertInterviewResultContract(result))
    assert.doesNotThrow(() => validateIpcArgs(IPC.exportMarkdown, [result]))
    assert.ok(providerMessages.some((message) => message.includes('内容读取不完整') && message.includes('README.md')))
    assert.ok(progressDetails.some((detail) => detail.includes('内容读取不完整') && detail.includes('README.md')))
    assert.ok(!providerMessages.join('\n').includes(root))
    assert.ok(!providerMessages.join('\n').includes('synthetic secret'))
    assert.ok(!progressDetails.join('\n').includes(root))
    assert.ok(!progressDetails.join('\n').includes('synthetic secret'))

    const markdown = resultToMarkdown(result)
    assert.ok(markdown.includes('尝试读取'))
    assert.ok(markdown.includes('README\\.md'))
    assert.ok(!markdown.includes('synthetic secret'))
    assert.ok(!markdown.includes(root))

    const html = await renderResultPage(result)
    assert.ok(html.includes('role="alert"'))
    assert.ok(html.includes('README.md'))
    assert.ok(!html.includes('synthetic secret'))
    assert.ok(!html.includes(root))

    fs.open = originalOpen
    const normalProgressDetails = []
    const normalResult = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'backend',
      profile: { id: 'p1', name: 'Mock', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic-key', model: 'mock' },
      signal: new AbortController().signal,
      onProgress: (_step, detail) => { if (detail) normalProgressDetails.push(detail) }
    })
    assert.equal(normalResult.contentReadSummary, undefined)
    assert.ok(!normalProgressDetails.join('\n').includes('内容读取不完整'))
    assert.ok(!resultToMarkdown(normalResult).includes('内容读取不完整'))
    const normalHtml = await renderResultPage(normalResult)
    assert.ok(!normalHtml.includes('内容读取不完整'))
  } finally {
    fs.open = originalOpen
    globalThis.fetch = originalFetch
    assert.ok(resolvedRoot.startsWith(`${allowedRoot}${path.sep}`), 'cleanup target remains under the temp directory')
    assert.ok(path.basename(resolvedRoot).startsWith('issue71-render-integration-'), 'cleanup target has the expected fixture name')
    await fs.rm(resolvedRoot, { recursive: true, force: true })
  }
})
