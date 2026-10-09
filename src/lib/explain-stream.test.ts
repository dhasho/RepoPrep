// 名词解释流式生命周期的测试（issue #12）
//
// 覆盖验收标准：关闭弹窗后立即终止请求、快速切换词条不串流、
// 用户主动停止不显示为普通错误、以及卸载与竞态。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { ExplainEvent, ExplainRequest } from '../../shared/types.ts'
import { ExplainStreamController }
  // @ts-expect-error Node strip-types requires the explicit extension; project bundler resolution does not.
  from './explain-stream.ts'

/** 可观测的假 API：记录调用顺序，并可手动推送事件 */
function makeFakeApi() {
  const calls: string[] = []
  const requests: ExplainRequest[] = []
  const cancelled: string[] = []
  const rejecters = new Map<string, (e: unknown) => void>()
  let push: ((e: ExplainEvent) => void) | null = null
  let unsubscribed = 0

  const api = {
    explain(req: ExplainRequest): Promise<void> {
      calls.push(`explain:${req.requestId}`)
      requests.push(req)
      return new Promise<void>((_resolve, reject) => {
        rejecters.set(req.requestId, reject)
      })
    },
    cancelExplain(requestId: string): void {
      calls.push(`cancel:${requestId}`)
      cancelled.push(requestId)
      // 模拟主进程：取消后该请求以"已取消"失败收场
      rejecters.get(requestId)?.(new Error('已取消'))
    },
    onExplainEvent(cb: (e: ExplainEvent) => void): () => void {
      push = cb
      return () => {
        unsubscribed++
      }
    }
  }

  return {
    api,
    calls,
    requests,
    cancelled,
    emit: (e: ExplainEvent) => push?.(e),
    /** 手动让某个请求的 invoke promise 拒绝（模拟 IPC 失败/取消） */
    reject: (requestId: string, err: unknown) => rejecters.get(requestId)?.(err),
    get unsubscribed() {
      return unsubscribed
    }
  }
}

const baseReq = { term: '依赖注入', profileId: 'p1', projectSummary: 's', question: 'q', snippet: 'x' }

test('开始解释：进入 streaming 并带上 requestId', () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.start(baseReq)
  assert.equal(c.getSnapshot().status, 'streaming')
  assert.equal(c.getSnapshot().requestId, 'r1')
  assert.deepEqual(fake.calls, ['explain:r1'])
  assert.equal(fake.requests[0].term, '依赖注入')
})

test('delta 累积、done 结束', () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.start(baseReq)
  fake.emit({ requestId: 'r1', type: 'delta', data: '第一段' })
  fake.emit({ requestId: 'r1', type: 'delta', data: '第二段' })
  assert.equal(c.getSnapshot().text, '第一段第二段')
  fake.emit({ requestId: 'r1', type: 'done', data: '' })
  assert.equal(c.getSnapshot().status, 'done')
  assert.equal(c.getSnapshot().requestId, '', '结束后不应再有进行中的 requestId')
})

test('验收 1：dispose（弹窗卸载/页面离开）立即取消进行中的请求', () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.start(baseReq)
  c.dispose()
  assert.deepEqual(fake.cancelled, ['r1'], '必须调用 cancelExplain')
  assert.equal(fake.unsubscribed, 1, '必须退订事件')
  assert.equal(c.getSnapshot().status, 'stopped')
  assert.equal(c.getSnapshot().requestId, '')
})

test('StrictMode 双挂载：dispose 后再次 start 会重新武装并发起新请求', () => {
  // dev 下 StrictMode 会先跑一次卸载清理（dispose）再重挂载同一个组件实例，
  // useMemo 的控制器不会重建——start 必须能恢复工作，否则弹卡永久失效。
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.dispose()
  c.start(baseReq)
  assert.deepEqual(fake.calls, ['explain:r1'], 'dispose 后的 start 应重新发起新请求')
  assert.equal(c.getSnapshot().status, 'streaming')
  assert.equal(c.getSnapshot().requestId, 'r1')
})

test('dispose 后不再发起新请求时，迟到事件仍被忽略（不会在卸载后更新界面）', () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.start(baseReq)
  fake.emit({ requestId: 'r1', type: 'delta', data: '半句' })
  const before = c.getSnapshot()
  c.dispose()
  fake.emit({ requestId: 'r1', type: 'delta', data: '迟到内容' })
  assert.equal(c.getSnapshot().text, before.text, '卸载后不应再累积文本')
})

test('验收 3：用户点停止不算错误，且以后续事件也不会把它翻成错误', () => {
  const fake = makeFakeApi()
  const ids = ['r1', 'r2']
  const c = new ExplainStreamController(fake.api, () => ids.shift()!)
  c.start(baseReq)
  c.stop()
  assert.deepEqual(fake.cancelled, ['r1'])
  assert.equal(c.getSnapshot().status, 'stopped', '停止应显示为"已停止"而不是 error')
  assert.equal(c.getSnapshot().error, '')
  // 主进程随后补发的 '已取消' error 事件不应把状态改成 error
  fake.emit({ requestId: 'r1', type: 'error', data: '已取消' })
  assert.equal(c.getSnapshot().status, 'stopped')
})

