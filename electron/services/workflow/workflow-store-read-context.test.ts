import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { WorkflowStore, WorkflowStoreOptions, WorkflowRunBinding, WorkflowComponentReadContext, WorkflowComponentReadView } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests.
import { openWorkflowStore, readWorkflowStore, inspectWorkflowComponentReadContext, createWorkflowVisiblePayloadPolicy } from './workflow-store.ts'

const native = process.platform === 'win32'
const binding: WorkflowRunBinding = { version: 1, logicalRunId: 'read-context-run', projectId: 'project', snapshotId: 'snapshot', runSpecHash: 'a'.repeat(64), configHash: 'b'.repeat(64), schemaVersion: 'workflow-v1', policyVersion: 'policy-v1' }
const valid = (payload: unknown) => !!payload && typeof payload === 'object' && (payload as { v?: number }).v === 1
const validators = { ledger: { schemaId: 'ledger-v1', validate: valid }, result: { schemaId: 'result-v1', validate: valid }, 'critical-journal': { schemaId: 'journal-v1', validate: valid } }
function assertDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value); assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child, seen)
}
const checkpoint = { stage: 'investigating' as const, components: [{ kind: 'ledger' as const, payload: { v: 1 } }] }
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false)
    return entry.isDirectory() ? files(filename) : [filename]
  })
}
function nativeTest(name: string, run: (directory: string) => Promise<void>) {
  test(name, { skip: !native, timeout: 600_000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-read-context-'))
    let passed = false
    try { await run(directory); passed = true } finally {
      if (passed) {
        const absolute = path.resolve(directory)
        assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
        assert.ok(path.basename(absolute).startsWith('repoprep-read-context-'))
        assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false)
        const released = files(absolute).reduce((sum, file) => sum + fs.statSync(file).size, 0)
        fs.rmSync(absolute, { recursive: true }); assert.equal(fs.existsSync(absolute), false)
        t.diagnostic('Cleaned verified synthetic fixture bytes=' + released)
      } else t.diagnostic('FAILED fixture retained: ' + directory)
    }
  })
}
async function seed(directory: string, two = false) {
  const store = await openWorkflowStore({ storageDirectory: directory, validators })
  try {
    const attempt = await store.beginAttempt(binding)
    await store.appendJournal(attempt, { v: 1 })
    await store.publish(attempt, checkpoint)
    if (two) {
      await store.appendJournal(attempt, { v: 1 })
      await store.publish(attempt, { ...checkpoint, components: [...checkpoint.components, { kind: 'result', payload: { v: 1 } }] })
      await store.appendJournal(attempt, { v: 1 })
    }
  } finally { await store.close() }
}
function read(directory: string, validateRead: NonNullable<WorkflowStoreOptions['validators']['ledger']>['validateRead'], extra: Partial<WorkflowStoreOptions> = {}) {
  return readWorkflowStore({ storageDirectory: directory, validators: { ...validators, ledger: { ...validators.ledger, validateRead } }, ...extra }, binding)
}

nativeTest('contexts are empty callback-scoped tokens; exact containing manifests share one immutable fully verified journal view', async directory => {
  await seed(directory, true)
  const contexts: WorkflowComponentReadContext[] = [], views: WorkflowComponentReadView[] = []
  const result = read(directory, (_payload, context) => {
    contexts.push(context)
    assert.deepEqual(Reflect.ownKeys(context), []); assert.equal(Object.isFrozen(context), true)
    for (const fake of [{}, Object.freeze({ ...context }), Object.create(context), new Proxy(context, {})]) assert.throws(() => inspectWorkflowComponentReadContext(fake as WorkflowComponentReadContext), { code: 'invalid-input' })
    const view = inspectWorkflowComponentReadContext(context)
    assertDeepFrozen(view)
    assert.equal(view.component.kind, 'ledger'); assert.ok(view.manifest.components.includes(view.component))
    assert.deepEqual(view.binding, binding); assert.equal(view.journal.length, 3)
    assert.equal(Object.isFrozen(view), true); assert.equal(Object.isFrozen(view.journal), true)
    assert.equal(Object.isFrozen(view.journal[0].payload), true); assert.equal(Object.isFrozen(view.manifest.components), true)
    assert.throws(() => { (view.journal as unknown[]).push({}) }, TypeError)
    views.push(view)
    return true
  })
  assert.equal(result.status, 'verified'); assert.equal(views.length, 2)
  assert.equal(views[0].journal, views[1].journal)
  assert.equal(views[0].manifest.sequence, 2); assert.equal(views[1].manifest.sequence, 1)
  assert.equal(views[0].manifestReference.id, 'm-000000000002'); assert.equal(views[1].manifestReference.id, 'm-000000000001')
  for (const context of contexts) assert.throws(() => inspectWorkflowComponentReadContext(context), { code: 'invalid-input' })
  await Promise.resolve()
  for (const context of contexts) assert.throws(() => inspectWorkflowComponentReadContext(context), { code: 'invalid-input' })
})

