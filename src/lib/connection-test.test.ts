// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { LlmProfileDraft, TestConnectionResult } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { ConnectionTestController } from './connection-test.ts'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const profile = (id: string, patch: Partial<LlmProfileDraft> = {}): LlmProfileDraft => ({
  id,
  name: `Synthetic ${id}`,
  baseUrl: 'https://example.invalid/v1',
  apiKey: `synthetic-${id}-secret`,
  model: 'synthetic-model',
  temperature: 0.4,
  ...patch
})

const success = (message: string): TestConnectionResult => ({ ok: true, message })

test('ConnectionTestController ignores every kind of late A settlement while B is loading', async (t) => {
  const settlements = ['success', 'business failure', 'IPC rejection'] as const
  for (const settlement of settlements) {
    await t.test(settlement, async () => {
      const pending: Array<{ requestProfile: LlmProfileDraft; response: Deferred<TestConnectionResult> }> = []
      const controller = new ConnectionTestController({
        testLlm(requestProfile) {
          const response = deferred<TestConnectionResult>()
          pending.push({ requestProfile, response })
          return response.promise
        }
      })
      controller.activate()

      const runA = controller.run(profile('A'))
      const runB = controller.run(profile('B'))
      assert.deepEqual(controller.getSnapshot(), { profileId: 'B', testing: true, result: null })
      assert.equal(pending[0].requestProfile.id, 'A')
      assert.equal(pending[1].requestProfile.id, 'B')

      if (settlement === 'success') {
        pending[0].response.resolve(success('late A success'))
      } else if (settlement === 'business failure') {
        pending[0].response.resolve({ ok: false, message: 'late A business failure' })
      } else {
        pending[0].response.reject(new Error('late A raw provider error synthetic-A-secret'))
      }
      await runA
      assert.deepEqual(controller.getSnapshot(), { profileId: 'B', testing: true, result: null },
        `A ${settlement} and finally must not change B while B is pending`)

      pending[1].response.resolve(success('B connected'))
      await runB
      assert.deepEqual(controller.getSnapshot(), { profileId: 'B', testing: false, result: success('B connected') })
    })
  }
})

test('ConnectionTestController keeps only the latest duplicate request when responses settle in reverse order', async () => {
  const pending: Array<Deferred<TestConnectionResult>> = []
  const controller = new ConnectionTestController({
    testLlm() {
      const response = deferred<TestConnectionResult>()
      pending.push(response)
      return response.promise
    }
  })
  controller.activate()

  const first = controller.run(profile('A'))
  const latest = controller.run(profile('A'))
  pending[1].resolve(success('latest'))
  await latest
  assert.deepEqual(controller.getSnapshot(), { profileId: 'A', testing: false, result: success('latest') })

  pending[0].resolve(success('stale'))
  await first
  assert.deepEqual(controller.getSnapshot(), { profileId: 'A', testing: false, result: success('latest') })
})

test('ConnectionTestController invalidates requests across profile configuration edits and deletion', async () => {
  const pending: Array<{ requestProfile: LlmProfileDraft; response: Deferred<TestConnectionResult> }> = []
  const controller = new ConnectionTestController({
    testLlm(requestProfile) {
      const response = deferred<TestConnectionResult>()
      pending.push({ requestProfile, response })
      return response.promise
    }
  })
  controller.activate()
  const original = profile('A')
  const editing = controller.run(original)
  original.baseUrl = 'https://edited.invalid/v2'
  original.apiKey = 'synthetic-edited-secret'
  original.model = 'edited-model'
  controller.invalidate()
  assert.equal(pending[0].requestProfile.baseUrl, 'https://example.invalid/v1', 'the request receives a profile snapshot')
  assert.equal(pending[0].requestProfile.apiKey, 'synthetic-A-secret')

  const edited = controller.run(profile('A', {
    baseUrl: 'https://edited.invalid/v2',
    apiKey: 'synthetic-edited-secret',
    model: 'edited-model'
  }))
  pending[0].response.resolve(success('old configuration'))
  await editing
  assert.deepEqual(controller.getSnapshot(), { profileId: 'A', testing: true, result: null })
  pending[1].response.resolve(success('edited configuration'))
  await edited
  assert.deepEqual(controller.getSnapshot(), { profileId: 'A', testing: false, result: success('edited configuration') })

  const deleting = controller.run(profile('A'))
  controller.invalidate()
  assert.deepEqual(controller.getSnapshot(), { profileId: null, testing: false, result: null })
  const empty = controller.run(profile('B'))
  pending[2].response.resolve(success('deleted profile'))
  await deleting
  assert.deepEqual(controller.getSnapshot(), { profileId: 'B', testing: true, result: null })
  pending[3].response.resolve(success('new profile'))
  await empty
  assert.deepEqual(controller.getSnapshot(), { profileId: 'B', testing: false, result: success('new profile') })
})

test('ConnectionTestController reports controlled failures and maps IPC rejections to a static safe message', async () => {
  const businessFailure = { ok: false, message: '服务返回的受控提示' }
  const failureResponse = deferred<TestConnectionResult>()
  const rejectionResponse = deferred<TestConnectionResult>()
  let call = 0
  const controller = new ConnectionTestController({
    testLlm() {
      call++
      return call === 1 ? failureResponse.promise : rejectionResponse.promise
    }
  })
  controller.activate()

  const businessRun = controller.run(profile('A'))
  failureResponse.resolve(businessFailure)
  await businessRun
  assert.deepEqual(controller.getSnapshot(), { profileId: 'A', testing: false, result: businessFailure })

  const rejectRun = controller.run(profile('A'))
  rejectionResponse.reject(new Error('upstream raw details synthetic-A-secret'))
  await rejectRun
  assert.deepEqual(controller.getSnapshot(), {
    profileId: 'A',
    testing: false,
    result: { ok: false, message: '连接测试失败，请稍后重试。' }
  })
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('synthetic-A-secret'), false)
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('upstream raw details'), false)
})

test('ConnectionTestController suppresses disposed work across reactivation and accepts a fresh request', async () => {
  const pending: Array<Deferred<TestConnectionResult>> = []
  const controller = new ConnectionTestController({
    testLlm() {
      const response = deferred<TestConnectionResult>()
      pending.push(response)
      return response.promise
    }
  })
  controller.activate()
  const oldRun = controller.run(profile('A'))
  controller.dispose()
  assert.deepEqual(controller.getSnapshot(), { profileId: null, testing: false, result: null })

  controller.activate()
  const newRun = controller.run(profile('B'))
  pending[0].resolve(success('disposed response'))
  await oldRun
  assert.deepEqual(controller.getSnapshot(), { profileId: 'B', testing: true, result: null })
  pending[1].resolve(success('fresh response'))
  await newRun
  assert.deepEqual(controller.getSnapshot(), { profileId: 'B', testing: false, result: success('fresh response') })
})

test('ConnectionTestController displays the current request result and returns to idle after invalidation', async () => {
  const response = deferred<TestConnectionResult>()
  const controller = new ConnectionTestController({ testLlm: () => response.promise })
  controller.activate()
  const run = controller.run(profile('A'))
  assert.deepEqual(controller.getSnapshot(), { profileId: 'A', testing: true, result: null })
  response.resolve(success('current request'))
  await run
  assert.deepEqual(controller.getSnapshot(), { profileId: 'A', testing: false, result: success('current request') })
  controller.invalidate()
  assert.deepEqual(controller.getSnapshot(), { profileId: null, testing: false, result: null })
})
