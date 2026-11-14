import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node test runner.
import { openWorkflowStore, readWorkflowStore, createWorkflowVisiblePayloadPolicy, WORKFLOW_STORE_MAXIMA } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import type { WorkflowStoreOptions, WorkflowStoreStep } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import { acquireWorkflowWriter, closeWorkflowWriter, queueWorkflowWriter } from './workflow-writer.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import type { WorkflowAttempt, WorkflowRunBinding, WorkflowWriterOwner } from './workflow-writer.ts'

const native = process.platform === 'win32'
const binding: WorkflowRunBinding = Object.freeze({ version: 1, logicalRunId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', runSpecHash: 'a'.repeat(64), configHash: 'b'.repeat(64), schemaVersion: 'workflow-v1', policyVersion: 'policy-v1' })
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validators = {
  ledger: { schemaId: 'ledger-test-v1', validate: (value: unknown) => object(value) && Number.isSafeInteger(value.held) },
  result: { schemaId: 'result-test-v1', validate: (value: unknown) => object(value) && typeof value.text === 'string' },
  'critical-journal': { schemaId: 'journal-test-v1', validate: (value: unknown) => object(value) && typeof value.event === 'string' },
  'recorded-visible-response': { schemaId: 'visible-test-v1', validate: (value: unknown) => object(value) && typeof value.text === 'string' }
}
function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-workflow-w-')) }
function cleanup(directory: string): void {
  const resolved = path.resolve(directory)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('repoprep-workflow-w-'))
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false)
  fs.rmSync(resolved, { recursive: true, force: true })
}
function options(directory: string, extra: Partial<WorkflowStoreOptions> = {}): WorkflowStoreOptions { return { storageDirectory: directory, validators, ...extra } }
function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function storeRoot(directory: string): string { return path.join(directory, 'workflow-store', 'v1') }
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)])
}
function record(directory: string, prefix: string): string { const found = files(storeRoot(directory)).filter(file => path.basename(file).startsWith(prefix)).sort().at(-1); assert.ok(found); return found }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const checkpoint = (text: string) => ({ stage: 'generating' as const, components: [{ kind: 'ledger' as const, payload: { held: 100 } }, { kind: 'result' as const, payload: { text } }] })
function worker(directory: string, mode = 'hold', step = '') {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', 'tests/fixtures/workflow-store/child.mjs', directory, mode, step], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let output = ''
  child.stderr?.on('data', bytes => { if (output.length < 8192) output += String(bytes) })
  const exit = once(child, 'exit')
  const message = once(child, 'message').then(([value]) => value as { state: string; code?: string })
  const stop = setTimeout(() => { child.kill() }, 50000)
  child.once('exit', () => clearTimeout(stop))
  return { child, exit, message, error: () => output }
}

// The ownership primitive is intentionally unavailable elsewhere until a native proof exists.
test('unsupported platform fails closed', { skip: native }, async () => {
  const directory = temp()
  try { await assert.rejects(openWorkflowStore(options(directory)), { code: 'unsupported-platform' }); assert.equal(readWorkflowStore(options(directory), binding).status, 'unavailable') } finally { cleanup(directory) }
})

test('real immutable component, journal and carry-forward round trip; legacy bytes unchanged', { skip: !native }, async () => {
  const directory = temp()
  const projectHash = createHash('sha1').update('synthetic-project').digest('hex')
  const legacy = [path.join(directory, 'draft-v1.json'), path.join(directory, 'generation-drafts', `${hash('synthetic-project')}.json`), path.join(directory, 'projects', `${projectHash}.json`), path.join(directory, 'projects', `${projectHash}.history`, `1700000000000-medium-general-${hash('synthetic-result')}.json`)]
  for (const filename of legacy) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, '{"version":1,"checkpoint":{"version":2},"legacy":"untouched"}') }
  let store = await openWorkflowStore(options(directory))
  try {
    const attempt = await store.beginAttempt(binding)
    const journal = await store.appendJournal(attempt, { event: 'intent' })
    const manifest = await store.publish(attempt, checkpoint('initial'))
    assert.equal(manifest.journalPosition?.sha256, journal.reference.sha256)
    let view = store.read(binding)
    assert.equal(view.status, 'verified')
    if (view.status !== 'verified') return
    assert.equal(view.manifest?.sequence, 1)
    assert.deepEqual(view.components.map(item => item.payload), [{ held: 100 }, { text: 'initial' }])
    assert.equal(view.journal.length, 1)
    assert.equal(store.read({ ...binding, projectId: 'another-project' }).status, 'unavailable')
    assert.equal(store.read({ ...binding, configHash: 'c'.repeat(64) }).status, 'unavailable')
    await store.close()
    store = await openWorkflowStore(options(directory))
    const next = await store.beginAttempt(binding)
    await store.appendJournal(next, { event: 'receipt' })
    await store.publish(next, checkpoint('resumed'))
    view = store.read(binding)
    assert.equal(view.status, 'verified')
    if (view.status !== 'verified') return
    assert.equal(view.currentEpoch.owner, 2)
    assert.equal(view.currentEpoch.attempt, 2)
    assert.equal(view.manifest?.sequence, 2)
    assert.equal(view.journal.length, 2)
    for (const filename of legacy) assert.equal(fs.readFileSync(filename, 'utf8'), '{"version":1,"checkpoint":{"version":2},"legacy":"untouched"}')
  } finally { await store.close(); cleanup(directory) }
})

