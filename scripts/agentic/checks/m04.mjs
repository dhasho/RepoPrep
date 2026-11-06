import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scanProject } from '../../../electron/services/scanner.ts'
import { createWorkflowSnapshot } from '../../../electron/services/workflow/snapshot-adapter.ts'
import { createEvidenceStore } from '../../../electron/services/workflow/evidence-store.ts'
import { WorkflowError } from '../../../electron/services/workflow/project-contract.ts'
import { createToolGateway } from '../../../electron/services/workflow/tool-gateway.ts'

const tools = ['get_overview', 'list_symbols', 'search_text', 'read_region', 'read_declaration_context']
const source = `export function answer(value: string) {\n  const synthetic = 'sk-proj-abcdefghijklmnop'\n  return value + synthetic\n}\nconst marker = 'literal [x] 100%'\n`
async function fixture({ blockRead = false, budgetMode = '' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repoprep-m04-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'sample.ts'), source)
  let resolveRead
  let readStarted = false
  const scan = await scanProject(root)
  const snapshot = await createWorkflowSnapshot(scan, {
    projectId: 'm04-synthetic',
    reader: async (...args) => {
      readStarted = true
      if (blockRead) await new Promise(resolve => { resolveRead = resolve })
      const { readProjectContent } = await import('../../../electron/services/project-content-reader.ts')
      return readProjectContent(...args)
    }
  })
  const store = createEvidenceStore(snapshot)
  const counts = { toolCalls: 0, reserved: 0, settled: 0, released: 0, actualBytes: 0 }
  const ledger = {
    assertCanContinue() { if (budgetMode === 'assert') throw new WorkflowError('budget-exhausted') },
    chargeTool() { if (budgetMode === 'charge') throw new WorkflowError('budget-exhausted'); counts.toolCalls++ },
    reserveRead(_id, bytes) { if (budgetMode === 'read') throw new WorkflowError('budget-exhausted'); counts.reserved += bytes },
    settleRead(_id, bytes) { counts.settled++; counts.actualBytes += bytes },
    releaseRead() { counts.released++ }
  }
  const gateway = createToolGateway(snapshot, store, ledger)
  return { root, snapshot, store, gateway, counts, stopRead: () => resolveRead?.(), readStarted: () => readStarted }
}
const actions = {
  get_overview: () => ({ actionId: 'case-action', tool: 'get_overview', args: { offset: 0, limit: 10 } }),
  list_symbols: f => ({ actionId: 'case-action', tool: 'list_symbols', args: { fileId: f.snapshot.files[0].fileId } }),
  search_text: f => ({ actionId: 'case-action', tool: 'search_text', args: { query: 'literal [x] 100%', fileIds: [f.snapshot.files[0].fileId] } }),
  read_region: f => ({ actionId: 'case-action', tool: 'read_region', args: { fileId: f.snapshot.files[0].fileId, startLine: 1, endLine: 3 } }),
  read_declaration_context: f => ({ actionId: 'case-action', tool: 'read_declaration_context', args: { fileId: f.snapshot.files[0].fileId, line: 2, maxLines: 10 } })
}
const cloneAction = action => ({ ...action, args: { ...action.args } })

