import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { RunSpec } from './run-spec.ts'
import type { WorkflowStore, WorkflowStoreOptions, WorkflowAttempt, WorkflowJournalBuildContext, WorkflowComponentReadContext } from './workflow-store.ts'
import type { LedgerCriticalEvent, LedgerCriticalEnvelopeV1 } from './ledger-critical-envelope.ts'
import type { LedgerStateV1 } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createBudgetLedger, exportBudgetLedgerState, sealBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createLedgerBinding, validateLedgerState } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { prepareLedgerCriticalSpec, ledgerCriticalPosition, createLedgerCriticalPayloadValidator } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { openWorkflowStore, readWorkflowStore } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { validateArchivedWorkflowLedger } from './workflow-ledger-archive.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { classifyWorkflowLedger, WORKFLOW_LEDGER_STATE_SCHEMA_ID } from './workflow-ledger-journal.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createWorkflowCancellationControl } from './workflow-cancellation-control.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunCoordinator } from './run-coordinator.ts'

const native = process.platform === 'win32'
const originalFetch = globalThis.fetch
let providerRequests = 0
before(() => { globalThis.fetch = async () => { providerRequests++; throw Error('Provider requests forbidden') } })
after(() => { globalThis.fetch = originalFetch; assert.equal(providerRequests, 0) })
function spec(id: string, fine = true): RunSpec {
  return createRunSpec({ version: 1, runId: id, projectId: 'project-' + id, snapshotId: 'snapshot-' + id, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: fine ? 'backend' : 'frontend', granularity: fine ? 'fine' : 'coarse', model: { profileId: 'profile-' + id, model: 'synthetic', endpointFingerprint: (fine ? 'a' : 'b').repeat(64), protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: fine ? 4_096 : 2_000, temperature: fine ? -0 : 0.4 }, promptVersion: 'prompt-v1', toolVersion: 'tool-v1', policyVersion: fine ? 'read-policy-v1' : 'read-policy-v2', budget: { wallClockMs: fine ? 60_000 : 30_000 } })
}
function options(directory: string, current: RunSpec, archive = true): WorkflowStoreOptions {
  return { storageDirectory: directory, validators: {
    'critical-journal': createLedgerCriticalPayloadValidator(),
    ledger: { schemaId: WORKFLOW_LEDGER_STATE_SCHEMA_ID, ...(archive ? { validateRead: validateArchivedWorkflowLedger } : {}), validate(payload: unknown) { try { validateLedgerState(current, payload); return true } catch { return false } } }
  } }
}
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-ledger-archive-'))
    let passed = false
    try { await run(directory); passed = true } finally {
      if (passed) {
        const absolute = path.resolve(directory)
        assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
        assert.ok(path.basename(absolute).startsWith('repoprep-ledger-archive-'))
        assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false)
        const released = files(absolute).reduce((sum, file) => sum + fs.statSync(file).size, 0)
        fs.rmSync(absolute, { recursive: true }); assert.equal(fs.existsSync(absolute), false)
        t.diagnostic('Cleaned verified synthetic fixture bytes=' + released)
      } else t.diagnostic('FAILED fixture retained: ' + directory)
    }
  })
}
function appender(store: WorkflowStore, attempt: WorkflowAttempt, original: RunSpec) {
  const prepared = prepareLedgerCriticalSpec({ spec: original })
  const ledger = createBudgetLedger(original, { clock: () => 0, utcClock: () => 1_000 })
  let state: LedgerStateV1 | undefined
  async function append(event: LedgerCriticalEvent, mutate?: (payload: LedgerCriticalEnvelopeV1) => LedgerCriticalEnvelopeV1) {
    const acknowledged = await store.appendJournal(attempt, (context: WorkflowJournalBuildContext) => {
      const provenance = { binding: prepared.binding, producingEpoch: context.producingEpoch, sequence: context.sequence, previous: context.previous }
      const logicalPosition = ledgerCriticalPosition(prepared, provenance, event)
      const payload: LedgerCriticalEnvelopeV1 = { format: 'workflow-ledger-critical/v1', originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, state: exportBudgetLedgerState(ledger, createLedgerBinding(original, logicalPosition)) }
      return mutate ? mutate(payload) : payload
    })
    state = (acknowledged.payload as LedgerCriticalEnvelopeV1).state
    return acknowledged
  }
  return { prepared, ledger, append, get state() { assert.ok(state); return state }, async created() { return append({ kind: 'created', genesis: prepared.genesis }) }, async sealed() { sealBudgetLedger(ledger); return append({ kind: 'seal', outcome: 'cancelled' }) } }
}

