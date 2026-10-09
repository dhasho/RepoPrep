// 生成任务槽位注册表的竞态测试（issue #20）
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { GenerationTaskRegistry } from './generation-tasks.ts'

test('验收：begin 是原子的——同一时刻只有一个任务能占用槽位', () => {
  const registry = new GenerationTaskRegistry()
  const first = registry.begin()
  assert.ok(first, '第一次 begin 应成功')
  assert.equal(registry.begin(), null, '重复 begin（双击 / 重复 IPC）必须被拒绝')
  assert.equal(registry.begin(), null, '扫描延迟期间再入的请求同样被拒绝')
  assert.equal(registry.active?.runId, first!.runId, '槽位仍归第一个任务所有')
})

test('runId 稳定且每次任务不同', () => {
  const registry = new GenerationTaskRegistry()
  const first = registry.begin()!
  assert.match(first.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  registry.finish(first.runId)
  const second = registry.begin()!
  assert.notEqual(second.runId, first.runId)
})

test('finish 只在 runId 匹配时释放（陈旧 finish 不会清掉新任务的锁）', () => {
  const registry = new GenerationTaskRegistry()
  const first = registry.begin()!
  registry.finish('stale-run-id')
  assert.equal(registry.active?.runId, first.runId, '陈旧 runId 的 finish 是空操作')
  registry.finish(first.runId)
  assert.equal(registry.active, null, '正确的 finish 释放槽位')
  assert.ok(registry.begin(), '释放后可以开始新任务')
})

test('验收：cancel 只中止当前任务，不释放锁（等任务自己收尾）', () => {
  const registry = new GenerationTaskRegistry()
  const task = registry.begin()!
  assert.equal(registry.cancelCurrent(), true)
  assert.equal(task.controller.signal.aborted, true, '当前任务的 controller 被中止')
  assert.equal(registry.active?.runId, task.runId, '锁仍归当前任务，直到它 finish')
  registry.finish(task.runId)
  assert.equal(registry.active, null)
})

test('无任务时 cancel 是安全的空操作', () => {
  const registry = new GenerationTaskRegistry()
  assert.equal(registry.cancelCurrent(), false)
  registry.cancelAll()
  assert.equal(registry.active, null)
})

test('cancelAll：反复取消只中止任务，不释放直到 finally 调用 finish', () => {
  const registry = new GenerationTaskRegistry()
  const task = registry.begin()!
  registry.cancelAll()
  registry.cancelAll()
  assert.equal(task.controller.signal.aborted, true)
  assert.equal(registry.active?.runId, task.runId)
  assert.equal(registry.begin(), null, '取消中的任务未完成时仍占槽位')
  registry.finish(task.runId)
  assert.ok(registry.begin(), 'finally 释放后允许新任务')
})
