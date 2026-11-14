import test, { before, after } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { LlmProfile } from '../../../shared/types.ts'
import type { RunSpec } from './run-spec.ts'
import type { ControlledRunSession, RunCoordinatorEvent } from './run-coordinator.ts'
import type { OriginalWorkflowRun, OriginalWorkflowRunOptions, WorkflowCancellationControl } from './workflow-ledger-journal.ts'
import type { WorkflowStoreOptions } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createWorkflowOriginalRun, WORKFLOW_LEDGER_STATE_SCHEMA_ID } from './workflow-ledger-journal.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunCoordinator } from './run-coordinator.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { openWorkflowStore, readWorkflowStore } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { prepareLedgerCriticalSpec, createLedgerCriticalPayloadValidator } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { validateLedgerState } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { normalizeBaseUrl } from '../llm.ts'

const native = process.platform === 'win32'
const secret = 'B03A_SYNTHETIC_KEY_NEVER_PERSIST'
const profile: LlmProfile = Object.freeze({ id: 'b03a-profile', name: 'Synthetic only', baseUrl: 'https://b03a.invalid/v1', apiKey: secret, model: 'synthetic', protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 4_096 })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function spec(runId = 'b03a-run', projectId = 'b03a-project', wallClockMs = 60_000): RunSpec {
  return createRunSpec({ version: 1, runId, projectId, snapshotId: 'snapshot-' + runId, strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: hash(normalizeBaseUrl(profile.baseUrl)), protocol: profile.protocol, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens }, promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1', budget: { wallClockMs } })
}
let fetchCalls = 0, transportCalls = 0
const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { fetchCalls++; throw Error('Network forbidden') } })
after(() => { globalThis.fetch = originalFetch; assert.equal(fetchCalls, 0); assert.equal(transportCalls, 0) })
const forbiddenTransport: NonNullable<OriginalWorkflowRunOptions['transport']> = async () => { transportCalls++; throw Error('Dormant transport forbidden') }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false)
    return entry.isDirectory() ? files(filename) : [filename]
  })
}
function storeOptions(storageDirectory: string, original: RunSpec): WorkflowStoreOptions {
  return { storageDirectory, validators: { 'critical-journal': createLedgerCriticalPayloadValidator(), ledger: { schemaId: WORKFLOW_LEDGER_STATE_SCHEMA_ID, validate(payload: unknown) { try { validateLedgerState(original, payload); return true } catch { return false } } } } }
}
function verified(directory: string, original: RunSpec) {
  const view = readWorkflowStore(storeOptions(directory, original), prepareLedgerCriticalSpec({ spec: original }).binding)
  assert.equal(view.status, 'verified')
  if (view.status !== 'verified') throw Error('Expected genuine W read')
  for (const entry of view.journal) {
    const actual = files(directory).filter(filename => path.basename(filename) === entry.reference.id + '.json')
    assert.equal(actual.length, 1)
    const bytes = fs.readFileSync(actual[0])
    assert.equal(bytes.length, entry.reference.byteLength)
    assert.equal(hash(bytes), entry.reference.sha256)
    assert.equal(bytes.includes(Buffer.from(secret)), false)
  }
  const folded = foldLedgerCriticalPrefix(view.journal.map(item => ({ payload: item.payload, reference: item.reference })))
  return { view, folded }
}
function terminal(directory: string, original: RunSpec, outcome: 'cancelled' | 'failed') {
  const { view, folded } = verified(directory, original)
  assert.equal(view.manifest?.stage, outcome)
  assert.equal(folded.terminalOutcome, outcome)
  assert.deepEqual(view.manifest?.journalPosition, view.journal.at(-1)?.reference)
  assert.equal(view.components.length, 1)
  assert.equal(view.components[0].reference.kind, 'ledger')
  assert.deepEqual(view.components[0].payload, folded.state)
  assert.deepEqual(folded.state?.models, [])
  assert.deepEqual(folded.state?.reads, [])
  assert.deepEqual(folded.state?.tools, [])
  return { view, folded }
}
type Cleanup = (operation: () => Promise<void>) => void
function nativeTest(name: string, run: (directory: string, cleanup: Cleanup, t: TestContext) => Promise<void>) {
  test(name, { skip: !native, timeout: 60_000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-b03a-'))
    const cleanup: (() => Promise<void>)[] = []
    try { await run(directory, operation => cleanup.push(operation), t) }
    finally {
      const results = []
      for (const operation of cleanup.reverse()) { try { await operation() } catch (error) { results.push(error) } }
      // Preserve all fixtures and failures for the parent review; no deletion in this task.
      t.diagnostic('Retained synthetic W fixture: ' + directory + '; bytes=' + files(directory).reduce((sum, filename) => sum + fs.statSync(filename).size, 0))
      assert.equal(fetchCalls, 0)
      assert.equal(transportCalls, 0)
      if (results.length) throw new AggregateError(results, 'Fixture close failed')
    }
  })
}
function factory(storageDirectory: string, original = spec(), extra: Partial<OriginalWorkflowRunOptions> = {}) {
  return createWorkflowOriginalRun({ storageDirectory, spec: original, profile, transport: forbiddenTransport, ...extra })
}

