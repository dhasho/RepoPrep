# Offline generation evaluation

- Mode: offline-pipeline-and-scorer-calibration
- Run: e2d4d9e2-47dd-4ede-83a1-9041ff400c20
- Corpus: repoprep-eval-corpus-v1
- Synthetic response: fixture-context-keyword-v1-node-json-repair
- Node: v24.16.0
- Config hash: d4e2965a0f9dd238d3e56487b2717c78f352793dda410bcf7728332473471ad1
- Scope: offline pipeline and scorer calibration; not a real model quality claim.

Baseline: same case budget and synthetic profile; one request containing README plus production-rendered file tree, always a valid JSON response. Synthetic fault schedule: node-routes generation: first raw reply is malformed JSON once; production repair request returns valid JSON. Baseline uses one valid JSON response; the Node generation case separately calibrates production repair.

| Case | Granularity | Pipeline q | Baseline q | Δ q | Pipeline fact keywords | Baseline fact keywords | Pipeline duplicate rate | Baseline duplicate rate | Pipeline/base requests | Raw JSON valid/invalid (pipeline/base) | Repair requests (pipeline/base) | Final contract (pipeline/base) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| react-state | medium | 20 | 20 | 0 | 4/4 | 3/4 | 0.0% | 0.0% | 1/1 | 1/0 (1/0) | 0/0 | true/true |
| node-routes | medium | 20 | 20 | 0 | 4/4 | 4/4 | 0.0% | 0.0% | 2/1 | 1/1 (1/0) | 1/0 | true/true |
| python-cli | fine | 25 | 32 | -7 | 4/4 | 4/4 | 0.0% | 0.0% | 4/1 | 4/0 (1/0) | 0/0 | true/true |

### react-state

Pipeline alerts: none; forbidden hits 0; input 2347 chars; 49 ms.
Baseline alerts: known_fact_keyword_missing; forbidden hits 0; input 424 chars; 5 ms.

### node-routes

Pipeline alerts: none; forbidden hits 0; input 4656 chars; 20 ms.
Baseline alerts: none; forbidden hits 0; input 400 chars; 4 ms.

### python-cli

Pipeline alerts: none; forbidden hits 0; input 10477 chars; 19 ms.
Baseline alerts: none; forbidden hits 0; input 392 chars; 5 ms.

Human review coverage: 0/137 pending. See review-template.json.

Limitations: keyword coverage only shows that configured terms appeared in generated text; it is not a factual accuracy score. No real model was called. Tokens are null because synthetic token usage is not measured.

Full outputs, raw synthetic replies, per-request messages, hashes, and case-level metrics are in report.json.

## Human review

Status: pending; coverage 0/137 (0.0%). Means over fully rated questions: factualCorrectness pending, projectRelevance pending, semanticDuplication pending.
