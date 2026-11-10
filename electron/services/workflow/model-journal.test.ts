import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
// @ts-ignore TS5097 -- direct Node runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createBudgetLedger, restoreBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createLedgerBinding, decodeLedgerState, encodeLedgerState } from './ledger-state.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { createModelGateway } from './model-gateway.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- direct Node runner.
import { WorkflowError } from './project-contract.ts'
import type { DurableModelEvent, DurableModelJournal } from './model-journal.ts'
import type { LedgerStateV1, LedgerJournalPosition } from './ledger-state.ts'
import type { ModelTransport } from './model-gateway.ts'
const profile = { id: 'profile-01', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', model: 'synthetic', protocol: 'openai' as const, contextWindowTokens: 49152, maxOutputTokens: 4096 }
const spec = createRunSpec({ version: 1, runId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine', model: { profileId: profile.id, model: profile.model, endpointFingerprint: createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex'), protocol: 'openai', contextWindowTokens: 49152, maxOutputTokens: 4096 }, promptVersion: 'prompt-v1', toolVersion: 'tool-v1', policyVersion: 'policy-v1' })
const messages = [{ role: 'user' as const, content: 'synthetic private request text' }]
const operation = { semanticHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64) }
const usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
const ledgerOptions = { clock: () => 0, utcClock: () => 1_000_000, durable: true }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

/** Real flushed files exercise the seam. This fixture is not production writer authority or a transaction implementation. */
async function harness(run: (h: Awaited<ReturnType<typeof createHarness>>) => Promise<void>) {
  const h = await createHarness()
  try { await run(h) } finally {
    assert.equal(dirname(resolve(h.directory)), resolve(tmpdir()))
    assert.match(basename(h.directory), /^repoprep-ledger-journal-/)
    assert.equal((await lstat(h.directory)).isSymbolicLink(), false)
    await rm(h.directory, { recursive: true, force: true })
  }
}
async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'repoprep-ledger-journal-'))
  const events: string[] = []; let sequence = 0; let current = true
  let fail: DurableModelEvent['kind'] | null = null; let failAfterWrite = false
  let tail: Promise<unknown> = Promise.resolve()
  let waitFor: DurableModelEvent['kind'] | null = null; let pause = deferred(); let entered = deferred()
  const journal: DurableModelJournal = {
    binding: createLedgerBinding(spec, { sequence: 0, hash: '0'.repeat(64) }), attemptId: 'attempt-01', fence: 1,
    assertCurrent(context) { if (!current || context.runId !== spec.runId || context.projectId !== spec.projectId || context.snapshotId !== spec.snapshotId || context.attemptId !== 'attempt-01' || context.fence !== 1) throw new WorkflowError('configuration-changed') },
    appendAndFlush(event, build) {
      const task = tail.then(async () => {
      journal.assertCurrent(event.context)
      events.push(event.kind + ':start')
      if (fail === event.kind && !failAfterWrite) throw Error('SYNTHETIC_SECRET raw disk failure')
      const position = { sequence: ++sequence, hash: createHash('sha256').update(JSON.stringify([sequence, event])).digest('hex') }
      const state = build(position)
      const handle = await open(join(directory, sequence + '.json'), 'wx')
      try { await handle.writeFile(JSON.stringify({ event, ledger: encodeLedgerState(spec, state) }), 'utf8'); await handle.sync() } finally { await handle.close() }
      if (waitFor === event.kind) { entered.resolve(); await pause.promise }
      events.push(event.kind + ':flushed')
      if (fail === event.kind && failAfterWrite) throw Error('SYNTHETIC_SECRET crash after durable write')
      return position
      })
      tail = task.catch(() => {})
      return task
    }
  }
  const read = async () => {
    const files = (await readdir(directory)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
    return Promise.all(files.map(async file => { const r = JSON.parse(await readFile(join(directory, file), 'utf8')); return { event: r.event as DurableModelEvent, state: decodeLedgerState(spec, r.ledger) } }))
  }
  return { directory, events, journal, read, revoke() { current = false }, setFailure(kind: DurableModelEvent['kind'], after = false) { fail = kind; failAfterWrite = after }, pause(kind: DurableModelEvent['kind']) { waitFor = kind; pause = deferred(); entered = deferred(); return { entered: entered.promise, release: pause.resolve } } }
}
const complete = (gateway: ReturnType<typeof createModelGateway>, id = 'request-01', extra = {}) => gateway.complete({ id, stage: 'generation', messages, durableOperation: operation, ...extra })
const settledTransport = (events: string[]): ModelTransport => async (_p, _m, _d, opts) => { await opts.beforeRequest!(); events.push('HTTP'); opts.onUsage!(usage); return 'synthetic output' }
const safeError = (error: unknown) => error instanceof WorkflowError && !/SYNTHETIC_SECRET|disk failure|synthetic private/.test(JSON.stringify(error))

