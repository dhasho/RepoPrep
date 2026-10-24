# Real evaluation cohort

本轮未通过核心事实覆盖回归检查：保守完整覆盖为 18/28，旧生产组为 23/28。两例 Python 为本轮新生成，另外两例 JavaScript 复用自完全相同请求体的历史实测；共选用 4 次测量，其中只有 2 次新调用。复用证明见 reuse-proof.json，逐项裁定和具体错误见 assistant-review-summary.json。继续改进通用预算分配，本汇总不代表最终版本已验收。

- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash (openai)
- Composed at: 2026-10-24T04:43:51.509Z
- Schema: repoprep-real-eval-cohort-v1 (aggregated measurements with per-case provenance; not itself a repoprep-eval-report-v2 run)
- Reuse proof canonical SHA-256: 39a2b3303d1e94de381885ea1d8fdbce927ccde2189d1e6e6f5e2613598f0e4f

## Source reports

| Role | Status | Run | Generated at | Reference | Canonical SHA-256 |
|---|---|---|---|---|---|
| baseline | complete | 86f91465-5ac3-4a70-8e5a-9b076bbbf1ab | 2026-10-23T09:14:49.649Z | ../2026-10-23-deepseek-v4-flash/report.json | 3279159288ace996a57d8012f6eff6752b21c62866854945dbc41294058639e0 |
| current | complete | 37bf2ccb-3aa0-473a-9e4a-4b712cdbf1d1 | 2026-10-24T04:33:06.048Z | ../2026-10-24-logical-v1-deepseek-v4-flash/report.json | e490b7b805459d813e55d5061b7ee0162d08841a7cdf9aeda74cd2a00386f159 |
| reuse | complete | e03c5a43-ad43-4c04-b410-8693f2725ee6 | 2026-10-23T18:52:13.674Z | ../2026-10-24-balanced-v1-deepseek-v4-flash/report.json | b7aa2de46b08271ee301dca24584f82ec4141e7a99fc831ff30f57001e88b9e2 |

## Selection

- Cohort cases: 4
- Fresh measurements from the current run: 2 (requests, schedule)
- Reused measurements from the prior run: 2 (mitt, p-limit)
- Selected measurement requests (raw request count across the selected cases): 4
- Fresh network requests (selected current-run requests): 2
- Reused measurements (filled case count): 2

## Aggregated measured totals

| Metric | Cohort |
|---|---:|
| Questions | 80 |
| Requests | 4 |
| Elapsed ms (scan + generation) | 525767 |
| Generator phase ms | 525567 |
| Actual input tokens | 109897 |
| Actual output tokens | 104254 |
| Actual total tokens | 214151 |
| Estimated input tokens | 168465 |
| Repair requests | 0 |
| Compensation requests | 0 |
| Context build ms | 1016 |
| Model ms | 523885 |
| Keyword coverage (hits / facts) | 27/28 |

## Cases

| Case | Source | Origin run | Requests | Questions | Elapsed ms | Actual tokens | Repairs / compensations | Keyword hits |
|---|---|---|---:|---:|---:|---:|---:|---:|
| mitt | reused | e03c5a43-ad43-4c04-b410-8693f2725ee6 | 1 | 20 | 126362 | 35754 | 0 / 0 | 6/6 |
| p-limit | reused | e03c5a43-ad43-4c04-b410-8693f2725ee6 | 1 | 20 | 168250 | 48296 | 0 / 0 | 7/7 |
| requests | fresh | 37bf2ccb-3aa0-473a-9e4a-4b712cdbf1d1 | 1 | 20 | 114672 | 64865 | 0 / 0 | 7/8 |
| schedule | fresh | 37bf2ccb-3aa0-473a-9e4a-4b712cdbf1d1 | 1 | 20 | 116483 | 65236 | 0 / 0 | 7/7 |

## Case provenance

| Case | Source | Origin report role | Origin run | Reference | First request prompt SHA-256 | Question fingerprints |
|---|---|---|---|---|---|---:|
| mitt | reused | reuse | e03c5a43-ad43-4c04-b410-8693f2725ee6 | ../2026-10-24-balanced-v1-deepseek-v4-flash/report.json | fe7ebd3fcc1e5a7c8907f0573cf517bbf021609f2f9cfc1ab189313559d65c71 | 20 |
| p-limit | reused | reuse | e03c5a43-ad43-4c04-b410-8693f2725ee6 | ../2026-10-24-balanced-v1-deepseek-v4-flash/report.json | 561321bcd3d6b169fe34d842d75b779f5a5011335a84c011b45dd3e725680428 | 20 |
| requests | fresh | current | 37bf2ccb-3aa0-473a-9e4a-4b712cdbf1d1 | ../2026-10-24-logical-v1-deepseek-v4-flash/report.json | 9b5e88190c4fe5d3ac029952089b00547b25c26e275cf301de54f1270eabc7a2 | 20 |
| schedule | fresh | current | 37bf2ccb-3aa0-473a-9e4a-4b712cdbf1d1 | ../2026-10-24-logical-v1-deepseek-v4-flash/report.json | a620c20e130473ee391d44b8c3e122abcba078a4b6d370b51cfb479fb7802d80 | 20 |

Full sorted per-question fingerprints are recorded in cohort.json under cases[].questionFingerprints.

## Limitations

- Actual provider token totals are null when complete usage receipts are unavailable; missing usage is never filled with zero.
- Estimated input tokens are application estimates and are reported separately from provider usage.
- Keyword fact coverage counts configured keyword matches; it is not factual accuracy.
- No monetary cost, model accuracy, or human review score is claimed anywhere in this cohort; human review in the source reports remains pending.
- Reused measurements are the original recorded production HTTP requests from the prior run, accepted only when the reuse proof attests identical request bodies; they are not new requests and never relabeled as fresh.
- This cohort is an aggregation of existing reports with explicit per-case provenance; it is not itself a repoprep-eval-report-v2 run and must not be presented as one fresh generation run.
- The legacy report digest does not bind generation metadata; the composer checks canonical output and question cross-links and records canonical hashes of all inputs.
- Endpoint origin hashes must match when both reports record them; older reports may omit that field.
