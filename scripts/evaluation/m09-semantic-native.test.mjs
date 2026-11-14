import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once, EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import fs from 'node:fs'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import io from './m09-semantic-io.cjs'
import native from './m09-semantic-native.cjs'
import launcher from './run-semantic-profile.cjs'
import { chatCompletionStream } from '../../electron/services/llm.ts'
import { claimSemanticExecution, inspectSemanticSource, executeSemanticEvaluation, executeNativeSemanticEvaluation } from '../agentic/semantic-eval.mjs'
import { fixture, profile, source } from '../agentic/semantic-eval-test-fixture.mjs'
import { deriveSemanticConfiguration, createSemanticAuthorizationDraft, validateSemanticConfiguration, validateFrozenSemanticExecution, semanticHash } from '../agentic/semantic-eval-contract.mjs'

async function loopback(t, responder) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    requests.push({ url: request.url, body })
    const value = responder(body, requests.length)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: value }, finish_reason: 'stop' }] }) + (responder.omitUsage ? '' : '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } })) + '\n\ndata: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { requests, profile: { ...profile, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } }
}
test('production transport awaits admission, performs a zero-wire final fence, and parses actual SSE usage', async t => {
  const wire = await loopback(t, () => 'loopback-response')
  let release, entered
  const admitted = new Promise(resolve => { entered = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  let fences = 0, usage, deltas = ''
  const pending = chatCompletionStream(wire.profile, [{ role: 'user', content: 'synthetic loopback' }], value => { deltas += value }, { includeUsage: true, beforeRequest: async () => { entered(); await waiting }, beforeFetch: () => { fences++ }, onUsage: value => { usage = value } })
  await admitted; assert.equal(wire.requests.length, 0); assert.equal(fences, 0)
  release(); assert.equal(await pending, 'loopback-response')
  assert.equal(wire.requests.length, 1); assert.equal(wire.requests[0].url, '/v1/chat/completions'); assert.equal(fences, 1); assert.equal(deltas, 'loopback-response')
  assert.deepEqual(usage, { inputTokens: 19, outputTokens: 7, totalTokens: 26 })
  for (const beforeFetch of [() => { throw new Error('synthetic final fence') }, () => Promise.reject(new Error('synthetic async fence'))]) {
    await assert.rejects(chatCompletionStream(wire.profile, [{ role: 'user', content: 'synthetic blocked' }], () => {}, { beforeRequest: async () => {}, beforeFetch }))
    assert.equal(wire.requests.length, 1)
  }
})
test('all100 existing genuine cases can use the directly imported production transport over loopback', async t => {
  const wire = await loopback(t, body => {
    const messages = body.messages
    const unit = JSON.parse(messages[1].content.split('\n')[1])
    const ids = [...new Set(JSON.stringify(messages).match(/ev_[a-f0-9-]{36}/gu))]
    if (messages[0].content.startsWith('Revise only')) return JSON.stringify({ question: { question: unit.question, answer: unit.answer + ' Revised from actual public evidence.', followUps: unit.followUps, ...(unit.title ? { title: unit.title } : {}) }, evidenceIds: ids, glossary: {} })
    return JSON.stringify({ assessment: 'material-risk', findings: [{ kind: 'unsupported-claim', path: 'answer', evidenceIds: ids, reason: 'Synthetic loopback evidence finding.' }] })
  })
  const f = await fixture(t, { privateProfile: wire.profile })
  const result = await executeSemanticEvaluation({ mode: 'synthetic', claim: await f.claim(), outputDirectory: f.output, transport: chatCompletionStream })
  assert.equal(result.cases, 100); assert.equal(result.sealed, false); assert.equal(wire.requests.length, 120)
  const validated = await validateFrozenSemanticExecution(f.output)
  assert.equal(validated.executionComplete, true); assert.equal(validated.nativeProvenance, 'not-applicable'); assert.equal(validated.accounting.requests, 120)
  assert.equal(validated.accounting.actualInputTokens, 120 * 19); assert.equal(validated.accounting.actualOutputTokens, 120 * 7)
  assert.equal(validated.quality, 'not-evaluated')
  // Rewrite the entire public structural envelope to real. Even a coherent
  // fabricated native artifact cannot mint the private observed-child anchor.
  const frozen = JSON.parse(await readFile(path.join(f.output, 'execution-freeze.json'), 'utf8')); frozen.mode = 'real'
  const authorization = { ...f.authorization, mode: 'real' }
  const authorizationHash = semanticHash(authorization)
  const claimId = semanticHash({ purpose: native.PURPOSE, mode: 'real', reference: authorization.reference, source: authorization.source })
  const savedClaim = JSON.parse(await readFile(path.join(f.output, 'claim.json'), 'utf8'))
  for (const value of [savedClaim.claim, savedClaim.started]) Object.assign(value, { mode: 'real', authorizationHash, claimId })
  const report = JSON.parse(await readFile(path.join(f.output, 'execution.json'), 'utf8')); Object.assign(report, { mode: 'real', authorizationHash, claimId })
  Object.assign(frozen, { authorizationHash, claimId })
  for (const [name, value] of [['authorization.json', authorization], ['claim.json', savedClaim], ['execution.json', report]]) await writeFile(path.join(f.output, name), io.bytes(value))
  const body = native.grantBody({ parentNonce: 'a'.repeat(64) }, { childNonce: 'b'.repeat(64) }, authorization)
  const grantHash = io.hash(body)
  const provenance = { schemaVersion: 1, purpose: native.PURPOSE, mode: 'real', native: { platform: 'win32', processType: 'browser', electron: '1.0.0', node: '22.0.0', chrome: '1.0.0' }, transport: native.TRANSPORT, parentNonce: body.parentNonce, childNonce: body.childNonce, source: frozen.source, entrySourceSha256: 'c'.repeat(64), bundleSha256: 'd'.repeat(64), publicDataHash: frozen.publicDataHash, planHash: frozen.planHash, executionMapHash: frozen.executionMapHash, configurationHash: frozen.configurationHash, authorizationHash, grantHash, grantFileSha256: io.sha256(io.bytes({ ...body, grantHash })), claimId, bootstrap: { capture: 1, stage: 1, paths: 4, release: 1, privateProfile: 1, distinctPaths: 4, captureBeforeReady: true, pathSwitchBeforeReady: true, releaseAfterPathSwitch: true }, freezeBinding: 'parent-observed-close-exact-freeze-v1' }
  await writeFile(path.join(f.output, 'native-provenance.json'), io.bytes(provenance))
  frozen.artifacts.push({ path: 'native-provenance.json' })
  const refreeze = async () => { for (const artifact of frozen.artifacts) { const raw = await readFile(path.join(f.output, artifact.path)); artifact.bytes = raw.length; artifact.sha256 = io.sha256(raw) } await writeFile(path.join(f.output, 'execution-freeze.json'), io.bytes(frozen)) }
  await refreeze()
  const detached = await validateFrozenSemanticExecution(f.output)
  assert.equal(detached.mode, 'real'); assert.equal(detached.nativeProvenance, 'unavailable'); assert.equal(detached.executionComplete, false)
  await assert.rejects(validateFrozenSemanticExecution(f.output, { requireReal: true }), /semantic-native-parent-proof-required/u)
  for (const nativeParentProof of [{ native: true }, { kind: 'm09-observed-native-child' }, detached]) await assert.rejects(validateFrozenSemanticExecution(f.output, { requireReal: true, nativeParentProof }), /semantic-native-parent-proof-required/u)
  for (const key of ['parentNonce', 'configurationHash', 'grantHash', 'bundleSha256', 'source']) {
    const altered = { ...provenance, [key]: key === 'source' ? { ...provenance.source, commit: '0'.repeat(40) } : '0'.repeat(64) }
    await writeFile(path.join(f.output, 'native-provenance.json'), io.bytes(altered)); await refreeze()
    await assert.rejects(validateFrozenSemanticExecution(f.output, { requireReal: true, nativeParentProof: {} }))
  }
})
test('Node, copied context, synthetic claim and caller transport cannot enter native execution', async t => {
  assert.throws(() => native.bootstrapNativeSemanticContext('C:\\synthetic', 'C:\\synthetic\\entry.cjs'), /semantic-native-main-required/u)
  const f = await fixture(t); const claim = await f.claim(); let calls = 0
  const transport = async () => { calls++; return '' }
  for (const context of [{ kind: 'm09-native-semantic-context' }, claim, { ...claim }, null]) await assert.rejects(executeNativeSemanticEvaluation({ context }), /semantic-native-context-required/u)
  for (const extra of [{ transport }, { profile }, { currentProfile: () => profile }, { dependencies: { transport } }, { mode: 'real' }]) await assert.rejects(executeNativeSemanticEvaluation({ context: claim, ...extra }), /semantic-native-context-required/u)
  for (const invalid of [Object.defineProperty({ context: claim }, 'transport', { value: transport }), { context: claim, [Symbol('transport')]: transport }]) await assert.rejects(executeNativeSemanticEvaluation(invalid), /semantic-native-context-required/u)
  let getters = 0; const accessor = Object.defineProperty({}, 'context', { enumerable: true, get() { getters++; return claim } })
  await assert.rejects(executeNativeSemanticEvaluation(accessor), /semantic-native-context-required/u); assert.equal(getters, 0)
  await assert.rejects(executeSemanticEvaluation({ mode: 'real', claim, outputDirectory: f.output, transport }), /semantic-claim-mode/u)
  assert.equal(calls, 0)
  assert.throws(() => launcher.verifySemanticParentProof({ kind: 'm09-observed-native-child' }, { outputDirectory: f.output, freezeBytes: Buffer.from('synthetic'), provenance: {} }), /semantic-native-parent-proof-required/u)
})
async function handshakeFixture(t) {
  const f = await fixture(t)
  const manifest = { parentNonce: 'c'.repeat(64), source, publicDataHash: f.bundle.publicDataHash, plan: f.plan, executionMap: f.executionMap, entrySourceSha256: 'd'.repeat(64), bundleSha256: 'e'.repeat(64), profileId: profile.id, reference: 'synthetic-handshake-' + randomUUID() }
  const configuration = deriveSemanticConfiguration(profile)
  const ready = { type: 'semantic-ready', schemaVersion: 1, purpose: native.PURPOSE, mode: 'real', parentNonce: manifest.parentNonce, childNonce: 'f'.repeat(64), source, publicDataHash: manifest.publicDataHash, planHash: f.plan.planHash, executionMapHash: f.executionMap.executionMapHash, configuration, entrySourceSha256: manifest.entrySourceSha256, bundleSha256: manifest.bundleSha256 }
  const authorization = createSemanticAuthorizationDraft({ mode: 'real', reference: manifest.reference, source, bundle: f.bundle, plan: f.plan, executionMap: f.executionMap, configuration })
  const body = native.grantBody(manifest, ready, authorization); const grant = { ...body, grantHash: io.hash(body) }
  const outcome = { type: 'semantic-outcome', schemaVersion: 1, purpose: native.PURPOSE, mode: 'real', parentNonce: manifest.parentNonce, childNonce: ready.childNonce, executionHash: '1'.repeat(64), provenanceHash: '2'.repeat(64), claimId: '3'.repeat(64), cases: 100, sealed: false, quality: 'not-evaluated' }
  return { f, manifest, ready, authorization, grant, outcome }
}
test('ready/grant schemas reject configuration, source, nonce, mode, budget and binding changes', async t => {
  const h = await handshakeFixture(t)
  native.validateReadyMessage(h.ready, h.manifest, validateSemanticConfiguration)
  native.validateGrantMessage(h.grant, h.manifest, h.ready, h.authorization)
  for (const change of [value => { value.mode = 'synthetic' }, value => { value.source.commit = '0'.repeat(40) }, value => { value.configuration.saved.temperature = 1.5 }, value => { value.planHash = '0'.repeat(64) }, value => { value.bundleSha256 = '0'.repeat(64) }, value => { value.parentNonce = '0'.repeat(64) }, value => { value.profile = profile }]) {
    const value = structuredClone(h.ready); change(value); assert.throws(() => native.validateReadyMessage(value, h.manifest, validateSemanticConfiguration))
  }
  for (const change of [value => { value.mode = 'synthetic' }, value => { value.childNonce = '0'.repeat(64) }, value => { value.authorization.budgets.aggregate.maxRequests++ }, value => { value.authorization.source.commit = '0'.repeat(40) }, value => { value.authorization.configuration.saved.temperature = 1.5 }, value => { value.authorization.reference = 'changed' }]) {
    const value = structuredClone(h.grant); change(value); const { grantHash, ...body } = value; value.grantHash = io.hash(body)
    assert.throws(() => native.validateGrantMessage(value, h.manifest, h.ready, h.authorization))
  }
  assert.throws(() => native.validateGrantMessage({ ...h.grant, grantHash: '0'.repeat(64) }, h.manifest, h.ready, h.authorization))
})
test('child grant input requires one canonical bounded message and EOF before acceptance', async () => {
  const good = new PassThrough(); const accepted = io.oneMessage(good, { maximum: 128, timeoutMs: 500 }); let done = false; void accepted.then(() => { done = true })
  good.write(io.bytes({ grant: 'synthetic' })); await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false)
  good.end(); assert.deepEqual(await accepted, { grant: 'synthetic' })
  for (const raw of [Buffer.from('{}\n{}\n'), Buffer.from('{"x":1}'), Buffer.from('{ "x": 1 }\n'), Buffer.alloc(129, 65)]) { const stream = new PassThrough(); const pending = io.oneMessage(stream, { maximum: 128, timeoutMs: 500 }); stream.end(raw); await assert.rejects(pending, /semantic-native-handshake-invalid/u) }
})
function fakeChild() {
  const child = new EventEmitter(); child.pid = 1234567; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.sent = []
  child.stdin = new Writable({ write(chunk, _encoding, callback) { child.sent.push(Buffer.from(chunk)); callback() } }); child.kills = 0
  child.kill = () => { child.kills++; return true }
  return child
}
test('parent waits direct close and cannot treat outcome bytes or an error as completion', async t => {
  const h = await handshakeFixture(t); const child = fakeChild(); let grants = 0, settled = false
  const pending = launcher.monitorSemanticChild(child, { manifest: h.manifest, validateConfiguration: validateSemanticConfiguration, onReady: () => { grants++; return h.grant }, timeoutMs: 1000 })
  void pending.then(() => { settled = true })
  child.stdout.write(io.bytes(h.ready)); child.stdout.write(io.bytes(h.outcome)); await new Promise(resolve => setImmediate(resolve))
  assert.equal(grants, 1); assert.equal(settled, false); assert.deepEqual(JSON.parse(Buffer.concat(child.sent)), h.grant)
  child.emit('close', 0, null); const observed = await pending; assert.equal(observed.childClosed, true)
  assert.throws(() => launcher.verifySemanticParentProof(observed, {}), /semantic-native-parent-proof-required/u)
  const failed = fakeChild(); let rejected = false
  const failure = launcher.monitorSemanticChild(failed, { manifest: h.manifest, validateConfiguration: validateSemanticConfiguration, onReady: () => h.grant, timeoutMs: 1000 })
  void failure.catch(() => { rejected = true }); failed.emit('error', new Error('unknown-sensitive-text'))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(rejected, false); assert.equal(failed.kills, 1)
  failed.emit('close', 1, null); await assert.rejects(failure, /semantic-native-child-failed/u)
})
test('parent rejects replay, malformed/wrong-mode messages, bounded pipes, late close and timeout', async t => {
  const h = await handshakeFixture(t)
  for (const raw of [Buffer.concat([io.bytes(h.ready), io.bytes(h.ready)]), io.bytes({ ...h.ready, mode: 'synthetic' }), Buffer.from('not-json\n'), Buffer.alloc(launcher.MAX_PIPE_BYTES + 1, 65), Buffer.concat([io.bytes(h.ready), io.bytes(h.outcome), io.bytes(h.outcome)])]) {
    const child = fakeChild(); const pending = launcher.monitorSemanticChild(child, { manifest: h.manifest, validateConfiguration: validateSemanticConfiguration, onReady: () => h.grant, timeoutMs: 1000 })
    child.stdout.write(raw); assert.equal(child.kills, 1); child.emit('close', 1, null); await assert.rejects(pending, /semantic-native-(?:handshake|control)-invalid/u)
  }
  const child = fakeChild(); const pending = launcher.monitorSemanticChild(child, { manifest: h.manifest, validateConfiguration: validateSemanticConfiguration, onReady: () => h.grant, timeoutMs: 20 })
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(child.kills, 1); child.emit('close', null, 'SIGTERM'); await assert.rejects(pending, /semantic-native-child-timeout/u)
})
test('runtime cleanup binds actual identity and preserves unexpected entries and copied tokens', async () => {
  const runtime = launcher.createSemanticRuntime()
  assert.throws(() => launcher.cleanupSemanticRuntime({ ...runtime.token }), /semantic-native-cleanup-preserved/u)
  const unexpected = path.join(runtime.root, 'unexpected-synthetic.txt'); io.write(unexpected, Buffer.from('retain-me'))
  assert.throws(() => launcher.cleanupSemanticRuntime(runtime.token), /semantic-native-cleanup-preserved/u)
  assert.equal(fs.readFileSync(unexpected, 'utf8'), 'retain-me')
  // Only our test-created diagnostic is removed, after captured file validation.
  io.file(unexpected); fs.unlinkSync(unexpected)
  const cleaned = launcher.cleanupSemanticRuntime(runtime.token)
  assert.equal(cleaned.removed, true); assert.equal(fs.existsSync(runtime.root), false)
})
test('bundling keeps the native registry singular and includes the real production fetch implementation', async t => {
  const require = createRequire(import.meta.url); const build = require('esbuild').build
  const root = path.resolve(import.meta.dirname, '../..')
  const result = await build({ entryPoints: [path.join(root, 'scripts/evaluation/run-semantic-profile-entry.cjs')], bundle: true, write: false, metafile: true, platform: 'node', format: 'cjs', target: 'node22', tsconfig: path.join(root, 'tsconfig.node.json'), external: ['electron'], logLevel: 'silent', define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(root, 'scripts/agentic/semantic-eval-contract.mjs')).href) } })
  const inputs = Object.keys(result.metafile.inputs)
  assert.equal(inputs.filter(name => name.endsWith('/m09-semantic-native.cjs')).length, 1)
  assert.equal(inputs.filter(name => name.endsWith('/llm.ts')).length, 1)
  assert.equal(inputs.some(name => name.endsWith('/run-semantic-profile.cjs')), false)
  const sourceCjs = require('./run-semantic-profile.cjs')
  const sourceEsm = await import(new URL('./run-semantic-profile.cjs', import.meta.url).href)
  assert.equal(sourceCjs, sourceEsm.default); assert.equal(sourceCjs.verifySemanticParentProof, launcher.verifySemanticParentProof)
  const emitted = result.outputFiles[0].text
  assert.ok(emitted.includes('chatCompletionStream')); assert.ok(emitted.includes('fetch(')); assert.ok(emitted.includes('getPrivateProfile'))
  assert.equal(inputs.some(name => /(?:truth|rubric|review-key|repair-key)/iu.test(name)), false)
})

