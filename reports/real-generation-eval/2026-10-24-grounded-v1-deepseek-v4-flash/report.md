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

评测对应生产源码提交 `f392db2f9715dcf2ec7110f5ee6248c1fed3110b`，92 份源码哈希与运行快照逐一一致。桌面与评测共用生成核心：JS/TS 使用已有 TypeScript 解析器，Python 使用逻辑行与缩进启发式；按入口、引用、配置及模块覆盖分配预算，收紧预算时保留完整代码单元。可选上下文和输出上限贯穿设置、IPC 与持久化，结果页和 Markdown 显示实际范围、输入估算及服务商用量。

最终类型检查通过；源码选择 79/79、题量及 token 预算 90/90、真实评测工具 44/44、设置等纯逻辑 44/44 通过。IPC 241/241、renderer 141/141 的已有验证覆盖范围在后续提交中未变。安全检查 77 项通过，跳过 2 项 POSIX 路径语义检查及 1 项本机无法创建文件符号链接的检查。独立 Electron 流程验证扫描、配置、取消后无保存、重试、历史、后台生成时切换项目及导出；使用实际构建与守卫 IPC，模型为本地合成 HTTP，交互为 DOM 事件，不等同于原生鼠标验收。

曾有一次与构建同时进行的工作流在扫描授权处停止，原失败记录保留，原因未确定；同一最终构建独立运行通过，未放宽授权守卫。Windows 包内主进程、preload、renderer、TypeScript 5.9.3 与 IPC 冒烟通过，安装包有效载荷 CRC 和 EXE/ASAR 恢复哈希通过。安装包未安装到用户系统。另在全新隔离目录以锁文件离线安装 118 个生产依赖并验证解析器；该次跳过生命周期脚本，Electron 运行与打包另行验证，未替换当前依赖或用户设置。

本轮没有新增 LangChain/LangGraph 依赖。后续若需要跨重启恢复、人工检查点或按证据缺口补取，再按[架构准则](../../../docs/project-standards.md)评估引入；当前 token 变化来自本轮整版实现与输出，不能归因为某个单独模块。
