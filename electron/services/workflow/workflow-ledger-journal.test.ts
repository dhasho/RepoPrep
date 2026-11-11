import test, { after, before } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { WorkflowLedgerJournalSession, WorkflowLedgerJournalOptions } from './workflow-ledger-journal.ts'
import type { LedgerCriticalEvent, LedgerCriticalEnvelopeV1 } from './ledger-critical-envelope.ts'
import type { WorkflowStoreOptions, WorkflowVerifiedJournal, WorkflowJournalBuildContext } from './workflow-store.ts'
import type { DurableModelContext, DurableModelEvent } from './model-journal.ts'
import type { LedgerStateV1 } from './ledger-state.ts'
import type { ModelTransport } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createWorkflowLedgerJournal, classifyWorkflowLedger, WORKFLOW_LEDGER_STATE_SCHEMA_ID } from './workflow-ledger-journal.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { openWorkflowStore, readWorkflowStore } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createBudgetLedger, exportBudgetLedgerState, requiresDurableModelAdmission, sealBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createLedgerBinding, validateLedgerState, hashSemanticModelOperation } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { LEDGER_CRITICAL_FORMAT, LEDGER_CRITICAL_SCHEMA_ID, prepareLedgerCriticalSpec, createLedgerCriticalPayloadValidator, ledgerCriticalPosition, validateLedgerCriticalEnvelope } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { WorkflowError } from './project-contract.ts'

