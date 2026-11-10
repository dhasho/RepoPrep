# P5/M09 semantic review and targeted revision

Date: 2026-11-10. Status: implementation contract accepted after the original M08 gate passed. Online semantic review remains disabled until the M09 calibration and repair gates pass. This ADR does not itself start a provider experiment or authorize a release/default switch.

## Prerequisite and scope

The immutable writer-v5 source 05607b9678a0a48ab545d44a0dd7f830695d5272 completed all 48 cells. Fresh full independent review and adjudication give 11/1800 candidate material errors versus 25/1800 control, topic value 4.46125 versus 4.41375, zero unpacked citations and complete generation usage. M08 real artifact verification exited 0 on 2026-11-10 (report 0bed1788-a5a5-4b47-890b-41b601db1dc5). This is development-synthetic fixed-evidence component evidence; M13 unseen-repository/release evidence remains outstanding. The earlier writer-v4 quality failure and all receipts stay intact.

No renderer, page, style, asset, resource, public IPC, preload, saved setting or InterviewResult shape change belongs to P5. Add main-process in-memory services and isolated evaluation. Persistence versions belong to P6. The existing generator format repair remains distinct from semantic review/revision.

## Module S: source authority and question patch contracts

Files: workflow/question-source.ts, workflow/question-patch.ts and focused tests; narrowly reviewed additions to question-evidence.ts and evidence-generation.ts. Export the existing fingerprintQuestion implementation without changing its canonical bytes. Preserve every existing M08 signature and behavior; adding an optional service method must not change generator messages or measured writer output.

A production question source is a process-issued capability, backed by a private WeakMap, not a deserializable sidecar. An authority is captured with one RunSpec, its original BudgetLedger, authorized snapshot and issued evidence store. Only the generation adapter owns the recording closure. Register the actual immutable PackedContext at guarded dispatch, then require a completed dispatch and settled complete ledger receipt before issuing a capability for a finalized, fingerprint-matching question/evidence binding. Join request ID, exact request hash, manifest hash, run/project/snapshot IDs and issued packed evidence IDs; reject fabricated objects, metadata-only claims, pending/failed/unknown dispatch, cross-run objects and stale question content. Check current authorized snapshot and cancellation before and after asynchronous work. Do not accept a capability copied through JSON or structuredClone. Public descriptions are bounded metadata without source, credentials or prompts. A capability proves dispatch/source binding only and must never assert factual correctness.

Expose one small typed authority/description interface for downstream reviewer/revision use. The implementation must document the final exported signatures in this ADR before integration. For evaluation candidates, provide a separately named, explicit frozen-input origin: the imported answer is unverified dataset input, not a previously paid/generated question. Reconstruct its evidence through the real snapshot/store/packer and record that origin; never invent a completed generation or provider receipt to satisfy production authority. Real review dispatch still requires the same exact message guards and receipts. Keep imported-input issuance out of the ordinary generation adapter.

Per-question patch normalization accepts only title/question/answer/followUps plus evidence IDs and bounded glossary additions in an outer proposal. Program retains the original question ID. Reuse existing normalization semantics and bounds; reject empty or silently dropped content. A pure prospective-result validator preserves all other questions/sections/identities, checks the shared granularity budget, IDs, normalized duplicate keys, result contract and glossary marker coverage, and returns an immutable new result only when the entire replacement is valid. It must not generate an artificial full InterviewResult for a one-question evaluation unit. No mutation or persistence occurs here.

## Module R: rules and semantic reviewer

Files: workflow/question-review.ts and tests. Depends on S. Inputs are an issued source capability, the current question, captured RunSpec/profile, original ledger, current snapshot/store, signal and existing ModelGateway/M07 packer. The reviewer must not create a fresh production ledger or trust caller-serialized metadata.

Pure rule failures are separate from model findings. Required rules cover question identity/fingerprint/structure, issued capability/run/snapshot membership, completed source dispatch and evidence membership. Return static rule codes, not model-supplied statuses.

