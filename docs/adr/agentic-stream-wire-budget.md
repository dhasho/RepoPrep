# Explicit SSE wire budget

Status: bounded client repair under implementation. Historical missing usage remains unknown.

## Evidence

The first M08 real request at `5496457` failed without a complete usage receipt. Its diagnostic was only `model-failed`; neither a specific failure kind nor response byte counts were retained. Preserve that request and its 2,813 input / 32,768 output reservation. The cause cannot be established retrospectively, and the original request is not replayed.

Independent offline probes found a separate, reproducible protocol limitation: the client counts every SSE envelope byte, including ignored reasoning fields, against a 4 MiB response limit. A synthetic stream with 20,000 one-character reasoning deltas, normal chunk metadata, 58 visible JSON characters and a declared completion usage below the 32,768-token ceiling occupied 4,900,753 wire bytes. The final usage tail began after the 4 MiB boundary. The old client cancelled before that tail. A smaller control completed and delivered usage. These are synthetic protocol tests, not a diagnosis or billing receipt for the real request.

## Decision

Keep the default and non-stream JSON response bound at 4 MiB. Add an explicit main-process SSE wire allowance for requests sent by the budget gateway: the reserved output tokens multiplied by 1,024 bytes, with a 4 MiB floor and a 32 MiB hard maximum. Forward that exact private option through the evidence-generation transport wrapper.

The reader continues processing chunks incrementally. The per-event buffer, visible-content character limit, total deadlines, cancellation and credential filtering retain their current bounds. Reasoning content is ignored and never persisted. The output-token reservation, wire `max_tokens`, per-run token limits and request-count limits do not increase.

Invalid byte-limit options fail before fetch. A response exceeding the explicit wire allowance still fails and retains unknown usage when no complete receipt exists. A finite response-limit reason may be recorded alongside the safe failure kind; raw provider messages, response text, reasoning, stacks and credentials are not diagnostics.

## Verification

Use the same small-frame SSE fixture to demonstrate default rejection and explicitly budgeted success with one usage callback. Test the hard ceiling, malformed option, event/content limits, timeout and cancellation independently. Preserve all existing default/static tests. No actual model request is required to validate this client change, and no old receipt or quality result is rewritten.
