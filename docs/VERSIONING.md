# 版本管理

RepoPrep 是单个 npm 包，使用 SemVer `MAJOR.MINOR.PATCH`。根目录 `package.json` 的 `version` 是产品版本的唯一来源；`package-lock.json` 顶层 `version` 与 `packages[""].version` 必须与它同步。

## 何时确定版本

版本在准备发布时确定，不是每次变更合入 `main` 都要 bump：

- 同一个待发布迭代内的多次代码提交、修复或随附文档变更，可以保持相同版本；不必因每个 commit 或 PR 机械升级。
- 准备发布时按自上一发布以来的整体变化选择级别：新增向后兼容功能用 `minor`，破坏兼容契约或数据格式的变化用 `major`，其余用 `patch`。
- 发布版本必须是合法 SemVer，且高于上一个已发布版本（比较数值段 MAJOR→MINOR→PATCH，不用字符串字典序；`0.10.0` 高于 `0.9.0`，含预发布时按 SemVer 规则核对）。纯文档、协作规则、模板等不影响产品的改动不触发版本变化，也不要求与目标分支比较版本。

## 操作与复核

在仓库根目录用 npm 内建命令更新版本（不增加专用脚本、不运行生命周期脚本、不创建 tag），只运行与本次发布级别相符的一条：

```powershell
npm version patch --no-git-tag-version --ignore-scripts
npm version minor --no-git-tag-version --ignore-scripts
npm version major --no-git-tag-version --ignore-scripts
```

npm 会同时更新 `package.json` 和 `package-lock.json`。完成后确认三处版本一致：

```powershell
node -e 'const p=require("./package.json"), l=require("./package-lock.json"); console.log(JSON.stringify({package:p.version, lock:l.version, lockRoot:l.packages[""].version}, null, 2)); if (p.version !== l.version || p.version !== l.packages[""].version) process.exitCode=1'
```

当前没有自动版本检查脚本或已提交的 CI 门禁，以上规则由人工在发布检查中复核；远端分支保护以平台设置为准。
