import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { RunSpec } from './run-spec.ts'
import type { BudgetLedger, LedgerProjection, ModelStage } from './budget-ledger.ts'
import type { DurableModelContext, DurableModelEvent } from './model-journal.ts'
import type { LedgerStateV1 } from './ledger-state.ts'
import type { CriticalProducingEpoch, CriticalRecordReference, LedgerCriticalEnvelopeV1, LedgerCriticalEvent } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createRunSpec, fingerprintRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createBudgetLedger, exportBudgetLedgerState, restoreBudgetLedger, retainUnknownModel, sealBudgetLedger, blockBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerBinding, hashSemanticModelOperation } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { encodeSavedRunSpec, hashSavedRunSpec, SAVED_RUN_SPEC_HASH_DOMAIN } from './saved-run-spec.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { LedgerCriticalError, LEDGER_CRITICAL_MAX_BYTES, LEDGER_CRITICAL_MAX_NODES, LEDGER_CRITICAL_MAX_DEPTH, prepareLedgerCriticalSpec, ledgerCriticalPosition, validateLedgerCriticalEnvelope, encodeLedgerCriticalEnvelope, decodeLedgerCriticalEnvelope, createLedgerCriticalPayloadValidator } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createLedgerCriticalCursor, checkLedgerCriticalTransition, acceptLedgerCriticalStep, foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'