test('forged/copied capabilities, cross-owner calls and terminal old actors cannot write or release a new slot', { skip: !native }, async () => {
  const directory = temp(), otherDirectory = temp()
  const store = await openWorkflowStore(options(directory)), other = await openWorkflowStore(options(otherDirectory))
  try {
    const attempt = await store.beginAttempt(binding)
    assert.throws(() => store.assertCurrent({} as WorkflowAttempt), { code: 'attempt-inactive' })
    assert.deepEqual(store.assertCurrent(attempt), store.assertCurrent(attempt))
    assert.throws(() => store.assertCurrent({ ...attempt }), { code: 'attempt-inactive' })
    assert.throws(() => other.assertCurrent(attempt), { code: 'attempt-inactive' })
    await assert.rejects(store.publish({} as WorkflowAttempt, checkpoint('forged')), { code: 'attempt-inactive' })
    await assert.rejects(store.publish({ ...attempt }, checkpoint('copied')), { code: 'attempt-inactive' })
    await assert.rejects(other.publish(attempt, checkpoint('cross-store')), { code: 'attempt-inactive' })
    assert.equal(store.finishAttempt(attempt), true)
    const next = await store.beginAttempt(binding)
    assert.throws(() => store.assertCurrent(attempt), { code: 'attempt-inactive' })
    assert.equal(store.assertCurrent(next).epoch.attempt, 2)
    assert.equal(store.finishAttempt(attempt), false)
    await assert.rejects(store.appendJournal(attempt, { event: 'late' }), { code: 'attempt-inactive' })
    await store.publish(next, checkpoint('current'))
    assert.equal(store.read(binding).status, 'verified')
    await assert.rejects(queueWorkflowWriter({} as WorkflowWriterOwner, () => undefined), { code: 'revoked' })
  } finally { await store.close(); await other.close(); cleanup(directory); cleanup(otherDirectory) }
})

test('cancel during a component await rejects queued late work and preserves the prefix', { skip: !native }, async () => {
  const directory = temp(), gate = deferred(), entered = deferred()
  let pause = false
  const store = await openWorkflowStore(options(directory, { onDurableStep: async step => { if (pause && step === 'component-flushed') { entered.resolve(); await gate.promise } } }))
  try {
    const controller = new AbortController(), attempt = await store.beginAttempt(binding, { signal: controller.signal })
    await store.publish(attempt, checkpoint('prefix'))
    pause = true
    const writing = store.publish(attempt, checkpoint('cancelled')).then(() => 'accepted', error => error.code)
    await entered.promise
    const queued = store.publish(attempt, checkpoint('queued-late')).then(() => 'accepted', error => error.code)
    controller.abort()
    const next = store.beginAttempt(binding)
    gate.resolve()
    assert.equal(await writing, 'attempt-inactive')
    assert.equal(await queued, 'attempt-inactive')
    const current = await next
    pause = false
    assert.equal(store.finishAttempt(attempt), false)
    await store.publish(current, checkpoint('new-attempt'))
    const view = store.read(binding)
    assert.equal(view.status, 'verified')
    if (view.status === 'verified') assert.deepEqual(view.components.at(-1)?.payload, { text: 'new-attempt' })
  } finally { gate.resolve(); await store.close(); cleanup(directory) }
})

