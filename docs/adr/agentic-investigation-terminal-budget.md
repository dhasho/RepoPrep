# Investigation output exhaustion and prompt v2

Status: offline implementation candidate; no additional live measurement is authorized by this document.

## Observed failure

The authorized 6,000-token-cap measurement at `b2f347a` completed the first retrieval cell in three decisions with 2,948 output tokens. The second repetition used all 6,000 investigation output tokens and its last response ended with `length`. All six requests had complete receipts and no observed overspend. The evaluator stopped after two of forty cells. The failed controller invocation did not return its tool statistics, so its diagnostics remain unavailable in the original report.

Increasing the PLAN's investigation allowance is not part of this change. A failed cell with a known receipt is useful evaluation data; it must retain its failure and measured costs.

## Decision

Treat a terminal `response/length` failure as a limited investigation result only when the actual ledger confirms complete usage, exactly exhausted investigation output, no overspend, no blocking state and no cancellation. Return the accumulated statistics and existing selection with `limit-reached/budget-exhausted`, plus safe failure metadata. Do not parse or accept the incomplete final response. The cell cannot earn successful evidence coverage. The evaluator can then continue to other fixed cells using the same global ledger.

Unknown usage, transport failures, configuration changes, secret filtering and cancellation retain their existing stop behavior. Nothing in this change permits a further decision beyond three, another tool beyond eight, or output beyond the fixed 6,000-token investigation allowance.

Prompt `workflow-prompt-v2` makes the decision limit explicit, describes navigation output as navigation rather than source evidence, encourages bounded source reads from already supplied file IDs, batches reads, and permits concise topic/selection/finish actions together when evidence is sufficient. It contains no development answer keys, fixture paths, holdout facts or fixed correct topics. The model still chooses what to investigate and can state unresolved needs.

New investigation dispatch requires the matching prompt version in RunSpec. New reports bind that version in their fingerprints; absent version metadata in older reports means v1, preserving their original fingerprints and costs. The original failed runs remain unchanged. Their missing statistics cannot be invented or replaced by v2 output. A v2 quality claim requires a new complete forty-cell matrix, with all previous calls still charged to the user-approved cumulative allowance.

## Verification and rollback

Offline tests exercise a fully settled length failure at the output boundary, missing usage, cancellation, overspend, version mismatch and a failed-but-observable cell in a full matrix. The latter remains a failed cell while its complete receipt and valid execution diagnostics are accounted for. Static production generation remains on its existing path. Rollback uses the v1 source commit and its own report/configuration bindings; mixed prompt versions cannot silently fill a quality matrix.