nativeTest('read callback is exact-schema only, literal-true only and has no payload-validator fallback', async directory => {
  await seed(directory)
  let writes = 0
  for (const outcome of [false, 'true', undefined, Promise.resolve(true), Promise.reject(Error('synthetic-rejection'))]) {
    let retained: WorkflowComponentReadContext | undefined
    const view = readWorkflowStore({ storageDirectory: directory, validators: { ...validators, ledger: { schemaId: 'ledger-v1', validate() { writes++; return true }, validateRead(_payload, context) { retained = context; return outcome as boolean } } } }, binding)
    assert.equal(view.status, 'unavailable'); assert.ok(retained)
    assert.throws(() => inspectWorkflowComponentReadContext(retained!), { code: 'invalid-input' })
  }
  assert.equal(writes, 0)
  assert.equal(read(directory, () => { throw Error('synthetic-callback-error') }).status, 'unavailable')
  const legacy = { schemaId: 'ledger-v1', validate() { throw Error('no-read-fallback') }, validateRead: () => true }
  const historical = readWorkflowStore({ storageDirectory: directory, validators: { ...validators, ledger: { schemaId: 'ledger-v2', validate: () => false, validateRead: () => { throw Error('wrong-schema') } } }, historicalValidators: { ledger: [legacy] } }, binding)
  assert.equal(historical.status, 'verified')
  assert.equal(readWorkflowStore({ storageDirectory: directory, validators: { ...validators, ledger: { schemaId: 'ledger-v2', validate: () => true, validateRead: () => true } } }, binding).status, 'unavailable')
})

nativeTest('current write validator remains mandatory even when archival read accepts old data', async directory => {
  await seed(directory)
  let readCalls = 0, writeCalls = 0
  const store = await openWorkflowStore({ storageDirectory: directory, validators: { ...validators, ledger: { schemaId: 'ledger-v1', validate() { writeCalls++; return false }, validateRead() { readCalls++; return true } } } })
  try {
    assert.ok(readCalls > 0); assert.equal(writeCalls, 0)
    const attempt = await store.beginAttempt({ ...binding, logicalRunId: 'new-run' })
    const before = files(directory).length
    await assert.rejects(store.publish(attempt, checkpoint), { code: 'unavailable' })
    assert.equal(writeCalls, 1); assert.equal(files(directory).length, before)
  } finally { await store.close() }
})

nativeTest('descriptors and callbacks are captured before the first await', async directory => {
  await seed(directory)
  const descriptor = { ...validators.ledger, validateRead: () => true }
  const opening = openWorkflowStore({ storageDirectory: directory, validators: { ...validators, ledger: descriptor } })
  descriptor.validateRead = () => false; descriptor.validate = () => false
  const store = await opening
  try { assert.equal(store.readOwned(binding).status, 'verified') } finally { await store.close() }
})

nativeTest('complete manifest and inherited-head structure is checked before issuing any read context', async directory => {
  await seed(directory, true)
  const latest = files(directory).find(file => path.basename(file) === 'm-000000000002.json')!
  const raw = JSON.parse(fs.readFileSync(latest, 'utf8'))
  raw.parent.sha256 = 'f'.repeat(64)
  fs.writeFileSync(latest, JSON.stringify(raw))
  let invoked = 0
  assert.equal(read(directory, () => { invoked++; return true }).status, 'unavailable')
  assert.equal(invoked, 0)
})

nativeTest('journal codecs and current component size/entry ceilings precede component callbacks', async directory => {
  await seed(directory, true)
  let calls = 0
  assert.equal(read(directory, () => { calls++; return true }, { limits: { componentBytes: { ledger: 1 } } }).status, 'unavailable')
  assert.equal(read(directory, () => { calls++; return true }, { limits: { maxEntries: 1 } }).status, 'unavailable')
  assert.equal(calls, 0)
  const latestJournal = files(directory).find(file => path.basename(file) === 'j-000000000003.json')!
  const raw = JSON.parse(fs.readFileSync(latestJournal, 'utf8')); raw.payload = { v: 0 }
  fs.writeFileSync(latestJournal, JSON.stringify(raw))
  assert.equal(read(directory, () => { calls++; return true }).status, 'unavailable'); assert.equal(calls, 0)
})