const baseInput = () => ({ version: 1, runId: 'critical-run', projectId: 'critical-project', snapshotId: 'critical-snapshot', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine',
  model: { profileId: 'synthetic-profile', endpointFingerprint: 'a'.repeat(64), model: 'synthetic-model', protocol: 'openai', temperature: -0, contextWindowTokens: 49152, maxOutputTokens: 4096 },
  promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1' })
function canon(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canon((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
const hash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : canon(value), 'utf8').digest('hex')
const usage = (inputTokens = 8, outputTokens = 6) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const epoch1: CriticalProducingEpoch = Object.freeze({ owner: 1, attempt: 1, attemptId: '11111111-1111-4111-8111-111111111111' })
const epoch2: CriticalProducingEpoch = Object.freeze({ owner: 2, attempt: 2, attemptId: '22222222-2222-4222-8222-222222222222' })
const code = (expected?: string) => (error: unknown): boolean => {
  assert.ok(error instanceof LedgerCriticalError)
  assert.ok(['LEDGER_CRITICAL_INVALID', 'LEDGER_CRITICAL_BYTES_INVALID', 'LEDGER_CRITICAL_TOO_LARGE', 'LEDGER_CRITICAL_TRANSITION_INVALID', 'LEDGER_CRITICAL_TOKEN_INVALID'].includes(error.code))
  if (expected) assert.equal(error.code, expected)
  assert.equal(error.message, error.code); assert.equal(error.message.includes('do-not-echo'), false)
  return true
}
function fixture(input: unknown = baseInput(), bootstrap = true) {
  const spec = createRunSpec(input), prepared = prepareLedgerCriticalSpec({ spec })
  let monotonic = 0, utc = 1_000_000, producingEpoch = epoch1
  let ledger = createBudgetLedger(spec, { clock: () => monotonic, utcClock: () => utc, durable: true })
  let cursor = createLedgerCriticalCursor(prepared)
  const records: { payload: LedgerCriticalEnvelopeV1; reference: CriticalRecordReference }[] = []
  function make(event: LedgerCriticalEvent, projection?: LedgerProjection, state?: LedgerStateV1): LedgerCriticalEnvelopeV1 {
    const provenance = { binding: prepared.binding, producingEpoch, sequence: cursor.logicalPosition.sequence + 1, previous: cursor.reference }
    const logicalPosition = ledgerCriticalPosition(prepared, provenance, event)
    return { format: 'workflow-ledger-critical/v1', originalSpecJson: prepared.originalSpecJson, provenance, event, logicalPosition,
      state: state ? { ...state, binding: createLedgerBinding(spec, logicalPosition) } : exportBudgetLedgerState(ledger, createLedgerBinding(spec, logicalPosition), projection) }
  }
  function reference(payload: LedgerCriticalEnvelopeV1): CriticalRecordReference {
    // Synthetic W-like byte/ref DATA. This test does not issue authentic W proof.
    const bytes = JSON.stringify({ format: 'workflow-journal/v1', binding: payload.provenance.binding, producingEpoch: payload.provenance.producingEpoch, kind: 'critical-journal', schemaId: 'workflow-ledger-critical-v1', payload, sequence: payload.provenance.sequence, previous: payload.provenance.previous })
    return { id: 'j-' + String(payload.provenance.sequence).padStart(12, '0'), producingEpoch: payload.provenance.producingEpoch, byteLength: Buffer.byteLength(bytes), sha256: hash(bytes) }
  }
  function accept(payload: LedgerCriticalEnvelopeV1): void {
    const ref = reference(payload)
    cursor = acceptLedgerCriticalStep(checkLedgerCriticalTransition(cursor, payload), ref)
    records.push({ payload, reference: ref })
  }
  const append = (event: LedgerCriticalEvent, projection?: LedgerProjection) => { const payload = make(event, projection); accept(payload); return payload }
  function context(id: string, stage: ModelStage = 'review', inputTokens = 10, outputTokens = 10): DurableModelContext {
    const semanticHash = hash('semantic:' + id)
    return { runId: spec.runId, projectId: spec.projectId, snapshotId: spec.snapshotId, attemptId: producingEpoch.attemptId, fence: producingEpoch.owner,
      id, stage, semanticHash, semanticOperationHash: hashSemanticModelOperation(spec, stage, semanticHash), requestHash: hash('request:' + id), manifestHash: hash('manifest:' + id), inputTokens, outputTokens, contextChars: 20 }
  }
  function reserve(c: DurableModelContext): void {
    ledger.reserveModel({ id: c.id, stage: c.stage, inputTokens: c.inputTokens, outputTokens: c.outputTokens, contextChars: c.contextChars, semanticHash: c.semanticHash, semanticOperationHash: c.semanticOperationHash, requestHash: c.requestHash, manifestHash: c.manifestHash })
  }
  const model = (kind: DurableModelEvent['kind'], c: DurableModelContext, receipt: ReturnType<typeof usage> | null = null, outputStatus: DurableModelEvent['outputStatus'] = 'missing'): LedgerCriticalEvent => ({ kind: 'model', model: { version: 1, kind, context: c, usage: receipt, outputStatus, failureCode: kind === 'unknown' ? 'receipt-unavailable' : 'none' } })
  function start(c: DurableModelContext): void {
    reserve(c); append(model('reservation', c)); append(model('intent', c), { id: c.id, state: 'dispatched', usage: null }); ledger.markDispatched(c.id)
  }
  function recover(epoch = epoch2): void {
    const state = cursor.state!, binding = state.binding
    // Structural authority here is only a synthetic test fixture for actual L.
    if (cursor.terminalOutcome === null) ledger = restoreBudgetLedger(spec, state, { clock: () => monotonic, utcClock: () => utc, authority: { binding, assertCurrent() {} } })
    producingEpoch = epoch; append({ kind: 'recovery', from: cursor.logicalPosition })
  }
  if (bootstrap) append({ kind: 'created', genesis: prepared.genesis })
  return { spec, prepared, records, make, accept, reference, append, context, reserve, model, start, recover,
    get ledger(): BudgetLedger { return ledger }, get cursor() { return cursor }, get epoch() { return producingEpoch },
    setEpoch(epoch: CriticalProducingEpoch) { producingEpoch = epoch }, tick(ms: number) { monotonic += ms; utc += ms }, rollback(ms: number) { utc -= ms } }
}

for (const strategy of ['static', 'agentic']) for (const granularity of ['coarse', 'medium', 'fine']) test('A0 equivalence and immutable prepare: ' + strategy + '/' + granularity, () => {
  const spec = createRunSpec({ ...baseInput(), strategy, strategyVersion: strategy + '-v1', granularity }), p = prepareLedgerCriticalSpec({ spec })
  assert.equal(p.originalSpecJson, Buffer.from(encodeSavedRunSpec(spec)).toString('utf8'))
  assert.equal(p.binding.runSpecHash, hashSavedRunSpec(spec)); assert.equal(p.binding.configHash, fingerprintRunSpec(spec))
  assert.equal(p.binding.runSpecHash, createHash('sha256').update(SAVED_RUN_SPEC_HASH_DOMAIN).update(p.originalSpecJson).digest('hex'))
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.spec.budget.total) && Object.isFrozen(p.binding) && Object.isFrozen(p.genesis))
  assert.notEqual(p.spec, spec); assert.equal(Object.is(p.spec.model.temperature, -0), true)
  assert.deepEqual(prepareLedgerCriticalSpec({ json: p.originalSpecJson }).spec, spec)
})
test('signed zero survives actual JSON outer serialization and keeps the full original hash', () => {
  const f = fixture(), original = f.records[0].payload, roundtrip = JSON.parse(JSON.stringify({ payload: original })).payload
  const decoded = decodeLedgerCriticalEnvelope(Buffer.from(JSON.stringify(roundtrip)))
  assert.equal(decoded.originalSpecJson, f.prepared.originalSpecJson)
  assert.equal(Object.is(prepareLedgerCriticalSpec({ json: decoded.originalSpecJson }).spec.model.temperature, -0), true)
  const positive = prepareLedgerCriticalSpec({ spec: createRunSpec({ ...baseInput(), model: { ...baseInput().model, temperature: 0 } }) })
  assert.notEqual(positive.binding.runSpecHash, f.prepared.binding.runSpecHash)
  assert.equal(positive.binding.configHash, f.prepared.binding.configHash)
  assert.deepEqual(decodeLedgerCriticalEnvelope(encodeLedgerCriticalEnvelope(original)), validateLedgerCriticalEnvelope(original))
})
test('fixed genesis and created logical hash vectors use independent canonical construction', () => {
  const f = fixture(), env = f.records[0].payload, p = env.provenance
  assert.equal(f.prepared.genesis.hash, hash(['repoprep.workflow.ledger-genesis.v1', f.prepared.binding]))
  assert.equal(env.logicalPosition.hash, hash(['repoprep.workflow.ledger-position.v1', p.binding, p.producingEpoch, p.sequence, p.previous, env.event]))
  // Literal vectors are also checked so key order/domain changes cannot bless themselves.
  assert.equal(f.prepared.genesis.hash, '06bf03f210e4715c1db877a6d7f077c19a1d30c64e68d38347d22a3a06eb265a')
  assert.equal(env.logicalPosition.hash, '88554f6e6a4cfe908886293ccb160416aeacfde58c89a56493637b3b0debf479')
})
test('full previous external reference, producer and event affect the next logical hash', () => {
  const f = fixture(), c = f.context('hash-op'); f.reserve(c)
  const env = f.make(f.model('reservation', c)), original = env.logicalPosition.hash
  for (const key of ['sha256', 'byteLength', 'producingEpoch'] as const) {
    const p = clone(env.provenance)
    const previous = p.previous! as { sha256: string; byteLength: number; producingEpoch: CriticalProducingEpoch }
    if (key === 'sha256') previous.sha256 = 'f'.repeat(64)
    else if (key === 'byteLength') previous.byteLength++
    else previous.producingEpoch = { ...epoch1, attemptId: '33333333-3333-4333-8333-333333333333' }
    assert.notEqual(ledgerCriticalPosition(f.prepared, p, env.event).hash, original)
  }
  const badId = clone(env.provenance) as unknown as { previous: { id: string } }; badId.previous.id = 'j-000000000002'
  assert.throws(() => ledgerCriticalPosition(f.prepared, badId, env.event), code())
  const uncommitted = f.model('reservation', c, null, 'uncommitted')
  assert.notEqual(ledgerCriticalPosition(f.prepared, env.provenance, uncommitted).hash, original)
})
test('model fence is owner, independently of attempt ordinal', () => {
  const f = fixture(); f.setEpoch({ ...epoch2, owner: 2, attempt: 3 }); f.recover({ ...epoch2, owner: 2, attempt: 3 })
  const c = f.context('owner-fence'); f.reserve(c); f.append(f.model('reservation', c))
  assert.equal(c.fence, 2)
  const wrong = { ...c, fence: 3 }
  assert.throws(() => f.make(f.model('intent', wrong), { id: c.id, state: 'dispatched', usage: null }), code())
})
for (const kind of ['prepared', 'cursor', 'step']) test('private tokens reject copied ' + kind, () => {
  const f = fixture(undefined, false), env = f.make({ kind: 'created', genesis: f.prepared.genesis })
  if (kind === 'prepared') assert.throws(() => createLedgerCriticalCursor({ ...f.prepared }), code('LEDGER_CRITICAL_TOKEN_INVALID'))
  else if (kind === 'cursor') assert.throws(() => checkLedgerCriticalTransition({ ...f.cursor }, env), code('LEDGER_CRITICAL_TOKEN_INVALID'))
  else { const step = checkLedgerCriticalTransition(f.cursor, env); assert.throws(() => acceptLedgerCriticalStep({ ...step }, f.reference(env)), code('LEDGER_CRITICAL_TOKEN_INVALID')) }
})
test('check is pure; accept consumes the step and linear cursor exactly once', () => {
  const f = fixture(undefined, false), cursor = f.cursor, env = f.make({ kind: 'created', genesis: f.prepared.genesis })
  const a = checkLedgerCriticalTransition(cursor, env), b = checkLedgerCriticalTransition(cursor, env)
  assert.equal(cursor.state, null)
  const next = acceptLedgerCriticalStep(a, f.reference(env)); assert.deepEqual(next.state, env.state)
  assert.throws(() => acceptLedgerCriticalStep(a, f.reference(env)), code('LEDGER_CRITICAL_TOKEN_INVALID'))
  assert.throws(() => acceptLedgerCriticalStep(b, f.reference(env)), code('LEDGER_CRITICAL_TOKEN_INVALID'))
})
for (const [name, mutate] of [
  ['foreign prototype', (v: any) => { Object.setPrototypeOf(v.state, new Date()) }],
  ['nonenumerable', (v: any) => { Object.defineProperty(v.state, 'blocked', { value: false, enumerable: false }) }],
  ['symbol', (v: any) => { v.state[Symbol('do-not-echo')] = 1 }],
  ['sparse array', (v: any) => { v.state.issuedIds = Array(1) }],
  ['array decoration', (v: any) => { v.state.models.extra = 'do-not-echo' }],
  ['extra field', (v: any) => { v.doNotEcho = 'do-not-echo' }],
  ['cycle', (v: any) => { v.state.self = v.state }],
  ['infinite integer', (v: any) => { v.state.time.elapsedHighWaterMs = Infinity }],
  ['bigint', (v: any) => { v.state.time.elapsedHighWaterMs = 1n }]
] as const) test('owned envelope refuses ' + name, () => { const f = fixture(), env = clone(f.records[0].payload); mutate(env); assert.throws(() => validateLedgerCriticalEnvelope(env), code()) })
test('ownership invokes no getter/proxy, and mutations cannot change accepted snapshots', () => {
  const f = fixture(); let hits = 0
  const env = clone(f.records[0].payload)
  Object.defineProperty(env.state, 'blocked', { enumerable: true, get() { hits++; return false } })
  assert.throws(() => validateLedgerCriticalEnvelope(env), code())
  const proxy = new Proxy({}, { getPrototypeOf() { hits++; throw Error('do-not-echo') }, ownKeys() { hits++; throw Error('do-not-echo') } })
  assert.throws(() => validateLedgerCriticalEnvelope(proxy), code())
  const bytes = new Proxy(new Uint8Array([123, 125]), { get() { hits++; throw Error('do-not-echo') } })
  assert.throws(() => decodeLedgerCriticalEnvelope(bytes), code())
  assert.equal(hits, 0)
  const original = clone(f.records[0].payload), checked = validateLedgerCriticalEnvelope(original)
  ;(original.state.time as any).startedUtcMs = 42
  assert.notEqual(checked.state.time.startedUtcMs, 42); assert.ok(Object.isFrozen(checked.state.time))
})
for (const source of ['{} {}', '\uFEFF{}', '{"x":1,"\\u0078":2}', '{"x":{"a":1,"a":2}}', '[1,]', '{"x":01}', '{"x":1e999}', '"\\uZZZZ"', 'false trailing']) test('strict byte decoder refuses JSON ' + source.slice(0, 28), () => {
  assert.throws(() => decodeLedgerCriticalEnvelope(Buffer.from(source)), code())
})
test('strict byte decoder rejects malformed UTF8 and empty bytes', () => {
  for (const bytes of [Buffer.from([0xc0, 0xaf]), new Uint8Array(), Buffer.from([0xff])]) assert.throws(() => decodeLedgerCriticalEnvelope(bytes), code())
})
test('explicit byte, depth and node bounds reject before delegates', () => {
  assert.throws(() => decodeLedgerCriticalEnvelope(new Uint8Array(LEDGER_CRITICAL_MAX_BYTES + 1)), code('LEDGER_CRITICAL_TOO_LARGE'))
  const deep: any = {}, f = fixture(); let current = deep
  for (let i = 0; i <= LEDGER_CRITICAL_MAX_DEPTH; i++) current = current.child = {}
  assert.throws(() => validateLedgerCriticalEnvelope(deep), code('LEDGER_CRITICAL_TOO_LARGE'))
  const many = [Array(100_000).fill(null), Array(100_000).fill(null), Array(LEDGER_CRITICAL_MAX_NODES - 200_000).fill(null)]
  assert.throws(() => validateLedgerCriticalEnvelope(many), code('LEDGER_CRITICAL_TOO_LARGE'))
  const large = clone(f.records[0].payload) as any; large.originalSpecJson = 'x'.repeat(16 * 1024 + 1)
  assert.throws(() => validateLedgerCriticalEnvelope(large), code('LEDGER_CRITICAL_TOO_LARGE'))
})
test('prepared canonical text rejects whitespace, altered derived budget and duplicate original keys', () => {
  const p = fixture().prepared
  for (const json of [' ' + p.originalSpecJson, p.originalSpecJson.replace('"version":1', '"version":1,"version":1')]) assert.throws(() => prepareLedgerCriticalSpec({ json }), code())
  const value = clone(p.spec) as any; value.budget.investigation.maxModelRequests++
  assert.throws(() => prepareLedgerCriticalSpec({ spec: value }), code())
})
for (const field of ['logicalRunId', 'projectId', 'snapshotId', 'runSpecHash', 'configHash', 'schemaVersion', 'policyVersion']) test('binding refuses changed ' + field, () => {
  const env = clone(fixture().records[0].payload) as any; env.provenance.binding[field] = field.includes('Hash') ? 'f'.repeat(64) : 'other-v1'
  assert.throws(() => validateLedgerCriticalEnvelope(env), code())
})
test('payload validator spans carried specs and bounded-cache eviction without ambient state', () => {
  const validator = createLedgerCriticalPayloadValidator(); assert.equal(validator.schemaId, 'workflow-ledger-critical-v1')
  const first = fixture().records[0].payload
  for (let i = 0; i < 20; i++) assert.equal(validator.validate(fixture({ ...baseInput(), runId: 'carried-' + i }).records[0].payload), true)
  assert.equal(validator.validate(first), true); assert.equal(validator.validate({}), false)
  let hits = 0
  const hostile = { get originalSpecJson() { hits++; return 'do-not-echo' } }
  assert.equal(validator.validate(hostile), false); assert.equal(hits, 0)
})

test('actual L projected reservation/intent/receipt supports known usage with missing output', () => {
  const f = fixture(), c = f.context('normal'); f.start(c)
  const env = f.append(f.model('receipt', c, usage()), { id: c.id, state: 'settled', usage: usage() })
  assert.equal(f.ledger.snapshot().total.inputTokens, 10) // live afterFlush has not run
  f.ledger.settleModel(c.id, usage())
  assert.equal(f.cursor.state!.models[0].usage!.inputTokens, 8); assert.equal(env.event.kind === 'model' && env.event.model.outputStatus, 'missing')
  assert.deepEqual(foldLedgerCriticalPrefix(f.records).state, f.cursor.state)
})
test('observation of concurrent B reservation never substitutes for its own accepted reservation', () => {
  const f = fixture(), a = f.context('A'), b = f.context('B'); f.reserve(a); f.reserve(b)
  f.append(f.model('reservation', a))
  assert.equal(f.cursor.state!.models.length, 2)
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make(f.model('intent', b), { id: b.id, state: 'dispatched', usage: null })), code('LEDGER_CRITICAL_TRANSITION_INVALID'))
  f.append(f.model('reservation', b)); f.append(f.model('intent', b), { id: b.id, state: 'dispatched', usage: null }); f.ledger.markDispatched(b.id)
  assert.equal(f.cursor.state!.models.find(row => row.id === b.id)!.state, 'dispatched')
})
test('actual L early unknown is conservative observation, then its own unknown event can finalize', () => {
  const f = fixture(), a = f.context('A'), b = f.context('B'); f.start(a); f.reserve(b)
  f.append(f.model('reservation', b))
  retainUnknownModel(f.ledger, b.id, false)
  f.append(f.model('receipt', a, usage()), { id: a.id, state: 'settled', usage: usage() }); f.ledger.settleModel(a.id, usage())
  assert.equal(f.cursor.state!.models.find(row => row.id === b.id)!.state, 'unknown-unsent')
  f.append(f.model('unknown', b))
  assert.equal(f.cursor.state!.blocked, true)
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make(f.model('intent', b), { id: b.id, state: 'dispatched', usage: null })), code())
})
test('projected settlement for A preserves concurrent C and every issued id', () => {
  const f = fixture(), a = f.context('A'), c = f.context('C'); f.start(a); f.reserve(c); f.append(f.model('reservation', c))
  const env = f.make(f.model('receipt', a, usage()), { id: a.id, state: 'settled', usage: usage() })
  const before = env.state.models.find(row => row.id === c.id)
  const dropped = clone(env) as any; dropped.state.models = dropped.state.models.filter((row: any) => row.id !== c.id)
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, dropped), code())
  const changed = clone(env) as any; changed.state.models.find((row: any) => row.id === c.id).requestHash = 'e'.repeat(64)
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, changed), code())
  const ids = clone(env) as any; ids.state.issuedIds = ids.state.issuedIds.filter((id: string) => id !== c.id)
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, ids), code())
  f.accept(env); assert.deepEqual(f.cursor.state!.models.find(row => row.id === c.id), before)
})
test('overspend projection allows a B reservation admitted during receipt fsync before live block', () => {
  const f = fixture({ ...baseInput(), budget: { maxModelRequests: 2, inputTokens: 128_000, outputTokens: 8192 } }), a = f.context('A', 'review', 64_000, 4096), b = f.context('B', 'review', 64_000, 4096)
  f.start(a)
  const env = f.make(f.model('receipt', a, usage(192_000, 4096)), { id: a.id, state: 'settled', usage: usage(192_000, 4096) })
  const step = checkLedgerCriticalTransition(f.cursor, env)
  f.reserve(b) // real synchronous L admission while A's projected receipt waits for ack
  const next = acceptLedgerCriticalStep(step, f.reference(env)); f.ledger.settleModel(a.id, usage(192_000, 4096))
  const p = { ...env.provenance, sequence: env.provenance.sequence + 1, previous: next.reference }
  const event = f.model('reservation', b), position = ledgerCriticalPosition(f.prepared, p, event)
  const bEnv: LedgerCriticalEnvelopeV1 = { ...env, provenance: p, event, logicalPosition: position, state: exportBudgetLedgerState(f.ledger, createLedgerBinding(f.spec, position)) }
  const accepted = acceptLedgerCriticalStep(checkLedgerCriticalTransition(next, bEnv), f.reference(bEnv))
  assert.equal(accepted.state!.diagnostics.overspendInputTokens, 128_000); assert.equal(accepted.state!.blocked, true)
  assert.equal(accepted.state!.models.reduce((sum, row) => sum + (row.usage?.inputTokens ?? row.inputTokens), 0), 256_000)
})
for (const mode of ['unknown-sent', 'unknown-unsent']) test('unknown never refunds the full cap: ' + mode, () => {
  const f = fixture(), c = f.context(mode)
  if (mode === 'unknown-sent') f.start(c); else { f.reserve(c); f.append(f.model('reservation', c)) }
  retainUnknownModel(f.ledger, c.id, mode === 'unknown-sent'); f.append(f.model('unknown', c))
  const row = f.cursor.state!.models[0]; assert.equal(row.usage, null); assert.equal(row.inputTokens, 10); assert.equal(f.cursor.state!.blocked, true)
})
test('receipt requires intent and cannot settle an unknown row or run twice', () => {
  const f = fixture(), c = f.context('R'); f.reserve(c); f.append(f.model('reservation', c))
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make(f.model('receipt', c, usage()), { id: c.id, state: 'settled', usage: usage() })), code())
  f.append(f.model('intent', c), { id: c.id, state: 'dispatched', usage: null }); f.ledger.markDispatched(c.id)
  f.append(f.model('receipt', c, usage()), { id: c.id, state: 'settled', usage: usage() }); f.ledger.settleModel(c.id, usage())
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make(f.model('receipt', c, usage()), { id: c.id, state: 'settled', usage: usage() })), code())
})
test('same semantic operation cannot acquire a fresh UUID after a known receipt', () => {
  const f = fixture(), c = f.context('once'); f.start(c); f.append(f.model('receipt', c, usage()), { id: c.id, state: 'settled', usage: usage() }); f.ledger.settleModel(c.id, usage())
  assert.throws(() => f.reserve({ ...c, id: 'new-uuid' }))
})
for (const actualBytes of [40, 100, 130]) test('actual read/tool own events and read receipt ' + actualBytes, () => {
  const f = fixture(), c = f.context('observe'); f.reserve(c); f.ledger.chargeTool('tool', 'investigation'); f.ledger.reserveRead('read', 100)
  f.append(f.model('reservation', c)) // conservative tool/read observations
  f.append({ kind: 'tool-charge', id: 'tool', stage: 'investigation' }); f.append({ kind: 'read-reservation', id: 'read', reservedBytes: 100 })
  f.ledger.settleRead('read', actualBytes); f.append({ kind: 'read-receipt', id: 'read', actualBytes })
  assert.equal(f.cursor.state!.reads[0].actualBytes, actualBytes); assert.equal(f.cursor.state!.diagnostics.overspendReadBytes, Math.max(0, actualBytes - 100))
})
test('read observation needs own reservation; exposed hold cannot be released', () => {
  const f = fixture(), c = f.context('observe'); f.reserve(c); f.ledger.reserveRead('read', 100); f.append(f.model('reservation', c))
  f.ledger.settleRead('read', 20)
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make({ kind: 'read-receipt', id: 'read', actualBytes: 20 })), code())
  const g = fixture(); g.ledger.reserveRead('read', 100); g.append({ kind: 'read-reservation', id: 'read', reservedBytes: 100 }); g.ledger.releaseRead('read')
  assert.throws(() => checkLedgerCriticalTransition(g.cursor, g.make({ kind: 'tool-charge', id: 'missing', stage: 'review' })), code())
})
test('unexposed read reserve/release leaves an orphan ID that cannot be reused', () => {
  const f = fixture(); f.ledger.reserveRead('orphan', 100); f.ledger.releaseRead('orphan'); f.ledger.chargeTool('tool', 'review'); f.append({ kind: 'tool-charge', id: 'tool', stage: 'review' })
  assert.ok(f.cursor.state!.issuedIds.includes('orphan')); assert.equal(f.cursor.state!.reads.length, 0)
  const env = clone(f.make({ kind: 'tool-charge', id: 'orphan', stage: 'review' })) as any; env.state.tools.push({ id: 'orphan', stage: 'review' })
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, env), code())
})
for (const field of ['overspendAdmissions', 'doubleSettlements', 'unknownUsageTreatedAsZero', 'overspendInputTokens']) test('unexplained diagnostics change rejected: ' + field, () => {
  const f = fixture(); f.ledger.chargeTool('tool', 'review'); const env = clone(f.make({ kind: 'tool-charge', id: 'tool', stage: 'review' })) as any; env.state.diagnostics[field]++
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, env), code())
})
test('snapshot sampled after original deadline remains conservative, never resets deadline', () => {
  const f = fixture(), c = f.context('late'); f.reserve(c); f.tick(f.spec.budget.total.wallClockMs + 1); f.append(f.model('reservation', c))
  assert.equal(f.cursor.state!.time.expiresUtcMs, 1_000_000 + f.spec.budget.total.wallClockMs)
  assert.throws(() => f.ledger.markDispatched(c.id))
})
test('time rollback and changed original start/deadline fail closed', () => {
  const f = fixture(); f.tick(20); f.ledger.chargeTool('one', 'review'); f.append({ kind: 'tool-charge', id: 'one', stage: 'review' })
  f.ledger.chargeTool('two', 'review'); const env = clone(f.make({ kind: 'tool-charge', id: 'two', stage: 'review' })) as any
  env.state.time.utcHighWaterMs--; assert.throws(() => checkLedgerCriticalTransition(f.cursor, env), code())
  const shifted = clone(f.make({ kind: 'tool-charge', id: 'two', stage: 'review' })) as any; shifted.state.time.startedUtcMs++; shifted.state.time.expiresUtcMs++
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, shifted), code())
  f.rollback(100); assert.throws(() => f.make({ kind: 'tool-charge', id: 'two', stage: 'review' }))
})
test('default L recovery follows complete prefix, preserving actual receipt and original deadline', () => {
  const f = fixture(), a = f.context('settled'), b = f.context('intent'), c = f.context('reserved')
  f.start(a); f.append(f.model('receipt', a, usage()), { id: a.id, state: 'settled', usage: usage() }); f.ledger.settleModel(a.id, usage())
  f.start(b); f.reserve(c); f.append(f.model('reservation', c)); f.ledger.reserveRead('read', 100); f.append({ kind: 'read-reservation', id: 'read', reservedBytes: 100 })
  const oldDeadline = f.cursor.state!.time.expiresUtcMs, oldPosition = f.cursor.logicalPosition
  f.tick(100); f.recover()
  assert.equal(f.cursor.state!.models.find(row => row.id === a.id)!.usage!.inputTokens, 8)
  assert.equal(f.cursor.state!.models.find(row => row.id === b.id)!.state, 'unknown')
  assert.equal(f.cursor.state!.models.find(row => row.id === c.id)!.state, 'unknown-unsent')
  assert.equal(f.cursor.state!.reads[0].reservedBytes, 100); assert.equal(f.cursor.state!.time.expiresUtcMs, oldDeadline)
  assert.ok(f.cursor.state!.time.elapsedHighWaterMs >= 100); assert.notDeepEqual(f.cursor.logicalPosition, oldPosition)
  assert.deepEqual(foldLedgerCriticalPrefix(f.records).state, f.cursor.state)
  assert.throws(() => f.ledger.releaseRead('read'))
})
test('recovery is required for changed epoch and cannot refund/introduce rows', () => {
  const f = fixture(), c = f.context('reserved'); f.reserve(c); f.append(f.model('reservation', c)); const old = f.cursor.logicalPosition
  f.setEpoch(epoch2); f.ledger.chargeTool('new', 'review')
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make({ kind: 'tool-charge', id: 'new', stage: 'review' })), code())
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make({ kind: 'recovery', from: old })), code())
})
for (const outcome of ['completed', 'cancelled', 'failed'] as const) test('sealed ' + outcome + ' refuses late business and remains frozen on later recovery', () => {
  const f = fixture(), c = f.context('reserved'); f.reserve(c); f.append(f.model('reservation', c)); f.tick(20); sealBudgetLedger(f.ledger)
  f.append({ kind: 'seal', outcome }); const time = f.cursor.state!.time
  assert.equal(f.cursor.terminalOutcome, outcome)
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make({ kind: 'seal', outcome: outcome === 'failed' ? 'cancelled' : 'failed' })), code())
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, f.make(f.model('receipt', c, usage()), { id: c.id, state: 'settled', usage: usage() })), code())
  f.tick(500); f.recover(); assert.equal(f.cursor.terminalOutcome, outcome); assert.deepEqual(f.cursor.state!.time, time)
  assert.equal(f.cursor.state!.models[0].state, 'reserved')
})
test('sequence, previous reference and producing epoch mismatches are rejected', () => {
  const f = fixture(); f.ledger.chargeTool('tool', 'review'); const env = f.make({ kind: 'tool-charge', id: 'tool', stage: 'review' })
  const previous = clone(env) as any; previous.provenance.previous.sha256 = 'f'.repeat(64)
  previous.logicalPosition = ledgerCriticalPosition(f.prepared, previous.provenance, previous.event); previous.state.binding.journal = previous.logicalPosition
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, previous), code())
  const skipped = clone(env) as any; skipped.provenance.sequence++
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, skipped), code())
  const step = checkLedgerCriticalTransition(f.cursor, env), ref = f.reference(env)
  assert.throws(() => acceptLedgerCriticalStep(step, { ...ref, producingEpoch: epoch2 }), code())
  assert.throws(() => acceptLedgerCriticalStep(step, { ...ref, byteLength: LEDGER_CRITICAL_MAX_BYTES + 1 }), code())
  acceptLedgerCriticalStep(step, ref)
})
test('valid forged references and truncated suffix remain data-only limits, never authenticity', () => {
  const f = fixture(); f.ledger.chargeTool('tool', 'review'); f.append({ kind: 'tool-charge', id: 'tool', stage: 'review' })
  assert.equal(foldLedgerCriticalPrefix(f.records.slice(0, 1)).logicalPosition.sequence, 1)
  assert.equal(foldLedgerCriticalPrefix(f.records).logicalPosition.sequence, 2)
  const first = f.records[0]
  const forged = foldLedgerCriticalPrefix([{ payload: first.payload, reference: { ...first.reference, byteLength: 1, sha256: 'f'.repeat(64) } }])
  assert.equal(forged.reference!.sha256, 'f'.repeat(64))
  assert.throws(() => foldLedgerCriticalPrefix([]), code())
})
test('actual W attempt and journal numeric boundaries are distinct data checks', () => {
  const f = fixture(undefined, false), epoch = { owner: 512, attempt: 4096, attemptId: epoch1.attemptId }; f.setEpoch(epoch)
  const first = f.make({ kind: 'created', genesis: f.prepared.genesis }); assert.equal(validateLedgerCriticalEnvelope(first).provenance.producingEpoch.attempt, 4096)
  for (const bad of [{ ...epoch, owner: 513 }, { ...epoch, attempt: 4097 }]) {
    f.setEpoch(bad); assert.throws(() => f.make({ kind: 'created', genesis: f.prepared.genesis }), code())
  }
  const p = { binding: f.prepared.binding, producingEpoch: epoch, sequence: 8192, previous: { id: 'j-000000008191', producingEpoch: epoch, byteLength: 1, sha256: 'e'.repeat(64) } }
  assert.equal(ledgerCriticalPosition(f.prepared, p, { kind: 'seal', outcome: 'failed' }).sequence, 8192)
  assert.throws(() => ledgerCriticalPosition(f.prepared, { ...p, sequence: 8193 }, { kind: 'seal', outcome: 'failed' }), code())
})