test('captured profile metadata preserves optional absence before shared defaults are derived', () => {
  const raw = { id: 'synthetic-defaults', name: 'Synthetic defaults', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-only', model: 'synthetic-model' }
  const selected = { profileId: raw.id, model: raw.model, savedBaseUrlSha256: io.sha256(Buffer.from('repoprep:m09:saved-base-url:v1\0' + raw.baseUrl)) }
  assert.equal(native.validateCapturedNativeProfileMetadata(raw, selected), true)
  assert.equal(deriveSemanticConfiguration(raw).saved.protocol, 'openai'); assert.equal(deriveSemanticConfiguration(raw).saved.temperature, 0.4)
  for (const field of [{ protocol: 'openai' }, { temperature: 0.4 }, { maxOutputTokens: 8192 }]) assert.throws(() => native.validateCapturedNativeProfileMetadata({ ...raw, ...field }, selected), /semantic-native-profile-mismatch/u)
  assert.throws(() => native.validateCapturedNativeProfileMetadata({ ...raw, baseUrl: raw.baseUrl + '/' }, selected), /semantic-native-profile-mismatch/u)
})
test('renderer, worker, already-ready and run-as-node candidates fail before snapshot capture', async () => {
  const require = createRequire(import.meta.url)
  const source = await readFile(new URL('./m09-semantic-native.cjs', import.meta.url), 'utf8')
  for (const candidate of [
    { type: 'renderer', platform: 'win32', ready: false, main: true, env: {} },
    { type: 'browser', platform: 'win32', ready: false, main: false, env: {} },
    { type: 'browser', platform: 'win32', ready: true, main: true, env: {} },
    { type: 'browser', platform: 'win32', ready: false, main: true, env: { ELECTRON_RUN_AS_NODE: '0' } },
    { type: 'browser', platform: 'linux', ready: false, main: true, env: {} }
  ]) {
    let captures = 0
    const module = { exports: {} }
    vm.runInNewContext(source, { module, exports: module.exports, Buffer, process: { platform: candidate.platform, type: candidate.type, versions: { electron: '1.0.0' }, env: candidate.env }, require: name => name === 'electron' ? { app: { isReady: () => candidate.ready, setPath() {} } } : name === 'node:worker_threads' ? { isMainThread: candidate.main } : name === './m09-profile-snapshot.cjs' ? { captureM09ProfileSnapshot() { captures++; throw new Error('must not capture') } } : require(name) })
    assert.throws(() => module.exports.bootstrapNativeSemanticContext('C:\\synthetic', 'C:\\synthetic\\entry.cjs'), /semantic-native-(?:main|before-ready)-required/u)
    assert.equal(captures, 0)
  }
})

test('actual production missing usage retains a hold and seals all later case dispatches', async t => {
  const responder = () => JSON.stringify({ assessment: 'no-material-risk', findings: [] }); responder.omitUsage = true
  const wire = await loopback(t, responder); const f = await fixture(t, { privateProfile: wire.profile })
  const result = await executeSemanticEvaluation({ mode: 'synthetic', claim: await f.claim(), outputDirectory: f.output, transport: chatCompletionStream })
  assert.equal(wire.requests.length, 1); assert.equal(result.cases, 100); assert.equal(result.sealed, true)
  const valid = await validateFrozenSemanticExecution(f.output)
  assert.equal(valid.executionComplete, false); assert.equal(valid.accounting.unknownRequests, 1); assert.equal(valid.accounting.requests, 1)
  const first = JSON.parse(await readFile(path.join(f.output, 'cases', f.plan.units[0].unitId + '.json')))
  assert.equal(first.ledger.reservations[0].state, 'unknown'); assert.equal(first.ledger.total.inputTokens, first.requests[0].inputAdmission); assert.equal(first.ledger.total.outputTokens, first.requests[0].outputReservation)
})
test('actual production final fence sees public mutation after awaited admission and sends zero wire requests', async t => {
  const wire = await loopback(t, () => '{}'); const f = await fixture(t, { copyData: true, privateProfile: wire.profile }); let entries = 0
  const target = path.join(f.data, 'projects.json'); const original = await readFile(target)
  const transport = (active, messages, delta, options) => { entries++; return chatCompletionStream(active, messages, delta, { ...options, onRequest: () => fs.appendFileSync(target, ' ') }) }
  const result = await executeSemanticEvaluation({ mode: 'synthetic', claim: await f.claim(), outputDirectory: f.output, transport })
  assert.equal(entries, 1); assert.equal(wire.requests.length, 0); assert.equal(result.sealed, true); assert.equal(result.cases, 100)
  const first = JSON.parse(await readFile(path.join(f.output, 'cases', f.plan.units[0].unitId + '.json')))
  assert.equal(first.requests[0].fetchFence, false); assert.equal(first.ledger.reservations[0].state, 'unknown')
  assert.equal(first.ledger.total.inputTokens, first.requests[0].inputAdmission); assert.equal(first.ledger.total.outputTokens, first.requests[0].outputReservation)
  await writeFile(target, original)
})

test('even a clean real source refuses ordinary caller profile/currentProfile before writing a claim', async t => {
  const f = await fixture(t)
  const invoke = args => execFileSync('git', ['-C', f.root, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const email = execFileSync('git', ['config', 'user.email'], { windowsHide: true, encoding: 'utf8' }).trim()
  invoke(['init', '--quiet', '--initial-branch=main'])
  invoke(['-c', 'user.name=dhasho', '-c', 'user.email=' + email, 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic security fixture'])
  const realSource = await inspectSemanticSource(f.root)
  const authorization = createSemanticAuthorizationDraft({ mode: 'real', reference: 'synthetic-clean-real-refusal', source: realSource, bundle: f.bundle, plan: f.plan, executionMap: f.executionMap, configuration: f.configuration })
  let reads = 0
  await assert.rejects(claimSemanticExecution({ mode: 'real', repoRoot: f.root, dataDirectory: f.data, profile, currentProfile: () => { reads++; return profile }, plan: f.plan, executionMap: f.executionMap, authorization, claimDirectory: path.join(f.root, 'claims'), context: { kind: 'm09-native-semantic-context' } }), /semantic-native-context-required/u)
  assert.equal(reads, 0); assert.equal(fs.readdirSync(path.join(f.root, 'claims')).length, 0)
})
function stagedRuntimeFixture() {
  const runtime = launcher.createSemanticRuntime()
  const stage = path.join(runtime.root, 'm09-profile-' + 'a'.repeat(48)); io.mkdir(stage)
  const names = { userData: 'user-data', sessionData: 'session-data', cache: 'cache', crashDumps: 'crash-dumps' }
  const paths = {}
  for (const [key, leaf] of Object.entries(names)) { const target = path.join(stage, leaf); fs.mkdirSync(target); paths[key] = { path: target, identity: io.directory(target) } }
  const settings = path.join(paths.userData.path, 'settings.json')
  const localState = path.join(paths.sessionData.path, 'Local State')
  fs.writeFileSync(settings, 'synthetic-encrypted-settings', { flag: 'wx' })
  fs.writeFileSync(localState, 'synthetic-local-state', { flag: 'wx' })
  const files = [settings, localState].map(filename => ({ relative: path.relative(stage, filename).split(path.sep).join('/'), identity: io.file(filename).identity }))
  io.write(path.join(runtime.root, 'bootstrap.json'), io.bytes({ schemaVersion: 1, parentNonce: 'b'.repeat(64), runtimeRoot: stage, runtimeIdentity: io.directory(stage), paths, files }))
  return { runtime, stage, paths, settings, localState }
}

function atomicReplace(filename, bytes) {
  const temporary = path.join(path.dirname(filename), '.replacement-' + randomUUID())
  fs.writeFileSync(temporary, bytes, { flag: 'wx' })
  fs.renameSync(temporary, filename)
}

test('staged runtime cleanup permits atomic Local State replacement under the captured session-data directory', () => {
  const f = stagedRuntimeFixture()
  const before = io.file(f.localState).identity
  const parent = io.directory(path.dirname(f.localState))
  atomicReplace(f.localState, Buffer.from('synthetic-local-state-after-atomic-replacement'))
  assert.notDeepEqual(io.file(f.localState).identity, before)
  assert.deepEqual(io.directory(path.dirname(f.localState)), parent)
  const cleaned = launcher.cleanupSemanticRuntime(f.runtime.token)
  assert.equal(cleaned.removed, true); assert.ok(cleaned.freedBytes > 50); assert.equal(fs.existsSync(f.runtime.root), false)
})

test('staged runtime cleanup preserves settings replacement and can clean after original identity is restored', () => {
  const f = stagedRuntimeFixture()
  const backup = path.join(path.dirname(f.runtime.root), path.basename(f.runtime.root) + '-settings-original')
  fs.renameSync(f.settings, backup)
  fs.writeFileSync(f.settings, 'synthetic-replaced-settings', { flag: 'wx' })
  assert.throws(() => launcher.cleanupSemanticRuntime(f.runtime.token), /semantic-native-cleanup-preserved/u)
  assert.equal(fs.existsSync(f.runtime.root), true); assert.equal(fs.existsSync(f.localState), true)
  fs.unlinkSync(f.settings); fs.renameSync(backup, f.settings)
  assert.equal(launcher.cleanupSemanticRuntime(f.runtime.token).removed, true)
})

test('staged runtime cleanup preserves a directory junction replacing the fixed session-data path', () => {
  const f = stagedRuntimeFixture()
  const sessionData = f.paths.sessionData.path
  const backup = path.join(path.dirname(f.runtime.root), path.basename(f.runtime.root) + '-session-data-original')
  fs.renameSync(sessionData, backup)
  fs.symlinkSync(backup, sessionData, 'junction')
  assert.throws(() => launcher.cleanupSemanticRuntime(f.runtime.token), /semantic-native-runtime-unsafe/u)
  assert.equal(fs.lstatSync(sessionData).isSymbolicLink(), true); assert.equal(fs.existsSync(f.runtime.root), true)
  fs.rmdirSync(sessionData); fs.renameSync(backup, sessionData)
  assert.equal(launcher.cleanupSemanticRuntime(f.runtime.token).removed, true)
})

test('staged runtime cleanup preserves hard-linked settings and unknown entries', () => {
  const f = stagedRuntimeFixture()
  const hardLink = path.join(path.dirname(f.runtime.root), path.basename(f.runtime.root) + '-settings-link')
  fs.linkSync(f.settings, hardLink)
  assert.throws(() => launcher.cleanupSemanticRuntime(f.runtime.token), /semantic-native-runtime-unsafe/u)
  assert.equal(fs.existsSync(f.runtime.root), true); assert.equal(fs.existsSync(f.settings), true)
  fs.unlinkSync(hardLink)
  const unexpected = path.join(f.paths.cache.path, 'unknown-synthetic.txt')
  fs.writeFileSync(unexpected, 'preserve-synthetic-diagnostic', { flag: 'wx' })
  assert.throws(() => launcher.cleanupSemanticRuntime(f.runtime.token), /semantic-native-cleanup-preserved/u)
  assert.equal(fs.readFileSync(unexpected, 'utf8'), 'preserve-synthetic-diagnostic')
  fs.unlinkSync(unexpected)
  assert.equal(launcher.cleanupSemanticRuntime(f.runtime.token).removed, true)
})

test('staged runtime cleanup refuses active runtime owners', () => {
  let capturedOwner
  const originalSet = WeakMap.prototype.set
  WeakMap.prototype.set = function (key, value) {
    if (key?.kind === 'm09-owned-semantic-runtime') capturedOwner = value
    return Reflect.apply(originalSet, this, [key, value])
  }
  let runtime
  try { runtime = launcher.createSemanticRuntime() } finally { WeakMap.prototype.set = originalSet }
  assert.ok(capturedOwner)
  capturedOwner.active = true; capturedOwner.closed = false
  assert.throws(() => launcher.cleanupSemanticRuntime(runtime.token), /semantic-native-cleanup-preserved/u)
  capturedOwner.active = true; capturedOwner.closed = true
  assert.throws(() => launcher.cleanupSemanticRuntime(runtime.token), /semantic-native-cleanup-preserved/u)
  capturedOwner.active = false; capturedOwner.closed = false
  assert.throws(() => launcher.cleanupSemanticRuntime(runtime.token), /semantic-native-cleanup-preserved/u)
  capturedOwner.active = false; capturedOwner.closed = true
  assert.equal(launcher.cleanupSemanticRuntime(runtime.token).removed, true)
})

test('staged runtime cleanup preserves unknown nested files and removes only the captured safe inventory', async () => {
  const runtime = launcher.createSemanticRuntime()
  const stage = path.join(runtime.root, 'm09-profile-' + 'a'.repeat(48)); io.mkdir(stage)
  const names = { userData: 'user-data', sessionData: 'session-data', cache: 'cache', crashDumps: 'crash-dumps' }
  const paths = {}
  for (const [key, leaf] of Object.entries(names)) { const target = path.join(stage, leaf); fs.mkdirSync(target); paths[key] = { path: target, identity: io.directory(target) } }
  const files = ['user-data/settings.json', 'session-data/Local State'].map(relative => { const target = path.join(stage, ...relative.split('/')); fs.writeFileSync(target, 'synthetic-encrypted-placeholder', { flag: 'wx' }); return { relative, identity: io.file(target).identity } })
  io.write(path.join(runtime.root, 'bootstrap.json'), io.bytes({ schemaVersion: 1, parentNonce: 'b'.repeat(64), runtimeRoot: stage, runtimeIdentity: io.directory(stage), paths, files }))
  const unexpected = path.join(paths.cache.path, 'unknown-fixture.txt'); fs.writeFileSync(unexpected, 'preserve-synthetic-diagnostic', { flag: 'wx' })
  assert.throws(() => launcher.cleanupSemanticRuntime(runtime.token), /semantic-native-cleanup-preserved/u)
  assert.equal(fs.readFileSync(unexpected, 'utf8'), 'preserve-synthetic-diagnostic'); assert.equal(fs.existsSync(path.join(paths.userData.path, 'settings.json')), true)
  io.file(unexpected); fs.unlinkSync(unexpected)
  const cleaned = launcher.cleanupSemanticRuntime(runtime.token)
  assert.equal(cleaned.removed, true); assert.ok(cleaned.freedBytes > 50); assert.equal(fs.existsSync(runtime.root), false)
})
