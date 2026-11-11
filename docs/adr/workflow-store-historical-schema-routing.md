# Historical workflow-store schema routing

Date: 2026-11-11. Status: B03b2a implementation proposal; root review and integration pending.

## Contract

`WorkflowStoreOptions.validators` remains the single current write validator for each configured component kind. An optional `historicalValidators?: Readonly<Partial<Record<WorkflowComponentKind, readonly WorkflowComponentValidator[]>>>` supplies one through eight exact historical schema IDs per kind. Historical kinds require a current validator, and IDs must be unique within a kind, including its current ID. IDs are opaque labels; prefixes and version ordering grant no authority.

The store captures option data, limits, maps, arrays, schema IDs and callback references synchronously before acquiring the writer. It rejects unknown properties/kinds, accessors, proxies, sparse or custom arrays, duplicate IDs and async/generator validator callbacks. Capturing a callback reference cannot freeze state enclosed by that callback; main-program validators must remain deterministic.

A historical decoder is used only on a matching stored ID while verifying components, journals and owner carry-forward. A missing ID, thrown callback, false, nonboolean or promise result fails closed. A failing matching decoder never falls through to another validator. Current publication and journal appends always use the current validator and its exact ID. Historical recorded-visible-response payloads also need the genuine main-program visible payload policy, returning synchronous boolean true.

## Run consistency and resume

Verification walks every journal record, every manifest ancestor and their referenced components across attempt ancestry. The first observed record for each kind pins that kind's schema ID; any other ID for that kind makes the whole run unavailable even when both IDs have registered decoders and their file hashes are valid. Current-view components alone cannot erase an ancestor's schema selection. Every inherited manifest and journal head must also occur, with its exact reference, in the verified chains; a later attempt cannot reset a chain to hide its prior schemas.

Before issuing a resumed attempt or performing publication/append, every schema selected by the run must equal that kind's current write ID. A mismatch rejects with unavailable before a marker, payload builder or payload write. Historical runs remain readable and can be carried to a new owner; a new logical run can use current schemas. Resuming an old run requires its selected schemas to remain the configured current writers. There is no upgrade, downgrade, relabelling, budget reset or implicit migration.

The unchanged disk format has no declaration of a complete schema set before records exist. Selection therefore occurs independently when each kind first appears. This API does not invent schema authority for a kind absent from the run. Cross-kind compatibility remains the caller's explicit semantic contract.

## Remaining host integration boundary

Exact ID routing is a storage prerequisite, not complete original-host compatibility. The existing workflow-ledger-journal validators(prepared) registers workflow-ledger-state-v1 with validateLedgerState(prepared.spec, payload). A historical terminal ledger for a different RunSpec can therefore fail under the same schema ID when an owner opens all prior prefixes in a shared root. This change deliberately does not weaken that validator or introduce an accept-all historical decoder.

A later host design must establish exact original-spec binding for historical validation, or adopt a separately reviewed self-contained ledger schema. This API does not pass stored binding context to validator callbacks, infer a RunSpec from schema labels, or claim to solve that host boundary.

## Scope and evidence

Outer workflow-store/v1 formats, default validators supplied by existing callers, limits, fencing, immutable publication and acknowledgement timing remain unchanged. This adds no critical V2 format, generation behavior, journal host, runtime registration, provider call, UI or product-default change. Existing V1-only callers need no historical configuration.

The focused workflow-store-schema-routing.test.ts suite uses real Windows ownership and immutable files with synthetic payloads. It covers exact old/current carry, current-only writes, blocked upgrade/downgrade, captured configuration, preflight rejection without traps/effects, strict synchronous decoder results, visible payload policy, hash-valid mixed schema ancestry and schema selections omitted from the latest manifest. Tests use no spawned worker, Electron, provider, keys or sealed measurements. Local results and source hashes are retained under .validation/b03b2a; they establish only this storage routing boundary, not full M09/M10/M11 completion or power-loss guarantees.
