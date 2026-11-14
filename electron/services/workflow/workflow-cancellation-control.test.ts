import test, { before, after } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import type { RunSpec } from './run-spec.ts'
import type { ControlledRunSession, WorkflowCancellationControl } from './workflow-cancellation-control.ts'
import type { WorkflowLedgerJournalOptions } from './workflow-ledger-journal.ts'
import type { WorkflowStoreOptions, WorkflowStoreRead } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createWorkflowCancellationControl, closeWorkflowCancellationControl } from './workflow-cancellation-control.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createWorkflowLedgerJournal, WORKFLOW_LEDGER_STATE_SCHEMA_ID } from './workflow-ledger-journal.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunCoordinator } from './run-coordinator.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { openWorkflowStore, readWorkflowStore } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { prepareLedgerCriticalSpec, createLedgerCriticalPayloadValidator } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { validateLedgerState } from './ledger-state.ts'

const native = process.platform === 'win32'
const originalFetch = globalThis.fetch
let providerRequests = 0
before(() => { globalThis.fetch = async () => { providerRequests++; throw Error('Provider requests forbidden') } })
after(() => { globalThis.fetch = originalFetch; assert.equal(providerRequests, 0) })
function spec(runId = 'controlled-run', projectId = 'controlled-project', wallClockMs = 60_000): RunSpec {
  return createRunSpec({ version: 1, runId, projectId, snapshotId: 'snapshot-' + runId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: 'synthetic-profile', model: 'synthetic-model', endpointFingerprint: 'a'.repeat(64), protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 2_000 }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { wallClockMs } })
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false)
    return entry.isDirectory() ? files(filename) : [filename]
  })
}
function options(storageDirectory: string, original: RunSpec): WorkflowStoreOptions {
  return { storageDirectory, validators: { 'critical-journal': createLedgerCriticalPayloadValidator(), ledger: { schemaId: WORKFLOW_LEDGER_STATE_SCHEMA_ID, validate(value: unknown) { try { validateLedgerState(original, value); return true } catch { return false } } } } }
}
function read(directory: string, original: RunSpec) { return readWorkflowStore(options(directory, original), prepareLedgerCriticalSpec({ spec: original }).binding) }
function verified(view: WorkflowStoreRead) { assert.equal(view.status, 'verified'); if (view.status !== 'verified') throw Error('Expected genuine W view'); return view }
function terminal(directory: string, original: RunSpec, outcome: 'cancelled' | 'failed') {
  const view = verified(read(directory, original))
  const folded = foldLedgerCriticalPrefix(view.journal.map(item => ({ payload: item.payload, reference: item.reference })))
  assert.equal(folded.terminalOutcome, outcome)
  assert.equal(view.manifest?.stage, outcome)
  assert.deepEqual(view.manifest?.journalPosition, view.journal.at(-1)?.reference)
  assert.equal(view.components.length, 1)
  assert.deepEqual(view.components[0].payload, folded.state)
  assert.equal(folded.state?.blocked, true)
  assert.notEqual(folded.state?.time.terminalElapsedMs, null)
  assert.deepEqual(folded.state?.models, [])
  assert.deepEqual(folded.state?.reads, [])
  assert.deepEqual(folded.state?.tools, [])
  for (const item of view.journal) {
    const matching = files(path.join(directory, 'workflow-store', 'v1')).filter(file => path.basename(file) === item.reference.id + '.json')
    assert.equal(matching.length, 1)
    const bytes = fs.readFileSync(matching[0])
    assert.equal(bytes.length, item.reference.byteLength)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.reference.sha256)
  }
  return view
}
type Cleanup = (operation: () => Promise<void>) => void
function nativeTest(name: string, run: (directory: string, cleanup: Cleanup, t: TestContext) => Promise<void>) {
  test(name, { skip: !native, timeout: 120_000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-a2b-'))
    const cleanup: (() => Promise<void>)[] = []
    let passed = false
    try { await run(directory, operation => cleanup.push(operation), t); passed = true }
    finally {
      const closed = await Promise.allSettled(cleanup.reverse().map(operation => operation()))
      if (closed.some(item => item.status === 'rejected')) passed = false
      if (passed) {
        const absolute = path.resolve(directory)
        assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
        assert.match(path.basename(absolute), /^repoprep-a2b-/)
        assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false)
        const bytes = files(absolute).reduce((sum, file) => sum + fs.statSync(file).size, 0)
        fs.rmSync(absolute, { recursive: true })
        assert.equal(fs.existsSync(absolute), false)
        t.diagnostic('Cleaned verified synthetic fixture bytes=' + bytes)
      } else t.diagnostic('FAILED fixture retained: ' + directory)
      for (const result of closed) if (result.status === 'rejected') throw result.reason
    }
  })
}
async function controlled(directory: string, cleanup: Cleanup, original = spec(), extra: Partial<WorkflowLedgerJournalOptions> = {}, begin = {}) {
  const control = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original, ...extra })
  const coordinator = createRunCoordinator()
  const session = coordinator.begin(original, { cancellationControl: control, ...begin })!
  cleanup(() => session.close())
  return { control, coordinator, session, original }
}

