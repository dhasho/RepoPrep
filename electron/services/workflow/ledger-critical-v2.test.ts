import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { RunSpec } from './run-spec.ts'
import type { BudgetLedger, LedgerProjection, ModelStage } from './budget-ledger.ts'
import type { DurableModelContext, DurableModelEvent } from './model-journal.ts'
import type { LedgerStateV1 } from './ledger-state.ts'
import type { OriginalPlanMetadata } from './original-plan-metadata.ts'
import type { LedgerCriticalEnvelopeV2, LedgerCriticalEventV2, CriticalProducingEpoch, CriticalRecordReference, CriticalLineageV2 } from './ledger-critical-v2-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createBudgetLedger, exportBudgetLedgerState, restoreBudgetLedger, retainUnknownModel, sealBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerBinding, hashSemanticModelOperation } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { ORIGINAL_PLAN_VERSION_TAGS, ORIGINAL_PLAN_VERSION_COMMITMENTS, ORIGINAL_PLAN_RETRY_POLICY, hashOriginalPlanBinding, hashOriginalPlanMetadata, validateOriginalPlanMetadata } from './original-plan-metadata.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { prepareLedgerCriticalSpec, ledgerCriticalPosition, validateLedgerCriticalEnvelope, encodeLedgerCriticalEnvelope, createLedgerCriticalPayloadValidator } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LedgerCriticalV2Error, LEDGER_CRITICAL_V2_FORMAT, LEDGER_CRITICAL_V2_SCHEMA_ID, LEDGER_CRITICAL_V2_MAX_LINEAGE_BYTES, LEDGER_CRITICAL_V2_MAX_BYTES, prepareLedgerCriticalV2Spec, ledgerCriticalV2Position, validateLedgerCriticalV2Envelope, encodeLedgerCriticalV2Envelope, decodeLedgerCriticalV2Envelope, createLedgerCriticalV2PayloadValidator } from './ledger-critical-v2-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerCriticalV2Cursor, checkLedgerCriticalV2Transition, acceptLedgerCriticalV2Step, foldLedgerCriticalV2Prefix } from './ledger-critical-v2-transitions.ts'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const usage = (inputTokens = 8, outputTokens = 6) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })
const baseInput = () => ({ version: 1, runId: 'critical-v2-run', projectId: 'critical-project', snapshotId: 'critical-snapshot', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: 'synthetic', endpointFingerprint: 'a'.repeat(64), model: 'synthetic', protocol: 'openai', temperature: -0, contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'workflow-prompt-v2', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
const epoch1 = Object.freeze({ owner: 1, attempt: 1, attemptId: '11111111-1111-4111-8111-111111111111' })
const epoch2 = Object.freeze({ owner: 2, attempt: 2, attemptId: '22222222-2222-4222-8222-222222222222' })
const code = (expected?: string) => (error: unknown): boolean => {
  assert.ok(error instanceof LedgerCriticalV2Error)
  if (expected) assert.equal(error.code, expected)
  assert.equal(error.message, error.code)
  return true
}
function fixture(input: unknown = baseInput(), bootstrap = true) {
  const spec = createRunSpec(input), prepared = prepareLedgerCriticalV2Spec({ spec })
  let monotonic = 0, utc = 1_000_000, producingEpoch: CriticalProducingEpoch = epoch1
  let ledger: BudgetLedger = createBudgetLedger(spec, { clock: () => monotonic, utcClock: () => utc, durable: true })
  let cursor = createLedgerCriticalV2Cursor(prepared)
  const records: { payload: LedgerCriticalEnvelopeV2; reference: CriticalRecordReference }[] = []
  function make(event: LedgerCriticalEventV2, projection?: LedgerProjection, state?: LedgerStateV1, lineage: CriticalLineageV2 = cursor.lineage): LedgerCriticalEnvelopeV2 {
    const provenance = { binding: prepared.binding, producingEpoch, sequence: cursor.logicalPosition.sequence + 1, previous: cursor.reference }
    const logicalPosition = ledgerCriticalV2Position(prepared, provenance, event, lineage)
    return { format: LEDGER_CRITICAL_V2_FORMAT, originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition, lineage,
      state: state ? { ...state, binding: createLedgerBinding(spec, logicalPosition) } : exportBudgetLedgerState(ledger, createLedgerBinding(spec, logicalPosition), projection) }
  }
  function outerBytes(payload: LedgerCriticalEnvelopeV2): Buffer {
    // Actual complete W encoding byte shape, not an authentic W write or ack.
    return Buffer.from(JSON.stringify({ format: 'workflow-journal/v1', binding: payload.provenance.binding, producingEpoch: payload.provenance.producingEpoch, kind: 'critical-journal', schemaId: LEDGER_CRITICAL_V2_SCHEMA_ID, payload, sequence: payload.provenance.sequence, previous: payload.provenance.previous }))
  }
  function reference(payload: LedgerCriticalEnvelopeV2): CriticalRecordReference {
    const bytes = outerBytes(payload)
    return { id: 'j-' + String(payload.provenance.sequence).padStart(12, '0'), producingEpoch: payload.provenance.producingEpoch, byteLength: bytes.length, sha256: hash(bytes.toString()) }
  }
  function accept(payload: LedgerCriticalEnvelopeV2) {
    const ref = reference(payload)
    cursor = acceptLedgerCriticalV2Step(checkLedgerCriticalV2Transition(cursor, payload), ref)
    records.push({ payload, reference: ref })
  }
  const append = (event: LedgerCriticalEventV2, projection?: LedgerProjection) => { const env = make(event, projection); accept(env); return env }
  function context(id: string, stage: ModelStage = 'investigation'): DurableModelContext {
    const semanticHash = hash('semantic:' + id)
    return { runId: spec.runId, projectId: spec.projectId, snapshotId: spec.snapshotId, attemptId: producingEpoch.attemptId, fence: producingEpoch.owner, id, stage, semanticHash, semanticOperationHash: hashSemanticModelOperation(spec, stage, semanticHash), requestHash: hash('request:' + id), manifestHash: hash('manifest:' + id), inputTokens: 10, outputTokens: 10, contextChars: 20 }
  }
  const model = (kind: DurableModelEvent['kind'], context: DurableModelContext, receipt: ReturnType<typeof usage> | null = null): LedgerCriticalEventV2 => ({ kind: 'model', model: { version: 1, kind, context, usage: receipt, outputStatus: 'missing', failureCode: kind === 'unknown' ? 'receipt-unavailable' : 'none' } })
  function reserve(c: DurableModelContext) { ledger.reserveModel({ id: c.id, stage: c.stage, inputTokens: c.inputTokens, outputTokens: c.outputTokens, contextChars: c.contextChars, semanticHash: c.semanticHash, semanticOperationHash: c.semanticOperationHash, requestHash: c.requestHash, manifestHash: c.manifestHash }) }
  function start(c: DurableModelContext) { reserve(c); append(model('reservation', c)); append(model('intent', c), { id: c.id, state: 'dispatched', usage: null }); ledger.markDispatched(c.id) }
  function settle(c: DurableModelContext, receipt = usage()) { append(model('receipt', c, receipt), { id: c.id, state: 'settled', usage: receipt }); ledger.settleModel(c.id, receipt) }
  function read(bytes = 100, actual = 40) { ledger.chargeTool('tool:1', 'investigation'); append({ kind: 'tool-charge', id: 'tool:1', stage: 'investigation' }); ledger.reserveRead('read:1', bytes); append({ kind: 'read-reservation', id: 'read:1', reservedBytes: bytes }); ledger.settleRead('read:1', actual); append({ kind: 'read-receipt', id: 'read:1', actualBytes: actual }) }
  function metadata(): OriginalPlanMetadata {
    return validateOriginalPlanMetadata({ version: 1, bindingHash: hashOriginalPlanBinding(prepared.binding), runSpecHash: prepared.binding.runSpecHash, configHash: prepared.binding.configHash,
      objectiveHash: hash('objective'), snapshotHash: hash(spec.snapshotId), evidenceHash: hash('evidence'), investigationHash: hash('investigation'), contextHash: hash('context'), versions: ORIGINAL_PLAN_VERSION_COMMITMENTS, writerVariant: 'topic-cards', questionBudget: spec.questionBudget, remainingModelRequests: spec.budget.total.maxModelRequests - cursor.state!.models.length, plannedTotal: 32, slots: [{ ordinal: 1, kind: 'global', weight: 1, quota: 16, sourceGroupHash: hash('same-source-group') }, { ordinal: 2, kind: 'module', weight: 1, quota: 16, sourceGroupHash: hash('same-source-group') }], retry: ORIGINAL_PLAN_RETRY_POLICY }, spec, prepared.binding)
  }
  function plan(value = metadata(), state?: LedgerStateV1) { return make({ kind: 'plan', planHash: hashOriginalPlanMetadata(value, spec, prepared.binding) }, undefined, state, { plan: value }) }
  function recover() {
    const state = cursor.state!
    // Synthetic recovery authority only for actual L fixture; never W proof.
    if (cursor.terminalOutcome === null) ledger = restoreBudgetLedger(spec, state, { clock: () => monotonic, utcClock: () => utc, authority: { binding: state.binding, assertCurrent() {} } })
    producingEpoch = epoch2; append({ kind: 'recovery', from: cursor.logicalPosition })
  }
  if (bootstrap) append({ kind: 'created', genesis: prepared.genesis })
  return { spec, prepared, records, make, accept, append, outerBytes, reference, context, model, reserve, start, settle, read, metadata, plan, recover,
    get ledger() { return ledger }, get cursor() { return cursor }, advance(ms: number) { monotonic += ms; utc += ms } }
}
function settled() { const f = fixture(), c = f.context('decision:1'); f.start(c); f.settle(c); f.read(); return f }

test('V2 independently commits genesis, exact original spec, binding, event, lineage and full outer reference', () => {
  const f = fixture(), envelope = f.records[0].payload, p = envelope.provenance
  assert.equal(f.prepared.genesis.hash, hash(['repoprep.workflow.ledger-genesis.v2', f.prepared.binding]))
  assert.equal(envelope.logicalPosition.hash, hash(['repoprep.workflow.ledger-position.v2', p.binding, p.producingEpoch, p.sequence, p.previous, envelope.event, envelope.lineage]))
  const v1 = prepareLedgerCriticalSpec({ spec: f.spec })
  assert.notDeepEqual(v1.genesis, f.prepared.genesis)
  assert.deepEqual(v1.binding, f.prepared.binding)
  assert.equal(Object.is(f.prepared.spec.model.temperature, -0), true)
  assert.deepEqual(decodeLedgerCriticalV2Envelope(encodeLedgerCriticalV2Envelope(envelope)), validateLedgerCriticalV2Envelope(envelope))
  assert.equal(f.records[0].reference.byteLength, f.outerBytes(envelope).length)
  assert.equal(f.records[0].reference.sha256, hash(f.outerBytes(envelope).toString()))
  assert.ok(f.outerBytes(envelope).length > encodeLedgerCriticalV2Envelope(envelope).length)
})
test('V2 actual accounting accepts settled model/read/tool then one immutable plan without new budget', () => {
  const f = settled(), before = f.cursor.state!, env = f.plan()
  f.advance(20); f.accept(env)
  assert.deepEqual(f.cursor.state!.models, before.models); assert.deepEqual(f.cursor.state!.reads, before.reads); assert.deepEqual(f.cursor.state!.tools, before.tools)
  assert.equal(Object.isFrozen(f.cursor.lineage.plan!.slots[0]), true)
  assert.equal(f.cursor.lineage.plan!.slots[0].sourceGroupHash, f.cursor.lineage.plan!.slots[1].sourceGroupHash)
  assert.notEqual(f.cursor.lineage.plan!.slots[0].ordinal, f.cursor.lineage.plan!.slots[1].ordinal)
  assert.deepEqual(foldLedgerCriticalV2Prefix(f.records).lineage, f.cursor.lineage)
  assert.equal(f.cursor.terminalOutcome, null)
  assert.deepEqual(Object.keys(f.cursor).sort(), ['binding', 'lineage', 'logicalPosition', 'reference', 'state', 'terminalOutcome'])
})
for (const kind of ['cancelled', 'failed'] as const) test('V2 plan ancestry remains exact through ' + kind + ' seal and frozen recovery', () => {
  const f = settled(); f.accept(f.plan()); const plan = f.cursor.lineage.plan
  sealBudgetLedger(f.ledger); f.append({ kind: 'seal', outcome: kind })
  f.recover(); assert.deepEqual(f.cursor.lineage.plan, plan); assert.equal(f.cursor.terminalOutcome, kind)
  assert.deepEqual(foldLedgerCriticalV2Prefix(f.records).state, f.cursor.state)
  assert.throws(() => f.append({ kind: 'tool-charge', id: 'late', stage: 'investigation' }), code())
})
for (const sent of [false, true]) test('V2 conservative unknown ' + (sent ? 'sent' : 'unsent') + ' and recovery keep all holds', () => {
  const f = fixture(), c = f.context('unknown')
  if (sent) f.start(c); else { f.reserve(c); f.append(f.model('reservation', c)) }
  retainUnknownModel(f.ledger, c.id, sent); f.append(f.model('unknown', c))
  const before = f.cursor.state!; assert.equal(before.models[0].outputTokens, 10)
  assert.throws(() => f.accept(f.plan()), code())
  f.recover(); assert.deepEqual(f.cursor.state!.models, before.models)
  sealBudgetLedger(f.ledger); f.append({ kind: 'seal', outcome: 'cancelled' })
  assert.equal(foldLedgerCriticalV2Prefix(f.records).terminalOutcome, 'cancelled')
})
test('V2 recovery of a dispatched row cannot refund it or accept an old epoch receipt', () => {
  const f = fixture(), c = f.context('dispatched'); f.start(c); f.recover()
  assert.equal(f.cursor.state!.models[0].state, 'unknown')
  assert.throws(() => f.append(f.model('receipt', c, usage())), code())
  const state = clone(f.cursor.state!); (state as any).models = []
  assert.throws(() => f.accept(f.make({ kind: 'tool-charge', id: 'fake', stage: 'investigation' }, undefined, state)), code())
})
for (const receipt of [usage(8, 6), usage(12, 15)]) test('V2 model receipt diagnostics use the actual shared policy ' + receipt.totalTokens, () => {
  const f = fixture(), c = f.context('metered'); f.start(c); f.settle(c, receipt)
  assert.equal(f.cursor.state!.diagnostics.overspendInputTokens, Math.max(0, receipt.inputTokens - 10))
  assert.equal(f.cursor.state!.diagnostics.overspendOutputTokens, Math.max(0, receipt.outputTokens - 10))
  assert.deepEqual(foldLedgerCriticalV2Prefix(f.records).state, f.cursor.state)
})
test('V2 read receipts cannot precede reservation or refund an exposed read', () => {
  const f = fixture(); f.ledger.reserveRead('read:1', 100); f.append({ kind: 'read-reservation', id: 'read:1', reservedBytes: 100 })
  const before = clone(f.cursor.state!); (before as any).reads = []
  assert.throws(() => f.accept(f.make({ kind: 'tool-charge', id: 'fake', stage: 'investigation' }, undefined, before)), code())
  f.ledger.settleRead('read:1', 130); f.append({ kind: 'read-receipt', id: 'read:1', actualBytes: 130 })
  assert.equal(f.cursor.state!.diagnostics.overspendReadBytes, 30)
  assert.throws(() => f.append({ kind: 'read-receipt', id: 'read:1', actualBytes: 130 }), code())
})
for (const mutation of ['models', 'reads', 'tools', 'issuedIds', 'diagnostics', 'start', 'deadline', 'rollback', 'blocked'] as const) test('V2 plan cannot change accounting: ' + mutation, () => {
  const f = settled(), state = clone(f.cursor.state!) as any
  if (mutation === 'models') state.models[0].usage.inputTokens--
  if (mutation === 'reads') state.reads[0].actualBytes--
  if (mutation === 'tools') state.tools = []
  if (mutation === 'issuedIds') state.issuedIds = []
  if (mutation === 'diagnostics') state.diagnostics.doubleSettlements++
  if (mutation === 'start') state.time.startedUtcMs--
  if (mutation === 'deadline') state.time.expiresUtcMs++
  if (mutation === 'rollback') state.time.utcHighWaterMs--
  if (mutation === 'blocked') state.blocked = true
  assert.throws(() => f.accept(f.plan(f.metadata(), state)), code())
})
test('V2 plan permits genuine monotonic clock progress without resetting original deadline', () => {
  const f = settled(), before = f.cursor.state!.time
  f.advance(250); f.accept(f.plan())
  assert.equal(f.cursor.state!.time.startedUtcMs, before.startedUtcMs); assert.equal(f.cursor.state!.time.expiresUtcMs, before.expiresUtcMs)
  assert.equal(f.cursor.state!.time.elapsedHighWaterMs, before.elapsedHighWaterMs + 250)
})
for (const changed of [false, true]) test('V2 rejects a ' + (changed ? 'changed' : 'repeated') + ' second plan', () => {
  const f = settled(); f.accept(f.plan()); const plan = clone(f.cursor.lineage.plan!) as any
  if (changed) plan.objectiveHash = hash('changed')
  assert.throws(() => f.accept(f.plan(plan)), code('LEDGER_CRITICAL_V2_TRANSITION_INVALID'))
})
test('V2 accounting cannot silently add, remove or change accepted plan lineage', () => {
  const f = settled(), p = f.metadata()
  f.ledger.chargeTool('tool:2', 'investigation')
  assert.throws(() => f.accept(f.make({ kind: 'tool-charge', id: 'tool:2', stage: 'investigation' }, undefined, undefined, { plan: p })), code())
  f.append({ kind: 'tool-charge', id: 'tool:2', stage: 'investigation' })
  f.accept(f.plan()); f.ledger.chargeTool('tool:3', 'investigation')
  const event = { kind: 'tool-charge', id: 'tool:3', stage: 'investigation' } as const
  assert.throws(() => f.accept(f.make(event, undefined, undefined, { plan: null })), code())
  const changed = clone(p) as any; changed.contextHash = hash('changed')
  assert.throws(() => f.accept(f.make(event, undefined, undefined, { plan: changed })), code())
})
test('V2 plan requires settled actual investigation model/read rows and original remaining-request sample', () => {
  const empty = fixture(); assert.throws(() => empty.accept(empty.plan()), code())
  const f = settled(); const p = clone(f.metadata()) as any; p.remainingModelRequests--
  assert.throws(() => f.accept(f.plan(p)), code())
  f.ledger.reserveRead('pending', 20); f.append({ kind: 'read-reservation', id: 'pending', reservedBytes: 20 })
  assert.throws(() => f.accept(f.plan()), code())
})
for (const stage of ['generation', 'review', 'repair', 'compensation'] as const) test('V2 plan-only format cannot admit premature ' + stage, () => {
  const f = fixture(), c = f.context('forbidden', stage)
  f.reserve(c); assert.throws(() => f.append(f.model('reservation', c)), code())
  assert.throws(() => f.make({ kind: 'tool-charge', id: 'forbidden-tool', stage }), code())
})
test('V2 refuses completed/succeeded and unknown event/lineage extensions', () => {
  const f = fixture()
  for (const event of [{ kind: 'seal', outcome: 'completed' }, { kind: 'succeeded' }, { kind: 'output', hash: hash('output') }, { kind: 'plan', planHash: hash('p'), extra: 1 }]) assert.throws(() => f.make(event as never), code())
  assert.throws(() => ledgerCriticalV2Position(f.prepared, f.records[0].payload.provenance, { kind: 'created', genesis: f.prepared.genesis }, { plan: null, output: hash('x') }), code())
})
test('V1 and V2 codecs, prepared tokens and fold prefixes cannot mix or silently migrate', () => {
  const f = fixture(), env = f.records[0].payload
  assert.throws(() => validateLedgerCriticalEnvelope(env)); assert.throws(() => validateLedgerCriticalV2Envelope({ ...env, format: 'workflow-ledger-critical/v1' }), code())
  const p1 = prepareLedgerCriticalSpec({ spec: f.spec })
  assert.throws(() => createLedgerCriticalV2Cursor(p1 as never), code('LEDGER_CRITICAL_V2_TOKEN_INVALID'))
  const provenance = env.provenance, event = { kind: 'created', genesis: p1.genesis } as const
  const position = ledgerCriticalPosition(p1, provenance, event)
  const v1 = { format: 'workflow-ledger-critical/v1', originalSpecJson: p1.originalSpecJson, provenance, event, logicalPosition: position, state: exportBudgetLedgerState(f.ledger, createLedgerBinding(f.spec, position)) }
  const bytes = encodeLedgerCriticalEnvelope(v1)
  assert.throws(() => decodeLedgerCriticalV2Envelope(bytes), code())
  assert.throws(() => foldLedgerCriticalV2Prefix([{ payload: v1, reference: f.records[0].reference }]), code())
  assert.throws(() => foldLedgerCriticalV2Prefix([...f.records, { payload: v1, reference: f.records[0].reference }]), code())
  assert.equal(createLedgerCriticalPayloadValidator().validate(env), false)
  assert.equal(createLedgerCriticalV2PayloadValidator().validate(v1), false)
})
test('V2 own private prepared/cursor/step tokens are linear bookkeeping and reject copies', () => {
  const f = fixture(undefined, false)
  assert.throws(() => createLedgerCriticalV2Cursor({ ...f.prepared }), code('LEDGER_CRITICAL_V2_TOKEN_INVALID'))
  const env = f.make({ kind: 'created', genesis: f.prepared.genesis }), ref = f.reference(env)
  assert.throws(() => checkLedgerCriticalV2Transition({ ...f.cursor }, env), code('LEDGER_CRITICAL_V2_TOKEN_INVALID'))
  const step = checkLedgerCriticalV2Transition(f.cursor, env)
  assert.throws(() => acceptLedgerCriticalV2Step({ ...step }, ref), code('LEDGER_CRITICAL_V2_TOKEN_INVALID'))
  acceptLedgerCriticalV2Step(step, ref)
  assert.throws(() => acceptLedgerCriticalV2Step(step, ref), code('LEDGER_CRITICAL_V2_TOKEN_INVALID'))
  assert.throws(() => checkLedgerCriticalV2Transition(f.cursor, env), code('LEDGER_CRITICAL_V2_TOKEN_INVALID'))
})
for (const field of ['sequence', 'previous', 'binding', 'epoch', 'spec'] as const) test('V2 rejects changed exact provenance: ' + field, () => {
  const f = settled(), env = clone(f.plan()) as any
  if (field === 'sequence') env.provenance.sequence++
  if (field === 'previous') env.provenance.previous.sha256 = hash('foreign-reference')
  if (field === 'binding') env.provenance.binding.configHash = hash('foreign-config')
  if (field === 'epoch') env.provenance.producingEpoch = epoch2
  if (field === 'spec') env.originalSpecJson = prepareLedgerCriticalV2Spec({ spec: createRunSpec({ ...baseInput(), runId: 'other-run' }) }).originalSpecJson
  assert.throws(() => f.accept(env), code())
})
test('V2 verifies references and never interprets caller-shaped refs as authentic W proof', () => {
  const f = settled(), env = f.plan(), step = checkLedgerCriticalV2Transition(f.cursor, env), ref = f.reference(env)
  for (const change of [{ id: 'j-000000000001' }, { byteLength: LEDGER_CRITICAL_V2_MAX_BYTES + 1 }, { producingEpoch: epoch2 }, { sha256: 'malformed' }]) assert.throws(() => acceptLedgerCriticalV2Step(step, { ...ref, ...change }), code())
  const accepted = acceptLedgerCriticalV2Step(step, { ...ref, sha256: hash('well-shaped-but-untrusted') })
  assert.equal(accepted.reference!.sha256, hash('well-shaped-but-untrusted'))
  // This documents the pure fold's authenticity limit; host ack/tail verification is separate.
})
test('V2 lineage is hashes/enums/counters only, rejects payload text and malformed ordinals/commitments', () => {
  const f = settled(), base = f.metadata()
  for (const mutate of [(p: any) => { p.label = 'private-source-path' }, (p: any) => { p.versions.writer = 'm08-evidence-writer-v5' }, (p: any) => { p.slots[1].ordinal = 1 }, (p: any) => { p.slots[0].sourceGroupHash = 'bad' }, (p: any) => { p.runSpecHash = hash('other') }, (p: any) => { p.questionBudget.min++ }, (p: any) => { p.plannedTotal++ }, (p: any) => { p.retry.maxFormatRetriesPerChain = 2 }]) {
    const p = clone(base); mutate(p); assert.throws(() => f.plan(p))
  }
  const infeasible = clone(base) as any; infeasible.slots = [{ ...infeasible.slots[0], quota: 2 }]; infeasible.plannedTotal = 2
  assert.equal(validateOriginalPlanMetadata(infeasible, f.spec, f.prepared.binding).plannedTotal, 2)
})
test('V2 untrusted data accessors/proxies/arrays never execute caller getters', () => {
  const f = settled(); let calls = 0
  for (const value of [Object.defineProperty({ ...f.metadata() }, 'objectiveHash', { enumerable: true, get() { calls++; return hash('x') } }), new Proxy({}, { ownKeys() { calls++; return [] } })]) assert.throws(() => f.plan(value as never))
  const bad = Object.defineProperty({ ...f.plan() }, 'lineage', { enumerable: true, get() { calls++; return { plan: null } } })
  assert.throws(() => validateLedgerCriticalV2Envelope(bad), code())
  const sparse = clone(f.metadata()) as any; delete sparse.slots[0]; assert.throws(() => f.plan(sparse))
  assert.equal(calls, 0)
})
for (const bad of ['{} {}', '{"a":1,"\u0061":2}', '{"x":{"x":1,"x":2}}', '[1,]', '{"x":01}', '\ufeff{}']) test('V2 strict byte reader refuses ' + bad, () => {
  assert.throws(() => decodeLedgerCriticalV2Envelope(Buffer.from(bad)), code())
})
test('V2 lineage4MiB and complete-record64MiB limits reject without truncating accepted ancestry', () => {
  const f = settled(), before = f.cursor
  assert.throws(() => f.make({ kind: 'plan', planHash: hash('oversized') }, undefined, undefined, { plan: 'x'.repeat(LEDGER_CRITICAL_V2_MAX_LINEAGE_BYTES) } as never), code('LEDGER_CRITICAL_V2_TOO_LARGE'))
  assert.throws(() => decodeLedgerCriticalV2Envelope(Buffer.alloc(LEDGER_CRITICAL_V2_MAX_BYTES + 1)), code('LEDGER_CRITICAL_V2_TOO_LARGE'))
  assert.equal(f.cursor, before); assert.equal(f.cursor.lineage.plan, null)
  const env = f.plan(), inner = encodeLedgerCriticalV2Envelope(env), outer = f.outerBytes(env)
  assert.ok(outer.length > inner.length)
  // Pure record sizing includes every outer byte and cumulatively repeated plan.
  // It does not pretend that these data bytes allocate storage or admit a run.
  f.accept(env); const sizeWithPlan = f.records.reduce((n, r) => n + f.outerBytes(r.payload).length, 0)
  assert.ok(sizeWithPlan > f.records.reduce((n, r) => n + encodeLedgerCriticalV2Envelope(r.payload).length, 0))
})
test('V2 carried-spec payload validator is self-contained and rejects current-only substitutions', () => {
  const validator = createLedgerCriticalV2PayloadValidator(), one = fixture(), two = fixture({ ...baseInput(), runId: 'other', granularity: 'coarse' })
  assert.equal(validator.validate(one.records[0].payload), true); assert.equal(validator.validate(two.records[0].payload), true)
  assert.equal(validator.validate({ ...one.records[0].payload, originalSpecJson: two.prepared.originalSpecJson }), false)
  assert.equal(validator.schemaId, LEDGER_CRITICAL_V2_SCHEMA_ID)
})

for (const component of ['planner', 'grouping', 'output', 'merge', 'writer'] as const) test('V2 closed plan rejects unknown or cross-component version: ' + component, () => {
  const f = settled(), p = clone(f.metadata()) as any
  assert.equal(p.versions[component], hash(['repoprep.workflow.original-plan-policy-version.v1', component, ORIGINAL_PLAN_VERSION_TAGS[component]]))
  p.versions[component] = hash('unknown-version')
  assert.throws(() => f.plan(p), { message: 'ORIGINAL_PLAN_METADATA_INVALID' })
  assert.throws(() => validateLedgerCriticalV2Envelope({ ...f.plan(), lineage: { plan: p } }), code())
  p.versions[component] = hash(['repoprep.workflow.original-plan-policy-version.v1', 'other-component', ORIGINAL_PLAN_VERSION_TAGS[component]])
  assert.throws(() => f.plan(p), { message: 'ORIGINAL_PLAN_METADATA_INVALID' })
  assert.throws(() => validateLedgerCriticalV2Envelope({ ...f.plan(), lineage: { plan: p } }), code())
})
test('V2 original retry descriptor preserves one format retry, two compensation rounds and ask eight', () => {
  const f = settled(), env = f.plan()
  assert.deepEqual(env.lineage.plan!.retry, { maxFormatRetriesPerChain: 1, maxCompensationRounds: 2, maxCompensationAsk: 8 })
  f.accept(env)
  assert.deepEqual(foldLedgerCriticalV2Prefix(f.records).lineage.plan!.retry, ORIGINAL_PLAN_RETRY_POLICY)
  for (const [key, values] of Object.entries({ maxFormatRetriesPerChain: [0, 2], maxCompensationRounds: [0, 1, 3], maxCompensationAsk: [0, 7, 9] })) {
    for (const value of values) {
      const p = clone(f.metadata()) as any; p.retry[key] = value
      assert.throws(() => f.plan(p), { message: 'ORIGINAL_PLAN_METADATA_INVALID' })
      assert.throws(() => validateLedgerCriticalV2Envelope({ ...f.plan(), lineage: { plan: p } }), code())
    }
  }
  const old = clone(f.metadata()) as any; old.retry = { formatAttemptsPerSlot: 1, compensationRequests: 1 }
  assert.throws(() => f.plan(old), { message: 'ORIGINAL_PLAN_METADATA_INVALID' })
  assert.throws(() => validateLedgerCriticalV2Envelope({ ...f.plan(), lineage: { plan: old } }), code())
})
test('V2 logical position binds all accepted plan commitments independently of accounting rows', () => {
  const f = settled(), first = f.plan(), p = clone(f.metadata()) as any
  p.objectiveHash = hash('changed-objective')
  const changed = f.plan(p)
  assert.notEqual(first.logicalPosition.hash, changed.logicalPosition.hash)
  assert.notEqual((first.event as { planHash: string }).planHash, (changed.event as { planHash: string }).planHash)
  const forged = { ...first, lineage: changed.lineage }
  assert.throws(() => validateLedgerCriticalV2Envelope(forged), code())
})

test('V2 metadata deeply rejects side-effectful scalar substitutions without inspecting them', () => {
  const f = settled(); let calls = 0
  const poison = new Proxy({}, { ownKeys() { calls++; return ['secret'] }, get() { calls++; return 'secret' }, getPrototypeOf() { calls++; return Object.prototype } })
  for (const mutate of [(p: any) => { p.versions.planner = poison }, (p: any) => { p.questionBudget.min = poison }, (p: any) => { p.retry.maxCompensationAsk = poison }, (p: any) => { p.slots[0].sourceGroupHash = poison }]) {
    const p = clone(f.metadata()); mutate(p)
    assert.throws(() => validateOriginalPlanMetadata(p, f.spec, f.prepared.binding), { message: 'ORIGINAL_PLAN_METADATA_INVALID' })
  }
  assert.equal(calls, 0)
})
for (const extra of [0, 1]) test('V2 plan rejects original total deadline at or beyond expiration ' + extra, () => {
  const f = settled(), before = f.cursor
  f.advance(f.spec.budget.total.wallClockMs + extra)
  assert.throws(() => f.accept(f.plan()), code('LEDGER_CRITICAL_V2_TRANSITION_INVALID'))
  assert.equal(f.cursor, before)
})
