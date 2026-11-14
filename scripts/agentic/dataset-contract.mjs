import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const DATASET_FILES = Object.freeze({
  projects: 'projects.json',
  retrievalTasks: 'retrieval-tasks.json',
  retrievalLabels: 'retrieval-labels.json',
  generationTasks: 'generation-tasks.json',
  generationLabels: 'generation-labels.json',
  reviewPacket: 'review-packet.json',
  reviewKey: 'review-key.json',
  repairSamples: 'repair-samples.json',
  repairKey: 'repair-key.json'
})
const LANGUAGES = Object.freeze(['Python', 'JavaScript', 'TypeScript'])
const ROLE_FOCUS = new Set(['general', 'frontend', 'backend', 'algorithm'])
const GRANULARITIES = new Set(['coarse', 'medium', 'fine'])
const REQUIRED_RETRIEVAL_TAGS = Object.freeze([
  'Python', 'JavaScript', 'TypeScript', 'cross-file', 'inheritance-callback',
  'conditions-exceptions', 'config-vs-behavior', 'index-failure'
])
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PRIVATE_PACKET_KEYS = new Set([
  'labels', 'label', 'truth', 'oracle', 'hint', 'hints', 'expectedfacts',
  'materialerror', 'errors', 'facts', 'expectedrepairfacts', 'errorexplanation',
  'requiredevidencegroups', 'notes'
])

export function canonicalJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]))
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function hashEvidenceRange(content, startLine, endLine) {
  return sha256(Buffer.from(content.split('\n').slice(startLine - 1, endLine).join('\n'), 'utf8'))
}

async function assertRegularFileWithin(root, filePath) {
  const relative = path.relative(root, filePath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('DATASET_UNAVAILABLE')
  }
  let cursor = root
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    let stats
    try {
      stats = await lstat(cursor)
    } catch {
      throw new Error('DATASET_UNAVAILABLE')
    }
    if (stats.isSymbolicLink() || ((stats.attributes ?? 0) & 0x400) !== 0) throw new Error('DATASET_UNAVAILABLE')
  }
  const stats = await lstat(filePath)
  if (!stats.isFile() || stats.size > MAX_DOCUMENT_BYTES) throw new Error('DATASET_UNAVAILABLE')
  return stats.size
}

export async function loadDatasetBundle(rootDir) {
  let root
  try {
    root = await realpath(rootDir)
    const rootStats = await lstat(rootDir)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('DATASET_UNAVAILABLE')
  } catch {
    throw new Error('DATASET_UNAVAILABLE')
  }
  const bundle = {}
  let totalBytes = 0
  for (const [key, filename] of Object.entries(DATASET_FILES)) {
    const filePath = path.join(root, filename)
    try {
      totalBytes += await assertRegularFileWithin(root, filePath)
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('DATASET_UNAVAILABLE')
      bundle[key] = JSON.parse(await readFile(filePath, 'utf8'))
    } catch {
      throw new Error('DATASET_UNAVAILABLE')
    }
  }
  return bundle
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.includes(key))
}

function hasPrivatePacketField(value) {
  if (Array.isArray(value)) return value.some(hasPrivatePacketField)
  if (!isObject(value)) return false
  return Object.entries(value).some(([key, item]) => PRIVATE_PACKET_KEYS.has(key.toLowerCase()) || hasPrivatePacketField(item))
}

function add(issues, condition, message) {
  if (condition) issues.push(message)
}

