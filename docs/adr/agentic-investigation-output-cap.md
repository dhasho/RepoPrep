# M06 investigation output reservation

Status: implemented; the user explicitly approved the 6,000-token-cap measurement at `b2f347a`. That measurement stopped after two cells; the default remains 2,000 and the approval does not reset earlier costs.

## Evidence

The first authorized development measurement lost usage on its second request and stopped. After receipt preservation was repaired, the measurement at `c5722bf` again stopped at the first task: both requests had complete usage, and the second explicitly reported `finish_reason: length` after 2,000 output tokens. The latter observation establishes truncation for that request only; it does not recover or explain the earlier missing receipt.

DeepSeek documents that omitted thinking settings enable thinking by default, with `high` effort, and that `length` can indicate exceeding `max_tokens`. This supports testing a larger response allowance; it does not prove how many tokens in this particular response were reasoning tokens. No reasoning payload is retained. See the [provider request contract](https://api-docs.deepseek.com/api/create-chat-completion/).

## Candidate decision

Permit the main-process evaluation authorization to select exactly 2,000 or 6,000 maximum output tokens per request. Keep 2,000 as the default. Bind the exact selected ceiling to the authorization, temporary profile, RunSpec and report/configuration fingerprints, and enforce it before dispatch and when checking receipts. An authorization for 2,000 cannot enable 6,000.

For an explicitly selected larger ceiling, reserve at most the remaining investigation output allowance for each decision. Release the difference only when a complete provider receipt arrives. With a 6,000-token stage allowance and a first actual response of 452 tokens, the next request can reserve at most 5,548 tokens. A missing receipt retains its full reservation and stops further dispatch.

The PLAN's per-run limits remain unchanged: at most three decisions, eight tools, 18,000 input tokens, 6,000 output tokens, 2 MiB reads and 180 seconds. The frozen 20 tasks × two repetitions and all quality thresholds remain unchanged. Model, endpoint, temperature and default reasoning remain unchanged; temporary caps never update saved settings. Earlier failed runs remain in the cost ledger and are not replaced with later results.

## Approval and rollback

The user approved a cumulative 120-request ceiling, then a new 118-request measurement after the first two calls, then the 6,000-token-cap candidate with at most 116 further requests. Ten calls have now been dispatched in total, with one historical usage still unknown. The latest six calls have complete usage: 6,632 input and 8,948 output tokens; one cell succeeded and one exhausted its 6,000-token stage allowance. Subsequent measurements must deduct all known usage and retained unknown reservations; this ADR does not authorize additional calls or reset the ceiling.

Rollback selects the default 2,000-token cap or removes the experimental evaluator. Production static generation and stored profiles retain their current behavior.