const native = process.platform === 'win32'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const profile = Object.freeze({ id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49152, maxOutputTokens: 4096, temperature: -0 })
const spec = createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: hash(normalizeBaseUrl(profile.baseUrl)), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens, temperature: -0 }, promptVersion: 'prompt-v1', toolVersion: 'tool-v1', policyVersion: 'policy-v1' })
const prepared = prepareLedgerCriticalSpec({ spec })
const messages = [{ role: 'user' as const, content: 'synthetic private request' }]
const operation = { semanticHash: hash('synthetic semantic'), manifestHash: hash('synthetic manifest') }
const usage = Object.freeze({ inputTokens: 5, outputTokens: 3, totalTokens: 8 })
const safeError = (error: unknown) => error instanceof WorkflowError && !/SYNTHETIC_SECRET|raw disk|synthetic private/.test(JSON.stringify(error))
let providerRequests = 0
const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { providerRequests++; throw Error('Provider requests forbidden') } })
after(() => { globalThis.fetch = originalFetch; assert.equal(providerRequests, 0) })
const rawValidators = {
  'critical-journal': createLedgerCriticalPayloadValidator(),
  ledger: { schemaId: WORKFLOW_LEDGER_STATE_SCHEMA_ID, validate(value: unknown) { try { validateLedgerState(spec, value); return true } catch { return false } } }
}
const storeOptions = (storageDirectory: string, extra: Partial<WorkflowStoreOptions> = {}): WorkflowStoreOptions => ({ storageDirectory, validators: rawValidators, ...extra })
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false)
    return entry.isDirectory() ? files(filename) : [filename]
  })
}
function cleanup(directory: string): number {
  const absolute = path.resolve(directory)
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
  assert.match(path.basename(absolute), /^repoprep-a2a-/)
  assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false)
  const bytes = files(absolute).reduce((sum, file) => sum + fs.statSync(file).size, 0)
  fs.rmSync(absolute, { recursive: true })
  assert.equal(fs.existsSync(absolute), false)
  return bytes
}
async function harness(t: TestContext, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-a2a-'))
  let success = false
  try { await run(directory); success = true } finally {
    if (success) t.diagnostic('native fixture removed; bytes=' + cleanup(directory))
    else t.diagnostic('FAILED fixture retained: ' + directory)
  }
}
function nativeTest(name: string, run: (directory: string) => Promise<void>) { test(name, { skip: !native, timeout: 120000 }, async t => harness(t, run)) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
function read(directory: string): WorkflowVerifiedJournal[] {
  const view = readWorkflowStore(storeOptions(directory), prepared.binding)
  assert.equal(view.status, 'verified')
  if (view.status !== 'verified') throw Error('Expected genuine verified W view')
  return [...view.journal]
}
function verifyBytes(directory: string, journal = read(directory)) {
  for (const item of journal) {
    const matching = files(directory).filter(file => path.basename(file) === item.reference.id + '.json')
    assert.equal(matching.length, 1)
    const bytes = fs.readFileSync(matching[0])
    assert.equal(bytes.length, item.reference.byteLength)
    assert.equal(hash(bytes), item.reference.sha256)
    const outer = JSON.parse(bytes.toString('utf8'))
    assert.deepEqual(outer.payload, item.payload)
    assert.deepEqual(outer.binding, prepared.binding)
    assert.deepEqual(outer.producingEpoch, item.reference.producingEpoch)
    assert.equal(outer.schemaId, LEDGER_CRITICAL_SCHEMA_ID)
    assert.equal(outer.sequence, item.sequence)
    assert.deepEqual(outer.previous, journal[item.sequence - 2]?.reference ?? null)
  }
  return foldLedgerCriticalPrefix(journal.map(item => ({ payload: item.payload, reference: item.reference })))
}
function gateway(session: WorkflowLedgerJournalSession, transport: ModelTransport) { return createModelGateway(session.spec, profile, session.ledger, { durability: session.journal, transport }) }
function complete(gate: ReturnType<typeof createModelGateway>, id = 'request-01') { return gate.complete({ id, stage: 'generation', messages, durableOperation: { ...operation, semanticHash: hash('semantic:' + id) } }) }
const settled = (beforeFetch: () => void = () => {}): ModelTransport => async (_p, _m, _d, options) => { await options.beforeRequest!(); options.beforeFetch?.(); beforeFetch(); options.onUsage!(usage); return 'synthetic output' }
async function raw(directory: string) {
  const store = await openWorkflowStore(storeOptions(directory))
  const attempt = await store.beginAttempt(prepared.binding)
  const ledger = createBudgetLedger(spec, { durable: true, clock: () => 0, utcClock: () => 1_000_000 })
  const append = (event: LedgerCriticalEvent, modify?: (context: WorkflowJournalBuildContext) => WorkflowJournalBuildContext, state?: (position: ReturnType<typeof ledgerCriticalPosition>) => LedgerStateV1) => store.appendJournal(attempt, actual => {
    const provenance = modify?.(actual) ?? actual
    const logicalPosition = ledgerCriticalPosition(prepared, provenance, event)
    return validateLedgerCriticalEnvelope({ format: LEDGER_CRITICAL_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, state: state?.(logicalPosition) ?? exportBudgetLedgerState(ledger, createLedgerBinding(spec, logicalPosition)) }, prepared)
  })
  return { store, attempt, ledger, append, created: () => append({ kind: 'created', genesis: prepared.genesis }) }
}
function context(session: WorkflowLedgerJournalSession, id = 'manual-01'): DurableModelContext {
  return { runId: spec.runId, projectId: spec.projectId, snapshotId: spec.snapshotId, attemptId: session.journal.attemptId, fence: session.journal.fence, id, stage: 'generation', semanticHash: operation.semanticHash, semanticOperationHash: hashSemanticModelOperation(spec, 'generation', operation.semanticHash), requestHash: hash('request'), manifestHash: operation.manifestHash, inputTokens: 10, outputTokens: 10, contextChars: 20 }
}
function model(c: DurableModelContext): DurableModelEvent { return { version: 1, kind: 'reservation', context: c, usage: null, outputStatus: 'missing', failureCode: 'none' } }
function reserve(session: WorkflowLedgerJournalSession, c: DurableModelContext) { session.ledger.reserveModel({ ...c }) }
function build(session: WorkflowLedgerJournalSession, position: ReturnType<typeof ledgerCriticalPosition>) { return exportBudgetLedgerState(session.ledger, createLedgerBinding(spec, position)) }

nativeTest('new genuine session flushes one created with complete original state and immutable owner identity', async directory => {
  assert.equal(classifyWorkflowLedger({ storageDirectory: directory, spec }).status, 'unavailable')
  const emptyOwner = await openWorkflowStore(storeOptions(directory))
  await emptyOwner.close()
  assert.equal(classifyWorkflowLedger({ storageDirectory: directory, spec }).status, 'absent')
  const mutable = JSON.parse(prepared.originalSpecJson)
  mutable.model.temperature = -0
  const pending = createWorkflowLedgerJournal({ storageDirectory: directory, spec: mutable })
  mutable.runId = 'changed-after-call'
  mutable.budget.total.inputTokens = 1
  const session = await pending
  try {
    assert.ok(Object.isFrozen(session) && Object.isFrozen(session.journal) && Object.isFrozen(session.spec.budget.total))
    assert.equal(session.spec.runId, spec.runId)
    assert.equal(requiresDurableModelAdmission(session.ledger), true)
    assert.equal(Object.is(session.spec.model.temperature, -0), true)
    const records = read(directory)
    assert.equal(records.length, 1)
    const envelope = records[0].payload as LedgerCriticalEnvelopeV1
    assert.equal(envelope.originalSpecJson, prepared.originalSpecJson)
    assert.equal(envelope.event.kind, 'created')
    assert.equal(envelope.provenance.previous, null)
    assert.deepEqual(envelope.state.models, [])
    assert.deepEqual(envelope.state.issuedIds, [])
    assert.equal(envelope.state.blocked, false)
    assert.equal(envelope.state.time.terminalElapsedMs, null)
    assert.deepEqual(session.journal.binding, envelope.state.binding)
    assert.equal(session.journal.fence, records[0].reference.producingEpoch.owner)
    assert.equal(session.journal.attemptId, records[0].reference.producingEpoch.attemptId)
    assert.deepEqual(verifyBytes(directory).state, envelope.state)
    assert.throws(() => createModelGateway(session.spec, profile, session.ledger), safeError)
    assert.throws(() => Object.assign(session.journal, { fence: 99 }), TypeError)
  } finally { await session.close() }
})

nativeTest('real gateway and L flush reservation/intent before HTTP and receipt before return', async directory => {
  const intent = deferred(), releaseIntent = deferred(), receipt = deferred(), releaseReceipt = deferred()
  let flushes = 0, http = 0, returned = false
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec, async onDurableStep(step) {
    if (step === 'journal-flushed') {
      flushes++
      if (flushes === 3) { intent.resolve(); await releaseIntent.promise }
      if (flushes === 4) { receipt.resolve(); await releaseReceipt.promise }
    }
  } })
  try {
    const request = complete(gateway(session, settled(() => {
      http++
      const records = read(directory)
      assert.deepEqual(records.map(item => { const e = (item.payload as LedgerCriticalEnvelopeV1).event; return e.kind === 'model' ? e.model.kind : e.kind }), ['created', 'reservation', 'intent'])
      assert.equal((records[2].payload as LedgerCriticalEnvelopeV1).state.models[0].state, 'dispatched')
      verifyBytes(directory, records)
    }))).then(result => { returned = true; return result })
    await intent.promise
    assert.equal(http, 0)
    releaseIntent.resolve()
    await receipt.promise
    assert.equal(returned, false)
    assert.equal(session.ledger.snapshot().reservations[0].state, 'dispatched')
    releaseReceipt.resolve()
    assert.equal((await request).content, 'synthetic output')
    const cursor = verifyBytes(directory)
    assert.equal(cursor.state!.models[0].state, 'settled')
    assert.deepEqual(cursor.state!.models[0].usage, usage)
    assert.deepEqual(session.journal.binding.journal, cursor.logicalPosition)
    assert.doesNotMatch(JSON.stringify(read(directory)), /SYNTHETIC_SECRET|synthetic private|synthetic output|baseUrl|apiKey/)
  } finally { releaseIntent.resolve(); releaseReceipt.resolve(); await session.close() }
})

