import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SCAN_LIMITS } from '@shared/types'
// @ts-ignore TS5097 -- direct Node tests require runtime .ts imports.
import { scanLimitDraftOf } from './scan-limit-input.ts'
// @ts-ignore TS5097 -- direct Node tests require runtime .ts imports.
import { scanLimitDraftWithDefault, scanLimitDraftWithValue, scanLimitLabel, scanLimitStopIndex, scanLimitStops, scanLimitValue } from './scan-limit-slider.ts'

test('slider stops show human units, include defaults, and preserve a valid custom value exactly', () => {
  const draft = scanLimitDraftOf({ maxFiles: 20_000, maxTreeNodes: 10_000, maxContentFileBytes: 512 * 1024 })
  const fileStops = scanLimitStops('maxFiles', draft.maxFiles)
  assert.ok(fileStops.includes(20_000))
  assert.ok(fileStops.includes(DEFAULT_SCAN_LIMITS.maxFiles))
  assert.equal(fileStops[scanLimitStopIndex('maxFiles', draft.maxFiles)], 20_000)
  assert.equal(scanLimitValue('maxFiles', draft.maxFiles), 20_000)
  assert.equal(scanLimitValue('maxTreeNodes', draft.maxTreeNodes), 10_000)
  assert.equal(scanLimitValue('maxContentFileBytes', draft.maxContentFileBytes), 512 * 1024)
  assert.ok(scanLimitStops('maxFiles', '100000', 12_345).includes(12_345), 'an in-session custom tick remains after moving the slider')
  assert.equal(scanLimitLabel('maxFiles', 1_000), '1千')
  assert.equal(scanLimitLabel('maxFiles', 20_000), '2万')
  assert.equal(scanLimitLabel('maxTreeNodes', 500_000), '50万')
  assert.equal(scanLimitLabel('maxContentFileBytes', 512 * 1024), '512KB')
})

test('default stop and restore control preserve omitted default semantics', () => {
  const draft = scanLimitDraftOf()
  assert.equal(scanLimitValue('maxFiles', draft.maxFiles), DEFAULT_SCAN_LIMITS.maxFiles)
  assert.deepEqual(scanLimitDraftWithDefault({ ...draft, maxFiles: '20000' }, 'maxFiles'), { ...draft, maxFiles: '' })
  assert.deepEqual(scanLimitDraftWithValue(draft, 'maxContentFileBytes', 512 * 1024), { ...draft, maxContentFileBytes: '524288' })
})
