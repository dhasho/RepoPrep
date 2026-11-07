import { randomUUID } from 'node:crypto'

export type WorkflowStrategy = 'static' | 'agentic'
export type WorkflowTerminalStatus = 'succeeded' | 'failed' | 'cancelled'
export type WorkflowEventStatus = WorkflowTerminalStatus | 'started' | 'interrupted' | 'unavailable' | 'skipped'
export type WorkflowLineagePhase = 'needed' | 'retrieved' | 'selected' | 'packed' | 'cited' | 'reviewed'
export type WorkflowReplayMode = 'deterministic-tools' | 'recorded-model' | 'real-model'
export type WorkflowReason =
  | 'cancelled-by-user'
  | 'budget-exhausted'
  | 'tool-error'
  | 'model-interrupted'
  | 'usage-unknown'
  | 'snapshot-missing'
  | 'evidence-unavailable'
  | 'required-evidence-omitted'
  | 'validation-failed'
  | 'trace-sink-failed'
  | 'no-progress'
  | 'timeout'
  | 'request-rejected'
  | 'other-static'

export interface WorkflowTraceBudget {
  inputTokens?: number
  outputTokens?: number
  readBytes?: number
  requestNumber?: number
}

export interface WorkflowTraceUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  complete: boolean
  reason?: 'not-provided' | 'stream-interrupted' | 'provider-omitted' | 'unavailable'
}

/** Metadata only. IDs and hashes may reference separately retained evidence; payloads never belong here. */
export interface WorkflowTraceInput {
  span: string
  spanId: string
  parentSpanId?: string
  component: string
  componentVersion: string
  status: WorkflowEventStatus
  phase?: WorkflowLineagePhase
  evidenceIds?: readonly string[]
  inputIds?: readonly string[]
  outputIds?: readonly string[]
  omittedIds?: readonly string[]
  inputHashes?: readonly string[]
  outputHashes?: readonly string[]
  manifestHash?: string
  budget?: WorkflowTraceBudget
  usage?: WorkflowTraceUsage
  reason?: WorkflowReason
  replayMode?: WorkflowReplayMode
  replayArtifactId?: string
  snapshotAvailability?: 'available' | 'missing'
}

export interface WorkflowTraceEvent extends Omit<WorkflowTraceInput, 'parentSpanId'> {
  schemaVersion: 1
  traceId: string
  runId: string
  projectId: string
  snapshotId: string
  sequence: number
  parentSpanId: string | null
  elapsedMs: number
  evidenceIds?: readonly string[]
  inputIds?: readonly string[]
  outputIds?: readonly string[]
  omittedIds?: readonly string[]
  inputHashes?: readonly string[]
  outputHashes?: readonly string[]
  budget?: Readonly<WorkflowTraceBudget>
  usage?: Readonly<WorkflowTraceUsage>
}

export interface WorkflowTraceLineage {
  valid: boolean
  available: boolean
  evidenceCount: number
  validEvidenceCount: number
  coverage: number
  issues: readonly string[]
}

export interface WorkflowTraceReplay {
  /** Describes replay inputs recorded in the trace; this module does not execute a replay. */
  mode: WorkflowReplayMode | 'unavailable'
  /** True means the referenced inputs appear available, not that replay was executed or passed. */
  available: boolean
  reason: 'snapshot-missing' | 'snapshot-availability-unknown' | 'model-recording-missing' | 'no-replay-recording' | null
}

export interface WorkflowTraceSnapshot {
  schemaVersion: 1
  traceId: string
  runId: string
  projectId: string
  snapshotId: string
  strategy: WorkflowStrategy
  events: readonly WorkflowTraceEvent[]
  terminalStatus: WorkflowTerminalStatus | null
  integrity: boolean
  sinkFailureCount: number
  requiredSpanCoverage: Readonly<{ required: readonly string[]; observed: readonly string[]; ratio: number }>
  lineage: WorkflowTraceLineage
  replay: WorkflowTraceReplay
}

export interface CreateWorkflowTraceOptions {
  runId: string
  projectId: string
  snapshotId: string
  strategy: WorkflowStrategy
  requiredSpans: readonly string[]
  clock?: () => number
  sink?: (event: WorkflowTraceEvent) => void | Promise<void>
}

export interface WorkflowTrace {
  /** Returns false after finish(); invalid or unsafe metadata throws synchronously. */
  emit(input: WorkflowTraceInput): boolean
  finish(status: WorkflowTerminalStatus): void
  snapshot(): WorkflowTraceSnapshot
  /** Waits for best-effort sink writes. Sink errors are captured and never rethrown. */
  flush(): Promise<void>
}

