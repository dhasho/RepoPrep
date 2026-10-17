// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import { resolveSourceRefs } from './source-evidence.ts'

const manifest = [{
  sourceId: 'opaque-one',
  snapshotHash: 'a'.repeat(64),
  path: 'src/core.ts',
  content: 'one\n[REDACTED:secret-assignment]\nthree\n',
  citableLineCount: 3
}]

test('source refs accept only bounded complete lines from the current manifest', () => {
  const result = resolveSourceRefs([
    { sourceId: 'opaque-one', startLine: 2, endLine: 3 },
    { sourceId: 'unknown', startLine: 1, endLine: 1 },
    { sourceId: 'opaque-one', startLine: 3, endLine: 2 },
    { sourceId: 'opaque-one', startLine: 1, endLine: 31 },
    { sourceId: 'opaque-one', startLine: 1, endLine: 4 }
  ], manifest)
  assert.deepEqual(result.evidence.map(({ path, startLine, endLine, excerpt }) => ({ path, startLine, endLine, excerpt })), [
    { path: 'src/core.ts', startLine: 2, endLine: 3, excerpt: '[REDACTED:secret-assignment]\nthree' }
  ])
  assert.equal(result.asked, 5)
  assert.equal(result.accepted, 1)
  assert.equal(result.rejected, 4)
})

test('source refs cannot introduce model paths or cite omitted files or excessive output', () => {
  const hiddenFile = { ...manifest[0], sourceId: 'hidden', path: '../secret.ts' }
  const result = resolveSourceRefs([
    { sourceId: 'opaque-one', path: 'attacker.ts', startLine: 1, endLine: 1 },
    { sourceId: 'missing', startLine: 1, endLine: 1 },
    { sourceId: 'hidden', startLine: 1, endLine: 1 },
    { sourceId: 'opaque-one', startLine: 1, endLine: 1 }
  ], [...manifest, hiddenFile], 2)
  assert.equal(result.evidence.length, 0)
  assert.equal(result.rejected, 4)
  assert.deepEqual(resolveSourceRefs({ sourceId: 'opaque-one', startLine: 1, endLine: 1 }, manifest), {
    evidence: [], asked: 1, accepted: 0, rejected: 1, usedChars: 0
  })
})

test('source refs reject unknown ids, too many lines, overlong excerpts, and total overflow', () => {
  const long = { ...manifest[0], sourceId: 'long', content: Array(32).fill('x'.repeat(120)).join('\n'), citableLineCount: 32 }
  const result = resolveSourceRefs([
    { sourceId: 'opaque-one', startLine: 1, endLine: 1 },
    { sourceId: 'long', startLine: 1, endLine: 31 },
    { sourceId: 'long', startLine: 1, endLine: 25 },
    { sourceId: 'long', startLine: 1, endLine: 1 }
  ], [...manifest, long], 1)
  assert.equal(result.accepted, 0)
  assert.equal(result.rejected, 4)
})

test('the final request-truncated partial line cannot be cited', () => {
  const partial = { ...manifest[0], content: 'first\nsecond\npartial…（内容已截断）', citableLineCount: 2 }
  const result = resolveSourceRefs([{ sourceId: 'opaque-one', startLine: 2, endLine: 3 }], [partial])
  assert.equal(result.accepted, 0)
  assert.equal(result.rejected, 1)
})
