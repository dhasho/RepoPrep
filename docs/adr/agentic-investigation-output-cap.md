# M06 investigation output reservation

Status: offline candidate; a live 6,000-token per-request ceiling requires explicit user approval. The existing approved/default ceiling remains 2,000 until then.

## Evidence

The first authorized development measurement lost usage on its second request and stopped. After receipt preservation was repaired, the measurement at `c5722bf` again stopped at the first task: both requests had complete usage, and the second explicitly reported `finish_reason: length` after 2,000 output tokens. The latter observation establishes truncation for that request only; it does not recover or explain the earlier missing receipt.

DeepSeek documents that omitted thinking settings enable thinking by default, with `high` effort, and that `length` can indicate exceeding `max_tokens`. This supports testing a larger response allowance; it does not prove how many tokens in this particular response were reasoning tokens. No reasoning payload is retained. See the [provider request contract](https://api-docs.deepseek.com/api/create-chat-completion/).

## Candidate decision

Permit the main-process evaluation authorization to select exactly 2,000 or 6,000 maximum output tokens per request. Keep 2,000 as the default. Bind the exact selected ceiling to the authorization, temporary profile, RunSpec and report/configuration fingerprints, and enforce it before dispatch and when checking receipts. An authorization for 2,000 cannot enable 6,000.

For an explicitly selected larger ceiling, reserve at most the remaining investigation output allowance for each decision. Release the difference only when a complete provider receipt arrives. With a 6,000-token stage allowance and a first actual response of 452 tokens, the next request can reserve at most 5,548 tokens. A missing receipt retains its full reservation and stops further dispatch.

The PLAN's per-run limits remain unchanged: at most three decisions, eight tools, 18,000 input tokens, 6,000 output tokens, 2 MiB reads and 180 seconds. The frozen 20 tasks × two repetitions and all quality thresholds remain unchanged. Model, endpoint, temperature and default reasoning remain unchanged; temporary caps never update saved settings. Earlier failed runs remain in the cost ledger and are not replaced with later results.

## Approval and rollback

The user approved a cumulative 120-request ceiling and later a new 118-request measurement after the first two calls. Four calls have now been dispatched in total, with one historical usage still unknown. Before any measurement with the proposed larger per-request ceiling, request explicit approval and deduct all known usage plus retained unknown reservations from the original budgets. Preparing this offline candidate does not authorize further calls or reset that ceiling.

Rollback selects the default 2,000-token cap or removes the experimental evaluator. Production static generation and stored profiles retain their current behavior.