nativeTest('unknown model usage retains original holds and a foldable full prefix', async directory => {
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec })
  try {
    await assert.rejects(complete(gateway(session, async (_p, _m, _d, options) => { await options.beforeRequest!(); options.beforeFetch?.(); return 'no receipt' })), safeError)
    const state = verifyBytes(directory).state!
    assert.equal(state.models[0].state, 'unknown')
    assert.equal(state.models[0].usage, null)
    assert.ok(state.models[0].outputTokens > 0)
    assert.equal(state.blocked, true)
    assert.equal(session.ledger.snapshot().total.outputTokens, state.models[0].outputTokens)
  } finally { await session.close() }
})

nativeTest('concurrent real L calls stay causal, and every original builder is invoked exactly once', async directory => {
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec })
  const calls = new Map<string, number>()
  try {
    const tracked = Object.freeze({ ...session.journal, appendAndFlush(event: DurableModelEvent, state: Parameters<typeof session.journal.appendAndFlush>[1]) {
      return session.journal.appendAndFlush(event, position => { const key = event.context.id + '/' + event.kind; calls.set(key, (calls.get(key) ?? 0) + 1); return state(position) })
    } })
    const gate = createModelGateway(session.spec, profile, session.ledger, { durability: tracked, transport: settled() })
    await Promise.all(['parallel-01', 'parallel-02', 'parallel-03'].map(id => complete(gate, id)))
    assert.equal(calls.size, 9)
    assert.ok([...calls.values()].every(count => count === 1))
    assert.equal(read(directory).length, 10)
    assert.equal(verifyBytes(directory).state!.models.filter(row => row.state === 'settled').length, 3)
  } finally { await session.close() }
})

