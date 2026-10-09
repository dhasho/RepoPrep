// 设置保存流程的测试（issue #15）：成功、失败、重复点击。
// fake API 为手动结算的 deferred promise，可精确控制"保存中"的窗口期。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { Settings } from '../../shared/types.ts'
import { SettingsSaveFlow }
  // @ts-expect-error Node strip-types requires the explicit extension; project bundler resolution does not.
  from './settings-save.ts'

interface Deferred {
  resolve: () => void
  reject: (e: unknown) => void
}

const settingsA: Settings = { profiles: [], defaultProfileId: null }

/** 可控延迟的假 API：记录调用次数，手动结算 */
function makeFakeApi() {
  const calls: Settings[] = []
  const pending = new Map<number, Deferred>()
  let n = 0
  return {
    api: {
      saveSettings(settings: Settings): Promise<void> {
        calls.push(settings)
        const id = ++n
        return new Promise<void>((resolve, reject) => {
          pending.set(id, { resolve, reject })
        })
      }
    },
    calls,
    settle(k: number) {
      pending.get(k)!.resolve()
    },
    fail(k: number, err: unknown) {
      pending.get(k)!.reject(err)
    }
  }
}

/** 结算后控制器回调在微任务里执行，冲刷一轮再断言 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('成功：等待主进程确认后才返回 saved，且只写盘一次', async () => {
  const fake = makeFakeApi()
  const flow = new SettingsSaveFlow(fake.api)
  const promise = flow.save(settingsA)
  let result: { outcome: string; hasEditsDuringSave: boolean } | null = null
  void promise.then((r) => {
    result = r
  })
  // 主进程还没确认写盘：不允许提前宣布成功
  assert.equal(result, null, '写盘完成前不应返回 saved')
  fake.settle(1)
  await flush()
  assert.deepEqual(result, { outcome: 'saved', hasEditsDuringSave: false })
  assert.equal(fake.calls.length, 1)
})

test('失败：把主进程的错误抛给调用方（不吞掉、不宣布成功）', async () => {
  const fake = makeFakeApi()
  const flow = new SettingsSaveFlow(fake.api)
  const promise = flow.save(settingsA)
  fake.fail(1, new Error('磁盘空间不足，无法保存设置。请清理磁盘空间后重试。'))
  await assert.rejects(promise, /磁盘空间不足/)
  assert.equal(fake.calls.length, 1)
})

test('重复点击：保存进行中再次触发返回 busy，不排队第二次写盘', async () => {
  const fake = makeFakeApi()
  const flow = new SettingsSaveFlow(fake.api)
  const first = flow.save(settingsA)
  const second = await flow.save(settingsA)
  assert.deepEqual(second, { outcome: 'busy', hasEditsDuringSave: false }, '保存期间的重复触发应被拒绝')
  assert.equal(fake.calls.length, 1, '不应发起第二次写盘')
  fake.settle(1)
  await flush()
  await first
})

test('保存发起后又有本地修改：结果带 hasEditsDuringSave=true（不得清除未保存标记）', async () => {
  const fake = makeFakeApi()
  const flow = new SettingsSaveFlow(fake.api)
  const promise = flow.save(settingsA)
  flow.markLocalEdit() // 保存进行中用户又改了配置
  fake.settle(1)
  await flush()
  assert.deepEqual(await promise, { outcome: 'saved', hasEditsDuringSave: true })
})

test('保存发起前发生的修改不影响判定（只有保存窗口期内的修改才算）', async () => {
  const fake = makeFakeApi()
  const flow = new SettingsSaveFlow(fake.api)
  flow.markLocalEdit() // 保存之前的老修改
  const promise = flow.save(settingsA)
  fake.settle(1)
  await flush()
  assert.deepEqual(await promise, { outcome: 'saved', hasEditsDuringSave: false })
})

test('失败或完成后可以再次保存（inFlight 状态正确复位）', async () => {
  const fake = makeFakeApi()
  const flow = new SettingsSaveFlow(fake.api)
  const first = flow.save(settingsA)
  fake.fail(1, new Error('保存失败'))
  await assert.rejects(first)
  // 失败后再次保存应正常发起新的写盘
  const second = flow.save(settingsA)
  assert.equal(fake.calls.length, 2)
  fake.settle(2)
  assert.deepEqual(await second, { outcome: 'saved', hasEditsDuringSave: false })
})
