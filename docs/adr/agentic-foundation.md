# ADR: Agentic evaluation foundation and honest gates

- Status: accepted as preparatory P0/P1 infrastructure; P0 remains incomplete
- Date: 2026-11-06
- Baseline: `9ef10caae918a2b86c27afdd8b19cbe5ad40869c`
- Scope: the frozen numerical standards in `PLAN.md` v1.1 remain authoritative

## Decision

Add a versioned frozen manifest and a fail-closed gate runner before any agentic runtime implementation. `scripts/agentic/manifest.v1.json` records the exact module check IDs, sample counts, thresholds, operational limits, required metrics, and the known missing evaluation assets. The runner executes named assertion functions, binds every new report to SHA-256 hashes of the source tree, frozen configuration, asset inventory, and gate schema, and writes a new immutable report under `.validation/agentic/<runId>/<module>.json`.

Every required check must have a function implementation. A missing check or metric is incomplete; a thrown assertion, unexpected ID, duplicate registration, non-function implementation, hash mismatch, explicit skip, or unknown result is non-passing. A checker cannot set a passing status by returning JSON: the runner derives status from whether the assertion function executes successfully. Reports keep measurements and references to raw test or evaluation outputs. `--mode real` does not substitute synthetic behavior and is blocked for M06, M08, M09, and M13 without a separately supplied authorization reference.

The CLI and extension point are preparatory infrastructure. Module checkers register named assertion functions; absent checks remain missing and exit nonzero. M11 has no executable replayer or persistent trace payload implementation in this work package and cannot pass. The gate harness itself does not claim that a module, dataset, blind review, quality target, or product phase is complete.

## Frozen evaluation requirements

The manifest records all M01–M13 check IDs and metric names from `PLAN.md` §11, including the following fixed acceptance values:

- M01: one valid specification, all 12 named invalid specifications rejected, stable fingerprint, and private fields rejected.
- M02: 8 snapshot/scan fixture classes; unauthorized reads and stale snapshot acceptance are zero; invalidation and text fallback pass.
- M03: 7 evidence cases; invalid evidence acceptance and source payload in trace are zero.
- M04: 5 tools × 6 cases, at least 30 independent checks; unexpected side effects and unsafe error leaks are zero.
- M05: all 12 ledger sequences; overspend admissions, double settlements, and unknown usage treated as zero are zero; generation reserve is protected.
- M06: 20 frozen retrieval tasks, 2 repeats each; evidence-complete task rate ≥0.90, invalid tool execution 0, repeated-read rate ≤0.20, no limit violations, complete usage. Per-task limits: 3 decisions, 8 tool calls, 18,000 input tokens, 6,000 output tokens, 2 MiB read, 180 seconds.
- M07: all 12 packing fixtures; fabricated source accepted, silent required-bundle drops, and budget violations are zero; deterministic replay and dispatched manifest match.
- M08: 12 independently evidence-labeled sufficient-evidence tasks (4 each for Python, JavaScript, TypeScript), two runs per strategy; no citation of unpacked evidence, material error rate no greater than static, topic value no more than 0.2 below static, usage complete.
- M09: all 40 erroneous and 40 correct review samples plus 20 independent repair samples; error recall ≥0.85, false positive rate ≤0.10, at least 14 correct repairs, no introduced material errors, budget compliant.
- M10: 9 lifecycle phases × 3 cancel/crash/late-event checks plus 5 other cases (at least 32); stale writes, duplicate recovery dispatches, and old-data overwrites are zero.
- M11: all 8 trace/replay scenarios; required span coverage and lineage validity are 1, secret leaks and fabricated replay are zero, and deterministic-tools, recorded-model, and real-model replay modes are distinguished.
- M12: both static and agentic strategies run all 8 product journeys; Electron workflow records `WORKFLOW-OK`, exits 0, and removes its fixture; cross-project updates and invalid citation navigation are zero.
- M13: 4 holdout repositories × 3 granularities × 2 strategies × 2 repeats = 48 runs. Material error rate improves by at least 20% relative to static, core fact coverage does not fall, topic value drops by at most 0.2, tokens ≤110% and p95 latency ≤150% of static. If static error rate is zero, candidate error rate must remain zero and coverage must improve by at least 5 percentage points. All safety and budget gates pass.