export function createChecks() {
  const checks = new Map()
  let unsafeErrorLeaks = 0
  let unexpectedSideEffects = 0
  for (const tool of tools) {
    checks.set(`m04:${tool}:valid`, async ctx => {
      const f = await fixture()
      try {
        const result = await f.gateway.execute(actions[tool](f))
        assert.equal(result.status, 'ok')
        assert.equal(result.tool, tool)
        assert.ok(JSON.stringify(result).length <= 64 * 1024)
        assert.ok(f.counts.toolCalls === 1)
        if (tool !== 'get_overview') assert.ok(result.evidenceIds.length > 0)
        if (tool === 'search_text') assert.equal(result.data.matches.length, 1, 'search treats metacharacters literally')
        if (tool === 'list_symbols') assert.equal(result.data.indexStatus, 'available')
        if (tool === 'read_declaration_context') assert.equal(result.data.contextMode, 'declaration')
        const leaked = JSON.stringify(result).includes('sk-proj-abcdefghijklmnop') || JSON.stringify(result).includes(f.root)
        unsafeErrorLeaks += Number(leaked)
        assert.equal(leaked, false)
        return { valid: true, evidenceCount: result.evidenceIds.length }
      } finally { await rm(f.root, { recursive: true, force: true }) }
    })
    checks.set(`m04:${tool}:invalid`, async ctx => {
      const f = await fixture()
      try {
        const action = actions[tool](f)
        action.args.extra = 'forbidden'
        const result = await f.gateway.execute(action)
        assert.equal(result.status, 'rejected')
        assert.equal(f.counts.toolCalls, 0)
        const getter = { actionId: 'getter', tool, get args() { throw new Error('synthetic getter') } }
        assert.equal((await f.gateway.execute(getter)).status, 'rejected')
        const hostileIds = ['forged']
        Object.defineProperty(hostileIds, '0', { get() { throw new Error('synthetic nested getter') } })
        assert.equal((await f.gateway.execute({ actionId: 'nested-getter', tool: 'search_text', args: { query: 'x', fileIds: hostileIds } })).status, 'rejected')
        const hostile = Object.assign(Object.create({ polluted: true }), actions[tool](f))
        assert.equal((await f.gateway.execute(hostile)).status, 'rejected')
        unexpectedSideEffects += f.counts.toolCalls + f.store.metadata().records
        assert.equal(unexpectedSideEffects, 0)
        return { unknownKeysAndAccessorsRejected: true }
      } finally { await rm(f.root, { recursive: true, force: true }) }
    })
    checks.set(`m04:${tool}:unauthorized`, async () => {
      const f = await fixture()
      try {
        if (tool === 'get_overview') {
          const deniedSnapshot = { ...f.snapshot, async assertCurrent() { throw new WorkflowError('permission-denied') } }
          const deniedGateway = createToolGateway(deniedSnapshot, f.store, { chargeTool() {}, assertCanContinue() {}, reserveRead() {}, settleRead() {}, releaseRead() {} })
          assert.equal((await deniedGateway.execute(actions[tool](f))).status, 'rejected')
        } else {
          const action = actions[tool](f)
          if (tool === 'search_text') action.args.fileIds = ['forged-file-id']
          else action.args.fileId = 'forged-file-id'
          const result = await f.gateway.execute(action)
          assert.equal(result.status, 'rejected')
          assert.equal(f.counts.reserved, 0)
        }
        return { unauthorizedDenied: true }
      } finally { await rm(f.root, { recursive: true, force: true }) }
    })
    checks.set(`m04:${tool}:cancel`, async () => {
      const f = await fixture()
      try {
        const controller = new AbortController(); controller.abort()
        const result = await f.gateway.execute(actions[tool](f), controller.signal)
        assert.equal(result.status, 'cancelled')
        assert.equal(f.counts.toolCalls, 0)
        assert.equal(f.store.metadata().records, 0)
        return { preCancelledWithoutSideEffects: true }
      } finally { await rm(f.root, { recursive: true, force: true }) }
    })
    checks.set(`m04:${tool}:budget-exhausted`, async () => {
      const f = await fixture({ budgetMode: 'charge' })
      try {
        const result = await f.gateway.execute(actions[tool](f))
        assert.equal(result.status, 'budget-exhausted')
        assert.equal(f.readStarted(), false)
        assert.equal(f.store.metadata().records, 0)
        return { budgetStopsBeforeRead: true }
      } finally { await rm(f.root, { recursive: true, force: true }) }
    })
    checks.set(`m04:${tool}:duplicate`, async () => {
      const f = await fixture()
      try {
        const action = actions[tool](f)
        const first = await f.gateway.execute(action)
        const repeated = await f.gateway.execute(cloneAction(action))
        assert.equal(repeated.status, first.status)
        assert.deepEqual(repeated.evidenceIds, first.evidenceIds)
        assert.deepEqual(repeated.data, first.data)
        assert.deepEqual(repeated.consumption, { readBytes: 0, toolCalls: 0, cacheHit: true })
        assert.equal(f.counts.toolCalls, 1)
        assert.equal(f.counts.reserved, tool === 'get_overview' ? 0 : f.snapshot.files[0].byteLength)
        const changed = cloneAction(action); changed.args.limit = 1
        if (tool === 'get_overview') assert.equal((await f.gateway.execute(changed)).reasonCode, 'duplicate-id-conflict')
        return { exactDuplicateIdempotent: true }
      } finally { await rm(f.root, { recursive: true, force: true }) }
    })
  }
  checks.set('m04:read-reservation-and-cache', async () => {
    const f = await fixture()
    try {
      const readAction = actions.read_region(f)
      const first = await f.gateway.execute(readAction)
      const cached = await f.gateway.execute({ ...readAction, actionId: 'second-read' })
      assert.equal(first.status, 'ok'); assert.equal(cached.status, 'ok')
      assert.equal(f.counts.reserved, f.snapshot.files[0].byteLength)
      assert.equal(f.counts.actualBytes, f.snapshot.files[0].byteLength)
      assert.equal(cached.consumption.cacheHit, true)
      assert.equal(cached.consumption.readBytes, 0)
      return { fullOriginalBytesReservedOnce: true }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  checks.set('m04:read-budget-exhausted', async () => {
    const f = await fixture({ budgetMode: 'read' })
    try {
      const result = await f.gateway.execute(actions.read_region(f))
      assert.equal(result.status, 'budget-exhausted')
      assert.equal(f.readStarted(), false)
      assert.equal(f.counts.reserved, 0)
      assert.equal(f.store.metadata().records, 0)
      return { byteBudgetStopsBeforeIo: true }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  checks.set('m04:cancel-during-read', async () => {
    const f = await fixture({ blockRead: true })
    try {
      const controller = new AbortController()
      const pending = f.gateway.execute(actions.read_region(f), controller.signal)
      while (!f.readStarted()) await new Promise(resolve => setTimeout(resolve, 1))
      controller.abort(); f.stopRead()
      const result = await pending
      assert.equal(result.status, 'cancelled')
      assert.ok(f.counts.reserved > 0)
      assert.equal(f.counts.released, 0, 'started I/O keeps its conservative reservation')
      assert.equal(f.store.metadata().records, 0)
      return { readReservationConservedAfterIoStarted: true }
    } finally { f.stopRead(); await rm(f.root, { recursive: true, force: true }) }
  })
  checks.set('m04:time-budget-after-read', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'repoprep-m04-deadline-'))
    try {
      await mkdir(path.join(root, 'src'), { recursive: true })
      await writeFile(path.join(root, 'src', 'sample.ts'), source)
      const snapshot = await createWorkflowSnapshot(await scanProject(root), { projectId: 'm04-deadline' })
      const store = createEvidenceStore(snapshot)
      let deadlinePassed = false
      let settledBytes = 0
      const delayedSnapshot = { ...snapshot, async readFile(fileId, signal) { const response = await snapshot.readFile(fileId, signal); deadlinePassed = true; return response } }
      const ledger = {
        assertCanContinue() { if (deadlinePassed) throw new WorkflowError('budget-exhausted') },
        chargeTool() {}, reserveRead() {}, settleRead(_id, bytes) { settledBytes += bytes }, releaseRead() {}
      }
      const gateway = createToolGateway(delayedSnapshot, store, ledger)
      const result = await gateway.execute({ actionId: 'deadline', tool: 'read_region', args: { fileId: snapshot.files[0].fileId, startLine: 1, endLine: 1 } })
      assert.equal(result.status, 'budget-exhausted')
      assert.equal(settledBytes, snapshot.files[0].byteLength)
      assert.equal(store.metadata().records, 0)
      return { deadlineCheckedAfterReadAndBeforeEvidence: true }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  checks.set('m04:unsupported-index-fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'repoprep-m04-fallback-'))
    try {
      await writeFile(path.join(root, 'notes.md'), 'alpha literal fallback\nbeta\n')
      const snapshot = await createWorkflowSnapshot(await scanProject(root), { projectId: 'm04-plain' })
      const store = createEvidenceStore(snapshot)
      const ledger = { chargeTool() {}, assertCanContinue() {}, reserveRead() {}, settleRead() {}, releaseRead() {} }
      const gateway = createToolGateway(snapshot, store, ledger)
      const fileId = snapshot.files[0].fileId
      const symbols = await gateway.execute({ actionId: 'plain-symbols', tool: 'list_symbols', args: { fileId } })
      const search = await gateway.execute({ actionId: 'plain-search', tool: 'search_text', args: { query: 'literal fallback' } })
      const context = await gateway.execute({ actionId: 'plain-context', tool: 'read_declaration_context', args: { fileId, line: 1, maxLines: 2 } })
      assert.equal(symbols.status, 'unavailable')
      assert.equal(search.status, 'ok'); assert.equal(search.data.matches.length, 1)
      assert.equal(context.data.contextMode, 'plaintext-fallback')
      return { unsupportedIndexIsExplicitAndTextStillWorks: true }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  checks.set('m04:stale-cache-denied', async () => {
    const f = await fixture()
    try {
      const first = actions.read_region(f)
      assert.equal((await f.gateway.execute(first)).status, 'ok')
      await writeFile(path.join(f.root, 'src', 'sample.ts'), `${source}changed\n`)
      const second = await f.gateway.execute({ ...first, actionId: 'after-stale' })
      assert.equal(second.status, 'rejected')
      assert.equal(second.evidenceIds.length, 0)
      return { cachedCapabilityNotReturnedWhenStale: true }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  checks.set('m04:side-effects-and-error-redaction', async ctx => {
    const f = await fixture()
    try {
      const before = JSON.stringify({ files: f.snapshot.files, store: f.store.metadata(), reads: f.counts })
      const failed = await f.gateway.execute({ actionId: 'private-failure', tool: 'read_region', args: { fileId: f.snapshot.files[0].fileId, startLine: 500, endLine: 501 } })
      assert.equal(failed.status, 'rejected')
      assert.equal(JSON.stringify(failed).includes(f.root), false)
      assert.equal(JSON.stringify(failed).includes('sk-proj-abcdefghijklmnop'), false)
      const after = JSON.stringify({ files: f.snapshot.files, store: f.store.metadata(), reads: f.counts })
      assert.notEqual(before, after, 'the rejected operation can consume a tool call but creates no evidence')
      assert.equal(f.store.metadata().records, 0)
      ctx.recordMetric('unexpectedSideEffects', unexpectedSideEffects, 'assertion:m04:no-project-mutation-or-extra-capability')
      ctx.recordMetric('unsafeErrorLeaks', unsafeErrorLeaks, 'assertion:m04:static-result-errors')
      return { noProjectWritesAndNoUnsafeErrorText: true }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  return checks
}

export const checks = createChecks()
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../manifest.v2.json', import.meta.url), 'utf8'))
assert.deepEqual([...checks.keys()], manifest.modules.M04.requiredCheckIds)
assert.equal(checks.size, 37)