nativeTest('factory token is empty frozen, exact-original bound, noncopyable and single-claim; raw A2a is not drain authority', async (directory, cleanup) => {
  const original = spec()
  const control = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original })
  assert.deepEqual(Reflect.ownKeys(control), [])
  assert.equal(Object.isFrozen(control), true)
  const coordinator = createRunCoordinator()
  for (const fake of [{}, Object.freeze({ ...control }), Object.create(control), new Proxy(control, {})]) {
    assert.throws(() => coordinator.begin(original, { cancellationControl: fake as WorkflowCancellationControl }))
  }
  assert.throws(() => coordinator.begin(spec('foreign-run'), { cancellationControl: control }))
  const rawDirectory = path.join(directory, 'raw-other-owner'); fs.mkdirSync(rawDirectory)
  const raw = await createWorkflowLedgerJournal({ storageDirectory: rawDirectory, spec: original })
  cleanup(() => raw.close())
  assert.throws(() => coordinator.begin(original, { cancellationControl: raw as unknown as WorkflowCancellationControl }))
  const mutableSpec = JSON.parse(JSON.stringify(original))
  const session = coordinator.begin(mutableSpec, { cancellationControl: control })!
  mutableSpec.runId = 'changed-run'; mutableSpec.projectId = 'changed-project'; mutableSpec.budget.total.wallClockMs = 1
  cleanup(() => session.close())
  assert.throws(() => createRunCoordinator().begin(original, { cancellationControl: control }))
  await assert.rejects(closeWorkflowCancellationControl(control), { code: 'invalid-argument' })
  await assert.rejects(session.resolveTerminal(), /accepted-work-not-sealed/)
  assert.equal(session.terminalStatus, null)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  assert.equal(session.cancel(), true)
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' })
  assert.throws(() => createRunCoordinator().begin(original, { cancellationControl: control }))
  assert.equal(coordinator.getActiveProjectRun(original.projectId), null)
  terminal(directory, original, 'cancelled')
})

nativeTest('cancel closes synchronously and retains slot through exact stage, async observer and terminal observer settlement', async (directory, cleanup) => {
  const original = spec()
  const stage = deferred(), observation = deferred(), terminalObservation = deferred(), reachedTerminal = deferred()
  const events: { type: string; sequence: number }[] = []
  const control = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original })
  const coordinator = createRunCoordinator()
  const session = coordinator.begin(original, { cancellationControl: control, onEvent(event) {
    events.push(event)
    if (event.type === 'stage-started' && event.stage === 'scanning') return observation.promise
    if (event.type === 'terminal') { reachedTerminal.resolve(); return terminalObservation.promise }
  } })!
  cleanup(() => session.close())
  let commits = 0, stageEntered = false
  const pending = session.execute('scanning', async context => {
    stageEntered = true
    assert.throws(() => context.commit(() => { commits++ }), /controlled-run-commit-unavailable/)
    await stage.promise
  })
  const rejected = assert.rejects(pending, /run-cancelled/)
  try {
    assert.equal(stageEntered, true)
    assert.throws(() => session.succeed({ secret: true }), /controlled-run-result-unavailable/)
    assert.equal(commits, 0)
    assert.equal(session.cancel(), true)
    assert.equal(session.signal.aborted, true)
    assert.equal(session.terminalStatus, null)
    assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
    const resolution = session.resolveTerminal()
    await tick()
    assert.equal(verified(read(directory, original)).journal.length, 1)
    stage.resolve(); await rejected; await tick()
    assert.equal(session.terminalStatus, null)
    assert.equal(verified(read(directory, original)).journal.length, 1)
    observation.resolve()
    await reachedTerminal.promise
    assert.equal(session.terminalStatus, 'cancelled')
    assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
    assert.equal(coordinator.begin(spec('blocked-next-run', original.projectId)), null)
    terminalObservation.resolve()
    assert.deepEqual(await resolution, { status: 'accepted', outcome: 'cancelled' })
    assert.equal(coordinator.getActiveProjectRun(original.projectId), null)
    assert.equal(session.result, null)
    assert.equal(events.filter(event => event.type === 'terminal').length, 1)
    assert.deepEqual(events.map(event => event.sequence), events.map((_event, i) => i + 1))
    terminal(directory, original, 'cancelled')
  } finally { stage.resolve(); observation.resolve(); terminalObservation.resolve(); await rejected }
})


