// 生成任务槽位注册表的竞态测试（issue #20）
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { GenerationTaskRegistry } from './generation-tasks.ts'

const runA = '4f22d0a1-3e0f-4f4e-8c1d-1c9f9036bc17'
const runB = 'e7a77f04-31b9-4c35-aaf2-7c7e1790ac54'

test('验收：begin 是原子的——同一时刻只有一个任务能占用槽位', () => {
  const registry = new GenerationTaskRegistry()
  const first = registry.begin(runA)
  assert.ok(first, '第一次 begin 应成功')
  assert.equal(registry.begin(runB), null, '重复 begin（双击 / 重复 IPC）必须被拒绝')
  assert.equal(registry.begin(runB), null, '扫描延迟期间再入的请求同样被拒绝')
  assert.equal(registry.active?.runId, first!.runId, '槽位仍归第一个任务所有')
})

test('runId 稳定且每次任务不同', () => {
  const registry = new GenerationTaskRegistry()
  const first = registry.begin(runA)!
  assert.equal(first.runId, runA)
  registry.finish(first.runId)
  const second = registry.begin(runB)!
  assert.notEqual(second.runId, first.runId)
})

test('finish 只在 runId 匹配时释放（陈旧 finish 不会清掉新任务的锁）', () => {
  const registry = new GenerationTaskRegistry()
  const first = registry.begin(runA)!
  registry.finish('stale-run-id')
  assert.equal(registry.active?.runId, first.runId, '陈旧 runId 的 finish 是空操作')
  registry.finish(first.runId)
  assert.equal(registry.active, null, '正确的 finish 释放槽位')
  assert.ok(registry.begin(runB), '释放后可以开始新任务')
})

test('cancel 只中止匹配任务，不释放锁（等任务自己收尾）', () => {
  const registry = new GenerationTaskRegistry()
  const task = registry.begin(runA)!
  assert.equal(registry.cancel(runB), false, '旧 runId 取消必须为空操作')
  assert.equal(task.controller.signal.aborted, false, '错 runId 不得影响当前任务')
  assert.equal(registry.cancel(runA.toUpperCase()), true, 'UUID 大小写差异应归一化为同一会话')
  assert.equal(task.controller.signal.aborted, true, '当前任务的 controller 被中止')
  assert.equal(registry.active?.runId, task.runId, '锁仍归当前任务，直到它 finish')
  registry.finish(task.runId)
  assert.equal(registry.active, null)
})

test('无任务时 cancel 是安全的空操作', () => {
  const registry = new GenerationTaskRegistry()
  assert.equal(registry.cancel(runA), false)
  registry.cancelAll()
  assert.equal(registry.active, null)
})

test('cancelAll：反复取消只中止任务，不释放直到 finally 调用 finish', () => {
  const registry = new GenerationTaskRegistry()
  const task = registry.begin(runA)!
  registry.cancelAll()
  registry.cancelAll()
  assert.equal(task.controller.signal.aborted, true)
  assert.equal(registry.active?.runId, task.runId)
  assert.equal(registry.begin(runB), null, '取消中的任务未完成时仍占槽位')
  registry.finish(task.runId)
  const next = registry.begin(runB)!
  registry.finish(runA)
  assert.equal(registry.active?.runId, runB, '旧任务迟到的 finish 不会清掉新任务槽位')
  assert.ok(next, 'finally 释放后允许新任务')
})