test('explicit close revokes synchronously before a queued write can complete', { skip: !native }, async () => {
  const directory = temp(), gate = deferred(), entered = deferred()
  let pause = false
  const store = await openWorkflowStore(options(directory, { onDurableStep: async step => { if (pause && step === 'component-flushed') { entered.resolve(); await gate.promise } } }))
  try {
    const attempt = await store.beginAttempt(binding)
    await store.publish(attempt, checkpoint('prefix'))
    pause = true
    const writing = store.publish(attempt, checkpoint('late')).then(() => 'accepted', error => error.code)
    await entered.promise
    const closed = store.close()
    await assert.rejects(store.appendJournal(attempt, { event: 'late' }), { code: 'revoked' })
    gate.resolve(); await closed
    assert.equal(await writing, 'revoked')
    const view = readWorkflowStore(options(directory), binding)
    assert.equal(view.status, 'verified')
    if (view.status === 'verified') assert.deepEqual(view.components.at(-1)?.payload, { text: 'prefix' })
  } finally { gate.resolve(); await store.close(); cleanup(directory) }
})

test('two native hidden processes contend; normal close and exact crash release the real listener', { skip: !native }, async () => {
  const directory = temp()
  const owner = worker(directory)
  let contender: ReturnType<typeof worker> | undefined
  try {
    assert.deepEqual(await owner.message, { state: 'owner' })
    contender = worker(directory)
    assert.deepEqual(await contender.message, { state: 'rejected', code: 'owner-unavailable' })
    await contender.exit
    owner.child.send('close')
    await owner.exit
    const next = worker(directory)
    assert.deepEqual(await next.message, { state: 'owner' })
    next.child.kill()
    await next.exit
    const recovered = await openWorkflowStore(options(directory))
    await recovered.close()
  } finally {
    if (owner.child.exitCode === null && !owner.child.killed) { owner.child.kill(); await owner.exit }
    if (contender && contender.child.exitCode === null && !contender.child.killed) { contender.child.kill(); await contender.exit }
    cleanup(directory)
  }
})

test('case, trailing separator and junction aliases cannot obtain a second owner', { skip: !native }, async () => {
  const directory = temp(), aliasParent = temp(), alias = path.join(aliasParent, 'root-junction')
  const store = await openWorkflowStore(options(directory))
  try {
    fs.symlinkSync(directory, alias, 'junction')
    for (const storageDirectory of [directory.toUpperCase(), directory + path.sep, alias]) await assert.rejects(openWorkflowStore({ storageDirectory, validators }), { code: 'owner-unavailable' })
    fs.unlinkSync(alias)
  } finally { await store.close(); if (fs.existsSync(alias)) fs.unlinkSync(alias); cleanup(directory); cleanup(aliasParent) }
})

for (const step of ['owner-marker-opened', 'owner-marker-flushed', 'attempt-marker-opened', 'attempt-marker-flushed', 'component-opened', 'component-flushed', 'journal-opened', 'journal-flushed', 'manifest-opened', 'manifest-flushed'] as const) {
  test(`real native process exits at ${step}; only complete bytes are usable`, { skip: !native }, async () => {
    const directory = temp()
    const mode = step.startsWith('owner-') ? 'crash-open' : step.startsWith('attempt-') ? 'crash-attempt' : step.startsWith('journal-') ? 'crash-journal' : 'crash'
    const child = worker(directory, mode, step)
    try {
      const [code] = await child.exit
      assert.equal(code, 86, child.error())
      const view = readWorkflowStore(options(directory), binding)
      if (['owner-marker-opened', 'attempt-marker-opened', 'journal-opened', 'manifest-opened'].includes(step)) {
        assert.equal(view.status, 'unavailable')
        await assert.rejects(openWorkflowStore(options(directory)))
      } else if (step === 'owner-marker-flushed') {
        assert.equal(view.status, 'absent')
      } else {
        assert.equal(view.status, 'verified')
        if (view.status !== 'verified') return
        if (step === 'attempt-marker-flushed') { assert.equal(view.manifest, null); assert.equal(view.journal.length, 0) }
        else {
          assert.deepEqual(view.components.at(-1)?.payload, { text: step === 'manifest-flushed' ? 'next' : 'prefix' })
          assert.equal(view.journal.length, step === 'journal-flushed' ? 2 : 1)
        }
      }
    } finally { if (child.child.exitCode === null && !child.child.killed) { child.child.kill(); await child.exit }; cleanup(directory) }
  })
}

