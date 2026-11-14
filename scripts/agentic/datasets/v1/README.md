# Development dataset v1

This is an agent-authored synthetic development dataset. Its twelve compact projects are authored fixtures, not copied from external repositories; no holdout repositories were read. Fixture code is inert source text and is never executed by the builder.

All task labels, review labels, and repair keys were authored by an AI agent from the fixture source. No human authored or verified these labels, no external model call was made, and blind independent review/adjudication is pending. These assets are not evidence of real-repository quality or human review.

Run `node scripts/agentic/build-development-datasets.mjs` from the repository root to deterministically rebuild the frozen JSON files and run local count, coverage, fingerprint, project hash, evidence range, and range hash checks.

`review-packet.json` and `repair-samples.json` are public blind packets. Their separate key files carry labels and must not be included in a blind reviewer context.