test('terminal metadata recovery rejects conservative rewriting of already frozen model states', () => {
  const f = fixture(), c = f.context('frozen'); f.reserve(c); f.append(f.model('reservation', c)); sealBudgetLedger(f.ledger); f.append({ kind: 'seal', outcome: 'cancelled' })
  const prior = f.cursor.state!, from = f.cursor.logicalPosition
  f.setEpoch(epoch2)
  const env = clone(f.make({ kind: 'recovery', from })) as any; env.state.models[0].state = 'unknown-unsent'
  assert.throws(() => checkLedgerCriticalTransition(f.cursor, env), code('LEDGER_CRITICAL_TRANSITION_INVALID'))
  f.append({ kind: 'recovery', from }); assert.deepEqual(f.cursor.state!.models, prior.models)
})
test('byte storage decorations are ignored by captured intrinsics without evaluation', () => {
  const bytes = encodeLedgerCriticalEnvelope(fixture().records[0].payload)
  let calls = 0
  for (const key of ['length', 'byteLength', 'constructor', 'valueOf', 'buffer', Symbol.iterator]) Object.defineProperty(bytes, key, { get() { calls++; throw Error('do-not-echo') } })
  assert.equal(decodeLedgerCriticalEnvelope(bytes).event.kind, 'created'); assert.equal(calls, 0)
})
test('one MiB input decodes in 64MiB heap without enumerating integer byte keys', () => {
  const f = fixture()
  const script = [
    'import {decodeLedgerCriticalEnvelope} from ' + JSON.stringify(new URL('./ledger-critical-envelope.ts', import.meta.url).href) + ';',
    'const source=' + JSON.stringify(JSON.stringify(f.records[0].payload)) + ';',
    'const input=new Uint8Array(1024*1024);input.fill(32);input.set(Buffer.from(source));let calls=0;',
    'for(const key of ["length","byteLength","constructor","valueOf","buffer",Symbol.iterator])Object.defineProperty(input,key,{get(){calls++;throw Error("decoration");}});',
    'const ownKeys=Reflect.ownKeys;Reflect.ownKeys=value=>{if(value===input)throw Error("enumerated bytes");return ownKeys(value);};',
    'const decoded=decodeLedgerCriticalEnvelope(input);console.log(JSON.stringify({ok:decoded.event.kind==="created",inputBytes:1024*1024,decorationsExecuted:calls}));'
  ].join('\n')
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--experimental-strip-types', '--import', new URL('../../../tests/register-shared-alias.mjs', import.meta.url).href, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384, windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout.trim()), { ok: true, inputBytes: 1024 * 1024, decorationsExecuted: 0 })
})

test('external reference data rejects nested accessor/object epochs without evaluating them', () => {
  const f = fixture(undefined, false), env = f.make({ kind: 'created', genesis: f.prepared.genesis }), step = checkLedgerCriticalTransition(f.cursor, env)
  let calls = 0
  const hostile = { get secret() { calls++; throw Error('do-not-echo') } }
  const ref = f.reference(env)
  assert.throws(() => acceptLedgerCriticalStep(step, { ...ref, producingEpoch: { ...epoch1, attemptId: hostile } } as unknown as CriticalRecordReference), code())
  assert.equal(calls, 0)
  assert.equal(acceptLedgerCriticalStep(step, ref).logicalPosition.sequence, 1)
})
