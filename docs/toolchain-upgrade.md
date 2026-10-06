# 工具链升级记录（issue #5）

## 一、升级内容

| 组件 | 升级前 | 升级后 | 说明 |
| --- | --- | --- | --- |
| Electron | 33.4.11 | **42.11.10** | Chromium 148 / Node 24.19。33 已 EOL |
| electron-builder | 25.1.8 | **26.17.0** | 打包链（`app-builder-lib` 25.1.8 → 26.17.0） |
| electron-vite | 2.3.0 | **5.0.0** | 构建编排 |
| Vite | 5.4.21 | **7.3.6** | 见下方「为什么是 Vite 7」 |
| @vitejs/plugin-react | 4.3.4 | **5.2.0** | 随 Vite 7 升级（6.x 要求 Vite 8） |
| TypeScript | 5.7.2 | **5.9.3** | 5.x 最新；TS 7 为原生编译器，属独立大版本，本次不动 |
| @types/node | 22.10.2 | **24.19.1** | 对齐 Electron 42 内嵌的 Node 24.19（`tsconfig.node.json` 显式启用 `"types": ["node"]`，此前类型面落后于运行时） |

## 二、版本选择依据

### Electron 选 42 而不是「最新」或「最小跨度」

- **支持窗口**：Electron 官方策略是「最近 3 个稳定大版本」。撰写时最新为 44.5.1，
  因此受支持的是 **44 / 43 / 42**。原版本 33 已 EOL，必须跨出窗口。
- **安全公告**：2026-09-29 发布的两条 HIGH 公告（`GHSA-hq2x-r82h-9wj4`、
  `GHSA-gr2m-v5gq-v685`，均与「沙箱窗口 / 弹出窗口未继承沙箱限制」有关）在
  41.10.4 / 41.10.6 及更高版本修复。**42.11.10 已包含修复**。
- **破坏面**：39→42 的破坏性变更对本项目没有实际影响（逐条核对如下），
  而 43/44 引入了 clipboard 模块重构、32 位平台移除、ANGLE 静态链接等更大改动。
  因此选 42 是在「进支持窗口 + 清掉已知公告」前提下的最小风险落点。

### 为什么是 Vite 7

`electron-vite@5` 的 peerDependencies 为 `vite: ^5 || ^6 || ^7` —— **不支持 Vite 8**。
因此 Vite 升到 7.3.6，`@vitejs/plugin-react` 对应升到 5.2.0（6.x 要求 Vite 8）。
待 electron-vite 支持 Vite 8 后再跟进。

### 39→42 破坏性变更逐条核对

| 版本 | 变更 | 对本项目影响 |
| --- | --- | --- |
| 39 | `--host-rules` 弃用 | 未使用 |
| 39 | `window.open` 弹窗恒可调整大小 | 未使用（窗口打开已被完全拒绝） |
| 39 | `shared texture` OSR 数据结构 | 未使用离屏渲染 |
| 39 | macOS `NSAudioCaptureUsageDescription`（desktopCapturer） | 未使用 desktopCapturer；且不发布 macOS |
| 40 | 渲染进程 clipboard API 弃用 | 渲染进程未使用 clipboard |
| 40 | macOS dSYM 压缩 | 仅 macOS 发布流程 |
| 41 | PDF 不再创建独立 WebContents | 不加载 PDF |
| 41 | Cookie `changed` 事件原因值 | 未使用 Cookie API |
| 41 | Linux 对话框 `showHiddenFiles` 弃用 | 仅 Linux |
| 42 | macOS 通知改用 UNNotification | 未使用通知 |
| 42 | 离屏渲染默认缩放 1.0 | 未使用离屏渲染 |
| 42 | **Electron 不再通过 postinstall 下载自身** | 需调整使用说明，见下 |
| 42 | `Session.clearStorageData` 移除 `quotas` | 未使用 |
| 42 | 子框架创建的 worker 需 `nodeIntegrationInSubFrames` 才有 Node 集成 | `nodeIntegration` 已关闭，且不使用 worker |
| 42 | preload 只在 DevTools 扩展帧运行 | 不使用 DevTools 扩展 |