test('old epoch injection after a new owner does not change its frozen current prefix', { skip: !native }, async () => {
  const directory = temp()
  let store = await openWorkflowStore(options(directory))
  try {
    const first = await store.beginAttempt(binding)
    await store.publish(first, checkpoint('frozen-prefix'))
    const oldManifestPath = record(directory, 'm-')
    const original = JSON.parse(fs.readFileSync(oldManifestPath, 'utf8'))
    await store.close()
    store = await openWorkflowStore(options(directory))
    const second = await store.beginAttempt(binding)
    // A byte-valid stale commit arrives in the old owner's directory after carry-forward.
    const injected = { ...original, sequence: 2, parent: { id: 'm-000000000001', producingEpoch: original.producingEpoch, byteLength: fs.statSync(oldManifestPath).size, sha256: hash(fs.readFileSync(oldManifestPath)) } }
    fs.writeFileSync(path.join(path.dirname(oldManifestPath), 'm-000000000002.json'), JSON.stringify(injected), { flag: 'wx' })
    let view = store.read(binding)
    assert.equal(view.status, 'verified')
    if (view.status === 'verified') assert.equal(view.manifest?.sequence, 1)
    await store.publish(second, checkpoint('current-owner'))
    view = store.read(binding)
    assert.equal(view.status, 'verified')
    if (view.status === 'verified') { assert.equal(view.manifest?.producingEpoch.owner, 2); assert.deepEqual(view.components.at(-1)?.payload, { text: 'current-owner' }) }
  } finally { await store.close(); cleanup(directory) }
})

for (const corruption of ['component-hash', 'component-missing', 'component-identity', 'component-schema', 'manifest-torn', 'attempt-torn', 'owner-torn', 'owner-future'] as const) {
  test(`reader fails closed for ${corruption} without partial state`, { skip: !native }, async () => {
    const directory = temp(), store = await openWorkflowStore(options(directory))
    try {
      const attempt = await store.beginAttempt(binding)
      await store.publish(attempt, checkpoint('original'))
      if (corruption.startsWith('component-')) {
        const manifestPath = record(directory, 'm-'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const componentPath = path.join(path.dirname(manifestPath), manifest.components[0].id + '.json')
        if (corruption === 'component-missing') fs.unlinkSync(componentPath)
        else if (corruption === 'component-hash') fs.appendFileSync(componentPath, ' ')
        else {
          const component = JSON.parse(fs.readFileSync(componentPath, 'utf8'))
          if (corruption === 'component-identity') component.binding.projectId = 'another-project'
          else component.schemaId = 'unapproved-v9'
          const bytes = JSON.stringify(component)
          fs.writeFileSync(componentPath, bytes)
          manifest.components[0].sha256 = hash(bytes); manifest.components[0].byteLength = Buffer.byteLength(bytes)
          fs.writeFileSync(manifestPath, JSON.stringify(manifest))
        }
      } else if (corruption === 'manifest-torn') fs.writeFileSync(record(directory, 'm-'), '{')
      else if (corruption === 'attempt-torn') fs.writeFileSync(record(directory, 'e-'), '{')
      else if (corruption === 'owner-torn') fs.writeFileSync(path.join(storeRoot(directory), 'epochs', 'o-000000000002.json'), '')
      else fs.writeFileSync(path.join(storeRoot(directory), 'epochs', 'o-000000000999.json'), '{}')
      assert.equal(store.read(binding).status, 'unavailable')
      await assert.rejects(store.publish(attempt, checkpoint('must-not-publish')))
    } finally { await store.close(); cleanup(directory) }
  })
}

test('quotas reserve all transaction bytes first, count pending/control files and never overwrite a prefix', { skip: !native }, async () => {
  const directory = temp()
  const store = await openWorkflowStore(options(directory, { limits: { runBytes: 7000, aggregateBytes: 10000 } }))
  try {
    const attempt = await store.beginAttempt(binding)
    await store.publish(attempt, checkpoint('prefix'))
    const before = files(storeRoot(directory)).map(file => [file, fs.readFileSync(file)] as const)
    await assert.rejects(store.publish(attempt, checkpoint('x'.repeat(6500))), { code: 'capacity-exhausted' })
    assert.equal(files(storeRoot(directory)).length, before.length)
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes)
    const pending = path.join(storeRoot(directory), 'pending.tmp')
    const pendingBytes = 10000 - before.reduce((sum, [, bytes]) => sum + bytes.length, 0) - 1
    assert.ok(pendingBytes > 0)
    fs.writeFileSync(pending, 'p'.repeat(pendingBytes))
    await assert.rejects(store.publish(attempt, checkpoint('next')), { code: 'capacity-exhausted' })
    assert.equal(store.read(binding).status, 'verified')
    assert.equal(fs.statSync(pending).size, pendingBytes)
  } finally { await store.close(); cleanup(directory) }
  const invalidDirectory = temp()
  try { await assert.rejects(openWorkflowStore(options(invalidDirectory, { limits: { runBytes: WORKFLOW_STORE_MAXIMA.runBytes + 1 } })), { code: 'invalid-input' }) } finally { cleanup(invalidDirectory) }
})

