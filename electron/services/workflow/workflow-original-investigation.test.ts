import test, { before, after } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { OriginalInvestigationRun, OriginalInvestigationRunOptions } from './workflow-ledger-journal.ts'
import type { WorkflowStoreOptions } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createOriginalInvestigationRun, WORKFLOW_LEDGER_STATE_SCHEMA_ID } from './workflow-ledger-journal.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { readProjectContent } from '../project-content-reader.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createWorkflowSnapshot } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { readWorkflowStore } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerCriticalPayloadValidator, prepareLedgerCriticalSpec } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { validateLedgerState } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { hashModelMessages } from './model-journal.ts'

const secret = 'B03B1_SYNTHETIC_KEY_NEVER_PERSIST'
const profile = { id: 'b03b1-profile', name: 'Synthetic only', baseUrl: 'https://b03b1.invalid/v1', apiKey: secret, model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49_152, maxOutputTokens: 4_096 }
const source = 'export function calculate(value: number) {\n  if (value < 0) throw new Error("negative")\n  return value * 2\n}\n'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const commitment = (value: unknown) => hash(JSON.stringify(value))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
let fetchCalls = 0
const oldFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { fetchCalls++; throw Error('Network forbidden') } })
after(() => { globalThis.fetch = oldFetch; assert.equal(fetchCalls, 0) })
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false)
    return entry.isDirectory() ? files(filename) : [filename]
  })
}
async function fixture(t: TestContext, settings: { rounds?: 2 | 3; read?: () => Promise<void>; step?: WorkflowStoreOptions['onDurableStep'] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-b03b1-'))
  const root = path.join(directory, 'project'); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'sample.ts'), source)
  const scan = await scanProject(root)
  const projectId = path.basename(directory)
  let reads = 0, expenses = 0
  const requests: Array<{ messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; profile: typeof profile }> = []
  const snapshot = await createWorkflowSnapshot(scan, { projectId, policyVersion: 'read-policy-v1', reader: async (...args) => {
    reads++; await settings.read?.()
    return readProjectContent(...args)
  } })
  const spec = createRunSpec({ version: 1, runId: projectId + '-run', projectId, snapshotId: snapshot.snapshotId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: hash(normalizeBaseUrl(profile.baseUrl)), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v2', toolVersion: 'read-tools-v1', policyVersion: snapshot.policyVersion })
  const storageDirectory = path.join(directory, 'storage'); fs.mkdirSync(storageDirectory)
  const transport: NonNullable<OriginalInvestigationRunOptions['transport']> = async (capturedProfile, messages, _delta, options) => {
    await options.beforeRequest!(); options.beforeFetch!()
    expenses++
    requests.push({ profile: { ...capturedProfile } as typeof profile, messages: structuredClone(messages) })
    options.onUsage!({ inputTokens: 15, outputTokens: 10, totalTokens: 25 })
    const user = JSON.parse(messages.at(-1)!.content)
    const topic = { type: 'propose_topics', topics: [{ id: 'numeric-validation', title: 'Negative input behavior', mechanism: 'Throws before multiplication.', valueRationale: 'Exercises exception control flow.', difficulty: 'intermediate', evidenceIds: user.evidenceIds, evidenceNeeds: [], unconfirmed: [] }] }
    const finish = [{ type: 'select_evidence', selection: { selectedIds: user.evidenceIds, requiredBundles: [], unresolved: [] } }, { type: 'finish_investigation', unresolved: [] }]
    const actions = expenses === 1 ? [{ type: 'request_tools', tools: [{ actionId: 'read-source-1', tool: 'read_region', args: { fileId: user.files[0].fileId, startLine: 1, endLine: 3 } }] }]
      : expenses === 2 ? [topic, ...((settings.rounds ?? 2) === 2 ? finish : [])] : finish
    return JSON.stringify({ actions })
  }
  let service: OriginalInvestigationRun | undefined
  const options: OriginalInvestigationRunOptions = { storageDirectory, spec, profile, snapshot, scan, transport, ...(settings.step ? { onDurableStep: settings.step } : {}) }
  let restoreClock = () => {}
  t.after(async () => {
    try {
      await service?.close()
      t.diagnostic('Retained synthetic W fixture: ' + directory + '; bytes=' + files(directory).reduce((n, file) => n + fs.statSync(file).size, 0))
      assert.equal(fetchCalls, 0)
    } finally { restoreClock() }
  })
  if (settings.rounds === 3) {
    // This is a persistence/identity success case, not an elapsed-time test.
    // Native W under concurrent Windows validation can outlive the unchanged
    // 180s investigation ceiling. Keep one captured clock closure throughout;
    // actual I/O, native timers, settlement and finally disposal remain real.
    const realUtcNow = Date.now
    const monotonicDescriptor = Object.getOwnPropertyDescriptor(performance, 'now')
    let utc = realUtcNow(), monotonic = performance.now()
    Date.now = () => utc
    Object.defineProperty(performance, 'now', { configurable: true, value: () => monotonic })
    restoreClock = () => {
      Date.now = realUtcNow
      if (monotonicDescriptor) Object.defineProperty(performance, 'now', monotonicDescriptor)
      else Reflect.deleteProperty(performance, 'now')
    }
  }
  return { directory, root, storageDirectory, scan, snapshot, spec, requests, options,
    counts: () => ({ reads, expenses }),
    async create(extra: Partial<OriginalInvestigationRunOptions> = {}) { service = await createOriginalInvestigationRun({ ...options, ...extra }); return service }
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function verified(f: Fixture) {
  const options: WorkflowStoreOptions = { storageDirectory: f.storageDirectory, validators: { 'critical-journal': createLedgerCriticalPayloadValidator(), ledger: { schemaId: WORKFLOW_LEDGER_STATE_SCHEMA_ID, validate(payload) { try { validateLedgerState(f.spec, payload); return true } catch { return false } } } } }
  const view = readWorkflowStore(options, prepareLedgerCriticalSpec({ spec: f.spec }).binding)
  assert.equal(view.status, 'verified')
  if (view.status !== 'verified') throw Error('Expected actual verified W')
  for (const item of view.journal) {
    const physical = files(f.storageDirectory).filter(filename => path.basename(filename) === item.reference.id + '.json')
    assert.equal(physical.length, 1)
    const bytes = fs.readFileSync(physical[0]); assert.equal(bytes.length, item.reference.byteLength); assert.equal(hash(bytes), item.reference.sha256)
    assert.equal(bytes.includes(Buffer.from(secret)), false)
  }
  const folded = foldLedgerCriticalPrefix(view.journal.map(item => ({ payload: item.payload, reference: item.reference })))
  return { view, folded }
}
function gate(index: number, reject = false) {
  const entered = deferred(), release = deferred(); let journals = 0
  return { entered, release, async step(step: string) {
    if (step !== 'journal-flushed' || ++journals !== index) return
    entered.resolve()
    if (reject) throw Error('synthetic flush rejection')
    await release.promise
  } }
}
const native = { skip: process.platform !== 'win32', timeout: 300_000 }

test('I1 real original investigation folds model, tool and source receipts before private completion', native, async t => {
  const f = await fixture(t, { rounds: 3 }); const run = await f.create({ objective: 'Explain numeric validation.' })
  assert.deepEqual(Object.keys(run).sort(), ['cancel', 'close', 'observe', 'run'])
  const result = await run.run()
  assert.equal(Object.isFrozen(run), true); assert.equal(Object.isFrozen(result), true)
  assert.deepEqual(result, { phase: 'completed', generationAdmission: 'unavailable', terminalSupport: 'cancellation-only', terminalStatus: null, decisions: 3, toolRequests: 1, selectedEvidenceCount: 1, topicCount: 1 })
  assert.deepEqual(f.counts(), { expenses: 3, reads: 1 })
  const { view, folded } = verified(f)
  const kinds = view.journal.map(item => { const event = (item.payload as any).event; return event.kind === 'model' ? event.model.kind : event.kind })
  assert.deepEqual(kinds, ['created', 'reservation', 'intent', 'receipt', 'tool-charge', 'read-reservation', 'read-receipt', 'reservation', 'intent', 'receipt', 'reservation', 'intent', 'receipt'])
  assert.equal(folded.state!.models.length, 3); assert.equal(folded.state!.tools.length, 1)
  assert.deepEqual(folded.state!.reads, [{ id: 'original-read:1', reservedBytes: Buffer.byteLength(source), state: 'settled', actualBytes: Buffer.byteLength(source) }])
  assert.equal(view.manifest, null)
  const prepared = prepareLedgerCriticalSpec({ spec: f.spec })
  const reservations = view.journal.map(item => (item.payload as any).event).filter(event => event.kind === 'model' && event.model.kind === 'reservation')
  for (const [index, event] of reservations.entries()) {
    const context = event.model.context
    assert.equal(context.id, 'original-decision:' + (index + 1))
    assert.equal(context.semanticHash, commitment({ domain: 'original-investigation-decision-v1', binding: prepared.binding, ordinal: index + 1 }))
    assert.equal(context.manifestHash, commitment({ domain: 'original-investigation-manifest-v1', originalSpec: prepared.originalSpecJson, objective: 'Explain numeric validation.', snapshot: { id: f.snapshot.snapshotId, policy: f.snapshot.policyVersion, files: f.snapshot.files }, messages: hashModelMessages(f.requests[index].messages) }))
  }
  await assert.rejects(run.run(), { code: 'invalid-argument' }); assert.deepEqual(f.counts(), { expenses: 3, reads: 1 })
  await run.close()
  const terminal = verified(f)
  assert.equal(terminal.folded.terminalOutcome, 'cancelled'); assert.equal(terminal.view.manifest?.stage, 'cancelled')
  assert.equal(terminal.folded.state!.reads.length, 1); assert.equal(terminal.folded.state!.models.length, 3)
})

for (const [index, expected] of [[2, { expenses: 0, reads: 0 }], [5, { expenses: 1, reads: 0 }], [6, { expenses: 1, reads: 0 }], [7, { expenses: 1, reads: 1 }]] as const) {
  test('I2 held actual flush ' + index + ' prevents following I/O or evidence-derived decision', native, async t => {
    const hold = gate(index); const f = await fixture(t, { step: hold.step }); const run = await f.create()
    const pending = run.run().then(value => ({ value }), error => ({ error }))
    try {
      await hold.entered.promise; await tick()
      assert.deepEqual(f.counts(), expected); assert.equal(run.observe().phase, 'running')
      assert.equal(run.observe().selectedEvidenceCount, 0)
    } finally { hold.release.resolve() }
    assert.equal('error' in await pending, false)
  })
}
for (const index of [2, 5, 6, 7]) {
  test('I3 rejected actual flush ' + index + ' ends investigation before any following expense', native, async t => {
    const fault = gate(index, true); const f = await fixture(t, { step: fault.step }); const run = await f.create()
    await assert.rejects(run.run())
    assert.deepEqual(f.counts(), { expenses: index === 2 ? 0 : 1, reads: index === 7 ? 1 : 0 })
    assert.equal(run.observe().phase, 'closed'); assert.equal(run.observe().selectedEvidenceCount, 0)
    const { folded } = verified(f)
    if (index >= 6) { assert.equal(folded.state!.reads.length, 1); assert.equal(folded.state!.reads[0].state, index === 7 ? 'settled' : 'reserved') }
  })
}

test('I4 cancellation drains held model receipt and retains the project slot until work settles', native, async t => {
  const hold = gate(4); const f = await fixture(t, { step: hold.step }); const run = await f.create()
  let settled = false
  const pending = run.run().then(() => { settled = true; return null }, error => { settled = true; return error })
  try {
    await hold.entered.promise; assert.equal(run.cancel(), true); await tick()
    assert.equal(settled, false); assert.equal(run.observe().terminalStatus, null)
    assert.deepEqual(f.counts(), { expenses: 1, reads: 0 })
    const concurrent = path.join(f.directory, 'concurrent'); fs.mkdirSync(concurrent)
    const other = Object.freeze({ ...f.spec, runId: f.spec.runId + '-concurrent' })
    await assert.rejects(createOriginalInvestigationRun({ ...f.options, storageDirectory: concurrent, spec: other }), { code: 'configuration-changed' })
  } finally { hold.release.resolve() }
  assert.ok(await pending); await run.close()
  assert.deepEqual(f.counts(), { expenses: 1, reads: 0 })
  assert.equal(run.observe().phase, 'closed')
  const { folded } = verified(f)
  assert.equal(folded.state!.models.length, 1)
})

test('I5 cancellation after read reservation acknowledgement retains its conservative row without raw read', native, async t => {
  const hold = gate(6); const f = await fixture(t, { step: hold.step }); const run = await f.create()
  const pending = run.run().then(() => null, error => error)
  try { await hold.entered.promise; assert.equal(run.cancel(), true); await tick(); assert.deepEqual(f.counts(), { expenses: 1, reads: 0 }) }
  finally { hold.release.resolve() }
  assert.ok(await pending); await run.close()
  const { folded } = verified(f)
  assert.deepEqual(folded.state!.reads, [{ id: 'original-read:1', reservedBytes: Buffer.byteLength(source), state: 'reserved', actualBytes: null }])
  assert.equal(run.observe().selectedEvidenceCount, 0)
})

test('I5 unknown-byte raw read failure never refunds an acknowledged reservation or dispatches model two', native, async t => {
  const f = await fixture(t, { read: async () => { throw Error('synthetic unknown byte read failure') } }); const run = await f.create()
  await assert.rejects(run.run()); await run.close()
  assert.deepEqual(f.counts(), { expenses: 1, reads: 1 })
  const { folded } = verified(f)
  assert.deepEqual(folded.state!.reads, [{ id: 'original-read:1', reservedBytes: Buffer.byteLength(source), state: 'reserved', actualBytes: null }])
  assert.equal(run.observe().selectedEvidenceCount, 0)
})

test('I6 genuine snapshot and exact scan membership reject copied, substituted and stale inputs before expense', native, async t => {
  const f = await fixture(t)
  await assert.rejects(createOriginalInvestigationRun({ ...f.options, snapshot: { ...f.snapshot } }), { code: 'stale-snapshot' })
  await assert.rejects(createOriginalInvestigationRun({ ...f.options, scan: { ...f.scan } }), { code: 'stale-snapshot' })
  await assert.rejects(createOriginalInvestigationRun({ ...f.options, objective: 'bad\0objective' }), { code: 'invalid-argument' })
  const run = await f.create()
  fs.writeFileSync(path.join(f.root, 'sample.ts'), source + '// stale\n')
  await assert.rejects(run.run()); assert.deepEqual(f.counts(), { expenses: 0, reads: 0 })
  await assert.rejects(run.run(), { code: 'invalid-argument' })
})

test('I6 original spec profile and objective are captured before asynchronous initialization', native, async t => {
  const hold = gate(1); const f = await fixture(t, { step: hold.step })
  const mutableSpec = structuredClone(f.spec) as { -readonly [K in keyof typeof f.spec]: typeof f.spec[K] }, mutableProfile = { ...profile }
  const options = { ...f.options, spec: mutableSpec, profile: mutableProfile, objective: 'Captured objective.' }
  const pending = f.create(options)
  try {
    await hold.entered.promise
    mutableSpec.roleFocus = 'frontend'; mutableProfile.apiKey = 'MUTATED_SYNTHETIC'; options.objective = 'Mutated objective.'
  } finally { hold.release.resolve() }
  const run = await pending; await run.run()
  assert.equal(f.requests[0].profile.apiKey, secret)
  assert.equal(JSON.parse(f.requests[0].messages.at(-1)!.content).intent, 'Captured objective.')
  assert.equal(JSON.parse(f.requests[0].messages.at(-1)!.content).roleFocus, f.spec.roleFocus)
  verified(f)
})

for (const index of [2, 3]) {
  test('I6 source changes during held durable flush ' + index + ' block actual wire admission', native, async t => {
    const hold = gate(index); const f = await fixture(t, { step: hold.step }); const run = await f.create()
    const pending = run.run().then(() => null, error => error)
    try {
      await hold.entered.promise
      fs.writeFileSync(path.join(f.root, 'sample.ts'), source + '// changed at intent fence\n')
    } finally { hold.release.resolve() }
    assert.ok(await pending); await run.close()
    assert.deepEqual(f.counts(), { expenses: 0, reads: 0 })
    assert.equal(run.observe().selectedEvidenceCount, 0)
    const { folded } = verified(f)
    assert.equal(folded.state!.models.length, 1)
    assert.equal(folded.state!.models[0].state === 'settled', false)
  })
}

test('I5 late raw read settlement drains during cancellation and retains acknowledged bytes conservatively', native, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { read: async () => { entered.resolve(); await release.promise } }); const run = await f.create()
  const pending = run.run().then(() => null, error => error)
  let closed = false
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    const held = verified(f)
    assert.equal(held.folded.state!.reads[0].state, 'reserved')
    assert.equal(run.cancel(), true)
    closing = run.close().then(() => { closed = true })
    await tick()
    assert.equal(closed, false); assert.equal(run.observe().terminalStatus, null)
  } finally { release.resolve() }
  assert.ok(await pending); await closing
  assert.deepEqual(f.counts(), { expenses: 1, reads: 1 })
  assert.equal(run.observe().selectedEvidenceCount, 0)
  const final = verified(f)
  assert.equal(final.folded.state!.reads[0].state, 'reserved')
  assert.equal(final.folded.state!.reads[0].actualBytes, null)
})
