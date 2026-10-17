import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { parseScanLimitDraft, scanLimitDraftOf } from './scan-limit-input.ts'
import { SCAN_LIMIT_BOUNDS } from '@shared/types'

test('scan limit drafts accept only decimal integers within bounds and omit blank defaults', () => {
  assert.deepEqual(parseScanLimitDraft(scanLimitDraftOf()).value, {})
  assert.deepEqual(parseScanLimitDraft({ maxFiles: '0001', maxTreeNodes: '10000', maxContentFileBytes: '524288' }).value,
    { maxFiles: 1, maxTreeNodes: 10000, maxContentFileBytes: 524288 })
  for (const invalid of ['0', String(SCAN_LIMIT_BOUNDS.maxFiles.max + 1), '1.5', '-1', '1e3', '0x10', 'abc']) {
    assert.ok(parseScanLimitDraft({ maxFiles: invalid, maxTreeNodes: '', maxContentFileBytes: '' }).errors.maxFiles, invalid)
  }
  assert.ok(parseScanLimitDraft({ maxFiles: '', maxTreeNodes: '', maxContentFileBytes: '1023' }).errors.maxContentFileBytes)
})
