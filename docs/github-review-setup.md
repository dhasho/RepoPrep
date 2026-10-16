# GitHub Review 配置

云端 review 在 Codex/GitHub 连接设置中启用，仓库规则由 [`AGENTS.md`](../AGENTS.md)、[`docs/review.md`](review.md) 与 `.github` 模板提供。平台是否已启用以及授权范围应以 Codex 设置和 GitHub 当前状态为准。

1. 在 Codex 的 GitHub 连接中授权 `dhasho/RepoPrep`。
2. 在 Codex Settings 选择该仓库，启用 **Review code / Code review**。需要自动审查所有 PR 时，在 **Automatic review** 中选择 **All PRs**；采用 **Follow personal preferences** 时，同时核对个人的 **Automatic review** 与触发设置。
3. 打开该仓库的 PR 评论，发送 `@codex review`。
4. 检查 review 的 reaction/状态及其 `Reviewed commit`，确认它对应当前 PR head；新提交后重新触发 review。

仓库中的 `## Code Review Rules` 提供项目审查重点，平台负责触发和发布 GitHub review。当前官方说明 GitHub review 聚焦 P0/P1；项目的 P2/P3 分级仍用于人工和本地审查。普通云端 review 不要求额外创建云端开发环境。

官方说明：[GitHub review 配置](https://learn.chatgpt.com/docs/third-party/github)、[Code review](https://learn.chatgpt.com/docs/code-review)。
