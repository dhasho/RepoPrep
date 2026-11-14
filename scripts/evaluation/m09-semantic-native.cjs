'use strict'

const path = require('node:path')
const crypto = require('node:crypto')
const { isMainThread } = require('node:worker_threads')
const io = require('./m09-semantic-io.cjs')
const snapshot = require('./m09-profile-snapshot.cjs')
const contexts = new WeakMap()
const PURPOSE = 'm09-semantic-v1'
const TRANSPORT = 'electron/services/llm.ts#chatCompletionStream/v1'
const HASH = /^[a-f0-9]{64}$/u
const MANIFEST_KEYS = ['schemaVersion', 'purpose', 'mode', 'parentPid', 'parentNonce', 'runtimeRoot', 'runtimeIdentity', 'entryIdentity', 'repoRoot', 'dataDirectory', 'settingsDirectory', 'profileId', 'outputDirectory', 'claimDirectory', 'reference', 'source', 'publicDataHash', 'assets', 'plan', 'executionMap', 'budgets', 'entrySourceSha256', 'bundleSha256']
const READY_KEYS = ['type', 'schemaVersion', 'purpose', 'mode', 'parentNonce', 'childNonce', 'source', 'publicDataHash', 'planHash', 'executionMapHash', 'configuration', 'entrySourceSha256', 'bundleSha256']
const GRANT_KEYS = ['type', 'schemaVersion', 'purpose', 'mode', 'parentNonce', 'childNonce', 'authorization', 'grantHash']
const OUTCOME_KEYS = ['type', 'schemaVersion', 'purpose', 'mode', 'parentNonce', 'childNonce', 'executionHash', 'provenanceHash', 'claimId', 'cases', 'sealed', 'quality']
function mainApp(beforeReady) {
  io.check(process.platform === 'win32' && process.type === 'browser' && isMainThread && typeof process.versions.electron === 'string' && !Object.hasOwn(process.env, 'ELECTRON_RUN_AS_NODE'), 'semantic-native-main-required')
  let app
  try { app = require('electron').app } catch { io.fail('semantic-native-main-required') }
  io.check(app && typeof app.isReady === 'function' && typeof app.setPath === 'function', 'semantic-native-main-required')
  if (beforeReady) io.check(!app.isReady(), 'semantic-native-before-ready-required')
  return app
}
function contextFor(token, state) { const binding = token && contexts.get(token); io.check(binding && (!state || binding.state === state), 'semantic-native-context-required'); return binding }
function manifestAt(runtimeRoot, entryFile) {
  const rootIdentity = io.directory(runtimeRoot)
  const manifest = io.json(path.join(runtimeRoot, 'control.json'))
  io.exact(manifest, MANIFEST_KEYS)
  io.check(manifest.schemaVersion === 1 && manifest.purpose === PURPOSE && manifest.mode === 'real' && manifest.parentPid === process.ppid && Number.isSafeInteger(manifest.parentPid) && manifest.parentPid > 0 && HASH.test(manifest.parentNonce), 'semantic-native-control-invalid')
  io.check(io.samePath(manifest.runtimeRoot, runtimeRoot) && io.sameIdentity(manifest.runtimeIdentity, rootIdentity), 'semantic-native-runtime-unsafe')
  io.check(io.samePath(entryFile, path.join(runtimeRoot, 'entry.cjs')) && io.sameIdentity(manifest.entryIdentity, io.file(entryFile, 32 * 1024 * 1024).identity), 'semantic-native-runtime-unsafe')
  io.check(HASH.test(manifest.bundleSha256) && io.sha256(io.read(entryFile, 32 * 1024 * 1024)) === manifest.bundleSha256 && HASH.test(manifest.entrySourceSha256), 'semantic-native-source-mismatch')
  for (const directory of [manifest.repoRoot, manifest.dataDirectory, manifest.settingsDirectory, manifest.claimDirectory, path.dirname(manifest.outputDirectory)]) io.directory(directory)
  io.check(io.samePath(manifest.dataDirectory, path.join(manifest.repoRoot, 'scripts', 'agentic', 'datasets', 'v1')), 'semantic-native-source-mismatch')
  io.check(!io.overlaps(runtimeRoot, manifest.repoRoot) && !io.overlaps(runtimeRoot, manifest.settingsDirectory) && !io.overlaps(manifest.outputDirectory, manifest.settingsDirectory) && !io.overlaps(manifest.claimDirectory, manifest.outputDirectory), 'semantic-native-runtime-unsafe')
  io.check(io.within(path.join(manifest.repoRoot, '.validation', 'agentic'), manifest.outputDirectory) && io.samePath(manifest.claimDirectory, path.join(manifest.repoRoot, '.validation', 'agentic', 'semantic-claims')), 'semantic-native-runtime-unsafe')
  io.check(typeof manifest.profileId === 'string' && manifest.profileId.length <= 256, 'semantic-native-control-invalid')
  return io.frozen(manifest)
}
/** The only issuer. This entire function is synchronous and pre-ready. */
function bootstrapNativeSemanticContext(runtimeRoot, entryFile) {
  const app = mainApp(true)
  let handle
  try {
    const manifest = manifestAt(runtimeRoot, entryFile)
    handle = snapshot.captureM09ProfileSnapshot({ settingsDirectory: manifest.settingsDirectory, ...(manifest.profileId ? { profileId: manifest.profileId } : {}) })
    const staged = snapshot.stageM09ProfileSnapshot(handle, { runtimeParent: runtimeRoot })
    const names = ['userData', 'sessionData', 'cache', 'crashDumps']
    io.check(new Set(names.map(name => staged[name].toLowerCase())).size === 4, 'semantic-native-bootstrap-failed')
    for (const name of names) app.setPath(name, staged[name])
    io.check(snapshot.releaseM09ProfileSnapshot(handle) === true, 'semantic-native-bootstrap-failed')
    handle = undefined
    // Private cleanup inventory, never a public authority or credential record.
    io.write(path.join(runtimeRoot, 'bootstrap.json'), io.bytes({ schemaVersion: 1, parentNonce: manifest.parentNonce, runtimeRoot: staged.runtimeRoot, runtimeIdentity: io.directory(staged.runtimeRoot), paths: Object.fromEntries(names.map(name => [name, { path: staged[name], identity: io.directory(staged[name]) }])), files: ['user-data/settings.json', 'session-data/Local State'].map(relative => ({ relative, identity: io.file(path.join(staged.runtimeRoot, ...relative.split('/')), 4 * 1024 * 1024).identity })) }))
    const token = Object.freeze({ kind: 'm09-native-semantic-context' })
    contexts.set(token, { state: 'bootstrapped', app, manifest, selected: staged.selectedProfile, childNonce: crypto.randomBytes(32).toString('hex'), counts: { capture: 1, stage: 1, paths: 4, release: 1, privateProfile: 0 }, profile: null, configuration: null, bundle: null, grant: null, provenance: null })
    return token
  } catch (error) {
    // An incomplete path switch is fatal; do not manufacture a weaker context.
    io.fail(io.safeCode(error, 'semantic-native-bootstrap-failed'))
  }
}
/** Pure comparison only; it cannot mint or advance a native context. */
function validateCapturedNativeProfileMetadata(value, selected) {
  io.check(value && value.id === selected.profileId && value.model === selected.model && typeof value.apiKey === 'string' && value.apiKey.length > 0 && typeof value.baseUrl === 'string', 'semantic-native-profile-unavailable')
  io.check(io.sha256(Buffer.from('repoprep:m09:saved-base-url:v1\0' + value.baseUrl, 'utf8')) === selected.savedBaseUrlSha256, 'semantic-native-profile-mismatch')
  // E3a retains optional absence. Defaults are applied only later by the shared
  // semantic configuration derivation, never by snapshot/profile comparison.
  for (const name of ['protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens']) io.check(Object.hasOwn(value, name) === Object.hasOwn(selected, name) && value[name] === selected[name], 'semantic-native-profile-mismatch')
  return true
}
/** Exactly one production store read, then one frozen in-memory profile forever. */
async function prepareNativeSemanticContext(token) {
  const binding = contextFor(token, 'bootstrapped')
  binding.state = 'preparing'
  try {
    await binding.app.whenReady()
    mainApp(false)
    const { getPrivateProfile } = await import('../../electron/services/store.ts')
    binding.counts.privateProfile++
    const value = await getPrivateProfile(binding.selected.profileId)
    validateCapturedNativeProfileMetadata(value, binding.selected)
    const contract = await import('../agentic/semantic-eval-contract.mjs')
    binding.profile = Object.freeze({ ...value })
    binding.configuration = contract.deriveSemanticConfiguration(binding.profile)
    const publicConfiguration = io.canonical(binding.configuration)
    io.check(!publicConfiguration.includes(binding.profile.apiKey) && !publicConfiguration.includes(binding.profile.baseUrl), 'semantic-native-profile-mismatch')
    binding.bundle = await contract.loadSemanticPublicBundle(binding.manifest.dataDirectory)
    contract.validateSemanticExecutionPlan(binding.bundle, binding.manifest.plan, binding.manifest.executionMap)
    io.check(binding.bundle.publicDataHash === binding.manifest.publicDataHash && io.canonical(binding.bundle.assets) === io.canonical(binding.manifest.assets) && io.canonical(contract.semanticBudgets()) === io.canonical(binding.manifest.budgets), 'semantic-native-source-mismatch')
    const { inspectSemanticSource } = await import('../agentic/semantic-eval.mjs')
    io.check(io.canonical(await inspectSemanticSource(binding.manifest.repoRoot)) === io.canonical(binding.manifest.source), 'semantic-native-source-mismatch')
    binding.state = 'ready'
    return io.frozen({ type: 'semantic-ready', schemaVersion: 1, purpose: PURPOSE, mode: 'real', parentNonce: binding.manifest.parentNonce, childNonce: binding.childNonce, source: binding.manifest.source, publicDataHash: binding.manifest.publicDataHash, planHash: binding.manifest.plan.planHash, executionMapHash: binding.manifest.executionMap.executionMapHash, configuration: binding.configuration, entrySourceSha256: binding.manifest.entrySourceSha256, bundleSha256: binding.manifest.bundleSha256 })
  } catch (error) { binding.state = 'failed'; io.fail(io.safeCode(error, 'semantic-native-prepare-failed')) }
}
function validateReadyMessage(message, manifest, validateConfiguration) {
  io.exact(message, READY_KEYS)
  io.check(message.type === 'semantic-ready' && message.schemaVersion === 1 && message.purpose === PURPOSE && message.mode === 'real' && message.parentNonce === manifest.parentNonce && HASH.test(message.childNonce), 'semantic-native-handshake-invalid')
  for (const [key, expected] of [['source', manifest.source], ['publicDataHash', manifest.publicDataHash], ['planHash', manifest.plan.planHash], ['executionMapHash', manifest.executionMap.executionMapHash], ['entrySourceSha256', manifest.entrySourceSha256], ['bundleSha256', manifest.bundleSha256]]) io.check(io.canonical(message[key]) === io.canonical(expected), 'semantic-native-handshake-invalid')
  validateConfiguration(message.configuration)
  if (manifest.profileId) io.check(message.configuration.saved.profileId === manifest.profileId, 'semantic-native-handshake-invalid')
  return message
}
function grantBody(manifest, ready, authorization) { return { type: 'semantic-grant', schemaVersion: 1, purpose: PURPOSE, mode: 'real', parentNonce: manifest.parentNonce, childNonce: ready.childNonce, authorization } }
/** Pure binding checker; passing it grants no native or parent capability. */
function validateGrantMessage(message, manifest, ready, expectedAuthorization) {
  io.exact(message, GRANT_KEYS)
  const expected = grantBody(manifest, ready, expectedAuthorization)
  io.check(HASH.test(message.grantHash) && message.grantHash === io.hash(expected) && io.canonical(message) === io.canonical({ ...expected, grantHash: io.hash(expected) }), 'semantic-native-grant-invalid')
  return message
}
async function acceptNativeSemanticGrant(token, message) {
  const binding = contextFor(token, 'ready')
  binding.state = 'grant-checking'
  try {
    const contract = await import('../agentic/semantic-eval-contract.mjs')
    const authorization = contract.createSemanticAuthorizationDraft({ mode: 'real', reference: binding.manifest.reference, source: binding.manifest.source, bundle: binding.bundle, plan: binding.manifest.plan, executionMap: binding.manifest.executionMap, configuration: binding.configuration })
    validateGrantMessage(message, binding.manifest, { childNonce: binding.childNonce }, authorization)
    const raw = io.read(path.join(binding.manifest.runtimeRoot, 'grant.json'))
    io.check(raw.equals(io.bytes(message)), 'semantic-native-grant-invalid')
    binding.grant = io.frozen({ message: structuredClone(message), fileSha256: io.sha256(raw) })
    binding.state = 'granted'
  } catch (error) { binding.state = 'failed'; io.fail(io.safeCode(error, 'semantic-native-grant-invalid')) }
}
function consumeNativeSemanticContext(token) {
  const binding = contextFor(token, 'granted')
  binding.state = 'executing'
  const currentProfile = () => binding.profile
  return Object.freeze({ manifest: binding.manifest, profile: binding.profile, configuration: binding.configuration, authorization: binding.grant.message.authorization, currentProfile })
}
function createNativeSemanticProvenance(token, claim) {
  const binding = contextFor(token, 'executing')
  io.check(!binding.provenance && binding.counts.privateProfile === 1 && claim.mode === 'real' && claim.configurationHash === binding.configuration.configurationHash && claim.authorizationHash === io.hash(binding.grant.message.authorization), 'semantic-native-provenance-invalid')
  const value = { schemaVersion: 1, purpose: PURPOSE, mode: 'real', native: { platform: process.platform, processType: process.type, electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }, transport: TRANSPORT, parentNonce: binding.manifest.parentNonce, childNonce: binding.childNonce, source: binding.manifest.source, entrySourceSha256: binding.manifest.entrySourceSha256, bundleSha256: binding.manifest.bundleSha256, publicDataHash: claim.publicDataHash, planHash: claim.planHash, executionMapHash: claim.executionMapHash, configurationHash: claim.configurationHash, authorizationHash: claim.authorizationHash, grantHash: binding.grant.message.grantHash, grantFileSha256: binding.grant.fileSha256, claimId: claim.claimId, bootstrap: { ...binding.counts, distinctPaths: 4, captureBeforeReady: true, pathSwitchBeforeReady: true, releaseAfterPathSwitch: true }, freezeBinding: 'parent-observed-close-exact-freeze-v1' }
  binding.provenance = io.frozen(value)
  return binding.provenance
}
function completeNativeSemanticExecution(token, result, freezeBytes) {
  const binding = contextFor(token, 'executing')
  io.check(binding.provenance && Buffer.isBuffer(freezeBytes) && io.sha256(freezeBytes) === result.executionHash && result.mode === 'real' && result.claimId === binding.provenance.claimId && result.cases === 100 && result.quality === 'not-evaluated', 'semantic-native-provenance-invalid')
  const outcome = io.frozen({ type: 'semantic-outcome', schemaVersion: 1, purpose: PURPOSE, mode: 'real', parentNonce: binding.manifest.parentNonce, childNonce: binding.childNonce, executionHash: result.executionHash, provenanceHash: io.sha256(io.bytes(binding.provenance)), claimId: result.claimId, cases: 100, sealed: result.sealed, quality: 'not-evaluated' })
  io.write(path.join(binding.manifest.runtimeRoot, 'outcome.json'), io.bytes(outcome))
  binding.state = 'completed'
  return outcome
}
function validateOutcomeMessage(message, manifest, ready) {
  io.exact(message, OUTCOME_KEYS)
  io.check(message.type === 'semantic-outcome' && message.schemaVersion === 1 && message.purpose === PURPOSE && message.mode === 'real' && message.parentNonce === manifest.parentNonce && message.childNonce === ready.childNonce && message.cases === 100 && typeof message.sealed === 'boolean' && message.quality === 'not-evaluated' && [message.executionHash, message.provenanceHash, message.claimId].every(value => HASH.test(value)), 'semantic-native-handshake-invalid')
  return message
}
module.exports = { PURPOSE, TRANSPORT, validateCapturedNativeProfileMetadata, bootstrapNativeSemanticContext, prepareNativeSemanticContext, acceptNativeSemanticGrant, consumeNativeSemanticContext, createNativeSemanticProvenance, completeNativeSemanticExecution, validateReadyMessage, validateGrantMessage, grantBody, validateOutcomeMessage }