test('preflight rejects option/owner/receipt adoption and accessors before storage or transport', async () => {
  const base = { storageDirectory: 'not-an-openable-store', spec: spec(), profile, transport: forbiddenTransport }
  let getters = 0, durableSteps = 0
  for (const key of ['ledger', 'journal', 'owner', 'attempt', 'gateway', 'plan', 'receipt', 'capability']) {
    await assert.rejects(createWorkflowOriginalRun({ ...base, [key]: {} } as OriginalWorkflowRunOptions), { code: 'invalid-argument' })
  }
  for (const key of ['storageDirectory', 'spec', 'profile', 'transport', 'onDurableStep']) {
    const accessor = Object.defineProperty({ ...base }, key, { enumerable: true, get() { getters++; throw Error(secret) } })
    await assert.rejects(createWorkflowOriginalRun(accessor), { code: 'invalid-argument' })
  }
  for (const key of ['id', 'name', 'apiKey', 'baseUrl', 'model', 'protocol']) {
    const accessor = Object.defineProperty({ ...profile }, key, { enumerable: true, get() { getters++; throw Error(secret) } })
    await assert.rejects(createWorkflowOriginalRun({ ...base, profile: accessor, onDurableStep() { durableSteps++ } }), { code: 'invalid-argument' })
  }
  await assert.rejects(createWorkflowOriginalRun({ ...base, transport: {} } as unknown as OriginalWorkflowRunOptions), { code: 'invalid-argument' })
  await assert.rejects(createWorkflowOriginalRun({ ...base, profile: { ...profile, apiKey: {} } } as unknown as OriginalWorkflowRunOptions), { code: 'invalid-argument' })
  await assert.rejects(createWorkflowOriginalRun({ ...base, profile: { ...profile, model: 'other' }, onDurableStep() { durableSteps++ } }), { code: 'configuration-changed' })
  assert.equal(getters, 0)
  assert.equal(durableSteps, 0)
})

nativeTest('F01 actual factory creates one original journal, exposes only dormant observations, cancels through real controller', async (directory, cleanup) => {
  const original = spec()
  const run = await factory(directory, original)
  assert.equal(Object.isFrozen(run), true)
  assert.deepEqual(Reflect.ownKeys(run).sort(), ['cancellationControl', 'closeUnclaimed', 'observe'])
  assert.equal(Object.isFrozen(run.cancellationControl), true)
  assert.deepEqual(Reflect.ownKeys(run.cancellationControl), [])
  assert.deepEqual(run.observe(), { mode: 'dormant-original-run-v1', durable: true, generationAdmission: 'unavailable', terminalSupport: 'cancellation-only' })
  assert.equal(Object.isFrozen(run.observe()), true)
  assert.equal(JSON.stringify(run).includes(secret), false)
  const initial = verified(directory, original)
  assert.equal(initial.view.manifest, null)
  assert.equal(initial.view.journal.length, 1)
  assert.equal(initial.folded.terminalOutcome, null)
  assert.equal((initial.view.journal[0].payload as { originalSpecJson: string }).originalSpecJson, prepareLedgerCriticalSpec({ spec: original }).originalSpecJson)
  const coordinator = createRunCoordinator()
  const session = coordinator.begin(original, { cancellationControl: run.cancellationControl })!
  cleanup(() => session.close())
  assert.equal(session.cancel(), true)
  assert.equal(session.signal.aborted, true)
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' })
  assert.equal(coordinator.getActiveProjectRun(original.projectId), null)
  terminal(directory, original, 'cancelled')
  for (const filename of files(directory)) assert.equal(fs.readFileSync(filename).includes(Buffer.from(secret)), false)
})

