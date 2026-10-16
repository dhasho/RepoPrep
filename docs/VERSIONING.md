# 版本管理

RepoPrep 是单个 npm 包，使用 SemVer `MAJOR.MINOR.PATCH`。根目录 `package.json` 的 `version` 是产品版本的权威来源；`package-lock.json` 顶层 `version` 与 `packages[""].version` 必须同步。

## 合并前的版本政策

每个准备合并到 `main` 的 PR 都提升一次版本，包括文档、修复和重构（`patch`）。新增向后兼容功能使用 `minor`；破坏兼容契约或数据格式的变化使用 `major`。项目处于 `0.x` 时也按此政策区分变更级别；破坏性变化须在 PR 中说明升级影响和迁移步骤。

使用 npm 内建命令在仓库根目录更新版本，不增加专用脚本、不运行生命周期脚本、不创建 Git tag：

```powershell
npm version patch --no-git-tag-version --ignore-scripts
npm version minor --no-git-tag-version --ignore-scripts
npm version major --no-git-tag-version --ignore-scripts
```

只运行与本次改动相符的一条命令。npm 会更新 `package.json` 和 `package-lock.json`；完成后检查三处版本都相同。不要复用已被目标分支使用的版本，不要降低版本，也不要只改其中一处。

## 人工复核

当前仓库没有自动版本检查脚本或已提交的 CI 定义，版本规则由人工复核。先查看三处版本是否一致：

```powershell
node -e 'const p=require("./package.json"), l=require("./package-lock.json"); console.log(JSON.stringify({package:p.version, lock:l.version, lockRoot:l.packages[""].version}, null, 2)); if (p.version !== l.version || p.version !== l.packages[""].version) process.exitCode=1'
```

查看目标基准版本：

```powershell
git show origin/main:package.json
```

人工确认当前版本是合法 SemVer，三处值完全一致，并且严格高于目标基准版本。比较数值段（先 MAJOR，再 MINOR，再 PATCH），不要用字符串字典序比较；例如 `0.10.0` 高于 `0.9.0`。如目标分支包含预发布版本，也应按 SemVer 规则核对。

并行 PR 可能基于相同旧版本。合并前刷新目标分支和基准版本，再选择一个严格高于最新基准的版本并更新 PR；最终 review 应绑定实际待合并的 head commit。当前仓库没有统一版本检查脚本或已提交的 CI workflow，版本规则按本文的人工步骤落实；远端分支保护和版本门禁以平台设置为准。

本地草稿阶段可以暂不 bump。准备合并 PR 时，按本文件的级别选择和复核步骤提升版本。创建 tag、发布或推送需另行获得对应授权；版本更新本身不自动执行这些操作。
