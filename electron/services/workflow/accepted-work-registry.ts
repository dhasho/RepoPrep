import { AsyncLocalStorage } from 'node:async_hooks'

type Awaitable<T> = T | PromiseLike<T>

export interface AcceptedWorkRegistry {
  createIssuer(label: string): AcceptedWorkIssuer
  seal(): void
  drain(): Promise<void>
  snapshot(): Readonly<{ sealed: boolean; pending: number }>
}

export interface AcceptedWorkIssuer {
  run<T>(
    start: (scope: SettlementScope) => Awaitable<T>,
    options?: Readonly<{ settlementSlots?: number }>
  ): Promise<T>
}

export interface SettlementScope {
  trackSettlement<T>(start: () => Awaitable<T>): Promise<T>
}

type RegistryErrorCode =
  | 'accepted-work-sealed'
  | 'accepted-work-invalid-label'
  | 'accepted-work-invalid-start'
  | 'accepted-work-invalid-options'
  | 'accepted-work-scope-inactive'
  | 'accepted-work-settlement-exhausted'
  | 'accepted-work-not-sealed'
  | 'accepted-work-self-wait'

class AcceptedWorkRegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode) {
    super(code)
    this.name = 'AcceptedWorkRegistryError'
    this.code = code
  }
}

interface Lease {
  active: boolean
}

/** Only the optional own data property is read; caller accessors are not invoked. */
function settlementSlots(options: Readonly<{ settlementSlots?: number }> | undefined): number {
  if (options === undefined) return 0
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw undefined
    const descriptor = Object.getOwnPropertyDescriptor(options, 'settlementSlots')
    if (descriptor && !('value' in descriptor)) throw undefined
    const slots: unknown = descriptor?.value
    if (slots === undefined) return 0
    if (typeof slots !== 'number' || !Number.isSafeInteger(slots) || slots < 0) throw undefined
    return slots
  } catch {
    throw new AcceptedWorkRegistryError('accepted-work-invalid-options')
  }
}

/**
 * Tracks admitted promises in memory. Sealing covers only this registry's issuers;
 * draining proves settlement, never successful I/O, native ownership or a terminal.
 */
export function createAcceptedWorkRegistry(): AcceptedWorkRegistry {
  const execution = new AsyncLocalStorage<Lease>()
  const pending = new Set<Lease>()
  let sealed = false
  let resolveDrain!: () => void
  // Keep one promise, but do not resolve it until the gate is sealed and empty.
  const drained = new Promise<void>(resolve => { resolveDrain = resolve })

  const finish = (lease: Lease): void => {
    // Invalidate saved scope methods before removing the parent's own lease.
    lease.active = false
    pending.delete(lease)
    if (sealed && pending.size === 0) resolveDrain()
  }

  const admit = <T>(start: (lease: Lease) => Awaitable<T>): Promise<T> => {
    const lease: Lease = { active: true }
    pending.add(lease)
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason: unknown) => void
    const result = new Promise<T>((done, fail) => { resolve = done; reject = fail })

    execution.run(lease, () => {
      // Observe settlement before callers can attach their own continuations.
      // Both rejection and fulfillment use the same cleanup, without changing
      // the result or exposing a caller-controlled release operation.
      void result.then(() => finish(lease), () => finish(lease))
      try {
        const outcome = start(lease)
        if (outcome === drained) {
          reject(new AcceptedWorkRegistryError('accepted-work-self-wait'))
        } else {
          // Native resolution reads then getters and schedules thenable jobs in
          // this execution context; asynchronous descendants inherit it too.
          resolve(outcome)
        }
      } catch (error) {
        reject(error)
      }
    })
    return result
  }

  return Object.freeze({
    createIssuer(label: string): AcceptedWorkIssuer {
      if (sealed) throw new AcceptedWorkRegistryError('accepted-work-sealed')
      if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(label)) {
        throw new AcceptedWorkRegistryError('accepted-work-invalid-label')
      }
      return Object.freeze({
        run<T>(start: (scope: SettlementScope) => Awaitable<T>, options?: Readonly<{ settlementSlots?: number }>): Promise<T> {
          if (sealed) return Promise.reject(new AcceptedWorkRegistryError('accepted-work-sealed'))
          if (typeof start !== 'function') return Promise.reject(new AcceptedWorkRegistryError('accepted-work-invalid-start'))
          let remaining: number
          try { remaining = settlementSlots(options) } catch (error) { return Promise.reject(error) }
          // A Proxy descriptor trap can reenter seal while validating options.
          if (sealed) return Promise.reject(new AcceptedWorkRegistryError('accepted-work-sealed'))
          return admit(parent => {
            const scope: SettlementScope = Object.freeze({
              trackSettlement<T>(child: () => Awaitable<T>): Promise<T> {
                if (!parent.active) return Promise.reject(new AcceptedWorkRegistryError('accepted-work-scope-inactive'))
                if (remaining === 0) return Promise.reject(new AcceptedWorkRegistryError('accepted-work-settlement-exhausted'))
                if (typeof child !== 'function') return Promise.reject(new AcceptedWorkRegistryError('accepted-work-invalid-start'))
                remaining -= 1
                return admit(() => child())
              }
            })
            return start(scope)
          })
        }
      })
    },
    seal(): void {
      sealed = true
      if (pending.size === 0) resolveDrain()
    },
    drain(): Promise<void> {
      // Check before returning even an existing shared promise. A stale
      // descendant retains its context but no longer owns an active lease.
      if (execution.getStore()?.active) return Promise.reject(new AcceptedWorkRegistryError('accepted-work-self-wait'))
      if (!sealed) return Promise.reject(new AcceptedWorkRegistryError('accepted-work-not-sealed'))
      return drained
    },
    snapshot(): Readonly<{ sealed: boolean; pending: number }> {
      return Object.freeze({ sealed, pending: pending.size })
    }
  })
}