nativeTest('deadline and actual stage failure seal admission but wait pending stage or observer leases', async (directory, cleanup) => {
  for (const mode of ['deadline', 'stage-failure'] as const) {
    const child = path.join(directory, mode); fs.mkdirSync(child)
    let time = 0
    const original = spec(mode, 'project-' + mode, 60_000)
    const stage = deferred(), observation = deferred()
    const control = await createWorkflowCancellationControl({ storageDirectory: child, spec: original })
    const coordinator = createRunCoordinator({ clock: () => time })
    const session = coordinator.begin(original, { cancellationControl: control, onEvent(event) { if (event.type === 'stage-started' && event.stage === 'scanning') return observation.promise } })!
    cleanup(() => session.close())
    const pending = session.execute('scanning', async () => {
      if (mode === 'stage-failure') throw Error('synthetic-stage-failure')
      await stage.promise
    })
    const failed = assert.rejects(pending, mode === 'stage-failure' ? /synthetic-stage-failure/ : /run-terminal/)
    try {
      if (mode === 'deadline') {
        time = original.budget.total.wallClockMs
        assert.throws(() => session.assertActive(), /run-deadline-exceeded/)
      } else await failed
      assert.equal(session.signal.aborted, true)
      assert.equal(session.terminalStatus, null)
      assert.equal(session.cancel(), false)
      const resolution = session.resolveTerminal()
      await tick()
      assert.equal(verified(read(child, original)).journal.length, 1)
      stage.resolve(); await failed
      assert.equal(session.terminalStatus, null)
      assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
      observation.resolve()
      assert.deepEqual(await resolution, { status: 'accepted', outcome: 'failed' })
      assert.equal(session.terminalStatus, 'failed')
      assert.equal(coordinator.getActiveProjectRun(original.projectId), null)
      terminal(child, original, 'failed')
    } finally { stage.resolve(); observation.resolve(); await failed }
  }
})

nativeTest('manifest-flushed acknowledgement loss accepts the actual outcome over a competing reason', async (directory, cleanup) => {
  let session!: ControlledRunSession
  let lost = false
  const events: string[] = []
  const original = spec()
  const control = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original, onDurableStep(step) {
    if (step === 'manifest-flushed' && !lost) { lost = true; assert.equal(session.fail(), false); throw Error('synthetic-ack-loss') }
  } })
  const coordinator = createRunCoordinator()
  session = coordinator.begin(original, { cancellationControl: control, onEvent(event) { if (event.type === 'terminal') events.push(event.status!) } })!
  cleanup(() => session.close())
  assert.equal(session.cancel(), true)
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' })
  assert.equal(lost, true)
  assert.equal(session.fail(), false)
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' })
  assert.deepEqual(events, ['cancelled'])
  const view = terminal(directory, original, 'cancelled')
  assert.equal(view.journal.length, 3)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), null)
})

nativeTest('seal-flushed acknowledgement loss is pending without manifest, then metadata retry preserves its fixed outcome', async (directory, cleanup) => {
  let journal = 0, lose = true
  const { original, session, coordinator } = await controlled(directory, cleanup, spec(), { onDurableStep(step) {
    if (step === 'journal-flushed' && ++journal === 3 && lose) { lose = false; throw Error('synthetic-seal-ack-loss') }
  } })
  assert.equal(session.cancel(), true)
  assert.deepEqual(await session.resolveTerminal(), { status: 'pending' })
  const sealed = verified(read(directory, original))
  assert.equal(sealed.manifest, null)
  assert.equal(foldLedgerCriticalPrefix(sealed.journal.map(item => ({ payload: item.payload, reference: item.reference }))).terminalOutcome, 'cancelled')
  assert.equal(session.terminalStatus, null)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  assert.equal(session.fail(), false)
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' })
  const view = terminal(directory, original, 'cancelled')
  assert.equal(view.journal.length, 4)
  assert.deepEqual(view.journal.map(item => (item.payload as { event: { kind: string } }).event.kind), ['created', 'recovery', 'seal', 'recovery'])
})

