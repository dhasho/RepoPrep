// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { CONTEXT_CHAR_BUDGETS, CONTEXT_TRUNCATION_WARNING, formatContextTruncationWarning, hasContextTruncation, safeClipText, validateMessageCharBudget } from './context-budget.ts'

test('message accounting sums system, user, and assistant content at the exact boundary', () => {
  const messages = [
    { role: 'system', content: 's'.repeat(7) },
    { role: 'user', content: 'u'.repeat(11) },
    { role: 'assistant', content: 'a'.repeat(13) }
  ]
  assert.equal(validateMessageCharBudget(messages, 31), true)
  assert.equal(validateMessageCharBudget(messages, 30), false)
  assert.equal(validateMessageCharBudget(messages, 32), true)
  assert.equal(CONTEXT_CHAR_BUDGETS.coarse, 60_000)
  assert.equal(CONTEXT_CHAR_BUDGETS.medium, 220_000)
  assert.equal(CONTEXT_CHAR_BUDGETS.fine, 160_000)
})

test('safe clipping preserves the marker and never emits half of a surrogate pair', () => {
  const clipped = safeClipText('prefix😀suffix', 8, '…')
  assert.ok(clipped.length <= 8)
  assert.ok(clipped.endsWith('…'))
  assert.ok(clipped.startsWith('prefix'))
  assert.doesNotMatch(clipped, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)

  const short = safeClipText('😀tail', 1, '…')
  assert.equal(short, '…', 'a one-character limit must not produce a lone UTF-16 surrogate')
})

test('context warning is static and metadata requires a real truncation flag', () => {
  const noTruncation = { treeTruncated: false, contentTruncated: false, requestTruncated: false }
  const clippedTree = { treeTruncated: true, contentTruncated: false, requestTruncated: false }
  assert.equal(hasContextTruncation(noTruncation), false)
  assert.equal(hasContextTruncation(clippedTree), true)
  assert.equal(formatContextTruncationWarning(undefined), '')
  assert.equal(formatContextTruncationWarning(noTruncation), '')
  assert.equal(formatContextTruncationWarning(clippedTree), `⚠️ ${CONTEXT_TRUNCATION_WARNING}`)
  assert.doesNotMatch(formatContextTruncationWarning(clippedTree), /path|secret|token|key/i)
})