nativeTest('outer W record quota refusal precedes HTTP and poisons future admission without refund', async directory => {
  const measure = path.join(directory, 'measure'); fs.mkdirSync(measure)
  const baseline = await createWorkflowLedgerJournal({ storageDirectory: measure, spec })
  const maximum = read(measure)[0].reference.byteLength + 128
  await baseline.close()
  const actual = path.join(directory, 'actual'); fs.mkdirSync(actual)
  const session = await createWorkflowLedgerJournal({ storageDirectory: actual, spec, limits: { componentBytes: { 'critical-journal': maximum } } })
  let http = 0, builders = 0
  try {
    const gate = gateway(session, settled(() => { http++ }))
    await assert.rejects(complete(gate), safeError)
    assert.equal(http, 0)
    assert.equal(read(actual).length, 1)
    assert.ok(session.ledger.snapshot().total.outputTokens > 0)
    assert.equal(session.ledger.snapshot().reservations[0].state, 'unknown-unsent')
    await assert.rejects(session.journal.appendAndFlush(model(context(session)), position => { builders++; return build(session, position) }), safeError)
    await assert.rejects(complete(gate, 'later-01'), safeError)
    assert.equal(builders, 0)
    assert.equal(classifyWorkflowLedger({ storageDirectory: actual, spec }).status, 'verified-nonterminal')
  } finally { await session.close() }
})

nativeTest('genuine intent flush followed by lost ack permanently poisons without HTTP or retry', async directory => {
  let flushes = 0, http = 0
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec, onDurableStep(step) { if (step === 'journal-flushed' && ++flushes === 3) throw Error('raw disk SYNTHETIC_SECRET after fsync') } })
  try {
    const gate = gateway(session, settled(() => { http++ }))
    await assert.rejects(complete(gate), safeError)
    assert.equal(http, 0)
    assert.equal(flushes, 3)
    const cursor = verifyBytes(directory)
    assert.equal(cursor.state!.models[0].state, 'dispatched')
    assert.equal(session.ledger.snapshot().reservations[0].state, 'unknown')
    assert.equal(session.journal.binding.journal.sequence, 2)
    assert.equal(cursor.logicalPosition.sequence, 3)
    await assert.rejects(complete(gate, 'no-retry'), safeError)
    assert.equal(flushes, 3)
  } finally { await session.close() }
})

