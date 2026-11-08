# M08 output rejection diagnostics and repair instructions

Status: implementation plan; no further provider call starts before this work is reviewed.

## Evidence and limits

The frozen writer-v2 candidate `b243ed2` stopped on its first cell after an initial request and one repair. Both receipts are complete: 4,648 input and 17,111 output tokens; four questions were accepted. The stored error is only `execution-failed`. Existing artifacts do not establish whether the cause was JSON syntax, citations, shape or another application check. Do not retrospectively assign a specific cause or rewrite that report.

Source review also establishes two protocol gaps independently of that historical failure: the legacy JSON example has no evidenceIds field, while the adapter requires it; and the adapter currently appends its common guidance to the first user message, ahead of the assistant reply and final user instruction during repair. These gaps do not prove the historical cause.

## Work packages

1. Add a typed, bounded generation-output rejection diagnostic. It contains only a finite reason, attempt/stage, batch index and program-issued request ID when available; at most the two existing format attempts are retained. Distinguish parser syntax, citation validation, normalized structure/checkpoint validation and empty output at the actual rejection boundary. Preserve existing user-facing messages, requests, retry count, streamed prefixes and receipt settlement. The evaluator copies only the allowlisted diagnostic into failed-cell metadata; no model text, source, prompts, keys, arbitrary error messages or stacks are diagnostics. No raw-response recording is introduced.
2. Version the evidence writer as v3 and make the common protocol explicit in the last user message of initial/repair/compensation requests. Repeat the existing remaining quota, require a nonempty evidenceIds string array on each new main question, and state that root/section/follow-up citations do not replace it. IDs must be copied exactly from the provided evidence rows; no placeholder ID is introduced. Preserve the common v2 length guidance, source context, topic-card isolation, unresolved items and prior-question hints. Both conditions receive identical instructions except the topic-card block. Do not change the default static prompt or weaken citation/JSON validation.

Luna implements the packages in separate worktrees; the main agent serially integrates the generator and evaluator contracts. Tests must exercise actual dispatch for a four-message repair, two-attempt rejection classification and receipt retention, safe diagnostic serialization, unchanged static messages, and unchanged hard budgets. No provider call is needed for these checks.

## Accounting and next measurement

M08 has used fifteen requests: fourteen complete receipts totaling 29,575 input and 231,148 output tokens, plus the original one-request unknown reservation of 2,813/32,768. Conservative charged totals are 32,388 input and 263,916 output. The remaining ceiling is 405 requests, 6,111,612 input admission and 2,881,812 output allowance. Per-run, per-request, corpus, repeat count, model/reasoning and quality thresholds remain frozen. All three prior attempts and hashes remain retained; a later complete matrix uses a new source/reference and does not splice earlier results.
