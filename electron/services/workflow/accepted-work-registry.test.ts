import assert from 'node:assert/strict'
import { AsyncResource } from 'node:async_hooks'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { createAcceptedWorkRegistry, type SettlementScope } from './accepted-work-registry.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import * as publicModule from './accepted-work-registry.ts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function stillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await nextTurn()
  assert.equal(settled, false, 'accepted work must remain a drain prerequisite')
}

const selfWait = { message: 'accepted-work-self-wait' }

test('public surface is frozen bookkeeping with no terminal or host bootstrap', async () => {
  assert.deepEqual(Object.keys(publicModule), ['createAcceptedWorkRegistry'])
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('receipt:1')
  const initial = registry.snapshot()
  assert.equal(Object.isFrozen(registry), true)
  assert.equal(Object.isFrozen(issuer), true)
  assert.equal(Object.isFrozen(initial), true)
  assert.deepEqual(initial, { sealed: false, pending: 0 })
  let scope!: SettlementScope
  const hold = deferred<void>()
  const root = issuer.run(value => { scope = value; return hold.promise })
  assert.equal(Object.isFrozen(scope), true)
  assert.deepEqual(initial, { sealed: false, pending: 0 }, 'snapshots do not become live state')
  registry.seal()
  hold.resolve(undefined)
  await root
  await registry.drain()
})

test('all issuer gates seal synchronously even during a reentrant root callback', async () => {
  const registry = createAcceptedWorkRegistry()
  const first = registry.createIssuer('first')
  const second = registry.createIssuer('second')
  const hold = deferred<number>()
  let callbackRan = false
  let forbiddenRan = false
  let blocked!: Promise<void>
  const root = first.run(() => {
    callbackRan = true
    assert.deepEqual(registry.snapshot(), { sealed: false, pending: 1 })
    registry.seal()
    registry.seal()
    blocked = second.run(() => { forbiddenRan = true })
    assert.throws(() => registry.createIssuer('third'), { message: 'accepted-work-sealed' })
    return hold.promise
  })
  assert.equal(callbackRan, true, 'admitted callbacks start before run returns')
  await assert.rejects(blocked, { message: 'accepted-work-sealed' })
  await assert.rejects(first.run(() => { forbiddenRan = true }), { message: 'accepted-work-sealed' })
  assert.equal(forbiddenRan, false)
  const drain = registry.drain()
  await stillPending(drain)
  hold.resolve(7)
  assert.equal(await root, 7)
  await drain
})

test('plain results, native promises, throws and rejections all leave a settled drain', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('outcomes')
  const thrown = new Error('synthetic callback failure')
  const rejected = { synthetic: 'rejected reason' }
  const value = issuer.run(() => 4)
  const native = issuer.run(() => Promise.resolve('native'))
  const failed = issuer.run(() => { throw thrown })
  const refusal = issuer.run(() => Promise.reject(rejected))
  registry.seal()
  assert.equal(await value, 4)
  assert.equal(await native, 'native')
  await assert.rejects(failed, error => error === thrown)
  await assert.rejects(refusal, error => error === rejected)
  await registry.drain()
  assert.equal(registry.snapshot().pending, 0)
})

test('then getter and then body see their registered lease and reject self-drain', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('thenable')
  const hold = deferred<string>()
  const checks: Array<Promise<void>> = []
  const root = issuer.run(() => {
    registry.seal()
    return Object.defineProperty({}, 'then', {
      get() {
        assert.equal(registry.snapshot().pending, 1)
        checks.push(assert.rejects(registry.drain(), selfWait))
        return (resolve: (value: Promise<string>) => void) => {
          assert.equal(registry.snapshot().pending, 1)
          checks.push(assert.rejects(registry.drain(), selfWait))
          resolve(hold.promise)
        }
      }
    }) as PromiseLike<string>
  })
  const drain = registry.drain()
  await nextTurn()
  assert.equal(checks.length, 2)
  await Promise.all(checks)
  await stillPending(drain)
  hold.resolve('thenable result')
  assert.equal(await root, 'thenable result')
  await drain
})