The report includes per-check results and raw references. Measurement metrics are recorded by checker implementations and must be asserted against the manifest's thresholds; merely recording a metric is not a passing quality result. M13 review requires two blinded reviewers and a third adjudicator for disagreements.

## Dataset freeze status

No retrieval tasks, sufficient-evidence tasks, review labels, repair labels, reviewer identities, or result receipts are present yet. Their inventory entries remain explicitly `not-materialized` with `sha256: null`. Synthetic tests can validate runner mechanics but cannot stand in for hidden holdout tasks, real model results, independent labels, or human review.

The four M13 public repository identities and commit IDs were selected and observed with `git ls-remote` on 2026-11-06 only, without fetching or reading repository source, to preserve them as holdout metadata:

| Language | Repository | Frozen commit |
| --- | --- | --- |
| Python | `encode/httpx` | `b5addb64f0161ff6bfe94c124ef76f6a1fba5254` |
| Python | `pallets/itsdangerous` | `672971d66a2ef9f85151e53283113f33d642dabd` |
| JavaScript | `caolan/async` | `3921e54bd0704157dbea238fdfcc0c3619abde1a` |
| TypeScript | `colinhacks/zod` | `8651451b82b454847ef9d6d8cc533496853a10d8` |

This metadata freeze is not a full dataset freeze: no task files or evidence labels have been created or hashed, and reviewer identities and adjudication records are not available. A scoring method is recorded in `scripts/agentic/assets/review-rubric.v1.json`; no labels are present and no reviewers have been recruited. Source remains unread to protect holdout isolation. No model calls were made. P0 remains open until the full task data, hidden labels, reviewer identities, receipts, and required schemas are actually prepared and hashed as specified in `PLAN.md`.

## Consequences

RunSpec is a main-process contract and does not introduce a new IPC input. Its model identity includes a required SHA-256 endpoint fingerprint; the future gateway must derive it from trusted normalized endpoint configuration and compare it before dispatch. The configuration fingerprint omits run/project/snapshot identity, which remains separate and cannot be replaced by a configuration match. Generation capacity is reserved before setting investigation limits. An experimental aggregate read ceiling of 8 MiB is new, distinct from the existing per-file ceiling from which the value was chosen; it can be tightened and is not connected to the production static reader yet. No runtime budget-enforcement claim is made until M05 exists. PLAN v1.2 records this contract decision without changing the v1.1 quality, sample-count, token, or latency acceptance thresholds.

- The final stdout line is the machine-readable summary; exit status is 0 only for `pass`. `incomplete`, `blocked`, and `failed` are nonzero.
- Every execution creates a fresh report, preserving earlier successes and failures rather than overwriting them.
- A source/config/data/schema fingerprint documents what ran. A caller may provide expected hashes to enforce an exact binding; mismatches fail.
- No new runtime dependency or model call is introduced. The integration adds test:agentic and verify:agentic:m01 through verify:agentic:m13 commands; unavailable modules fail closed. Public repository metadata was observed using the already-authorized `git ls-remote` operation; repository source was not retrieved.
- M01 now has an assertion-backed checker against the actual contract. Complete the missing P0 assets before advancing phases; M11 replay and unrelated modules remain incomplete.

## Alternatives considered

- **Treat a test-runner exit code or fixture status JSON as the module result:** rejected because it would not prove required checks ran and could permit synthetic/declared passes.
- **Mark unavailable samples skipped:** rejected because PLAN §11 says unsupported fixtures and absent required checks remain incomplete rather than pass.
- **Use a synthetic corpus as the holdout:** rejected because it cannot establish real repository retrieval or answer quality, and relabeling it would weaken the fixed acceptance standard.
- **Fetch the public holdout repositories now:** rejected for this asset-freeze task; commit metadata was sufficient to identify the holdout while keeping its source unseen.
