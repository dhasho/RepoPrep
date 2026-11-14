// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node direct TypeScript tests require runtime .ts suffixes.
import { createWorkflowTrace, type WorkflowTraceInput } from './trace.ts'

const HASH = 'a'.repeat(64)

function makeTrace(overrides: Partial<Parameters<typeof createWorkflowTrace>[0]> = {}) {
  let now = 10
  return createWorkflowTrace({
    runId: 'run-1',
    projectId: 'project-1',
    snapshotId: 'snapshot-1',
    strategy: 'static',
    requiredSpans: ['run', 'context', 'dispatch', 'model', 'validation'],
    clock: () => now++,
    ...overrides
  })
}

function emit(trace: ReturnType<typeof makeTrace>, input: WorkflowTraceInput) {
  assert.equal(trace.emit(input), true)
}

function beginRun(trace: ReturnType<typeof makeTrace>) {
  emit(trace, { span: 'run', spanId: 'run-1', component: 'orchestrator', componentVersion: '1', status: 'started' })
}

function emitPhase(trace: ReturnType<typeof makeTrace>, id: string, phase: WorkflowTraceInput['phase']) {
  emit(trace, { span: phase!, spanId: `span-${phase}`, parentSpanId: 'run-1', component: 'evidence', componentVersion: '1', status: 'started' })
  emit(trace, { span: phase!, spanId: `span-${phase}`, parentSpanId: 'run-1', component: 'evidence', componentVersion: '1', status: 'succeeded', phase, evidenceIds: [id] })
}

test('normal run records immutable ordered metadata, required coverage, lineage, and deterministic replay', () => {
  const trace = makeTrace()
  beginRun(trace)
  emit(trace, { span: 'context', spanId: 'context-1', parentSpanId: 'run-1', component: 'generator', componentVersion: '1', status: 'started' })
  emit(trace, { span: 'context', spanId: 'context-1', parentSpanId: 'run-1', component: 'generator', componentVersion: '1', status: 'succeeded', outputHashes: [HASH], manifestHash: HASH, snapshotAvailability: 'available', replayMode: 'deterministic-tools' })
  for (const phase of ['needed', 'retrieved', 'selected', 'packed', 'cited', 'reviewed'] as const) emitPhase(trace, 'ev-1', phase)
  emit(trace, { span: 'dispatch', spanId: 'dispatch-1', parentSpanId: 'run-1', component: 'generator', componentVersion: '1', status: 'started' })
  emit(trace, { span: 'dispatch', spanId: 'dispatch-1', parentSpanId: 'run-1', component: 'generator', componentVersion: '1', status: 'succeeded', inputHashes: [HASH], budget: { inputTokens: 120, requestNumber: 1 } })
  trace.finish('succeeded')

  const snapshot = trace.snapshot()
  assert.deepEqual(snapshot.events.map(event => event.sequence), Array.from({ length: snapshot.events.length }, (_, index) => index + 1))
  assert.equal(snapshot.events[0].schemaVersion, 1)
  assert.equal(snapshot.events[0].runId, 'run-1')
  assert.deepEqual(snapshot.requiredSpanCoverage.required, ['run', 'context', 'dispatch', 'model', 'validation'])
  assert.deepEqual(snapshot.requiredSpanCoverage.observed, ['context', 'dispatch', 'run'])
  assert.equal(snapshot.requiredSpanCoverage.ratio, 3 / 5)
  assert.equal(snapshot.lineage.valid, true)
  assert.equal(snapshot.lineage.coverage, 1)
  assert.equal(snapshot.replay.mode, 'deterministic-tools')
  assert.equal(snapshot.terminalStatus, 'succeeded')
  assert.throws(() => (snapshot.events as unknown as WorkflowTraceInput[]).push({} as WorkflowTraceInput), TypeError)
  assert.throws(() => (snapshot.events[0] as unknown as { status: string }).status = 'failed', TypeError)
  assert.equal(trace.emit({ span: 'late', spanId: 'late-1', component: 'test', componentVersion: '1', status: 'started' }), false)
})