test('throwing then getters and then bodies reject work without stranding drain', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('bad-thenable')
  const getterFailure = { source: 'getter' }
  const thenFailure = { source: 'then' }
  const getter = issuer.run(() => Object.defineProperty({}, 'then', {
    get() { assert.equal(registry.snapshot().pending, 1); throw getterFailure }
  }))
  const then = issuer.run(() => ({ then() { throw thenFailure } }) as unknown as PromiseLike<void>)
  registry.seal()
  await assert.rejects(getter, error => error === getterFailure)
  await assert.rejects(then, error => error === thenFailure)
  await registry.drain()
})

test('native thenable assimilation honors first settlement and ignores later throws', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('first-settlement')
  const root = issuer.run(() => ({
    then(resolve: (value: string) => void, reject: (reason: unknown) => void) {
      resolve('first')
      reject(new Error('ignored rejection'))
      resolve('ignored value')
      throw new Error('ignored throw')
    }
  }) as PromiseLike<string>)
  registry.seal()
  assert.equal(await root, 'first')
  await registry.drain()
})

test('invalid starts and options reject without launching work or reading caller accessors', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('validation')
  let launches = 0
  let getters = 0
  const launch = () => { launches += 1 }
  const invalidOptions: unknown[] = [null, 1, 'private text', [], { settlementSlots: -1 },
    { settlementSlots: 0.5 }, { settlementSlots: Infinity }, { settlementSlots: NaN },
    { settlementSlots: Number.MAX_SAFE_INTEGER + 1 }, { settlementSlots: '2' }]
  invalidOptions.push(Object.defineProperty({}, 'settlementSlots', {
    get() { getters += 1; throw new Error('private getter contents') }
  }))
  for (const options of invalidOptions) {
    await assert.rejects(issuer.run(launch, options as never), error => {
      assert.equal((error as Error).message, 'accepted-work-invalid-options')
      assert.equal(String(error).includes('private'), false)
      return true
    })
  }
  await assert.rejects(issuer.run(null as never), { message: 'accepted-work-invalid-start' })
  assert.equal(launches, 0)
  assert.equal(getters, 0)
  assert.equal(registry.snapshot().pending, 0)
  registry.seal()
  await registry.drain()
})

test('option policy ignores inherited and unrelated properties without reading getters', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('own-data-only')
  let getters = 0
  const options = Object.create(Object.defineProperty({}, 'settlementSlots', {
    get() { getters += 1; throw new Error('inherited getter must not execute') }
  }))
  Object.defineProperty(options, 'unrelated', {
    get() { getters += 1; throw new Error('unrelated getter must not execute') }
  })
  const root = issuer.run(async scope => {
    await assert.rejects(scope.trackSettlement(() => undefined), { message: 'accepted-work-settlement-exhausted' })
  }, options)
  registry.seal()
  await root
  await registry.drain()
  assert.equal(getters, 0)
})

test('descriptor trap errors are fixed diagnostics and reentrant seal cannot admit a root', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('proxy-options')
  const trapped = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private trap text') } })
  await assert.rejects(issuer.run(() => assert.fail('invalid options launched'), trapped), {
    message: 'accepted-work-invalid-options'
  })
  const reentrant = new Proxy({}, { getOwnPropertyDescriptor() { registry.seal(); return undefined } })
  await assert.rejects(issuer.run(() => assert.fail('sealed root launched'), reentrant), {
    message: 'accepted-work-sealed'
  })
  await registry.drain()
})

test('sealed admission rejects before inspecting options or invalid labels', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('closed')
  registry.seal()
  const options = new Proxy({}, { getOwnPropertyDescriptor() { assert.fail('sealed options inspected') } })
  await assert.rejects(issuer.run(() => assert.fail('sealed callback'), options), { message: 'accepted-work-sealed' })
  assert.throws(() => registry.createIssuer({ toString() { assert.fail('label coerced') } } as never), {
    message: 'accepted-work-sealed'
  })
  await registry.drain()
})