（`nativeImage.createFromNamedImage` 的 `hslShift` 弃用也属 42 段，本项目未使用该 API。）

唯一需要落地的是「不再 postinstall 下载二进制」：已更新 `.npmrc` 说明与 README
「常见问题」，并保留手动下载入口 `node node_modules/electron/install.js`。

## 三、关于 `npm run dist` 的构建次数

`dist = electron-vite build && electron-builder --win`。实测 electron-builder 阶段
**不会**再跑一次构建（日志里 `vite v7` 出现 3 次 = main/preload 的 ssr 两次 +
renderer 一次，全部来自 `electron-vite build`），所以不存在重复构建。

electron-builder 阶段会执行一次 `@electron/rebuild`（重建原生依赖）。本项目没有原生
依赖，这一步是空转但开销很小，保留即可。

如果 CI 里希望把「构建」和「打包」两步分开，可以直接复用已打包目录
（已在本机验证可用，产物与完整流程一致）：

```bash
npm run build
npx electron-builder --win --prepackaged dist/win-unpacked
```

## 四、打包内容与 `ignore` 依赖（本次踩到的坑，只记录不改动）

排查中发现一个容易踩坏的约束：**`out/main/index.js` 运行时仍然 `require` 生产依赖**
（当前只有 `ignore`，用于解析 `.gitignore`），其余生产依赖（`react` / `react-markdown` /
`remark-gfm` / `rehype-highlight` / `highlight.js`）都已被 Vite 打进
`out/renderer/assets/*.js`。

因此若为了瘦身把 `files` 写成 `"!node_modules/**"`，打包版会**静默启动失败**：
进程活着但不创建窗口、无任何日志（因为 asar 内 `require("ignore")` 失败）。
本次已把这条约束以注释形式写进 `electron-builder.yml`，避免以后有人顺手加排除规则。

顺带记录体积现状（基于 Electron 42.11.10）：

| 项 | 大小 |
| --- | --- |
| `app.asar`（当前配置） | 18.97 MB |
| `app.asar`（实验：排除 `react`/`react-dom`/`react-markdown`/`rehype-highlight`/`remark-gfm`/`highlight.js`） | 8.71 MB |
| NSIS 安装包 | 106–109 MB |

上表的瘦身实验已实测**可用**（打包版能正常加载 `app.asar` 内的 renderer），但会引入
「主进程新增运行时依赖时必须记得同步白名单」的维护隐患，属于运行时打包行为而非本次
升级范围，因此**未采纳**，仅在此记录，供后续单独评估。

## 五、安全审计结果

审计方式：以 `package-lock.json` 解析出的完整依赖集合，逐个查询
GitHub Advisory Database，并按 semver 精确判定已安装版本是否落在受影响区间内
（只统计 HIGH / CRITICAL，已撤回公告单列不计入）。这比 `npm audit` 更适合本机环境，
因为本机使用的第三方 registry 未实现 `/-/npm/v1/security/*`，且直连官方源时 TLS
会被中间设备拦截（证书不含 DNS 名）。

> **方法学注意（本次踩到的坑，务必保留）**：GitHub Advisory 返回的区间是
> `">= 1.0.0, < 1.2.2"` 这种**逗号**形式，而 npm 的 `semver` 无法解析它 ——
> `semver.validRange(">=1.0.0, <1.2.2")` 返回 `null`，`semver.satisfies()` 会
> **静默返回 `false` 且不抛异常**，从而系统性漏报。必须先规范化为空格 AND 形式：
> `range.split(',').map(s => s.trim()).join(' ')`。本文件早期版本的错误数字正是由此产生。

审计脚本已随仓库提供，可随时复现（需要 `gh` CLI 已登录）：

```bash
npm run audit:deps                                      # 审计当前 lockfile
node scripts/audit-deps.cjs <lockfile> --label BEFORE   # 审计任意基线 lockfile
```

### 结果对比

| 范围 | 升级前（`origin/main` @ a939fd3） | 升级后 |
| --- | --- | --- |
| 完整依赖树（含构建链）适用 HIGH/CRITICAL | **30**（含已撤回 32） | **2**（含已撤回 4） |
| 其中 CRITICAL | 1 | **0** |
| 生产依赖树（真正进入安装包）适用公告 | 0 | **0**（任何严重度亦为 0） |
| 受影响包数量 | 14 | 2 |

