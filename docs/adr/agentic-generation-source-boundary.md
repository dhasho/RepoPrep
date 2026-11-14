# Evidence-backed writer source boundaries

Status: writer-v5 correction implemented after a complete failed M08 quality comparison. Full synthetic workflow252/252, existing question-budget126/126 and typecheck passed. No new provider execution or quality pass is established by this document.

## Evidence and limits

Writer-v4 at `78e66e2` completed all48 real fixed-evidence cells with complete usage. Two independent agents reviewed every main and follow-up answer; a third resolved the final1000 disagreements. Candidate material errors were40/1791, exceeding control32/1800. Topic means4.830821/4.837917, zero unpacked citations and complete generation usage do not override that failure. Frozen samples, labels, rubric and acceptance thresholds remain unchanged.

Post-gate development diagnosis inspected the72 final material-error units and their actual source excerpts. Both writers repeatedly inferred missing declarations, methods or state; treated omitted code as evidence of absence; or dropped type, guard, exception and follow-up conditions. The existing system prompt already warns against unsupported claims. A compact clarification at the final shared user-message instruction addresses the specific ambiguity between an incomplete excerpt and a complete relevant scope. This selected error set does not represent all answers, prove that topic cards caused the eight-unit difference, or predict the benefit of the correction. Holdout facts remain unused.

## Decision

Add a short source-boundary paragraph to the evidence-backed writer's common appended instruction and version that writer as v5. Apply it equally to candidate and fixed-evidence static control, on main answers and every follow-up, including format-repair requests. Only code present in the actual request supports observed implementation claims. IDs, topic cards and public objectives do not verify facts. Check relevant declarations/bindings, types, complete guards and call paths when available. When a necessary definition or method is omitted, state what the excerpt shows and keep alternatives conditional; do not turn “not shown here” into “does not exist.” Keep recommendations and assumptions separate from observed behavior and carry the same qualifications into follow-ups.

Keep the current concise word ranges, quota, two-follow-up guidance, JSON/citation fields, grouping, normalization, repair/compensation counts, ledger/deadline, source reads and sidecar meaning. Keep model, temperature and reasoning configuration unchanged. No task IDs, project-specific exception rules, judge adjustments or hidden-key material enter the prompt. The existing topic-card warning remains; it is not promoted to verification. Default legacy static generation and all pages, styles, resources and preload stay unchanged.

Root owns this scope and final review; a GPT-6-Luna agent implements the isolated module. Prompt/transport tests verify both variants and the four-message format-repair path receive the same shared rule without changing source manifests, structural contracts or limits. Such tests establish wiring only, not semantic correctness. Do not use a keyword-based answer checker as quality acceptance.

## Measurement and rollback

A subsequent quality claim needs a new immutable source, complete48-cell matched comparison and fresh independent full review/adjudication under the same original thresholds. Do not reuse the failed cohort's controls or successful prefixes. The original report, judgments and paid accounting remain unchanged.

The old M08 allowance retains291 requests,5,841,417 input admission and893,499 output; that output remainder cannot cover a comparable full run (~1.7M). Any additional bounded allocation must be separately recorded under the user's standing model authorization before execution, with prior usage and the original unknown reservation retained. This ADR itself neither resets nor enlarges the old bound. Missing receipts still stop dispatch and are never automatically repeated.

If the correction does not pass, retain the failed results and leave P5, the product default and release gates unchanged. Reverting the common paragraph/writer version restores writer-v4 behavior; no saved settings or legacy result data are migrated.
