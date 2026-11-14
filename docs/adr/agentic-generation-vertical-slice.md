# P4 generation vertical slice

Status: implementation plan after the M06 real gate passed at `417b576`. This document does not authorize generation-model calls.

## Goal and boundaries

Implement M08 and the in-memory portion of M10: authorized evidence and topic cards produce an existing `InterviewResult` plus a separate question-evidence sidecar. Reuse the existing question quotas, streaming parser, normalization, duplicate exclusion and compensation. Keep the production static default and legacy result/checkpoint formats unchanged. Cross-restart persistence, UI/IPC selection, semantic review and release remain later phases.

M06 passed all forty cells with 39 complete evidence tasks, zero invalid tool executions, a 5.78% repeated-read rate, no cap violations and complete usage for all 86 requests. Its one coverage gap remains in the report. Earlier failed measurements and one historical unknown receipt remain in the cumulative ledger.

## Interfaces and ownership

1. **Generation request seam** (`generator.ts`, new `workflow/generation-request.ts`): a main-process-only optional `GenerationRequestAdapter`. `prepare` receives a program request ID, generation/repair/compensation stage, batch index/label/quota, character/input budgets, signal, and a `buildMessages(contextText)` callback for the current attempt. It returns exact prepared messages and private dispatch metadata. `complete` sends that prepared request, streaming deltas and legacy numeric observers through the shared model gateway. `acceptQuestion` receives the raw fragment and the normalized, newly accepted program-created question ID. No adapter means the existing static path, messages and behavior.

2. **Question evidence registry** (new `workflow/question-evidence.ts`): `createQuestionEvidenceRegistry` registers actual dispatched packed manifests, validates raw `evidenceIds` against that particular request, binds them to accepted program question IDs, and finalizes only IDs surviving the final result. It computes fingerprints from final normalized question content. Sidecar version 1 contains run/project/snapshot identity, question ID/fingerprint, request ID, packed-manifest hash and bounded evidence IDs. Its state is source-bound but semantically unverified. It contains no source payload, prompt, credential or reasoning, and does not populate legacy `sourceEvidence` fields.

3. **Run lifecycle** (new `workflow/run-coordinator.ts`): an in-memory coordinator owns run/project/snapshot identity, monotonic event sequence, cancellation and exactly one terminal state. Stage operations check lifecycle before and after awaits; late results cannot publish a result or release a newer run's ownership. No disk persistence or checkpoint migration is introduced here.

4. **Integration** (new evidence-generation adapter and workflow entry): resolve selected evidence through the issued store, build the legacy batch/context shape without extra source reads, pack complete messages separately for every initial/repair/compensation attempt, and call the model gateway with `makeDispatchGuard`. The generator's final fitting cannot mutate a packet after its manifest was frozen. All model requests share the existing RunSpec ledger. Main-process factories capture the authorized scan/snapshot rather than trusting equivalent-looking caller objects.

The first three independent modules use separate Luna worktrees. The root agent reviews and integrates them, then delegates the concrete adapter/evaluation module once the interfaces exist. Implementers do not read development answer keys or holdout labels.

## Failure and lifecycle rules

An invalid or unpacked model citation cannot become an accepted question. Treat that as a bounded format failure, drain the current request sufficiently to preserve available usage, and charge any repair to the same ledger. A missing usage receipt retains its reservation and stops further dispatch. Packer conflicts, cancellation and budget exhaustion do not produce a successful result. Sidecar finalization discards dropped candidates and rejects missing bindings for surviving evidence-grounded questions.

Legacy checkpoints are not silently reused for an evidence-aware request adapter. Exact recovery waits for the P6 manifest/sidecar design. Static checkpoint and result reading remain unchanged.

## Validation and promotion

Verify default/static equivalence, actual dispatched packet hashes, mutation rejection before fetch, source-ID validation, final question-ID/fingerprint alignment after normalization/dedup/compensation, shared costs for repairs, missing receipts, cancellation and late completion. Run typecheck, relevant question/IPC/recovery suites, security and Electron smoke. A synthetic vertical slice must use actual snapshot/store/packer/generator/gateway components with a synthetic transport; it is not a real quality score.

M08 remains incomplete until its frozen twelve sufficient-evidence tasks are measured for candidate and static control, each twice, with independent scoring and complete provider receipts. Prepare that exact experiment and its budget before requesting separate authorization. The remaining M06 allowance is not authorization for generation experiments.
