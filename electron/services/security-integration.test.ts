import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { scanProject, treeToText } from './scanner.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { buildContext, renderBatch } from './context-builder.ts'

test('excludes sensitive paths and redacts ordinary source before rendering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-security-'))
  try {
    await fs.mkdir(path.join(root, '.ssh'), { recursive: true })
    await fs.mkdir(path.join(root, '.aws'), { recursive: true })
    await fs.writeFile(path.join(root, '.env'), 'API_KEY=obviously-fake-env-secret\n')
    await fs.writeFile(path.join(root, '.ssh', 'id_ed25519'), 'obviously-fake-private-key\n')
    await fs.writeFile(path.join(root, '.aws', 'credentials.db'), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(root, 'src.ts'), 'const apiKey = "obviously-fake-source-secret"\nexport const value = 1\n')
    await fs.writeFile(path.join(root, 'README.md'), '# Safe fixture\n')

    const scan = await scanProject(root)
    const env = scan.files.find((file) => file.relPath === '.env')
    const key = scan.files.find((file) => file.relPath === '.ssh/id_ed25519')
    const source = scan.files.find((file) => file.relPath === 'src.ts')
    assert.ok(env && key && source)
    assert.equal(env.isContentCandidate, false)
    assert.equal(key.isContentCandidate, false)
    assert.equal(source.isContentCandidate, true)
    assert.equal(scan.security.excludedFiles, 3)
    assert.equal(scan.security.categories['env-file'], 1)
    assert.equal(scan.security.categories['private-key-file'], 1)
    assert.equal(scan.security.categories['secret-directory'], 1)
    assert.equal(scan.files.some((file) => file.relPath === '.aws/credentials.db'), false)

    const hasNode = (nodes: Array<{ path: string; children?: Array<{ path: string; children?: unknown[] }> }>, target: string): boolean =>
      nodes.some((node) => node.path === target || hasNode((node.children ?? []) as Array<{ path: string; children?: Array<{ path: string; children?: unknown[] }> }>, target))
    assert.equal(hasNode(scan.tree.children ?? [], '.env'), true)
    assert.equal(hasNode(scan.tree.children ?? [], '.ssh'), true)
    assert.equal(hasNode(scan.tree.children ?? [], '.ssh/id_ed25519'), true)
    assert.equal(hasNode(scan.tree.children ?? [], '.aws/credentials.db'), true)

    const built = await buildContext(scan, 'medium')
    const treeText = treeToText(scan.tree)
    const rendered = built.batches.flatMap((batch) => [
      ...batch.files.map((file) => file.content),
      renderBatch(built.headerText, treeText, batch)
    ]).join('\n')
    assert.equal(built.contentSecurity.redactedFiles, 1)
    assert.equal(built.contentSecurity.redactionMatches, 1)
    assert.match(rendered, /\[REDACTED:secret-assignment\]/)
    assert.doesNotMatch(rendered, /obviously-fake-(?:env|source)-secret/)
    assert.doesNotMatch(rendered, /\.env|\.ssh|id_ed25519|\.aws|credentials\.db/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