test('validator and explicit payload policy are mandatory program capabilities', { skip: !native }, async () => {
  const directory = temp()
  let store = await openWorkflowStore(options(directory))
  try {
    const attempt = await store.beginAttempt(binding)
    await assert.rejects(store.publish(attempt, { stage: 'generating', components: [{ kind: 'ledger', payload: { arbitraryJson: true } }] }))
    await assert.rejects(store.publish(attempt, { stage: 'generating', components: [{ kind: 'recorded-visible-response', payload: { text: 'visible' } }] }))
    assert.equal(files(storeRoot(directory)).filter(file => path.basename(file).startsWith('c-')).length, 0)
    await store.close()
    const policy = createWorkflowVisiblePayloadPolicy(payload => object(payload) && payload.text === 'visible')
    await assert.rejects(openWorkflowStore(options(directory, { visiblePayloadPolicy: { ...policy } })), { code: 'invalid-input' })
    store = await openWorkflowStore(options(directory, { visiblePayloadPolicy: policy }))
    const next = await store.beginAttempt(binding)
    await store.publish(next, { stage: 'generating', components: [{ kind: 'recorded-visible-response', payload: { text: 'visible' } }] })
    assert.equal(store.read(binding).status, 'verified')
    assert.equal(readWorkflowStore(options(directory), binding).status, 'unavailable')
  } finally { await store.close(); cleanup(directory) }
})

test('filesystem links, replacement directories and caller-controlled paths fail closed', { skip: !native }, async () => {
  const directory = temp(), outside = temp()
  const store = await openWorkflowStore(options(directory))
  try {
    const attempt = await store.beginAttempt(binding)
    await store.publish(attempt, checkpoint('prefix'))
    const dataDirectory = path.dirname(record(directory, 'm-'))
    const moved = dataDirectory + '-preserved'
    fs.renameSync(dataDirectory, moved)
    fs.symlinkSync(outside, dataDirectory, 'junction')
    await assert.rejects(store.publish(attempt, checkpoint('unsafe')), { code: 'unsafe-path' })
    assert.equal(store.read(binding).status, 'unavailable')
    assert.equal(fs.readdirSync(outside).length, 0)
    fs.unlinkSync(dataDirectory)
    fs.renameSync(moved, dataDirectory)
    const target = path.join(outside, 'must-not-capture.json')
    fs.writeFileSync(target, '{"private":true}')
    fs.linkSync(target, path.join(storeRoot(directory), 'foreign.json'))
    assert.equal(store.read(binding).status, 'unavailable')
    fs.unlinkSync(path.join(storeRoot(directory), 'foreign.json'))
    await assert.rejects(store.beginAttempt({ ...binding, logicalRunId: '../escape' }))
  } finally { await store.close(); cleanup(directory); cleanup(outside) }
})

test('injected disk failure after component flush publishes nothing and preserves the verified prefix', { skip: !native }, async () => {
  const directory = temp()
  let fail = false
  const store = await openWorkflowStore(options(directory, { onDurableStep(step: WorkflowStoreStep) { if (fail && step === 'component-flushed') throw new Error('private upstream detail') } }))
  try {
    const attempt = await store.beginAttempt(binding)
    await store.publish(attempt, checkpoint('prefix'))
    fail = true
    await assert.rejects(store.publish(attempt, checkpoint('failed')), { code: 'disk-failure', message: 'workflow-store:disk-failure' })
    const view = store.read(binding)
    assert.equal(view.status, 'verified')
    if (view.status === 'verified') assert.deepEqual(view.components.at(-1)?.payload, { text: 'prefix' })
  } finally { await store.close(); cleanup(directory) }
})


