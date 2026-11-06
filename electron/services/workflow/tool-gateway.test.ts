// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { test } from 'node:test'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import os from 'node:os'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { scanProject } from '../scanner.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createWorkflowSnapshot } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createEvidenceStore } from './evidence-store.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createToolGateway } from './tool-gateway.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createRunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createBudgetLedger } from './budget-ledger.ts'

const text = 'export function greet(name: string) {\n  return `hello ${name}`\n}\n'
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm04-gateway-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'sample.ts'), text)
  const snapshot = await createWorkflowSnapshot(await scanProject(root), { projectId: 'gateway-test' })
  const store = createEvidenceStore(snapshot)
  const counts = { calls: 0, reserved: 0, settled: 0 }
  const ledger = {
    chargeTool() { counts.calls++ }, assertCanContinue() {},
    reserveRead(_id: string, bytes: number) { counts.reserved += bytes },
    settleRead(_id: string, bytes: number) { counts.settled += bytes }, releaseRead() {}
  }
  return { root, snapshot, store, counts, gateway: createToolGateway(snapshot, store, ledger) }
}

test('all read tools return bounded redacted evidence-backed results and cache exact reads', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const fileId = f.snapshot.files[0].fileId
  const cases = [
    { actionId: 'overview', tool: 'get_overview', args: {} },
    { actionId: 'symbols', tool: 'list_symbols', args: { fileId } },
    { actionId: 'search', tool: 'search_text', args: { query: 'hello' } },
    { actionId: 'region', tool: 'read_region', args: { fileId, startLine: 1, endLine: 3 } },
    { actionId: 'context', tool: 'read_declaration_context', args: { fileId, line: 2, maxLines: 3 } }
  ] as const
  for (const action of cases) {
    const result = await f.gateway.execute(action)
    assert.equal(result.status, 'ok', action.tool)
    assert.ok(JSON.stringify(result).length <= 64 * 1024)
    if (action.tool !== 'get_overview') assert.ok(result.evidenceIds.length > 0)
  }
  assert.ok(f.counts.reserved > 0)
  assert.equal(f.counts.settled, Buffer.byteLength(text))
})

test('rejects accessors, extra fields and forged file ids without reading', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  assert.equal((await f.gateway.execute({ actionId: 'bad', tool: 'read_region', args: { fileId: '../outside', startLine: 1, endLine: 1 } })).status, 'rejected')
  assert.equal((await f.gateway.execute({ actionId: 'extra', tool: 'get_overview', args: { rawPath: 'C:/secret' } })).status, 'rejected')
  const accessor = Object.defineProperty({}, 'actionId', { get() { throw Error('no') } })
  assert.equal((await f.gateway.execute(accessor)).status, 'rejected')
  assert.equal(f.counts.reserved, 0)
})

test('exact duplicate action returns frozen result without additional budget or evidence', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const action = { actionId: 'same', tool: 'read_region', args: { fileId: f.snapshot.files[0].fileId, startLine: 1, endLine: 2 } }
  const first = await f.gateway.execute(action); const second = await f.gateway.execute(action)
  assert.equal(second.status, first.status)
  assert.deepEqual(second.evidenceIds, first.evidenceIds)
  assert.deepEqual(second.data, first.data)
  assert.deepEqual(second.consumption, { readBytes: 0, toolCalls: 0, cacheHit: true })
  assert.ok(Object.isFrozen(second) && Object.isFrozen(second.data))
  assert.equal(f.counts.calls, 1)
})

test('stale exact duplicates resolve to a static result instead of rejecting', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const action = { actionId: 'same-stale', tool: 'read_region', args: { fileId: f.snapshot.files[0].fileId, startLine: 1, endLine: 2 } }
  assert.equal((await f.gateway.execute(action)).status, 'ok')
  await writeFile(path.join(f.root, 'src', 'sample.ts'), `${text}changed\n`)
  const stale = await f.gateway.execute(action)
  assert.equal(stale.status, 'rejected')
  assert.equal(stale.evidenceIds.length, 0)
})

