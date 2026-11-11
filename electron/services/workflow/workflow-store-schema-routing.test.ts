import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- direct Node test runner.
import { openWorkflowStore, readWorkflowStore, createWorkflowVisiblePayloadPolicy } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node test runner.
import type { WorkflowStore, WorkflowStoreOptions, WorkflowComponentValidators, WorkflowComponentKind, WorkflowRunBinding } from './workflow-store.ts'

const native = process.platform === 'win32'
const binding: WorkflowRunBinding = Object.freeze({ version: 1, logicalRunId: 'schema-run-01', projectId: 'project-01', snapshotId: 'snapshot-01', runSpecHash: 'a'.repeat(64), configHash: 'b'.repeat(64), schemaVersion: 'workflow-v1', policyVersion: 'policy-v1' })
const anotherBinding = Object.freeze({ ...binding, logicalRunId: 'schema-run-02' })
const kinds = ['ledger', 'critical-journal', 'result', 'recorded-visible-response'] as const
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function validators(version: number): WorkflowComponentValidators {
  return Object.fromEntries(kinds.map(kind => [kind, { schemaId: kind + '-schema-' + version, validate: (value: unknown) => object(value) && value.version === version && typeof value.text === 'string' }]))
}
const v1 = validators(1), v2 = validators(2)
function options(directory: string, current = v2, historical = v1, extra: Partial<WorkflowStoreOptions> = {}): WorkflowStoreOptions {
  return { storageDirectory: directory, validators: current, historicalValidators: Object.fromEntries(Object.entries(historical).map(([kind, validator]) => [kind, [validator]])), ...extra }
}
function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-schema-routing-')) }
function cleanup(directory: string): void {
  const resolved = path.resolve(directory)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('repoprep-schema-routing-'))
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false)
  fs.rmSync(resolved, { recursive: true, force: true })
  assert.equal(fs.existsSync(resolved), false)
}
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false)
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? files(filename) : [filename]
  }).sort()
}
function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function snapshot(directory: string): unknown { return files(directory).map(filename => [path.relative(directory, filename), hash(fs.readFileSync(filename))]) }
const payload = (version: number) => ({ version, text: 'synthetic-' + version })
const checkpoint = (version: number) => ({ stage: 'generating' as const, components: [{ kind: 'ledger' as const, payload: payload(version) }, { kind: 'result' as const, payload: payload(version) }] })
async function seed(directory: string, visible = false): Promise<void> {
  const store = await openWorkflowStore({ storageDirectory: directory, validators: v1, ...(visible ? { visiblePayloadPolicy: createWorkflowVisiblePayloadPolicy(() => true) } : {}) })
  try {
    const attempt = await store.beginAttempt(binding)
    await store.appendJournal(attempt, payload(1))
    await store.publish(attempt, visible ? { stage: 'generating', components: [{ kind: 'recorded-visible-response', payload: payload(1) }] } : checkpoint(1))
  } finally { await store.close() }
}
function verified(store: WorkflowStore, run = binding) {
  const view = store.read(run)
  assert.equal(view.status, 'verified')
  if (view.status !== 'verified') throw new Error('expected-verified')
  return view
}

