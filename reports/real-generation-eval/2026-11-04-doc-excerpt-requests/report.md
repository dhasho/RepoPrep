# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 0a84cfe5-0b30-41e0-8ff7-4e30328f9d02
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
| requests | generation | complete | 20 | 1 | 112336 | 729 | 111335 | 63277 | 63878 | none | known_fact_keyword_missing |

Actual token usage is unknown when provider usage receipts are incomplete. Estimated input tokens are application estimates and are not provider usage.
Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

零网络上下文证据见 [context-audit.json](context-audit.json)，包含四个固定公开仓库的 dispatch 区域与哈希，不含源码正文或完整请求，也不评价答案质量。[prompt-template-proof.json](prompt-template-proof.json) 记录前后提示词模板的语法节点哈希；实际项目上下文已改变。两份证据的文件哈希见 [provenance.json](provenance.json)。

## 源码复核与同条件对照

20 道主问题与全部 44 条追问已逐项源码复核。冻结复合事实为完整 5/8、部分 1、缺失 2，上一轮为完整 3、部分 3、缺失 2；新增完整覆盖会话请求设置合并和环境配置合并。Response.ok/布尔与重定向上限仍缺失。另记 2 类实质错误和 2 条不精确表述：认证 hooks 丢失推断、请求 cookie 的类型转换与合并路径、Response.next 的 property/method 混淆、chunk_size=None 例外。比上一轮多一类实质错误，不能把覆盖提升当作所有答案更准确。见 [逐项复核](assistant-review-requests.json)。

模型、出题提示词规则、low 推理强度（项目上下文正文已变）、上下文窗口及输出策略与 run `314d1677-7aee-4e7a-a56e-2000fadcc21c` 相同。实际输入 42209→42465（+0.61%），输出 42768→20812（-51.34%），合计 84977→63277（-25.54%）。输入估算仍单独记录，不冒充 provider usage；token 也不是货币账单。这是单次同条件观察，不能分离归因或外推通用准确率。见 [comparison.md](comparison.md)。

107 份生产/评测源码与冻结副本、真实请求体与零网络审计哈希均已核对；传输观察器与生产诊断保留相同完整用量。节选显式不完整，只改变确认的文档字符串内容；__doc__ 的完整值不能从节选恢复。其余三仓的合成请求体逐字节不变，本目录未为它们发起真实调用。源与检查边界见 [provenance.json](provenance.json)。本复核为代理辅助，非独立人工盲审，人工状态仍 pending。
