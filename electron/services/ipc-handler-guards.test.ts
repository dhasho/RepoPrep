// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { INVOKE_CHANNELS } from './ipc-validation.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { AuthorizedProjectRegistry } from './ipc-authority.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { createGuardedIpcHandler, ExplainAbortRegistry } from './ipc-handler-guards.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { RESULT_CONTRACT_MESSAGES } from '../../shared/result-contract.ts'

const requestId = '4f22d0a1-3e0f-4f4e-8c1d-1c9f9036bc17'
const profile = { id: 'p1', name: 'Demo', baseUrl: 'https://example.com', apiKey: '', model: 'test' }
const result = {
  version: 1, createdAt: '2026-09-25T00:00:00.000Z', projectName: 'demo', projectPath: 'C:\\demo',
  granularity: 'fine', roleFocus: 'backend', profileId: 'p1', modelUsed: 'test', projectSummary: '', sections: [], glossary: {}
}
const inputs = new Map<string, unknown[]>([
  [IPC.selectFolder, []], [IPC.scanProject, ['C:\\demo']], [IPC.recentProjects, []],
  [IPC.removeRecent, ['C:\\demo']], [IPC.loadResult, ['C:\\demo']], [IPC.deleteResult, ['C:\\demo']],
  [IPC.listAnalyses, ['C:\\demo']], [IPC.loadAnalysis, ['C:\\demo', 'a'.repeat(64)]],
  [IPC.generateRun, [{ projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'backend', profileId: 'p1', runId: requestId }]],
  [IPC.generateCancel, [requestId]], [IPC.explainStart, [{ requestId, term: 'IPC', profileId: 'p1', projectSummary: '', question: '问题', snippet: '' }]],
  [IPC.explainCancel, [requestId]], [IPC.settingsGet, []],
  [IPC.storageDiagnostics, []], [IPC.storageRecover, [`result:${'a'.repeat(40)}`]],
  [IPC.settingsSave, [{ profiles: [profile], defaultProfileId: 'p1' }]], [IPC.llmTest, [profile]],
  [IPC.llmListModels, [profile]], [IPC.exportMarkdown, [result]]
])

function context() {
  const mainFrame = { url: 'http://localhost:5173/' }
  const contents = { mainFrame }
  const event = { sender: contents, senderFrame: mainFrame }
  const projects = new AuthorizedProjectRegistry()
  projects.registerSelected('C:\\demo')
  return {
    deps: {
      getExpectedWebContents: () => contents,
      getTrustedRendererUrl: () => 'http://localhost:5173/',
      getStorageRecoveryProject: (id: string) => id === `result:${'a'.repeat(40)}` ? 'C:\\demo' : null,
      projects
    },
    event,
    projects
  }
}

test('登记通道和白名单与实际 IPC invoke 常量完全一致', () => {
  const invokeValues = Object.entries(IPC).filter(([key]) => key !== 'generateProgress' && key !== 'explainEvent').map(([, value]) => value)
  assert.deepEqual([...INVOKE_CHANNELS].sort(), [...invokeValues].sort())
})