test('historical routing carries exact old schemas while new runs write only the current schema; incompatible resume and downgrade are blocked', { skip: !native }, async () => {
  const directory = temp()
  let store: WorkflowStore | undefined
  try {
    await seed(directory)
    const beforeOpen = snapshot(directory)
    assert.equal(readWorkflowStore({ storageDirectory: directory, validators: v2 }, binding).status, 'unavailable')
    await assert.rejects(openWorkflowStore({ storageDirectory: directory, validators: v2 }), { code: 'unavailable' })
    assert.deepEqual(snapshot(directory), beforeOpen)
    store = await openWorkflowStore(options(directory))
    const old = verified(store)
    assert.deepEqual(old.components.map(item => item.payload), [payload(1), payload(1)])
    assert.equal(old.journal[0].schemaId, 'critical-journal-schema-1')
    const beforeResume = snapshot(directory)
    await assert.rejects(store.beginAttempt(binding), { code: 'unavailable' })
    assert.deepEqual(snapshot(directory), beforeResume)
    const attempt = await store.beginAttempt(anotherBinding)
    const beforeInvalid = snapshot(directory)
    await assert.rejects(store.appendJournal(attempt, payload(1)), { code: 'unavailable' })
    await assert.rejects(store.publish(attempt, checkpoint(1)), { code: 'unavailable' })
    assert.deepEqual(snapshot(directory), beforeInvalid)
    await store.appendJournal(attempt, payload(2))
    await store.publish(attempt, checkpoint(2))
    assert.ok(verified(store, anotherBinding).components.every(item => item.reference.schemaId.endsWith('-2')))
    await store.close(); store = undefined
    store = await openWorkflowStore(options(directory, v1, v2))
    assert.equal(verified(store).journal.length, 1)
    assert.equal(verified(store, anotherBinding).journal[0].schemaId, 'critical-journal-schema-2')
    const beforeDowngrade = snapshot(directory)
    await assert.rejects(store.beginAttempt(anotherBinding), { code: 'unavailable' })
    assert.deepEqual(snapshot(directory), beforeDowngrade)
    const resumed = await store.beginAttempt(binding)
    await store.appendJournal(resumed, payload(1))
    await store.publish(resumed, checkpoint(1))
    assert.equal(verified(store).journal.length, 2)
  } finally { await store?.close(); cleanup(directory) }
})

test('historical routing captures descriptors, arrays, options and current callbacks before the first await', { skip: !native }, async () => {
  const directory = temp()
  let store: WorkflowStore | undefined
  try {
    await seed(directory)
    const current = { ...v2, ledger: { ...v2.ledger! } }, historicalEntry = { ...v1.ledger! }
    const historic = { ledger: [historicalEntry, ...Array.from({ length: 7 }, (_, index) => ({ schemaId: 'unused-history-' + index, validate: () => false }))], result: [v1.result!], 'critical-journal': [v1['critical-journal']!] }
    const config = { storageDirectory: directory, validators: current, historicalValidators: historic }
    const opening = openWorkflowStore(config)
    config.storageDirectory = directory + '-unowned'
    current.ledger.schemaId = 'changed-current'
    current.ledger.validate = () => false
    historicalEntry.schemaId = 'changed-historical'
    historicalEntry.validate = () => false
    historic.ledger.splice(0)
    store = await opening
    assert.equal(verified(store).components[0].reference.schemaId, 'ledger-schema-1')
    const attempt = await store.beginAttempt(anotherBinding)
    await store.publish(attempt, checkpoint(2))
    assert.equal(verified(store, anotherBinding).components[0].reference.schemaId, 'ledger-schema-2')
    assert.equal(fs.existsSync(directory + '-unowned'), false)
  } finally { await store?.close(); cleanup(directory) }
})

