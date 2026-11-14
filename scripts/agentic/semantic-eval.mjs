import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, writeFileSync, readSync, fstatSync, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson, sha256 } from './dataset-contract.mjs'
import {
  SEMANTIC_PURPOSE, SEMANTIC_PROTOCOL, SEMANTIC_LIMITS, SEMANTIC_MANIFEST_UNAVAILABLE,
  semanticAssert as check, semanticFail as fail, semanticRecord, semanticHash,
  freezeSemanticValue, assertSafeSemanticDirectory, readSemanticFile, parseSemanticJson,
  safeSemanticRelativePath, loadSemanticPublicBundle, validateSemanticPublicBundle,
  validateSemanticExecutionPlan, deriveSemanticConfiguration, semanticEffectiveProfile,
  createSemanticCaseRunSpec, semanticRunSpecFingerprint, validateSemanticAuthorization,
  semanticSampleUnit, semanticContentUnit
} from './semantic-eval-contract.mjs'
import { scanProject } from '../../electron/services/scanner.ts'
import { createWorkflowSnapshot } from '../../electron/services/workflow/snapshot-adapter.ts'
import { createEvidenceStore } from '../../electron/services/workflow/evidence-store.ts'
import { createBudgetLedger } from '../../electron/services/workflow/budget-ledger.ts'
import * as questionSource from '../../electron/services/workflow/question-source.ts'
import * as questionReview from '../../electron/services/workflow/question-review.ts'
import { createQuestionRevisionService, createSingleQuestionRevisionTarget, readSingleQuestionRevisionTarget, readQuestionRevisionDispatches } from '../../electron/services/workflow/question-revision.ts'
import { fingerprintQuestion } from '../../electron/services/workflow/question-evidence.ts'
import { estimateMessageTokens } from '../../shared/token-budget.ts'
import { WorkflowError } from '../../electron/services/workflow/project-contract.ts'
import { chatCompletionStream } from '../../electron/services/llm.ts'
import nativeSemantic from '../evaluation/m09-semantic-native.cjs'