test('out-of-order parent and lineage events are rejected or measured as invalid', () => {
  const trace = makeTrace()
  assert.throws(() => trace.emit({ span: 'child', spanId: 'child-1', parentSpanId: 'parent-1', component: 'test', componentVersion: '1', status: 'started' }), /Parent span/)
  beginRun(trace)
  emit(trace, { span: 'lineage', spanId: 'lineage-1', parentSpanId: 'run-1', component: 'test', componentVersion: '1', status: 'started' })
  emit(trace, { span: 'lineage', spanId: 'lineage-1', parentSpanId: 'run-1', component: 'test', componentVersion: '1', status: 'succeeded', phase: 'selected', evidenceIds: ['ev-2'] })
  trace.finish('failed')
  const snapshot = trace.snapshot()
  assert.equal(snapshot.lineage.valid, false)
  assert.equal(snapshot.lineage.coverage, 0)
  assert.ok(snapshot.lineage.issues.includes('ev-2:missing-needed'))
  assert.deepEqual(snapshot.events.map(event => event.sequence), [1, 2, 3, 4])
})

test('cancelled run closes the run span and rejects late events', () => {
  const trace = makeTrace()
  beginRun(trace)
  trace.finish('cancelled')
  assert.equal(trace.snapshot().terminalStatus, 'cancelled')
  assert.equal(trace.snapshot().events.at(-1)?.spanId, 'run-1')
  assert.equal(trace.emit({ span: 'model', spanId: 'model-1', component: 'generator', componentVersion: '1', status: 'started' }), false)
})

test('tool failure retains a static failure reason and terminal status', () => {
  const trace = makeTrace()
  beginRun(trace)
  emit(trace, { span: 'tool', spanId: 'tool-1', parentSpanId: 'run-1', component: 'tool-gateway', componentVersion: '1', status: 'started' })
  emit(trace, { span: 'tool', spanId: 'tool-1', parentSpanId: 'run-1', component: 'tool-gateway', componentVersion: '1', status: 'failed', reason: 'tool-error' })
  trace.finish('failed')
  assert.equal(trace.snapshot().events.find(event => event.span === 'tool' && event.status === 'failed')?.reason, 'tool-error')
  assert.equal(trace.snapshot().terminalStatus, 'failed')
})

test('model interruption is distinct from recorded-model replay without a recording', () => {
  const trace = makeTrace()
  beginRun(trace)
  emit(trace, { span: 'model', spanId: 'model-1', parentSpanId: 'run-1', component: 'model-gateway', componentVersion: '1', status: 'started' })
  emit(trace, { span: 'model', spanId: 'model-1', parentSpanId: 'run-1', component: 'model-gateway', componentVersion: '1', status: 'interrupted', reason: 'model-interrupted', replayMode: 'recorded-model', snapshotAvailability: 'available' })
  trace.finish('failed')
  assert.equal(trace.snapshot().events.find(event => event.span === 'model' && event.status === 'interrupted')?.reason, 'model-interrupted')
  assert.deepEqual(trace.snapshot().replay, { mode: 'unavailable', available: false, reason: 'model-recording-missing' })
})

