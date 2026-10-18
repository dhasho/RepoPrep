import test from 'node:test'
import assert from 'node:assert/strict'
import type { InterviewResult, ProjectOverview } from '@shared/types'
import type { GenerationTask } from './generation-session'
// @ts-ignore TS5097 -- direct Node tests require runtime TypeScript suffixes.
import { pageKey, settleGenerationHistory, settleGenerationPage, type AppPageSnapshot } from './app-page-history.ts'
// @ts-ignore TS5097 -- direct Node tests require runtime TypeScript suffixes.
import { createNavigationHistory, visitNavigation } from './navigation-history.ts'

const overview: ProjectOverview = {
  root: 'C:\\history', name: 'history', totalFiles: 1, totalBytes: 1, languages: [],
  tree: { name: 'history', path: '.', type: 'dir', children: [] }, keyFiles: [],
  security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} }
}
const result: InterviewResult = {
  version: 1, createdAt: '2026-10-18T00:00:00.000Z', projectName: 'history', projectPath: overview.root,
  granularity: 'coarse', roleFocus: 'backend', profileId: 'p', modelUsed: 'synthetic',
  projectSummary: 'Synthetic', sections: [], glossary: {}
}
function page(overrides: Partial<AppPageSnapshot> = {}): AppPageSnapshot {
  return {
    view: 'generating', sidebarMode: 'projects', overview, projectStoragePath: overview.root,
    existingResult: null, result: null, resultStoragePath: null, selectedAnalysisId: null,
    configureInitialOptions: undefined, configureNotice: null, configureRevision: 2,
    foregroundRunId: 'run', generationFailure: null, ...overrides
  }
}
function task(overrides: Partial<GenerationTask> = {}): GenerationTask {
  return {
    runId: 'run', status: 'succeeded', mode: 'background', overview: { ...overview },
    options: { projectPath: overview.root, granularity: 'coarse', roleFocus: 'backend', profileId: 'p' },
    existingResult: null, result, resultStoragePath: 'C:\\canonical-history', analysisId: 'exact-analysis',
    error: null, progress: null, logs: [], startedAt: 0, ...overrides
  }
}

test('settlement updates all matching past and forward entries without moving the cursor or cloning results', () => {
  const pending = page()
  const unrelated = page({ view: 'settings', foregroundRunId: null })
  const history = {
    entries: [
      { key: pageKey(pending), value: pending }, { key: 'settings', value: unrelated },
      { key: pageKey(pending), value: pending }
    ], index: 1, maxEntries: 50
  }
  const finished = task()
  const next = settleGenerationHistory(history, [finished])
  assert.equal(next.index, 1)
  assert.equal(next.entries.length, 3)
  assert.equal(next.maxEntries, 50)
  assert.strictEqual(next.entries[1], history.entries[1], 'the current unrelated page is untouched')
  for (const index of [0, 2]) {
    const restored = next.entries[index].value
    assert.equal(restored.view, 'result')
    assert.strictEqual(restored.result, result)
    assert.strictEqual(restored.overview, pending.overview, 'history reuses its captured tree, not another task clone')
    assert.equal(restored.selectedAnalysisId, 'exact-analysis')
    assert.equal(restored.resultStoragePath, 'C:\\canonical-history')
    assert.equal(restored.foregroundRunId, null)
    assert.equal('logs' in restored, false)
  }
  assert.strictEqual(settleGenerationHistory(next, [finished]), next, 'terminal projection is idempotent')
  assert.equal(history.entries[0].value.view, 'generating', 'earlier snapshots remain immutable')
})

test('running, cancelling and unrelated run updates preserve the original page and history objects', () => {
  const pending = page()
  const history = createNavigationHistory({ key: pageKey(pending), value: pending })
  for (const status of ['running', 'cancelling'] as const) {
    assert.strictEqual(settleGenerationPage(pending, task({ status, result: null })), pending)
    assert.strictEqual(settleGenerationHistory(history, [task({ status })]), history)
  }
  assert.strictEqual(settleGenerationHistory(history, [task({ runId: 'other' })]), history)
})

test('cancelled and failed snapshots retain retry context without a live task', () => {
  const pending = page()
  const cancelled = settleGenerationPage(pending, task({ status: 'cancelled', result: null, existingResult: result }))
  assert.equal(cancelled.view, 'configure')
  assert.equal(cancelled.configureRevision, 3)
  assert.equal(cancelled.configureInitialOptions?.granularity, 'coarse')
  assert.equal(cancelled.configureInitialOptions?.roleFocus, 'backend')
  assert.strictEqual(cancelled.existingResult, result)
  assert.equal(cancelled.foregroundRunId, null)
  const failed = settleGenerationPage(pending, task({ status: 'failed', result: null, error: 'Synthetic failure' }))
  assert.equal(failed.view, 'generation-error')
  assert.deepEqual(failed.generationFailure, { runId: 'run', error: 'Synthetic failure' })
  assert.equal(failed.configureInitialOptions?.projectPath, overview.root)
  assert.equal(failed.foregroundRunId, null)
  assert.strictEqual(settleGenerationPage(failed, task({ status: 'failed' })), failed)
  assert.equal(settleGenerationPage(pending, task({ status: 'failed', error: '' })).generationFailure?.error,
    '生成失败，请重试。', 'an empty failure message must still render a terminal error instead of a spinner')
  const another = settleGenerationPage(page({ foregroundRunId: 'other' }), task({ runId: 'other', status: 'failed' }))
  assert.notEqual(pageKey(failed), pageKey(another), 'different failed runs remain distinct visits')
})

test('settlement respects history eviction and never reintroduces expired generation entries', () => {
  let history = createNavigationHistory({ key: 'select', value: page({ view: 'select', foregroundRunId: null }) })
  for (let number = 1; number <= 55; number++) {
    const pending = page({ foregroundRunId: `run-${number}` })
    history = visitNavigation(history, { key: pageKey(pending), value: pending })
  }
  assert.equal(history.entries.length, 50)
  assert.strictEqual(settleGenerationHistory(history, [task({ runId: 'run-1' })]), history)
  const next = settleGenerationHistory(history, [task({ runId: 'run-55' })])
  assert.equal(next.entries.length, 50)
  assert.equal(next.index, history.index)
  assert.strictEqual(next.entries[0], history.entries[0])
  assert.equal(next.entries.at(-1)?.value.view, 'result')
})