For each model review, send only a fresh opaque unit ID, bounded question/answer/follow-up tree and freshly packed actual source. Do not include author labels, original sample IDs, private grading keys, expected facts, hidden repository facts or the generator's topic-card verdict. Render source as untrusted data. Freeze exact messages and guard them at dispatch with current snapshot, source capability, fingerprint and ledger checks. Keep the private profile in a captured closure. Metadata trace never stores raw source, prompts, assessment reasons, credentials or hidden reasoning.

Model response schema (no extra keys): {assessment, findings}. assessment is no-material-risk | material-risk | uncertain. At most 8 findings, each {kind, path, evidenceIds, reason}; kind is contradiction | unsupported-claim | missing-condition | low-value. path is answer or a concrete existing followUps.<index>[.followUps.<index>...].answer with depth at most 2. evidenceIds is 1..16 unique IDs actually included in this review request; reason is nonempty text of at most 500 characters. no-material-risk requires no findings; material-risk requires at least one finding; uncertain is never promoted to verified. The program supplies opaque finding IDs and signed run/source/question/request bindings after validation.

Outcome statuses: assessed | incomplete | not-run-budget. An assessed sidecar remains model-assessed-unverified. Incomplete reasons use bounded static codes for cancellation, stale state, malformed output, missing usage, timeout, model failure or exhausted budget. At most one format retry, reusing the same ledger and source guards. Never retry an unknown receipt. Explicit per-call review ceiling is 4096 output tokens; callers may tighten it and actual dispatch is also limited by RunSpec/profile and remaining capacity. This is a service maximum, not a new allowance.

## Module V: targeted revision

Files: workflow/question-revision.ts and tests. Depends on S/R. Only program-issued material-risk findings for the current question/fingerprint/source capability can authorize one revision proposal. At most one revision plus one format retry; explicit output ceiling 8192, further constrained by the same RunSpec/ledger/profile. Semantic operation metadata says semantic-review, semantic-review-format, semantic-revision or semantic-revision-format while the underlying ledger uses existing review/repair stages.

Model proposal (no extra keys): {question, evidenceIds, glossary}; question has title/question/answer/followUps and no IDs. New evidence IDs must be among actual repair-request packed sources; no new tool commands or budget/policy/identity fields are accepted. An optional bounded read-only investigation can be requested only through the existing investigator and ledger, never by executing model text. P5's first evaluator uses fixed supplied evidence; it does not pretend to validate an additional investigation loop.

Normalize with S, bind the new question to the completed actual revision dispatch, and validate the whole prospective result. Atomic replacement happens only after the latest-request fence/current fingerprint/cancellation/snapshot checks still pass. Preserve before/after fingerprints, original ID, accepted finding IDs and actual dispatch provenance; invalidate the prior semantic assessment. Any failure leaves the original result intact. An unchanged proposal is not a successful repair. Imported evaluation units use the dedicated single-question validation path without inventing unrelated questions.

## Module E: isolated evaluation and gate

Public implementation inputs are review-set.json, repair-set.json, project source and schemas. review-key.json, repair-key.json, label prose and private holdout facts never enter implementer/model prompts. A separate scoring adapter may load private keys after freezing outputs; runtime imports candidates with opaque shuffled IDs and retains the private mapping separately. Bind original asset hashes and current source/profile/configuration/reference. The dataset answerFingerprint remains distinct from the production question fingerprint.

M09 thresholds remain all 40 wrong + 40 correct reviewed, recall >= .85 and false-positive rate <= .10, plus all 20 independent repair samples, at least 14 correct repairs and zero introduced material errors; budget compliance and complete receipts are required. Uncertain/missing observations remain explicit incomplete. Repair correctness requires fresh independent blinded source judgments, not keyword matching or the production reviewer grading itself.

Before any provider call freeze one exact aggregate authorization and per-case budget plan, claim and durable admission journal. Proposed maximum: 240 requests, 1600000 aggregate input admission and 1200000 aggregate output; each review case <=2 requests and each repair case <=4, with original per-run 5/14, 128000 input/65536 output and 600-second ceilings preserved. This is a proposed upper bound, not an executable grant. Review service caps 4096 and revision caps 8192 apply below those ceilings. Unknown usage is charged at full reservation and stops new dispatch. M08/M06 funds are never reused or reset. Read the user's updated saved API profile only in the native main-process runtime, capture it once and bind it afresh; never print credentials, alter saved settings, use retired credentials, or reuse an old-profile quality comparison.

