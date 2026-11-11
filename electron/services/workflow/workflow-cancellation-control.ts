import type { RunSpec } from './run-spec.ts'
import type { RunStage, RunSession, RunSessionSnapshot, RunStageContext, RunCoordinatorEvent } from './run-coordinator.ts'
import type { WorkflowCancellationControl, WorkflowCancellationOutcome, WorkflowCancellationResolution } from './workflow-ledger-journal.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { claimWorkflowCancellationControl } from './workflow-ledger-journal.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createAcceptedWorkRegistry } from './accepted-work-registry.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
export { createWorkflowCancellationControl, closeWorkflowCancellationControl } from './workflow-ledger-journal.ts'
export type { WorkflowCancellationControl, WorkflowCancellationResolution } from './workflow-ledger-journal.ts'

export interface ControlledRunSession extends RunSession {
  /** Metadata-only retry after closure. Active calls reject not-sealed; own leases reject self-wait. Pending keeps the slot. */
  resolveTerminal(): Promise<WorkflowCancellationResolution>
  /** Waits real accepted work and W/listener closure. Pending still does not release the project slot. */
  close(): Promise<void>
}
interface ControlledRunOptions {
  readonly spec: RunSpec
  readonly control: WorkflowCancellationControl
  readonly signal?: AbortSignal
  readonly observers: readonly (((event: RunCoordinatorEvent) => unknown) | undefined)[]
  readonly clock: () => number
  readonly canTransition: (from: RunStage, to: RunStage) => boolean
  readonly activate: (session: ControlledRunSession) => void
  readonly release: () => void
}
function lifecycleError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { name: 'RunLifecycleError', code })
}
function now(clock: () => number): number {
  let value: number
  try { value = clock() } catch { throw lifecycleError('run-clock-invalid') }
  if (!Number.isFinite(value)) throw lifecycleError('run-clock-invalid')
  return value
}