test('unknown provider usage stays incomplete instead of being filled with zeroes', () => {
  const trace = makeTrace()
  beginRun(trace)
  emit(trace, { span: 'model', spanId: 'model-1', parentSpanId: 'run-1', component: 'model-gateway', componentVersion: '1', status: 'started' })
  emit(trace, { span: 'model', spanId: 'model-1', parentSpanId: 'run-1', component: 'model-gateway', componentVersion: '1', status: 'succeeded', usage: { complete: false, reason: 'provider-omitted' } })
  assert.throws(() => trace.emit({ span: 'other', spanId: 'other-1', component: 'test', componentVersion: '1', status: 'started', prompt: 'arbitrary' } as unknown as WorkflowTraceInput), /Unknown/)
  assert.throws(() => trace.emit({ span: 'other', spanId: 'other-1', component: 'test', componentVersion: '1', status: 'started', usage: { complete: true } } as unknown as WorkflowTraceInput), /all token counts/)
  trace.finish('succeeded')
  assert.deepEqual(trace.snapshot().events.find(event => event.span === 'model' && event.status === 'succeeded')?.usage, { complete: false, reason: 'provider-omitted' })
})

test('asynchronous sink failure is captured without rejecting emit or flush', async () => {
  const trace = makeTrace({ sink: async () => { throw new Error('sink failure') } })
  beginRun(trace)
  assert.doesNotThrow(() => trace.emit({ span: 'context', spanId: 'context-1', parentSpanId: 'run-1', component: 'generator', componentVersion: '1', status: 'started' }))
  await assert.doesNotReject(trace.flush())
  assert.equal(trace.snapshot().integrity, false)
  assert.ok(trace.snapshot().sinkFailureCount > 0)
})

test('missing evidence snapshot makes replay explicitly unavailable', () => {
  const trace = makeTrace()
  beginRun(trace)
  emit(trace, { span: 'context', spanId: 'context-1', parentSpanId: 'run-1', component: 'generator', componentVersion: '1', status: 'started' })
  emit(trace, { span: 'context', spanId: 'context-1', parentSpanId: 'run-1', component: 'generator', componentVersion: '1', status: 'unavailable', phase: 'needed', reason: 'snapshot-missing', snapshotAvailability: 'missing' })
  trace.finish('failed')
  assert.deepEqual(trace.snapshot().replay, { mode: 'unavailable', available: false, reason: 'snapshot-missing' })
  assert.equal(trace.snapshot().lineage.available, false)
  assert.equal(trace.snapshot().lineage.coverage, 0)
})

test('private or arbitrary payload fields are rejected at runtime', () => {
  const trace = makeTrace()
  beginRun(trace)
  assert.throws(() => trace.emit({
    span: 'model', spanId: 'model-1', parentSpanId: 'run-1', component: 'model-gateway', componentVersion: '1', status: 'started',
    prompt: 'private prompt'
  } as unknown as WorkflowTraceInput), /Unknown trace event field/)
  assert.throws(() => trace.emit({
    span: 'model', spanId: 'model-1', parentSpanId: 'run-1', component: 'model-gateway', componentVersion: '1', status: 'started',
    budget: { inputTokens: 1, apiKey: 'secret' }
  } as unknown as WorkflowTraceInput), /Unknown budget field/)
})

test('constructor identities are captured and span end metadata cannot be changed', () => {
  let now = 1
  const options = {
    runId: 'run-original', projectId: 'project-original', snapshotId: 'snapshot-original', strategy: 'static' as const,
    requiredSpans: ['run'], clock: () => now++
  }
  const trace = createWorkflowTrace(options)
  options.runId = 'run-mutated'
  options.projectId = 'project-mutated'
  options.snapshotId = 'snapshot-mutated'
  options.requiredSpans[0] = 'mutated'
  emit(trace, { span: 'run', spanId: 'run-1', component: 'orchestrator', componentVersion: '1', status: 'started' })
  assert.throws(() => trace.emit({ span: 'run', spanId: 'run-1', component: 'other', componentVersion: '1', status: 'succeeded' }), /out of order/)
  trace.finish('succeeded')
  assert.equal(trace.snapshot().runId, 'run-original')
  assert.equal(trace.snapshot().events.at(-1)?.runId, 'run-original')
  assert.deepEqual(trace.snapshot().requiredSpanCoverage.required, ['run'])
  assert.throws(() => trace.finish('invalid' as 'failed'), /terminal status/)
})