nativeTest('uncertain reservation ack rejects already queued L requests and future builders', async directory => {
  const entered = deferred(), release = deferred(); let flushes = 0, http = 0
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec, async onDurableStep(step) {
    if (step === 'journal-flushed' && ++flushes === 2) { entered.resolve(); await release.promise; throw Error('raw disk ack lost') }
  } })
  try {
    const gate = gateway(session, settled(() => { http++ }))
    const requests = [complete(gate, 'queue-01'), complete(gate, 'queue-02')]
    const rejected = Promise.all(requests.map(request => assert.rejects(request, safeError)))
    await entered.promise; release.resolve(); await rejected
    assert.equal(http, 0)
    assert.equal(flushes, 2)
    assert.equal(verifyBytes(directory).state!.models.length, 2)
    assert.ok(session.ledger.snapshot().reservations.every(row => row.state === 'unknown-unsent'))
  } finally { release.resolve(); await session.close() }
})

for (const failure of ['throw', 'invalid-state', 'async-state', 'wrong-context', 'copy-epoch'] as const) nativeTest('builder/input failure poisons genuine attempt: ' + failure, async directory => {
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec })
  const c = context(session); let builders = 0
  reserve(session, c)
  try {
    const event = model(failure === 'wrong-context' ? { ...c, snapshotId: 'fake-snapshot' } : failure === 'copy-epoch' ? { ...c, fence: c.fence + 1, attemptId: '11111111-1111-4111-8111-111111111111' } : c)
    await assert.rejects(session.journal.appendAndFlush(event, position => {
      builders++
      if (failure === 'throw') throw Error('raw disk SYNTHETIC_SECRET')
      if (failure === 'invalid-state') return { ...build(session, position), models: [] }
      if (failure === 'async-state') return Promise.resolve(build(session, position)) as unknown as LedgerStateV1
      return build(session, position)
    }), safeError)
    assert.equal(builders, failure === 'wrong-context' || failure === 'copy-epoch' ? 0 : 1)
    await assert.rejects(session.journal.appendAndFlush(model(c), position => { builders++; return build(session, position) }), safeError)
    assert.equal(builders, failure === 'wrong-context' || failure === 'copy-epoch' ? 0 : 1)
    assert.equal(read(directory).length, 1)
    assert.equal(session.ledger.snapshot().blocked, true)
    assert.ok(session.ledger.snapshot().total.outputTokens > 0)
  } finally { await session.close() }
})

nativeTest('factory and classifier reject caller-selected store, ack, binding, epoch and copied authority options', async directory => {
  for (const key of ['store', 'attempt', 'gateway', 'binding', 'genesis', 'epoch', 'journalPosition', 'validators', 'ack', 'authority']) {
    assert.throws(() => createWorkflowLedgerJournal({ storageDirectory: directory, spec, [key]: {} } as WorkflowLedgerJournalOptions), safeError)
    assert.throws(() => classifyWorkflowLedger({ storageDirectory: directory, spec, [key]: {} }), safeError)
  }
  let getters = 0
  const accessor = Object.defineProperty({ storageDirectory: directory }, 'spec', { enumerable: true, get() { getters++; return spec } })
  assert.throws(() => createWorkflowLedgerJournal(accessor as WorkflowLedgerJournalOptions), safeError)
  assert.equal(getters, 0)
  assert.throws(() => createWorkflowLedgerJournal(new Proxy({ storageDirectory: directory, spec }, {})), safeError)
  assert.equal(files(directory).length, 0)
})