test('journal payload builders receive a serialized logical position and genuine sync assertion is repeatable', { skip: !native }, async () => {
  const directory = temp(), store = await openWorkflowStore(options(directory))
  try {
    const attempt = await store.beginAttempt(binding)
    const positions: number[] = []
    const first = store.appendJournal(attempt, context => {
      positions.push(context.sequence)
      assert.equal(context.previous, null)
      assert.deepEqual(context.producingEpoch, store.assertCurrent(attempt).epoch)
      assert.deepEqual(store.assertCurrent(attempt), store.assertCurrent(attempt))
      return { event: 'reservation', logicalHash: hash(String(context.sequence)), state: { held: 100, journalSequence: context.sequence } }
    })
    const second = store.appendJournal(attempt, context => {
      positions.push(context.sequence)
      assert.equal(context.previous?.id, 'j-000000000001')
      return { event: 'intent', logicalHash: hash(String(context.sequence)), state: { held: 100, journalSequence: context.sequence } }
    })
    const [one, two] = await Promise.all([first, second])
    assert.deepEqual(positions, [1, 2])
    assert.equal(one.sequence, 1); assert.equal(two.sequence, 2)
    assert.notEqual(two.reference.sha256, hash('2'))
    await assert.rejects(store.appendJournal(attempt, async () => ({ event: 'not-sync' })), { code: 'invalid-input' })
    store.finishAttempt(attempt)
    assert.throws(() => store.assertCurrent(attempt), { code: 'attempt-inactive' })
  } finally { await store.close(); cleanup(directory) }
})

test('unexpected root replacement and future attempt epoch invalidate the synchronous assertion', { skip: !native }, async () => {
  const directory = temp(), store = await openWorkflowStore(options(directory))
  try {
    const attempt = await store.beginAttempt(binding)
    const markerPath = record(directory, 'e-'), marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const future = { ...marker, producingEpoch: { ...marker.producingEpoch, attempt: 3 } }
    fs.writeFileSync(path.join(path.dirname(markerPath), 'e-000000000001-000000000003.json'), JSON.stringify(future))
    assert.throws(() => store.assertCurrent(attempt))
    fs.unlinkSync(path.join(path.dirname(markerPath), 'e-000000000001-000000000003.json'))
    assert.throws(() => store.assertCurrent(attempt), { code: 'attempt-inactive' })
    const current = await store.beginAttempt(binding)
    const root = storeRoot(directory), preserved = root + '-preserved'
    fs.renameSync(root, preserved); fs.mkdirSync(root)
    assert.throws(() => store.assertCurrent(current), { code: 'unsafe-path' })
    fs.rmdirSync(root); fs.renameSync(preserved, root)
    assert.throws(() => store.assertCurrent(current), { code: 'revoked' })
  } finally { await store.close(); cleanup(directory) }
})

test('per-kind and control bounds reject before opening payload files; scan exhaustion is explicit', { skip: !native }, async () => {
  const directory = temp()
  const store = await openWorkflowStore(options(directory, { limits: { componentBytes: { result: 768 }, maxEntries: 32 } }))
  try {
    const attempt = await store.beginAttempt(binding)
    const before = files(storeRoot(directory)).length
    await assert.rejects(store.publish(attempt, { stage: 'generating', components: [{ kind: 'result', payload: { text: 'x'.repeat(900) } }] }), { code: 'capacity-exhausted' })
    assert.equal(files(storeRoot(directory)).length, before)
    await assert.rejects(store.publish(attempt, { stage: 'generating', components: [{ kind: 'prompt' as 'result', payload: { text: 'synthetic' } }] }), { code: 'invalid-input' })
    for (let index = 0; index < 32; index++) fs.writeFileSync(path.join(storeRoot(directory), `pending-${index}.tmp`), '')
    await assert.rejects(store.publish(attempt, { stage: 'generating', components: [{ kind: 'result', payload: { text: 'small' } }] }), { code: 'capacity-exhausted' })
    assert.equal(readWorkflowStore(options(directory, { limits: { maxEntries: 32 } }), binding).status, 'unavailable')
  } finally { await store.close(); cleanup(directory) }
  const controlDirectory = temp()
  try {
    await assert.rejects(openWorkflowStore(options(controlDirectory, { limits: { controlBytes: 16 } })), { code: 'capacity-exhausted' })
    assert.equal(files(storeRoot(controlDirectory)).length, 0)
  } finally { cleanup(controlDirectory) }
})

