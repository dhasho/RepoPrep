# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 314d1677-7aee-4e7a-a56e-2000fadcc21c
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
| requests | generation | complete | 20 | 1 | 219279 | 807 | 218096 | 84977 | 63934 | none | known_fact_keyword_missing |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 单例筛查结论

本轮只执行 Requests：20 题、1 次实际模型请求，无修复或补偿。逐事实源码复核为完整 3/8、部分 3、缺失 2、矛盾 0，与上一轮完整覆盖 3/8 持平；另记录 1 类实质错误、2 条不精确表述。会话合并由缺失改善为部分覆盖，但 Response.ok 从部分覆盖变为缺失，认证 hooks 的错误推断仍存在。详见 [复核明细](assistant-review-requests.json)。

| 条件 | 输入 tokens | 输出 tokens | 总 tokens |
|---|---:|---:|---:|
| 2026-10-24 grounded | 42508 | 18346 | 60854 |
| 2026-11-01 scoped | 42428 | 35765 | 78193 |
| 本轮 low | 42209 | 42768 | 84977 |

本轮总用量比 scoped 增加 8.68%，比 grounded 增加 39.64%；没有证明质量或成本收益，未继续其余三次计划调用。本次显式请求 low 推理强度，但低强度不保证少用 token。不同推理条件、提示与上下文变化并存，不能把差异单独归因于调用链选择或推理强度。以上是 Requests 单例对照，不能外推四例总量或货币账单；原报告引用见 [case-comparison.json](case-comparison.json)。

测量源码为 `dcd457dc1ad5fe998b787bf76496cd37b635689d`，105 份源码哈希、冻结副本和合成捕获的实际请求体哈希已核对。生产客户端与传输观察器均保留相同完整 provider usage。用户设置、备份和 Local State 的前后哈希一致。设置 UI→公有回读→加密保存→受守卫 IPC→生产请求已经过真实 Electron 流程验证，其他检查见 [provenance.json](provenance.json)。复核为代理辅助，人工状态仍 pending；整体改进目标保持进行中。