const EVENT_KEYS = new Set([
  'span', 'spanId', 'parentSpanId', 'component', 'componentVersion', 'status', 'phase', 'evidenceIds',
  'inputIds', 'outputIds', 'omittedIds', 'inputHashes', 'outputHashes', 'manifestHash', 'budget', 'usage',
  'reason', 'replayMode', 'replayArtifactId', 'snapshotAvailability'
])
const BUDGET_KEYS = new Set(['inputTokens', 'outputTokens', 'readBytes', 'requestNumber'])
const USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'totalTokens', 'complete', 'reason'])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/i
const PHASES: readonly WorkflowLineagePhase[] = ['needed', 'retrieved', 'selected', 'packed', 'cited', 'reviewed']
const EVENT_STATUSES: readonly WorkflowEventStatus[] = ['started', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unavailable', 'skipped']
const REASONS: readonly WorkflowReason[] = [
  'cancelled-by-user', 'budget-exhausted', 'tool-error', 'model-interrupted', 'usage-unknown', 'snapshot-missing',
  'evidence-unavailable', 'required-evidence-omitted', 'validation-failed', 'trace-sink-failed', 'no-progress',
  'timeout', 'request-rejected', 'other-static'
]

function freezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy)) as T
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) copy[key] = freezeCopy(entry)
    return Object.freeze(copy) as T
  }
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Invalid ${label} object`)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError(`Unknown ${label} field`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`Invalid ${label} field`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new TypeError(`Invalid ${label}`)
}

function validateOptionalIdList(value: unknown, label: string): asserts value is readonly string[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 512) throw new TypeError(`Invalid ${label}`)
  const seen = new Set<string>()
  for (const id of value) {
    validateId(id, label)
    if (seen.has(id)) throw new TypeError(`Duplicate ${label}`)
    seen.add(id)
  }
}

function validateHashList(value: unknown, label: string): asserts value is readonly string[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 512 || value.some(hash => typeof hash !== 'string' || !HASH_PATTERN.test(hash))) {
    throw new TypeError(`Invalid ${label}`)
  }
}

function validateCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`)
}

function validateInput(value: unknown): asserts value is WorkflowTraceInput {
  if (!isRecord(value)) throw new TypeError('Trace event must be an object')
  exactKeys(value, EVENT_KEYS, 'trace event')
  validateId(value.span, 'span')
  validateId(value.spanId, 'spanId')
  if (value.parentSpanId !== undefined) validateId(value.parentSpanId, 'parentSpanId')
  validateId(value.component, 'component')
  validateId(value.componentVersion, 'componentVersion')
  if (!EVENT_STATUSES.includes(value.status as WorkflowEventStatus)) throw new TypeError('Invalid status')
  if (value.phase !== undefined && !PHASES.includes(value.phase as WorkflowLineagePhase)) throw new TypeError('Invalid phase')
  validateOptionalIdList(value.evidenceIds, 'evidenceIds')
  validateOptionalIdList(value.inputIds, 'inputIds')
  validateOptionalIdList(value.outputIds, 'outputIds')
  validateOptionalIdList(value.omittedIds, 'omittedIds')
  if (value.omittedIds?.length && value.reason === undefined) throw new TypeError('Omitted IDs require a static reason')
  validateHashList(value.inputHashes, 'inputHashes')
  validateHashList(value.outputHashes, 'outputHashes')
  if (value.manifestHash !== undefined && (typeof value.manifestHash !== 'string' || !HASH_PATTERN.test(value.manifestHash))) throw new TypeError('Invalid manifestHash')
  if (value.budget !== undefined) {
    if (!isRecord(value.budget)) throw new TypeError('Invalid budget')
    exactKeys(value.budget, BUDGET_KEYS, 'budget')
    for (const key of BUDGET_KEYS) if (value.budget[key] !== undefined) validateCount(value.budget[key], `budget.${key}`)
  }
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new TypeError('Invalid usage')
    exactKeys(value.usage, USAGE_KEYS, 'usage')
    if (typeof value.usage.complete !== 'boolean') throw new TypeError('Invalid usage completeness')
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) if (value.usage[key] !== undefined) validateCount(value.usage[key], `usage.${key}`)
    if (value.usage.reason !== undefined && !['not-provided', 'stream-interrupted', 'provider-omitted', 'unavailable'].includes(String(value.usage.reason))) throw new TypeError('Invalid usage reason')
    if (!value.usage.complete && value.usage.reason === undefined) throw new TypeError('Incomplete usage requires a static reason')
    if (value.usage.complete && value.usage.reason !== undefined) throw new TypeError('Complete usage cannot have an unknown reason')
    const inputTokens = value.usage.inputTokens
    const outputTokens = value.usage.outputTokens
    const totalTokens = value.usage.totalTokens
    if (value.usage.complete && (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || typeof totalTokens !== 'number')) throw new TypeError('Complete usage requires all token counts')
    if (typeof inputTokens === 'number' && typeof outputTokens === 'number' && typeof totalTokens === 'number' && totalTokens !== inputTokens + outputTokens) throw new TypeError('Inconsistent usage totals')
  }
  if (value.reason !== undefined && !REASONS.includes(value.reason as WorkflowReason)) throw new TypeError('Invalid reason')
  if (value.replayMode !== undefined && !['deterministic-tools', 'recorded-model', 'real-model'].includes(String(value.replayMode))) throw new TypeError('Invalid replay mode')
  if (value.replayArtifactId !== undefined) validateId(value.replayArtifactId, 'replayArtifactId')
  if (value.snapshotAvailability !== undefined && !['available', 'missing'].includes(String(value.snapshotAvailability))) throw new TypeError('Invalid snapshot availability')
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator
}