nativeTest('torn newest journal remains pending with no older prefix fallback or slot release', async (directory, cleanup) => {
  let journal = 0
  const { original, coordinator, session } = await controlled(directory, cleanup, spec(), { onDurableStep(step) {
    if (step === 'journal-opened' && ++journal === 2) throw Error('synthetic-torn-journal')
  } })
  session.cancel()
  assert.deepEqual(await session.resolveTerminal(), { status: 'pending' })
  assert.equal(read(directory, original).status, 'unavailable')
  const before = files(directory).map(file => [file, fs.statSync(file).size])
  assert.deepEqual(await session.resolveTerminal(), { status: 'pending' })
  assert.deepEqual(files(directory).map(file => [file, fs.statSync(file).size]), before)
  assert.equal(session.terminalStatus, null)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  await session.close()
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
})

nativeTest('resolver rejects its own active stage and observer leases; a stale continuation cannot release a newer slot', async (directory, cleanup) => {
  const original = spec()
  const control = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original })
  const coordinator = createRunCoordinator()
  let session!: ControlledRunSession
  const trigger = deferred(), observerDone = deferred()
  const oldContinuation = deferred(), continuationDone = deferred()
  session = coordinator.begin(original, { cancellationControl: control, onEvent: async event => {
    if (event.type === 'stage-started' && event.stage === 'scanning') {
      await trigger.promise
      await assert.rejects(session.resolveTerminal(), /accepted-work-self-wait/)
      observerDone.resolve()
    }
    if (event.type === 'terminal') await assert.rejects(session.resolveTerminal(), /accepted-work-self-wait/)
  } })!
  cleanup(() => session.close())
  const pending = session.execute('scanning', async context => {
    session.cancel()
    trigger.resolve()
    await assert.rejects(session.resolveTerminal(), /accepted-work-self-wait/)
    await assert.rejects(session.close(), /accepted-work-self-wait/)
    void oldContinuation.promise.then(() => {
      assert.equal(session.cancel(), false)
      assert.throws(() => context.commit(() => assert.fail('forbidden effect')), /controlled-run-commit-unavailable/)
      continuationDone.resolve()
    })
  })
  await assert.rejects(pending, /run-cancelled/)
  await observerDone.promise
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' })
  const next = coordinator.begin(spec('next-run', original.projectId))!
  oldContinuation.resolve(); await continuationDone.promise
  assert.equal(coordinator.getActiveProjectRun(original.projectId), 'next-run')
  next.cancel()
})

nativeTest('true close waits actual W write/listener; independent owner and closing tokens remain protected', async (directory, cleanup) => {
  const flushed = deferred(), release = deferred()
  let hold = true
  const original = spec()
  const { control, coordinator, session } = await controlled(directory, cleanup, original, { onDurableStep(step) {
    if (step === 'manifest-flushed' && hold) { hold = false; flushed.resolve(); return release.promise }
  } })
  session.cancel()
  await flushed.promise
  let closed = false
  const close = session.close().then(() => { closed = true })
  try {
    await tick()
    assert.equal(closed, false)
    assert.equal(session.terminalStatus, null)
    assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
    await assert.rejects(openWorkflowStore(options(directory, original)), { code: 'owner-unavailable' })
    assert.throws(() => createRunCoordinator().begin(original, { cancellationControl: control }))
    release.resolve(); await close
    assert.equal(closed, true)
    const reopened = await openWorkflowStore(options(directory, original))
    await reopened.close()
    terminal(directory, original, 'cancelled')
  } finally { release.resolve(); await close }
})

