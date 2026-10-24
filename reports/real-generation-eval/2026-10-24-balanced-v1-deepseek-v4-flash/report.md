# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: e03c5a43-ad43-4c04-b410-8693f2725ee6
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
| mitt | generation | complete | 20 | 1 | 126362 | 81 | 126242 | 35754 | 14028 | none | none |
| p-limit | generation | complete | 20 | 1 | 168250 | 118 | 168107 | 48296 | 26471 | none | none |
| schedule | generation | complete | 20 | 1 | 110283 | 155 | 109878 | 65884 | 62770 | none | none |
| requests | generation | complete | 20 | 1 | 176889 | 524 | 176082 | 78709 | 63975 | none | known_fact_keyword_missing |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 本轮状态与后续修正

本轮使用 64k 中粒度输入预算，4 个项目共 80 题、4 次真实调用。相对于旧生产组，输入 token 少 25.24%，总 token 少 12.21%；输出 token 多 4.49%，总耗时多 0.98%。这不证明货币成本或速度改善，也不能单独证明回答质量提高。

已完成 mitt、p-limit 的源码复核：完整覆盖 13 条核心事实，发现 1 条实质错误。Python 两例的检查进一步暴露了通用代码单元选择缺陷：多行声明的闭括号被误当作结束，函数体可能被省略却标记为完整。因此本轮 Python 输出保留作诊断记录，不作为修复后版本的结果。`assistant-review-summary.json` 如实保留未完成的两例；后续修复及重新生成须记录在新的报告中。

若修复后的 JavaScript 请求体与本轮逐字节相同，可以在单独的 cohort 汇总中明确复用这两例实测；原始运行时间、调用和输出仍属于本轮，不能重标为新调用。Requests 已用于问题诊断，后续属于回归样本；所有代理复核均不等于人工盲审。