test('historical routing rejects malformed captured configuration without invoking accessors or proxy traps or touching disk', async () => {
  const directory = temp()
  let invoked = 0
  const base = () => ({ storageDirectory: directory, validators: v2 })
  const trap = () => { invoked++; throw new Error('must-not-invoke-proxy') }
  const proxied = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  const accessor = Object.defineProperty({}, 'schemaId', { enumerable: true, get() { invoked++; return 'historical' } })
  const arrayAccessor = Object.defineProperty([v1.ledger!], '0', { enumerable: true, get() { invoked++; return v1.ledger } })
  const cases: unknown[] = [
    { ...base(), unknown: true },
    Object.defineProperty(base(), 'storageDirectory', { enumerable: true, get() { invoked++; return directory } }),
    proxied,
    { ...base(), validators: proxied },
    { ...base(), validators: { unknown: v2.ledger } },
    { ...base(), validators: { ledger: accessor } },
    { ...base(), validators: { ledger: { ...v2.ledger, extra: true } } },
    { ...base(), validators: { ledger: { schemaId: 'bad id', validate: () => true } } },
    { ...base(), validators: { ledger: { schemaId: 'current', validate: new Proxy(() => true, { apply: trap }) } } },
    { ...base(), historicalValidators: proxied },
    { ...base(), historicalValidators: { unknown: [v1.ledger] } },
    { ...base(), historicalValidators: { ledger: proxied } },
    { ...base(), historicalValidators: { ledger: new Proxy([v1.ledger], { get: trap, getPrototypeOf: trap, ownKeys: trap }) } },
    { ...base(), historicalValidators: { ledger: [] } },
    { ...base(), historicalValidators: { ledger: new Array(1) } },
    { ...base(), historicalValidators: { ledger: arrayAccessor } },
    { ...base(), historicalValidators: { ledger: [v2.ledger] } },
    { ...base(), historicalValidators: { ledger: [v1.ledger, v1.ledger] } },
    { ...base(), historicalValidators: { ledger: Array.from({ length: 9 }, (_, index) => ({ schemaId: 'history-' + index, validate: () => true })) } },
    { ...base(), validators: {}, historicalValidators: { ledger: [v1.ledger] } },
    { ...base(), historicalValidators: { ledger: [{ schemaId: 'async', validate: async () => true }] } },
    { ...base(), historicalValidators: { ledger: [{ schemaId: 'generator', validate: function* () { yield true } }] } },
    { ...base(), historicalValidators: { ledger: [{ schemaId: 'callback', validate: null }] } },
    { ...base(), limits: proxied },
    { ...base(), limits: { componentBytes: { unknown: 1 } } },
    { ...base(), visiblePayloadPolicy: {} },
    { ...base(), onDurableStep: 'callback' }
  ]
  try {
    for (let index = 0; index < cases.length; index++) {
      await assert.rejects(openWorkflowStore(cases[index] as WorkflowStoreOptions), { code: 'invalid-input' }, 'case ' + index)
      assert.deepEqual(readWorkflowStore(cases[index] as WorkflowStoreOptions, binding), { status: 'unavailable', code: 'invalid-input' }, 'read case ' + index)
    }
    assert.equal(invoked, 0)
    assert.deepEqual(files(directory), [])
  } finally { cleanup(directory) }
})

test('historical routing uses only the exact matching ID and rejects throwing, nonboolean and promise results without fallback', { skip: !native }, async () => {
  const directory = temp()
  try {
    await seed(directory)
    for (const validate of [() => false, () => 1, () => 'true', () => ({ then() { throw new Error('then-must-not-run') } }), () => Promise.resolve(true), () => Promise.reject(new Error('synthetic-rejection')), () => { throw new Error('synthetic-validator-failure') }]) {
      let fallbackCalls = 0
      const config = options(directory, v2, v1, { historicalValidators: {
        ledger: [{ schemaId: 'ledger-schema-1', validate: validate as (value: unknown) => boolean }, { schemaId: 'other-historical', validate: () => { fallbackCalls++; return true } }],
        result: [v1.result!], 'critical-journal': [v1['critical-journal']!]
      } })
      assert.equal(readWorkflowStore(config, binding).status, 'unavailable')
      const before = snapshot(directory)
      await assert.rejects(openWorkflowStore(config), { code: 'unavailable' })
      assert.deepEqual(snapshot(directory), before)
      assert.equal(fallbackCalls, 0)
    }
    let guessed = 0
    const config = options(directory, v2, v1, { historicalValidators: { ledger: [{ schemaId: 'ledger-schema-1-prefix-guess', validate: () => { guessed++; return true } }], result: [v1.result!], 'critical-journal': [v1['critical-journal']!] } })
    assert.equal(readWorkflowStore(config, binding).status, 'unavailable')
    assert.equal(guessed, 0)
  } finally { cleanup(directory) }
})

