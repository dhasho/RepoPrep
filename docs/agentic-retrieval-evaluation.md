# M06 retrieval evaluation runner

The runner evaluates the M06 investigation controller on the 20 frozen development retrieval tasks, twice per task (40 cells). It materializes only the authored `projects.json` source files into temporary project roots. Task objectives and role/granularity are passed to the controller; retrieval labels remain in the evaluator for scoring and are never included in controller inputs. Each cell uses the actual `RunSpec` defaults for global input/output/read/time capacity, preserving the generator reserve; its investigation allowance remains the existing 3 requests, 8 tools, 18,000 input tokens, 6,000 output tokens, 2 MiB reads, and 180 seconds.

## Authorization and execution

This runner makes no model calls unless a local authorization JSON is supplied and matches the current clean source commit, the hashes of `projects.json`, `retrieval-tasks.json`, and `retrieval-labels.json`, and the saved profile's nonsecret model configuration. It has no synthetic fallback. Missing, malformed, stale, or mismatched authorization blocks before the saved credential is loaded. An atomic ignored claim is created before the saved profile store is accessed; a claim is one-shot and remains after crashes or partial runs, so unknown paid work is never automatically resent. The runner only adjusts an in-memory profile clone. The default per-response output cap is 2,000 tokens; exactly 6,000 is also supported when separately approved and explicitly bound in the authorization. Every request is still bounded by the remaining 6,000-token investigation allowance. See the [output reservation decision](adr/agentic-investigation-output-cap.md).

The authorization document is created outside tracked source after explicit user approval (for example, in ignored `.validation/agentic/authorizations/`). Its fields are:

```json
{
  "purpose": "m06-retrieval-v1",
  "reference": "user-approved-reference",
  "sourceCommit": "40-character-clean-HEAD",
  "retrievalDataHash": "sha256-from-current-dataset-files",
  "endpointFingerprint": "sha256-of-normalized-endpoint",
  "model": "approved-model-id",
  "protocol": "openai",
  "temperature": 0.4,
  "reasoningEffort": null,
  "contextWindowTokens": 49152,
  "maxOutputTokens": 2000,
  "maxRuns": 40,
  "maxRequests": 120,
  "maxInputTokens": 720000,
  "maxOutputTokensTotal": 240000
}
```

The Electron child revalidates the authorization and one-shot claim synchronously, then stages only the encrypted settings and OSCrypt `Local State` and sets all isolated Electron paths before its first asynchronous yield. A static startup diagnostic is written to stderr and, after a claim exists, to `.validation/agentic/claims/<claim-id>.startup-status.json`. It records only a fixed stage and allowlisted error code; it never records exception messages, stacks, profile data, or credentials.

For an existing claim that has no `.started` marker, an operator can run a credential-only preflight with the same approved artifact and selected settings directory:

```powershell
node scripts/evaluation/run-retrieval-profile.cjs `
  --authorization C:\path\to\approved-m06-authorization.json `
  --settings-dir C:\Users\<user>\AppData\Roaming\ProjectLens `
  --credential-preflight
```

This mode refuses a missing or already-started claim, verifies the saved profile binding, and exits after native credential decryption. It does not create a claim, write user settings, create an evaluation output directory, or invoke a provider.

The `contextWindowTokens`, `endpointFingerprint`, and `model` values must match the selected saved profile. The authorization artifact carries no API key or encrypted profile data. Keep it outside the repository and provide its path explicitly:

```powershell
node scripts/evaluation/run-retrieval-profile.cjs `
  --authorization C:\path\to\approved-m06-authorization.json `
  --output .validation/agentic/retrieval-approved-run
```

The default saved profile is selected unless `--profile-id` is supplied. The launcher validates authorization and repository bindings before opening the Electron profile store, then checks saved public profile fields against the approval before decrypting its credential. The temporary Electron user-data directory is restricted to the current OS user and removed only after the child process closes. Reports, per-run receipts, and an fsynced per-request journal are written under ignored `.validation/agentic/`; they contain evidence selection ranges/hashes, bounded receipts, run outcomes, and nonsecret provider configuration metadata.

## Gate verification

`verifyRetrievalReport(report, bundle)` recomputes the 40-cell matrix, validates settled per-call usage receipts and run caps, and checks selected evidence ranges against the frozen project source and every required evidence group. It does not trust `report.metrics`, the reported completion booleans, or status fields. Subset runs are useful for screening but cannot pass M06. A missing report or authorization path is reported as unknown by the gate checker. Verification never calls a model.

Failed requests remain in the request journal. Complete provider usage received before a failure, or in the bounded tail following a terminal finish failure, is retained once; missing usage remains unknown and keeps its conservative reservation. Anthropic message-start usage alone is preliminary and cannot settle a failed stream. Tail reading respects the same byte, timeout and cancellation limits and emits no further content. Safe failure metadata includes only an allowlisted kind, numeric HTTP status and allowlisted finish reason; raw exceptions, provider bodies and reasoning text are not report fields.

For incomplete receipts, aggregate actual `inputTokens` and `outputTokens` are `null`. `knownInputTokens`, `knownOutputTokens` and `unknownRequests` describe the observed receipts separately; charged totals describe conservative budget use, not a provider invoice. Receipt completeness, matrix completeness, diagnostic availability and observed cap violations are independent. Failed controller outputs may leave retrieval or read statistics unavailable instead of reporting an invented zero, invalid execution or missing provider usage. Missing diagnostics still fail the gate. No repaired collector can recover a historical receipt that was never captured. Preserve original reports and journals; any offline reassessment must be a separate artifact bound to their hashes. Resuming real measurements after a missing-usage stop requires further user direction and must account for all earlier requests and retained reservations.

Offline tests use only synthetic data and synthetic transports. They do not read saved credentials and never label synthetic output as a real run.
