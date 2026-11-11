import { randomInt, randomUUID } from 'node:crypto'
import { lstat, open, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 } from './dataset-contract.mjs'
import { normalizeBaseUrl } from '../../electron/services/llm.ts'
import { resolveGenerationBudget } from '../../shared/token-budget.ts'
import { createRunSpec, fingerprintRunSpec } from '../../electron/services/workflow/run-spec.ts'
import { validateSingleQuestionEvaluationInput } from '../../electron/services/workflow/question-patch.ts'

export const SEMANTIC_PURPOSE = 'm09-semantic-v1'
export const SEMANTIC_PROTOCOL = 'm09-semantic-execution-v1'
export const SEMANTIC_LIMITS = Object.freeze({
  reviews: 80, repairs: 20, cases: 100,
  aggregate: Object.freeze({ maxRequests: 240, inputAdmission: 1_600_000, outputReservation: 1_146_880 }),
  review: Object.freeze({ maxRequests: 2, inputAdmission: 12_000, outputReservation: 8192, callOutputCap: 4096 }),
  repair: Object.freeze({ maxRequests: 4, inputAdmission: 32_000, outputReservation: 24_576, callOutputCap: 8192 }),
  original: Object.freeze({ coarseRequests: 5, fineRequests: 14, inputTokens: 128_000, outputTokens: 65_536, wallClockMs: 600_000 }),
  files: Object.freeze({ documentBytes: 16 * 1024 * 1024, publicBytes: 64 * 1024 * 1024, artifactBytes: 16 * 1024 * 1024, executionBytes: 128 * 1024 * 1024, maxArtifacts: 2048, maxJournalEvents: 2048 })
})
export const SEMANTIC_PUBLIC_FILES = Object.freeze(['projects.json', 'review-packet.json', 'repair-samples.json'])
export const SEMANTIC_MANIFEST_UNAVAILABLE = 'actual-manifest-accessor-unavailable'
const DEFAULT_DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datasets', 'v1')
const HASH = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const UNIT = /^unit-[a-f0-9-]{36}$/u
const QUESTION = /^question-[a-f0-9-]{36}$/u
const PROJECT = /^project-[a-f0-9-]{36}$/u
const EVIDENCE = /^ev_[a-f0-9-]{36}$/u
const LANGUAGES = new Set(['Python', 'JavaScript', 'TypeScript'])
const PRIVATE_FIELD = /^(?:labels?|truth|oracle|hints?|expectedfacts|materialerror|errors|facts|expectedrepairfacts|errorexplanation|requiredevidencegroups|notes|author|strategy|provider|apikey|credentials?|reasoning)$/iu
export const semanticHash = value => sha256(Buffer.from(canonicalJson(value), 'utf8'))
export const semanticFail = (code) => { throw new Error(code) }
export const semanticAssert = (condition, code = 'semantic-contract-invalid') => { if (!condition) semanticFail(code) }
export function freezeSemanticValue(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSemanticValue(child)
    Object.freeze(value)
  }
  return value
}
export function semanticRecord(value, allowed, required = allowed) {
  semanticAssert(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    semanticAssert(typeof key === 'string' && allowed.includes(key) && descriptor && 'value' in descriptor && descriptor.enumerable)
  }
  semanticAssert(required.every(key => Object.hasOwn(value, key)))
}
export function semanticArray(value, min, max) {
  semanticAssert(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= min && value.length <= max && Reflect.ownKeys(value).length === value.length + 1)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    semanticAssert(descriptor && 'value' in descriptor && descriptor.enumerable)
  }
}
export function semanticText(value, max, allowEmpty = false) {
  semanticAssert(typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) && !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value)
}
export function safeSemanticRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\:\0]/u.test(value) && !value.startsWith('/') &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part) && !/[<>"|?*\x00-\x1f]/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}
function noPrivateFields(value) {
  if (Array.isArray(value)) { for (const child of value) noPrivateFields(child); return }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) { semanticAssert(!PRIVATE_FIELD.test(key), 'semantic-public-private-field'); noPrivateFields(child) }
}
function integer(value, min, max) { semanticAssert(Number.isSafeInteger(value) && value >= min && value <= max) }
function hash(value) { semanticAssert(HASH.test(value ?? '')) }
function plainBytes(value) { return Buffer.from(value, 'utf8') }

