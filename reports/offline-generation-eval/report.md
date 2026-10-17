# Offline generation evaluation

- Mode: offline-pipeline-and-scorer-calibration
- Run: b0d5dfbb-3388-4968-8366-bcadff241653
- Corpus: repoprep-eval-corpus-v1
- Synthetic response: fixture-context-keyword-v1
- Config hash: b2a13ef1117ff18d9508805c452940e40f1cca9e96e797c44455c36f78c10e31
- Scope: offline pipeline and scorer calibration; not a real model quality claim.

Baseline: one request per case, same budget and synthetic profile, using README plus the production rendered file tree.

| Case | Granularity | Pipeline q | Baseline q | Δ q | Pipeline fact keywords | Baseline fact keywords | Pipeline duplicate rate | Baseline duplicate rate | Pipeline/base requests |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| react-state | medium | 20 | 20 | 0 | 4/4 | 3/4 | 0.0% | 0.0% | 1/1 |
| node-routes | medium | 20 | 20 | 0 | 4/4 | 4/4 | 0.0% | 0.0% | 1/1 |
| python-cli | fine | 25 | 32 | -7 | 4/4 | 4/4 | 0.0% | 0.0% | 4/1 |

### react-state

Pipeline alerts: none; forbidden hits 0; input 2347 chars; 48 ms.
Baseline alerts: known_fact_keyword_missing; forbidden hits 0; input 424 chars; 5 ms.

### node-routes

Pipeline alerts: none; forbidden hits 0; input 2243 chars; 13 ms.
Baseline alerts: none; forbidden hits 0; input 400 chars; 7 ms.

### python-cli

Pipeline alerts: none; forbidden hits 0; input 10477 chars; 22 ms.
Baseline alerts: none; forbidden hits 0; input 392 chars; 4 ms.

Human review coverage: 0/137 pending. See review-template.json.

Limitations: keyword coverage only shows that configured terms appeared in generated text; it is not a factual accuracy score. No real model was called. Tokens are null because synthetic token usage is not measured.

Full outputs, raw synthetic replies, per-request messages, hashes, and case-level metrics are in report.json.

## Human review

Status: pending; coverage 0/137 (0.0%). Means over fully rated questions: factualCorrectness pending, projectRelevance pending, semanticDuplication pending.