## Delivery and checks

Root owns architecture, contracts, integration and final review. Implement S, then R/V/E in isolated worktrees using the user's requested implementation agent when available. Each module delivers focused adversarial tests (forgery, unknown usage, stale snapshot/fingerprint, cancellation, duplicate/conflicting replacement and late completion as applicable). Required integration checks: typecheck, test:agentic, test:question-budget and affected security/recovery checks. Register new tests in the existing agentic entry point. Synthetic checks establish mechanism only; M09 stays incomplete until the full real gate and independent repair judgments pass. Keep static default, existing UI and legacy data unchanged. Record all actual invocation provenance and unavailable service usage honestly.

## Module S exported contract (implemented)

`fingerprintQuestion(question: QuestionItem): string` is now exported from `question-evidence.ts`; its original canonical serialization and bounds are unchanged. It intentionally excludes the program-owned question ID.

`question-source.ts` exports the following main-process-only contracts:

```ts
interface QuestionSourceAuthorityInput {
  readonly spec: RunSpec
  readonly ledger: BudgetLedger
  readonly snapshot: WorkflowProjectSnapshot
  readonly store: WorkflowEvidenceStore
  readonly signal: AbortSignal
}
interface QuestionSourceAuthority extends QuestionSourceAuthorityInput {
  describe(source: unknown, question: QuestionItem): QuestionSourceDescription
  assertCurrent(source: unknown, question: QuestionItem, signal?: AbortSignal): Promise<QuestionSourceDescription>
}
interface QuestionSourceCapability { readonly kind: 'question-source' }
type QuestionSourceOrigin = 'completed-generation' | 'frozen-evaluation-input'
interface QuestionSourceDescription {
  readonly version: 1
  readonly origin: QuestionSourceOrigin
  readonly verification: 'source-bound-unverified' | 'imported-input-unverified'
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly questionId: string
  readonly questionFingerprint: string
  readonly requestId: string | null
  readonly requestHash: string
  readonly manifestHash: string
  readonly evidenceIds: readonly string[]
}
function assertQuestionSourceAuthority(value: unknown): asserts value is QuestionSourceAuthority
interface FrozenEvaluationQuestionSourceInput extends QuestionSourceAuthorityInput {
  readonly question: QuestionItem
  readonly glossary: Readonly<Record<string, string>>
  readonly evidence: readonly Readonly<{ fileId: string; range: LineRange }>[]
}
function createFrozenEvaluationQuestionSource(input: FrozenEvaluationQuestionSourceInput): Promise<Readonly<{
  authority: QuestionSourceAuthority
  source: QuestionSourceCapability
  question: QuestionItem
  glossary: Readonly<Record<string, string>>
}>>
```

Consumers first call `assertQuestionSourceAuthority` on the authority itself, then reuse its exact captured references and call `assertCurrent` before and after asynchronous work. `describe` is a synchronous membership/fingerprint/receipt check and metadata view; fresh filesystem authorization requires `assertCurrent`. Copied authorities and copied/serialized capabilities are rejected. A description contains only bounded IDs, hashes and origin/verification metadata. Neither origin claims factual correctness.

`EvidenceGenerationAdapter` retains all existing methods and adds `readonly sourceAuthority: QuestionSourceAuthority` plus `sourceFor(question: QuestionItem): Promise<QuestionSourceCapability>`. `sourceFor` only issues after the existing `finalize` has succeeded. The recorder is retained inside the generation adapter; its internal bootstrap requires an adapter-owned non-exported token, checked through a read-only identity predicate. No public authority method can register, complete or import production dispatches. The separately named frozen evaluation factory reads the authorized snapshot, verifies snapshot-owned reads, issues evidence through its store and runs the real packer. Each read reserves a program-generated unique ledger ID before I/O and settles the returned `consumedBytes` (including zero for cache hits); failed attempted reads retain their reservation. Imported answers remain unverified and have `requestId: null`; the factory does not dispatch a model or fabricate a provider/generation receipt.

`question-patch.ts` exports:

