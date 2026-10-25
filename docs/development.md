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
- **术语解释流式响应异常**：检查模型服务配置后重试；不完整的响应不会显示为完成。
- **大型项目生成较慢**：细粒度会按模块分批请求；可先用粗粒度或中粒度了解整体，再决定是否用细粒度深入分析。
- **`npm audit` 遇到 registry 错误**：某些第三方 registry 不提供安全公告接口，可临时运行 `npm audit --registry=https://registry.npmjs.org/`。

更多架构和协作约束见[项目规范](project-standards.md)与根目录的[协作入口](../AGENTS.md)。
