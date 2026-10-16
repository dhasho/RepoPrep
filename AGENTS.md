# RepoPrep 协作入口

- 用户当前任务中的显式要求优先于本文件的项目默认规则。开始 coding task 前确认当前目录属于哪个 Git 仓库；属于仓库时先记录当前分支和工作区状态，再尝试 `git pull --ff-only`。拉取失败或有本地改动时先判断影响，不覆盖用户内容。
- 主代理负责架构规划、验收标准和最终审查；计划完成后按模块委派给 `gpt-6-luna` 子代理。多代理开发使用隔离 worktree；依赖明确后可并行。完成后由主代理整合审查，并让主工作目录回到 `main`。
- 新分支默认使用 `codex/` 前缀。Git 提交及 GitHub 操作使用 `dhasho` 身份，执行前核实配置身份。
- worktree 缓冲目标为 5–10 个，上限 10 个。超限时优先清理较旧且不活跃的干净 worktree；保留其分支和提交。含未提交、未推送或必要 ignored 内容时，先保存可恢复副本；不得强制丢弃。
- 规范权威入口：协作入口见本文件；架构与职责见 [`docs/project-standards.md`](docs/project-standards.md)；代码审查见 [`docs/review.md`](docs/review.md)；验证命令见 [`docs/validation.md`](docs/validation.md)；版本策略见 [`docs/VERSIONING.md`](docs/VERSIONING.md)。发生冲突时以对应主题的专门文档为准。
- 规则描述的是必须遵守的目标，不代表现有代码已实现。改代码前确认实际实现与脚本，再按文档要求验证。

## Code Review Rules

Review 是只读审查：不要求 coding 流程中的 `git pull`、新 worktree、版本升级或指定子代理执行。按 [审查约定](docs/review.md) 和 [项目规范](docs/project-standards.md) 检查实际 diff、调用路径与可复核证据；范围仅限本次变更影响的路径，不为机械检查或凑数量制造 finding。云端 review 无需复现仓库自定义模板，也无需罗列所有 P2/P3。

- IPC 路径核对发送方、运行时 schema 与项目授权是否统一守卫；API Key 等凭证不得进入日志、错误、结果或导出。
- 题量以 `shared/types.ts` 的预算为准，检查分配、合并、README/UI 承诺一致；扫描快照、过滤内容与缓存复用应保持一致。
- 核对取消、重复请求及迟到事件的生命周期，确保旧请求或旧事件不能覆盖当前 UI 状态或保存结果。