const claims = new WeakMap()
const HASH = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_EVENT_BYTES = 65_536
const RESERVED_FILES = new Set(['public-data.json', 'plan.json', 'execution-map.json', 'authorization.json', 'claim.json', 'execution.json', 'execution-freeze.json', 'critical.jsonl'])
function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true }) }
  catch { fail('semantic-source-unavailable') }
}
/** Reads Git metadata/tree identities only, never private grading document bytes. */
export async function inspectSemanticSource(repoRoot) {
  const root = await assertSafeSemanticDirectory(repoRoot)
  const top = git(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim()
  check(path.resolve(top).toLowerCase() === root.toLowerCase(), 'semantic-source-root')
  check(git(root, ['status', '--porcelain=v1', '--untracked-files=all']).length === 0, 'semantic-source-dirty')
  const commit = git(root, ['rev-parse', 'HEAD']).toString('ascii').trim()
  const treeObject = git(root, ['rev-parse', 'HEAD^{tree}']).toString('ascii').trim()
  check(COMMIT.test(commit) && COMMIT.test(treeObject), 'semantic-source-unavailable')
  const treeSha256 = sha256(Buffer.from('m09-git-source-identity-v1\0' + commit + '\0' + treeObject, 'ascii'))
  return freezeSemanticValue({ commit, treeSha256 })
}
async function sourceForMode(input) {
  if (input.mode === 'real') {
    check(!Object.hasOwn(input, 'syntheticSource'), 'semantic-real-source-override')
    return inspectSemanticSource(input.repoRoot)
  }
  check(input.mode === 'synthetic', 'semantic-mode-invalid')
  semanticRecord(input.syntheticSource, ['commit', 'treeSha256'])
  check(COMMIT.test(input.syntheticSource.commit ?? '') && HASH.test(input.syntheticSource.treeSha256 ?? ''), 'semantic-source-invalid')
  return freezeSemanticValue(structuredClone(input.syntheticSource))
}
function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right }
function assertSynchronousDirectory(directory) {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = lstatSync(cursor)
    check(stat.isDirectory() && !stat.isSymbolicLink() && ((stat.attributes ?? 0) & 0x400) === 0, 'semantic-final-fence')
  }
  check(samePath(realpathSync(absolute), absolute), 'semantic-final-fence')
}
function finalPublicAssetHash(directory, filename) {
  assertSynchronousDirectory(directory)
  const absolute = path.join(directory, filename)
  const before = lstatSync(absolute)
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= SEMANTIC_LIMITS.files.documentBytes && ((before.attributes ?? 0) & 0x400) === 0, 'semantic-final-fence')
  const descriptor = openSync(absolute, 'r')
  try {
    const actual = fstatSync(descriptor)
    const same = (left, right) => left.ino === right.ino && left.dev === right.dev && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.nlink === 1
    check(actual.isFile() && same(before, actual), 'semantic-final-fence')
    const digest = createHash('sha256'); let bytes = 0
    while (bytes <= SEMANTIC_LIMITS.files.documentBytes) {
      const chunk = Buffer.alloc(Math.min(65536, SEMANTIC_LIMITS.files.documentBytes + 1 - bytes))
      const count = readSync(descriptor, chunk, 0, chunk.length, bytes)
      if (!count) break
      bytes += count; digest.update(chunk.subarray(0, count))
    }
    check(bytes === before.size && bytes <= SEMANTIC_LIMITS.files.documentBytes && same(actual, fstatSync(descriptor)), 'semantic-final-fence')
    const final = lstatSync(absolute)
    check(final.isFile() && !final.isSymbolicLink() && same(actual, final), 'semantic-final-fence')
    assertSynchronousDirectory(directory)
    return digest.digest('hex')
  } finally { closeSync(descriptor) }
}
/** Repeatable synchronous last-fetch check; it never rereads a private profile or grading asset. */
function assertFrozenDispatchBinding(binding) {
  check(semanticHash(binding.authorization) === binding.record.authorizationHash && binding.plan.planHash === binding.record.planHash && binding.executionMap.executionMapHash === binding.record.executionMapHash && binding.configuration.configurationHash === binding.record.configurationHash, 'semantic-final-fence')
  for (const filename of ['projects.json', 'review-packet.json', 'repair-samples.json']) check(finalPublicAssetHash(binding.dataDirectory, filename) === binding.bundle.assets[filename].rawSha256, 'semantic-public-changed')
  if (binding.record.mode === 'real') {
    assertSynchronousDirectory(binding.repoRoot)
    check(git(binding.repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']).length === 0, 'semantic-source-dirty')
    const commit = git(binding.repoRoot, ['rev-parse', 'HEAD']).toString('ascii').trim()
    const tree = git(binding.repoRoot, ['rev-parse', 'HEAD^{tree}']).toString('ascii').trim()
    check(commit === binding.source.commit && COMMIT.test(tree) && sha256(Buffer.from('m09-git-source-identity-v1\0' + commit + '\0' + tree, 'ascii')) === binding.source.treeSha256, 'semantic-source-changed')
  }
}
function currentConfig(input) {
  if (input.mode === 'real') check(typeof input.currentProfile === 'function', 'semantic-current-profile-required')
  check(input.profile && typeof input.profile === 'object', 'semantic-profile-required')
  return deriveSemanticConfiguration(input.profile)
}
function pathInside(root, child) { const relative = path.relative(root, child); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
async function safeChildDirectory(root, relative) {
  check(safeSemanticRelativePath(relative), 'semantic-unsafe-path')
  let cursor = root
  for (const component of relative.split('/')) {
    cursor = path.join(cursor, component)
    try { await mkdir(cursor, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
    await assertSafeSemanticDirectory(cursor)
  }
  return cursor
}
async function writeExclusive(directory, relative, bytes, maxBytes = SEMANTIC_LIMITS.files.artifactBytes) {
  check(safeSemanticRelativePath(relative) && Buffer.isBuffer(bytes) && bytes.length <= maxBytes, 'semantic-artifact-invalid')
  const absolute = path.resolve(directory, ...relative.split('/'))
  check(pathInside(directory, absolute), 'semantic-unsafe-path')
  const parentRelative = path.relative(directory, path.dirname(absolute)).split(path.sep).join('/')
  if (parentRelative) await safeChildDirectory(directory, parentRelative)
  const handle = await open(absolute, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  const saved = await readSemanticFile(directory, relative, maxBytes)
  check(saved.equals(bytes), 'semantic-artifact-write')
  return { path: relative, sha256: sha256(bytes), bytes: bytes.length }
}
async function writeJson(directory, relative, value) {
  return writeExclusive(directory, relative, Buffer.from(canonicalJson(value) + '\n', 'utf8'))
}
async function safeNewOutput(outputDirectory) {
  check(typeof outputDirectory === 'string' && path.isAbsolute(outputDirectory), 'semantic-output-required')
  const parent = await assertSafeSemanticDirectory(path.dirname(outputDirectory))
  const output = path.resolve(outputDirectory)
  check(pathInside(parent, output), 'semantic-output-invalid')
  await mkdir(output, { mode: 0o700 }).catch(() => fail('semantic-output-exists'))
  await assertSafeSemanticDirectory(output)
  return output
}
function claimIdentity(authorization) {
  return semanticHash({ purpose: SEMANTIC_PURPOSE, mode: authorization.mode, reference: authorization.reference, source: authorization.source })
}
/** Claims are private process capabilities backed by exclusive fsynced disk records. */
export async function claimSemanticExecution(input) {
  return claimSemanticCore(input)
}
async function claimSemanticCore(input, nativeContext) {
  const source = await sourceForMode(input)
  if (input.mode === 'real') check(nativeContext, 'semantic-native-context-required')
  const bundle = await loadSemanticPublicBundle(input.dataDirectory)
  validateSemanticExecutionPlan(bundle, input.plan, input.executionMap)
  const configuration = currentConfig(input)
  const expected = { mode: input.mode, source, bundle, plan: input.plan, executionMap: input.executionMap, configuration }
  check(input.authorization, 'semantic-authorization-required')
  validateSemanticAuthorization(input.authorization, expected)
  if (input.mode === 'real') {
    const latest = await input.currentProfile()
    check(semanticHash(deriveSemanticConfiguration(latest)) === semanticHash(configuration) && latest.apiKey === input.profile.apiKey, 'semantic-current-profile-mismatch')
  }
  const claimRoot = await assertSafeSemanticDirectory(input.claimDirectory)
  const claimId = claimIdentity(input.authorization)
  const authorizationHash = semanticHash(input.authorization)
  const record = { schemaVersion: 1, purpose: SEMANTIC_PURPOSE, mode: input.mode, claimId, authorizationHash, source, publicDataHash: bundle.publicDataHash, planHash: input.plan.planHash, executionMapHash: input.executionMap.executionMapHash, configurationHash: configuration.configurationHash }
  const file = await writeJson(claimRoot, claimId + '.claim.json', record)
  const claim = Object.freeze({ kind: 'semantic-execution-claim' })
  claims.set(claim, { claimRoot, record: freezeSemanticValue(record), claimFile: file, authorization: freezeSemanticValue(structuredClone(input.authorization)), plan: freezeSemanticValue(structuredClone(input.plan)), executionMap: freezeSemanticValue(structuredClone(input.executionMap)), bundle, configuration, source, consumed: false, dataDirectory: await realpath(input.dataDirectory), repoRoot: input.repoRoot, currentProfile: input.currentProfile, profile: Object.freeze({ ...input.profile }) })
  return claim
}
function staticReason(error) {
  const allowed = ['semantic-source-dirty', 'semantic-source-changed', 'semantic-current-profile-mismatch', 'semantic-public-changed', 'semantic-admission-limit', 'semantic-final-fence', 'semantic-cancelled', 'semantic-model-output', 'semantic-missing-usage', 'semantic-journal-failed']
  return allowed.includes(error?.message) ? error.message : error instanceof WorkflowError ? 'workflow-' + error.code : 'semantic-case-failed'
}
function readManifestFromSource(authority, source, question) {
  return typeof questionSource.readQuestionSourceManifest === 'function' ? questionSource.readQuestionSourceManifest(authority, source, question) : null
}
function hashMessages(messages) { return sha256(Buffer.from(JSON.stringify(messages), 'utf8')) }
function safeUsage(value) {
  if (!value || typeof value !== 'object' || !['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) || value.totalTokens !== value.inputTokens + value.outputTokens) return null
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens }
}
function strictVoid(value) {
  if (value !== undefined) { void Promise.resolve(value).catch(() => {}); fail('semantic-final-fence') }
}
function createCriticalJournal(directory, secret) {
  const filename = path.join(directory, 'critical.jsonl')
  const descriptor = openSync(filename, 'wx', 0o600)
  let priorHash = '0'.repeat(64); let count = 0; let closed = false
  return {
    append(type, payload) {
      check(!closed && count < SEMANTIC_LIMITS.files.maxJournalEvents, 'semantic-journal-failed')
      const event = { sequence: count, previousHash: priorHash, type, ...payload }
      const encoded = canonicalJson(event)
      check(!secret || !encoded.includes(secret), 'semantic-journal-failed')
      check(Buffer.byteLength(encoded, 'utf8') <= MAX_EVENT_BYTES, 'semantic-journal-failed')
      const record = { ...event, eventHash: semanticHash(event) }
      try { writeFileSync(descriptor, canonicalJson(record) + '\n', 'utf8'); fsyncSync(descriptor) } catch { fail('semantic-journal-failed') }
      priorHash = record.eventHash; count++
      return record
    },
    finish() { if (!closed) { fsyncSync(descriptor); closeSync(descriptor); closed = true } return { path: 'critical.jsonl', events: count, headHash: priorHash } }
  }
}
function aggregateEmpty() { return { requests: 0, inputAdmission: 0, outputReservation: 0, actualInputTokens: 0, actualOutputTokens: 0, unknownRequests: 0 } }
function requestState(ledger, requestId) { return ledger.snapshot().reservations.find(entry => entry.id === requestId) }
function makeBudgetGuard({ state, unit, ledger, requests, journal, signal, binding, profile }) {
  const policy = SEMANTIC_LIMITS[unit.kind]
  const local = aggregateEmpty()
  return function wrapTransport(actualTransport) {
    return async (activeProfile, messages, emit, options) => {
      check(!state.sealed && !signal.aborted, signal.aborted ? 'semantic-cancelled' : 'semantic-admission-limit')
      check(deriveSemanticConfiguration(activeProfile).saved.endpointFingerprint === binding.configuration.saved.endpointFingerprint && activeProfile.model === profile.model && activeProfile.apiKey === profile.apiKey, 'semantic-current-profile-mismatch')
      const reserved = ledger.snapshot().reservations.filter(entry => entry.state === 'reserved')
      check(reserved.length === 1, 'semantic-admission-limit')
      const entry = reserved[0]
      check(['review', 'repair'].includes(entry.stage), 'semantic-admission-limit')
      const request = { requestId: entry.id, stage: entry.stage, inputAdmission: entry.inputTokens, outputReservation: entry.outputTokens, contextChars: entry.contextChars, requestHash: hashMessages(messages), estimatedInputTokens: estimateMessageTokens(messages), manifest: null, manifestUnavailable: SEMANTIC_MANIFEST_UNAVAILABLE, guardIntent: false, fetchFence: false, transportComplete: false, outputHash: null, outputChars: null, usage: null, state: 'reserved' }
      check(request.estimatedInputTokens === entry.inputTokens && entry.outputTokens === options.maxOutputTokens, 'semantic-admission-limit')
      for (const meter of [state.aggregate, local]) {
        const cap = meter === local ? policy : SEMANTIC_LIMITS.aggregate
        check(meter.requests + 1 <= cap.maxRequests && meter.inputAdmission + entry.inputTokens <= cap.inputAdmission && meter.outputReservation + entry.outputTokens <= cap.outputReservation, 'semantic-admission-limit')
      }
      requests.push(request)
      for (const meter of [state.aggregate, local]) { meter.requests++; meter.inputAdmission += entry.inputTokens; meter.outputReservation += entry.outputTokens }
      journal.append('reservation', { unitId: unit.unitId, requestId: entry.id, stage: entry.stage, inputAdmission: entry.inputTokens, outputReservation: entry.outputTokens, contextChars: entry.contextChars, requestHash: request.requestHash })
      let admissionStarted = false; let admissionComplete = false; let live = true; let violation = false; let receipt = null
      const guard = () => { check(live && !violation && !state.sealed && !signal.aborted, signal.aborted ? 'semantic-cancelled' : 'semantic-final-fence') }
      const beforeFetch = () => {
        guard(); check(admissionComplete, 'semantic-final-fence'); assertFrozenDispatchBinding(binding); strictVoid(options.beforeFetch?.()); guard(); assertFrozenDispatchBinding(binding)
        request.fetchFence = true
      }
      const beforeRequest = () => {
        if (admissionStarted) { violation = true; fail('semantic-final-fence') }
        admissionStarted = true
        const waiting = (async () => {
          guard()
          const current = await loadSemanticPublicBundle(binding.dataDirectory)
          check(current.publicDataHash === binding.bundle.publicDataHash, 'semantic-public-changed')
          if (binding.record.mode === 'real') {
            check(canonicalJson(await inspectSemanticSource(binding.repoRoot)) === canonicalJson(binding.source), 'semantic-source-changed')
            const latest = await binding.currentProfile()
            check(semanticHash(deriveSemanticConfiguration(latest)) === semanticHash(binding.configuration) && latest.apiKey === binding.profile.apiKey, 'semantic-current-profile-mismatch')
          }
          guard()
          journal.append('intent', { unitId: unit.unitId, requestId: entry.id, requestHash: request.requestHash })
          await options.beforeRequest?.()
          guard()
          check(requestState(ledger, entry.id)?.state === 'dispatched', 'semantic-final-fence')
          request.guardIntent = true; admissionComplete = true
          strictVoid(options.beforeFetch?.()); guard(); assertFrozenDispatchBinding(binding)
        })()
        void waiting.catch(() => {})
        return waiting
      }
      let output = null; let error = null
      try {
        const raw = await actualTransport(activeProfile, messages, emit, { ...options, beforeRequest, beforeFetch, onUsage: value => { receipt = safeUsage(value); options.onUsage?.(value) } })
        guard()
        // Preserve the gateway's genuine unknown-unsent classification for a transport that returns without admission.
        if (!admissionComplete) return raw
        check(admissionComplete && request.fetchFence && typeof raw === 'string' && raw.length <= 256_000 && (!profile.apiKey || !raw.includes(profile.apiKey)), 'semantic-model-output')
        output = raw; request.transportComplete = true; request.outputHash = sha256(Buffer.from(raw, 'utf8')); request.outputChars = raw.length
        return raw
      } catch (caught) { error = caught; throw caught }
      finally {
        live = false
        request.usage = receipt
        request.state = receipt ? 'known' : admissionComplete ? 'unknown' : admissionStarted ? 'unknown-unsent' : 'unsent'
        if (!receipt && admissionStarted) { state.sealed = true; state.sealReason = 'semantic-missing-usage'; state.aggregate.unknownRequests++ }
        if (receipt) { state.aggregate.actualInputTokens += receipt.inputTokens; state.aggregate.actualOutputTokens += receipt.outputTokens }
        try { journal.append(receipt ? 'receipt' : 'unknown', { unitId: unit.unitId, requestId: entry.id, requestHash: request.requestHash, usage: receipt, outputHash: request.outputHash, outputChars: request.outputChars, transportComplete: request.transportComplete, reason: error ? staticReason(error) : receipt ? null : 'semantic-missing-usage' }) }
        catch { state.sealed = true; state.sealReason = 'semantic-journal-failed'; fail('semantic-journal-failed') }
      }
    }
  }
}
async function materializeProject(directory, project, projectId) {
  const root = await safeChildDirectory(directory, 'scratch/' + projectId)
  let total = 0
  for (const file of project.files) {
    const bytes = Buffer.from(file.content, 'utf8'); total += bytes.length
    check(total <= SEMANTIC_LIMITS.files.publicBytes && sha256(bytes) === file.sha256, 'semantic-public-changed')
    const parentRelative = path.posix.dirname(file.path)
    if (parentRelative !== '.') await safeChildDirectory(root, parentRelative)
    await writeExclusive(root, file.path, bytes, SEMANTIC_LIMITS.files.documentBytes)
  }
  return root
}
async function actualEvidence(authority, source, question, project) {
  const description = await authority.assertCurrent(source, question)
  const records = await authority.store.resolve(description.evidenceIds, authority.spec.snapshotId, authority.signal)
  const sources = []
  for (const record of records) {
    const file = project.files.find(file => file.path === record.relPath)
    check(file && record.originalRange && record.originalRange.startLine === record.displayRange.startLine && record.originalRange.endLine === record.displayRange.endLine, 'semantic-source-range-unavailable')
    const text = file.content.split('\n').slice(record.displayRange.startLine - 1, record.displayRange.endLine).join('\n')
    check(text === record.text && sha256(Buffer.from(text, 'utf8')) === record.contentHash, 'semantic-source-canonical-mismatch')
    sources.push({ path: record.relPath, startLine: record.displayRange.startLine, endLine: record.displayRange.endLine, sha256: record.contentHash, text })
  }
  return { description, records, sources, manifest: readManifestFromSource(authority, source, question) }
}
function bindManifest(requests, requestId, manifest) {
  if (!manifest) return
  const request = requests.find(entry => entry.requestId === requestId)
  check(request && manifest.requestHash === request.requestHash && manifest.estimatedInputTokens === request.inputAdmission + manifest.serializationOverheadTokens && manifest.contextChars === request.contextChars, 'semantic-manifest-binding')
  request.manifest = structuredClone(manifest); request.manifestUnavailable = null
}
async function executeCase({ binding, unit, mapping, output, projectRoot, state, journal, transport, signal }) {
  const sample = binding.bundle.documents[unit.kind === 'review' ? 'review-packet.json' : 'repair-samples.json'].samples.find(sample => sample.id === mapping.sampleId)
  const project = binding.bundle.documents['projects.json'].projects.find(project => project.id === sample.projectId)
  const initial = semanticSampleUnit(sample, unit.questionId)
  const before = semanticContentUnit(initial)
  const requests = []; const sourceReads = []
  const record = { schemaVersion: 1, unitId: unit.unitId, kind: unit.kind, status: 'not-run', reason: null, before, after: before, review: { assessment: 'incomplete', outcome: null }, revision: null, source: null, sources: [], evidence: [], spec: null, specFingerprint: null, ledger: null, sourceReads, requests, inputHash: unit.inputHash, outputHash: semanticHash(before), artifacts: [] }
  if (state.sealed || signal.aborted) { record.reason = state.sealReason ?? 'semantic-cancelled'; return record }
  let ledger
  try {
    const scan = await scanProject(projectRoot)
    const snapshot = await createWorkflowSnapshot(scan, { projectId: unit.projectId })
    const store = createEvidenceStore(snapshot)
    const spec = createSemanticCaseRunSpec({ unit, snapshot, configuration: binding.configuration })
    ledger = createBudgetLedger(spec)
    record.spec = spec; record.specFingerprint = semanticRunSpecFingerprint(spec)
    const profile = semanticEffectiveProfile(binding.profile, unit.kind)
    const evidence = sample.evidence.map(ref => {
      const file = snapshot.files.find(file => file.relPath === ref.path)
      check(file, 'semantic-public-evidence-missing')
      return { fileId: file.fileId, range: { startLine: ref.startLine, endLine: ref.endLine } }
    })
    const imported = await questionSource.createFrozenEvaluationQuestionSource({ spec, ledger, snapshot, store, signal, question: initial.question, glossary: initial.glossary, evidence })
    sourceReads.push(...questionSource.readFrozenQuestionSourceReads(imported.authority, imported.source, imported.question).map(entry => ({ ...entry })))
    const actual = await actualEvidence(imported.authority, imported.source, imported.question, project)
    record.source = { description: actual.description, manifest: actual.manifest, manifestUnavailable: actual.manifest ? null : SEMANTIC_MANIFEST_UNAVAILABLE }
    record.sources = actual.sources
    record.evidence = actual.records.map(({ id, fileId, relPath, originalRange, displayRange, contentHash, text, sourceKind, snapshotId }) => ({ id, fileId, relPath, originalRange, displayRange, contentHash, text, sourceKind, snapshotId }))
    const wrappedTransport = makeBudgetGuard({ state, unit, ledger, requests, journal, signal, binding, profile })(transport)
    const outcome = await questionReview.createQuestionReviewService({ authority: imported.authority, profile, glossary: imported.glossary, transport: wrappedTransport }).review({ source: imported.source, question: imported.question, signal, maxOutputTokens: Math.min(4096, profile.maxOutputTokens) })
    record.status = 'incomplete'
    record.review = { assessment: outcome.status === 'assessed' ? outcome.assessment : 'incomplete', outcome: structuredClone(outcome) }
    for (const dispatch of questionReview.readQuestionReviewDispatches(outcome)) bindManifest(requests, dispatch.requestId, dispatch.manifest)
    if (unit.kind === 'review') {
      record.status = outcome.status === 'assessed' ? 'completed' : 'incomplete'
      record.reason = outcome.status === 'assessed' ? null : outcome.reason
    } else if (outcome.status === 'assessed' && outcome.assessment === 'material-risk' && outcome.findings.length && !state.sealed) {
      const target = createSingleQuestionRevisionTarget(imported)
      const revised = await createQuestionRevisionService({ authority: imported.authority, profile, transport: wrappedTransport }).revise({ target, source: imported.source, questionId: imported.question.id, outcome, findingIds: outcome.findings.slice(0, 8).map(finding => finding.id), signal, maxOutputTokens: Math.min(8192, profile.maxOutputTokens) })
      for (const dispatch of readQuestionRevisionDispatches(revised)) bindManifest(requests, dispatch.requestId, dispatch.manifest)
      const { source: acceptedSource, ...safeRevision } = revised
      record.revision = structuredClone(safeRevision)
      if (revised.status === 'applied') {
        const current = readSingleQuestionRevisionTarget(target)
        check(current.question.id === imported.question.id && fingerprintQuestion(current.question) !== fingerprintQuestion(imported.question), 'semantic-revision-invalid')
        const accepted = await actualEvidence(imported.authority, acceptedSource, current.question, project)
        record.after = semanticContentUnit({ question: current.question, glossary: current.glossary })
        record.status = 'applied'; record.reason = null
        bindManifest(requests, revised.provenance.source.requestId, accepted.manifest)
        record.revision.acceptedSource = { description: accepted.description, manifest: accepted.manifest, manifestUnavailable: accepted.manifest ? null : SEMANTIC_MANIFEST_UNAVAILABLE }
      } else { record.reason = revised.reason }
    } else { record.reason = state.sealed ? state.sealReason : outcome.status === 'assessed' ? 'no-genuine-material-risk' : outcome.reason }
  } catch (error) {
    record.status = 'incomplete'; record.reason = staticReason(error)
    if (record.revision?.status === 'applied') record.revision = { status: 'incomplete', reason: 'source-capture-failed' }
    record.after = before
  }
  finally {
    if (ledger) {
      record.ledger = structuredClone(ledger.snapshot())
      if (record.ledger.blocked || Object.values(record.ledger.overspend).some(value => value > 0)) { state.sealed = true; state.sealReason = 'semantic-admission-limit' }
      for (const request of requests) {
        const receipt = record.ledger.reservations.find(entry => entry.id === request.requestId)
        request.ledger = receipt ? structuredClone(receipt) : null
        if (receipt?.state === 'unknown' || receipt?.state === 'unknown-unsent') {
          if (!['unknown', 'unknown-unsent'].includes(request.state)) state.aggregate.unknownRequests++
          request.state = receipt.state
          state.sealed = true; state.sealReason = 'semantic-missing-usage'
        }
      }
    }
    record.outputHash = semanticHash(record.after)
  }
  return record
}
async function allFiles(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    check(!entry.isSymbolicLink(), 'semantic-unsafe-path')
    const name = relative ? relative + '/' + entry.name : entry.name
    if (entry.isDirectory()) files.push(...await allFiles(directory, name))
    else { check(entry.isFile(), 'semantic-artifact-invalid'); files.push(name) }
  }
  return files.sort()
}
/** Ordinary caller entry remains synthetic-only even with a real disk claim. */
export async function executeSemanticEvaluation(input) {
  return executeSemanticCore(input)
}
/** Native context membership, private profile and fixed production transport only. */
export async function executeNativeSemanticEvaluation(input) {
  const contextDescriptor = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'context') : null
  check(contextDescriptor && 'value' in contextDescriptor && contextDescriptor.enumerable && Reflect.ownKeys(input).length === 1 && [Object.prototype, null].includes(Object.getPrototypeOf(input)), 'semantic-native-context-required')
  const native = nativeSemantic.consumeNativeSemanticContext(input.context)
  const claim = await claimSemanticCore({ mode: 'real', repoRoot: native.manifest.repoRoot, dataDirectory: native.manifest.dataDirectory, profile: native.profile, currentProfile: native.currentProfile, plan: native.manifest.plan, executionMap: native.manifest.executionMap, authorization: native.authorization, claimDirectory: native.manifest.claimDirectory }, input.context)
  const result = await executeSemanticCore({ mode: 'real', claim, outputDirectory: native.manifest.outputDirectory }, input.context)
  const freezeBytes = await readSemanticFile(result.outputDirectory, 'execution-freeze.json')
  return nativeSemantic.completeNativeSemanticExecution(input.context, result, freezeBytes)
}
async function executeSemanticCore(input, nativeContext) {
  const binding = claims.get(input?.claim)
  check(binding && !binding.consumed, 'semantic-claim-required')
  check(input.mode === binding.record.mode, 'semantic-claim-mode')
  binding.consumed = true
  const actualClaim = parseSemanticJson(await readSemanticFile(binding.claimRoot, binding.claimFile.path, 65_536))
  check(canonicalJson(actualClaim) === canonicalJson(binding.record), 'semantic-claim-file-mismatch')
  const currentBundle = await loadSemanticPublicBundle(binding.dataDirectory)
  check(currentBundle.publicDataHash === binding.bundle.publicDataHash, 'semantic-public-changed')
  if (input.mode === 'real') {
    check(canonicalJson(await inspectSemanticSource(binding.repoRoot)) === canonicalJson(binding.source), 'semantic-source-changed')
    const latest = await binding.currentProfile()
    check(semanticHash(deriveSemanticConfiguration(latest)) === semanticHash(binding.configuration) && latest.apiKey === binding.profile.apiKey, 'semantic-current-profile-mismatch')
    check(nativeContext, 'semantic-native-fetch-integration-required')
  }
  const transport = input.mode === 'real' ? chatCompletionStream : input.transport
  check(typeof transport === 'function', 'semantic-synthetic-transport-required')
  const startedRecord = { schemaVersion: 1, purpose: SEMANTIC_PURPOSE, mode: binding.record.mode, claimId: binding.record.claimId, authorizationHash: binding.record.authorizationHash, planHash: binding.plan.planHash }
  const started = await writeJson(binding.claimRoot, binding.record.claimId + '.started.json', startedRecord)
  const output = await safeNewOutput(input.outputDirectory)
  check(!pathInside(output, binding.dataDirectory) && !pathInside(binding.dataDirectory, output) && output !== binding.dataDirectory, 'semantic-output-overlap')
  const artifacts = []
  for (const [name, value] of [['public-data.json', binding.bundle], ['plan.json', binding.plan], ['execution-map.json', binding.executionMap], ['authorization.json', binding.authorization], ['claim.json', { claim: binding.record, started: startedRecord }]]) artifacts.push(await writeJson(output, name, value))
  await safeChildDirectory(output, 'cases')
  await safeChildDirectory(output, 'inputs')
  for (const name of ['projects.json', 'review-packet.json', 'repair-samples.json']) {
    const bytes = await readSemanticFile(binding.dataDirectory, name)
    check(sha256(bytes) === binding.bundle.assets[name].rawSha256, 'semantic-public-changed')
    artifacts.push(await writeExclusive(output, 'inputs/' + name, bytes))
  }
  const journal = createCriticalJournal(output, binding.profile.apiKey)
  const state = { aggregate: aggregateEmpty(), sealed: false, sealReason: null }
  const controller = input.signal ? null : new AbortController()
  const signal = input.signal ?? controller.signal
  const projectRoots = new Map()
  const cases = []
  let sourceStable = true
  try {
    const projects = binding.bundle.documents['projects.json'].projects
    for (const unit of binding.plan.units) {
      const mapping = binding.executionMap.entries[unit.order]
      let projectRoot = projectRoots.get(unit.projectId)
      if (!projectRoot && !state.sealed && !signal.aborted) {
        const project = projects.find(project => project.id === mapping.projectId)
        projectRoot = await materializeProject(output, project, unit.projectId)
        projectRoots.set(unit.projectId, projectRoot)
      }
      const result = await executeCase({ binding, unit, mapping, output, projectRoot, state, journal, transport, signal })
      check(!binding.profile.apiKey || !canonicalJson(result).includes(binding.profile.apiKey), 'semantic-artifact-secret')
      const caseFile = await writeJson(output, `cases/${unit.unitId}.json`, result)
      artifacts.push(caseFile)
      cases.push({ unitId: unit.unitId, kind: unit.kind, status: result.status, file: caseFile.path, sha256: caseFile.sha256 })
    }
  } catch (error) {
    state.sealed = true; state.sealReason = staticReason(error)
  } finally {
    // Preserve every denominator slot even after an infrastructure or receipt failure.
    for (const unit of binding.plan.units.slice(cases.length)) {
      const sample = binding.bundle.documents[unit.kind === 'review' ? 'review-packet.json' : 'repair-samples.json'].samples.find(sample => sample.id === binding.executionMap.entries[unit.order].sampleId)
      const before = semanticContentUnit(semanticSampleUnit(sample, unit.questionId))
      const result = { schemaVersion: 1, unitId: unit.unitId, kind: unit.kind, status: 'not-run', reason: state.sealReason ?? 'semantic-case-failed', before, after: before, review: { assessment: 'incomplete', outcome: null }, revision: null, source: null, sources: [], evidence: [], spec: null, specFingerprint: null, ledger: null, sourceReads: [], requests: [], inputHash: unit.inputHash, outputHash: semanticHash(before), artifacts: [] }
      const caseFile = await writeJson(output, `cases/${unit.unitId}.json`, result)
      artifacts.push(caseFile); cases.push({ unitId: unit.unitId, kind: unit.kind, status: result.status, file: caseFile.path, sha256: caseFile.sha256 })
    }
  }
  const current = await loadSemanticPublicBundle(binding.dataDirectory).catch(() => null)
  if (!current || current.publicDataHash !== binding.bundle.publicDataHash) { sourceStable = false; state.sealed = true; state.sealReason = 'semantic-public-changed' }
  if (binding.record.mode === 'real') {
    const finalSource = await inspectSemanticSource(binding.repoRoot).catch(() => null)
    if (!finalSource || canonicalJson(finalSource) !== canonicalJson(binding.source)) { sourceStable = false; state.sealed = true; state.sealReason = 'semantic-source-changed' }
  }
  const journalSummary = journal.finish()
  const journalBytes = await readSemanticFile(output, 'critical.jsonl')
  artifacts.push({ path: 'critical.jsonl', sha256: sha256(journalBytes), bytes: journalBytes.length })
  const report = { schemaVersion: 1, purpose: SEMANTIC_PURPOSE, protocol: SEMANTIC_PROTOCOL, mode: binding.record.mode, source: binding.source, sourceHashMeaning: 'git-commit-tree-identity-v1', publicDataHash: binding.bundle.publicDataHash, planHash: binding.plan.planHash, executionMapHash: binding.executionMap.executionMapHash, configurationHash: binding.configuration.configurationHash, authorizationHash: binding.record.authorizationHash, claimId: binding.record.claimId, sourceStable, sealed: state.sealed, sealReason: state.sealReason, aggregate: state.aggregate, cases, journal: journalSummary, quality: 'not-evaluated' }
  artifacts.push(await writeJson(output, 'execution.json', report))
  if (nativeContext) artifacts.push(await writeJson(output, 'native-provenance.json', nativeSemantic.createNativeSemanticProvenance(nativeContext, binding.record)))
  const fileNames = await allFiles(output)
  const committedArtifacts = []
  let totalBytes = 0
  for (const name of fileNames) {
    const bytes = await readSemanticFile(output, name, SEMANTIC_LIMITS.files.artifactBytes)
    totalBytes += bytes.length
    check(totalBytes <= SEMANTIC_LIMITS.files.executionBytes && committedArtifacts.length < SEMANTIC_LIMITS.files.maxArtifacts, 'semantic-execution-oversized')
    committedArtifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) })
  }
  const body = { schemaVersion: 1, purpose: SEMANTIC_PURPOSE, protocol: SEMANTIC_PROTOCOL, mode: binding.record.mode, source: binding.source, publicDataHash: binding.bundle.publicDataHash, planHash: binding.plan.planHash, executionMapHash: binding.executionMap.executionMapHash, configurationHash: binding.configuration.configurationHash, authorizationHash: binding.record.authorizationHash, claimId: binding.record.claimId, artifacts: committedArtifacts }
  const freezeBytes = Buffer.from(canonicalJson(body) + '\n', 'utf8')
  const executionHash = sha256(freezeBytes)
  await writeExclusive(output, 'execution-freeze.json', freezeBytes)
  return freezeSemanticValue({ outputDirectory: output, executionHash, mode: binding.record.mode, claimId: binding.record.claimId, cases: cases.length, sealed: state.sealed, quality: 'not-evaluated' })
}