test('验收 2：快速切换词条时先取消旧请求，且旧请求的事件不会污染新内容', () => {
  const fake = makeFakeApi()
  const ids = ['r1', 'r2']
  const c = new ExplainStreamController(fake.api, () => ids.shift()!)
  c.start(baseReq)
  fake.emit({ requestId: 'r1', type: 'delta', data: '旧内容' })

  // 切换到新词条
  c.start({ ...baseReq, term: '事务隔离' })
  assert.deepEqual(fake.cancelled, ['r1'], '切换时应取消旧请求')
  assert.equal(c.getSnapshot().requestId, 'r2')
  assert.equal(c.getSnapshot().text, '', '新请求的文本应从空开始')

  // 旧请求的迟到事件必须被忽略
  fake.emit({ requestId: 'r1', type: 'delta', data: '迟到的旧内容' })
  fake.emit({ requestId: 'r1', type: 'done', data: '' })
  assert.equal(c.getSnapshot().text, '', '旧请求的 delta 不应写入')
  assert.equal(c.getSnapshot().status, 'streaming', '旧请求的 done 不应结束新请求')

  // 新请求正常流入
  fake.emit({ requestId: 'r2', type: 'delta', data: '新内容' })
  assert.equal(c.getSnapshot().text, '新内容')
  assert.equal(fake.requests[1].term, '事务隔离')
})

test('普通错误仍显示为 error（与"已停止"区分开）', () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.start(baseReq)
  fake.emit({ requestId: 'r1', type: 'error', data: '模型不可用' })
  assert.equal(c.getSnapshot().status, 'error')
  assert.equal(c.getSnapshot().error, '模型不可用')
})

test('explain 的 invoke promise 被拒绝且仍是当前请求时记为 error', async () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.start(baseReq)
  fake.reject('r1', new Error('请求无效或未获授权'))
  // 拒绝回调在微任务里执行，冲刷后再断言
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(c.getSnapshot().status, 'error')
  assert.equal(c.getSnapshot().error, '请求无效或未获授权')
  assert.equal(c.getSnapshot().requestId, '', '出错后不应再有进行中的 requestId')
})

test('切换词条后旧请求迟到的 invoke 拒绝不影响新请求（异步时序）', async () => {
  const fake = makeFakeApi()
  const ids = ['r1', 'r2']
  const c = new ExplainStreamController(fake.api, () => ids.shift()!)
  c.start(baseReq)
  c.start({ ...baseReq, term: '事务隔离' })
  fake.reject('r1', new Error('已取消'))
  // 让拒绝回调的微任务走完，验证新请求的 streaming 状态没被打翻
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(c.getSnapshot().status, 'streaming')
  assert.equal(c.getSnapshot().requestId, 'r2')
  assert.equal(c.getSnapshot().error, '')
})

test('用户停止后 invoke 的拒绝不会把状态改成 error', async () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  c.start(baseReq)
  c.stop()
  fake.reject('r1', new Error('已取消'))
  // 拒绝回调在微任务里执行，冲刷后再断言"已停止"没被翻成错误
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(c.getSnapshot().status, 'stopped', '停止后应保持"已停止"状态')
  assert.equal(c.getSnapshot().error, '')
})

test('重新解释：done 之后可以再次 start 并拿到新的 requestId', () => {
  const fake = makeFakeApi()
  const ids = ['r1', 'r2']
  const c = new ExplainStreamController(fake.api, () => ids.shift()!)
  c.start(baseReq)
  fake.emit({ requestId: 'r1', type: 'done', data: '' })
  assert.equal(c.getSnapshot().status, 'done')

  c.start(baseReq)
  assert.equal(c.getSnapshot().requestId, 'r2')
  assert.equal(c.getSnapshot().status, 'streaming')
  assert.deepEqual(fake.calls.filter((x) => x.startsWith('cancel')), [], '已结束的请求无需取消')
})

test('订阅者能收到状态变化通知', () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  let notified = 0
  const off = c.subscribe(() => {
    notified++
  })
  c.start(baseReq)
  fake.emit({ requestId: 'r1', type: 'delta', data: 'x' })
  assert.ok(notified >= 2, `订阅者应被通知，实际 ${notified} 次`)
  off()
  const before = notified
  fake.emit({ requestId: 'r1', type: 'delta', data: 'y' })
  assert.equal(notified, before, '退订后不应再收到通知')
})

test('getSnapshot 引用稳定：未变化时返回同一对象（供 useSyncExternalStore 使用）', () => {
  const fake = makeFakeApi()
  const c = new ExplainStreamController(fake.api, () => 'r1')
  const a = c.getSnapshot()
  assert.equal(a, c.getSnapshot())
  c.start(baseReq)
  const b = c.getSnapshot()
  assert.notEqual(a, b, '状态变化后应返回新对象以触发重渲染')
  assert.equal(b, c.getSnapshot())
})