### 已消除的主要条目（升级前 14 个受影响包中的 12 个）

| 包 | 公告 | 严重度 |
| --- | --- | --- |
| electron 33.4.11 | `GHSA-hq2x-r82h-9wj4`、`GHSA-gr2m-v5gq-v685`、`GHSA-j84w-jfhq-vhvj`、`GHSA-9qh4-3jw8-366w`、`GHSA-9f4c-93c8-jc8g` | HIGH ×5 |
| tar 6.2.1 | `GHSA-23hp-3jrh-7fpw` 等 **9** 条 | **CRITICAL ×1** + HIGH ×8 |
| vite 5.4.21 | `GHSA-fx2h-pf6j-xcff`（`server.fs.deny` 可绕过） | HIGH |
| js-yaml 4.3.1 | `GHSA-2883-xcg3-v3hh` | HIGH |
| glob 10.4.5 | `GHSA-5j98-mcp5-4vw2` | HIGH |
| app-builder-lib 25.1.8 | `GHSA-7g7r-gx96-252g`（AppImage 搜索路径不可控） | HIGH |
| builder-util-runtime 9.2.10 | `GHSA-p2f4-r6v6-j797`（跨域重定向泄漏凭据） | HIGH |
| brace-expansion 1.1.18 / 2.1.4 / 5.0.9 | `GHSA-6j4f-fj2g-mc7p`、`GHSA-qhr7-859c-m2p7` | HIGH |
| extract-zip 2.0.1 | `GHSA-7pqw-9j4j-h8q3`、`GHSA-jmr9-qjv8-65gv` | HIGH ×2 |
| source-map-js 1.2.1 | `GHSA-68fv-2mgg-jv7q`（本次通过显式升级到 1.2.2 消除） | HIGH |

### 仍存在的 2 条（均在构建链，不进入安装包，上游无修复版本）

均已确认**只经由 devDependencies 引入**，不会进入 `dist`：

| 包 | 公告 | 暴露面评估 |
| --- | --- | --- |
| `braces@3.0.3` | `GHSA-vfj7-8cjw-p6xm`（深层嵌套模式导致栈耗尽 DoS） | 依赖链 `tailwindcss → chokidar / micromatch / fast-glob`，**仅在 Tailwind 构建期扫描 glob 时可达**，输入是开发者自己写的 glob 而非外部数据。上游 `last_affected` 即等于当前最新发布版，无修复版本 |
| `http-cache-semantics@4.2.0` | `GHSA-ch52-4w7c-c8xp`（`max-stale` 可跨用户泄漏缓存响应） | 依赖链 `electron-builder → app-builder-lib → @electron/get → got → cacheable-request`。**仅在打包时下载 Electron 二进制的 HTTP 缓存路径上可达**。构建机不共享缓存、下载源为固定 HTTPS 源，实际风险低；上游同样无修复版本 |

另有 2 条**已撤回（Withdrawn）**公告，不计入上述统计，仅作记录：
`cacheable-request@7.0.4` 的 `GHSA-8x6c-cv3v-vp6g`（2023-02-14 撤回）与
`esbuild` 的 `GHSA-gv7w-rqvm-qjhr`（2026-06-17 撤回）。

结论：**安装包内不含任何适用公告（任何严重度）**；剩余 2 条全部位于构建期工具链，
且上游均无修复版本可用。

### 安装包口径的验证

「生产依赖」是否等于「真正进入安装包」，不能只凭 `npm ls --omit=dev` 断言。这里用了
两条互相独立的口径并比对结果：

1. 实证：用 `@electron/asar` 解析 `dist/win-unpacked/resources/app.asar`，枚举其中
   所有含 `name`+`version` 的包目录；
2. 推导：从 lockfile 按 root `dependencies` 做可达闭包。