/** @internal Coordinator-only assembly. The storage token is claimed before any callback can run. */
export function beginControlledRun(options: ControlledRunOptions): ControlledRunSession {
  const startedAt = now(options.clock)
  const storage = claimWorkflowCancellationControl(options.control, options.spec)
  const work = createAcceptedWorkRegistry()
  const stages = work.createIssuer('coordinator-stage')
  const observers = work.createIssuer('coordinator-observer')
  const terminalWork = createAcceptedWorkRegistry()
  const terminalObservers = terminalWork.createIssuer('coordinator-terminal-observer')
  const controller = new AbortController()
  const identity = Object.freeze({ runId: options.spec.runId, projectId: options.spec.projectId, snapshotId: options.spec.snapshotId })
  const deadlineAt = startedAt + options.spec.budget.total.wallClockMs
  let lastNow = startedAt
  let currentStage: RunStage = 'created'
  let closedReason: WorkflowCancellationOutcome | null = null
  let terminalStatus: WorkflowCancellationOutcome | null = null
  let terminalElapsedMs: number | null = null
  let sequence = 0
  let operationInFlight = false
  let terminalStarted = false
  let resolution: Promise<WorkflowCancellationResolution> | null = null
  let accepted: WorkflowCancellationResolution | null = null
  let closing: Promise<void> | null = null
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  let externalAbort: (() => void) | null = null

  const monotonicNow = (): number => {
    const value = now(options.clock)
    if (value < lastNow) throw lifecycleError('run-clock-invalid')
    lastNow = value
    return value
  }
  const closedError = () => lifecycleError(closedReason === 'cancelled' ? 'run-cancelled' : 'run-terminal')
  const sealAdmission = (reason: WorkflowCancellationOutcome): boolean => {
    if (closedReason || terminalStatus) return false
    closedReason = reason
    work.seal()
    storage.sealAdmission()
    if (!controller.signal.aborted) controller.abort()
    if (deadlineTimer !== null) clearTimeout(deadlineTimer)
    deadlineTimer = null
    if (options.signal && externalAbort) options.signal.removeEventListener('abort', externalAbort)
    externalAbort = null
    return true
  }
  const assertActive = (): void => {
    if (closedReason) throw closedError()
    let time: number
    try { time = monotonicNow(); storage.assertAvailable() } catch (error) { sealAdmission('failed'); kickResolution(); throw error }
    if (time >= deadlineAt) { sealAdmission('failed'); kickResolution(); throw lifecycleError('run-deadline-exceeded') }
    if (controller.signal.aborted) { sealAdmission('cancelled'); kickResolution(); throw lifecycleError('run-cancelled') }
  }
  const event = (type: RunCoordinatorEvent['type'], status?: WorkflowCancellationOutcome): RunCoordinatorEvent => Object.freeze({ ...identity, sequence: ++sequence, type, stage: currentStage, ...(status ? { status } : {}) })
  const kickResolution = (): void => {
    if (closedReason && !accepted && !closing) void resolveTerminal().catch(() => {})
  }
  const emitBusiness = (type: 'stage-started' | 'stage-completed'): void => {
    if (closedReason) return
    const emitted = event(type)
    for (const observer of options.observers) {
      if (!observer) continue
      // run() registers before invoking; its lease includes the exact returned thenable.
      const observed = observers.run(() => observer(emitted))
      void observed.then(kickResolution, kickResolution)
    }
  }
  const resolveTerminal = async (): Promise<WorkflowCancellationResolution> => {
    // Always guard before reusing a shared resolution. A caller inside its own live
    // stage or observer gets self-wait, including when another caller is resolving.
    await work.drain()
    if (terminalStarted) await terminalWork.drain()
    if (accepted) return accepted
    if (resolution) return resolution
    if (!closedReason) return Object.freeze({ status: 'pending' })
    const requested = closedReason
    resolution = (async () => {
      const outcome = await storage.resolve(requested)
      if (outcome.status !== 'accepted') return outcome
      accepted = outcome
      terminalStatus = outcome.outcome
      try { terminalElapsedMs = Math.max(0, monotonicNow() - startedAt) } catch { terminalElapsedMs = Math.max(0, lastNow - startedAt) }
      terminalStarted = true
      const emitted = event('terminal', outcome.outcome)
      for (const observer of options.observers) {
        if (!observer) continue
        const observed = terminalObservers.run(() => observer(emitted))
        void observed.catch(() => {})
      }
      terminalWork.seal()
      await terminalWork.drain()
      options.release()
      return outcome
    })()
    try { return await resolution } finally { resolution = null }
  }
  const session: ControlledRunSession = Object.freeze({
    ...identity,
    get signal() { return controller.signal },
    get terminalStatus() { return terminalStatus },
    get result() { return null },
    async execute<T>(stage: RunStage, operation: (context: RunStageContext) => Promise<T> | T): Promise<T> {
      assertActive()
      if (operationInFlight) throw new TypeError('Run stage operation already in progress')
      if (!options.canTransition(currentStage, stage) || typeof operation !== 'function') throw new TypeError('Invalid run stage transition')
      operationInFlight = true
      currentStage = stage
      const operationResult = stages.run(async () => {
        try {
          emitBusiness('stage-started')
          const context: RunStageContext = Object.freeze({
            ...identity, signal: controller.signal, assertActive,
            commit<T>(_effect: () => T): T { throw new TypeError('controlled-run-commit-unavailable') }
          })
          assertActive()
          const value = await operation(context)
          assertActive()
          emitBusiness('stage-completed')
          assertActive()
          return value
        } catch (error) {
          if (closedReason) throw closedError()
          sealAdmission('failed')
          throw error
        }
      })
      // The issuer releases its actual lease before this continuation can resolve.
      // Resolution therefore never waits for the execute() promise that called it.
      try { return await operationResult } finally { operationInFlight = false; kickResolution() }
    },
    assertActive,
    succeed(_result: unknown): boolean { throw new TypeError('controlled-run-result-unavailable') },
    fail(): boolean { const changed = sealAdmission('failed'); kickResolution(); return changed },
    cancel(): boolean { const changed = sealAdmission('cancelled'); kickResolution(); return changed },
    resolveTerminal,
    async close(): Promise<void> {
      sealAdmission('cancelled')
      await work.drain()
      if (terminalStarted) await terminalWork.drain()
      if (!closing) closing = (async () => { await resolveTerminal(); await storage.close() })()
      return closing
    },
    snapshot(): RunSessionSnapshot {
      let elapsedMs = terminalElapsedMs
      if (elapsedMs === null) {
        try { elapsedMs = Math.max(0, monotonicNow() - startedAt) } catch (error) { sealAdmission('failed'); kickResolution(); throw error }
      }
      return Object.freeze({ ...identity, stage: currentStage, terminalStatus, sequence, elapsedMs })
    }
  })
  options.activate(session)
  emitBusiness('stage-started')
  externalAbort = () => { session.cancel() }
  if (options.signal?.aborted) session.cancel()
  else if (!closedReason) options.signal?.addEventListener('abort', externalAbort, { once: true })
  if (!closedReason) {
    try { deadlineTimer = setTimeout(() => { session.fail() }, Math.max(0, deadlineAt - monotonicNow())) }
    catch (error) { sealAdmission('failed'); kickResolution(); throw error }
  }
  kickResolution()
  return session
}
