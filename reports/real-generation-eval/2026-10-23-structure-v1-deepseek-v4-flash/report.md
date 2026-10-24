# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 04cc5679-1e4b-4fb5-a724-1e7fe9ff1548
- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash
- Status: complete
- Human review: pending
- Context window setting: unknown
- Configured output cap: provider controlled
- Application input budget: 32000 estimated tokens
- Reserved output: 65536 tokens (deepseek-reasoning-reserve-65536)

| Case | Variant | Status | Questions | Requests | Elapsed ms | Context ms | Model ms | Actual tokens | Estimated input tokens | Failure stage | Alerts |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| mitt | generation | complete | 20 | 1 | 148181 | 102 | 148030 | 38538 | 14028 | none | none |
| p-limit | generation | complete | 20 | 1 | 167408 | 147 | 167231 | 45137 | 26471 | none | none |
| schedule | generation | complete | 20 | 1 | 98018 | 190 | 97642 | 38165 | 31997 | none | none |
| requests | generation | complete | 20 | 1 | 147388 | 495 | 146679 | 48607 | 31927 | none | known_fact_keyword_missing |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

<!-- source-fact-audit-32k -->
## 源码事实复核与默认策略判定

本轮为 32k 中粒度输入预算实验，共 80 题、4 次真实调用。与旧生产组相比，总 token 少约 34.6%，但冻结事实仅完整覆盖 14/28；部分 6、缺失 7、矛盾 1。记录实质错误 3 条、表述不精确 2 条。这些计数不是全部答案的正确率，也不是独立人工盲审。

该默认策略未通过覆盖回归检查。原始问题、API 回执、review-template 和四份 ZCode 原始复核均保留；主代理裁定见 assistant-review-summary.json 及各 case 的 primaryAudit。后续提高通用预算，并定位到 Python 多行声明的单元边界缺陷，继续单独修复。不能把本轮的用量下降宣称为质量提升。

Requests 在本轮后用于诊断，之后作为回归样本，不再称为未见过的独立 holdout。总 token 降幅也不等于货币账单降幅，报告未包含服务价格或缓存折扣。
