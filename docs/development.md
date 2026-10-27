# 开发指南

## 环境

- 使用 Node.js `^22.15.0 || >=24.0.0`（本地开发建议 24.x）；在仓库根目录 `npm ci` 按 `package-lock.json` 安装依赖。
- `npm run dev` 在 `http://127.0.0.1:5186/` 启动开发应用，renderer 的 HMR 使用同一端口。该端口配置了 `strictPort`，被占用时启动直接失败：先确认并释放端口，或修改 `electron.vite.config.ts` 的 `renderer.server.port`；不要直接结束身份不明的占用进程。
- `npm run build` 构建主进程、preload 与 renderer；`npm run dist` 重新构建并用 electron-builder 生成 Windows 安装包。
- `npm run preview` 默认先构建再启动生产预览；若已有最新构建，可用 `npm run preview -- --skipBuild` 直接启动。
- `npm run typecheck` 执行 Node/Electron 与 Web 两套 TypeScript 检查。其他测试命令和适用范围见[验证指南](validation.md)。

## Electron 二进制

Electron 42 起二进制在首次通过 Electron CLI 运行时按需下载（例如 `npm run dev`），默认缓存位于 `%LOCALAPPDATA%\electron\Cache`。手动下载：

```bash
node node_modules/electron/install.js
```

electron-builder 打包时管理自己的辅助二进制下载。网络环境需要镜像时，按需临时设置环境变量（npmmirror 示例）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="<镜像服务地址>"
```

镜像通过上面的环境变量设置即可，不要在 `.npmrc` 写 `electron_mirror` 等旧式配置键；`.npmrc` 内的说明以本节为准。

## 打包注意

- 主进程构建产物在运行时会 `require` 生产依赖（当前包括解析 `.gitignore` 用的 `ignore` 和源码分析用的 `typescript`，以 `package.json` `dependencies` 为准）。不要在 electron-builder 的 `files` 中排除 `node_modules`，否则打包版会静默启动失败（进程存活但不创建窗口）；该约束已注释在 `electron-builder.yml`。

## 常见问题

- **应用或冒烟测试静默退出、`require('electron')` 返回路径字符串**：通常是 `ELECTRON_RUN_AS_NODE=1` 让 Electron 以 Node 模式启动，清除该变量后重试。沙箱环境阻断子进程与命名管道时也会静默退出，需在正常权限下运行。
- **模型输出无法解析**：应用会自动重试一次；仍失败时可尝试更适合结构化输出的模型。
- **模型请求超时**：确认服务地址、网络和模型服务状态，再按界面提示重试。
- **生成中断或应用意外退出**：重新打开同一个项目，在配置页选择“继续生成”；网络或额度问题解决后才会由你主动发起恢复。流式返回中的完整题目（含答案和追问）校验后逐题保存在本机应用数据目录，与正式报告分开；生成页可以提前阅读尚未完成的正文，但这些预览文字只有组成完整题目并保存后才可恢复。生成期间保留项目与历史列表，完成后切换到问题目录。取消生成也保留已保存题目，可以明确“丢弃草稿”后重新开始。
- **继续生成的范围**：恢复会保留已保存题目的原文与编号标识，仅请求补齐剩余题目，并排除已完成考察点。未完整接收的那道题会重新生成，不从某个 token 续写；题目已足够但术语表等内容尚未完整返回时，只补齐缺少的报告信息。项目上下文、颗粒度、方向或模型参数改变后拒绝混用旧结果；可在原配置下补充额度或替换同一服务的 API Key。服务商若忽略流式请求、一次返回完整 JSON，只能在收到完整响应后保存题目；旧版本草稿会保留，协议不兼容时提示重新生成。
- **报告已生成但保存失败**：草稿保留完整结果，恢复时显示“保存已完成报告”，不再调用模型。草稿保存在本机应用数据目录的 `generation-drafts/`，不会额外保存请求提示词、整份源码上下文、API Key 或无效模型响应；已保存题目仍可能包含报告引用的代码。恢复后的用量诊断只统计本次实际发出的请求，未提供完整用量回执的请求不会被当成零用量。
- **草稿损坏**：应用先尝试读取上一份有效备份；两份都无法恢复时，可在配置页显式“丢弃损坏草稿”，原文件会留在同目录的 `.corrupt-*` 归档中，再重新开始。此操作不能删除有效草稿或历史报告。
- **术语解释流式响应异常**：检查模型服务配置后重试；不完整的响应不会显示为完成。
- **大型项目生成较慢**：细粒度会按模块分批请求；可先用粗粒度或中粒度了解整体，再决定是否用细粒度深入分析。
- **`npm audit` 遇到 registry 错误**：某些第三方 registry 不提供安全公告接口，可临时运行 `npm audit --registry=https://registry.npmjs.org/`。

更多架构和协作约束见[项目规范](project-standards.md)与根目录的[协作入口](../AGENTS.md)。