nativeTest('close revokes issuance immediately and awaits a real pending W flush', async directory => {
  const entered = deferred(), release = deferred(); let flushes = 0, closed = false, http = 0
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec, async onDurableStep(step) { if (step === 'journal-flushed' && ++flushes === 2) { entered.resolve(); await release.promise } } })
  const request = assert.rejects(complete(gateway(session, settled(() => { http++ }))), safeError)
  try {
    await entered.promise
    const closing = session.close().then(() => { closed = true })
    assert.throws(() => session.journal.assertCurrent(context(session)), safeError)
    await Promise.resolve(); assert.equal(closed, false)
    await assert.rejects(complete(gateway(session, settled(() => { http++ })), 'after-close'), safeError)
    release.resolve(); await Promise.all([closing, request])
    assert.equal(closed, true)
    assert.equal(http, 0)
    verifyBytes(directory)
  } finally { release.resolve(); await session.close(); await request }
})

nativeTest('finish and old sessions cannot admit after a new genuine owner/attempt', async directory => {
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec })
  assert.equal(session.finish(), true)
  assert.equal(session.finish(), false)
  assert.throws(() => session.journal.assertCurrent(context(session)), safeError)
  await assert.rejects(complete(gateway(session, settled()), 'after-finish'), safeError)
  await session.close()
  const successor = await openWorkflowStore(storeOptions(directory))
  try {
    await successor.beginAttempt(prepared.binding)
    assert.throws(() => session.journal.assertCurrent(context(session)), safeError)
    await assert.rejects(session.journal.appendAndFlush(model(context(session)), position => build(session, position)), safeError)
    assert.equal(read(directory).length, 1)
  } finally { await successor.close() }
})

for (const step of ['attempt-marker-flushed', 'journal-flushed'] as const) nativeTest('initialization failure retains evidence, closes W and cannot reset: ' + step, async directory => {
  await assert.rejects(createWorkflowLedgerJournal({ storageDirectory: directory, spec, onDurableStep(actual) { if (actual === step) throw Error('raw disk init ack lost') } }), safeError)
  assert.equal(classifyWorkflowLedger({ storageDirectory: directory, spec }).status, step === 'attempt-marker-flushed' ? 'initialized-without-created' : 'verified-nonterminal')
  const evidence = files(directory).filter(file => path.basename(file).startsWith('j-') || path.basename(file).startsWith('e-')).map(file => [file, hash(fs.readFileSync(file))])
  assert.ok(evidence.length)
  await assert.rejects(createWorkflowLedgerJournal({ storageDirectory: directory, spec }), safeError)
  for (const [file, digest] of evidence) assert.equal(hash(fs.readFileSync(file)), digest)
})

nativeTest('existing full prefix and sealed terminal cannot become a new budget', async directory => {
  const source = await raw(directory)
  await source.created()
  await source.store.close()
  await assert.rejects(createWorkflowLedgerJournal({ storageDirectory: directory, spec }), safeError)
  const store = await openWorkflowStore(storeOptions(directory))
  const attempt = await store.beginAttempt(prepared.binding)
  try {
    const prior = verifyBytes(directory)
    const recovery = await store.appendJournal(attempt, provenance => {
      const event = { kind: 'recovery' as const, from: prior.logicalPosition }
      const logicalPosition = ledgerCriticalPosition(prepared, provenance, event)
      const state = { ...prior.state!, binding: createLedgerBinding(spec, logicalPosition) }
      return validateLedgerCriticalEnvelope({ format: LEDGER_CRITICAL_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, state }, prepared)
    })
    const recoveryEnvelope = recovery.payload as LedgerCriticalEnvelopeV1
    await store.appendJournal(attempt, provenance => {
      const event = { kind: 'seal' as const, outcome: 'completed' as const }
      const logicalPosition = ledgerCriticalPosition(prepared, provenance, event)
      const state = { ...recoveryEnvelope.state, binding: createLedgerBinding(spec, logicalPosition), blocked: true, time: { ...recoveryEnvelope.state.time, terminalElapsedMs: recoveryEnvelope.state.time.elapsedHighWaterMs } }
      return validateLedgerCriticalEnvelope({ format: LEDGER_CRITICAL_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, state }, prepared)
    })
  } finally { await store.close() }
  const terminal = classifyWorkflowLedger({ storageDirectory: directory, spec })
  assert.equal(terminal.status, 'terminal')
  if (terminal.status === 'terminal') { assert.equal(terminal.outcome, 'completed'); assert.equal(terminal.state.blocked, true) }
  await assert.rejects(createWorkflowLedgerJournal({ storageDirectory: directory, spec }), safeError)
})

