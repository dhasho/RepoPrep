## 问题与最终行为

**问题 / 需求：** 说明触发场景、当前问题或关联 issue。

**最终行为：** 描述用户可观察到的变化，以及如何满足验收标准。

## 范围与约束

**改动范围：** 列出主要模块、数据路径或界面。

**约束与非目标：** 说明保持的安全/架构边界，以及明确不在本次处理的内容。

**依赖与合并顺序：** 关联 issue、依赖 PR；无则写“无”。

## 版本

- 变更后的 `package.json` 版本：`<version>`
- 目标 base 分支及版本：`<branch> @ <version>`

说明新版本为何高于目标分支；规则见 [docs/VERSIONING.md](https://github.com/dhasho/ProjectLens/blob/main/docs/VERSIONING.md)。

## 验证结果

填写实际执行的命令、结果和环境。只保留适用项，不要默认标记通过。

| 检查 | 命令 / 场景 | 结果与说明 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 未运行 / 通过 / 失败；说明 |
| 安全 | `npm run test:security` | 未运行 / 通过 / 失败；说明 |
| IPC | `npm run test:ipc` | 未运行 / 通过 / 失败；说明 |
| 扫描缓存 | `npm run test:scan-cache` | 未运行 / 通过 / 失败；说明 |
| 题量预算 | `npm run test:question-budget` | 未运行 / 通过 / 失败；说明 |
| 构建 / smoke | 按验证指南选择 `npm run build` 或 `npm run test:smoke` | 说明结果；smoke 只代表其覆盖范围。安全与 smoke 命令内部会构建，避免重复运行构建 |
| 其他 / 手工步骤 | 按 [docs/validation.md](https://github.com/dhasho/ProjectLens/blob/main/docs/validation.md) 选择 | 未运行 / 通过 / 失败；说明 |

**失败或跳过：** 写明原因及受影响结论；没有则写“无”。

**证据边界：** 说明 mock、smoke、手工验证、真实模型/API、安装态或用户流程实际覆盖到哪里；不要把 mock 当成真实 API 验收，也不要把 smoke 当成完整安装或端到端验收。

## Review 处理

**作者自检：** 简述检查的真实调用路径与发现。

**独立主代理审查：** 待审 / 已完成；审查结论与 Reviewed commit：`<填入或待审>`。

**外部意见及处理：** 关联 finding、修复 commit 和验证；未解决项说明理由、风险及后续 issue。没有意见时写“无”。