test('newest attempt marker injected during an await fences out the old publication irreversibly', { skip: !native }, async () => {
  const directory = temp(), gate = deferred(), entered = deferred()
  let pause = false
  const store = await openWorkflowStore(options(directory, { onDurableStep: async step => { if (pause && step === 'component-flushed') { entered.resolve(); await gate.promise } } }))
  try {
    const attempt = await store.beginAttempt(binding)
    await store.publish(attempt, checkpoint('prefix'))
    const markerPath = record(directory, 'e-')
    pause = true
    const writing = store.publish(attempt, checkpoint('stale')).then(() => 'accepted', error => error.code)
    await entered.promise
    const future = path.join(path.dirname(markerPath), 'e-000000000001-000000000002.json')
    fs.writeFileSync(future, '', { flag: 'wx' })
    gate.resolve()
    assert.equal(await writing, 'attempt-inactive')
    assert.equal(files(storeRoot(directory)).filter(file => path.basename(file).startsWith('m-')).length, 1)
    assert.equal(store.read(binding).status, 'unavailable')
    fs.unlinkSync(future)
    assert.throws(() => store.assertCurrent(attempt), { code: 'attempt-inactive' })
    const view = store.read(binding)
    assert.equal(view.status, 'verified')
    if (view.status === 'verified') assert.deepEqual(view.components.at(-1)?.payload, { text: 'prefix' })
  } finally { gate.resolve(); await store.close(); cleanup(directory) }
})

test('missing component in a parent commit invalidates the entire committed set', { skip: !native }, async () => {
  const directory = temp(), store = await openWorkflowStore(options(directory))
  try {
    const attempt = await store.beginAttempt(binding)
    const prior = await store.publish(attempt, checkpoint('first'))
    const previousDirectory = path.dirname(record(directory, 'm-'))
    await store.publish(attempt, checkpoint('latest'))
    fs.unlinkSync(path.join(previousDirectory, prior.components[0].id + '.json'))
    assert.equal(store.read(binding).status, 'unavailable')
    await assert.rejects(store.appendJournal(attempt, { event: 'must-not-admit' }))
  } finally { await store.close(); cleanup(directory) }
})

for (const stage of ['completed', 'cancelled', 'failed'] as const) {
  test(`committed ${stage} manifest fences queued old work and permits a distinct recovery attempt`, { skip: !native }, async () => {
    const directory = temp(), store = await openWorkflowStore(options(directory))
    try {
      const attempt = await store.beginAttempt(binding)
      const terminal = store.publish(attempt, { ...checkpoint('terminal-prefix'), stage })
      const queuedJournal = store.appendJournal(attempt, { event: 'late-intent' }).then(() => 'accepted', error => error.code)
      const queuedPublish = store.publish(attempt, checkpoint('late-result')).then(() => 'accepted', error => error.code)
      const committed = await terminal
      assert.equal(committed.stage, stage)
      const before = files(storeRoot(directory)).map(filename => [filename, fs.readFileSync(filename)] as const)
      assert.equal(await queuedJournal, 'attempt-inactive')
      assert.equal(await queuedPublish, 'attempt-inactive')
      assert.throws(() => store.assertCurrent(attempt), { code: 'attempt-inactive' })
      await assert.rejects(store.appendJournal(attempt, { event: 'after-terminal' }), { code: 'attempt-inactive' })
      assert.equal(files(storeRoot(directory)).length, before.length)
      for (const [filename, bytes] of before) assert.deepEqual(fs.readFileSync(filename), bytes)
      assert.equal(store.finishAttempt(attempt), true)
      const next = await store.beginAttempt(binding)
      assert.notEqual(store.assertCurrent(next).epoch.attemptId, committed.producingEpoch.attemptId)
      await store.appendJournal(next, { event: 'new-physical-attempt' })
      await store.publish(next, checkpoint('recovery'))
      const view = store.read(binding)
      assert.equal(view.status, 'verified')
      if (view.status === 'verified') assert.deepEqual(view.components.at(-1)?.payload, { text: 'recovery' })
    } finally { await store.close(); cleanup(directory) }
  })
}