nativeTest('unclaimed closing token cannot be claimed; shared/raw handles cannot substitute ownership', async (directory, cleanup) => {
  const original = spec()
  const control = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original })
  await assert.rejects(createWorkflowCancellationControl({ storageDirectory: directory, spec: spec('other-run') }), { code: 'unreadable' })
  const closed = closeWorkflowCancellationControl(control)
  assert.throws(() => createRunCoordinator().begin(original, { cancellationControl: control }))
  await closed
  cleanup(() => closeWorkflowCancellationControl(control))
})

nativeTest('readOwned checks the real owner on both sides and does not wait or drain an in-flight write', async (directory, cleanup) => {
  const held = deferred(), release = deferred()
  let pause = true
  const original = spec(), prepared = prepareLedgerCriticalSpec({ spec: original })
  const store = await openWorkflowStore({ ...options(directory, original), onDurableStep(step) {
    if (step === 'attempt-marker-opened' && pause) { pause = false; held.resolve(); return release.promise }
  } })
  cleanup(() => store.close())
  const attempt = store.beginAttempt(prepared.binding)
  const rejected = assert.rejects(attempt)
  await held.promise
  try {
    // Returning while this actual write is still paused proves it is no barrier.
    assert.equal(store.readOwned(prepared.binding).status, 'unavailable')
    const close = store.close()
    assert.throws(() => store.readOwned(prepared.binding), { code: 'revoked' })
    release.resolve(); await rejected; await close
    assert.doesNotThrow(() => store.read(prepared.binding))
  } finally { release.resolve(); await rejected }
})


nativeTest('lost genuine owner exclusion stays pending and close never releases an unrelated real owner', async (directory, cleanup) => {
  const original = spec()
  const { coordinator, session } = await controlled(directory, cleanup, original)
  const independentDirectory = path.join(directory, 'independent'); fs.mkdirSync(independentDirectory)
  const independent = await openWorkflowStore(options(independentDirectory, original))
  cleanup(() => independent.close())
  const marker = files(directory).find(file => path.basename(file) === 'o-000000000001.json' && !file.includes('independent'))!
  assert.ok(marker)
  fs.appendFileSync(marker, ' ')
  session.cancel()
  assert.deepEqual(await session.resolveTerminal(), { status: 'pending' })
  assert.deepEqual(await session.resolveTerminal(), { status: 'pending' })
  assert.equal(session.terminalStatus, null)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  await session.close()
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  assert.equal(independent.readOwned(prepareLedgerCriticalSpec({ spec: original }).binding).status, 'absent')
})

nativeTest('readOwned rechecks owner after production read, including reentrant validator owner revocation', async (directory, cleanup) => {
  let revoke = false, closed: Promise<void> | null = null
  const original = spec(), binding = prepareLedgerCriticalSpec({ spec: original }).binding
  const store = await openWorkflowStore({ storageDirectory: directory, validators: { ledger: { schemaId: 'owned-test-v1', validate(value) {
    if (revoke) closed = store.close()
    return !!value && typeof value === 'object' && (value as { held: unknown }).held === 5
  } } } })
  cleanup(() => store.close())
  const attempt = await store.beginAttempt(binding)
  await store.publish(attempt, { stage: 'cancelled', components: [{ kind: 'ledger', payload: { held: 5 } }] })
  assert.equal(store.readOwned(binding).status, 'verified', 'owner checks do not depend on now-terminal attempt currentness')
  revoke = true
  assert.throws(() => store.readOwned(binding), { code: 'revoked' })
  await closed
})


nativeTest('real coordinator deadline timer aborts and retains the slot until its actual stage settles', async (directory, cleanup) => {
  const original = spec(), stage = deferred(), aborted = deferred()
  let time = 0
  const control = await createWorkflowCancellationControl({ storageDirectory: directory, spec: original })
  const coordinator = createRunCoordinator({ clock: () => time })
  const session = coordinator.begin(original, { cancellationControl: control, onEvent(event) {
    if (event.type === 'stage-started' && event.stage === 'created') time = original.budget.total.wallClockMs - 1
  } })!
  cleanup(() => session.close())
  session.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
  const pending = session.execute('scanning', () => stage.promise)
  const rejected = assert.rejects(pending, /run-terminal/)
  try {
    await aborted.promise
    assert.equal(session.signal.aborted, true)
    assert.equal(session.terminalStatus, null)
    assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
    assert.equal(verified(read(directory, original)).journal.length, 1)
    stage.resolve(); await rejected
    assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'failed' })
    terminal(directory, original, 'failed')
  } finally { stage.resolve(); await rejected }
})
