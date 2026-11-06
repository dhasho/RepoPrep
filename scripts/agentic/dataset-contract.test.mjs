import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertDatasetBundle, canonicalJson, createBlindReviewPacket, hashEvidenceRange, loadDatasetBundle, sha256, validateDatasetBundle } from './dataset-contract.mjs'

const languageNames = ['Python', 'JavaScript', 'TypeScript']
const projectExt = ['py', 'js', 'ts']
const refFor = (project, fileName = project.files[0].path) => {
  const file = project.files.find((entry) => entry.path === fileName)
  return { path: file.path, startLine: 1, endLine: 2, sha256: hashEvidenceRange(file.content, 1, 2) }
}

function makeBundle() {
  const projects = languageNames.map((language, index) => {
    const files = ['left', 'right'].map((name) => {
      const content = `${name} mechanism ${index}\nreturn value_${index}\n`
      return { path: `${name}.${projectExt[index]}`, content, sha256: sha256(Buffer.from(content, 'utf8')) }
    })
    const project = { id: `project-${index}`, language, sourceKind: 'authored-fixture', files }
    project.contentSha256 = sha256(Buffer.from(canonicalJson({ id: project.id, language, files: files.map(({ path: filePath, sha256: fileHash }) => ({ path: filePath, sha256: fileHash })).sort((a, b) => a.path.localeCompare(b.path, 'en')) }), 'utf8'))
    return project
  })
  const retrievalTasks = Array.from({ length: 20 }, (_, index) => {
    const project = projects[index % projects.length]
    const tags = []
    if (index < 2) tags.push('Python')
    if (index >= 2 && index < 4) tags.push('JavaScript')
    if (index >= 4 && index < 6) tags.push('TypeScript')
    if (index >= 6 && index < 8) tags.push('cross-file')
    if (index >= 8 && index < 10) tags.push('inheritance-callback')
    if (index >= 10 && index < 12) tags.push('conditions-exceptions')
    if (index >= 12 && index < 14) tags.push('config-vs-behavior')
    if (index >= 14 && index < 16) tags.push('index-failure')
    return { id: `retrieval-${index}`, projectId: project.id, objective: `Retrieve unique mechanism ${index}`, roleFocus: 'backend', granularity: 'medium', tags, indexMode: index >= 14 && index < 16 ? 'unavailable' : 'normal' }
  })
  const retrievalLabels = retrievalTasks.map((task, index) => {
    const project = projects.find(({ id }) => id === task.projectId)
    const refs = task.tags.includes('cross-file') ? [refFor(project, project.files[0].path), refFor(project, project.files[1].path)] : [refFor(project)]
    return { taskId: task.id, requiredEvidenceGroups: [{ id: `group-${index}`, allOf: refs }], notes: 'Synthetic harness annotation' }
  })
  const generationTasks = Array.from({ length: 12 }, (_, index) => {
    const project = projects[Math.floor(index / 4)]
    return { id: `generation-${index}`, projectId: project.id, objective: `Generate unique interview mechanism ${index}`, roleFocus: 'backend', granularity: 'medium', topic: `topic-${index}` }
  })
  const generationLabels = generationTasks.map((task, index) => ({ taskId: task.id, evidence: [refFor(projects[Math.floor(index / 4)])], expectedFacts: [{ id: `fact-${index}`, claim: `fixture fact ${index}` }], pitfalls: [] }))
  const makeSample = (kind, index) => {
    const project = projects[index % projects.length]
    const sample = { id: `${kind}-${index}`, projectId: project.id, question: `Unique ${kind} question ${index}?`, answer: `Unique ${kind} answer ${index}.`, followUps: [{ question: `Follow up ${kind} ${index}?`, answer: `Follow up answer ${kind} ${index}.` }], evidence: [refFor(project)] }
    sample.answerFingerprint = sha256(Buffer.from(canonicalJson({ question: sample.question, answer: sample.answer, followUps: sample.followUps }), 'utf8'))
    return sample
  }
  const reviewSamples = Array.from({ length: 80 }, (_, index) => makeSample('review', index))
  const reviewLabels = reviewSamples.map((sample, index) => ({ sampleId: sample.id, materialError: index < 40, errors: index < 40 ? [{ claim: `claim ${index}`, explanation: `explanation ${index}` }] : [], facts: [`fact ${index}`] }))
  const repairSamples = Array.from({ length: 20 }, (_, index) => makeSample('repair', index))
  const repairLabels = repairSamples.map((sample, index) => ({ sampleId: sample.id, expectedRepairFacts: [`repair fact ${index}`], errorExplanation: `repair explanation ${index}` }))
  return {
    projects: { schemaVersion: 1, split: 'development-synthetic', projects },
    retrievalTasks: { schemaVersion: 1, tasks: retrievalTasks },
    retrievalLabels: { schemaVersion: 1, labels: retrievalLabels },
    generationTasks: { schemaVersion: 1, tasks: generationTasks },
    generationLabels: { schemaVersion: 1, labels: generationLabels },
    reviewPacket: { schemaVersion: 1, samples: reviewSamples },
    reviewKey: { schemaVersion: 1, labels: reviewLabels },
    repairSamples: { schemaVersion: 1, samples: repairSamples },
    repairKey: { schemaVersion: 1, labels: repairLabels }
  }
}

