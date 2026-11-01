# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: c87cf61f-cacd-4e5f-821f-be1471372856
- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash
- Status: complete
- Human review: pending
- Context window setting: 1000000
- Configured output cap: provider controlled
- Application input budget: 64000 estimated tokens
- Reserved output: 65536 tokens (deepseek-reasoning-reserve-65536)

| Case | Variant | Status | Questions | Requests | Elapsed ms | Context ms | Model ms | Actual tokens | Estimated input tokens | Failure stage | Alerts |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| mitt | generation | complete | 20 | 1 | 260689 | 127 | 260499 | 60359 | 14462 | none | none |
| p-limit | generation | complete | 20 | 1 | 201616 | 155 | 201421 | 52492 | 26905 | none | none |
| schedule | generation | complete | 20 | 1 | 118371 | 204 | 117817 | 63795 | 63993 | none | none |
| requests | generation | complete | 20 | 1 | 191815 | 595 | 190885 | 78193 | 63947 | none | none |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 源码复核与用量观察

四例全部新生成，共 80 题、4 次 HTTP 调用，无格式修复或补偿。逐项源码复核为完整 23/28、部分 3、缺失 2、矛盾 0；完整覆盖与上轮 23/28 持平。另记 4 类实质错误、4 条不精确表述；重复出现在同一道题的同一主张只计一类并保留所有位置。类型参数、异常先后与认证分支仍有错误，不能把核心覆盖通过解释为答案全部正确。见 [复核汇总](assistant-review-summary.json) 及逐 case sidecar。

上轮输入/输出/总 token 为 109,577 / 103,959 / 213,536，本轮为 109,986 / 144,853 / 254,839：输入 +0.37%，输出 +39.34%，总计 +19.34%。这轮没有证明质量或成本收益；保留 2026-10-24 grounded 运行作为较低用量的参考。对比见 [comparison.md](comparison.md)。token 不是货币账单，当前观察不能单独归因于作用域标记；与上轮之间还包含流式生成等生产变更。

测量源码为 `f99291570bce4baf4f776a0eb50df0009323018d`，105 份源码哈希已逐一核对并冻结。无网络的生产请求捕获与本轮四个真实请求体哈希完全对应；两个 Python 项目的摘录包含限定作用域，全部文件可容纳时原文不变。长 SSE 在本轮触发旧观察器整体 1 MiB 上限，因此原始 transport usage 保留为 null；实际用量来自生产客户端已保存且标为 complete 的 provider 记录。随后修复观察器为逐事件有界解析，并通过 54 项合成/原生评测回归，未为补回执额外发起付费请求。测量与后续修复的两份脚本哈希明确区分，见 [provenance.json](provenance.json)。

三位 GPT-6 Luna 模块执行者读取全部主答案与嵌套追问，主代理复核全部冻结事实结论、保留的错误及产物绑定；这是非盲的代理辅助复核，人工状态仍为 pending。四例均已参与诊断，不能外推为普遍准确率。用户设置、备份与 Local State 的运行前后哈希一致。