nativeTest('genuine host A/B cancellation terminals coexist in one W root despite different original specs, budgets, signed zero and policies', async directory => {
  const a = spec('archive-A'), b = spec('archive-B', false)
  for (const original of [a, b]) {
    const token = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original })
    const session = createRunCoordinator().begin(original, { cancellationControl: token })!
    try { assert.equal(session.cancel(), true); assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' }) } finally { await session.close() }
  }
  for (const original of [a, b]) {
    const classification = classifyWorkflowLedger({ storageDirectory: directory, spec: original })
    assert.equal(classification.status, 'terminal')
    if (classification.status === 'terminal') { assert.equal(classification.outcome, 'cancelled'); assert.equal(classification.state.binding.runId, original.runId) }
  }
  const currentB = await openWorkflowStore(options(directory, b))
  try {
    const viewA = currentB.readOwned(prepareLedgerCriticalSpec({ spec: a }).binding)
    assert.equal(viewA.status, 'verified')
    if (viewA.status !== 'verified') throw Error('missing A')
    const newRun = spec('archive-new-B', false)
    // The current writer's exact spec is B, so A's valid historical state is never a B write.
    const attempt = await currentB.beginAttempt(prepareLedgerCriticalSpec({ spec: newRun }).binding)
    const before = files(directory).length
    await assert.rejects(currentB.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: viewA.components[0].payload }] }), { code: 'unavailable' })
    assert.equal(files(directory).length, before)
  } finally { await currentB.close() }
})

nativeTest('the current host write closure still rejects an A projection under B while the same schema reads A archivally', async directory => {
  const a = spec('write-A'), b = spec('write-B', false)
  let store = await openWorkflowStore(options(directory, a))
  let stateA: LedgerStateV1
  try { const attempt = await store.beginAttempt(prepareLedgerCriticalSpec({ spec: a }).binding); const build = appender(store, attempt, a); await build.created(); stateA = build.state; await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: stateA }] }) } finally { await store.close() }
  store = await openWorkflowStore(options(directory, b))
  try {
    const attempt = await store.beginAttempt(prepareLedgerCriticalSpec({ spec: b }).binding)
    await assert.rejects(store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: stateA! }] }), { code: 'unavailable' })
  } finally { await store.close() }
})

nativeTest('an old containing manifest anchor is validated against the complete view including a valid newer journal tail', async directory => {
  const original = spec('old-anchor')
  const store = await openWorkflowStore(options(directory, original))
  try {
    const attempt = await store.beginAttempt(prepareLedgerCriticalSpec({ spec: original }).binding), build = appender(store, attempt, original)
    const first = await build.created()
    await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: build.state }] })
    build.ledger.reserveRead('read-01', 20)
    await build.append({ kind: 'read-reservation', id: 'read-01', reservedBytes: 20 })
    const view = store.readOwned(build.prepared.binding)
    assert.equal(view.status, 'verified')
    const classification = classifyWorkflowLedger({ storageDirectory: directory, spec: original })
    assert.equal(classification.status, 'verified-nonterminal')
    if (classification.status === 'verified-nonterminal') {
      assert.deepEqual(classification.manifestAnchor?.reference, first.reference)
      assert.equal(classification.position.sequence, 2); assert.equal(classification.state.reads.length, 1)
    }
    await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: build.state }] })
    assert.equal(store.readOwned(build.prepared.binding).status, 'verified')
  } finally { await store.close() }
})

nativeTest('schema-valid projection and terminal-stage mismatches retain genuine host manifest-mismatch diagnostics', async directory => {
  const original = spec('mismatch'), store = await openWorkflowStore(options(directory, original))
  try {
    const attempt = await store.beginAttempt(prepareLedgerCriticalSpec({ spec: original }).binding), build = appender(store, attempt, original)
    await build.created()
    const schemaValid = { ...build.state, blocked: true }
    await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: schemaValid }] })
    assert.deepEqual(classifyWorkflowLedger({ storageDirectory: directory, spec: original }), { status: 'manifest-mismatch', reason: 'ledger' })
    await store.publish(attempt, { stage: 'cancelled', components: [{ kind: 'ledger', payload: build.state }] })
    assert.deepEqual(classifyWorkflowLedger({ storageDirectory: directory, spec: original }), { status: 'manifest-mismatch', reason: 'terminal' })
  } finally { await store.close() }
})

nativeTest('a missing manifest anchor fails generic archival reads while known-spec classification retains its anchor diagnostic', async directory => {
  const original = spec('missing-anchor'), store = await openWorkflowStore(options(directory, original, false))
  try {
    const prepared = prepareLedgerCriticalSpec({ spec: original }), attempt = await store.beginAttempt(prepared.binding)
    const build = appender(store, attempt, original)
    const state = exportBudgetLedgerState(build.ledger, createLedgerBinding(original, prepared.genesis))
    // Real W publication before the created journal yields a genuinely absent anchor.
    await store.publish(attempt, { stage: 'created', components: [{ kind: 'ledger', payload: state }] })
    await build.created()
    const exact = store.readOwned(prepared.binding)
    assert.equal(exact.status, 'verified')
    if (exact.status === 'verified') { assert.equal(exact.journal.length, 1); assert.equal(exact.manifest!.journalPosition, null) }
    assert.equal(readWorkflowStore(options(directory, original), prepared.binding).status, 'unavailable')
    assert.deepEqual(classifyWorkflowLedger({ storageDirectory: directory, spec: original }), { status: 'manifest-mismatch', reason: 'anchor' })
  } finally { await store.close() }
})