test('accepts a minimal synthetic harness bundle and reports frozen coverage', () => {
  const bundle = makeBundle()
  const result = validateDatasetBundle(bundle)
  assert.equal(result.valid, true, result.issues.join('; '))
  assert.deepEqual(result.counts, { projects: 3, retrievalTasks: 20, retrievalLabels: 20, generationTasks: 12, generationLabels: 12, reviewSamples: 80, reviewLabels: 80, repairSamples: 20, repairLabels: 20 })
  assert.ok(Object.values(result.coverage).every((count) => count >= 2))
  assert.equal(assertDatasetBundle(bundle).valid, true)
})

test('rejects missing assets, bad counts, invalid hashes, and out-of-range evidence', () => {
  const missing = makeBundle()
  missing.generationTasks.tasks.pop()
  assert.ok(validateDatasetBundle(missing).issues.some((issue) => issue.includes('generation task count')))

  const wrongHash = makeBundle()
  wrongHash.projects.projects[0].files[0].sha256 = '0'.repeat(64)
  assert.ok(validateDatasetBundle(wrongHash).issues.some((issue) => issue.includes('project file hash mismatch')))

  const outOfRange = makeBundle()
  outOfRange.retrievalLabels.labels[0].requiredEvidenceGroups[0].allOf[0].endLine = 99
  assert.ok(validateDatasetBundle(outOfRange).issues.some((issue) => issue.includes('out of bounds')))
})

test('rejects duplicate IDs, non-bijective labels, hidden packet labels, and missing tag coverage', () => {
  const duplicate = makeBundle()
  duplicate.retrievalTasks.tasks[1].id = duplicate.retrievalTasks.tasks[0].id
  assert.ok(validateDatasetBundle(duplicate).issues.some((issue) => issue.includes('duplicate id')))

  const unpaired = makeBundle()
  unpaired.reviewKey.labels.pop()
  assert.ok(validateDatasetBundle(unpaired).issues.some((issue) => issue.includes('bijectively match')))

  const privatePacket = makeBundle()
  privatePacket.reviewPacket.oracle = { labels: [] }
  assert.ok(validateDatasetBundle(privatePacket).issues.some((issue) => issue.includes('private label material')))
  assert.equal(Object.hasOwn(createBlindReviewPacket(privatePacket).reviewPacket, 'oracle'), false)

  const hiddenSampleField = makeBundle()
  hiddenSampleField.reviewPacket.samples[0].expectedFacts = [{ id: 'secret', claim: 'private' }]
  assert.ok(validateDatasetBundle(hiddenSampleField).issues.some((issue) => issue.includes('unknown fields')))
  assert.equal(Object.hasOwn(createBlindReviewPacket(hiddenSampleField).reviewPacket.samples[0], 'expectedFacts'), false)

  const missingTag = makeBundle()
  missingTag.retrievalTasks.tasks[0].tags = []
  missingTag.retrievalTasks.tasks[1].tags = []
  assert.ok(validateDatasetBundle(missingTag).issues.some((issue) => issue.includes('tag coverage')))
})

