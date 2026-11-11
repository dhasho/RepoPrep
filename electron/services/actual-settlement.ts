import { AsyncLocalStorage } from 'node:async_hooks'

/** Local waiting semantics only; this does not prove ownership or successful I/O. */
export function createActualSettlement() {
  const execution = new AsyncLocalStorage<{ active: boolean }>()
  const pending = new Set<Promise<void>>()
  let sealed = false
  let drained: Promise<void> | undefined

  return Object.freeze({
    capture<T>(invoke: () => T): Readonly<{ value: T; settlement: Promise<Awaited<T>> }> {
      if (sealed) throw new Error('Actual settlement admission is closed.')
      const lease = { active: true }
      let release!: () => void
      // Register before invocation, including synchronous reentrant cleanup.
      const held = new Promise<void>(resolve => { release = () => { lease.active = false; pending.delete(held); resolve() } })
      pending.add(held)
      return execution.run(lease, () => {
        let value: T
        try { value = invoke() } catch (error) { release(); throw error }
        // A fresh native promise normalizes once, even if the returned promise
        // has an unexpected then getter. The abort race only sees this promise.
        const settlement = new Promise<Awaited<T>>(resolve => { resolve(value as Awaited<T> | PromiseLike<Awaited<T>>) })
        void settlement.then(release, release)
        return Object.freeze({ value, settlement })
      })
    },
    sealAndDrain(): Promise<void> {
      if (execution.getStore()?.active) return Promise.reject(new Error('Actual settlement cannot wait for itself.'))
      if (!drained) {
        sealed = true
        // Each held promise is released by the original operation's settlement,
        // never its abort race. Cleanup children must be captured before sealing.
        drained = Promise.all([...pending]).then(() => { execution.disable() })
      }
      return drained
    }
  })
}

export type ActualSettlement = ReturnType<typeof createActualSettlement>