nativeTest('recorded visible responses still require their genuine visible payload policy', async directory => {
  const store = await openWorkflowStore({ storageDirectory: directory, validators: { 'recorded-visible-response': { schemaId: 'visible-v1', validate: valid } }, visiblePayloadPolicy: createWorkflowVisiblePayloadPolicy(() => true) })
  try { const attempt = await store.beginAttempt(binding); await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'recorded-visible-response', payload: { v: 1 } }] }) } finally { await store.close() }
  for (const [policy, expected] of [[undefined, 'unavailable'], [createWorkflowVisiblePayloadPolicy(() => false), 'unavailable'], [createWorkflowVisiblePayloadPolicy(() => true), 'verified']] as const) {
    const result = readWorkflowStore({ storageDirectory: directory, validators: { 'recorded-visible-response': { schemaId: 'visible-v1', validate: () => false, validateRead: () => true } }, ...(policy ? { visiblePayloadPolicy: policy } : {}) }, binding)
    assert.equal(result.status, expected)
  }
})

nativeTest('owner revocation during a callback invalidates inspection and readOwned before a view escapes', async directory => {
  await seed(directory)
  let revoke = false, closed: Promise<void> | undefined, retained: WorkflowComponentReadContext | undefined
  let store: WorkflowStore
  store = await openWorkflowStore({ storageDirectory: directory, validators: { ...validators, ledger: { ...validators.ledger, validateRead(_payload, context) {
    if (revoke) { retained = context; closed = store.close(); assert.throws(() => inspectWorkflowComponentReadContext(context)); return true }
    return true
  } } } })
  try { revoke = true; assert.throws(() => store.readOwned(binding)); assert.ok(retained); assert.throws(() => inspectWorkflowComponentReadContext(retained!)) } finally { await closed; await store.close() }
})

test('read decoder configuration rejects critical-journal hooks, getters, proxies, async/generator functions and invalid descriptors without invoking them', async () => {
  let invoked = 0
  const trap = () => { invoked++; throw Error('must-not-invoke') }
  const directory = path.join(os.tmpdir(), 'repoprep-read-context-never-created-' + Date.now())
  const accessor = Object.defineProperty({ schemaId: 'ledger-v1', validate: valid }, 'validateRead', { enumerable: true, get: trap })
  const proxyCallback = new Proxy(() => true, { apply: trap })
  const cases = [
    { ...validators.ledger, validateRead: undefined }, { ...validators.ledger, validateRead: null }, accessor,
    new Proxy(validators.ledger, { ownKeys: trap, getPrototypeOf: trap }),
    { ...validators.ledger, validateRead: proxyCallback }, { ...validators.ledger, validateRead: async () => true }, { ...validators.ledger, validateRead: function* () { yield true } }
  ]
  for (const ledger of cases) await assert.rejects(openWorkflowStore({ storageDirectory: directory, validators: { ledger } } as unknown as WorkflowStoreOptions), { code: 'invalid-input' })
  for (const options of [
    { storageDirectory: directory, validators: { 'critical-journal': { ...validators['critical-journal'], validateRead: () => true } } },
    { storageDirectory: directory, validators, historicalValidators: { 'critical-journal': [{ schemaId: 'old', validate: valid, validateRead: () => true }] } }
  ]) await assert.rejects(openWorkflowStore(options), { code: 'invalid-input' })
  assert.equal(invoked, 0); assert.equal(fs.existsSync(directory), false)
})

for (const kind of ['ledger', 'critical-journal'] as const) nativeTest('hidden inherited ' + kind + ' head is rejected before any component context', async directory => {
  const store = await openWorkflowStore({ storageDirectory: directory, validators })
  try {
    for (let index = 0; index < 2; index++) {
      const attempt = await store.beginAttempt(binding)
      if (kind === 'critical-journal') await store.appendJournal(attempt, { v: 1 })
      await store.publish(attempt, checkpoint)
      store.finishAttempt(attempt)
    }
  } finally { await store.close() }
  const prefix = kind === 'ledger' ? 'm-' : 'j-'
  const latest = files(directory).filter(file => path.basename(file).startsWith(prefix)).sort().at(-1)!
  const record = JSON.parse(fs.readFileSync(latest, 'utf8'))
  record.sequence = 1
  if (kind === 'ledger') record.parent = null
  else record.previous = null
  fs.writeFileSync(latest, JSON.stringify(record))
  fs.renameSync(latest, path.join(path.dirname(latest), prefix + '000000000001.json'))
  let calls = 0
  assert.equal(read(directory, () => { calls++; return true }).status, 'unavailable')
  assert.equal(calls, 0)
})
