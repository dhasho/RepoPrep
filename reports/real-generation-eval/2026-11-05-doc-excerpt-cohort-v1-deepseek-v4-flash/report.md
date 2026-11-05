# Multi-run real evaluation cohort

四例已测齐：核心事实完整覆盖 25/28（前次 23/28），但实质错误由 4 类增至 8 类，尚未证明整体答案质量改善。候选总用量 213,010 tokens，比最近 scoped 四例少 16.41%，比更早较低用量 grounded 参考少 0.25%；两端推理条件不同，不能宣称稳定成本收益。

本目录汇总三个完整运行中选出的四例测量；所选生成调用为 4 次，包含前置失败筛查的研究累计为 5 次。详细条件与限制见 [comparison.md](comparison.md)，逐事实汇总见 [assistant-review-summary.json](assistant-review-summary.json)，来源绑定见 [provenance.json](provenance.json)。

组合工具 [aggregate-multirun.mjs](aggregate-multirun.mjs) 与 [8 项验证](aggregate-multirun.test.mjs)随报告保存；工具拒绝缺例、重复 case、不同源码图、配置或 fixture 漂移与无效报告绑定。测试及组合过程不调用模型。复现组合时传入仓库绝对根目录、上面三个子集报告与失败筛查报告，并指定全新输出目录：

```powershell
node reports/real-generation-eval/2026-11-05-doc-excerpt-cohort-v1-deepseek-v4-flash/aggregate-multirun.mjs --root (Get-Location).Path --baseline reports/real-generation-eval/2026-11-01-scoped-v1-deepseek-v4-flash/report.json --candidate reports/real-generation-eval/2026-11-04-doc-excerpt-requests/report.json --candidate reports/real-generation-eval/2026-11-05-doc-excerpt-mitt-schedule/report.json --candidate reports/real-generation-eval/2026-11-05-doc-excerpt-p-limit/report.json --campaign-report reports/real-generation-eval/2026-11-04-callchain-low-requests/report.json --output (Join-Path (Get-Location).Path '.validation/doc-excerpt-cohort-reproduced') --allow-reasoning-change
node --test reports/real-generation-eval/2026-11-05-doc-excerpt-cohort-v1-deepseek-v4-flash/aggregate-multirun.test.mjs
```

- Schema: repoprep-real-eval-multirun-cohort-v1
- Corpus: repoprep-real-corpus-v1
- Model/protocol: deepseek-v4-flash / openai
- Selected cases: 4
- Selected measurement requests: 4
- Campaign requests: 5
- Reasoning-effort change: provider-default → low

This is a multi-run aggregation, not one fresh four-case run. Proxy review is not human review. No monetary cost or factual accuracy is inferred.

## Selected cases

| Case | Origin run | Requests | Questions | Provider usage | Estimated input | Question fingerprints | Source report |
|---|---|---:|---:|---|---:|---:|---|
| mitt | 835a902a-59ce-4880-a279-f8ff7abec2b2 | 1 | 20 | 31464 | 14570 | 20 | reports/real-generation-eval/2026-11-05-doc-excerpt-mitt-schedule/report.json |
| p-limit | 00032e42-668d-40c6-ae6f-1937906571f2 | 1 | 20 | 49513 | 27013 | 20 | reports/real-generation-eval/2026-11-05-doc-excerpt-p-limit/report.json |
| requests | 0a84cfe5-0b30-41e0-8ff7-4e30328f9d02 | 1 | 20 | 63277 | 63878 | 20 | reports/real-generation-eval/2026-11-04-doc-excerpt-requests/report.json |
| schedule | 835a902a-59ce-4880-a279-f8ff7abec2b2 | 1 | 20 | 68756 | 63997 | 20 | reports/real-generation-eval/2026-11-05-doc-excerpt-mitt-schedule/report.json |

## Reports

- Baseline: reports/real-generation-eval/2026-11-01-scoped-v1-deepseek-v4-flash/report.json (run c87cf61f-cacd-4e5f-821f-be1471372856; SHA-256 1d2980271c855851ade5f58d0a96b0fdd55a4008fa595edac81f9d0e9fdda640)
- Candidate: reports/real-generation-eval/2026-11-04-doc-excerpt-requests/report.json (run 0a84cfe5-0b30-41e0-8ff7-4e30328f9d02; SHA-256 dc54d42681dcca5a303cb9f258c667e2f92920e6f8c772b89d1c854da8df94fa)
- Candidate: reports/real-generation-eval/2026-11-05-doc-excerpt-mitt-schedule/report.json (run 835a902a-59ce-4880-a279-f8ff7abec2b2; SHA-256 a360dc183aaf5012b42ce57ba0cad2a3869ff02ae36da69d6d90264b8492b903)
- Candidate: reports/real-generation-eval/2026-11-05-doc-excerpt-p-limit/report.json (run 00032e42-668d-40c6-ae6f-1937906571f2; SHA-256 7d7a828dfa2391297e7055ade432fa347841c13dedada3022682ec062375c98c)
- Campaign-only: reports/real-generation-eval/2026-11-04-callchain-low-requests/report.json (run 314d1677-7aee-4e7a-a56e-2000fadcc21c; SHA-256 064960f6ed63f40fcfd9ff8320e41dd350a4a7392bbcced732988e5ee36061b8)

## Limitations

- This is a multi-run aggregation with per-case run provenance, not one fresh four-case run.
- Each case retains its original source run, report digest, raw and canonical report hashes, relative report reference, and 20 sorted question fingerprints.
- Campaign requests include all candidate source-run network receipts plus explicitly supplied campaign-only reports; the baseline is a comparison reference and is not counted unless separately supplied as campaign-only.
- Selected measurement requests sum only the four selected generation case request counts; campaign-only attempts are excluded.
- Provider usage remains null unless the source case contains a complete provider usage receipt; estimated input tokens remain separate.
- The legacy source report digest may not bind generation metadata; each input is additionally checked with the production comparator and its full canonical report hash is recorded.
- Proxy review is not human review. This artifact does not score factual accuracy or infer monetary cost.
- Baseline and candidate reasoning efforts differ under explicit authorization; treat them as different inference conditions.