nativeTest('F02 actual token cannot be copied, adopted, mismatched or claimed twice', async (directory, cleanup) => {
  const original = spec()
  const run = await factory(directory, original)
  const coordinator = createRunCoordinator()
  for (const fake of [{}, { ...run.cancellationControl }, JSON.parse(JSON.stringify(run.cancellationControl)), Object.create(run.cancellationControl), new Proxy(run.cancellationControl, {}), run]) {
    assert.throws(() => coordinator.begin(original, { cancellationControl: fake as WorkflowCancellationControl }))
  }
  assert.throws(() => coordinator.begin(spec('foreign'), { cancellationControl: run.cancellationControl }))
  const session = coordinator.begin(original, { cancellationControl: run.cancellationControl })!
  cleanup(() => session.close())
  assert.throws(() => createRunCoordinator().begin(original, { cancellationControl: run.cancellationControl }))
  await assert.rejects(run.closeUnclaimed(), { code: 'invalid-argument' })
  session.cancel()
  await session.resolveTerminal()
  terminal(directory, original, 'cancelled')
})

nativeTest('F03 caller spec/profile mutation during W creation cannot alter captured original run', async (directory, cleanup) => {
  const original = spec()
  const mutableSpec = JSON.parse(JSON.stringify(original))
  const mutableProfile = { ...profile }
  const entered = deferred(), release = deferred()
  const pending = factory(directory, mutableSpec, { profile: mutableProfile, async onDurableStep(step) { if (step === 'journal-flushed') { entered.resolve(); await release.promise } } })
  await entered.promise
  mutableSpec.runId = 'replaced'; mutableSpec.model.model = 'foreign'; mutableSpec.budget.total.wallClockMs = 1
  mutableProfile.model = 'foreign'; mutableProfile.apiKey = 'mutated-' + secret
  release.resolve()
  const run = await pending
  const session = createRunCoordinator().begin(original, { cancellationControl: run.cancellationControl })!
  cleanup(() => session.close())
  session.cancel()
  await session.resolveTerminal()
  terminal(directory, original, 'cancelled')
})

nativeTest('F04 original lifetime drains actual stage/observer thenables before terminal and project release', async (directory, cleanup) => {
  const original = spec()
  const run = await factory(directory, original)
  const stage = deferred(), observer = deferred(), terminalObserver = deferred(), terminalEntered = deferred()
  const events: RunCoordinatorEvent[] = []
  const coordinator = createRunCoordinator()
  const session = coordinator.begin(original, { cancellationControl: run.cancellationControl, onEvent(event) {
    events.push(event)
    if (event.type === 'stage-started' && event.stage === 'scanning') return { then(resolve: () => void) { void observer.promise.then(resolve) } }
    if (event.type === 'terminal') { terminalEntered.resolve(); return terminalObserver.promise }
  } })!
  cleanup(async () => { stage.resolve(); observer.resolve(); terminalObserver.resolve(); await session.close() })
  const work = session.execute('scanning', context => {
    assert.equal(context.signal, session.signal)
    return stage.promise
  })
  const rejected = assert.rejects(work, /run-cancelled/)
  assert.equal(session.cancel(), true)
  assert.equal(session.signal.aborted, true)
  await assert.rejects(session.execute('investigating', () => undefined), /run-cancelled/)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  let resolved = false
  const resolution = session.resolveTerminal().then(value => { resolved = true; return value })
  await tick()
  assert.equal(resolved, false)
  stage.resolve()
  await rejected
  await tick()
  assert.equal(session.terminalStatus, null)
  assert.equal(verified(directory, original).view.manifest, null)
  observer.resolve()
  await terminalEntered.promise
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  assert.equal(resolved, false)
  terminalObserver.resolve()
  assert.deepEqual(await resolution, { status: 'accepted', outcome: 'cancelled' })
  assert.equal(events.filter(event => event.type === 'terminal').length, 1)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), null)
  terminal(directory, original, 'cancelled')
})