两者得到的集合**完全相同（113 个包）**，因此「生产依赖闭包」确实是本项目入包内容的
正确口径。在这 113 个包上适用公告数为 **0**。
（注意 `@types/react` / `@types/prop-types` / `csstype` 在 lockfile 中缺少 `dev:true`
标记，但实测并不在 asar 内，electron-builder 的裁剪是正确的。）

## 六、验证记录

在本机全新 worktree（`codex/issue-5-toolchain-upgrade-v2`，基于 `origin/main` @ `a939fd3`）执行：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（Vite 7.3.6，main / preload / renderer 三个目标） |
| `npm run test:security` | 18/18 通过（含构建产物 CSP 与「生产 HTML 无内联脚本」断言） |
| `npm run test:ipc` | 31/31 通过 |
| `npm run test:scan-cache` | 21/21 通过 |
| `npm run dist` | 通过，产出 `dist/ProjectLens Setup 0.1.0.exe`（108.7 MB） |
| `npm run test:smoke` | **SMOKE-OK** —— 窗口创建成功、断言确认加载的就是 `out/renderer/index.html`、React 渲染出界面、`window.api` 桥接可用、`getRecentProjects()` 经 IPC 守卫往返成功、无 `did-fail-load` / `preload-error` / 渲染进程告警或报错 |
| 打包版启动（`dist/win-unpacked/ProjectLens.exe`） | **PACKAGED-SMOKE-OK** —— 进程存活、renderer 正常加载 `app.asar/out/renderer/index.html`、窗口标题 `ProjectLens`、主进程输出 `[ProjectLens] main ready` |
| Electron 运行时 | electron 42.11.10 / chrome 148.0.7778.280 / node 24.19.0 |

`test:smoke` 只覆盖「启动 + 一次无参数 IPC」。注意 `project:recent` 并不在需要项目授权的
通道集合内，因此它**不覆盖**项目授权链路（授权路径目前由 `test:ipc` 的单测覆盖）。

### 冒烟测试自身的失效模式（已实测并修复）

只验证「能通过」是不够的，因此对冒烟测试做了负向验证，确认它在应当失败时确实失败：

| 注入的故障 | 修复前 | 修复后 |
| --- | --- | --- |
| 删除 `out/renderer/index.html` | — | 7 秒内 `SMOKE-FAIL` + 退出码 1，报 `ERR_FILE_NOT_FOUND` |
| 环境里存在 `ELECTRON_RENDERER_URL`（主进程会优先加载 dev server） | 全部断言仍通过（假绿） | `loadedIsBuildOutput=false` → `SMOKE-FAIL` + 退出码 1，并提示该变量 |
| 断言执行前窗口被关闭（触发主进程 `window-all-closed → app.quit()`） | **退出码 0 且无 VERDICT**（假绿） | `will-quit` 兜底 → 退出码 1。注意：此处只设 `process.exitCode` 无效，必须 `app.exit(1)`（Electron 的 quit 流程不走 Node 正常退出路径，已实测） |
| 设置 `ELECTRON_RUN_AS_NODE=1` | 报出与根因无关的 `Cannot read properties of undefined (reading 'on')` | 前置检测并直接提示该变量与清除命令，退出码 1 |

### 仍需人工确认的部分

自动化只能覆盖到「应用能起来 + IPC 通」。以下需要真实 GUI 与模型服务，请在合并前手工走一遍：

1. 安装 `dist/ProjectLens Setup 0.1.0.exe`，启动应用；
2. 「选择项目文件夹」选择一个真实项目，确认扫描结果与文件树正常；
3. 配置一个大模型（Base URL + API Key），点「测试连接」，再生成一次面试题；
4. 在结果页确认 Markdown 渲染（列表 / 表格 / 代码块）与名词点击解释；
5. 导出 Markdown，确认保存对话框与文件内容正常。

### 本机环境注意事项

- 本会话的 `ELECTRON_RUN_AS_NODE=1` 会让任何 Electron 应用以 Node 模式启动
  （表现为 `require('electron')` 返回路径字符串、应用静默退出）。若遇到类似现象，
  先确认该变量未被设置。
- 沙箱环境会阻断 Electron 的子进程与命名管道，导致应用静默退出；冒烟测试需在
  正常权限下运行。
