# M06 retrieval evaluation runner

The runner evaluates the M06 investigation controller on the 20 frozen development retrieval tasks, twice per task (40 cells). It materializes only the authored `projects.json` source files into temporary project roots. Task objectives and role/granularity are passed to the controller; retrieval labels remain in the evaluator for scoring and are never included in controller inputs.

## Authorization and execution

This runner makes no model calls unless a local authorization JSON is supplied and matches the current clean source commit, the hashes of `projects.json`, `retrieval-tasks.json`, and `retrieval-labels.json`, and the saved profile's nonsecret model configuration. It has no synthetic fallback. Missing, malformed, stale, or mismatched authorization blocks before the saved credential is loaded. The runner only adjusts an in-memory profile clone to cap each model response at 2,000 output tokens.

The authorization document is created outside the repository after explicit user approval. Its fields are:

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

The `contextWindowTokens`, `endpointFingerprint`, and `model` values must match the selected saved profile. The authorization artifact carries no API key or encrypted profile data. Keep it outside the repository and provide its path explicitly:

```powershell
node scripts/evaluation/run-retrieval-profile.cjs `
  --authorization C:\path\to\approved-m06-authorization.json `
  --output .validation/agentic/retrieval-approved-run
```

The default saved profile is selected unless `--profile-id` is supplied. The launcher validates authorization and repository bindings before opening the Electron profile store. Reports are written under ignored `.validation/agentic/` by default and contain only evidence selection ranges/hashes, bounded receipts, run outcomes, and nonsecret provider configuration metadata.

## Gate verification

`verifyRetrievalReport(report, bundle)` recomputes the 40-cell matrix, validates settled per-call usage receipts and run caps, and checks selected evidence ranges against the frozen project source and every required evidence group. It does not trust `report.metrics`, the reported completion booleans, or status fields. Subset runs are useful for screening but cannot pass M06. A missing report or authorization path is reported as unknown by the gate checker. Verification never calls a model.

Offline tests use only synthetic data and synthetic transports. They do not read saved credentials and never label synthetic output as a real run.
