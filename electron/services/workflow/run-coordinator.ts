// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import type { RunSpec } from './run-spec.ts'
import type { WorkflowCancellationControl } from './workflow-ledger-journal.ts'
import type { ControlledRunSession } from './workflow-cancellation-control.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { beginControlledRun } from './workflow-cancellation-control.ts'
export type { ControlledRunSession } from './workflow-cancellation-control.ts'

export const RUN_STAGES = Object.freeze([
  'created', 'scanning', 'investigating', 'tool', 'packing', 'generating',
  'validating', 'reviewing', 'revising', 'persisting'
] as const)

export type RunStage = typeof RUN_STAGES[number]
export type RunTerminalStatus = 'succeeded' | 'failed' | 'cancelled'
export type RunCoordinatorEvent = Readonly<{
  runId: string
  projectId: string
  snapshotId: string
  sequence: number
  type: 'stage-started' | 'stage-completed' | 'terminal'
  stage: RunStage
  status?: RunTerminalStatus
}>

export interface RunStageContext {
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly signal: AbortSignal
  assertActive(): void
  /** Guard a synchronous in-memory mutation; await asynchronous work before calling this. */
  commit<T>(effect: () => T): T
}

export interface RunSessionSnapshot {
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly stage: RunStage
  readonly terminalStatus: RunTerminalStatus | null
  readonly sequence: number
  readonly elapsedMs: number
}

export interface RunCoordinatorOptions {
  onEvent?: (event: RunCoordinatorEvent) => void
  clock?: () => number
}

export interface BeginRunOptions {
  /** Internal opt-in, issued by the genuine cancellation-only factory. */
  cancellationControl?: WorkflowCancellationControl
  signal?: AbortSignal
  onEvent?: (event: RunCoordinatorEvent) => void
}

export interface RunSession {
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly signal: AbortSignal
  readonly terminalStatus: RunTerminalStatus | null
  readonly result: unknown
  execute<T>(stage: RunStage, operation: (context: RunStageContext) => Promise<T> | T): Promise<T>
  assertActive(): void
  succeed(result: unknown): boolean
  fail(): boolean
  cancel(): boolean
  snapshot(): RunSessionSnapshot
}

export interface RunCoordinator {
  begin(spec: RunSpec, options: BeginRunOptions & { cancellationControl: WorkflowCancellationControl }): ControlledRunSession | null
  begin(spec: RunSpec, options?: BeginRunOptions): RunSession | null
  cancel(runId: string): boolean
  cancelProject(projectId: string): boolean
  getActiveProjectRun(projectId: string): string | null
}

const transitions: Readonly<Record<RunStage, ReadonlySet<RunStage>>> = Object.freeze({
  created: new Set<RunStage>(['scanning']),
  scanning: new Set<RunStage>(['investigating']),
  investigating: new Set<RunStage>(['tool', 'packing']),
  tool: new Set<RunStage>(['investigating']),
  packing: new Set<RunStage>(['generating', 'validating']),
  generating: new Set<RunStage>(['packing', 'validating']),
  validating: new Set<RunStage>(['reviewing', 'persisting']),
  reviewing: new Set<RunStage>(['revising', 'persisting']),
  revising: new Set<RunStage>(['generating', 'packing', 'validating']),
  persisting: new Set<RunStage>()
})

class RunLifecycleError extends Error {
  readonly code: 'run-cancelled' | 'run-deadline-exceeded' | 'run-terminal' | 'run-clock-invalid'

  constructor(code: RunLifecycleError['code']) {
    super(code)
    this.name = 'RunLifecycleError'
    this.code = code
  }
}

function finiteNow(clock: () => number): number {
  let value: number
  try { value = clock() } catch { throw new RunLifecycleError('run-clock-invalid') }
  if (!Number.isFinite(value)) throw new RunLifecycleError('run-clock-invalid')
  return value
}

function safeObserver(observer: BeginRunOptions['onEvent'] | RunCoordinatorOptions['onEvent'], event: RunCoordinatorEvent): void {
  try {
    const outcome: unknown = observer?.(event)
    if (outcome && typeof (outcome as PromiseLike<unknown>).then === 'function') void Promise.resolve(outcome).catch(() => {})
  } catch { /* observers are not part of run control */ }
}

