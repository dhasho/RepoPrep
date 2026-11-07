import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunCoordinator, RUN_STAGES, type RunSession, type RunStage } from './run-coordinator.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunSpec, type RunSpec } from './run-spec.ts'

function spec(runId = 'run-01', projectId = 'project-01', wallClockMs = 60_000): RunSpec {
  return createRunSpec({
    version: 1, runId, projectId, snapshotId: `snapshot-${runId}`, strategy: 'agentic', strategyVersion: 'agentic-v1',
    roleFocus: 'backend', granularity: 'fine',
    model: { profileId: 'synthetic-profile', model: 'synthetic-model', endpointFingerprint: 'a'.repeat(64), protocol: 'openai', contextWindowTokens: 49_152, maxOutputTokens: 2_000 },
    promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1',
    budget: { wallClockMs }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function advance(session: RunSession, stages: readonly RunStage[]): Promise<void> {
  for (const stage of stages) await session.execute(stage, () => undefined)
}

const setupStages: Readonly<Record<RunStage, readonly RunStage[]>> = {
  created: [],
  scanning: [],
  investigating: ['scanning'],
  tool: ['scanning', 'investigating'],
  packing: ['scanning', 'investigating'],
  generating: ['scanning', 'investigating', 'packing'],
  validating: ['scanning', 'investigating', 'packing', 'generating'],
  reviewing: ['scanning', 'investigating', 'packing', 'generating', 'validating'],
  revising: ['scanning', 'investigating', 'packing', 'generating', 'validating', 'reviewing'],
  persisting: ['scanning', 'investigating', 'packing', 'generating', 'validating']
}

test('late completion in every phase is suppressed after cancellation', async () => {
  for (const stage of RUN_STAGES.filter((item): item is Exclude<RunStage, 'created'> => item !== 'created')) {
    const events: Array<Record<string, unknown>> = []
    const coordinator = createRunCoordinator({ onEvent: event => events.push(event) })
    const session = coordinator.begin(spec(`late-${stage}`))!
    await advance(session, setupStages[stage])
    const wait = deferred<string>()
    let writes = 0
    const pending = session.execute(stage, async context => {
      await wait.promise
      context.commit(() => { writes++ })
      return 'late-private-result'
    })
    assert.equal(session.cancel(), true, `${stage}: cancellation should win`)
    const eventCountAfterCancel = events.length
    wait.resolve('late-private-result')
    await assert.rejects(pending, /run-cancelled/u)
    assert.equal(session.terminalStatus, 'cancelled')
    assert.equal(session.result, null)
    assert.equal(writes, 0)
    assert.equal(events.length, eventCountAfterCancel)
    assert.equal(events.filter(event => event.type === 'terminal').length, 1)
    assert.equal(events.at(-1)?.status, 'cancelled')
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.ok(events.every(event => Object.isFrozen(event) && !('result' in event) && !('payload' in event) && !('error' in event)))
  }
})

test('normal phase cycles publish only after validation and emit started/completed metadata', async () => {
  const events: Array<Record<string, unknown>> = []
  let session: RunSession | null = null
  const coordinator = createRunCoordinator({ onEvent: event => {
    events.push(event)
    if (event.type === 'terminal') {
      assert.equal(session?.terminalStatus, event.status)
      assert.equal(session?.signal.aborted, true)
      assert.equal(session?.cancel(), false)
    }
  } })
  session = coordinator.begin(spec('phase-cycles'))!
  const initial = session.snapshot()
  for (const stage of ['scanning', 'investigating', 'tool', 'investigating', 'packing', 'generating', 'packing', 'generating', 'validating', 'reviewing', 'revising', 'generating', 'validating', 'persisting'] as const) {
    await session.execute(stage, context => {
      assert.equal(context.signal, session.signal)
      context.assertActive()
    })
  }
  assert.equal(session.succeed({ approved: true }), true)
  assert.deepEqual(session.result, { approved: true })
  assert.equal(session.terminalStatus, 'succeeded')
  assert.equal(initial.stage, 'created')
  assert.equal(initial.sequence, 1)
  assert.ok(Object.isFrozen(initial))
  assert.equal(session.snapshot().stage, 'persisting')
  assert.equal(events.filter(event => event.type === 'terminal').length, 1)
  assert.equal(events.filter(event => event.type === 'stage-started').length, events.filter(event => event.type === 'stage-completed').length + 1)
  assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
  assert.equal(coordinator.getActiveProjectRun('project-01'), null)
  assert.equal(coordinator.begin(spec('phase-cycles')), null, 'run IDs cannot be reused after terminal')
  await assert.rejects(session.execute('tool', () => undefined), /run-terminal/u)
})

test('begin rejects active duplicate run IDs and project ownership without blocking other projects', () => {
  const coordinator = createRunCoordinator()
  const first = coordinator.begin(spec('duplicate-run', 'duplicate-project'))!
  assert.equal(coordinator.begin(spec('other-run', 'duplicate-project')), null)
  assert.equal(coordinator.begin(spec('duplicate-run', 'other-project')), null)
  const otherProject = coordinator.begin(spec('other-project-run', 'other-project'))
  assert.ok(otherProject)
  assert.equal(coordinator.getActiveProjectRun('duplicate-project'), 'duplicate-run')
  assert.equal(coordinator.cancel('duplicate-run'), true)
  assert.equal(coordinator.cancel('duplicate-run'), false)
  assert.equal(first.terminalStatus, 'cancelled')
  assert.equal(otherProject.cancel(), true)
})

test('old operation cleanup cannot release a newer project lease', async () => {
  const coordinator = createRunCoordinator()
  const old = coordinator.begin(spec('old-run', 'leased-project'))!
  await old.execute('scanning', () => undefined)
  await old.execute('investigating', () => undefined)
  const wait = deferred<void>()
  const pending = old.execute('tool', () => wait.promise)
  assert.equal(coordinator.cancel('old-run'), true)
  const current = coordinator.begin(spec('new-run', 'leased-project'))!
  wait.resolve()
  await assert.rejects(pending, /run-cancelled/u)
  assert.equal(coordinator.cancel('old-run'), false)
  assert.equal(coordinator.getActiveProjectRun('leased-project'), 'new-run')
  assert.equal(coordinator.begin(spec('third-run', 'leased-project')), null)
  current.cancel()
  const third = coordinator.begin(spec('third-run', 'leased-project'))!
  third.cancel()
})

test('observer exceptions cannot interrupt terminal cleanup or ownership release', () => {
  const coordinator = createRunCoordinator({ onEvent: async () => { throw new Error('observer-private-error') } })
  const session = coordinator.begin(spec('observer-error'))!
  assert.equal(session.cancel(), true)
  assert.equal(session.terminalStatus, 'cancelled')
  assert.equal(coordinator.getActiveProjectRun('project-01'), null)
  const next = coordinator.begin(spec('observer-next'))!
  next.cancel()
})

test('operation failure records one safe terminal outcome and releases the active slot', async () => {
  const events: Array<Record<string, unknown>> = []
  const coordinator = createRunCoordinator({ onEvent: event => events.push(event) })
  const session = coordinator.begin(spec('failed-run'))!
  await assert.rejects(session.execute('scanning', () => { throw new Error('private source and prompt') }), /private source and prompt/u)
  assert.equal(session.terminalStatus, 'failed')
  assert.equal(session.result, null)
  assert.equal(session.cancel(), false)
  assert.equal(events.filter(event => event.type === 'terminal').length, 1)
  assert.equal(JSON.stringify(events).includes('private source'), false)
  assert.equal(coordinator.getActiveProjectRun('project-01'), null)
})

test('deadline is enforced by monotonic checks and terminal precedence is stable', () => {
  let now = 10
  const coordinator = createRunCoordinator({ clock: () => now })
  const expired = coordinator.begin(spec('deadline-run', 'deadline-project', 100_000))!
  now += 100_000
  assert.throws(() => expired.assertActive(), /run-deadline-exceeded/u)
  assert.equal(expired.terminalStatus, 'failed')
  assert.equal(expired.signal.aborted, true)
  assert.equal(coordinator.getActiveProjectRun('deadline-project'), null)

  const cancelled = coordinator.begin(spec('cancel-wins', 'cancel-project', 1))!
  assert.equal(cancelled.cancel(), true)
  assert.equal(cancelled.terminalStatus, 'cancelled')
  assert.throws(() => cancelled.assertActive(), /run-cancelled/u)
})

test('wall-clock deadline aborts an unresolved stage operation', async () => {
  const coordinator = createRunCoordinator()
  const session = coordinator.begin(spec('timer-deadline', 'timer-project', 80))!
  const wait = deferred<void>()
  const pending = session.execute('scanning', () => wait.promise)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(session.terminalStatus, 'failed')
  assert.equal(session.signal.aborted, true)
  wait.resolve()
  await assert.rejects(pending, /run-terminal/u)
  assert.equal(coordinator.getActiveProjectRun('timer-project'), null)
})

test('external abort shares the owned signal and releases its project slot', () => {
  const coordinator = createRunCoordinator()
  const external = new AbortController()
  const session = coordinator.begin(spec('external-cancel'), { signal: external.signal })!
  external.abort()
  assert.equal(session.terminalStatus, 'cancelled')
  assert.equal(session.signal.aborted, true)
  assert.equal(coordinator.getActiveProjectRun('project-01'), null)
})

test('succeed is unavailable before validation and terminal notifications cannot expose result data', async () => {
  const events: Array<Record<string, unknown>> = []
  let session: RunSession | null = null
  const coordinator = createRunCoordinator({ onEvent: event => { events.push(event); if (event.type === 'stage-completed' && event.stage === 'validating') session?.cancel() } })
  session = coordinator.begin(spec('observer-cancel'))!
  assert.throws(() => session.succeed({ private: true }), /before validation/u)
  await advance(session, ['scanning', 'investigating', 'packing', 'generating'])
  await assert.rejects(session.execute('validating', () => ({ private: true })), /run-cancelled/u)
  assert.equal(session.terminalStatus, 'cancelled')
  assert.equal(session.result, null)
  assert.ok(events.every(event => !('private' in event)))
})

test('terminal success and overlapping stages are blocked while an operation is pending', async () => {
  const coordinator = createRunCoordinator()
  const session = coordinator.begin(spec('no-overlap'))!
  await advance(session, ['scanning', 'investigating', 'packing', 'generating'])
  const wait = deferred<void>()
  const pending = session.execute('validating', () => wait.promise)
  assert.throws(() => session.succeed({ tooEarly: true }), /still in progress/u)
  await assert.rejects(session.execute('reviewing', () => undefined), /already in progress/u)
  assert.equal(session.cancel(), true)
  wait.resolve()
  await assert.rejects(pending, /run-cancelled/u)
  assert.equal(session.result, null)
})