nativeTest('torn latest W evidence is unavailable and never falls back or resets', async directory => {
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec })
  await complete(gateway(session, settled()))
  await session.close()
  const latest = read(directory).at(-1)!
  const filename = files(directory).find(file => path.basename(file) === latest.reference.id + '.json')!
  fs.truncateSync(filename, 17)
  const before = hash(fs.readFileSync(filename))
  assert.equal(classifyWorkflowLedger({ storageDirectory: directory, spec }).status, 'unavailable')
  await assert.rejects(createWorkflowLedgerJournal({ storageDirectory: directory, spec }), safeError)
  assert.equal(hash(fs.readFileSync(filename)), before)
})

for (const mismatch of ['epoch', 'sequence', 'previous', 'original'] as const) nativeTest('genuine full-prefix classifier rejects payload versus outer mismatch: ' + mismatch, async directory => {
  const source = await raw(directory)
  try {
    const first = await source.created()
    if (mismatch === 'original') {
      const different = prepareLedgerCriticalSpec({ spec: { ...spec, runId: 'other-run' } })
      const ledger = createBudgetLedger(different.spec, { durable: true })
      await source.store.appendJournal(source.attempt, actual => {
        const provenance = { ...actual, binding: different.binding }
        const event = { kind: 'created' as const, genesis: different.genesis }
        const logicalPosition = ledgerCriticalPosition(different, provenance, event)
        return validateLedgerCriticalEnvelope({ format: LEDGER_CRITICAL_FORMAT, originalSpecJson: different.originalSpecJson, provenance, event, logicalPosition, state: exportBudgetLedgerState(ledger, createLedgerBinding(different.spec, logicalPosition)) }, different)
      })
    } else await source.append({ kind: 'created', genesis: prepared.genesis }, actual => mismatch === 'epoch' ? { ...actual, producingEpoch: { ...actual.producingEpoch, owner: actual.producingEpoch.owner + 1 } } : mismatch === 'sequence' ? { ...actual, sequence: 1, previous: null } : { ...actual, previous: { ...first.reference, sha256: 'f'.repeat(64) } })
    assert.equal(read(directory).length, 2) // W DATA validity alone is insufficient.
    assert.equal(classifyWorkflowLedger({ storageDirectory: directory, spec }).status, 'unavailable')
  } finally { await source.store.close() }
})

nativeTest('classifier requires recovery on a changed genuine producing epoch', async directory => {
  const source = await raw(directory)
  await source.created()
  source.store.finishAttempt(source.attempt)
  const next = await source.store.beginAttempt(prepared.binding)
  try {
    await source.store.appendJournal(next, provenance => {
      const event = { kind: 'created' as const, genesis: prepared.genesis }, logicalPosition = ledgerCriticalPosition(prepared, provenance, event)
      return validateLedgerCriticalEnvelope({ format: LEDGER_CRITICAL_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, state: exportBudgetLedgerState(source.ledger, createLedgerBinding(spec, logicalPosition)) }, prepared)
    })
    assert.equal(classifyWorkflowLedger({ storageDirectory: directory, spec }).status, 'unavailable')
  } finally { await source.store.close() }
})