test('real journal flushes reservation and intent before HTTP, and receipt before settled return', async () => harness(async h => {
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const gate = h.pause('receipt')
  const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, trace() { throw Error('observational trace failure') }, transport: settledTransport(h.events) })
  let returned = false
  const result = complete(gateway).then(value => { returned = true; return value })
  await gate.entered
  assert.deepEqual(h.events, ['reservation:start', 'reservation:flushed', 'intent:start', 'intent:flushed', 'HTTP', 'receipt:start'])
  assert.equal(returned, false); assert.equal(ledger.snapshot().reservations[0].state, 'dispatched')
  gate.release()
  assert.equal((await result).content, 'synthetic output')
  assert.equal(ledger.snapshot().reservations[0].state, 'settled')
  const records = await h.read(); assert.equal(records.length, 3)
  assert.equal(records[1].state.models[0].state, 'dispatched')
  assert.deepEqual(records[2].state.models[0].usage, usage)
  assert.equal(records[2].event.outputStatus, 'uncommitted')
  const json = JSON.stringify(records)
  assert.doesNotMatch(json, /SYNTHETIC_SECRET|synthetic private request text|synthetic output|baseUrl|apiKey/)
}))

test('reservation and intent journal failures prevent HTTP and keep conservative costs', async () => {
  for (const kind of ['reservation', 'intent'] as const) await harness(async h => {
    h.setFailure(kind)
    const ledger = createBudgetLedger(spec, ledgerOptions)
    let http = 0
    const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async (_p, _m, _d, opts) => { await opts.beforeRequest!(); http++; return 'forbidden' } })
    await assert.rejects(complete(gateway), safeError)
    assert.equal(http, 0); assert.equal(ledger.snapshot().blocked, true)
    assert.equal(ledger.snapshot().reservations[0].state, kind === 'intent' ? 'unknown' : 'unknown-unsent')
    assert.ok(ledger.snapshot().total.outputTokens > 0)
    await assert.rejects(complete(gateway, 'new-uuid'), safeError)
  })
})

test('cancellation, fence revocation and expiry while intent awaits prevent HTTP after flush', async () => {
  for (const mode of ['cancel', 'fence', 'expiry', 'manifest'] as const) await harness(async h => {
    const controller = new AbortController(); let time = 0; let manifestCurrent = true
    const ledger = createBudgetLedger(spec, { ...ledgerOptions, clock: () => time })
    const gate = h.pause('intent'); let http = 0
    const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async (_p, _m, _d, opts) => { await opts.beforeRequest!(); http++; return 'forbidden' } })
    const request = complete(gateway, 'request-01', { signal: controller.signal, dispatchGuard() { if (!manifestCurrent) throw new WorkflowError('configuration-changed') } })
    const rejected = assert.rejects(request, safeError)
    await gate.entered
    if (mode === 'cancel') controller.abort()
    if (mode === 'fence') h.revoke()
    if (mode === 'expiry') time = 600_000
    if (mode === 'manifest') manifestCurrent = false
    gate.release(); await rejected
    assert.equal(http, 0); assert.equal(ledger.snapshot().blocked, true)
    assert.equal(ledger.snapshot().reservations[0].state, 'unknown')
    assert.equal((await h.read())[1].state.models[0].state, 'dispatched')
  })
})

