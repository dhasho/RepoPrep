# Real evaluation cohort

本轮完整事实覆盖为 22/28（部分 3、缺失 3、矛盾 0），低于旧生产组 23/28，保留为未通过的诊断结果。选中测量共 80 题、4 次调用，其中两例 Python 为新生成，两例 JavaScript 复用已证明请求体相同的历史实测。总 token 比原生产组少 17.06%，输入 token 少 25.18%；这不等于货币成本降幅，也不能单独宣称质量提升。

逐项复核记录于 assistant-review-summary.json 及来源报告的 sidecar。新答案仍存在把注释扩展成错误反事实等问题，继续收紧通用依据要求与依赖/可选路径覆盖；之后提示词变化的版本须四例全部重新生成，不能继续复用本轮 JavaScript 答案。复核为代理辅助，人工盲审仍未完成。

- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash (openai)
- Composed at: 2026-10-24T12:02:21.264Z
- Schema: repoprep-real-eval-cohort-v1 (aggregated measurements with per-case provenance; not itself a repoprep-eval-report-v2 run)
- Reuse proof canonical SHA-256: d225fde510c0404d710247e1a5e1f15508478d7b71b724fd1aeabfad460a3f02

## Source reports

| Role | Status | Run | Generated at | Reference | Canonical SHA-256 |
|---|---|---|---|---|---|
| baseline | complete | 86f91465-5ac3-4a70-8e5a-9b076bbbf1ab | 2026-10-23T09:14:49.649Z | ../2026-10-23-deepseek-v4-flash/report.json | 3279159288ace996a57d8012f6eff6752b21c62866854945dbc41294058639e0 |
| current | complete | 2178580d-a8d4-45e7-b8bc-147d7c4bb8f6 | 2026-10-24T11:39:13.914Z | ../2026-10-24-weighted-v1-deepseek-v4-flash/report.json | c93dbf09a541ae3f99b70099e0bffedfaeb5a36183dfb22579ad1d69bb730132 |
| reuse | complete | e03c5a43-ad43-4c04-b410-8693f2725ee6 | 2026-10-23T18:52:13.674Z | ../2026-10-24-balanced-v1-deepseek-v4-flash/report.json | b7aa2de46b08271ee301dca24584f82ec4141e7a99fc831ff30f57001e88b9e2 |

## Selection

- Cohort cases: 4
- Fresh measurements from the current run: 2 (requests, schedule)
- Reused measurements from the prior run: 2 (mitt, p-limit)
- Selected measurement requests (raw request count across the selected cases): 4
- Fresh network requests (all calls in the current source run, including controls): 2
- Reused measurements (filled case count): 2

## Aggregated measured totals

| Metric | Cohort |
|---|---:|
| Questions | 80 |
| Requests | 4 |
| Elapsed ms (scan + generation) | 530640 |
| Generator phase ms | 530481 |
| Actual input tokens | 109424 |
| Actual output tokens | 106589 |
| Actual total tokens | 216013 |
| Estimated input tokens | 168483 |
| Repair requests | 0 |
| Compensation requests | 0 |
| Context build ms | 1103 |
| Model ms | 528808 |
| Keyword coverage (hits / facts) | 28/28 |

## Cases

| Case | Source | Origin run | Requests | Questions | Elapsed ms | Actual tokens | Repairs / compensations | Keyword hits |
|---|---|---|---:|---:|---:|---:|---:|---:|
| mitt | reused | e03c5a43-ad43-4c04-b410-8693f2725ee6 | 1 | 20 | 126362 | 35754 | 0 / 0 | 6/6 |
| p-limit | reused | e03c5a43-ad43-4c04-b410-8693f2725ee6 | 1 | 20 | 168250 | 48296 | 0 / 0 | 7/7 |
| requests | fresh | 2178580d-a8d4-45e7-b8bc-147d7c4bb8f6 | 1 | 20 | 127848 | 68157 | 0 / 0 | 8/8 |
| schedule | fresh | 2178580d-a8d4-45e7-b8bc-147d7c4bb8f6 | 1 | 20 | 108180 | 63806 | 0 / 0 | 7/7 |

## Case provenance

| Case | Source | Origin report role | Origin run | Reference | First request prompt SHA-256 | Question fingerprints |
|---|---|---|---|---|---|---:|
| mitt | reused | reuse | e03c5a43-ad43-4c04-b410-8693f2725ee6 | ../2026-10-24-balanced-v1-deepseek-v4-flash/report.json | fe7ebd3fcc1e5a7c8907f0573cf517bbf021609f2f9cfc1ab189313559d65c71 | 20 |
| p-limit | reused | reuse | e03c5a43-ad43-4c04-b410-8693f2725ee6 | ../2026-10-24-balanced-v1-deepseek-v4-flash/report.json | 561321bcd3d6b169fe34d842d75b779f5a5011335a84c011b45dd3e725680428 | 20 |
| requests | fresh | current | 2178580d-a8d4-45e7-b8bc-147d7c4bb8f6 | ../2026-10-24-weighted-v1-deepseek-v4-flash/report.json | 2e771bad28300141d1f22acc337a822226ab1ed22144cc949fcc3d3e49938ff6 | 20 |
| schedule | fresh | current | 2178580d-a8d4-45e7-b8bc-147d7c4bb8f6 | ../2026-10-24-weighted-v1-deepseek-v4-flash/report.json | 41db9e7bd1484223bb7e9cac2edca8258e6f57e3cc604faa2008c4ac7f8a1677 | 20 |

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