nativeTest('F05 shared original registry rejects active stage/observer and terminal self-wait', async (directory, cleanup) => {
  const original = spec()
  const run = await factory(directory, original)
  const trigger = deferred(), observerDone = deferred()
  let session!: ControlledRunSession
  session = createRunCoordinator().begin(original, { cancellationControl: run.cancellationControl, onEvent: async event => {
    if (event.type === 'stage-started' && event.stage === 'scanning') {
      await trigger.promise
      await assert.rejects(session.resolveTerminal(), /accepted-work-self-wait/)
      observerDone.resolve()
    }
    if (event.type === 'terminal') await assert.rejects(session.resolveTerminal(), /accepted-work-self-wait/)
  } })!
  cleanup(async () => { trigger.resolve(); await session.close() })
  const work = session.execute('scanning', async () => {
    session.cancel(); trigger.resolve()
    await assert.rejects(session.resolveTerminal(), /accepted-work-self-wait/)
    await assert.rejects(session.close(), /accepted-work-self-wait/)
  })
  await assert.rejects(work, /run-cancelled/)
  await observerDone.promise
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'cancelled' })
  terminal(directory, original, 'cancelled')
})

nativeTest('F06 dormant factory never enables legacy result commit or succeeded terminal', async (directory, cleanup) => {
  const original = spec()
  const run = await factory(directory, original)
  const session = createRunCoordinator().begin(original, { cancellationControl: run.cancellationControl })!
  cleanup(() => session.close())
  assert.throws(() => session.succeed({ arbitrary: true }), /controlled-run-result-unavailable/)
  assert.equal(session.result, null)
  assert.equal(session.terminalStatus, null)
  await session.execute('scanning', context => { assert.throws(() => context.commit(() => secret), /controlled-run-commit-unavailable/) })
  assert.equal(verified(directory, original).view.manifest, null)
  session.fail()
  assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'failed' })
  terminal(directory, original, 'failed')
})

nativeTest('F07 unclaimed disposal and failed genuine initialization release actual W ownership', async (directory, cleanup) => {
  const original = spec()
  const run = await factory(directory, original)
  await run.closeUnclaimed()
  await run.closeUnclaimed()
  assert.throws(() => createRunCoordinator().begin(original, { cancellationControl: run.cancellationControl }))
  const nextOwner = await openWorkflowStore(storeOptions(directory, original))
  await nextOwner.close()
  const failing = path.join(directory, 'failure'); fs.mkdirSync(failing)
  await assert.rejects(factory(failing, spec('fault'), { onDurableStep(step) { if (step === 'journal-flushed') throw Error(secret) } }), error => {
    assert.equal((error as { code: string }).code, 'unreadable')
    assert.equal(String(error).includes(secret), false)
    return true
  })
  const afterFault = await openWorkflowStore(storeOptions(failing, spec('fault')))
  cleanup(() => afterFault.close())
  const view = verified(failing, spec('fault'))
  assert.equal(view.view.manifest, null)
  assert.equal(view.view.journal.length, 1)
})

nativeTest('F08 torn newest journal keeps original pending slot and prevents replacement', async (directory, cleanup) => {
  const original = spec()
  let journals = 0
  const run = await factory(directory, original, { onDurableStep(step) { if (step === 'journal-opened' && ++journals === 2) throw Error('synthetic torn record') } })
  const coordinator = createRunCoordinator()
  const session = coordinator.begin(original, { cancellationControl: run.cancellationControl })!
  cleanup(() => session.close())
  session.cancel()
  assert.deepEqual(await session.resolveTerminal(), { status: 'pending' })
  assert.equal(session.terminalStatus, null)
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
  assert.equal(coordinator.begin(spec('replacement', original.projectId)), null)
  const before = files(directory).map(filename => [filename, fs.statSync(filename).size])
  assert.deepEqual(await session.resolveTerminal(), { status: 'pending' })
  assert.deepEqual(files(directory).map(filename => [filename, fs.statSync(filename).size]), before)
  await session.close()
  await assert.rejects(factory(directory, original), { code: 'unreadable' })
  assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
})

