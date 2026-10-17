# 开发指南

## 环境

- 使用 Node.js 22.15.0 或更高的 22.x，或 24.0.0 及以上版本；项目建议使用 Node.js 24+。
- 在仓库根目录运行 `npm ci`，按 `package-lock.json` 安装依赖。
- `npm run dev` 在 `http://127.0.0.1:5186/` 启动开发应用；renderer 的 HMR 使用同一端口。若端口已被占用，启动会直接失败；请先确认并释放该端口，或修改 `electron.vite.config.ts` 中的 `renderer.server.port`。不要直接结束身份不明的占用进程。
- `npm run build` 构建；`npm run dist` 打包 Windows 安装程序。`npm run preview` 构建并预览本地构建产物，不另开开发服务器端口。
- `npm run typecheck` 执行 TypeScript 检查。其他测试命令和适用范围见[验证指南](validation.md)。

## Electron 二进制

Electron 42 起，二进制会在首次通过 Electron CLI 运行时按需下载，例如运行 `npm run dev`。默认缓存位于 `%LOCALAPPDATA%\electron\Cache`。如需手动下载，在仓库根目录运行：

```bash
node node_modules/electron/install.js
```

electron-builder 打包时管理自己的辅助二进制下载。网络环境需要镜像时，可在 PowerShell 临时设置 `ELECTRON_MIRROR`（以下为 npmmirror 示例）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
```

electron-builder 的辅助二进制可通过 `$env:ELECTRON_BUILDER_BINARIES_MIRROR` 设置镜像服务提供的地址。只在需要时设置相应变量。`.npmrc` 不再使用 npm 将在后续主版本移除支持的 `electron_mirror` 等旧式配置。

## 常见问题

- **模型输出无法解析**：应用会自动重试一次；仍失败时可尝试更适合结构化输出的模型。
- **模型请求超时**：确认服务地址、网络和模型服务状态，再按界面提示重试。
- **术语解释流式响应异常**：检查模型服务配置后重试；不完整的响应不会显示为完成。
- **大型项目生成较慢**：细粒度会按模块分批请求；可先用粗粒度或中粒度了解整体，再决定是否用细粒度深入分析。
- **`npm audit` 遇到 registry 错误**：某些第三方 registry 不提供安全公告接口，可临时运行 `npm audit --registry=https://registry.npmjs.org/`。

更多架构和协作约束见[项目规范](project-standards.md)与根目录的[协作入口](../AGENTS.md)。工具链升级记录见[工具链升级指南](toolchain-upgrade.md)。
