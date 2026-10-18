// @ts-ignore TS5097 -- explicit extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- explicit extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import {
  createNavigationHistory,
  currentNavigation,
  replaceNavigation,
  stepNavigation,
  visitNavigation
}
  // @ts-expect-error Node strip-types requires the explicit extension; project bundler resolution does not.
  from './navigation-history.ts'

interface Page {
  title: string
  payload: object
}

function entry(key: string, title = key): { key: string; value: Page } {
  return { key, value: { title, payload: {} } }
}

test('creates a one-entry history with the default bounded capacity', () => {
  const first = entry('project-a')
  const history = createNavigationHistory(first)

  assert.deepEqual(history.entries, [first])
  assert.equal(history.index, 0)
  assert.equal(history.maxEntries, 50)
  assert.strictEqual(currentNavigation(history), first)
})

test('visits step backward and forward while refusing to cross either boundary', () => {
  const first = entry('project-a')
  const second = entry('project-b')
  const third = entry('analysis-c')
  const atThird = visitNavigation(visitNavigation(createNavigationHistory(first), second), third)
  const atSecond = stepNavigation(atThird, -1)
  const atFirst = stepNavigation(atSecond, -1)

  assert.equal(currentNavigation(atThird), third)
  assert.equal(currentNavigation(atSecond), second)
  assert.equal(currentNavigation(atFirst), first)
  assert.strictEqual(stepNavigation(atFirst, -1), atFirst)
  assert.strictEqual(stepNavigation(atThird, 1), atThird)
  assert.equal(currentNavigation(stepNavigation(atSecond, 1)), third)
})

test('a new visit after going back truncates forward entries without mutating prior snapshots', () => {
  const first = entry('project-a')
  const second = entry('project-b')
  const third = entry('analysis-c')
  const fourth = entry('analysis-d')
  const original = visitNavigation(visitNavigation(createNavigationHistory(first), second), third)
  const atSecond = stepNavigation(original, -1)
  const branched = visitNavigation(atSecond, fourth)

  assert.deepEqual(branched.entries, [first, second, fourth])
  assert.equal(branched.index, 2)
  assert.deepEqual(original.entries, [first, second, third])
  assert.equal(original.index, 2)
  assert.deepEqual(atSecond.entries, [first, second, third])
  assert.equal(atSecond.index, 1)
})

test('visiting the current key replaces it without pushing or discarding forward history', () => {
  const first = entry('project-a')
  const second = entry('project-b', 'old B')
  const third = entry('analysis-c')
  const original = visitNavigation(visitNavigation(createNavigationHistory(first), second), third)
  const atSecond = stepNavigation(original, -1)
  const replacement = entry('project-b', 'updated B')
  const updated = visitNavigation(atSecond, replacement)

  assert.deepEqual(updated.entries, [first, replacement, third])
  assert.equal(updated.index, 1)
  assert.strictEqual(currentNavigation(updated), replacement)
  assert.equal(currentNavigation(stepNavigation(updated, 1)), third)
  assert.deepEqual(original.entries, [first, second, third])
})

test('replace changes only the current entry and keeps forward history intact', () => {
  const first = entry('project-a')
  const second = entry('project-b')
  const third = entry('analysis-c')
  const original = visitNavigation(visitNavigation(createNavigationHistory(first), second), third)
  const atSecond = stepNavigation(original, -1)
  const replacement = entry('project-b-renamed', 'replacement')
  const updated = replaceNavigation(atSecond, replacement)

  assert.deepEqual(updated.entries, [first, replacement, third])
  assert.equal(updated.index, 1)
  assert.strictEqual(currentNavigation(updated), replacement)
  assert.equal(currentNavigation(stepNavigation(updated, 1)), third)
  assert.deepEqual(atSecond.entries, [first, second, third])
})

test('evicts the oldest entries at capacity and preserves the configured limit', () => {
  const first = entry('project-a')
  const second = entry('project-b')
  const third = entry('analysis-c')
  const history = visitNavigation(
    visitNavigation(createNavigationHistory(first, 2), second),
    third
  )

  assert.deepEqual(history.entries, [second, third])
  assert.equal(history.index, 1)
  assert.equal(history.maxEntries, 2)
  assert.equal(currentNavigation(history), third)
})

test('retains value references rather than cloning navigation payloads', () => {
  const payload = { nested: { count: 1 } }
  const first = { key: 'analysis-a', value: payload }
  const history = createNavigationHistory(first)
  const updated = replaceNavigation(history, first)

  assert.strictEqual(history.entries[0].value, payload)
  assert.strictEqual(updated.entries[0].value, payload)
  assert.strictEqual(history.entries[0], first)
})

test('rejects non-positive, fractional, and unsafe history limits', () => {
  const first = entry('project-a')
  for (const maxEntries of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createNavigationHistory(first, maxEntries), RangeError)
  }
})