nativeTest('original deadline covers initialization, with no token issued after expiry', async (directory) => {
  const realNow = Date.now, anchor = realNow()
  let utc = anchor
  let run: OriginalWorkflowRun | undefined
  try {
    // The ledger captures this one function; advance its captured value, not Date.now.
    Date.now = () => utc
    const pending = factory(directory, spec('expired-construction', 'project', 10_000), { onDurableStep(step) { if (step === 'journal-flushed') utc = anchor + 10_001 } }).then(created => { run = created; return created })
    await assert.rejects(pending, { code: 'budget-exhausted' })
  } finally {
    try { if (run) await run.closeUnclaimed() } finally { Date.now = realNow }
  }
  const owner = await openWorkflowStore(storeOptions(directory, spec('expired-construction', 'project', 10_000)))
  await owner.close()
})

nativeTest('original deadline rejects expired claim without consuming token or resetting allowance', async (directory) => {
  const original = spec('expired-claim', 'project', 10_000)
  const realNow = Date.now, anchor = realNow()
  let utc = anchor
  let run: OriginalWorkflowRun | undefined, session: ControlledRunSession | null | undefined
  try {
    Date.now = () => utc
    run = await factory(directory, original)
    utc = anchor + 10_001
    assert.throws(() => { session = createRunCoordinator().begin(original, { cancellationControl: run!.cancellationControl }) }, { code: 'budget-exhausted' })
    assert.equal(verified(directory, original).view.manifest, null)
  } finally {
    try { if (session) await session.close(); else if (run) await run.closeUnclaimed() } finally { Date.now = realNow }
  }
})

nativeTest('delayed claim uses remaining original deadline, including with a fresh coordinator clock', async (directory) => {
  const original = spec()
  const realNow = Date.now, anchor = realNow()
  let utc = anchor
  let run: OriginalWorkflowRun | undefined, session: ControlledRunSession | null | undefined
  try {
    Date.now = () => utc
    run = await factory(directory, original)
    utc = anchor + 10_000
    let time = 0
    session = createRunCoordinator({ clock: () => time }).begin(original, { cancellationControl: run.cancellationControl })!
    time = 55_000
    assert.throws(() => session!.assertActive(), /run-deadline-exceeded/)
    assert.equal(session.signal.aborted, true)
    assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'failed' })
    await session.close()
    terminal(directory, original, 'failed')
  } finally {
    try { if (session) await session.close(); else if (run) await run.closeUnclaimed() } finally { Date.now = realNow }
  }
})

nativeTest('claim-boundary original expiry synchronously closes signal before any business event', async (directory) => {
  const original = spec()
  const realNow = Date.now, anchor = realNow()
  let utc = anchor, remainingReads = Number.POSITIVE_INFINITY
  let run: OriginalWorkflowRun | undefined, session: ControlledRunSession | null | undefined
  try {
    // First claim sample is healthy; the next original-ledger sample expires.
    Date.now = () => { if (remainingReads-- === 0) utc = anchor + original.budget.total.wallClockMs + 1; return utc }
    run = await factory(directory, original)
    const events: RunCoordinatorEvent[] = []
    const coordinator = createRunCoordinator({ onEvent(event) { events.push(event) } })
    remainingReads = 1
    session = coordinator.begin(original, { cancellationControl: run.cancellationControl })!
    assert.equal(session.signal.aborted, true)
    assert.equal(events.length, 0)
    assert.equal(session.terminalStatus, null)
    assert.equal(coordinator.getActiveProjectRun(original.projectId), original.runId)
    await assert.rejects(session.execute('scanning', () => undefined), /run-terminal/)
    assert.deepEqual(await session.resolveTerminal(), { status: 'accepted', outcome: 'failed' })
    assert.deepEqual(events.map(event => event.type), ['terminal'])
    terminal(directory, original, 'failed')
  } finally {
    try { if (session) await session.close(); else if (run) await run.closeUnclaimed() } finally { Date.now = realNow }
  }
})
