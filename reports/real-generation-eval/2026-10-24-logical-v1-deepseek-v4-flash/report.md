# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 37bf2ccb-3aa0-473a-9e4a-4b712cdbf1d1
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
| schedule | generation | complete | 20 | 1 | 116483 | 170 | 115902 | 65236 | 63966 | none | none |
| requests | generation | complete | 20 | 1 | 114672 | 647 | 113634 | 64865 | 64000 | none | known_fact_keyword_missing |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 修复结果与质量判断

本轮只重新生成 schedule、Requests 两例，共 40 题、2 次真实调用，修复了 Python 多行声明和装饰器的单元边界。主代理阅读全部答案与追问并核对源码，15 条冻结事实完整覆盖 5 条、部分 5 条、缺失 5 条；另记录 1 条实质错误和 1 条表述不精确。复核文件保留题目指纹及源码行号，属于代理辅助复核，人工盲审仍未完成。

schedule 的 `until()` 参数转换等实现已恢复，但 Requests 的早期核心请求流程仍被预算省略。问题转为有限预算下文件重要性分配不足。此轮作为诊断记录保留，继续改进通用上下文分配；不能因函数边界修好、生成成功或 token 下降就宣布质量通过。完整四例的显式来源汇总见[cohort 报告](../2026-10-24-logical-cohort-v1-deepseek-v4-flash/report.md)。
