# B0a: accepted-work registry

Date: 2026-11-11

Status: standalone bookkeeping dependency; not wired to the existing run coordinator.

## Decision and scope

Add `electron/services/workflow/accepted-work-registry.ts` as an in-memory registry of work that a host has already accepted. The module provides admission gates, finite settlement tickets and a shared drain. It does not issue or consume a terminal status, native proof, host attestation, result authenticator or W capability. The existing coordinator, workflow runner and their immediate terminal behavior remain unchanged.

A sealed registry proves that its own issuer gates reject new root work. A completed drain proves that its registered promises have settled. Neither proves successful I/O, revocation of an external issuer, provider cancellation, W exclusion, owner close/reopen, process exit, durable publication or terminal acceptance. The host must register every relevant operation before launching it; an unregistered promise cannot become covered by this module's bookkeeping after the fact.

## API

The only runtime export is `createAcceptedWorkRegistry()`. The exported types are `AcceptedWorkRegistry`, `AcceptedWorkIssuer` and `SettlementScope`.

```ts
interface AcceptedWorkRegistry {
  createIssuer(label: string): AcceptedWorkIssuer
  seal(): void
  drain(): Promise<void>
  snapshot(): Readonly<{ sealed: boolean; pending: number }>
}

interface AcceptedWorkIssuer {
  run<T>(
    start: (scope: SettlementScope) => T | PromiseLike<T>,
    options?: Readonly<{ settlementSlots?: number }>
  ): Promise<T>
}

interface SettlementScope {
  trackSettlement<T>(start: () => T | PromiseLike<T>): Promise<T>
}
```

Registry, issuer, scope and snapshot objects are frozen. Counts, lease activity, ticket balances and execution scopes remain in closure state. Saved methods retain their original registry or parent binding; borrowing a method with a different receiver cannot acquire another parent's tickets or revive an expired scope. Labels are diagnostic identifiers only. Duplicate labels are allowed and share the same registry gate.

## Admission and validation

Root admission first checks the gate, validates the start function and copies the ticket count. It rechecks the gate after option inspection because a Proxy descriptor trap can synchronously reenter `seal()`. A root or child lease is added before its callback is invoked. Admitted callbacks run synchronously, and their values, synchronous throws, rejected promises and thenables all use native Promise resolution followed by the same settlement observer. Callers cannot release leases or decrement counters.

The validation policy is deliberately small for a trusted-main API:

- Labels are primitive strings matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. They are never coerced or included in error messages.
- Start values must have JavaScript type `function`. Errors thrown when invoking a function or callable Proxy remain work failures, with their original rejection reason.
- Options may be absent or a non-null, non-array object. Only the own descriptor for `settlementSlots` is inspected. An accessor descriptor is rejected without invoking its getter; inherited and unrelated properties are ignored without reading them.
- An absent or `undefined` slot value means zero. Other values must be nonnegative safe integers. No string coercion occurs.
- Proxy traps can execute during descriptor inspection; this API is not a sandbox. Trap errors become the fixed internal `accepted-work-invalid-options` error, without their text or cause. Invalid inputs do not invoke the work callback or register a lease.

After sealing, root admission rejects before inspecting options. `createIssuer()` throws synchronously after sealing. `run()` and `trackSettlement()` admission or validation errors return rejected promises. Internal errors have fixed `accepted-work-*` codes and messages; callback rejection reasons are returned only through their work promise and are not copied into diagnostics.

## Settlement tickets and drain

Each admitted root fixes its ticket balance once, with a default of zero. `trackSettlement()` requires its original parent lease to remain active and consumes one ticket before invoking the child. A synchronous child failure still consumes the ticket. Invalid child callback input does not consume a ticket. Children receive no scope or new ticket budget. A saved parent scope can spend only its remaining original finite budget.

`seal()` is synchronous, idempotent and irreversible across all existing issuers and future issuer creation. An already active parent may spend its remaining settlement tickets after sealing. This permits completion of genuine accepted work; it is not permission to issue fresh provider, source, tool or other business operations. The host must compose settlement callbacks accordingly, since a function's name or return value cannot prove its business purpose.

Every actual child has a separate lease. The parent's settlement observer invalidates its scope before removing its own lease, and that observer is installed before callers can attach result continuations. Registered children continue independently if the parent succeeds or fails. There is no parent-to-child zero-count handoff window. Unused tickets expire with the parent and are not themselves work.

`drain()` before sealing rejects. After sealing, every permitted external call returns the exact same Promise, including after it has resolved. Empty state while the gate is open does not resolve that Promise. It resolves only when sealing and settlement of all registered work have both occurred. Rejected work is settled work; drain completion makes no claim about success. Timeout, `Promise.race`, abandoned waiting and a requested cancellation cannot settle or remove work. A never-settling operation keeps drain pending.

## Self-wait detection and limits

A private `AsyncLocalStorage` belongs to each registry. Root and child callback invocation, direct result getter access, thenable jobs created by native assimilation and asynchronous descendants created in those contexts inherit the active lease. `drain()` rejects calls from the registry's own active execution context before returning any shared Promise. Once that lease's settlement observer has run, a stale descendant can call drain normally. Registries are independent: acyclic waits for another registry's drain remain allowed.

There is a second identity check at the callback result boundary. If either a root or child directly returns this registry's saved drain Promise, that work rejects with `accepted-work-self-wait` even if the Promise was obtained in another execution context. This covers the case where an external caller gets drain after sealing and a still-active parent's settlement callback returns that saved Promise without calling `drain()` again.

The module does not inspect native Promise dependency graphs, rewrite Promise prototypes or install a general `async_hooks` graph. A native Promise may already be adopting the drain, or an async function/thenable may hide adoption of a previously obtained drain Promise. For example, resolving a previously returned deferred Promise with the saved drain can form an opaque cycle. Such work remains pending; it does not produce a false successful drain. Cross-work cycles are likewise not solved. Async work launched elsewhere also retains its original execution context; accepting its Promise cannot rewrite its executor or transfer ownership.

Host composition must therefore keep registry drain and final control publication outside the accepted-business-work set. Final publication is a later phase and must never wait as one of its own drain prerequisites. The dynamic self-wait checks are useful diagnostics and guards, not native authority or a general proof of acyclicity.

## Validation

The deterministic focused suite uses only synthetic values, promises, thenables, execution contexts and caller deadlines. It covers synchronous multi-issuer sealing and reentrancy; validation and fixed diagnostics; Promise/thenable failure paths; finite tickets and saved-scope expiry; parent-child handoff and independent failures; stable drain identity; abandoned waiting; root/child/thenable self-waits across awaits; direct saved-drain returns; stale descendants; and independent registries.

Run the focused test and existing coordinator regression with the repository's direct TypeScript runner:

```text
node --experimental-strip-types --import ./tests/register-shared-alias.mjs --test electron/services/workflow/accepted-work-registry.test.ts
node --experimental-strip-types --import ./tests/register-shared-alias.mjs --test electron/services/workflow/run-coordinator.test.ts
```

Also run `tsc --noEmit -p tsconfig.node.json` and `tsc --noEmit -p tsconfig.web.json`, directing incremental metadata into the new validation evidence directory when existing source files must remain frozen. These checks exercise standalone bookkeeping and compatibility; they do not validate native release, providers, real profiles or durable terminal publication.
