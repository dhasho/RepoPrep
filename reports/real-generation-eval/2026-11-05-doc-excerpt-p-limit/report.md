# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 00032e42-668d-40c6-ae6f-1937906571f2
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
| p-limit | generation | complete | 20 | 1 | 181918 | 195 | 181660 | 49513 | 27013 | none | none |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 源码复核

20 道主问题和 60 条追问已完成代理辅助复核，7/7 核心事实均完整覆盖；另记 2 类实质错误：Q4 把 files 白名单误写成发布包全部内容，Q10/Q12/Q13 将存在 pending 输入错误推广为 Promise.all 必然永不结算（重复机制只计一次）。后者用隔离的原生 Promise 探针复核，未执行上游代码。语义依据分别见 [npm files 官方文档](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#files)与 [ECMAScript Promise.all 规范](https://tc39.es/ecma262/2026/multipage/control-abstraction-objects.html#sec-promise.all)。逐项指纹、引用和限制见 [assistant-review-p-limit.json](assistant-review-p-limit.json)。

本例实际用量 14,851 输入、34,662 输出、合计 49,513 tokens；1 次 HTTP，无格式修复或补偿。请求哈希与合成捕获相同，107 项源码哈希与其他三例一致，原设置及备份未改动。这是额外明确授权的一次调用，研究累计 5 次；不将 token 用量换算为货币费用。人工复核仍为 pending。
