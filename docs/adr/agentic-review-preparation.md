# Prepare independent M08 review inputs

Status: implementation plan for a read-only evaluation tool. The ongoing writer-v4 measurement remains frozen at `78e66e2`.

The pure blind-packet builder and strict M08 gate exist, but operators still need a repeatable way to prepare the actual review files. Add a CLI taking only source-root, report-file and authorization-file. It must use the same verified execution loader as the gate: real mode, complete 48-cell matrix, source/data/config/claim/receipt/raw-artifact/lineage checks. It never reads saved credentials or calls a model.

Only after successful verification, create the report's new `review/` directory with exclusive writes. Produce opaque `packets.json`, separate `private-map.json`, the exact frozen public rubric, and clearly incomplete reviewer templates under `templates/`. Templates use unknown/null/empty grading fields and cannot pass the gate; do not invent grades, invocations, identities or costs. Refuse existing output, partial runs or malformed bindings without overwriting anything. Keep private maps out of the files later delivered to graders. Retain all main answers and recursive follow-ups and verify packet reconstruction before committing prepared files.

Factor the existing raw verification preamble into a small shared loader, preserving every guard and the gate's existing quality checks. Do not add a skip-review gate mode or let preparation itself report quality pass. The synthetic test path stays explicitly separate from the public real CLI.

Because M08 supports a frozen measured source different from the current read-only checker, record the actual checker source tree hash and commit as bounded metadata references, and detect checker changes during verification. Keep the measured source binding distinct. No source text, prompts, credentials or arbitrary errors belong in these references.

Luna implements and tests the tool in an isolated worktree; root reviews integration. Test existing-output protection, partial/synthetic rejection before writes, actual source/packet hashes, complete recursive template coverage and unknown templates failing review validation. The current generator, model settings, budgets, source/input data, question counts and quality thresholds remain unchanged. No provider call is required to implement or verify this tool.
