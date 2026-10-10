// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test, { after } from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { validateIpcArgs } from './ipc-validation.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { generateInterview } from './generator.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { scanProject } from './scanner.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { resultToMarkdown } from './markdown-export.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { LLM_PROFILE_LIMITS, RESULT_CONTRACT_MESSAGES } from '../../shared/result-contract.ts'

const roots: string[] = []
after(async () => {
  const allowedRoot = path.resolve(os.tmpdir())
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(`${allowedRoot}${path.sep}`), `fixture cleanup must stay in temp directory: ${resolved}`)
    assert.ok(path.basename(resolved).startsWith('issue70-fixture-'), `unexpected fixture path: ${resolved}`)
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('mocked real generation with maximum profile name/model and 257 referenced terms passes IPC and Markdown export', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue70-fixture-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\nA deterministic synthetic project for contract coverage.\n')
  const terms = Array.from({ length: 257 }, (_, index) => `term-${index}`)
  const answer = terms.map((term) => `[[${term}]]`).join(' ')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      projectSummary: 'Synthetic project summary',
      sections: [{ title: 'Contract coverage', summary: 'Legal output', questions: Array.from({ length: 20 }, (_, i) => ({
        question: `Question ${i + 1}`,
        answer,
        followUps: []
      })) }],
      glossary: Object.fromEntries(terms.map((term) => [term, `Definition for ${term}`]))
    }) } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const progress: number[] = []
  try {
    const result = await generateInterview({
      scan: await scanProject(root),
      granularity: 'medium',
      roleFocus: 'backend',
      profile: {
        id: 'p1', name: 'N'.repeat(LLM_PROFILE_LIMITS.name), baseUrl: 'https://mock.invalid/v1',
        apiKey: 'synthetic', model: 'M'.repeat(LLM_PROFILE_LIMITS.model)
      },
      signal: new AbortController().signal,
      onProgress: (_step, _detail, percent) => progress.push(percent)
    })

    assert.equal(result.modelUsed.length, 515)
    assert.equal(Object.keys(result.glossary).length, 257)
    assert.ok(progress.includes(100), 'valid result should report completion')
    assert.doesNotThrow(() => validateIpcArgs(IPC.exportMarkdown, [result]))
    const markdown = resultToMarkdown(result)
    assert.ok(markdown.includes('## 附录：专业名词表'))
    assert.ok(markdown.includes('| term-256 | Definition for term-256 |'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('over-budget generated result fails before the 100 percent completion event', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'issue70-fixture-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      projectSummary: 'x'.repeat(50_001),
      sections: [{ title: 'Topic', questions: Array.from({ length: 20 }, (_, i) => ({ question: `Question ${i}`, answer: 'Answer', followUps: [] })) }],
      glossary: {}
    }) } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const progress: number[] = []
  try {
    await assert.rejects(generateInterview({
      scan: await scanProject(root), granularity: 'medium', roleFocus: 'backend',
      profile: { id: 'p1', name: 'Mock', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic', model: 'mock' },
      signal: new AbortController().signal,
      onProgress: (_step, _detail, percent) => progress.push(percent)
    }), (error: unknown) => error instanceof Error && error.message === RESULT_CONTRACT_MESSAGES.generated)
    assert.equal(progress.includes(100), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
