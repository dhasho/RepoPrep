import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { GenerationDraftStore } from '../../electron/services/generation-draft-store.ts'
import { generateInterview } from '../../electron/services/generator.ts'
import { scanProject } from '../../electron/services/scanner.ts'

const [phase, directory, baseUrl] = process.argv.slice(2)
const projectPath = path.join(directory, 'project')
const store = new GenerationDraftStore(directory)
const profile = { id: 'resume-profile', name: 'Synthetic', model: 'local', baseUrl, apiKey: 'SYNTHETIC_PRIVATE_API_KEY' }
const draft = phase === 'fail'
  ? store.begin(projectPath, { projectName: 'project', granularity: 'fine', roleFocus: 'backend', profileId: profile.id, modelLabel: profile.model })
  : store.read(projectPath)
assert.ok(draft)
if (phase === 'publish') {
  assert.ok(draft.summary.ready && draft.result)
  // The main-process handler separately tests the actual saveResult boundary;
  // this phase proves a new process needs no model to reuse the durable result.
  await fs.writeFile(path.join(directory, 'published.json'), JSON.stringify(draft.result))
  store.remove(projectPath, draft.summary.id)
  assert.equal(store.read(projectPath), null)
  console.log('PUBLISHED_WITHOUT_GENERATION')
} else {
  const scan = await scanProject(projectPath)
  const generate = () => generateInterview({ scan, granularity: 'fine', roleFocus: 'backend', profile, signal: new AbortController().signal, onProgress: () => {}, checkpoint: { state: draft.checkpoint, save: (value) => store.save(projectPath, draft.summary.id, value) } })
  if (phase === 'fail') {
    await assert.rejects(generate())
    assert.equal(store.read(projectPath)?.checkpoint?.entries.length, 2)
    console.log('FAILED_WITH_TWO_DURABLE_BATCHES')
  } else {
    assert.equal(draft.checkpoint.entries.length, 2)
    const result = await generate()
    store.complete(projectPath, draft.summary.id, result)
    console.log('RESUMED_AND_COMPLETED')
  }
}
