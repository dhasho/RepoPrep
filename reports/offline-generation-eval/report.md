# Offline generation evaluation

- Mode: offline-pipeline-and-scorer-calibration
- Run: 1b67ecf9-e992-47f4-8a1f-7fa2b6edd2d4
- Corpus: repoprep-eval-corpus-v1
- Synthetic response: fixture-context-keyword-v1-evidence-json-repair
- Node: v24.16.0
- Config hash: 4fb388ba39e982b92fe1869e662fc95a7f0dfbd9632ee8458911b1a7fe95e416
- Scope: offline pipeline and scorer calibration; not a real model quality claim.

Baseline: same case budget and synthetic profile; one request containing README plus production-rendered file tree; no code source manifest or refs; always valid JSON. Synthetic fault schedule: node-routes generation: first raw reply is malformed JSON; production repair returns refs chosen only from the primary user context plus one deliberately unknown source ID. Baseline uses one valid JSON response; the Node generation case separately calibrates production repair.

| Case | Granularity | Pipeline q | Baseline q | Δ q | Pipeline fact keywords | Baseline fact keywords | Pipeline duplicate rate | Baseline duplicate rate | Pipeline/base requests | Raw JSON valid/invalid (pipeline/base) | Repair requests (pipeline/base) | Final contract (pipeline/base) | Evidence questions with refs (pipeline/base) | Pipeline refs asked/accepted/rejected/retained |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| react-state | medium | 20 | 20 | 0 | 4/4 | 3/4 | 0.0% | 0.0% | 1/1 | 1/0 (1/0) | 0/0 | true/true | 20/20 (0/20) | 20/20/0/20 |
| node-routes | medium | 20 | 20 | 0 | 4/4 | 4/4 | 0.0% | 0.0% | 2/1 | 1/1 (1/0) | 1/0 | true/true | 20/20 (0/20) | 21/20/1/20 |
| python-cli | fine | 25 | 32 | -7 | 4/4 | 4/4 | 0.0% | 0.0% | 4/1 | 4/0 (1/0) | 0/0 | true/true | 25/25 (0/32) | 25/25/0/25 |

Evidence coverage counts questions with at least one retained canonical reference. Production resolve counts prove the ID and range were checked against that request manifest; baseline has no code source manifest. Neither range validity nor keyword coverage proves that evidence semantically supports the answer.

### react-state

Pipeline alerts: none; forbidden hits 0; input 2697 chars; 53 ms. Retained refs 20; coverage 20/20; Production generateInterview resolved returned IDs and line ranges against the request manifest; this does not establish semantic support.
Baseline alerts: known_fact_keyword_missing; forbidden hits 0; input 427 chars; 5 ms. Baseline provided no code source manifest; source references were unavailable.

### node-routes

Pipeline alerts: none; forbidden hits 0; input 5290 chars; 19 ms. Retained refs 20; coverage 20/20; Production generateInterview resolved returned IDs and line ranges against the request manifest; this does not establish semantic support.
Baseline alerts: none; forbidden hits 0; input 403 chars; 3 ms. Baseline provided no code source manifest; source references were unavailable.

### python-cli

Pipeline alerts: none; forbidden hits 0; input 11477 chars; 20 ms. Retained refs 25; coverage 25/25; Production generateInterview resolved returned IDs and line ranges against the request manifest; this does not establish semantic support.
Baseline alerts: none; forbidden hits 0; input 395 chars; 5 ms. Baseline provided no code source manifest; source references were unavailable.

Human review coverage: 0/137 pending. See review-template.json.

Limitations: keyword coverage only shows that configured terms appeared in generated text; it is not a factual accuracy score. Source paths and line ranges validate request-scoped provenance, not semantic support or correctness. No real model was called. Tokens are null because synthetic token usage is not measured.

Full outputs, raw synthetic replies, per-request messages, hashes, and case-level metrics are in report.json.

## Human review

Status: pending; coverage 0/137 (0.0%). Means over fully rated questions: factualCorrectness pending, projectRelevance pending, semanticDuplication pending.