test('gateway and request abort signals are both honored during a read', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm04-global-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'sample.ts'), text)
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const began = new Promise<void>(resolve => { started = resolve })
  const snapshot = await createWorkflowSnapshot(await scanProject(root), { projectId: 'global-abort-test', reader: async () => {
    started?.()
    await new Promise<void>(resolve => { release = resolve })
    return text
  } })
  const store = createEvidenceStore(snapshot)
  const globalController = new AbortController()
  const requestController = new AbortController()
  const ledger = { chargeTool() {}, assertCanContinue() {}, reserveRead() {}, settleRead() {}, releaseRead() {} }
  const gateway = createToolGateway(snapshot, store, ledger, { signal: globalController.signal })
  const pending = gateway.execute({ actionId: 'global-abort', tool: 'read_region', args: { fileId: snapshot.files[0].fileId, startLine: 1, endLine: 1 } }, requestController.signal)
  await began
  globalController.abort()
  release?.()
  const result = await pending
  assert.equal(requestController.signal.aborted, false)
  assert.equal(result.status, 'cancelled')
  assert.equal(store.metadata().records, 0)
})

test('oversized declarations fall back around the requested line with an omission marker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm04-large-declaration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src'), { recursive: true })
  const longText = `export function longDeclaration() {\n${Array.from({ length: 12 }, (_, index) => `  const line${index} = ${index}`).join('\n')}\n  return line11\n}\n`
  await writeFile(path.join(root, 'src', 'long.ts'), longText)
  const snapshot = await createWorkflowSnapshot(await scanProject(root), { projectId: 'long-declaration-test' })
  const store = createEvidenceStore(snapshot)
  const ledger = { chargeTool() {}, assertCanContinue() {}, reserveRead() {}, settleRead() {}, releaseRead() {} }
  const gateway = createToolGateway(snapshot, store, ledger)
  const result = await gateway.execute({ actionId: 'long-context', tool: 'read_declaration_context', args: { fileId: snapshot.files[0].fileId, line: 10, maxLines: 3 } })
  assert.equal(result.status, 'ok')
  const data = result.data as { declarationOmitted: boolean; declarationIncluded: boolean; startLine: number; endLine: number; contextMode: string }
  assert.equal(data.declarationOmitted, true)
  assert.equal(data.declarationIncluded, false)
  assert.ok(data.startLine <= 10 && data.endLine >= 10)
  assert.ok(data.endLine - data.startLine + 1 <= 3)
  assert.equal(data.contextMode, 'plaintext-fallback')
})

test('real M05 ledger accounts gateway cache hits and enforces the eight tool-call cap', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const spec = createRunSpec({
    version: 1, runId: 'm04-ledger-run', projectId: f.snapshot.projectId, snapshotId: f.snapshot.snapshotId,
    strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine',
    model: { profileId: 'profile-01', endpointFingerprint: 'a'.repeat(64), model: 'synthetic-model', protocol: 'openai', reasoningEffort: 'high', contextWindowTokens: 49_152, maxOutputTokens: 4096 },
    promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1'
  })
  const ledger = createBudgetLedger(spec)
  const gateway = createToolGateway(f.snapshot, f.store, ledger)
  const readAction = (actionId: string) => ({ actionId, tool: 'read_region', args: { fileId: f.snapshot.files[0].fileId, startLine: 1, endLine: 2 } })
  const first = await gateway.execute(readAction('ledger-read-a'))
  const second = await gateway.execute(readAction('ledger-read-b'))
  assert.equal(first.status, 'ok')
  assert.equal(second.status, 'ok')
  assert.deepEqual(second.consumption, { readBytes: 0, toolCalls: 1, cacheHit: true })
  for (let index = 0; index < 6; index++) {
    const overview = await gateway.execute({ actionId: `ledger-overview-${index}`, tool: 'get_overview', args: {} })
    assert.equal(overview.status, 'ok')
  }
  const blocked = await gateway.execute({ actionId: 'ledger-overview-over-cap', tool: 'get_overview', args: {} })
  assert.equal(blocked.status, 'budget-exhausted')
  const state = ledger.snapshot()
  assert.equal(state.total.toolCalls, 8)
  assert.equal(state.total.readBytes, Buffer.byteLength(text))
  assert.equal(state.remaining.investigationToolCalls, 0)
})