test('historical visible-response decoding still requires the genuine synchronous payload policy', { skip: !native }, async () => {
  const directory = temp()
  let store: WorkflowStore | undefined
  try {
    await seed(directory, true)
    const config = options(directory)
    assert.equal(readWorkflowStore(config, binding).status, 'unavailable')
    for (const validate of [() => false, () => 1, () => Promise.resolve(true)]) {
      const policy = createWorkflowVisiblePayloadPolicy(validate as (value: unknown) => boolean)
      assert.equal(readWorkflowStore({ ...config, visiblePayloadPolicy: policy }, binding).status, 'unavailable')
    }
    const policy = createWorkflowVisiblePayloadPolicy(value => object(value) && value.version === 1)
    store = await openWorkflowStore({ ...config, visiblePayloadPolicy: policy })
    assert.equal(verified(store).components[0].reference.kind, 'recorded-visible-response')
  } finally { await store?.close(); cleanup(directory) }
})

// Modify a genuine committed latest record and repair its direct hash reference. The
// unchanged ancestry stays valid, so a schema conflict cannot hide behind hash rejection.
function replaceLatestSchema(directory: string, kind: 'ledger' | 'critical-journal'): void {
  const all = files(directory)
  const prefix = kind === 'ledger' ? 'm-' : 'j-'
  const latest = all.filter(filename => path.basename(filename).startsWith(prefix)).sort().at(-1)!
  const record = JSON.parse(fs.readFileSync(latest, 'utf8'))
  if (kind === 'critical-journal') { record.schemaId = v2[kind]!.schemaId; record.payload = payload(2) }
  else {
    const ref = record.components.find((item: { kind: string }) => item.kind === kind)
    const componentFile = all.find(filename => path.basename(filename) === ref.id + '.json')!
    const component = JSON.parse(fs.readFileSync(componentFile, 'utf8'))
    component.schemaId = v2[kind]!.schemaId; component.payload = payload(2)
    const bytes = Buffer.from(JSON.stringify(component))
    fs.writeFileSync(componentFile, bytes)
    ref.schemaId = component.schemaId; ref.byteLength = bytes.length; ref.sha256 = hash(bytes)
  }
  const bytes = Buffer.from(JSON.stringify(record))
  fs.writeFileSync(latest, bytes)
  if (kind === 'critical-journal') {
    for (const manifestFile of all.filter(filename => path.basename(filename).startsWith('m-'))) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (manifest.journalPosition?.id === path.basename(latest, '.json')) {
        manifest.journalPosition.byteLength = bytes.length; manifest.journalPosition.sha256 = hash(bytes)
        fs.writeFileSync(manifestFile, JSON.stringify(manifest))
      }
    }
  }
}
for (const kind of ['ledger', 'critical-journal'] as const) test('historical routing rejects hash-valid mixed ' + kind + ' schemas across attempt history', { skip: !native }, async () => {
  const directory = temp()
  let store: WorkflowStore | undefined
  try {
    await seed(directory)
    store = await openWorkflowStore({ storageDirectory: directory, validators: v1 })
    const attempt = await store.beginAttempt(binding)
    await store.appendJournal(attempt, payload(1))
    await store.publish(attempt, checkpoint(1))
    await store.close(); store = undefined
    assert.equal(readWorkflowStore(options(directory), binding).status, 'verified')
    replaceLatestSchema(directory, kind)
    const seen: number[] = []
    const current = { ...v2, [kind]: { schemaId: v2[kind]!.schemaId, validate: (value: unknown) => { if (object(value)) seen.push(value.version as number); return v2[kind]!.validate(value) } } }
    const config = options(directory, current)
    assert.equal(readWorkflowStore(config, binding).status, 'unavailable')
    if (kind === 'ledger') assert.equal(seen.length, 0, 'complete conflicting ancestry must reject before any component decoder')
    else assert.ok(seen.includes(2), 'new exact journal codec was checked before conflicting ancestry rejected')
    await assert.rejects(openWorkflowStore(config), { code: 'unavailable' })
  } finally { await store?.close(); cleanup(directory) }
})

