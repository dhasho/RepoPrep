// 模型列表检测竞态的测试（issue #14）
//
// fake API 的每个请求都是手动结算的 deferred promise，可以精确控制
// "谁先发、谁后回"，覆盖验收标准的全部竞态场景。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { ListModelsResult, LlmProfile } from '../../shared/types.ts'
import { ModelDetectionController, modelStateOf }
  // @ts-expect-error Node strip-types requires the explicit extension; project bundler resolution does not.
  from './model-detection.ts'

interface Deferred {
  resolve: (r: ListModelsResult) => void
  reject: (e: unknown) => void
}

/** 可控延迟的假 API：记录每次调用，返回按序手动结算的 promise */
function makeFakeApi() {
  const calls: LlmProfile[] = []
  const pending = new Map<number, Deferred>()
  let n = 0
  const api = {
    listModels(profile: LlmProfile): Promise<ListModelsResult> {
      calls.push(profile)
      const id = ++n
      return new Promise<ListModelsResult>((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
    }
  }
  return {
    api,
    calls,
    /** 让第 k 个（1 起）请求成功返回 */
    settle(k: number, result: ListModelsResult) {
      pending.get(k)!.resolve(result)
    },
    /** 让第 k 个（1 起）请求失败 */
    fail(k: number, err: unknown) {
      pending.get(k)!.reject(err)
    }
  }
}

const profileA = (overrides?: Partial<LlmProfile>): LlmProfile => ({
  id: 'profile-a',
  name: 'A',
  baseUrl: 'https://a.example/v1',
  apiKey: 'key-a',
  model: 'm-a',
  temperature: 0.4,
  ...overrides
})

/** 结算后控制器回调在微任务里执行，冲刷一轮再断言 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('检测成功：结果写入该配置槽位，loading 结束', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  c.detect(profileA())
  assert.equal(modelStateOf(c.getSnapshot(), 'profile-a').loading, true)
  fake.settle(1, { ok: true, models: ['m1', 'm2'], message: '检测到 2 个' })
  await flush()
  const s = modelStateOf(c.getSnapshot(), 'profile-a')
  assert.equal(s.loading, false)
  assert.deepEqual(s.models, ['m1', 'm2'])
  assert.equal(s.messageOk, true)
  assert.equal(s.showList, true)
})

test('验收 1：检测期间换 API Key（invalidate）后，旧响应被丢弃', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  c.detect(profileA())
  c.invalidate('profile-a') // 用户改了 Key / Base URL
  fake.settle(1, { ok: true, models: ['旧列表'], message: 'ok' })
  await flush()
  const s = modelStateOf(c.getSnapshot(), 'profile-a')
  assert.deepEqual(s.models, [], '过期的列表不应出现')
  assert.equal(s.loading, false)
  assert.equal(s.message, '', '过期响应不应留下提示')
  assert.equal(s.showList, false)
})

test('验收 1：响应返回时只写入发起它的配置，另一配置的槽位不受影响', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  c.detect(profileA())
  c.detect(profileA({ id: 'profile-b', apiKey: 'key-b' }))
  fake.settle(1, { ok: true, models: ['a-模型'], message: 'ok' })
  await flush()
  assert.deepEqual(modelStateOf(c.getSnapshot(), 'profile-a').models, ['a-模型'])
  assert.deepEqual(modelStateOf(c.getSnapshot(), 'profile-b').models, [], '旧配置的响应不应出现在新配置界面')
  assert.equal(modelStateOf(c.getSnapshot(), 'profile-b').loading, true)
})

test('验收 2：连续快速检测同一配置，只接受最后一次响应', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  const p = profileA()
  c.detect(p) // 第 1 次
  c.detect(p) // 第 2 次（同一配置，后发）
  fake.settle(1, { ok: true, models: ['先发后至'], message: 'ok' })
  await flush()
  assert.deepEqual(modelStateOf(c.getSnapshot(), 'profile-a').models, [], '先发的迟到响应应被丢弃')
  fake.settle(2, { ok: true, models: ['最后一次'], message: 'ok' })
  await flush()
  assert.deepEqual(modelStateOf(c.getSnapshot(), 'profile-a').models, ['最后一次'])
  assert.equal(fake.calls.length, 2)
})

test('验收 2 反向：最后一次先返回、先发的后返回，仍以最后一次为准', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  const p = profileA()
  c.detect(p)
  c.detect(p)
  fake.settle(2, { ok: true, models: ['最后一次'], message: 'ok' })
  await flush()
  assert.deepEqual(modelStateOf(c.getSnapshot(), 'profile-a').models, ['最后一次'])
  fake.settle(1, { ok: true, models: ['先发后至'], message: 'ok' })
  await flush()
  assert.deepEqual(modelStateOf(c.getSnapshot(), 'profile-a').models, ['最后一次'], '迟到响应不能覆盖新结果')
})

test('验收 3：被取代的请求失败不显示误导性错误', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  const p = profileA()
  c.detect(p)
  c.detect(p)
  fake.fail(1, new Error('网络错误'))
  await flush()
  const s = modelStateOf(c.getSnapshot(), 'profile-a')
  assert.equal(s.message, '', '被取代请求的失败不应显示')
  assert.equal(s.loading, true, '仍应显示最后一次检测的 loading')
  // 最后一次失败时才显示错误
  fake.fail(2, new Error('服务超时'))
  await flush()
  assert.equal(modelStateOf(c.getSnapshot(), 'profile-a').message, '获取失败：服务超时')
})

test('最后一次请求失败也丢弃过期成功响应（成功与失败共用同一序号判断）', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  const p = profileA()
  c.detect(p)
  c.invalidate('profile-a')
  fake.fail(1, new Error('网络错误'))
  await flush()
  const s = modelStateOf(c.getSnapshot(), 'profile-a')
  assert.equal(s.message, '', '失效后的失败不应显示')
  assert.equal(s.loading, false)
})

test('Base URL 为空时不发起请求并提示', () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  c.detect(profileA({ baseUrl: '   ' }))
  assert.deepEqual(fake.calls, [], '不应调用 API')
  assert.equal(modelStateOf(c.getSnapshot(), 'profile-a').message, '请先填写接口地址（Base URL）')
})

test('hideList 只收起列表，不影响结果与提示', async () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  c.detect(profileA())
  fake.settle(1, { ok: true, models: ['m1'], message: 'ok' })
  await flush()
  c.hideList('profile-a')
  const s = modelStateOf(c.getSnapshot(), 'profile-a')
  assert.equal(s.showList, false)
  assert.deepEqual(s.models, ['m1'])
  assert.equal(s.message, 'ok')
})

test('invalidate 对没有记录的配置是安全的', () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  c.invalidate('profile-x')
  assert.equal(modelStateOf(c.getSnapshot(), 'profile-x').loading, false)
})

test('getSnapshot 引用稳定：未变化时返回同一对象（供 useSyncExternalStore 使用）', () => {
  const fake = makeFakeApi()
  const c = new ModelDetectionController(fake.api)
  const a = c.getSnapshot()
  assert.equal(a, c.getSnapshot())
  c.detect(profileA())
  const b = c.getSnapshot()
  assert.notEqual(a, b, '状态变化后应返回新对象以触发重渲染')
  assert.equal(b, c.getSnapshot())
})
