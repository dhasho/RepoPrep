# Bounded M08 writing guidance

Status: approved implementation plan for writer v2. M08 remains incomplete.

## Evidence

The immutable `843f039` cohort completed the four paired observations of the first medium task, then stopped on the first fine task. All twelve request receipts are complete: 24,927 input and 214,037 output tokens. The fine run used its entire 65,536 output-token allowance, accepted 24 questions and ended with provider `finish_reason: length`; the existing minimum is 25. It is a failed cell, not a successful shorter run. The original report, journal, all fifteen referenced artifacts and their hashes are retained.

The current common generator instructions allow main answers of 150–400 Chinese characters, two to four follow-ups of 50–150 characters, and optional nested follow-ups. This breadth can consume the fixed allowance before the fine question target is reached. The receipts establish output exhaustion; they do not separate visible output from provider reasoning or prove a quality cause.

## Decision

Keep the frozen corpus, all question minimum/target/maximum values, batches, model, default reasoning, temperature, per-request ceiling and all cumulative/time limits. Version only the evidence writer's common guidance as `m08-evidence-writer-v2`. Apply it identically to static-control and topic-card conditions: request concise main answers of 150–220 characters and two follow-ups of 50–80 characters each, with empty nested follow-ups by default. These choices remain within the existing prompt ranges. Preserve mechanisms, required conditions, source citations, complete JSON, glossary coverage and the existing result contract; do not truncate generated answers or bypass validation to obtain a successful count.

The topic-card block remains the sole difference between the two conditions. Default generation without the evidence adapter keeps its existing messages. Add no author labels, fact keys, sample-specific heuristics or new online calls. Verify shared guidance on initial, repair and compensation requests, ordinary static equivalence, actual dispatch manifests and budget enforcement.

## Measurement and rollback

Any later real measurement uses a new immutable source and new one-shot reference for the entire 48-cell matrix. Do not combine the four successful writer-v1 cells with writer-v2 results. The earlier unknown request retains its full 2,813/32,768 reservation; after this twelve-request attempt, the remaining M08 ceiling is 407 requests, 6,116,260 input admission and 2,898,923 output allowance. No allowance is reset or borrowed from M06.

Independent blind reviewers must still assess all main and follow-up answers against the frozen rubric. Concision, valid citations or successful execution do not establish quality. If the unchanged quality thresholds fail, retain the failure and keep M08/P4 incomplete. Rollback selects writer v1 in source; historical results and saved user settings are not rewritten.
