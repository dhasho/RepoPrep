# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: ee69a921-05fe-4d8d-bf44-2ba4bc72ee21
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
| mitt | generation | complete | 20 | 1 | 179983 | 86 | 179863 | 44150 | 14045 | none | none |
| p-limit | generation | complete | 20 | 1 | 121986 | 89 | 121878 | 35241 | 26488 | none | none |
| schedule | generation | complete | 20 | 1 | 161414 | 123 | 161096 | 73291 | 63993 | none | none |
| requests | generation | complete | 20 | 1 | 93818 | 429 | 93143 | 60854 | 64000 | none | known_fact_keyword_missing |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 源码复核与对比

本轮四例全部新生成，共 80 题、4 次实际 HTTP 调用，无格式修复或补偿调用。相同模型、协议、温度、项目提交和题量条件下，输入 token 为 109,577（旧生产组 146,247），输出 103,959（旧 114,186），合计 213,536（旧 260,433）：输入少 25.07%，合计少 18.01%。对比只使用旧报告的 generation 组，不混入 README 对照；见 [comparison.md](comparison.md)。token 减少不等于货币账单降幅。

主代理读取全部答案与追问，逐项核对 28 条冻结事实：完整 23、部分 2、缺失 3、矛盾 0；旧生产组为完整 23、部分 2、缺失 2、矛盾 1。完整覆盖回归门槛已恢复，但不表示所有答案准确。复核仍记录 3 条实质错误与 5 条不精确表述，包括 TypeScript 约束、finally、调度周期反事实和 hooks 顺序等；详见 assistant-review-summary.json 和各 case sidecar。

复核为代理辅助，非独立人工盲审，也不是全部答案准确率。四例均已用于诊断，Requests 属于回归样本；本轮只能作为整版观察，不能分离归因或宣称对任意项目普遍提升。所有问题指纹、源码范围、真实回执及早期未通过实验均保留。语言控制示例使用本机 TypeScript 5.9.3，未执行上游项目的 4.9 构建。

## 实现与验证范围

评测对应生产源码提交 `f392db2f9715dcf2ec7110f5ee6248c1fed3110b`，92 份源码哈希与运行快照逐一一致。桌面与评测共用生成核心：JS/TS 使用已有 TypeScript 解析器，Python 使用逻辑行与缩进启发式；按入口、引用、配置及模块覆盖分配预算，收紧预算时保留完整代码单元。可选上下文和输出上限贯穿设置、IPC 与持久化，结果页和 Markdown 显示实际范围、输入估算及服务商用量。当前 token 变化来自本轮整版实现与输出，不能归因为某个单独模块。