/** Owns per-run lifecycle and project slots in memory; it does not persist workflow state. */
export function createRunCoordinator(options: RunCoordinatorOptions = {}): RunCoordinator {
  const clock = options.clock ?? (() => performance.now())
  const activeProjects = new Map<string, symbol>()
  const activeRuns = new Map<string, { token: symbol; cancel: () => boolean }>()
  const seenRunIds = new Set<string>()

  const release = (runId: string, projectId: string, token: symbol): void => {
    const active = activeRuns.get(runId)
    if (active?.token === token) activeRuns.delete(runId)
    if (activeProjects.get(projectId) === token) activeProjects.delete(projectId)
  }

  function begin(spec: RunSpec, beginOptions: BeginRunOptions & { cancellationControl: WorkflowCancellationControl }): ControlledRunSession | null
  function begin(spec: RunSpec, beginOptions?: BeginRunOptions): RunSession | null
  function begin(spec: RunSpec, beginOptions: BeginRunOptions = {}): RunSession | null {
      const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
      if (!spec || !validId(spec.runId) || !validId(spec.projectId) || !validId(spec.snapshotId) || !Number.isSafeInteger(spec.budget?.total?.wallClockMs) || spec.budget.total.wallClockMs < 1) throw new TypeError('Invalid run identity or deadline')
      if (activeRuns.has(spec.runId) || activeProjects.has(spec.projectId) || seenRunIds.has(spec.runId)) return null

      const token = Symbol(spec.runId)
      if (beginOptions.cancellationControl !== undefined) {
        const controlledIdentity = Object.freeze({ runId: spec.runId, projectId: spec.projectId })
        return beginControlledRun({
          spec, control: beginOptions.cancellationControl, signal: beginOptions.signal,
          observers: [options.onEvent, beginOptions.onEvent], clock,
          canTransition: (from, to) => RUN_STAGES.includes(to) && transitions[from].has(to),
          activate(session) {
            activeProjects.set(controlledIdentity.projectId, token)
            activeRuns.set(controlledIdentity.runId, { token, cancel: () => session.cancel() })
            seenRunIds.add(controlledIdentity.runId)
          },
          release: () => release(controlledIdentity.runId, controlledIdentity.projectId, token)
        })
      }
      const identity = Object.freeze({ runId: spec.runId, projectId: spec.projectId, snapshotId: spec.snapshotId })
      const controller = new AbortController()
      const startedAt = finiteNow(clock)
      const deadlineAt = startedAt + spec.budget.total.wallClockMs
      let lastClockValue = startedAt
      let currentStage: RunStage = 'created'
      let terminalStatus: RunTerminalStatus | null = null
      let operationInFlight = false
      let sequence = 0
      let publishedResult: unknown = null
      let terminalElapsedMs: number | null = null
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null
      let externalAbort: (() => void) | null = null
      const observers = [options.onEvent, beginOptions.onEvent]

      const emit = (type: RunCoordinatorEvent['type'], status?: RunTerminalStatus): void => {
        const event = Object.freeze({
          ...identity,
          sequence: ++sequence,
          type,
          stage: currentStage,
          ...(status ? { status } : {})
        }) as RunCoordinatorEvent
        for (const observer of observers) safeObserver(observer, event)
      }

      let session!: RunSession
      const sampleTerminalElapsed = (): number => {
        try {
          const now = finiteNow(clock)
          if (now >= lastClockValue) lastClockValue = now
        } catch { /* keep the last known monotonic time for terminal diagnostics */ }
        return Math.max(0, lastClockValue - startedAt)
      }

      const finish = (status: RunTerminalStatus, result?: unknown): boolean => {
        if (terminalStatus) return false
        terminalStatus = status
        terminalElapsedMs = sampleTerminalElapsed()
        publishedResult = status === 'succeeded' ? result : null
        if (!controller.signal.aborted) controller.abort()
        if (deadlineTimer !== null) clearTimeout(deadlineTimer)
        deadlineTimer = null
        if (beginOptions.signal && externalAbort) beginOptions.signal.removeEventListener('abort', externalAbort)
        externalAbort = null
        try { emit('terminal', status) } finally { release(identity.runId, identity.projectId, token) }
        return true
      }

      const monotonicNow = (): number => {
        const now = finiteNow(clock)
        if (now < lastClockValue) throw new RunLifecycleError('run-clock-invalid')
        lastClockValue = now
        return now
      }

      const assertActive = (): void => {
        if (terminalStatus) throw new RunLifecycleError(terminalStatus === 'cancelled' ? 'run-cancelled' : 'run-terminal')
        let now: number
        try { now = monotonicNow() } catch (error) {
          finish('failed')
          throw error
        }
        if (now >= deadlineAt) {
          finish('failed')
          throw new RunLifecycleError('run-deadline-exceeded')
        }
        if (controller.signal.aborted) {
          finish('cancelled')
          throw new RunLifecycleError('run-cancelled')
        }
      }

      session = {
        ...identity,
        get signal() { return controller.signal },
        get terminalStatus() { return terminalStatus },
        get result() { return terminalStatus === 'succeeded' ? publishedResult : null },
        async execute<T>(stage: RunStage, operation: (context: RunStageContext) => Promise<T> | T): Promise<T> {
          assertActive()
          if (operationInFlight) throw new TypeError('Run stage operation already in progress')
          if (!RUN_STAGES.includes(stage) || !transitions[currentStage].has(stage)) throw new TypeError('Invalid run stage transition')
          operationInFlight = true
          currentStage = stage
          try {
            emit('stage-started')
            const context = Object.freeze({
              ...identity,
              signal: controller.signal,
              assertActive,
              commit<T>(effect: () => T): T {
                assertActive()
                const value = effect()
                assertActive()
                return value
              }
            })
            assertActive()
            const value = await operation(context)
            assertActive()
            emit('stage-completed')
            assertActive()
            return value
          } catch (error) {
            if (terminalStatus) throw new RunLifecycleError(terminalStatus === 'cancelled' ? 'run-cancelled' : 'run-terminal')
            finish('failed')
            throw error
          } finally { operationInFlight = false }
        },
        assertActive,
        succeed(result: unknown) {
          assertActive()
          if (operationInFlight) throw new TypeError('Run stage operation is still in progress')
          if (!['validating', 'reviewing', 'persisting'].includes(currentStage)) throw new TypeError('Run cannot succeed before validation')
          return finish('succeeded', result)
        },
        fail() { return finish('failed') },
        cancel() { return finish('cancelled') },
        snapshot(): RunSessionSnapshot {
          let elapsedMs = terminalElapsedMs
          if (elapsedMs === null) {
            try { elapsedMs = Math.max(0, monotonicNow() - startedAt) } catch (error) {
              finish('failed')
              throw error
            }
          }
          return Object.freeze({ ...identity, stage: currentStage, terminalStatus, sequence, elapsedMs })
        }
      }

      activeProjects.set(identity.projectId, token)
      activeRuns.set(identity.runId, { token, cancel: () => session.cancel() })
      seenRunIds.add(identity.runId)
      emit('stage-started')
      externalAbort = () => { session.cancel() }
      if (!terminalStatus && beginOptions.signal?.aborted) session.cancel()
      else if (!terminalStatus) beginOptions.signal?.addEventListener('abort', externalAbort, { once: true })
      if (!terminalStatus) {
        try {
          deadlineTimer = setTimeout(() => {
            if (!terminalStatus) finish('failed')
          }, Math.max(0, deadlineAt - monotonicNow()))
        } catch (error) {
          finish('failed')
          throw error
        }
      }
      return session
  }
  return {
    begin,
    cancel(runId) { return activeRuns.get(runId)?.cancel() ?? false },
    cancelProject(projectId) {
      const token = activeProjects.get(projectId)
      if (!token) return false
      const active = [...activeRuns.values()].find(item => item.token === token)
      return active?.cancel() ?? false
    },
    getActiveProjectRun(projectId) {
      const token = activeProjects.get(projectId)
      if (!token) return null
      return [...activeRuns.entries()].find(([, active]) => active.token === token)?.[0] ?? null
    }
  }
}