```ts
interface NormalizedQuestionPatch {
  readonly question: QuestionItem
  readonly evidenceIds: readonly string[]
  readonly glossary: Readonly<Record<string, string>>
}
function normalizeQuestionPatch(proposal: unknown, original: QuestionItem, allowedEvidenceIds: readonly string[]): NormalizedQuestionPatch
interface QuestionReplacementInput {
  readonly result: InterviewResult
  readonly questionId: string
  readonly expectedFingerprint: string
  readonly proposal: unknown
  readonly allowedEvidenceIds: readonly string[]
}
interface QuestionReplacement {
  readonly result: InterviewResult
  readonly question: QuestionItem
  readonly evidenceIds: readonly string[]
  readonly beforeFingerprint: string
  readonly afterFingerprint: string
}
function validateQuestionReplacement(input: QuestionReplacementInput): QuestionReplacement
function validateSingleQuestionEvaluationInput(question: QuestionItem, glossary: Readonly<Record<string, string>>): Readonly<{
  question: QuestionItem
  glossary: Readonly<Record<string, string>>
}>
interface SingleQuestionReplacementInput {
  readonly question: QuestionItem
  readonly glossary: Readonly<Record<string, string>>
  readonly expectedFingerprint: string
  readonly proposal: unknown
  readonly allowedEvidenceIds: readonly string[]
}
interface SingleQuestionReplacement {
  readonly question: QuestionItem
  readonly glossary: Readonly<Record<string, string>>
  readonly evidenceIds: readonly string[]
  readonly beforeFingerprint: string
  readonly afterFingerprint: string
}
function validateSingleQuestionReplacement(input: SingleQuestionReplacementInput): SingleQuestionReplacement
```

Patch proposals have exactly `{question, evidenceIds, glossary}`. Their question has only optional `title` and required `question`, `answer`, `followUps`; the original ID is supplied by the program. Follow-up depth remains the generator's two levels, and strict validation prevents the existing normalizer from dropping supplied content. New glossary entries are limited to 64, evidence references to 16 distinct actually packed IDs, and total patch content to 256,000 characters; existing result-contract bounds still apply. Whole-result replacement checks the shared granularity range, all section/question IDs, normalized primary-question duplicates, all glossary markers and the result contract, then returns a detached frozen result. It never mutates or freezes caller-owned input and preserves existing unrelated values. The single-question evaluation functions validate an actual unit directly and do not manufacture a full result.

The generation adapter keeps the M07 `dispatchGuard` synchronous, pure and repeatable at admission, intent and receipt fences. Its actual transport's prefetch hook performs outer `beforeRequest` admission, snapshot checks after asynchronous work, gateway `beforeRequest` admission, further snapshot/exact-message checks, one source registration, request notification and the final guard. Synchronous hooks retain a synchronous path; Promise hooks return the entire admission chain for the transport/LLM to await. A transport that drops this Promise cannot register a late source and does not leak an unhandled rejection. End-to-end native asynchronous admission requires the companion LLM await support; M08 prompt bytes, writer version and metadata sidecar are unchanged.


Internal cross-module exports are capability-gated and are not downstream authoring APIs:

```ts
// evidence-generation.ts: read-only membership predicate; owner tokens are never exposed.
function ownsGenerationSourceRecorder(owner: unknown, input: QuestionSourceAuthorityInput): boolean
// question-source.ts: construction fails without that exact adapter-owned token and captured references.
function createGenerationQuestionSourceRecorder(input: QuestionSourceAuthorityInput, owner: unknown): Readonly<{
  authority: QuestionSourceAuthority
  recordDispatch(requestId: string, packet: PackedContext, stage: ModelStage): void
  completeDispatch(requestId: string): void
  failDispatch(requestId: string): void
  capture(requestId: string, question: QuestionItem, evidenceIds: readonly string[]): void
  finalize(sidecar: QuestionEvidenceSidecar): void
  sourceFor(question: QuestionItem): Promise<QuestionSourceCapability>
}>
```

Follow-up and evidence-ID arrays at the unknown patch boundary require the standard array prototype, continuous own enumerable data elements, bounded length and no extra/symbol/accessor properties. Validation rejects array accessors without executing them.