test('checks answer fingerprints, unique answers, material-error coherence, and cross-file evidence', () => {
  const bundle = makeBundle()
  bundle.reviewKey.labels[0].errors = []
  bundle.repairSamples.samples[0].answerFingerprint = bundle.reviewPacket.samples[0].answerFingerprint
  bundle.retrievalLabels.labels[6].requiredEvidenceGroups[0].allOf.pop()
  const issues = validateDatasetBundle(bundle).issues
  assert.ok(issues.some((issue) => issue.includes('material-error label needs errors')))
  assert.ok(issues.some((issue) => issue.includes('answers must be distinct')))
  assert.ok(issues.some((issue) => issue.includes('multiple source files')))
})

test('accepts cross-file evidence distributed across multiple required groups', () => {
  const bundle = makeBundle()
  const label = bundle.retrievalLabels.labels[6]
  const project = bundle.projects.projects.find(({ id }) => id === bundle.retrievalTasks.tasks[6].projectId)
  label.requiredEvidenceGroups = [
    { id: 'caller-group', allOf: [refFor(project, project.files[0].path)] },
    { id: 'callee-group', allOf: [refFor(project, project.files[1].path)] }
  ]
  assert.equal(validateDatasetBundle(bundle).valid, true)
})

test('blind review packet contains samples only and failures use a safe static error', () => {
  const bundle = makeBundle()
  const packet = createBlindReviewPacket(bundle)
  assert.equal(packet.reviewPacket.samples.length, 80)
  assert.equal(packet.repairSamples.samples.length, 20)
  assert.equal(Object.hasOwn(packet, 'reviewKey'), false)
  assert.throws(() => assertDatasetBundle({}), { message: 'DATASET_CONTRACT_INVALID' })
})

test('loader rejects symlinked documents, traversal-shaped roots, and oversized files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dataset-contract-'))
  try {
    const bundle = makeBundle()
    for (const [key, filename] of Object.entries({ projects: 'projects.json', retrievalTasks: 'retrieval-tasks.json', retrievalLabels: 'retrieval-labels.json', generationTasks: 'generation-tasks.json', generationLabels: 'generation-labels.json', reviewPacket: 'review-packet.json', reviewKey: 'review-key.json', repairSamples: 'repair-samples.json', repairKey: 'repair-key.json' })) {
      const doc = bundle[key]
      await writeFile(path.join(root, filename), JSON.stringify(doc), 'utf8')
    }
    const loaded = await loadDatasetBundle(root)
    assert.equal(validateDatasetBundle(loaded).valid, true)

    const linkedDir = path.join(root, 'linked')
    await mkdir(linkedDir)
    try {
      await symlink(path.join(root, 'projects.json'), path.join(linkedDir, 'projects.json'))
      await assert.rejects(loadDatasetBundle(linkedDir), { message: 'DATASET_UNAVAILABLE' })
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    }

    try {
      await symlink(root, path.join(root, 'root-link'), 'junction')
      await assert.rejects(loadDatasetBundle(path.join(root, 'root-link')), { message: 'DATASET_UNAVAILABLE' })
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    }

    await rm(path.join(root, 'projects.json'))
    await writeFile(path.join(root, 'projects.json'), 'x'.repeat(16 * 1024 * 1024 + 1), 'utf8')
    await assert.rejects(loadDatasetBundle(root), { message: 'DATASET_UNAVAILABLE' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