nativeTest('missing self-contained journal never falls back to the current payload-only schema validator', async directory => {
  const original = spec('no-journal'), prepared = prepareLedgerCriticalSpec({ spec: original })
  const store = await openWorkflowStore(options(directory, original))
  try {
    const attempt = await store.beginAttempt(prepared.binding), ledger = createBudgetLedger(original, { clock: () => 0, utcClock: () => 1_000 })
    const state = exportBudgetLedgerState(ledger, createLedgerBinding(original, prepared.genesis))
    await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: state }] })
    assert.equal(store.readOwned(prepared.binding).status, 'unavailable')
  } finally { await store.close() }
})

nativeTest("self-contained foreign original binding and provenance do not become this W component's historical spec", async directory => {
  const a = spec('outer-A'), b = spec('foreign-B', false)
  const store = await openWorkflowStore(options(directory, a))
  try {
    const attempt = await store.beginAttempt(prepareLedgerCriticalSpec({ spec: a }).binding)
    const foreign = appender(store, attempt, b), original = appender(store, attempt, a)
    // A genuine W outer record can carry independently codec-valid B data. Host read must bind both.
    await foreign.created()
    const ledger = createBudgetLedger(a, { clock: () => 0, utcClock: () => 1_000 })
    const state = exportBudgetLedgerState(ledger, createLedgerBinding(a, original.prepared.genesis))
    await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: state }] })
    assert.equal(store.readOwned(original.prepared.binding).status, 'unavailable')
  } finally { await store.close() }
})

nativeTest('an unknown journal schema remains unavailable even if an injected payload-only validator accepts it', async directory => {
  const original = spec('unknown-schema'), config = options(directory, original)
  const store = await openWorkflowStore({ ...config, validators: { ...config.validators, 'critical-journal': { schemaId: 'unknown-critical-v1', validate: () => true } } })
  try {
    const prepared = prepareLedgerCriticalSpec({ spec: original }), attempt = await store.beginAttempt(prepared.binding)
    await store.appendJournal(attempt, { opaque: true })
    const state = exportBudgetLedgerState(createBudgetLedger(original, { clock: () => 0, utcClock: () => 1_000 }), createLedgerBinding(original, prepared.genesis))
    await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: state }] })
    assert.equal(store.readOwned(prepared.binding).status, 'unavailable')
  } finally { await store.close() }
})

nativeTest('actual envelope outer-reference mismatch fails before accepting a historical ledger payload', async directory => {
  const original = spec('bad-reference'), store = await openWorkflowStore(options(directory, original))
  try {
    const attempt = await store.beginAttempt(prepareLedgerCriticalSpec({ spec: original }).binding), build = appender(store, attempt, original)
    await build.created()
    await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: build.state }] })
    sealBudgetLedger(build.ledger)
    await build.append({ kind: 'seal', outcome: 'cancelled' }, payload => {
      const provenance = { ...payload.provenance, previous: { ...payload.provenance.previous!, sha256: 'f'.repeat(64) } }
      const logicalPosition = ledgerCriticalPosition(build.prepared, provenance, payload.event)
      return { ...payload, provenance, logicalPosition, state: { ...payload.state, binding: createLedgerBinding(original, logicalPosition) } }
    })
    assert.equal(store.readOwned(build.prepared.binding).status, 'unavailable')
  } finally { await store.close() }
})

test('archive validator rejects forged contexts without reading payload accessors or granting authority', () => {
  let accessed = 0
  const payload = Object.defineProperty({}, 'binding', { get() { accessed++; throw Error('not-data') } })
  assert.equal(validateArchivedWorkflowLedger(payload, {} as WorkflowComponentReadContext), false)
  assert.equal(accessed, 0)
})

nativeTest('uniform original spec and complete causal fold are required even when every individual V1 envelope is codec-valid', async directory => {
  for (const kind of ['mixed-original', 'causal-drift'] as const) {
    const subdirectory = path.join(directory, kind); fs.mkdirSync(subdirectory)
    const a = spec('chain-A'), b = spec('chain-B', false), store = await openWorkflowStore(options(subdirectory, a))
    try {
      const attempt = await store.beginAttempt(prepareLedgerCriticalSpec({ spec: a }).binding), build = appender(store, attempt, a)
      await build.created()
      await store.publish(attempt, { stage: 'investigating', components: [{ kind: 'ledger', payload: build.state }] })
      if (kind === 'mixed-original') {
        const foreign = appender(store, attempt, b)
        sealBudgetLedger(foreign.ledger)
        await foreign.append({ kind: 'seal', outcome: 'cancelled' })
      } else {
        sealBudgetLedger(build.ledger)
        await build.append({ kind: 'seal', outcome: 'cancelled' }, payload => ({ ...payload, state: { ...payload.state, diagnostics: { ...payload.state.diagnostics, doubleSettlements: 1 } } }))
      }
      assert.equal(store.readOwned(build.prepared.binding).status, 'unavailable')
    } finally { await store.close() }
  }
})
