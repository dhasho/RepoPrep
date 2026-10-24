# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 2178580d-a8d4-45e7-b8bc-147d7c4bb8f6
- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash
- Status: complete
- Human review: pending
- Context window setting: unknown
- Configured output cap: provider controlled
- Application input budget: 64000 estimated tokens
- Reserved output: 65536 tokens (deepseek-reasoning-reserve-65536)

| Case | Variant | Status | Questions | Requests | Elapsed ms | Context ms | Model ms | Actual tokens | Estimated input tokens | Failure stage | Alerts |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| schedule | generation | complete | 20 | 1 | 108180 | 210 | 107626 | 63806 | 63992 | none | none |
| requests | generation | complete | 20 | 1 | 127848 | 694 | 126833 | 68157 | 63992 | none | none |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

本轮 Python 子集共 40 题、2 次真实调用；主代理已阅读全部答案和追问，并将逐事实判断与具体错误绑定到原问题指纹。两例加权检索改善后的完整四例观察见[显式来源汇总](../2026-10-24-weighted-cohort-v1-deepseek-v4-flash/report.md)，其中完整事实覆盖 22/28，仍未通过与旧生产组 23/28 的回归检查。原始输出和用量保留，不用后续结果覆盖。