function computeLineage(events: readonly WorkflowTraceEvent[]): WorkflowTraceLineage {
  const latest = new Map<string, number>()
  const issues: string[] = []
  const evidence = new Set<string>()
  let lineageDeclared = false
  let validEvidence = 0

  for (const event of events) {
    if (!event.phase) continue
    lineageDeclared = true
    if (event.status !== 'succeeded' || !event.evidenceIds?.length) continue
    const phaseIndex = PHASES.indexOf(event.phase)
    for (const id of event.evidenceIds) {
      evidence.add(id)
      const previous = latest.get(id)
      if (previous === undefined) {
        if (phaseIndex !== 0) issues.push(`${id}:missing-needed`)
      } else if (phaseIndex > previous + 1) {
        issues.push(`${id}:missing-${PHASES[previous + 1]}`)
      } else if (phaseIndex < previous) {
        issues.push(`${id}:out-of-order-${event.phase}`)
      }
      if (previous === undefined || phaseIndex > previous) latest.set(id, phaseIndex)
    }
  }

  for (const id of evidence) {
    if (latest.get(id) === PHASES.length - 1) validEvidence++
    else issues.push(`${id}:incomplete`)
  }
  if (!lineageDeclared || evidence.size === 0) issues.push('lineage-unavailable')
  const uniqueIssues = [...new Set(issues)]
  return freezeCopy({ valid: evidence.size > 0 && uniqueIssues.length === 0, available: evidence.size > 0, evidenceCount: evidence.size, validEvidenceCount: validEvidence, coverage: evidence.size === 0 ? 0 : ratio(validEvidence, evidence.size), issues: uniqueIssues })
}

function computeReplay(events: readonly WorkflowTraceEvent[]): WorkflowTraceReplay {
  const snapshots = events.flatMap(event => event.snapshotAvailability ? [event.snapshotAvailability] : [])
  if (snapshots.includes('missing')) return { mode: 'unavailable', available: false, reason: 'snapshot-missing' }
  if (!snapshots.includes('available')) return { mode: 'unavailable', available: false, reason: 'snapshot-availability-unknown' }
  const mode = [...events].reverse().find(event => event.replayMode)?.replayMode
  if (!mode) return { mode: 'unavailable', available: false, reason: 'no-replay-recording' }
  if (mode === 'recorded-model' && !events.some(event => event.replayMode === mode && event.replayArtifactId)) return { mode: 'unavailable', available: false, reason: 'model-recording-missing' }
  return { mode, available: true, reason: null }
}

