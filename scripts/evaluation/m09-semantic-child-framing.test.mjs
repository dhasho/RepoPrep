import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import io from './m09-semantic-io.cjs'
import native from './m09-semantic-native.cjs'
import launcher from './run-semantic-profile.cjs'
import framing from './m09-semantic-child-framing.cjs'
import { loadSemanticPublicBundle, createSemanticExecutionPlan, deriveSemanticConfiguration, createSemanticAuthorizationDraft, validateSemanticConfiguration } from '../agentic/semantic-eval-contract.mjs'

// Public fixture construction and actual monitor only; no native, transport,
// profile store, approval, launch or proof issuer is invoked.
const source = { commit: 'a'.repeat(40), treeSha256: 'b'.repeat(64) }
const bundle = await loadSemanticPublicBundle()
const { plan, executionMap } = createSemanticExecutionPlan(bundle)
const profile = { id: 'synthetic-framing', name: 'Synthetic framing', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic', apiKey: 'synthetic-framing-only-no-provider', protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 8192 }
const configuration = deriveSemanticConfiguration(profile)
const manifest = { parentNonce: 'c'.repeat(64), source, publicDataHash: bundle.publicDataHash, plan, executionMap, entrySourceSha256: 'd'.repeat(64), bundleSha256: 'e'.repeat(64), profileId: profile.id, reference: 'synthetic-framing' }
const ready = { type: 'semantic-ready', schemaVersion: 1, purpose: native.PURPOSE, mode: 'real', parentNonce: manifest.parentNonce, childNonce: 'f'.repeat(64), source, publicDataHash: manifest.publicDataHash, planHash: plan.planHash, executionMapHash: executionMap.executionMapHash, configuration, entrySourceSha256: manifest.entrySourceSha256, bundleSha256: manifest.bundleSha256 }
const authorization = createSemanticAuthorizationDraft({ mode: 'real', reference: manifest.reference, source, bundle, plan, executionMap, configuration })
const grantBody = native.grantBody(manifest, ready, authorization)
const grant = { ...grantBody, grantHash: io.hash(grantBody) }
const outcome = { type: 'semantic-outcome', schemaVersion: 1, purpose: native.PURPOSE, mode: 'real', parentNonce: manifest.parentNonce, childNonce: ready.childNonce, executionHash: '1'.repeat(64), provenanceHash: '2'.repeat(64), claimId: '3'.repeat(64), cases: 100, sealed: false, quality: 'not-evaluated' }
const CRLF = Buffer.from([13, 10])
const CANARY = 'synthetic-sensitive-canary-no-error-echo'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const tick = () => new Promise(resolve => setImmediate(resolve))
function childFixture({ timeoutMs = 1000, onReady = () => grant } = {}) {
  const child = new EventEmitter()
  Object.assign(child, { pid: 1234567, stdout: new PassThrough(), stderr: new PassThrough(), sent: [], kills: 0 })
  child.stdin = new Writable({ write(chunk, _encoding, callback) { child.sent.push(Buffer.from(chunk)); callback() } })
  child.kill = () => { child.kills++; return true }
  let grants = 0, settled = false
  const pending = launcher.monitorSemanticChild(child, { manifest, validateConfiguration: validateSemanticConfiguration, onReady(value) { grants++; return onReady(value) }, timeoutMs })
  void pending.then(() => { settled = true }, () => { settled = true })
  const bytes = []
  return { child, pending, bytes, grants: () => grants, settled: () => settled,
    write(raw) { const value = Buffer.from(raw); bytes.push(value); child.stdout.write(value) },
    close(code = 0, signal = null) { child.emit('close', code, signal) },
    assertAccounting(observed) { const raw = Buffer.concat(bytes); assert.equal(observed.stdoutBytes, raw.length); assert.equal(observed.stdoutSha256, hash(raw)) }
  }
}
async function rejectFixture(f, code = 'semantic-native-handshake-invalid') {
  assert.equal(f.child.kills, 1)
  assert.equal(f.settled(), false)
  f.close(null, 'SIGTERM')
  const error = await f.pending.catch(error => error)
  assert.equal(error.code, code); assert.equal(error.message, code)
  f.assertAccounting(error.observed)
  return error
}

test('pure framing classifier has independent once-only first-line state and no extra authority API', () => {
  const a = framing.createSemanticChildLineClassifier(), b = framing.createSemanticChildLineClassifier()
  assert.deepEqual(Object.keys(framing), ['createSemanticChildLineClassifier'])
  assert.deepEqual(Object.keys(a), ['classify']); assert.equal(Object.isFrozen(a), true)
  assert.equal(a.classify(Buffer.from([13])), 'preamble'); assert.equal(a.classify(Buffer.from([13])), 'invalid-blank')
  assert.equal(b.classify(Buffer.from('{}')), 'message'); assert.equal(b.classify(Buffer.from([13])), 'invalid-blank')
  const c = framing.createSemanticChildLineClassifier(); assert.equal(c.classify(Buffer.alloc(0)), 'invalid-blank'); assert.equal(c.classify(Buffer.from([13])), 'invalid-blank')
})
for (const preamble of [false, true]) test('actual monitor accepts canonical handshake with preamble=' + preamble + ' only after direct close', async () => {
  const f = childFixture(); if (preamble) f.write(CRLF)
  f.write(io.bytes(ready)); f.write(io.bytes(outcome)); await tick()
  assert.equal(f.grants(), 1); assert.equal(f.settled(), false); assert.equal(f.child.kills, 0)
  assert.deepEqual(Buffer.concat(f.child.sent), io.bytes(grant))
  f.close(); const observed = await f.pending; f.assertAccounting(observed)
  assert.equal(observed.stdoutPreambleLines, Number(preamble))
  assert.throws(() => launcher.verifySemanticParentProof(observed, {}), /semantic-native-parent-proof-required/u)
})
for (const mode of ['split CRLF', 'coalesced records', 'split ready']) test('actual monitor preserves exact framing across ' + mode, async () => {
  const f = childFixture(), bytes = Buffer.concat([CRLF, io.bytes(ready), io.bytes(outcome)])
  if (mode === 'split CRLF') { f.write(bytes.subarray(0, 1)); f.write(bytes.subarray(1)) }
  else if (mode === 'split ready') { f.write(bytes.subarray(0, 9)); f.write(bytes.subarray(9, 47)); f.write(bytes.subarray(47)) }
  else f.write(bytes)
  assert.equal(f.grants(), 1); f.close(); const observed = await f.pending; f.assertAccounting(observed); assert.equal(observed.stdoutPreambleLines, 1)
})
test('preamble alone never grants and rejects incomplete status-zero direct close', async () => {
  const f = childFixture(); f.write(CRLF); await tick(); assert.equal(f.grants(), 0); assert.equal(f.settled(), false); assert.equal(f.child.kills, 0)
  f.close(); const error = await f.pending.catch(error => error); assert.equal(error.code, 'semantic-native-child-closed'); assert.equal(error.observed.stdoutPreambleLines, 1); f.assertAccounting(error.observed)
})
test('preamble alone preserves existing timeout and actual-close wait', async () => {
  const f = childFixture({ timeoutMs: 10 }); f.write(CRLF)
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.settled(), false)
  const error = await rejectFixture(f, 'semantic-native-child-timeout'); assert.equal(f.grants(), 0); assert.equal(error.observed.stdoutPreambleLines, 1)
})
const invalidLines = [
  ['empty LF', Buffer.from('\n')], ['space LF', Buffer.from(' \n')], ['tab LF', Buffer.from('\t\n')],
  ['space CRLF', Buffer.from(' \r\n')], ['double CR', Buffer.from('\r\r\n')], ['BOM CRLF', Buffer.from('\ufeff\r\n')],
  ['unknown text', Buffer.from(CANARY + '\n')], ['bad UTF8', Buffer.from([255, 10])],
  ['null JSON', io.bytes(null)], ['array JSON', io.bytes([])], ['primitive JSON', io.bytes(CANARY)],
  ['wrong schema', io.bytes({ type: 'semantic-ready' })], ['JSON CRLF', Buffer.from(io.bytes(ready).toString('utf8').trimEnd() + '\r\n')],
  ['noncanonical JSON', Buffer.from(JSON.stringify(ready, null, 1) + '\n')]
]
for (const [name, line] of invalidLines) test('actual monitor rejects ' + name + ' after the sole valid preamble', async () => {
  const f = childFixture(); f.write(CRLF); f.write(line); const error = await rejectFixture(f, ['array JSON', 'primitive JSON', 'wrong schema'].includes(name) ? 'semantic-native-control-invalid' : 'semantic-native-handshake-invalid')
  assert.equal(f.grants(), 0); assert.equal(error.observed.stdoutPreambleLines, 1); assert.ok(!error.message.includes(CANARY))
})
for (const [name, chunks, grants] of [
  ['second initial CRLF', [CRLF, CRLF], 0],
  ['CRLF after ready', [io.bytes(ready), CRLF], 1],
  ['CRLF between ready/outcome after preamble', [CRLF, io.bytes(ready), CRLF], 1],
  ['CRLF after outcome', [CRLF, io.bytes(ready), io.bytes(outcome), CRLF], 1],
  ['LF before preamble', [Buffer.from('\n'), CRLF], 0]
]) test('actual monitor rejects ' + name + ' without issuing another grant', async () => {
  const f = childFixture(); for (const chunk of chunks) f.write(chunk)
  await rejectFixture(f); assert.equal(f.grants(), grants)
})
for (const suffix of [Buffer.from([13]), Buffer.from('{')]) test('actual monitor rejects partial final line ' + suffix[0], async () => {
  const f = childFixture(); f.write(CRLF); f.write(io.bytes(ready)); f.write(io.bytes(outcome)); f.write(suffix); f.close()
  const error = await f.pending.catch(error => error); assert.equal(error.code, 'semantic-native-child-closed'); f.assertAccounting(error.observed)
})
for (const [name, change] of [
  ['wrong nonce', value => { value.parentNonce = '0'.repeat(64) }], ['wrong source', value => { value.source.commit = '0'.repeat(40) }],
  ['wrong mode', value => { value.mode = 'synthetic' }], ['wrong configuration', value => { value.configuration.saved.temperature = 1.5 }]
]) test('preamble cannot bypass ' + name, async () => {
  const f = childFixture(), value = structuredClone(ready); change(value); f.write(CRLF); f.write(io.bytes(value)); await rejectFixture(f); assert.equal(f.grants(), 0)
})
test('preamble cannot authorize an asynchronous grant', async () => {
  const f = childFixture({ onReady: () => Promise.resolve(grant) }); f.write(CRLF); f.write(io.bytes(ready)); await rejectFixture(f); assert.equal(f.child.sent.length, 0)
})
for (const duplicate of ['ready', 'outcome']) test('preamble cannot bypass duplicate ' + duplicate, async () => {
  const f = childFixture(); f.write(CRLF); f.write(io.bytes(ready)); if (duplicate === 'outcome') f.write(io.bytes(outcome)); f.write(io.bytes(duplicate === 'ready' ? ready : outcome)); await rejectFixture(f, duplicate === 'ready' ? 'semantic-native-control-invalid' : 'semantic-native-handshake-invalid'); assert.equal(f.grants(), 1)
})
test('pipe byte cap includes both preamble bytes at exact cap and cap plus one', async () => {
  for (const extra of [0, 1]) {
    const f = childFixture(); f.write(CRLF); f.write(Buffer.alloc(launcher.MAX_PIPE_BYTES - 2 + extra, 65))
    assert.equal(f.child.kills, extra)
    if (!extra) { f.close(); const error = await f.pending.catch(error => error); assert.equal(error.code, 'semantic-native-child-closed'); f.assertAccounting(error.observed) }
    else await rejectFixture(f)
  }
})
test('parser failure retains its first code and hashes every received stdout drain byte', async () => {
  const f = childFixture(); f.write(CRLF); f.write(Buffer.from(CANARY + '\n')); f.write(io.bytes(ready)); f.write(Buffer.alloc(launcher.MAX_PIPE_BYTES + 1, 66)); f.child.emit('error', new Error(CANARY))
  const error = await rejectFixture(f); assert.equal(f.child.kills, 1); assert.equal(f.grants(), 0); assert.equal(error.observed.stdoutPreambleLines, 1); assert.ok(!error.message.includes(CANARY))
})
for (const [code, signal] of [[1, null], [null, 'SIGTERM']]) test('valid framing cannot bypass actual close ' + code + '/' + signal, async () => {
  const f = childFixture(); f.write(CRLF); f.write(io.bytes(ready)); f.write(io.bytes(outcome)); await tick(); assert.equal(f.settled(), false); f.close(code, signal)
  const error = await f.pending.catch(error => error); assert.equal(error.code, 'semantic-native-child-closed'); f.assertAccounting(error.observed)
})
for (const surface of ['child', 'stdin', 'stdout', 'stderr']) test('valid preamble retains ' + surface + ' error and waits for actual close', async () => {
  const f = childFixture(); f.write(CRLF); (surface === 'child' ? f.child : f.child[surface]).emit('error', new Error(CANARY))
  await rejectFixture(f, surface === 'stdin' ? 'semantic-native-child-closed' : 'semantic-native-child-failed')
})
test('actual close finalizes hashes and ignores late stdout/stderr/error/close events', async () => {
  const f = childFixture(); f.write(CRLF); f.write(io.bytes(ready)); f.write(io.bytes(outcome)); f.close(); const observed = await f.pending
  const saved = JSON.stringify(observed), sent = f.child.sent.length, kills = f.child.kills
  f.child.stdout.emit('data', Buffer.from(CANARY)); f.child.stderr.emit('data', Buffer.from(CANARY)); f.child.emit('error', new Error(CANARY)); f.child.stdin.emit('error', new Error(CANARY)); f.close(1, 'SIGTERM')
  assert.equal(JSON.stringify(observed), saved); assert.equal(f.child.sent.length, sent); assert.equal(f.child.kills, kills); f.assertAccounting(observed)
})
test('existing stderr prefix-hash meaning remains unchanged on cap overflow', async () => {
  const f = childFixture(); const prefix = Buffer.from('synthetic-stderr-prefix'); f.child.stderr.write(prefix); f.child.stderr.write(Buffer.alloc(launcher.MAX_PIPE_BYTES, 67)); f.write(CRLF)
  const error = await rejectFixture(f, 'semantic-native-child-failed'); assert.equal(error.observed.stderrBytes, prefix.length + launcher.MAX_PIPE_BYTES); assert.equal(error.observed.stderrSha256, hash(prefix))
})

test('initial LF and initial whitespace cannot use or replace the exact CRLF allowance', async () => {
  for (const raw of [Buffer.from('\n'), Buffer.from(' \n'), Buffer.from('\t\n'), Buffer.from(' \r\n'), Buffer.from('\r\r\n'), Buffer.from('\ufeff\r\n')]) {
    const f = childFixture(); f.write(raw); f.write(CRLF); const error = await rejectFixture(f); assert.equal(error.observed.stdoutPreambleLines, 0); assert.equal(f.grants(), 0)
  }
})
test('interrupt after preamble still kills once and waits for actual close', async () => {
  const f = childFixture(); f.write(CRLF); process.emit('SIGINT'); await rejectFixture(f, 'semantic-native-child-failed'); assert.equal(f.grants(), 0)
})
test('first parser failure survives the later existing timeout without replacing accounting', async () => {
  const f = childFixture({ timeoutMs: 10 }); f.write(CRLF); f.write(Buffer.from('bad-json\n')); await new Promise(resolve => setTimeout(resolve, 30)); f.write(Buffer.from(CANARY)); await rejectFixture(f); assert.equal(f.child.kills, 1)
})
