# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 835a902a-59ce-4880-a279-f8ff7abec2b2
- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash
- Status: complete
- Human review: pending
- Context window setting: 1000000
- Configured output cap: provider controlled
- Reasoning effort: low
- Application input budget: 64000 estimated tokens
- Reserved output: 65536 tokens (deepseek-reasoning-reserve-65536)

| Case | Variant | Status | Questions | Requests | Elapsed ms | Context ms | Model ms | Actual tokens | Estimated input tokens | Failure stage | Alerts |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| mitt | generation | complete | 20 | 1 | 115719 | 96 | 115584 | 31464 | 14570 | none | none |
| schedule | generation | complete | 20 | 1 | 138794 | 176 | 138428 | 68756 | 63997 | none | none |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 源码复核与范围

本运行只包含 mitt 与 schedule，共 40 题、2 次真实 HTTP 调用，无修复或补偿。107 份源码哈希与 Requests 新候选完全一致；请求体与零网络审计逐一匹配。mitt 完整覆盖 6/6，但仍有 4 类实质错误（falsy handler、泛型数字键、handler 参数位、npm-run-all 分组）；schedule 完整覆盖 7/7，Hashable/tuple 边界作为非阻断说明保留。完整覆盖不能当作所有答案正确。逐项引用见各 case sidecar，汇总见 [assistant-review-summary.json](assistant-review-summary.json)。

实际用量 mitt 为 31,464 tokens，schedule 为 68,756 tokens，合计 100,220；这是这两项生成的 provider usage，不是整轮研究账单。低推理强度可能引入不同输出，不能把变化单独归因于上下文节选。未执行上游项目或脚本；npm-run-all 调度语义另外核对了 [官方文档](https://github.com/mysticatea/npm-run-all/blob/master/docs/npm-run-all.md)，没有安装或运行它。

本目录不是一次四例运行，也不包含 p-limit。代理辅助复核非独立人工盲审，人工状态仍 pending。
