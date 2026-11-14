# Durable transport actual settlement

Date: 2026-11-11. Scope: the in-process L2 request completion barrier.

Durable model admission opts the production LLM transport into actual settlement through the private main-process `CallOptions.awaitActualSettlement` Boolean. The option selects stronger waiting semantics; it proves neither W ownership nor paid authority, and custom transports remain accounting-only seams.

A request-local tracker registers an operation before invoking admission, delta, observational callbacks or body/reader cancellation. It normalizes the returned thenable once, attaches both settlement handlers immediately and keeps its original settlement separate from the caller-facing abort race. Cancellation still closes fetch/callback admission through the existing signals and fences. Before the outer request settles, cleanup is registered, local issuance is sealed and all accepted operations settle. A callback or cancel operation that never settles intentionally keeps the durable request pending. One body is cancelled at most once across abort, reader-finally and response-finally paths.

The gateway enables this transport mode with durable admission and separately tracks its admission, trace, invalid async dispatch guard and final held-back delta callbacks. Original receipt/unknown persistence and L settlement remain awaited. Accepted trace work settles before the final source/configuration/signal/deadline checks; diagnostic failures and cleanup errors do not replace the primary result or finite failure. Ordinary callers retain their responsive abort race and detached diagnostic waiting, with rejection observers.

The local tracker is separate from workflow accepted-work authority so the LLM service has no service-to-workflow dependency. It cannot create run/source/operation capabilities, terminal records or recovery authority. A future genuine owner must still bind production transport, register stage/read/tool/I/O issuance and provide the B0 terminal protocol. No provider evaluation, native invocation, UI or default behavior is enabled by this change.