test('hook reentrancy produces only one intent and no accepted content', async () => harness(async h => {
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async (_p, _m, _d, opts) => {
    const first = opts.beforeRequest!(); const second = opts.beforeRequest!()
    const outcomes = await Promise.allSettled([first, second])
    assert.equal(outcomes[1].status, 'rejected')
    return 'must not be accepted'
  } })
  await assert.rejects(complete(gateway), safeError)
  assert.equal(h.events.filter(event => event === 'intent:start').length, 1)
  assert.equal(ledger.snapshot().blocked, true)
}))

test('a crash after flushed intent restores unknown held work and rejects a fresh UUID', async () => harness(async h => {
  h.setFailure('intent', true)
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: settledTransport(h.events) })
  await assert.rejects(complete(gateway), safeError)
  const records = await h.read(); const state = records.at(-1)!.state
  const recovered = restoreBudgetLedger(spec, state, { ...ledgerOptions, authority: { binding: state.binding, assertCurrent() {} } })
  assert.equal(recovered.snapshot().reservations[0].state, 'unknown')
  assert.equal(recovered.snapshot().total.outputTokens, state.models[0].outputTokens)
  assert.throws(() => recovered.reserveModel({ id: 'changed-uuid', stage: 'generation', inputTokens: 1, outputTokens: 1, semanticOperationHash: state.models[0].semanticOperationHash! }))
  assert.equal(h.events.includes('HTTP'), false)
}))

test('failed receipt persistence never releases or advertises recoverably settled usage', async () => harness(async h => {
  h.setFailure('receipt')
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: settledTransport(h.events) })
  await assert.rejects(complete(gateway), safeError)
  assert.equal(ledger.snapshot().reservations[0].state, 'unknown'); assert.equal(ledger.snapshot().usageComplete, false)
  assert.equal(ledger.snapshot().total.outputTokens, 4096)
  assert.equal((await h.read()).at(-1)!.event.kind, 'intent')
}))

test('semantic operation registry rejects a changed UUID after a complete usage receipt without stored output', async () => harness(async h => {
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async (_p, _m, _d, opts) => { await opts.beforeRequest!(); opts.onUsage!(usage); throw Error('synthetic missing output') } })
  await assert.rejects(complete(gateway), safeError)
  const records = await h.read(); const state = records.at(-1)!.state
  assert.equal(records.at(-1)!.event.outputStatus, 'missing'); assert.equal(state.models[0].state, 'settled')
  assert.deepEqual(state.models[0].usage, usage)
  const recovered = restoreBudgetLedger(spec, state, { ...ledgerOptions, authority: { binding: state.binding, assertCurrent() {} } })
  let http = 0
  const resumeJournal = { ...h.journal, binding: state.binding }
  const resumed = createModelGateway(spec, profile, recovered, { durability: resumeJournal, transport: async () => { http++; return 'forbidden' } })
  await assert.rejects(complete(resumed, 'new-request-uuid'), safeError)
  assert.equal(http, 0); assert.equal((await h.read()).length, records.length)
}))

test('broken transports skipping or discarding the awaited hook cannot return unmetered content', async () => {
  for (const skip of [true, false]) await harness(async h => {
    const ledger = createBudgetLedger(spec, ledgerOptions)
    const gate = h.pause('intent')
    let hook: void | Promise<void> = undefined
    const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async (_p, _m, _d, opts) => { if (!skip) hook = opts.beforeRequest!(); opts.onUsage!(usage); return 'forbidden' } })
    const rejected = assert.rejects(complete(gateway), safeError)
    if (!skip) await gate.entered
    gate.release()
    await rejected
    await Promise.allSettled([hook])
    assert.equal(ledger.snapshot().blocked, true)
    assert.equal(ledger.snapshot().usageComplete, false)
  })
})

test('default llm transport enforces real journal ordering before a synthetic fetch', async () => harness(async h => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { const records = await h.read(); assert.equal(records.at(-1)!.event.kind, 'intent'); h.events.push('HTTP'); return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic output' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }) }
  try { const ledger = createBudgetLedger(spec, ledgerOptions); await complete(createModelGateway(spec, profile, ledger, { durability: h.journal })); assert.equal(ledger.snapshot().usageComplete, true) } finally { globalThis.fetch = original }
}))


