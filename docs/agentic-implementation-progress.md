# Agentic 重构实施账本

日期：2026-11-06。数值标准沿用 [PLAN.md](../PLAN.md) v1.1 第 11 节；评审人员来源按 v1.3 和用户授权改为独立子代理。**P0、P1 最小静态链路及 P2 模块门禁已通过，继续实施 P3；完整 M11、真实质量验收及默认策略切换尚未完成。**

## 工作包与边界

| 工作包 | 关联目标 | 输入 → 输出 | 状态与证据 |
| --- | --- | --- | --- |
| 验收基线 | G4/G5、P0、M13 最小实现 | PLAN 数值、`9ef10ca` → manifest v2、代理 rubric、任务/标注、四个保留集 SHA、fail-closed runner | P0 通过；并非 M13 真实质量门禁通过 |
| 运行契约 | G2/G6、M01 | 不可信公开配置 → 不可变 RunSpec、题量、配置指纹和预算预留 | 实际断言覆盖 12 类非法输入；`verify:agentic:m01` 单独验收 |
| 静态上下文边界 | G2、P1 | 原授权 ScanResult → 原 BuiltContext | static adapter 委托原 builder；没有增加 renderer/IPC 能力 |
| Metadata trace | G3/G4、M11 最小实现 | 主进程阶段、最终 dispatch、usage → 内存事件 | 不落源码、prompt 或凭据；缺证据链时明确 unavailable；完整 M11 仍未完成 |
| 静态链路接入 | G2/G6、P1 | 原生成请求 → 原题答、原 checkpoint，加可选观测 | 对照测试核对实际消息、正文、题量和保存记录；trace 失败不能改变任务结果 |
| 快照与证据池 | G2/G3/G6、P2、M02/M03 | 批准扫描 → 不可变快照/能力 → 程序签发的证据 ID | 8项快照、7项证据门禁通过；失效、伪造、重叠、容量与脱敏定位按实际断言检查 |
| 预算与工具 | G2/G4/G6、P2、M04/M05 | 受限动作/调用 → 脱敏证据与保守账本 | 37项工具、12种账本序列通过；实际 M02/M03/M05 组合验证缓存和8次工具上限 |

实现文件限定于 `electron/services/workflow/`、生成器接缝、`scripts/agentic/`、对应测试及实施文档。没有依赖更新、凭据迁移、持久化版本变更或真实模型调用。共享文件由主代理串行整合，模块实现和复核由 Luna 子代理在隔离 worktree 完成。

## P0 已冻结的资产

- 12 个 `development-synthetic` 项目，20 个检索任务及必要证据组，包含各语言、跨文件、继承/回调、条件/异常、配置差异和索引失败覆盖。
- 12 个充分证据题答任务（Python/JS/TS 各 4 个），以及独立固定的源码证据。
- 40 个错误样本、40 个正确样本和 20 个独立修订样本及代理标注。
- 两个不继承实现/作者标签上下文的评审代理，各逐项审阅全部80个题答；第三个代理处理65处评分分歧并复核20/12/20项标注。五处初次证据缺口已修正，失败记录和修订前版本保留。
- 四个固定 SHA 的真实保留集及48条复合事实，标注代理单独读取源码；实现代理不接收事实清单。只读校验器核对真实工作树、远端身份、文件与范围哈希。

新保留集为 `encode/httpx`、`pallets/itsdangerous`、`caolan/async`、`colinhacks/zod`。源码仅供独立数据代理标注和只读哈希校验，没有用于实现调参。原四仓继续作为开发回归集。尚无真实生成质量、token 或延迟对照成绩；未调用用户配置的外部模型端点。代理标注/评审的底层 token 收据不可得，成本记为 unknown，不补零，不计作生产运行 usage。

## 契约决策

RunSpec 的配置指纹排除 run/project/snapshot 身份，身份另存，不能用配置指纹代替项目授权或快照验证。题量仍只来自 `GRANULARITY_QUESTION_BUDGET`。

新契约的实验性总读取上限为 8 MiB，可配置为更小的非负数。它是独立的全局上限，取值参考现有扫描器允许的最大单文件大小，**不是原实现已有总读取限制**。M05 已实现新工作流的预留/结算，M04 在实际文件读取前预留原文件字节；调查受2 MiB/8工具/180秒约束。尚未替换生产 static 路径，不能据此声称旧生成器已经受新全局账本保护；未来对照必须明确配对读取条件。

Trace 目前只在本次进程内存中存在，可由主进程显式注入；尚无生产 trace 落盘。保留 20 次/7 天/100 MiB 的策略只已冻结在 manifest，尚未实现清理服务。Replay 字段描述输入可用性，没有执行重放；M11 的完整 required spans 和 replay gate 保持未通过，不缩小分母。

## 验证与回退

验证记录包含新工作流定向测试、runner 自测、M01 gate、既有题量/IPC/恢复回归、typecheck 和 Electron smoke。具体命令、数量、失败记录及最终门禁报告见本次 PR 与 `.validation/agentic/`；每个 gate 绑定当时源码、配置和数据指纹。

| 命令 | 本次结果 |
| --- | --- |
| `npm run typecheck` | Node/Web 均通过 |
| `npm run test:agentic` | 99/99 通过（加入快照、证据、工具、模型网关和账本边界） |
| `npm run test:agentic:holdout` | 正常本机权限下7/7通过、0 skip，包含实际链接逃逸拒绝 |
| `npm run verify:agentic:p0` | 11项必需检查通过，failed/missing/skipped/unknown均为0 |
| `npm run test:question-budget` | 118/118 通过 |
| `npm run test:ipc` | 270/270 通过（含 fetch 前阻断/取消） |
| `npm run test:recovery` | 34/34 通过 |
| `npm run test:smoke` | `VERDICT SMOKE-OK`、退出 0、runner 确认隔离目录已删除 |
| `npm run test:security` | 构建通过；77通过、0失败、3项既有平台跳过 |
| `npm run test:scan-cache` | 补齐既有命令的导入解析注册器后60通过、0失败、2项既有平台跳过；M02独立门禁的8项均无skip |
| `npm run test:file-selection` | 102/102通过 |
| `npm run verify:agentic:m01` | 15 个必需 check 通过，其中非法输入 12/12 拒绝；四类失败计数为 0 |
| `npm run verify:agentic:m02`、`npm run verify:agentic:m03`、`npm run verify:agentic:m04`、`npm run verify:agentic:m05` | 8/7/37/12项通过，失败/缺失/跳过/未知均为0 |
| `npm run verify:agentic:m11` | 预期 incomplete/退出 1；完整证据链和重放未交付 |
| `npm run verify:agentic:m13 -- --mode real` | 预期 blocked/退出 1；未授权调用，未访问模型端点 |

首次普通沙箱下的 IPC/恢复测试遇到临时目录重命名及 loopback 权限失败，Electron 也未输出成功 verdict；失败日志保留。在正常本机权限下使用合成凭据和本地 HTTP 重跑，通过不等于真实服务验收。

回退时移除 `contextProvider`/`workflowTrace` 注入即沿原 static 路径运行。没有默认策略变更或旧数据重写；如需撤销新代码，可回退本 PR 的提交。P2 必须通过 M02–M05 门禁后才进入 P3；代理评审不替代真实控制器/生成器的运行和 usage 收据。
