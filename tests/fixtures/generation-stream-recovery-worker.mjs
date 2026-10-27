import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { GenerationDraftStore } from '../../electron/services/generation-draft-store.ts'
import { generateInterview } from '../../electron/services/generator.ts'
import { scanProject } from '../../electron/services/scanner.ts'

const [phase, directory, baseUrl, progressPath] = process.argv.slice(2)
const projectPath = path.join(directory, 'project')
const store = new GenerationDraftStore(directory)
const profile = { id: 'stream-resume-profile', name: 'Synthetic', model: 'local', baseUrl, apiKey: 'SYNTHETIC_PRIVATE_API_KEY' }

if (phase === 'publish') {
  const draft = store.read(projectPath)
  assert.ok(draft?.summary.ready && draft.result)
  // A fresh process reuses a durable ready result without a generation request.
  await fs.writeFile(path.join(directory, 'published.json'), JSON.stringify(draft.result))
  store.remove(projectPath, draft.summary.id)
  assert.equal(store.read(projectPath), null)
  console.log('PUBLISHED_WITHOUT_GENERATION')
} else {
  const draft = phase === 'fail'
    ? store.begin(projectPath, { projectName: 'project', granularity: 'medium', roleFocus: 'backend', profileId: profile.id, modelLabel: profile.model })
    : store.read(projectPath)
  assert.ok(draft)
  const scan = await scanProject(projectPath)
  const controller = new AbortController()
  let maxSavedQuestions = 0
  const generate = () => generateInterview({
    scan,
    granularity: 'medium',
    roleFocus: 'backend',
    profile,
    signal: controller.signal,
    onProgress: () => {
      // Progress is reported only after the corresponding checkpoint is saved.
      const persisted = store.read(projectPath)
      maxSavedQuestions = Math.max(maxSavedQuestions, persisted?.summary.completedQuestions ?? 0)
      fsSync.writeFileSync(progressPath, JSON.stringify({ savedQuestions: maxSavedQuestions }))
    },
    checkpoint: {
      state: draft.checkpoint,
      save: (checkpoint) => store.save(projectPath, draft.summary.id, checkpoint)
    }
  })

  if (phase === 'fail') {
    await assert.rejects(generate())
    const persisted = store.read(projectPath)
    assert.equal(persisted?.summary.completedQuestions, 3)
    assert.equal(persisted?.checkpoint?.entries.length, 0)
    assert.equal(persisted?.checkpoint?.pending?.batch?.sections?.reduce((count, section) => count + section.questions.length, 0), 3)
    assert.equal(persisted?.result, undefined)
    console.log('FAILED_WITH_THREE_DURABLE_QUESTIONS')
  } else {
    assert.equal(draft.summary.completedQuestions, 3)
    const result = await generate()
    store.complete(projectPath, draft.summary.id, result)
    console.log('RESUMED_AND_COMPLETED')
  }
}