test('receipt await cannot expose output after cancellation, fence revocation or original expiry', async () => {
  for (const mode of ['cancel', 'fence', 'expiry'] as const) await harness(async h => {
    const controller = new AbortController(); let time = 0
    const ledger = createBudgetLedger(spec, { ...ledgerOptions, clock: () => time })
    const gate = h.pause('receipt')
    const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: settledTransport(h.events) })
    const rejected = assert.rejects(complete(gateway, 'request-01', { signal: controller.signal }), safeError)
    await gate.entered
    if (mode === 'cancel') controller.abort()
    if (mode === 'fence') h.revoke()
    if (mode === 'expiry') time = 600_000
    gate.release(); await rejected
    assert.deepEqual(ledger.snapshot().reservations[0].usage, usage)
    assert.equal(ledger.snapshot().usageComplete, true)
  })
})

test('durable partial/missing receipt rejects output, holds the full reservation and persists unknown', async () => {
  for (const partial of [false, true]) await harness(async h => {
    const ledger = createBudgetLedger(spec, ledgerOptions)
    const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async (_p, _m, _d, opts) => { await opts.beforeRequest!(); if (partial) opts.onUsage!({ inputTokens: 2 } as never); return 'unreceipted output' } })
    await assert.rejects(complete(gateway), safeError)
    assert.equal(ledger.snapshot().reservations[0].state, 'unknown')
    assert.equal(ledger.snapshot().total.outputTokens, 4096)
    assert.equal((await h.read()).at(-1)!.event.kind, 'unknown')
  })
})

test('a durably written over-receipt preserves actual charges and blocks all further admissions', async () => harness(async h => {
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const over = { inputTokens: 10_000, outputTokens: 5_000, totalTokens: 15_000 }
  const gateway = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async (_p, _m, _d, opts) => { await opts.beforeRequest!(); opts.onUsage!(over); return 'synthetic output' } })
  await complete(gateway)
  assert.deepEqual(ledger.snapshot().reservations[0].usage, over)
  assert.equal(ledger.snapshot().blocked, true)
  const state = (await h.read()).at(-1)!.state
  assert.equal(state.blocked, true)
  assert.ok(state.diagnostics.overspendOutputTokens > 0)
  assert.throws(() => ledger.chargeTool('new-tool', 'review'))
}))

test('durable operation metadata cannot silently downgrade to a non-durable gateway', async () => harness(async h => {
  const ledger = createBudgetLedger(spec, ledgerOptions); let http = 0
  const gateway = createModelGateway(spec, profile, ledger, { transport: async () => { http++; return 'forbidden' } })
  await assert.rejects(complete(gateway), safeError)
  const durable = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: async () => { http++; return 'forbidden' } })
  await assert.rejects(durable.complete({ id: 'missing-operation', stage: 'generation', messages }), safeError)
  assert.equal(http, 0); assert.equal(ledger.snapshot().total.reservedRequests, 0)
}))

test('raw writer-authorization errors are mapped to finite static workflow failures', async () => harness(async h => {
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const journal = { ...h.journal, assertCurrent() { throw Error('SYNTHETIC_SECRET raw authorization error') } }
  const gateway = createModelGateway(spec, profile, ledger, { durability: journal, transport: settledTransport(h.events) })
  await assert.rejects(complete(gateway), safeError)
  assert.equal(h.events.includes('HTTP'), false)
}))


test('concurrent gateways on one original ledger cannot overwrite an earlier durable receipt projection', async () => harness(async h => {
  const ledger = createBudgetLedger(spec, ledgerOptions)
  const first = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: settledTransport(h.events) })
  const second = createModelGateway(spec, profile, ledger, { durability: h.journal, transport: settledTransport(h.events) })
  await Promise.all([complete(first, 'first'), complete(second, 'second', { durableOperation: { ...operation, semanticHash: 'e'.repeat(64) } })])
  const records = await h.read(); const last = records.at(-1)!.state
  assert.equal(last.models.length, 2)
  assert.equal(last.models.every(model => model.state === 'settled'), true)
  const recovered = restoreBudgetLedger(spec, last, { ...ledgerOptions, authority: { binding: last.binding, assertCurrent() {} } })
  assert.equal(recovered.snapshot().usageComplete, true)
  assert.equal(recovered.snapshot().total.inputTokens, 10)
}))