test('每个 invoke 通道都在 main.ts 中注册了 handler', () => {
  // 通道清单由 ipc-validation.ts 的 schema 表派生，因此“新增通道”会自动进入白名单；
  // 这里补上另一半约束：新通道必须同时真的在 main.ts 里注册，否则渲染进程调用它只会
  // 得到一句 “No handler registered”，很难定位。
  const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
  const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const registered = new Set<string>(
    [...code.matchAll(/\bhandle\(\s*IPC\.(\w+)/g)].map((match) => IPC[match[1] as keyof typeof IPC] as string)
  )
  for (const channel of INVOKE_CHANNELS) {
    assert.ok(registered.has(channel), `main.ts 未注册 IPC handler：${channel}`)
  }
})

test('每个 invoke 通道都通过统一 guard 到达业务 handler', async () => {
  assert.equal(inputs.size, INVOKE_CHANNELS.length)
  for (const channel of INVOKE_CHANNELS) {
    const { deps, event } = context()
    let calls = 0
    const handler = createGuardedIpcHandler(channel, deps, (_event, ...args) => { calls++; return args })
    const output = await handler(event, ...(inputs.get(channel)!))
    assert.equal(calls, 1, channel)
    assert.ok(Array.isArray(output), channel)
  }
})

test('项目 handler 与导出 handler 收到 registry 中登记的原始路径', async () => {
  const { deps, event, projects } = context()
  projects.registerSelected('C:\\Demo')
  for (const [channel, args] of [
    [IPC.scanProject, ['c:\\demo']], [IPC.loadResult, ['c:\\demo']],
    [IPC.listAnalyses, ['c:\\demo']], [IPC.loadAnalysis, ['c:\\demo', 'a'.repeat(64)]],
    [IPC.deleteResult, ['c:\\demo']],
    [IPC.generateRun, [{ ...inputs.get(IPC.generateRun)![0] as object, projectPath: 'c:\\demo' }]],
    [IPC.exportMarkdown, [{ ...result, projectPath: 'c:\\demo' }]]
  ] as Array<[string, unknown[]]>) {
    const handler = createGuardedIpcHandler(channel, deps, (_event, arg) => arg)
    const received = await handler(event, ...args) as Record<string, unknown>
    const path = typeof received === 'string' ? received : received.projectPath
    assert.equal(path, 'C:\\Demo', channel)
  }
})

test('removeRecent authorizes the supplied alias but preserves the exact persisted key', async () => {
  const { deps, event, projects } = context()
  projects.registerRecent(['C:\\Demo'])
  projects.registerSelected('c:/demo')
  const handler = createGuardedIpcHandler(IPC.removeRecent, deps, (_event, path) => path)
  assert.equal(await handler(event, 'C:\\Demo'), 'C:\\Demo')
})

test('result recovery requires a currently authorized project resolved from its diagnostic ID', async () => {
  const allowed = context()
  let received = ''
  const handler = createGuardedIpcHandler(IPC.storageRecover, allowed.deps, (_event, id) => { received = id as string })
  const id = `result:${'a'.repeat(40)}`
  await handler(allowed.event, id)
  assert.equal(received, id)

  const denied = context()
  let calls = 0
  const deniedDeps = { ...denied.deps, getStorageRecoveryProject: () => null }
  await assert.rejects(
    createGuardedIpcHandler(IPC.storageRecover, deniedDeps, () => { calls++ })(denied.event, id),
    /请求无效或未获授权/
  )
  assert.equal(calls, 0, 'revoked or unresolved result diagnostics must fail before the store is called')
})

test('所有通道拒绝非可信 sender，且拒绝发生在服务调用前', async () => {
  for (const channel of INVOKE_CHANNELS) {
    const { deps, event } = context()
    let calls = 0
    const handler = createGuardedIpcHandler(channel, deps, () => { calls++ })
    await assert.rejects(handler({ ...event, senderFrame: { url: 'https://evil.example/' } }, ...(inputs.get(channel)!)), /请求无效或未获授权/)
    assert.equal(calls, 0, channel)
  }
})

test('拒绝子框架、其他窗口与尚未确定信任入口的请求', async () => {
  // 子框架：URL 恰好与信任入口一致，但 senderFrame 不是主框架，必须拒绝。
  const subframe = context()
  await assert.rejects(
    createGuardedIpcHandler(IPC.settingsGet, subframe.deps, () => 'called')(
      { ...subframe.event, senderFrame: { url: 'http://localhost:5173/' } }
    ),
    /请求无效或未获授权/
  )

  // 其他窗口：sender 与期望的 webContents 不是同一个对象。
  const otherWindow = context()
  const mainWindow = context()
  await assert.rejects(
    createGuardedIpcHandler(IPC.settingsGet, { ...otherWindow.deps, getExpectedWebContents: () => mainWindow.event.sender }, () => 'called')(otherWindow.event),
    /请求无效或未获授权/
  )

  // 入口尚未确定（窗口还没建好或入口未决）：必须拒绝，而不是退化成只比对 webContents。
  const noEntry = context()
  await assert.rejects(
    createGuardedIpcHandler(IPC.settingsGet, { ...noEntry.deps, getTrustedRendererUrl: () => null }, () => 'called')(noEntry.event),
    /请求无效或未获授权/
  )
})

test('路径操作与导出拒绝未登记项目，服务层不执行', async () => {
  for (const [channel, args] of [
    [IPC.scanProject, ['C:\\private']], [IPC.loadResult, ['C:\\private']],
    [IPC.listAnalyses, ['C:\\private']], [IPC.loadAnalysis, ['C:\\private', 'a'.repeat(64)]],
    [IPC.deleteResult, ['C:\\private']], [IPC.generateRun, [{ ...inputs.get(IPC.generateRun)![0] as object, projectPath: 'C:\\private' }]],
    [IPC.exportMarkdown, [{ ...result, projectPath: 'C:\\private' }]]
  ] as Array<[string, unknown[]]>) {
    const { deps, event } = context()
    let calls = 0
    const handler = createGuardedIpcHandler(channel, deps, () => { calls++ })
    await assert.rejects(handler(event, ...args), /请求无效或未获授权/)
    assert.equal(calls, 0, channel)
  }
})

test('未知通道和畸形输入拒绝，服务错误对 renderer 脱敏', async () => {
  const { deps, event } = context()
  let calls = 0
  await assert.rejects(createGuardedIpcHandler('unknown:invoke', deps, () => { calls++ })(event), /请求无效或未获授权/)
  await assert.rejects(createGuardedIpcHandler(IPC.settingsGet, deps, () => { calls++ })(event, 'extra'), /请求无效或未获授权/)
  await assert.rejects(createGuardedIpcHandler(IPC.settingsGet, deps, () => { calls++; throw new Error('secret path C:\\private api-key=secret') })(event), /请求处理失败，请稍后重试/)
  assert.equal(calls, 1)
})

test('名词解释拒绝重复活动 requestId，并将取消绑定到正确的控制器实例', () => {
  const registry = new ExplainAbortRegistry()
  const active = registry.begin(requestId)
  assert.ok(active)
  assert.equal(registry.begin(requestId.toUpperCase()), null)
  registry.cancel(requestId.toUpperCase())
  assert.equal(active.signal.aborted, true)

  registry.finish(requestId, active)
  const next = registry.begin(requestId)
  assert.ok(next)
  assert.notEqual(next, active)
  assert.equal(next.signal.aborted, false)
  registry.cancel(requestId)
  assert.equal(next.signal.aborted, true)
  registry.finish(requestId, next)
  assert.ok(registry.begin(requestId), 'requestId can be reused after its active request finishes')
})

test('设置持久化失败：白名单内的静态业务错误原样透传给渲染进程（issue #15）', async () => {
  const messages = [
    '磁盘空间不足，无法保存设置。请清理磁盘空间后重试。',
    '没有写入权限，无法保存设置。请检查应用数据目录权限后重试。',
    '保存设置失败，请重试；若持续失败请检查磁盘状态。'
  ]
  for (const message of messages) {
    const { deps, event } = context()
    await assert.rejects(
      createGuardedIpcHandler(IPC.settingsSave, deps, () => {
        throw new Error(message)
      })(event, ...(inputs.get(IPC.settingsSave)!)),
      (err: unknown) => err instanceof Error && err.message === message
    )
  }

  // 非白名单错误仍被替换为通用文案，不泄露底层细节
  const { deps, event } = context()
  await assert.rejects(
    createGuardedIpcHandler(IPC.settingsSave, deps, () => {
      throw new Error('EACCES: permission denied, open /home/user/.config/settings.json')
    })(event, ...(inputs.get(IPC.settingsSave)!)),
    (err: unknown) => err instanceof Error && err.message === '请求处理失败，请稍后重试'
  )
})

test('生成结果与历史结果的静态契约错误可安全透传给 renderer', async () => {
  for (const [channel, message, args] of [
    [IPC.generateRun, RESULT_CONTRACT_MESSAGES.generated, inputs.get(IPC.generateRun)!],
    [IPC.loadResult, RESULT_CONTRACT_MESSAGES.history, inputs.get(IPC.loadResult)!]
  ] as Array<[string, string, unknown[]]>) {
    const { deps, event } = context()
    await assert.rejects(
      createGuardedIpcHandler(channel, deps, () => { throw new Error(message) })(event, ...args),
      (error: unknown) => error instanceof Error && error.message === message
    )
  }
})