test('labels are bounded identifiers and duplicate labels do not confer authority', async () => {
  const registry = createAcceptedWorkRegistry()
  for (const label of ['', 'with spaces', 'a'.repeat(129), null, {}]) {
    assert.throws(() => registry.createIssuer(label as never), { message: 'accepted-work-invalid-label' })
  }
  const first = registry.createIssuer('same')
  const second = registry.createIssuer('same')
  assert.equal(await first.run(() => 1), 1)
  registry.seal()
  await assert.rejects(second.run(() => 2), { message: 'accepted-work-sealed' })
  await registry.drain()
})

test('only preallocated settlement tickets remain usable after seal', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('receipt-owner')
  const parentHold = deferred<void>()
  const childHold = deferred<number>()
  let scope!: SettlementScope
  const options = { settlementSlots: 1 }
  const root = issuer.run(value => { scope = value; return parentHold.promise }, options)
  options.settlementSlots = 100
  registry.seal()
  const child = scope.trackSettlement(function () {
    assert.equal(arguments.length, 0, 'children are not issued scopes or new tickets')
    assert.equal(registry.snapshot().pending, 2, 'child is registered before launch')
    return childHold.promise
  })
  await assert.rejects(scope.trackSettlement(() => assert.fail('exhausted child launched')), {
    message: 'accepted-work-settlement-exhausted'
  })
  parentHold.resolve(undefined)
  await root
  const drain = registry.drain()
  await stillPending(drain)
  childHold.resolve(8)
  assert.equal(await child, 8)
  await drain
})

test('synchronous child failure consumes its ticket and cannot replenish admission', async () => {
  const registry = createAcceptedWorkRegistry()
  const hold = deferred<void>()
  let scope!: SettlementScope
  const root = registry.createIssuer('child-failure').run(value => { scope = value; return hold.promise }, { settlementSlots: 1 })
  registry.seal()
  const failure = { synthetic: 'child failure' }
  await assert.rejects(scope.trackSettlement(() => { throw failure }), error => error === failure)
  await assert.rejects(scope.trackSettlement(() => assert.fail('ticket replenished')), {
    message: 'accepted-work-settlement-exhausted'
  })
  await stillPending(registry.drain())
  hold.resolve(undefined)
  await root
  await registry.drain()
})

test('invalid child callback neither launches nor consumes a reserved ticket', async () => {
  const registry = createAcceptedWorkRegistry()
  const hold = deferred<void>()
  let scope!: SettlementScope
  const root = registry.createIssuer('child-validation').run(value => { scope = value; return hold.promise }, { settlementSlots: 1 })
  registry.seal()
  await assert.rejects(scope.trackSettlement(12 as never), { message: 'accepted-work-invalid-start' })
  assert.equal(await scope.trackSettlement(() => 'valid child'), 'valid child')
  hold.resolve(undefined)
  await root
  await registry.drain()
})

test('a reentrant child sees its ticket consumed before its callback starts', async () => {
  const registry = createAcceptedWorkRegistry()
  const hold = deferred<void>()
  let scope!: SettlementScope
  const root = registry.createIssuer('reentrant-child').run(value => { scope = value; return hold.promise }, { settlementSlots: 1 })
  registry.seal()
  const child = scope.trackSettlement(async () => {
    await assert.rejects(scope.trackSettlement(() => assert.fail('reentrant child launched')), {
      message: 'accepted-work-settlement-exhausted'
    })
  })
  await child
  hold.resolve(undefined)
  await root
  await registry.drain()
})

test('parent settlement expires saved methods before caller continuation can start late work', async () => {
  const registry = createAcceptedWorkRegistry()
  let saved!: SettlementScope['trackSettlement']
  const root = registry.createIssuer('scope-expiry').run(scope => {
    saved = scope.trackSettlement
    return Promise.resolve('done')
  }, { settlementSlots: 2 })
  registry.seal()
  await root
  await assert.rejects(saved(() => assert.fail('expired method launched')), { message: 'accepted-work-scope-inactive' })
  await assert.rejects(saved.call({ trackSettlement: saved }, () => assert.fail('borrowed method launched')), {
    message: 'accepted-work-scope-inactive'
  })
  await registry.drain()
})

