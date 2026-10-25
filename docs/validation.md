# 验证

验证按本文的命令和人工检查步骤执行。当前仓库没有统一的 `verify` 入口，也没有已提交的 CI workflow；分支保护、自动 review 等远端设置另行核实。

## 环境与依赖

- 使用满足根 `package.json` `engines.node`（`^22.15.0 || >=24.0.0`）的 Node.js，本地开发建议 24.x。
- 在仓库根目录执行 `npm ci` 按 `package-lock.json` 安装；不要用 `npm install` 更新锁文件来代替干净安装。
- 首次运行可能需要下载 Electron 二进制，脚本不保证完全断网的冷环境可运行。依赖缺失时如实报告为未验证。
- 默认测试主要使用临时项目和 mock，不调用真实模型；fixture 或 mock 通过不能证明真实 API、模型兼容性、额度或服务端行为。

## 当前命令

以下命令均在仓库根目录运行：

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run typecheck` | 对 Node/Electron 与 Web 两套 TypeScript 配置执行 `tsc --noEmit`。 |
| `npm run test:ipc` | IPC schema、调用方权限、handler 防护与安全结果测试，OpenAI/Claude 格式、流式响应和本地合成模型生成链路。 |
| `npm run test:lib` | 设置保存、服务商预设、扫描滑条、模型探测及导航等纯逻辑测试。 |
| `npm run test:renderer` | 组件实际挂载与交互：设置、滑条、接口规范切换、项目侧栏和结果页。 |
| `npm run test:scan-cache` | 项目快照和扫描缓存测试。 |
| `npm run test:file-selection` | 文件选择策略与真实扫描、上下文构建、snippet 选择的集成覆盖。 |
| `npm run test:question-budget` | 问题预算、集成预算与生成合并测试。 |
| `npm run test:security` | 先 `npm run build`，再运行窗口安全、敏感信息及安全集成测试。 |
| `npm run test:native-credentials` | 先 build，再在真实 Electron `safeStorage` 和设置服务中用合成 key、隔离临时数据目录做加密往返验证。 |
| `npm run test:smoke` | 先 build，再运行 Electron 本地构建产物冒烟。 |
| `npm run test:electron:workflow` | 先 build，再用真实主进程、preload、renderer 和守卫 IPC 验证扫描、配置、取消后无保存、重试、历史回读、项目隔离及 Markdown 写盘；模型服务是本地合成 HTTP。 |
| `node tests/run-smoke.cjs --asar <absolute-app.asar-path>` | 在 `dist` 已构建后，检查 `dist/win-unpacked/resources/app.asar` 的运行时依赖并在隔离 Electron 中加载归档内代码。不安装应用，不等同安装态验收。 |
| `npm run test:eval` | 离线评分器和人工复核 CLI 单元/命令行测试；不运行生成器或真实模型。 |
| `npm run test:eval:real` | 真实语料校验、生产生成器对照链路、请求限额与失败报告的定向测试；使用合成 HTTP 响应与合成凭据，不调用真实模型。 |
| `npm run eval:real -- verify --repos-root <directory>` | 核验公开仓库的固定提交、工作树、来源及源码事实哈希/行号；不访问模型服务。 |
| `npm run eval:real:saved -- --repos-root <directory> --output <new-directory>` | 在隔离 Electron 主进程内读取已保存模型，执行真实仓库生成。会调用配置的模型服务，边界见[真实评测](real-generation-evaluation.md)。 |
| `npm run eval:real:cohort -- <baseline> <current> <prior> <proof> <new-directory>` | 组合已完成的子集运行与历史测量，不调用模型。 |
| `npm run eval:offline -- <new-directory>` | 通过 loopback 合成响应器运行固定 fixture、生产生成流程和评分器；不读取用户设置或密钥，独立输出目录可避免覆盖已有报告。 |
| `npm run eval:review -- template <report.json> <review.json>` / `... import ...` | 生成或导入离线报告的人工评分，规则见 [generation-evaluation.md](generation-evaluation.md)。 |
| `npm run build` | 构建 Electron 主进程、preload 与 renderer。 |
| `npm run dist` | 重新构建并用 electron-builder 生成 Windows 安装包。 |
| `npm run audit:deps` | 通过 GitHub CLI/GraphQL 查询 lockfile 依赖适用的 HIGH/CRITICAL 公告，需要 `gh` 已认证并可联网。 |

## 按改动范围选择验证

| 改动范围 | 提交前最低检查 |
| --- | --- |
| 仅文档、模板或 `.gitignore` | `git diff --check`；人工核对相对链接、命令是否存在、版本与 `package.json`/lockfile 一致。无需产品测试或模型调用。 |
| 局部产品逻辑 | `npm run typecheck` 加对应套件：IPC 用 `test:ipc`，扫描/缓存用 `test:scan-cache`，文件选择和上下文组装用 `test:file-selection`，问题预算/生成合并用 `test:question-budget`，安全边界用 `test:security`。 |
| 跨模块或 UI/主进程行为 | `npm run typecheck`、受影响测试套件，以及 `npm run test:smoke`。 |
| IPC、权限或安全边界 | `npm run typecheck`、`npm run test:ipc`、`npm run test:security`；影响启动或渲染时加 `npm run test:smoke`。 |
| 生成逻辑或生成数据流 | `npm run typecheck`、`npm run test:question-budget`；按涉及边界加 `test:ipc` 或 `test:security`。不等同真实模型验收。 |
| 构建、打包配置或发布文件 | `npm run typecheck`、`npm run test:security`、`npm run test:smoke`（后两者内部会 build）；发布产物变更再运行 `npm run dist`。 |
| 依赖或 lockfile 更新 | `npm ci`、`npm run typecheck`、受影响测试；依赖安全复核运行 `npm run audit:deps`；打包依赖变化加 `npm run dist`。 |

矩阵是提交前的最低技术证据，不是机械的完整清单：未覆盖的变更类型先确定并执行相应检查或人工验收；已有成功阶段无新改动时不重复运行，失败后定向诊断并保留原失败结果，修复后重跑受影响阶段。

## 结果解释边界

- `test:smoke` 验证本地构建产物的窗口加载、React 渲染和一次 IPC 往返；完整有限流程由 `test:electron:workflow` 覆盖。记 smoke 为通过必须同时满足：日志含 `VERDICT SMOKE-OK`、Electron 退出码 `0`、父 runner 确认隔离临时目录已删除；只有退出码 0 而无 verdict 或出现 `SMOKE-FAIL` 都不算通过。二者都不证明安装态验收。
- `test:native-credentials` 用合成密钥和临时目录验证本机 `safeStorage` 与实际设置服务的加密往返、明文隔离和公开回读；不调用模型、不使用用户密钥，也不证明 Windows DPAPI 数据可迁移到其他账户或设备。
- `test:eval`、`eval:offline` 与 `eval:review` 只覆盖合成 fixture、loopback 响应、评分器和人工评分导入规则，不能当作真实模型质量或事实正确性验证。
- `dist` 当前只生成 Windows 安装包；生成成功不等于安装验收，后者需实际安装并检查启动、保存/导出和卸载。
- `audit:deps` 只检查查询到的适用 HIGH/CRITICAL 公告：完整且无命中为 `status=clean`/退出码 0；完整且有命中为 `status=findings`/退出码 1；查询或报告不完整为 `status=incomplete`/退出码 2。部分查询的零命中不能解释为干净；已撤回公告单独记录、不计入有效命中。执行前用 `gh auth status` 确认身份（预期 `dhasho`）。该检查不是默认离线检查。
- 验收真实 API、模型兼容性或额度需明确授权和真实服务配置；不要用 fixture、mock 或 smoke 结果代替。
- 网络或依赖条件不满足时，写明跳过/失败原因；不因缺少依赖自动 `npm install` 后当作干净环境成功。
