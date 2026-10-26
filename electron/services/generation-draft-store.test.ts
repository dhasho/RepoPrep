import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node tests.
import { GenerationDraftStore } from './generation-draft-store.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { GENERATION_DRAFT_MESSAGES as messages, type GenerationCheckpoint } from '../../shared/generation-checkpoint.ts'

const meta = { projectName: 'Synthetic', granularity: 'fine' as const, roleFocus: 'general' as const, profileId: 'p1', modelLabel: 'Synthetic / local' }
const state = (): GenerationCheckpoint => ({ version: 1, fingerprint: 'a'.repeat(64), totalBatches: 2, entries: [{ key: 'b'.repeat(64), batch: { projectSummary: 'Summary', sections: [{ id: 's1', title: 'First batch', questions: [{ id: 'q1', question: 'Question one?', answer: 'Verified synthetic answer.', followUps: [] }] }], glossary: {} } }] })

test('draft survives process restart, is separate from analyses, and requires the exact draft identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    assert.equal(store.read(projectPath), null)
    const draft = store.begin(projectPath, meta)
    assert.throws(() => store.begin(projectPath, meta), { message: messages.exists })
    store.save(projectPath, draft.summary.id, state())
    const restarted = new GenerationDraftStore(directory)
    const recovered = restarted.read(projectPath)!
    assert.equal(recovered.summary.completedBatches, 1)
    assert.equal(recovered.summary.completedQuestions, 1)
    assert.deepEqual(recovered.checkpoint, state())
    assert.equal(fs.existsSync(path.join(directory, 'projects')), false, 'draft is not published as a completed report')
    assert.throws(() => restarted.remove(projectPath, randomUUID()), { message: messages.missing })
    const incompatible = state(); incompatible.fingerprint = 'c'.repeat(64)
    assert.throws(() => restarted.save(projectPath, draft.summary.id, incompatible), { message: messages.changed })
    const rollback = state(); rollback.entries = []
    assert.throws(() => restarted.save(projectPath, draft.summary.id, rollback), { message: messages.changed })
    const result = { version: 1 as const, createdAt: '2026-10-26T00:00:00.000Z', projectName: meta.projectName, projectPath, granularity: meta.granularity, roleFocus: meta.roleFocus, profileId: meta.profileId, modelUsed: meta.modelLabel, ...state().entries[0].batch }
    restarted.complete(projectPath, draft.summary.id, result)
    assert.deepEqual(new GenerationDraftStore(directory).read(projectPath)?.result, result, 'completed-but-unpublished report is durable and reusable without a model')
    restarted.remove(projectPath, draft.summary.id)
    assert.equal(new GenerationDraftStore(directory).read(projectPath), null, 'discard removes the backup too, so restart cannot resurrect it')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('bounded journal recovers its previous valid checkpoint and rejects corrupt or mismatched records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    const draft = store.begin(projectPath, meta)
    store.save(projectPath, draft.summary.id, state())
    store.save(projectPath, draft.summary.id, state())
    const target = fs.readdirSync(path.join(directory, 'generation-drafts')).find((name) => name.endsWith('.json'))!
    const file = path.join(directory, 'generation-drafts', target)
    fs.writeFileSync(file, '{interrupted-write')
    assert.equal(store.read(projectPath)?.summary.completedQuestions, 1, 'validated backup survives corrupt primary')
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ ...store.read(projectPath), summary: { ...draft.summary, projectPath: directory } }))
    assert.throws(() => store.read(projectPath), { message: messages.corrupt })
    fs.writeFileSync(file, 'x'.repeat(16 * 1024 * 1024 + 1))
    assert.throws(() => store.read(projectPath), { message: messages.corrupt })
    store.remove(projectPath, null)
    assert.equal(store.read(projectPath), null)
    const archives = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.corrupt-'))
    assert.equal(archives.length, 2, 'explicit corrupt discard archives both original files')
    const next = store.begin(projectPath, meta)
    assert.throws(() => store.remove(projectPath, null), { message: messages.changed }, 'corrupt-discard mode cannot remove a now-valid draft')
    assert.equal(store.read(projectPath)?.summary.id, next.summary.id)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('invalid batches and accidental credential fields cannot enter the private journal', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    const draft = store.begin(projectPath, meta)
    const unsafe = state() as GenerationCheckpoint & { apiKey: string }
    unsafe.apiKey = 'synthetic-secret'
    assert.throws(() => store.save(projectPath, draft.summary.id, unsafe), { message: messages.save })
    const invalid = state(); invalid.entries[0].batch.sections[0].questions[0].answer = 'x'.repeat(50_001)
    assert.throws(() => store.save(projectPath, draft.summary.id, invalid), { message: messages.save })
    assert.equal(store.read(projectPath)?.checkpoint, null)
    const files = fs.readdirSync(path.join(directory, 'generation-drafts'))
    for (const file of files) assert.ok(!fs.readFileSync(path.join(directory, 'generation-drafts', file), 'utf8').includes('synthetic-secret'))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