test('parent-child handoff retains drain even when the parent fails after launching the child', async () => {
  const registry = createAcceptedWorkRegistry()
  const childHold = deferred<void>()
  let child!: Promise<void>
  const failure = new Error('parent failed after accepted child')
  const root = registry.createIssuer('handoff').run(scope => {
    registry.seal()
    child = scope.trackSettlement(() => childHold.promise)
    assert.equal(registry.snapshot().pending, 2)
    throw failure
  }, { settlementSlots: 1 })
  const drain = registry.drain()
  await assert.rejects(root, error => error === failure)
  await stillPending(drain)
  childHold.resolve(undefined)
  await child
  await drain
})

test('an asynchronous child rejection settles independently without changing parent outcome', async () => {
  const registry = createAcceptedWorkRegistry()
  const parentHold = deferred<number>()
  const childHold = deferred<void>()
  let scope!: SettlementScope
  const root = registry.createIssuer('async-child-failure').run(value => { scope = value; return parentHold.promise }, { settlementSlots: 1 })
  registry.seal()
  const child = scope.trackSettlement(() => childHold.promise)
  const failure = new Error('synthetic receipt rejection')
  childHold.reject(failure)
  await assert.rejects(child, error => error === failure)
  await stillPending(registry.drain())
  parentHold.resolve(9)
  assert.equal(await root, 9)
  await registry.drain()
})

test('an empty open registry does not pre-resolve its later shared drain', async () => {
  const registry = createAcceptedWorkRegistry()
  const issuer = registry.createIssuer('later-work')
  await assert.rejects(registry.drain(), { message: 'accepted-work-not-sealed' })
  await nextTurn()
  const hold = deferred<void>()
  const root = issuer.run(() => hold.promise)
  registry.seal()
  const drain = registry.drain()
  assert.equal(registry.drain(), drain)
  await stillPending(drain)
  hold.resolve(undefined)
  await root
  await drain
  assert.equal(registry.drain(), drain, 'the resolved drain identity is retained')
})

test('sealing an empty registry resolves one stable drain promise', async () => {
  const registry = createAcceptedWorkRegistry()
  registry.seal()
  const first = registry.drain()
  registry.seal()
  assert.equal(registry.drain(), first)
  await first
  assert.equal(registry.drain(), first)
})

test('a caller deadline or abandoned wait cannot remove accepted work', async () => {
  const registry = createAcceptedWorkRegistry()
  const hold = deferred<void>()
  const deadline = deferred<'caller-timeout'>()
  const root = registry.createIssuer('long-work').run(() => hold.promise)
  registry.seal()
  const drain = registry.drain()
  const limitedWait = Promise.race([drain.then(() => 'drained' as const), deadline.promise])
  deadline.resolve('caller-timeout')
  assert.equal(await limitedWait, 'caller-timeout')
  await stillPending(drain)
  assert.equal(registry.snapshot().pending, 1)
  hold.resolve(undefined)
  await root
  await drain
})

test('root drain self-wait rejects before the sealed check and before a shared promise return', async () => {
  const registry = createAcceptedWorkRegistry()
  const root = registry.createIssuer('self-root').run(async () => {
    await assert.rejects(registry.drain(), selfWait)
    registry.seal()
    await assert.rejects(registry.drain(), selfWait)
  })
  await root
  await registry.drain()
})

test('root async descendants retain self-wait detection across awaits', async () => {
  const registry = createAcceptedWorkRegistry()
  const root = registry.createIssuer('self-after-await').run(async () => {
    await nextTurn()
    registry.seal()
    await registry.drain()
  })
  await assert.rejects(root, selfWait)
  await registry.drain()
})