export function createWorkflowTrace(options: CreateWorkflowTraceOptions): WorkflowTrace {
  validateId(options.runId, 'runId')
  validateId(options.projectId, 'projectId')
  validateId(options.snapshotId, 'snapshotId')
  if (options.strategy !== 'static' && options.strategy !== 'agentic') throw new TypeError('Invalid strategy')
  if (!Array.isArray(options.requiredSpans) || options.requiredSpans.some(span => typeof span !== 'string' || !ID_PATTERN.test(span))) throw new TypeError('Invalid required spans')
  const runId = options.runId
  const projectId = options.projectId
  const snapshotId = options.snapshotId
  const strategy = options.strategy
  const sink = options.sink
  const requiredSpans = [...new Set(options.requiredSpans)]
  const clock = options.clock ?? (() => performance.now())
  const startTime = clock()
  if (!Number.isFinite(startTime)) throw new TypeError('Clock must return a finite number')
  const traceId = `trace_${randomUUID()}`
  const events: WorkflowTraceEvent[] = []
  const spans = new Map<string, { name: string; started: boolean; ended: boolean; parentSpanId: string | null; component: string; componentVersion: string }>()
  const pendingWrites: Promise<void>[] = []
  let lastTime = startTime
  let terminalStatus: WorkflowTerminalStatus | null = null
  let sinkFailureCount = 0

  const append = (input: WorkflowTraceInput): WorkflowTraceEvent => {
    const now = clock()
    if (!Number.isFinite(now) || now < lastTime) throw new TypeError('Clock must be finite and monotonic')
    lastTime = now
    const event = freezeCopy({
      ...input,
      schemaVersion: 1 as const,
      traceId,
      runId,
      projectId,
      snapshotId,
      sequence: events.length + 1,
      parentSpanId: input.parentSpanId ?? null,
      elapsedMs: Math.max(0, now - startTime)
    }) as WorkflowTraceEvent
    events.push(event)
    if (sink) {
      try {
        const result = sink(freezeCopy(event))
        if (result && typeof (result as Promise<void>).then === 'function') {
          const write = Promise.resolve(result).then(() => undefined, () => { sinkFailureCount++ })
          pendingWrites.push(write)
        }
      } catch {
        sinkFailureCount++
      }
    }
    return event
  }

  return {
    emit(input: WorkflowTraceInput): boolean {
      if (terminalStatus) return false
      validateInput(input)
      const span = spans.get(input.spanId)
      if (input.status === 'started') {
        if (span) throw new TypeError('Span already exists')
        if (input.parentSpanId) {
          const parent = spans.get(input.parentSpanId)
          if (!parent?.started || parent.ended) throw new TypeError('Parent span must be active before child span')
        }
        spans.set(input.spanId, { name: input.span, started: true, ended: false, parentSpanId: input.parentSpanId ?? null, component: input.component, componentVersion: input.componentVersion })
      } else {
        if (!span || !span.started || span.ended || span.name !== input.span || span.parentSpanId !== (input.parentSpanId ?? null) || span.component !== input.component || span.componentVersion !== input.componentVersion) throw new TypeError('Span status is out of order')
        spans.set(input.spanId, { ...span, ended: true })
      }
      append(input)
      return true
    },
    finish(status: WorkflowTerminalStatus): void {
      if (!['succeeded', 'failed', 'cancelled'].includes(status)) throw new TypeError('Invalid terminal status')
      if (terminalStatus) return
      terminalStatus = status
      const activeRun = [...spans.entries()].find(([, span]) => span.name === 'run' && span.started && !span.ended)
      const terminalEvent: WorkflowTraceInput = activeRun
        ? { span: 'run', spanId: activeRun[0], parentSpanId: activeRun[1].parentSpanId ?? undefined, component: activeRun[1].component, componentVersion: activeRun[1].componentVersion, status }
        : { span: 'run', spanId: 'run_terminal', component: 'workflow-trace', componentVersion: '1', status }
      if (status === 'cancelled') terminalEvent.reason = 'cancelled-by-user'
      if (activeRun) spans.set(activeRun[0], { ...activeRun[1], ended: true })
      append(terminalEvent)
    },
    snapshot(): WorkflowTraceSnapshot {
      const observed = [...new Set(events.filter(event => event.status !== 'started').map(event => event.span))].filter(span => requiredSpans.includes(span)).sort()
      const lineage = computeLineage(events)
      return freezeCopy({
        schemaVersion: 1,
        traceId,
        runId,
        projectId,
        snapshotId,
        strategy,
        events,
        terminalStatus,
        integrity: sinkFailureCount === 0,
        sinkFailureCount,
        requiredSpanCoverage: { required: requiredSpans, observed, ratio: ratio(observed.length, requiredSpans.length) },
        lineage,
        replay: computeReplay(events)
      })
    },
    async flush(): Promise<void> {
      await Promise.all(pendingWrites)
    }
  }
}
