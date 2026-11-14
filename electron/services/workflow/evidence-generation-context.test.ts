import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { test } from 'node:test'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { ScanResult } from '../scanner.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { EvidenceRecord } from './project-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { TopicCard } from './investigation-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { buildLegacyEvidenceContext, makeEvidenceGenerationGroups } from './evidence-generation-context.ts'

const records: EvidenceRecord[] = ['a', 'b', 'c'].map((id, index) => ({
  id, snapshotId: 'snapshot', fileId: `file-${id}`, relPath: `src/${id}.ts`, originalRange: { startLine: 1, endLine: 1 }, displayRange: { startLine: 1, endLine: 1 },
  contentHash: `hash-${id}`, text: 'x'.repeat(index + 1), sourceKind: 'code', readStatus: 'complete', parseStatus: 'parsed', omission: 'none', transformationVersion: 'v1',
  redactionSummary: { totalMatches: index === 1 ? 1 : 0, matchesByCategory: { apiKey: index === 1 ? 1 : 0 } }
}))
const topics: TopicCard[] = [{ id: 'topic-ab', title: 'A and B', mechanism: 'mechanism', valueRationale: 'value', difficulty: 'intermediate', evidenceIds: ['a', 'b'], evidenceNeeds: [], unconfirmed: [] }]

test('shared grouping is deterministic and keeps topic evidence together', () => {
  const args = [['a', 'b', 'c'], records, [], topics, 3, true] as const
  const first = makeEvidenceGenerationGroups(...args)
  const second = makeEvidenceGenerationGroups(...args)
  assert.deepEqual(first, second)
  assert.equal(first.length, 2)
  assert.ok(first.some(group => group.ids.includes('a') && group.ids.includes('b') && group.topics[0]?.id === 'topic-ab'))
  assert.ok(first.every(group => group.ids.length > 0))
})

test('shared legacy context preserves labels, redaction summary, selection, and header/tree', () => {
  const groups = makeEvidenceGenerationGroups(['a', 'b', 'c'], records, [], topics, 2, false)
  const scan = { name: 'Synthetic', languages: [{ lang: 'TypeScript', percent: 100 }], truncation: false } as unknown as ScanResult
  const context = buildLegacyEvidenceContext(scan, ['src/a.ts', 'src/b.ts', 'src/c.ts'], records, groups)
  assert.deepEqual(context.batches.map(batch => batch.label), ['证据组 1', '证据组 2'])
  assert.match(context.headerText, /项目：Synthetic/)
  assert.equal(context.treeText, '- src/a.ts\n- src/b.ts\n- src/c.ts')
  assert.equal(context.contentSecurity.redactionMatches, 1)
  assert.equal(context.contentSecurity.redactedFiles, 1)
  assert.ok(context.selection)
  assert.equal(context.selection.selectedRegions, 3)
  assert.equal(context.contentReadSummary.attemptedReads, 3)
})


test('single atomic component preserves its record reference when medium replication is needed', () => {
  const original = records[0]
  const mediumGroups = makeEvidenceGenerationGroups(['a'], [original], [], [], 2, false)
  assert.equal(mediumGroups.length, 2)
  assert.strictEqual(mediumGroups[0].files[0], original)
  assert.strictEqual(mediumGroups[1].files[0], original)

  const fineGroups = makeEvidenceGenerationGroups(['a'], [original], [], [], 1, true)
  assert.equal(fineGroups.length, 1)
  assert.strictEqual(fineGroups[0].files[0], original)
})