test('active child contexts reject drain across awaits even after their parent settles', async () => {
  const registry = createAcceptedWorkRegistry()
  const childHold = deferred<void>()
  let child!: Promise<void>
  const root = registry.createIssuer('self-child').run(scope => {
    child = scope.trackSettlement(async () => {
      await childHold.promise
      await registry.drain()
    })
  }, { settlementSlots: 1 })
  registry.seal()
  const drain = registry.drain()
  await root
  childHold.resolve(undefined)
  await assert.rejects(child, selfWait)
  await drain
})

test('a child directly returning a saved own-drain promise rejects instead of deadlocking', async () => {
  const registry = createAcceptedWorkRegistry()
  const hold = deferred<void>()
  let scope!: SettlementScope
  const root = registry.createIssuer('saved-drain-child').run(value => { scope = value; return hold.promise }, { settlementSlots: 1 })
  registry.seal()
  const savedDrain = registry.drain()
  const child = scope.trackSettlement(() => savedDrain)
  await assert.rejects(child, selfWait)
  await stillPending(savedDrain)
  hold.resolve(undefined)
  await root
  await savedDrain
})

test('a root directly returning own drain obtained from an external context is rejected', async () => {
  const external = new AsyncResource('accepted-work-external-test')
  try {
    const registry = createAcceptedWorkRegistry()
    let savedDrain!: Promise<void>
    const root = registry.createIssuer('saved-drain-root').run(() => {
      registry.seal()
      savedDrain = external.runInAsyncScope(() => registry.drain())
      return savedDrain
    })
    await assert.rejects(root, selfWait)
    assert.equal(registry.drain(), savedDrain)
    await savedDrain
  } finally {
    external.emitDestroy()
  }
})

test('child thenable getters and jobs retain their own active execution context', async () => {
  const registry = createAcceptedWorkRegistry()
  const hold = deferred<void>()
  const checks: Array<Promise<void>> = []
  let scope!: SettlementScope
  const root = registry.createIssuer('child-thenable').run(value => { scope = value; return hold.promise }, { settlementSlots: 1 })
  registry.seal()
  const child = scope.trackSettlement(() => Object.defineProperty({}, 'then', {
    get() {
      checks.push(assert.rejects(registry.drain(), selfWait))
      return (resolve: (value: number) => void) => {
        checks.push(assert.rejects(registry.drain(), selfWait))
        resolve(11)
      }
    }
  }) as PromiseLike<number>)
  assert.equal(await child, 11)
  assert.equal(checks.length, 2)
  await Promise.all(checks)
  hold.resolve(undefined)
  await root
  await registry.drain()
})

test('stale root and child descendants do not falsely self-block after their leases settle', async () => {
  const registry = createAcceptedWorkRegistry()
  let externalDrain!: Promise<void>
  const descendants: Array<Promise<void>> = []
  let child!: Promise<void>
  const root = registry.createIssuer('stale-scopes').run(scope => {
    descendants.push(nextTurn().then(() => {
      assert.equal(registry.drain(), externalDrain)
      return externalDrain
    }))
    child = scope.trackSettlement(() => {
      descendants.push(nextTurn().then(() => {
        assert.equal(registry.drain(), externalDrain)
        return externalDrain
      }))
    })
  }, { settlementSlots: 1 })
  registry.seal()
  externalDrain = registry.drain()
  await root
  await child
  await Promise.all(descendants)
  await externalDrain
})

test('distinct registries can wait for each other when the dependency is acyclic', async () => {
  const first = createAcceptedWorkRegistry()
  const second = createAcceptedWorkRegistry()
  const hold = deferred<number>()
  const secondRoot = second.createIssuer('independent').run(() => hold.promise)
  second.seal()
  const secondDrain = second.drain()
  const firstRoot = first.createIssuer('wait-other-registry').run(() => {
    assert.equal(second.drain(), secondDrain)
    return secondDrain
  })
  first.seal()
  const firstDrain = first.drain()
  await stillPending(firstDrain)
  hold.resolve(5)
  assert.equal(await secondRoot, 5)
  await firstRoot
  await firstDrain
  await secondDrain
})