export function validateDatasetBundle(bundle) {
  const issues = []
  const counts = { projects: 0, retrievalTasks: 0, retrievalLabels: 0, generationTasks: 0, generationLabels: 0, reviewSamples: 0, reviewLabels: 0, repairSamples: 0, repairLabels: 0 }
  const coverage = Object.fromEntries(REQUIRED_RETRIEVAL_TAGS.map((tag) => [tag, 0]))
  if (!isObject(bundle)) return { valid: false, issues: ['bundle must be an object'], counts, coverage }

  const documents = [
    ['projects', bundle.projects, 'projects'],
    ['retrievalTasks', bundle.retrievalTasks, 'tasks'],
    ['retrievalLabels', bundle.retrievalLabels, 'labels'],
    ['generationTasks', bundle.generationTasks, 'tasks'],
    ['generationLabels', bundle.generationLabels, 'labels'],
    ['reviewPacket', bundle.reviewPacket, 'samples'],
    ['reviewKey', bundle.reviewKey, 'labels'],
    ['repairSamples', bundle.repairSamples, 'samples'],
    ['repairKey', bundle.repairKey, 'labels']
  ]
  for (const [name, document] of documents) {
    add(issues, !isObject(document) || document.schemaVersion !== 1, `${name} must use schemaVersion 1`)
  }
  for (const [name, document, keys] of [
    ['projects', bundle.projects, ['schemaVersion', 'split', 'projects']],
    ['retrieval tasks', bundle.retrievalTasks, ['schemaVersion', 'tasks']],
    ['retrieval labels', bundle.retrievalLabels, ['schemaVersion', 'labels']],
    ['generation tasks', bundle.generationTasks, ['schemaVersion', 'tasks']],
    ['generation labels', bundle.generationLabels, ['schemaVersion', 'labels']],
    ['review packet', bundle.reviewPacket, ['schemaVersion', 'samples']],
    ['review key', bundle.reviewKey, ['schemaVersion', 'labels']],
    ['repair samples', bundle.repairSamples, ['schemaVersion', 'samples']],
    ['repair key', bundle.repairKey, ['schemaVersion', 'labels']]
  ]) add(issues, !hasOnlyKeys(document, keys), `${name} document has unknown fields`)
  add(issues, hasPrivatePacketField(bundle.reviewPacket), 'review packet contains private label material')
  add(issues, hasPrivatePacketField(bundle.repairSamples), 'repair packet contains private label material')

  const projects = bundle.projects?.projects
  const retrievalTasks = bundle.retrievalTasks?.tasks
  const retrievalLabels = bundle.retrievalLabels?.labels
  const generationTasks = bundle.generationTasks?.tasks
  const generationLabels = bundle.generationLabels?.labels
  const reviewSamples = bundle.reviewPacket?.samples
  const reviewLabels = bundle.reviewKey?.labels
  const repairSamples = bundle.repairSamples?.samples
  const repairLabels = bundle.repairKey?.labels
  for (const [name, value] of [['projects', projects], ['retrieval tasks', retrievalTasks], ['retrieval labels', retrievalLabels], ['generation tasks', generationTasks], ['generation labels', generationLabels], ['review samples', reviewSamples], ['review labels', reviewLabels], ['repair samples', repairSamples], ['repair labels', repairLabels]]) {
    add(issues, !Array.isArray(value), `${name} must be an array`)
  }
  if (![projects, retrievalTasks, retrievalLabels, generationTasks, generationLabels, reviewSamples, reviewLabels, repairSamples, repairLabels].every(Array.isArray)) {
    return { valid: false, issues, counts, coverage }
  }

  Object.assign(counts, { projects: projects.length, retrievalTasks: retrievalTasks.length, retrievalLabels: retrievalLabels.length, generationTasks: generationTasks.length, generationLabels: generationLabels.length, reviewSamples: reviewSamples.length, reviewLabels: reviewLabels.length, repairSamples: repairSamples.length, repairLabels: repairLabels.length })
  add(issues, retrievalTasks.length !== 20, 'retrieval task count must be 20')
  add(issues, generationTasks.length !== 12, 'generation task count must be 12')
  add(issues, reviewSamples.length !== 80, 'review sample count must be 80')
  add(issues, reviewLabels.length !== 80, 'review label count must be 80')
  add(issues, repairSamples.length !== 20, 'repair sample count must be 20')
  add(issues, repairLabels.length !== 20, 'repair label count must be 20')
  add(issues, bundle.projects?.split !== 'development-synthetic', 'projects split must be development-synthetic')

  const projectById = new Map()
  const globalIds = new Set()
  const registerId = (id, label) => {
    add(issues, typeof id !== 'string' || id.length === 0, `${label} id is required`)
    if (typeof id === 'string' && id.length > 0) {
      add(issues, globalIds.has(id), `duplicate id: ${label}`)
      globalIds.add(id)
    }
  }
  for (const project of projects) {
    if (!isObject(project)) { issues.push('project entry must be an object'); continue }
    add(issues, !hasOnlyKeys(project, ['id', 'language', 'sourceKind', 'files', 'contentSha256']), 'project has unknown fields')
    registerId(project.id, 'project')
    add(issues, !LANGUAGES.includes(project.language), 'project language is invalid')
    add(issues, project.sourceKind !== 'authored-fixture', 'project sourceKind must be authored-fixture')
    add(issues, !Array.isArray(project.files) || project.files.length === 0, 'project files must be a non-empty array')
    if (!Array.isArray(project.files)) continue
    const paths = new Set()
    for (const file of project.files) {
      if (!isObject(file)) { issues.push('project file entry must be an object'); continue }
      add(issues, !hasOnlyKeys(file, ['path', 'content', 'sha256']), 'project file has unknown fields')
      const safe = typeof file.path === 'string' && file.path.length > 0 && !file.path.includes('\\') && !file.path.includes('\0') && !file.path.includes(':') && !file.path.startsWith('/') && !/^[a-zA-Z]:/.test(file.path) && file.path.split('/').every((part) => part && part !== '.' && part !== '..')
      add(issues, !safe, 'project file path is unsafe')
      add(issues, paths.has(file.path), 'project contains duplicate file paths')
      paths.add(file.path)
      add(issues, typeof file.content !== 'string' || file.content.includes('\r'), 'project content must be LF text')
      add(issues, typeof file.content === 'string' && Buffer.byteLength(file.content, 'utf8') > MAX_DOCUMENT_BYTES, 'project file exceeds size limit')
      add(issues, !HASH_PATTERN.test(file.sha256 ?? '') || (typeof file.content === 'string' && sha256(Buffer.from(file.content, 'utf8')) !== file.sha256), 'project file hash mismatch')
    }
    const summary = {
      id: project.id,
      language: project.language,
      files: project.files.filter(isObject).map(({ path: filePath, sha256: fileHash }) => ({ path: filePath, sha256: fileHash }))
    }
    add(issues, !HASH_PATTERN.test(project.contentSha256 ?? '') || sha256(Buffer.from(canonicalJson(summary), 'utf8')) !== project.contentSha256, 'project content hash mismatch')
    if (typeof project.id === 'string') projectById.set(project.id, project)
  }

  const objectives = new Set()
  for (const [kind, tasks] of [['retrieval', retrievalTasks], ['generation', generationTasks]]) {
    for (const task of tasks) {
      if (!isObject(task)) { issues.push(`${kind} task entry must be an object`); continue }
      const allowedTaskKeys = kind === 'retrieval' ? ['id', 'projectId', 'objective', 'roleFocus', 'granularity', 'tags', 'indexMode'] : ['id', 'projectId', 'objective', 'roleFocus', 'granularity', 'topic']
      add(issues, !hasOnlyKeys(task, allowedTaskKeys), `${kind} task has unknown fields`)
      registerId(task.id, `${kind} task`)
      add(issues, !projectById.has(task.projectId), `${kind} task project is missing`)
      add(issues, typeof task.objective !== 'string' || task.objective.trim().length === 0, `${kind} task objective is required`)
      add(issues, !ROLE_FOCUS.has(task.roleFocus), `${kind} task roleFocus is invalid`)
      add(issues, !GRANULARITIES.has(task.granularity), `${kind} task granularity is invalid`)
      if (typeof task.objective === 'string') {
        add(issues, objectives.has(task.objective), 'task objectives must be distinct')
        objectives.add(task.objective)
      }
    }
  }
  const languages = { Python: 0, JavaScript: 0, TypeScript: 0 }
  for (const task of generationTasks) {
    if (isObject(task) && languages[projectById.get(task.projectId)?.language] !== undefined) languages[projectById.get(task.projectId).language] += 1
  }
  for (const language of LANGUAGES) add(issues, languages[language] !== 4, `generation task coverage must include 4 ${language} tasks`)

  const refValid = (ref, context) => {
    if (!isObject(ref)) { issues.push(`${context} evidence reference is invalid`); return null }
    add(issues, !hasOnlyKeys(ref, ['path', 'startLine', 'endLine', 'sha256']), `${context.name} evidence reference has unknown fields`)
    const projectId = context.projectId
    const project = projectById.get(projectId)
    const file = project?.files?.find((item) => isObject(item) && item.path === ref.path)
    add(issues, !file, `${context.name} evidence path is missing`)
    add(issues, !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine, `${context.name} evidence range is invalid`)
    if (!file || typeof file.content !== 'string' || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine) return null
    const lineCount = file.content.split('\n').length
    add(issues, ref.endLine > lineCount, `${context.name} evidence range is out of bounds`)
    if (ref.endLine > lineCount) return null
    add(issues, !HASH_PATTERN.test(ref.sha256 ?? '') || hashEvidenceRange(file.content, ref.startLine, ref.endLine) !== ref.sha256, `${context.name} evidence range hash mismatch`)
    return { projectId, path: ref.path }
  }

  const retrievalLabelMap = new Map()
  for (const label of retrievalLabels) {
    if (!isObject(label)) { issues.push('retrieval label entry must be an object'); continue }
    add(issues, !hasOnlyKeys(label, ['taskId', 'requiredEvidenceGroups', 'notes']), 'retrieval label has unknown fields')
    add(issues, retrievalLabelMap.has(label.taskId), 'retrieval labels contain duplicate taskId')
    retrievalLabelMap.set(label.taskId, label)
  }
  add(issues, retrievalLabelMap.size !== retrievalTasks.length || retrievalTasks.some((task) => !retrievalLabelMap.has(task?.id)), 'retrieval labels must bijectively match tasks')
  for (const task of retrievalTasks) {
    if (!isObject(task)) continue
    const tags = Array.isArray(task.tags) ? task.tags : []
    for (const tag of REQUIRED_RETRIEVAL_TAGS) {
      if (tags.includes(tag)) coverage[tag] += 1
    }
    if (Array.isArray(task.tags)) add(issues, new Set(task.tags).size !== task.tags.length || task.tags.some((tag) => typeof tag !== 'string'), 'retrieval task tags must be unique strings')
    if (tags.includes('index-failure')) add(issues, task.indexMode !== 'unavailable', 'index-failure task must use unavailable index mode')
    else add(issues, !['normal', 'unavailable'].includes(task.indexMode), 'retrieval indexMode is invalid')
    const label = retrievalLabelMap.get(task.id)
    if (!label) continue
    const groups = label.requiredEvidenceGroups
    add(issues, !Array.isArray(groups) || groups.length === 0, 'retrieval label needs required evidence groups')
    if (!Array.isArray(groups)) continue
    const groupIds = new Set()
    const allRequiredPaths = new Set()
    for (const group of groups) {
      if (!isObject(group)) { issues.push('retrieval evidence group is invalid'); continue }
      add(issues, !hasOnlyKeys(group, ['id', 'allOf']), 'retrieval evidence group has unknown fields')
      add(issues, typeof group.id !== 'string' || !group.id || groupIds.has(group.id), 'retrieval evidence group ids must be unique')
      groupIds.add(group.id)
      add(issues, !Array.isArray(group.allOf) || group.allOf.length === 0, 'retrieval evidence group must require evidence')
      if (!Array.isArray(group.allOf)) continue
      const refs = group.allOf.map((ref) => refValid(ref, { projectId: task.projectId, name: 'retrieval' })).filter(Boolean)
      const uniqueRefs = new Set(group.allOf.map((ref) => isObject(ref) ? `${ref.path}:${ref.startLine}-${ref.endLine}` : 'invalid'))
      add(issues, uniqueRefs.size !== group.allOf.length, 'retrieval evidence group repeats an evidence range')
      for (const ref of refs) allRequiredPaths.add(ref.path)
    }
    add(issues, tags.includes('cross-file') && allRequiredPaths.size < 2, 'cross-file task requires multiple source files across required groups')
  }
  for (const tag of REQUIRED_RETRIEVAL_TAGS) add(issues, coverage[tag] < 2, `retrieval tag coverage is below 2: ${tag}`)

  const generationLabelMap = new Map()
  for (const label of generationLabels) {
    if (!isObject(label)) { issues.push('generation label entry must be an object'); continue }
    add(issues, !hasOnlyKeys(label, ['taskId', 'evidence', 'expectedFacts', 'pitfalls']), 'generation label has unknown fields')
    add(issues, generationLabelMap.has(label.taskId), 'generation labels contain duplicate taskId')
    generationLabelMap.set(label.taskId, label)
  }
  add(issues, generationLabelMap.size !== generationTasks.length || generationTasks.some((task) => !generationLabelMap.has(task?.id)), 'generation labels must bijectively match tasks')
  for (const task of generationTasks) {
    if (!isObject(task)) continue
    const label = generationLabelMap.get(task.id)
    if (!label) continue
    add(issues, !Array.isArray(label.evidence) || label.evidence.length === 0, 'generation label needs evidence')
    add(issues, !Array.isArray(label.expectedFacts) || label.expectedFacts.length === 0, 'generation label needs expected facts')
    add(issues, !Array.isArray(label.pitfalls), 'generation label pitfalls must be an array')
    for (const fact of Array.isArray(label.expectedFacts) ? label.expectedFacts : []) {
      add(issues, !hasOnlyKeys(fact, ['id', 'claim']), 'generation expected fact has unknown fields')
      add(issues, !isObject(fact) || typeof fact.id !== 'string' || !fact.id || typeof fact.claim !== 'string' || !fact.claim.trim(), 'generation expected fact is invalid')
    }
    for (const ref of Array.isArray(label.evidence) ? label.evidence : []) refValid(ref, { projectId: task.projectId, name: 'generation' })
  }

  const sampleMap = (samples, name) => {
    const map = new Map()
    for (const sample of samples) {
      if (!isObject(sample)) { issues.push(`${name} sample entry must be an object`); continue }
      add(issues, !hasOnlyKeys(sample, ['id', 'projectId', 'question', 'answer', 'followUps', 'evidence', 'answerFingerprint']), `${name} sample has unknown fields`)
      registerId(sample.id, `${name} sample`)
      add(issues, !projectById.has(sample.projectId), `${name} sample project is missing`)
      add(issues, typeof sample.question !== 'string' || !sample.question.trim(), `${name} question is required`)
      add(issues, typeof sample.answer !== 'string' || !sample.answer.trim(), `${name} answer is required`)
      add(issues, !Array.isArray(sample.followUps), `${name} followUps must be an array`)
      for (const followUp of Array.isArray(sample.followUps) ? sample.followUps : []) {
        add(issues, !hasOnlyKeys(followUp, ['question', 'answer']), `${name} follow-up has unknown fields`)
        add(issues, !isObject(followUp) || typeof followUp.question !== 'string' || typeof followUp.answer !== 'string', `${name} follow-up is invalid`)
      }
      const canonical = canonicalJson({ question: sample.question, answer: sample.answer, followUps: sample.followUps })
      const fingerprint = typeof canonical === 'string' ? sha256(Buffer.from(canonical, 'utf8')) : null
      add(issues, !fingerprint || !HASH_PATTERN.test(sample.answerFingerprint ?? '') || sample.answerFingerprint !== fingerprint, `${name} answer fingerprint mismatch`)
      for (const ref of Array.isArray(sample.evidence) ? sample.evidence : []) refValid(ref, { projectId: sample.projectId, name })
      add(issues, !Array.isArray(sample.evidence) || sample.evidence.length === 0, `${name} sample needs evidence`)
      map.set(sample.id, sample)
    }
    return map
  }
  const reviewSampleMap = sampleMap(reviewSamples, 'review')
  const repairSampleMap = sampleMap(repairSamples, 'repair')
  for (const sample of reviewSamples) add(issues, hasPrivatePacketField(sample), 'review packet contains a private label field')
  for (const sample of repairSamples) add(issues, hasPrivatePacketField(sample), 'repair samples contain a private label field')

  const fingerprints = new Set()
  for (const sample of [...reviewSamples, ...repairSamples]) {
    if (!isObject(sample)) continue
    add(issues, fingerprints.has(sample.answerFingerprint), 'review and repair answers must be distinct')
    fingerprints.add(sample.answerFingerprint)
  }
  const reviewLabelMap = new Map()
  let badLabels = 0
  for (const label of reviewLabels) {
    if (!isObject(label)) { issues.push('review label entry must be an object'); continue }
    add(issues, !hasOnlyKeys(label, ['sampleId', 'materialError', 'errors', 'facts']), 'review label has unknown fields')
    add(issues, reviewLabelMap.has(label.sampleId), 'review labels contain duplicate sampleId')
    reviewLabelMap.set(label.sampleId, label)
    if (label.materialError === true) badLabels += 1
    add(issues, typeof label.materialError !== 'boolean', 'review materialError must be boolean')
    add(issues, label.materialError === true && (!Array.isArray(label.errors) || label.errors.length === 0), 'material-error label needs errors')
    add(issues, label.materialError === false && (!Array.isArray(label.errors) || label.errors.length !== 0), 'good-answer label must have no errors')
    add(issues, !Array.isArray(label.facts), 'review facts must be an array')
    add(issues, !Array.isArray(label.errors), 'review errors must be an array')
    for (const error of Array.isArray(label.errors) ? label.errors : []) {
      add(issues, !hasOnlyKeys(error, ['claim', 'explanation']), 'review error has unknown fields')
      add(issues, !isObject(error) || typeof error.claim !== 'string' || typeof error.explanation !== 'string', 'review error is invalid')
    }
    for (const fact of Array.isArray(label.facts) ? label.facts : []) add(issues, typeof fact !== 'string', 'review facts must be strings')
  }
  add(issues, badLabels !== 40, 'review key must contain 40 material-error labels')
  add(issues, reviewLabelMap.size !== reviewSamples.length || reviewSamples.some((sample) => !reviewLabelMap.has(sample?.id)), 'review labels must bijectively match samples')
  const repairLabelMap = new Map()
  for (const label of repairLabels) {
    if (!isObject(label)) { issues.push('repair label entry must be an object'); continue }
    add(issues, !hasOnlyKeys(label, ['sampleId', 'expectedRepairFacts', 'errorExplanation']), 'repair label has unknown fields')
    add(issues, repairLabelMap.has(label.sampleId), 'repair labels contain duplicate sampleId')
    repairLabelMap.set(label.sampleId, label)
    add(issues, !Array.isArray(label.expectedRepairFacts) || label.expectedRepairFacts.length === 0, 'repair key needs expected repair facts')
    if (Array.isArray(label.expectedRepairFacts)) add(issues, label.expectedRepairFacts.some((fact) => typeof fact !== 'string' || !fact.trim()), 'repair expected facts must be non-empty strings')
    add(issues, typeof label.errorExplanation !== 'string' || !label.errorExplanation.trim(), 'repair key needs an error explanation')
  }
  add(issues, repairLabelMap.size !== repairSamples.length || repairSamples.some((sample) => !repairLabelMap.has(sample?.id)), 'repair labels must bijectively match samples')
  for (const id of reviewLabelMap.keys()) add(issues, !reviewSampleMap.has(id), 'review label references an unknown sample')
  for (const id of repairLabelMap.keys()) add(issues, !repairSampleMap.has(id), 'repair label references an unknown sample')

  return { valid: issues.length === 0, issues, counts, coverage }
}

export function assertDatasetBundle(bundle) {
  const result = validateDatasetBundle(bundle)
  if (!result.valid) throw new Error('DATASET_CONTRACT_INVALID')
  return result
}

export function createBlindReviewPacket(bundle) {
  const publicSample = (sample) => ({
    id: sample?.id,
    projectId: sample?.projectId,
    question: sample?.question,
    answer: sample?.answer,
    followUps: Array.isArray(sample?.followUps) ? sample.followUps.map(({ question, answer } = {}) => ({ question, answer })) : [],
    evidence: Array.isArray(sample?.evidence) ? sample.evidence.map(({ path: sourcePath, startLine, endLine, sha256: hash } = {}) => ({ path: sourcePath, startLine, endLine, sha256: hash })) : [],
    answerFingerprint: sample?.answerFingerprint
  })
  const packet = {
    schemaVersion: 1,
    reviewPacket: { schemaVersion: 1, samples: Array.isArray(bundle?.reviewPacket?.samples) ? bundle.reviewPacket.samples.map(publicSample) : [] },
    repairSamples: { schemaVersion: 1, samples: Array.isArray(bundle?.repairSamples?.samples) ? bundle.repairSamples.samples.map(publicSample) : [] }
  }
  return packet
}