/** @internal Reject links along every existing absolute path component, including root ancestors. */
export async function assertSafeSemanticDirectory(directory) {
  semanticText(directory, 4096)
  semanticAssert(path.isAbsolute(directory), 'semantic-unsafe-path')
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let cursor = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = await lstat(cursor).catch(() => semanticFail('semantic-unsafe-path'))
    semanticAssert(stat.isDirectory() && !stat.isSymbolicLink() && ((stat.attributes ?? 0) & 0x400) === 0, 'semantic-unsafe-path')
  }
  const resolved = await realpath(absolute)
  semanticAssert((process.platform === 'win32' ? resolved.toLowerCase() : resolved) === (process.platform === 'win32' ? absolute.toLowerCase() : absolute), 'semantic-unsafe-path')
  return absolute
}
/** @internal A caller supplies an allowlisted relative artifact path, never a model path. */
export async function readSemanticFile(directory, relative, maxBytes = SEMANTIC_LIMITS.files.documentBytes) {
  semanticAssert(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= SEMANTIC_LIMITS.files.artifactBytes, 'semantic-file-limit')
  const root = await assertSafeSemanticDirectory(directory)
  semanticAssert(safeSemanticRelativePath(relative), 'semantic-unsafe-path')
  const absolute = path.resolve(root, ...relative.split('/'))
  semanticAssert(absolute.startsWith(root + path.sep), 'semantic-unsafe-path')
  await assertSafeSemanticDirectory(path.dirname(absolute))
  const before = await lstat(absolute).catch(() => semanticFail('semantic-file-unavailable'))
  semanticAssert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maxBytes && ((before.attributes ?? 0) & 0x400) === 0, 'semantic-file-unavailable')
  const handle = await open(absolute, 'r')
  try {
    const actual = await handle.stat()
    semanticAssert(actual.isFile() && actual.nlink === 1 && actual.size === before.size && actual.ino === before.ino && actual.dev === before.dev && actual.mtimeMs === before.mtimeMs && actual.ctimeMs === before.ctimeMs, 'semantic-file-changed')
    const chunks = []; let length = 0; let position = 0
    while (length <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(65_536, maxBytes + 1 - length))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (!bytesRead) break
      chunks.push(chunk.subarray(0, bytesRead)); length += bytesRead; position += bytesRead
    }
    semanticAssert(length <= maxBytes, 'semantic-file-oversized')
    const bytes = Buffer.concat(chunks, length)
    const after = await handle.stat()
    semanticAssert(bytes.length <= maxBytes && bytes.length === before.size && after.size === actual.size && after.mtimeMs === actual.mtimeMs && after.ctimeMs === actual.ctimeMs, 'semantic-file-changed')
    const final = await lstat(absolute)
    semanticAssert(final.isFile() && !final.isSymbolicLink() && final.nlink === 1 && final.ino === actual.ino && final.dev === actual.dev && final.size === actual.size && final.ctimeMs === actual.ctimeMs && final.mtimeMs === actual.mtimeMs, 'semantic-file-changed')
    await assertSafeSemanticDirectory(path.dirname(absolute))
    return bytes
  } finally { await handle.close() }
}
/** Strict independent JSON parser: duplicate keys and deep/oversized structures fail before schema use. */
export function parseSemanticJson(bytes) {
  semanticAssert(bytes && bytes.length <= SEMANTIC_LIMITS.files.documentBytes, 'semantic-json-oversized')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { semanticFail('semantic-json-invalid') }
  let cursor = 0; let nodes = 0
  const bad = () => semanticFail('semantic-json-invalid')
  const space = () => { while (cursor < text.length && /[\x20\t\r\n]/u.test(text[cursor])) cursor++ }
  const string = () => {
    if (text[cursor] !== '"') bad()
    const start = cursor++
    while (cursor < text.length) {
      const char = text[cursor++]
      if (char === '"') {
        try { return JSON.parse(text.slice(start, cursor)) } catch { bad() }
      }
      if (char === '\\') { if (cursor >= text.length) bad(); cursor++ }
      else if (char.charCodeAt(0) < 32) bad()
    }
    bad()
  }
  const value = depth => {
    if (++nodes > 250_000 || depth > 48) bad()
    space()
    const char = text[cursor]
    if (char === '"') return string()
    if (char === '{') {
      cursor++; space(); const object = {}; const keys = new Set()
      if (text[cursor] === '}') { cursor++; return object }
      while (cursor < text.length) {
        space(); const key = string()
        if (keys.has(key)) bad()
        keys.add(key); space(); if (text[cursor++] !== ':') bad()
        const child = value(depth + 1)
        Object.defineProperty(object, key, { value: child, enumerable: true, writable: true, configurable: true })
        space(); const next = text[cursor++]
        if (next === '}') return object
        if (next !== ',') bad()
      }
      bad()
    }
    if (char === '[') {
      cursor++; space(); const array = []
      if (text[cursor] === ']') { cursor++; return array }
      while (cursor < text.length) {
        array.push(value(depth + 1)); space(); const next = text[cursor++]
        if (next === ']') return array
        if (next !== ',') bad()
      }
      bad()
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, cursor)) { cursor += literal.length; return result }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(cursor))
    if (!match) bad()
    cursor += match[0].length
    const number = Number(match[0]); if (!Number.isFinite(number)) bad()
    return number
  }
  const result = value(0)
  space(); if (cursor !== text.length) bad()
  return result
}
function fileKey(file) { return file.path.toLowerCase() }
function sampleContent(sample) {
  return { question: sample.question, answer: sample.answer, followUps: sample.followUps.map(follow => ({ question: follow.question, answer: follow.answer })) }
}
export function semanticSampleUnit(sample, questionId) {
  semanticAssert(QUESTION.test(questionId), 'semantic-question-id-invalid')
  const question = { id: questionId, ...sampleContent(sample) }
  return validateSingleQuestionEvaluationInput(question, {})
}
export function semanticContentUnit(unit) {
  semanticRecord(unit, ['question', 'glossary'])
  const { id: _id, ...content } = unit.question
  const validated = validateSingleQuestionEvaluationInput({ id: 'evaluation-question', ...content }, unit.glossary)
  const { id: _validatedId, ...question } = validated.question
  return freezeSemanticValue({ question, glossary: structuredClone(validated.glossary) })
}
export function validateSemanticContentUnit(value) {
  semanticRecord(value, ['question', 'glossary'])
  semanticRecord(value.question, ['title', 'question', 'answer', 'followUps'], ['question', 'answer', 'followUps'])
  const copied = semanticContentUnit({ question: { id: 'evaluation-question', ...value.question }, glossary: value.glossary })
  semanticAssert(canonicalJson(copied) === canonicalJson(value), 'semantic-content-invalid')
  return copied
}
export function validateSemanticPublicDocuments(documents) {
  semanticRecord(documents, SEMANTIC_PUBLIC_FILES)
  const projectsDocument = documents['projects.json']
  semanticRecord(projectsDocument, ['schemaVersion', 'split', 'projects'])
  semanticAssert(projectsDocument.schemaVersion === 1 && projectsDocument.split === 'development-synthetic')
  semanticArray(projectsDocument.projects, 1, 32)
  const projectById = new Map()
  const ids = new Set()
  let sourceBytes = 0; let sourceFiles = 0
  const register = id => { semanticAssert(ID.test(id ?? '') && !ids.has(id), 'semantic-public-duplicate'); ids.add(id) }
  for (const project of projectsDocument.projects) {
    semanticRecord(project, ['id', 'language', 'sourceKind', 'files', 'contentSha256'])
    register(project.id)
    semanticAssert(LANGUAGES.has(project.language) && project.sourceKind === 'authored-fixture')
    semanticArray(project.files, 1, 128)
    sourceFiles += project.files.length
    const paths = new Set()
    for (const file of project.files) {
      semanticRecord(file, ['path', 'content', 'sha256'])
      semanticAssert(safeSemanticRelativePath(file.path), 'semantic-unsafe-path')
      semanticText(file.content, SEMANTIC_LIMITS.files.documentBytes, true)
      semanticAssert(!file.content.includes('\r') && !paths.has(fileKey(file)), 'semantic-public-file-invalid')
      for (const prior of paths) semanticAssert(!prior.startsWith(fileKey(file) + '/') && !fileKey(file).startsWith(prior + '/'), 'semantic-public-file-invalid')
      paths.add(fileKey(file))
      const bytes = plainBytes(file.content)
      sourceBytes += bytes.length
      semanticAssert(bytes.length <= SEMANTIC_LIMITS.files.documentBytes && sha256(bytes) === file.sha256, 'semantic-public-file-hash')
    }
    semanticAssert(sourceFiles <= 1024 && sourceBytes <= SEMANTIC_LIMITS.files.publicBytes)
    const summary = { id: project.id, language: project.language, files: project.files.map(({ path: relative, sha256: fileHash }) => ({ path: relative, sha256: fileHash })) }
    semanticAssert(semanticHash(summary) === project.contentSha256, 'semantic-public-project-hash')
    projectById.set(project.id, project)
  }
  const fingerprints = new Set()
  for (const [filename, count] of [['review-packet.json', 80], ['repair-samples.json', 20]]) {
    const doc = documents[filename]
    noPrivateFields(doc)
    semanticRecord(doc, ['schemaVersion', 'samples'])
    semanticAssert(doc.schemaVersion === 1)
    semanticArray(doc.samples, count, count)
    for (const sample of doc.samples) {
      semanticRecord(sample, ['id', 'projectId', 'question', 'answer', 'followUps', 'evidence', 'answerFingerprint'])
      register(sample.id)
      const project = projectById.get(sample.projectId)
      semanticAssert(project, 'semantic-public-project-missing')
      semanticText(sample.question, 32_000); semanticText(sample.answer, 200_000)
      semanticArray(sample.followUps, 0, 32)
      for (const follow of sample.followUps) { semanticRecord(follow, ['question', 'answer']); semanticText(follow.question, 32_000); semanticText(follow.answer, 200_000) }
      semanticAssert(semanticHash(sampleContent(sample)) === sample.answerFingerprint && !fingerprints.has(sample.answerFingerprint), 'semantic-public-fingerprint')
      fingerprints.add(sample.answerFingerprint)
      // Reuse the actual single-question grammar, without source or billing authority.
      semanticSampleUnit(sample, 'question-00000000-0000-4000-8000-000000000000')
      semanticArray(sample.evidence, 1, 16)
      const refs = new Set()
      for (const ref of sample.evidence) {
        semanticRecord(ref, ['path', 'startLine', 'endLine', 'sha256'])
        semanticAssert(safeSemanticRelativePath(ref.path), 'semantic-unsafe-path')
        const file = project.files.find(file => file.path === ref.path)
        semanticAssert(file, 'semantic-public-evidence-missing')
        integer(ref.startLine, 1, 1_000_000); integer(ref.endLine, ref.startLine, 1_000_000)
        const lines = file.content.split('\n')
        semanticAssert(ref.endLine <= lines.length, 'semantic-public-evidence-range')
        const text = lines.slice(ref.startLine - 1, ref.endLine).join('\n')
        semanticAssert(sha256(plainBytes(text)) === ref.sha256, 'semantic-public-evidence-hash')
        const key = canonicalJson(ref)
        semanticAssert(!refs.has(key), 'semantic-public-evidence-duplicate'); refs.add(key)
      }
    }
  }
  return { sourceBytes, sourceFiles }
}
function assetSet(documents, rawHashes) {
  return Object.fromEntries(SEMANTIC_PUBLIC_FILES.map(name => {
    hash(rawHashes[name])
    return [name, { rawSha256: rawHashes[name], canonicalSha256: semanticHash(documents[name]) }]
  }))
}
export function projectSemanticPublicData(documents, rawHashes) {
  validateSemanticPublicDocuments(documents)
  semanticRecord(rawHashes, SEMANTIC_PUBLIC_FILES)
  const assets = assetSet(documents, rawHashes)
  return freezeSemanticValue({ schemaVersion: 1, split: 'development-synthetic', documents: structuredClone(documents), assets, publicDataHash: semanticHash({ schemaVersion: 1, assets }) })
}
export function validateSemanticPublicBundle(bundle) {
  semanticRecord(bundle, ['schemaVersion', 'split', 'documents', 'assets', 'publicDataHash'])
  semanticAssert(bundle.schemaVersion === 1 && bundle.split === 'development-synthetic')
  validateSemanticPublicDocuments(bundle.documents)
  semanticRecord(bundle.assets, SEMANTIC_PUBLIC_FILES)
  for (const name of SEMANTIC_PUBLIC_FILES) {
    semanticRecord(bundle.assets[name], ['rawSha256', 'canonicalSha256'])
    hash(bundle.assets[name].rawSha256)
    semanticAssert(semanticHash(bundle.documents[name]) === bundle.assets[name].canonicalSha256)
  }
  semanticAssert(semanticHash({ schemaVersion: 1, assets: bundle.assets }) === bundle.publicDataHash)
  return true
}
export async function loadSemanticPublicBundle(directory = DEFAULT_DATA) {
  const root = await assertSafeSemanticDirectory(directory)
  const documents = {}; const hashes = {}; let total = 0
  for (const name of SEMANTIC_PUBLIC_FILES) {
    const bytes = await readSemanticFile(root, name)
    total += bytes.length
    semanticAssert(total <= SEMANTIC_LIMITS.files.publicBytes, 'semantic-public-oversized')
    documents[name] = parseSemanticJson(bytes); hashes[name] = sha256(bytes)
  }
  return projectSemanticPublicData(documents, hashes)
}
export function createSemanticExecutionPlan(bundle) {
  validateSemanticPublicBundle(bundle)
  const projects = new Map(bundle.documents['projects.json'].projects.map(project => [project.id, `project-${randomUUID()}`]))
  const entries = []
  for (const [name, kind] of [['review-packet.json', 'review'], ['repair-samples.json', 'repair']]) {
    for (const sample of bundle.documents[name].samples) entries.push({ sample, kind })
  }
  for (let index = entries.length - 1; index > 0; index--) { const chosen = randomInt(index + 1); [entries[index], entries[chosen]] = [entries[chosen], entries[index]] }
  const mapping = []; const units = []
  entries.forEach(({ sample, kind }, order) => {
    const unitId = `unit-${randomUUID()}`; const questionId = `question-${randomUUID()}`
    mapping.push({ unitId, sampleId: sample.id, projectId: sample.projectId, order, kind })
    units.push({ unitId, questionId, projectId: projects.get(sample.projectId), order, kind, inputHash: semanticHash(semanticContentUnit(semanticSampleUnit(sample, questionId))), evidenceHash: semanticHash(sample.evidence) })
  })
  const mapBody = { schemaVersion: 1, publicDataHash: bundle.publicDataHash, entries: mapping }
  const executionMap = { ...mapBody, executionMapHash: semanticHash(mapBody) }
  const planBody = { schemaVersion: 1, purpose: SEMANTIC_PURPOSE, publicDataHash: bundle.publicDataHash, executionMapHash: executionMap.executionMapHash, units }
  const plan = { ...planBody, planHash: semanticHash(planBody) }
  return freezeSemanticValue({ plan, executionMap })
}
export function validateSemanticExecutionPlan(bundle, plan, executionMap) {
  validateSemanticPublicBundle(bundle)
  semanticRecord(plan, ['schemaVersion', 'purpose', 'publicDataHash', 'executionMapHash', 'units', 'planHash'])
  semanticRecord(executionMap, ['schemaVersion', 'publicDataHash', 'entries', 'executionMapHash'])
  semanticAssert(plan.schemaVersion === 1 && plan.purpose === SEMANTIC_PURPOSE && executionMap.schemaVersion === 1 && plan.publicDataHash === bundle.publicDataHash && executionMap.publicDataHash === bundle.publicDataHash)
  const { executionMapHash, ...mapBody } = executionMap
  const { planHash, ...planBody } = plan
  semanticAssert(semanticHash(mapBody) === executionMapHash && plan.executionMapHash === executionMapHash && semanticHash(planBody) === planHash, 'semantic-plan-hash')
  semanticArray(plan.units, 100, 100); semanticArray(executionMap.entries, 100, 100)
  const samples = new Map()
  for (const [name, kind] of [['review-packet.json', 'review'], ['repair-samples.json', 'repair']]) for (const sample of bundle.documents[name].samples) samples.set(sample.id, { sample, kind })
  const ids = new Set(); const questions = new Set(); const seenSamples = new Set(); const projectMap = new Map(); const reverseProjectMap = new Map()
  for (let order = 0; order < 100; order++) {
    const unit = plan.units[order]; const map = executionMap.entries[order]
    semanticRecord(unit, ['unitId', 'questionId', 'projectId', 'order', 'kind', 'inputHash', 'evidenceHash'])
    semanticRecord(map, ['unitId', 'sampleId', 'projectId', 'order', 'kind'])
    const expected = samples.get(map.sampleId)
    semanticAssert(expected && expected.kind === unit.kind && map.kind === unit.kind && map.projectId === expected.sample.projectId && map.unitId === unit.unitId && map.order === order && unit.order === order, 'semantic-plan-bijection')
    semanticAssert(UNIT.test(unit.unitId) && QUESTION.test(unit.questionId) && PROJECT.test(unit.projectId) && !ids.has(unit.unitId) && !questions.has(unit.questionId) && !seenSamples.has(map.sampleId), 'semantic-plan-bijection')
    ids.add(unit.unitId); questions.add(unit.questionId); seenSamples.add(map.sampleId)
    semanticAssert(!projectMap.has(map.projectId) || projectMap.get(map.projectId) === unit.projectId, 'semantic-plan-project')
    semanticAssert(!reverseProjectMap.has(unit.projectId) || reverseProjectMap.get(unit.projectId) === map.projectId, 'semantic-plan-project')
    projectMap.set(map.projectId, unit.projectId); reverseProjectMap.set(unit.projectId, map.projectId)
    semanticAssert(unit.inputHash === semanticHash(semanticContentUnit(semanticSampleUnit(expected.sample, unit.questionId))) && unit.evidenceHash === semanticHash(expected.sample.evidence), 'semantic-plan-input')
  }
  return true
}
const PROFILE_KEYS = ['id', 'name', 'baseUrl', 'apiKey', 'model', 'protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens']
export function deriveSemanticConfiguration(profile) {
  semanticRecord(profile, PROFILE_KEYS, ['id', 'name', 'baseUrl', 'apiKey', 'model'])
  semanticAssert(ID.test(profile.id ?? ''), 'semantic-profile-invalid')
  semanticText(profile.name, 120); semanticText(profile.model, 160); semanticText(profile.baseUrl, 2048); semanticText(profile.apiKey, 8192)
  let endpoint
  try { endpoint = new URL(profile.baseUrl) } catch { semanticFail('semantic-profile-invalid') }
  semanticAssert(['https:', 'http:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.hash && !/[\\\s]/u.test(profile.baseUrl), 'semantic-profile-invalid')
  const protocol = profile.protocol ?? 'openai'
  semanticAssert(['openai', 'anthropic'].includes(protocol) && (profile.reasoningEffort === undefined || ['low', 'high'].includes(profile.reasoningEffort)) && !(protocol === 'anthropic' && profile.reasoningEffort !== undefined), 'semantic-profile-invalid')
  if (profile.contextWindowTokens !== undefined) integer(profile.contextWindowTokens, 4096, 2_097_152)
  if (profile.maxOutputTokens !== undefined) integer(profile.maxOutputTokens, 256, 393_216)
  semanticAssert(profile.contextWindowTokens === undefined || profile.maxOutputTokens === undefined || profile.maxOutputTokens < profile.contextWindowTokens, 'semantic-profile-invalid')
  const temperature = profile.temperature ?? 0.4
  semanticAssert(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2, 'semantic-profile-invalid')
  const savedReserve = resolveGenerationBudget(profile, 'coarse').reservedOutputTokens
  const saved = { profileId: profile.id, endpointFingerprint: sha256(plainBytes(normalizeBaseUrl(profile.baseUrl))), model: profile.model, protocol, temperature, reasoningEffort: profile.reasoningEffort ?? null, contextWindowTokens: profile.contextWindowTokens ?? null, maxOutputTokens: profile.maxOutputTokens ?? null, resolvedOutputTokens: savedReserve }
  const effective = Object.fromEntries(['review', 'repair'].map(kind => [kind, { maxOutputTokens: Math.min(savedReserve, SEMANTIC_LIMITS[kind].callOutputCap), contextWindowTokens: saved.contextWindowTokens }]))
  for (const kind of ['review', 'repair']) semanticAssert(effective[kind].maxOutputTokens >= 256 && (saved.contextWindowTokens === null || effective[kind].maxOutputTokens < saved.contextWindowTokens), 'semantic-profile-context-invalid')
  const body = { schemaVersion: 1, saved, effective }
  return freezeSemanticValue({ ...body, configurationHash: semanticHash(body) })
}
export function validateSemanticConfiguration(config) {
  semanticRecord(config, ['schemaVersion', 'saved', 'effective', 'configurationHash'])
  semanticAssert(config.schemaVersion === 1)
  semanticRecord(config.saved, ['profileId', 'endpointFingerprint', 'model', 'protocol', 'temperature', 'reasoningEffort', 'contextWindowTokens', 'maxOutputTokens', 'resolvedOutputTokens'])
  semanticRecord(config.effective, ['review', 'repair'])
  const saved = config.saved
  semanticAssert(ID.test(saved.profileId ?? '') && HASH.test(saved.endpointFingerprint ?? '') && ['openai', 'anthropic'].includes(saved.protocol) && (saved.reasoningEffort === null || ['low', 'high'].includes(saved.reasoningEffort)) && !(saved.protocol === 'anthropic' && saved.reasoningEffort !== null))
  semanticText(saved.model, 160); semanticAssert(Number.isFinite(saved.temperature) && saved.temperature >= 0 && saved.temperature <= 2)
  if (saved.contextWindowTokens !== null) integer(saved.contextWindowTokens, 4096, 2_097_152)
  if (saved.maxOutputTokens !== null) integer(saved.maxOutputTokens, 256, 393_216)
  const resolved = resolveGenerationBudget({ model: saved.model, protocol: saved.protocol, ...(saved.maxOutputTokens === null ? {} : { maxOutputTokens: saved.maxOutputTokens }) }, 'coarse').reservedOutputTokens
  semanticAssert(resolved === saved.resolvedOutputTokens)
  for (const kind of ['review', 'repair']) {
    semanticRecord(config.effective[kind], ['maxOutputTokens', 'contextWindowTokens'])
    semanticAssert(config.effective[kind].contextWindowTokens === saved.contextWindowTokens && config.effective[kind].maxOutputTokens === Math.min(resolved, SEMANTIC_LIMITS[kind].callOutputCap) && (saved.contextWindowTokens === null || config.effective[kind].maxOutputTokens < saved.contextWindowTokens))
  }
  const { configurationHash, ...body } = config
  semanticAssert(semanticHash(body) === configurationHash)
  return true
}
export function semanticEffectiveProfile(profile, kind) {
  semanticAssert(['review', 'repair'].includes(kind))
  const config = deriveSemanticConfiguration(profile)
  return Object.freeze({ ...profile, protocol: config.saved.protocol, temperature: config.saved.temperature, maxOutputTokens: config.effective[kind].maxOutputTokens })
}
export function createSemanticCaseRunSpec({ unit, snapshot, configuration }) {
  validateSemanticConfiguration(configuration)
  semanticAssert(['review', 'repair'].includes(unit.kind) && UNIT.test(unit.unitId) && PROJECT.test(unit.projectId) && snapshot.projectId === unit.projectId)
  const saved = configuration.saved
  const cap = configuration.effective[unit.kind].maxOutputTokens
  const limits = SEMANTIC_LIMITS[unit.kind]
  return createRunSpec({ version: 1, runId: unit.unitId, projectId: snapshot.projectId, snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'general', granularity: 'coarse', model: { profileId: saved.profileId, endpointFingerprint: saved.endpointFingerprint, model: saved.model, protocol: saved.protocol, temperature: saved.temperature, ...(saved.reasoningEffort === null ? {} : { reasoningEffort: saved.reasoningEffort }), ...(saved.contextWindowTokens === null ? {} : { contextWindowTokens: saved.contextWindowTokens }), maxOutputTokens: cap }, promptVersion: 'semantic-evaluation-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { maxModelRequests: limits.maxRequests, inputTokens: limits.inputAdmission, outputTokens: limits.outputReservation } })
}
export function semanticBudgets() {
  return structuredClone({ aggregate: SEMANTIC_LIMITS.aggregate, review: SEMANTIC_LIMITS.review, repair: SEMANTIC_LIMITS.repair, original: SEMANTIC_LIMITS.original })
}
export function createSemanticAuthorizationDraft({ mode, reference, source, bundle, plan, executionMap, configuration }) {
  semanticAssert(['real', 'synthetic'].includes(mode))
  semanticText(reference, 160)
  semanticAssert(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(reference), 'semantic-authorization-invalid')
  semanticRecord(source, ['commit', 'treeSha256'])
  semanticAssert(COMMIT.test(source.commit ?? '') && HASH.test(source.treeSha256 ?? ''))
  validateSemanticExecutionPlan(bundle, plan, executionMap); validateSemanticConfiguration(configuration)
  return freezeSemanticValue({ schemaVersion: 1, purpose: SEMANTIC_PURPOSE, mode, reference, source: structuredClone(source), assets: structuredClone(bundle.assets), publicDataHash: bundle.publicDataHash, planHash: plan.planHash, executionMapHash: executionMap.executionMapHash, configuration: structuredClone(configuration), budgets: semanticBudgets() })
}
export function validateSemanticAuthorization(authorization, expected) {
  semanticRecord(authorization, ['schemaVersion', 'purpose', 'mode', 'reference', 'source', 'assets', 'publicDataHash', 'planHash', 'executionMapHash', 'configuration', 'budgets'])
  const wanted = createSemanticAuthorizationDraft({ ...expected, reference: authorization.reference })
  semanticAssert(canonicalJson(authorization) === canonicalJson(wanted), 'semantic-authorization-binding')
  return true
}
export function semanticRunSpecFingerprint(spec) { return fingerprintRunSpec(spec) }

export { validateFrozenSemanticExecution, projectSemanticScoringInputs } from './semantic-execution-validation.mjs'
