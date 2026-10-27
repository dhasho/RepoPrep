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
const batch = (question = 'Question one?', id = 'q1', answer = 'Verified synthetic answer.') => ({ projectSummary: 'Summary', sections: [{ id: 's1', title: 'First batch', questions: [{ id, question, answer, followUps: [] }] }], glossary: {} })
const state = (): GenerationCheckpoint => ({ version: 2, fingerprint: 'a'.repeat(64), totalBatches: 2, entries: [{ key: 'b'.repeat(64), batch: batch() }] })

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
    store.save(projectPath, draft.summary.id, state())
    const unsafe = state() as GenerationCheckpoint & { apiKey: string }
    unsafe.apiKey = 'synthetic-secret'
    assert.throws(() => store.save(projectPath, draft.summary.id, unsafe), { message: messages.save })
    const invalid = state(); invalid.entries[0].batch.sections[0].questions[0].answer = 'x'.repeat(50_001)
    assert.throws(() => store.save(projectPath, draft.summary.id, invalid), { message: messages.changed })
    assert.deepEqual(store.read(projectPath)?.checkpoint, state(), 'failed writes leave the last accepted snapshot readable')
    const files = fs.readdirSync(path.join(directory, 'generation-drafts'))
    for (const file of files) assert.ok(!fs.readFileSync(path.join(directory, 'generation-drafts', file), 'utf8').includes('synthetic-secret'))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('v1 checkpoints remain readable without rewriting their original bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-v1-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    const draft = store.begin(projectPath, meta)
    const compensation = state()
    compensation.totalBatches = 1
    compensation.entries.push({ key: 'd'.repeat(64), batch: batch('Compensation question?', 'q-comp') })
    store.save(projectPath, draft.summary.id, compensation)
    const fileName = fs.readdirSync(path.join(directory, 'generation-drafts')).find((name) => name.endsWith('.json'))!
    const file = path.join(directory, 'generation-drafts', fileName)
    const old = store.read(projectPath)!
    const legacy = { ...old, checkpoint: { ...old.checkpoint!, version: 1, pending: undefined } }
    legacy.summary = { ...legacy.summary, completedQuestions: 2, totalBatches: 1 }
    delete legacy.checkpoint!.pending
    fs.writeFileSync(file, JSON.stringify(legacy))
    const bytes = fs.readFileSync(file)
    assert.equal(store.read(projectPath)?.checkpoint?.version, 1)
    assert.equal(store.read(projectPath)?.checkpoint?.entries.length, 2, 'compensation entries may exceed the planned batch count')
    assert.deepEqual(fs.readFileSync(file), bytes)
    const numericStringVersion = JSON.parse(bytes.toString('utf8'))
    numericStringVersion.checkpoint.version = '1'
    fs.writeFileSync(file, JSON.stringify(numericStringVersion))
    fs.rmSync(`${file}.bak`, { force: true })
    assert.throws(() => store.read(projectPath), { message: messages.corrupt }, 'numeric strings are not accepted as checkpoint versions')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('pending questions append durably, deduplicate globally, and promote without rewriting accepted questions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-pending-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    const draft = store.begin(projectPath, meta)
    const first = state()
    first.pending = { key: 'c'.repeat(64), batch: { ...batch('  [[Question one?]]  ', 'q2'), projectSummary: '', glossary: { Term: 'Meaning' } } }
    store.save(projectPath, draft.summary.id, first)
    store.save(projectPath, draft.summary.id, first)
    const restarted = new GenerationDraftStore(directory)
    assert.equal(restarted.read(projectPath)?.summary.completedBatches, 1)
    assert.equal(restarted.read(projectPath)?.summary.completedQuestions, 1, 'pending questions are counted with global normalized deduplication')
    const appended = structuredClone(first)
    appended.pending!.batch.sections[0].questions.push({ id: 'q3', question: 'Question three?', answer: '', followUps: [] })
    appended.pending!.batch.projectSummary = 'Growing summary'
    appended.pending!.batch.glossary.Term2 = 'Another meaning'
    restarted.save(projectPath, draft.summary.id, appended)
    assert.equal(new GenerationDraftStore(directory).read(projectPath)?.summary.completedQuestions, 2)
    const promoted = structuredClone(appended)
    promoted.entries.push({ key: promoted.pending!.key, batch: promoted.pending!.batch })
    delete promoted.pending
    restarted.save(projectPath, draft.summary.id, promoted)
    assert.equal(new GenerationDraftStore(directory).read(projectPath)?.summary.completedBatches, 2)
    assert.equal(new GenerationDraftStore(directory).read(projectPath)?.summary.completedQuestions, 2)
    assert.deepEqual(promoted.entries[0], first.entries[0])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('pending cannot be shortened, reordered, rewritten, or replaced without promotion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-pending-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    const draft = store.begin(projectPath, meta)
    const initial = state()
    const pendingBatch = { ...batch('Question two?', 'q2'), glossary: { Term: 'Meaning' } }
    pendingBatch.sections[0].questions.push({ id: 'q3', question: 'Question three?', answer: 'Answer three.', followUps: [] })
    initial.pending = { key: 'c'.repeat(64), batch: pendingBatch }
    store.save(projectPath, draft.summary.id, initial)
    const mutate = (fn: (candidate: GenerationCheckpoint) => void) => {
      const candidate = structuredClone(initial)
      fn(candidate)
      assert.throws(() => store.save(projectPath, draft.summary.id, candidate), { message: messages.changed })
    }
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions = [] })
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions[0].answer = 'rewritten' })
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions[0].id = 'changed-id' })
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions[0].question = 'Question three?' })
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions[0].title = 'New title metadata' })
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions[0].followUps.push({ question: 'Follow up?', answer: '', followUps: [] }) })
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions[0].sourceEvidence = [] })
    mutate((candidate) => { candidate.pending!.batch.sections[0].questions.reverse() })
    mutate((candidate) => { candidate.pending!.batch.sections[0].title = 'Different ownership' })
    mutate((candidate) => { candidate.pending!.batch.glossary.Term = 'Changed definition' })
    mutate((candidate) => { delete candidate.pending!.batch.glossary.Term })
    mutate((candidate) => { candidate.pending!.key = 'd'.repeat(64) })
    mutate((candidate) => { delete candidate.pending })
    assert.equal(store.read(projectPath)?.checkpoint?.pending?.key, 'c'.repeat(64))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('promoted pending can be followed by a different pending key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-promotion-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    const draft = store.begin(projectPath, meta)
    const initial = state()
    initial.pending = { key: 'c'.repeat(64), batch: batch('Question two?', 'q2') }
    store.save(projectPath, draft.summary.id, initial)
    const promoted = structuredClone(initial)
    promoted.entries.push({ key: promoted.pending!.key, batch: promoted.pending!.batch })
    promoted.pending = { key: 'd'.repeat(64), batch: batch('Question three?', 'q3') }
    store.save(projectPath, draft.summary.id, promoted)
    assert.equal(store.read(projectPath)?.checkpoint?.pending?.key, 'd'.repeat(64))
    assert.equal(store.read(projectPath)?.summary.completedBatches, 2)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('unsafe or oversized pending data is rejected without replacing the last snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-draft-invalid-pending-'))
  const projectPath = path.join(directory, 'project')
  try {
    const store = new GenerationDraftStore(directory)
    const draft = store.begin(projectPath, meta)
    const initial = state()
    initial.pending = { key: 'c'.repeat(64), batch: batch('Question two?', 'q2') }
    store.save(projectPath, draft.summary.id, initial)
    const unsafe = structuredClone(initial) as GenerationCheckpoint & { pending: { apiKey?: string } }
    unsafe.pending.apiKey = 'synthetic-secret'
    assert.throws(() => store.save(projectPath, draft.summary.id, unsafe), { message: messages.save })
    const oversized = structuredClone(initial)
    oversized.pending!.batch.sections[0].questions.push({ id: 'q3', question: 'Question three?', answer: 'x'.repeat(50_001), followUps: [] })
    assert.throws(() => store.save(projectPath, draft.summary.id, oversized), { message: messages.save })
    assert.deepEqual(store.read(projectPath)?.checkpoint, initial)
    assert.ok(!fs.readFileSync(fs.readdirSync(path.join(directory, 'generation-drafts')).map((name) => path.join(directory, 'generation-drafts', name)).find((file) => file.endsWith('.json'))!, 'utf8').includes('synthetic-secret'))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