test('historical routing pins kinds found only in older manifests before admitting any new attempt', { skip: !native }, async () => {
  const directory = temp()
  let store: WorkflowStore | undefined
  try {
    await seed(directory)
    store = await openWorkflowStore({ storageDirectory: directory, validators: v1 })
    const attempt = await store.beginAttempt(binding)
    await store.publish(attempt, { stage: 'generating', components: [{ kind: 'result', payload: payload(1) }] })
    await store.close(); store = undefined
    const current = { ...v1, ledger: v2.ledger! }
    store = await openWorkflowStore({ storageDirectory: directory, validators: current, historicalValidators: { ledger: [v1.ledger!] } })
    assert.deepEqual(verified(store).components.map(item => item.reference.kind), ['result'])
    const before = snapshot(directory)
    await assert.rejects(store.beginAttempt(binding), { code: 'unavailable' })
    assert.deepEqual(snapshot(directory), before)
  } finally { await store?.close(); cleanup(directory) }
})

for (const kind of ['ledger', 'critical-journal'] as const) test('historical routing rejects a replacement ' + kind + ' chain that hides an inherited schema', { skip: !native }, async () => {
  const directory = temp()
  let store: WorkflowStore | undefined
  try {
    store = await openWorkflowStore({ storageDirectory: directory, validators: v1 })
    for (let index = 0; index < 2; index++) {
      const attempt = await store.beginAttempt(binding)
      if (kind === 'ledger') await store.publish(attempt, { stage: 'generating', components: [{ kind, payload: payload(1) }] })
      else await store.appendJournal(attempt, payload(1))
      store.finishAttempt(attempt)
    }
    await store.close(); store = undefined
    assert.equal(readWorkflowStore(options(directory), binding).status, 'verified')
    replaceLatestSchema(directory, kind)
    const prefix = kind === 'ledger' ? 'm-' : 'j-'
    const latest = files(directory).filter(filename => path.basename(filename).startsWith(prefix)).sort().at(-1)!
    const record = JSON.parse(fs.readFileSync(latest, 'utf8'))
    record.sequence = 1
    if (kind === 'ledger') record.parent = null
    else record.previous = null
    fs.writeFileSync(latest, JSON.stringify(record))
    fs.renameSync(latest, path.join(path.dirname(latest), prefix + '000000000001.json'))
    // Every remaining reference is hash-valid. Only the inherited head is absent
    // from this attempted replacement chain.
    assert.equal(readWorkflowStore(options(directory), binding).status, 'unavailable')
    await assert.rejects(openWorkflowStore(options(directory)), { code: 'unavailable' })
  } finally { await store?.close(); cleanup(directory) }
})

test('historical routing rechecks active writes and rejects before a journal builder after a historical schema appears', { skip: !native }, async () => {
  const directory = temp()
  let store: WorkflowStore | undefined
  try {
    store = await openWorkflowStore(options(directory, v1, v2))
    const attempt = await store.beginAttempt(binding)
    await store.publish(attempt, { stage: 'generating', components: [{ kind: 'ledger', payload: payload(1) }] })
    replaceLatestSchema(directory, 'ledger')
    assert.equal(verified(store).components[0].reference.schemaId, 'ledger-schema-2')
    const before = snapshot(directory)
    let builderCalls = 0
    await assert.rejects(store.publish(attempt, { stage: 'generating', components: [{ kind: 'result', payload: payload(1) }] }), { code: 'unavailable' })
    await assert.rejects(store.appendJournal(attempt, () => { builderCalls++; return payload(1) }), { code: 'unavailable' })
    assert.equal(builderCalls, 0)
    assert.deepEqual(snapshot(directory), before)
  } finally { await store?.close(); cleanup(directory) }
})