nativeTest('older valid manifest is checked at its anchor and cannot override a newer genuine tail', async directory => {
  const source = await raw(directory)
  try {
    const created = await source.created(), anchor = created.payload as LedgerCriticalEnvelopeV1
    await source.store.publish(source.attempt, { stage: 'created', components: [{ kind: 'ledger', payload: anchor.state }] })
    source.ledger.chargeTool('tool-01', 'generation')
    const later = await source.append({ kind: 'tool-charge', id: 'tool-01', stage: 'generation' })
    const classification = classifyWorkflowLedger({ storageDirectory: directory, spec })
    assert.equal(classification.status, 'verified-nonterminal')
    if (classification.status === 'verified-nonterminal') {
      assert.equal(classification.position.sequence, 2)
      assert.deepEqual(classification.reference, later.reference)
      assert.equal(classification.state.tools.length, 1)
      assert.deepEqual(classification.manifestAnchor, { reference: created.reference, position: anchor.logicalPosition })
    }
    verifyBytes(directory)
  } finally { await source.store.close() }
})

for (const mismatch of ['ledger', 'anchor', 'terminal'] as const) nativeTest('classifier distinguishes manifest mismatch: ' + mismatch, async directory => {
  const source = await raw(directory)
  try {
    const created = await source.created(), envelope = created.payload as LedgerCriticalEnvelopeV1
    const state = mismatch === 'ledger' ? { ...envelope.state, blocked: true } : envelope.state
    await source.store.publish(source.attempt, { stage: mismatch === 'terminal' ? 'completed' : 'created', components: [{ kind: 'ledger', payload: state }] })
    if (mismatch === 'anchor') {
      const manifestFile = files(directory).find(file => /^m-/.test(path.basename(file)))!
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); manifest.journalPosition = null
      fs.writeFileSync(manifestFile, JSON.stringify(manifest))
    }
    assert.deepEqual(classifyWorkflowLedger({ storageDirectory: directory, spec }), { status: 'manifest-mismatch', reason: mismatch })
  } finally { await source.store.close() }
})

nativeTest('sealed unresolved accounting stays frozen during classification', async directory => {
  const source = await raw(directory)
  try {
    await source.created()
    source.ledger.reserveModel({ id: 'unresolved', stage: 'generation', inputTokens: 10, outputTokens: 20, contextChars: 20, semanticHash: operation.semanticHash, semanticOperationHash: hashSemanticModelOperation(spec, 'generation', operation.semanticHash), requestHash: hash('request'), manifestHash: operation.manifestHash })
    source.ledger.chargeTool('tool-01', 'generation')
    await source.append({ kind: 'tool-charge', id: 'tool-01', stage: 'generation' })
    sealBudgetLedger(source.ledger)
    const seal = await source.append({ kind: 'seal', outcome: 'cancelled' })
    const envelope = seal.payload as LedgerCriticalEnvelopeV1
    await source.store.publish(source.attempt, { stage: 'cancelled', components: [{ kind: 'ledger', payload: envelope.state }] })
    const result = classifyWorkflowLedger({ storageDirectory: directory, spec })
    assert.equal(result.status, 'terminal')
    if (result.status === 'terminal') { assert.equal(result.state.models[0].state, 'reserved'); assert.deepEqual(result.state, envelope.state); assert.equal(result.outcome, 'cancelled') }
  } finally { await source.store.close() }
})


nativeTest('genuine journal-open failure leaves torn evidence and poisons every later admission', async directory => {
  let opened = 0, http = 0
  const session = await createWorkflowLedgerJournal({ storageDirectory: directory, spec, onDurableStep(step) {
    if (step === 'journal-opened' && ++opened === 2) throw Error('raw disk SYNTHETIC_SECRET write refusal')
  } })
  try {
    const gate = gateway(session, settled(() => { http++ }))
    await assert.rejects(complete(gate), safeError)
    assert.equal(http, 0)
    assert.equal(opened, 2)
    assert.ok(session.ledger.snapshot().total.outputTokens > 0)
    assert.equal(session.ledger.snapshot().reservations[0].state, 'unknown-unsent')
    assert.equal(classifyWorkflowLedger({ storageDirectory: directory, spec }).status, 'unavailable')
    await assert.rejects(complete(gate, 'after-refusal'), safeError)
    assert.equal(opened, 2)
  } finally { await session.close() }
  await assert.rejects(createWorkflowLedgerJournal({ storageDirectory: directory, spec }), safeError)
})
