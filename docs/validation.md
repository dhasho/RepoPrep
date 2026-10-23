# 验证

验证按本文的命令和人工检查步骤执行。当前仓库没有统一的 `verify` 脚本，也没有已提交的 CI workflow。文档和模板不启用远端平台门禁；分支保护、自动 review 等设置应另行核实。

## 环境与依赖

- 使用满足根 `package.json` 中 `engines.node` 的 Node.js：最低为 `>=22.15.0`。本地开发建议使用 Node 24.x；建议版本不改变声明的最低版本。
- 在仓库根目录执行 `npm ci`，按 `package-lock.json` 安装依赖。不要用 `npm install` 更新锁文件来代替干净安装验证。
- 首次使用 Electron 时可能需要取得 Electron 二进制；当前验证脚本不保证在完全断网、无缓存的冷环境运行。依赖缺失时应报告为未验证，不要在记录中把隐式补装算成验证成功。
- 默认测试主要使用临时项目和 mock，不调用真实模型。fixture 或 mock 通过不能证明真实 API、模型兼容性、额度或服务端行为。

## 当前命令

以下命令均在仓库根目录运行：

| 命令 | 覆盖范围与说明 |
| --- | --- |
| `npm run typecheck` | 分别对 Node/Electron 与 Web TypeScript 配置执行 `tsc --noEmit`。 |
| `npm run test:ipc` | IPC schema、调用方权限、handler 防护与安全结果测试，以及 OpenAI/Claude 格式、流式响应和本地合成模型生成链路。 |
| `npm run test:lib` | 设置保存、服务商预设、扫描滑条、模型探测及导航等纯逻辑测试。 |
| `npm run test:renderer` | 组件实际挂载与交互，包括设置、滑条、接口规范切换、项目侧栏和结果页。 |
| `npm run test:scan-cache` | 项目快照和扫描缓存测试。 |
| `npm run test:file-selection` | 文件选择策略与真实扫描、上下文构建、模型请求的集成覆盖，包括深层引用、模块覆盖、Coarse 限制和渲染预算。 |
| `npm run test:question-budget` | 问题预算、集成预算与生成合并测试。 |
| `npm run test:security` | 先执行 `npm run build`，再运行窗口安全、敏感信息及安全集成测试。 |
| `npm run test:native-credentials` | 先执行 `npm run build`，再在真实 Electron `safeStorage` 和设置服务中用合成 key、隔离临时数据目录做加密保存、无明文检查、public 回读与私有解密往返。证明本机当前平台的原生存储链路，不证明真实模型调用或跨用户/设备可移植。 |
| `npm run test:smoke` | 先执行 `npm run build`，再运行 Electron 本地构建产物冒烟。父 runner 创建独立临时目录并给子进程设置隔离 `appData`/`sessionData`；等待 Electron 退出后有限重试清理。只有 Electron 输出 `VERDICT SMOKE-OK`、退出码为 0 且父 runner 确认临时目录已删除，才算通过。 |
| `npm run test:eval` | 离线评分器和人工复核 CLI 单元/命令行测试；不运行生成器或真实模型。 |
| `npm run test:eval:real` | 真实语料校验、生产生成器对照链路、请求限额、失败报告及已保存模型启动器的定向测试；使用合成 HTTP 响应和隔离设置，不调用真实模型。 |
| `npm run eval:real -- verify --repos-root <directory>` | 核验公开仓库的固定提交、工作树、来源及源码事实哈希/行号；不读取模型凭据或访问模型服务。 |
| `npm run eval:real:saved -- --repos-root <directory> --output <new-directory>` | 在隔离 Electron 主进程内读取已保存模型，执行真实仓库生成和 README 对照。会调用配置的模型服务；默认最多 16 次请求，报告和复核边界见 [真实评测](real-generation-evaluation.md)。 |
| `npm run eval:offline` | 通过 loopback 本地合成响应器运行固定 fixture、生产生成流程和评分器，生成离线报告；不读取用户设置或密钥，不访问外部模型服务。可用 `npm run eval:offline -- <directory>` 指定报告目录。结果只说明 fixture 关键词和流水线行为，不证明真实模型质量。 |
| `npm run eval:review -- template <report.json> <review.json>` / `npm run eval:review -- import <report.json> <filled-review.json>` | 基于带 digest 与 fingerprint 绑定的离线报告生成评分模板，或导入人工评分并更新报告。导入会写入 report JSON 和同目录的 review Markdown；规则与局限见 [generation-evaluation.md](generation-evaluation.md)。 |
| `npm run build` | 构建 Electron 主进程、preload 与 renderer。 |
| `npm run dist` | 重新构建并用 electron-builder 生成 Windows 安装包。 |
| `npm run audit:deps` | 通过 GitHub CLI/GraphQL 查询 lockfile 依赖适用的 HIGH/CRITICAL 公告；需要 `gh` 可用且已认证并可联网。完整无命中为 `status=clean` / 退出码 0；完整且有命中为 `status=findings` / 退出码 1；查询或报告不完整为 `status=incomplete` / 退出码 2。 |

目前没有自动检查这些命令的统一入口，也没有自动 SemVer 比较门禁。云端 review 在 Codex/GitHub 连接配置中启用，仓库文档与模板提供规则；是否启用及权限范围以平台状态为准。下表是按影响范围执行的提交前最低验证要求，不是可选建议。未覆盖的变更类型应先确定并执行相应测试或人工验收；已有脚本不能机械代替对实际需求和用户流程的验收。若测试失败，先定向诊断失败阶段并保留原失败结果。修复后应重跑受影响阶段。已有成功阶段没有新改动或疑点时不必重复运行。

## 按改动范围选择验证

| 改动范围 | 提交前最低检查 |
| --- | --- |
| 仅文档、模板或 `.gitignore` | `git diff --check`；人工核对相对链接、命令是否存在、版本与 `package.json`/lockfile 是否一致。无需产品全量测试或模型调用。 |
| 局部产品逻辑 | `npm run typecheck` 加对应测试套件：IPC 用 `test:ipc`，扫描/缓存用 `test:scan-cache`，文件选择和上下文组装用 `test:file-selection`，问题预算/生成合并用 `test:question-budget`，安全边界用 `test:security`。 |
| 跨模块或 UI/主进程行为 | `npm run typecheck`、所有受影响测试套件，以及 `npm run test:smoke` 检查构建产物能否启动并完成有限渲染/IPC 检查。 |
| IPC、权限或安全边界 | `npm run typecheck`、`npm run test:ipc`、`npm run test:security`；若改动影响启动或渲染，再加 `npm run test:smoke`。 |
| 生成逻辑或生成数据流 | `npm run typecheck`、`npm run test:question-budget`；按涉及边界加 `test:ipc` 或 `test:security`。这些测试不等同于真实模型验收。 |
| 构建配置、Electron 打包配置或发布文件 | `npm run typecheck`、`npm run test:security`（内部会 build）、`npm run test:smoke`（内部会 build）；发布产物变更再运行 `npm run dist`。检查构建已由这些入口完成时，不要无理由再单独运行 `npm run build`。 |
| 依赖或 lockfile 更新 | `npm ci`、`npm run typecheck`、受影响测试；依赖安全复核可运行 `npm run audit:deps`。有打包依赖变化时增加 `npm run dist`。 |

`test:security`、`test:smoke` 和 `dist` 都会自行构建。只在有新变更、结果疑点或前一阶段失败时再单独重跑受影响构建/检查阶段，避免重复报告同一成功构建。矩阵中的产品检查是提交前最低技术证据；对矩阵未覆盖的需求仍须补充相应测试或人工验收，并如实记录未覆盖部分。

## 检查结果的解释边界

- `test:smoke` 检查本地 Electron 构建产物的窗口加载、React 渲染和一次 IPC 往返。它不是安装态验证，也不是完整用户流程；不证明真实项目扫描、模型生成、导出或取消流程可用。
- smoke 使用隔离的临时 `appData` 与 `sessionData`。父 runner 等待 Electron 子进程关闭后，在经 prefix 和绝对路径范围核验的目录内做有限清理重试；清理失败会令 runner 非零退出。将 smoke 记为通过时，必须确认日志含 `VERDICT SMOKE-OK`，Electron 退出码为 `0`，并看到父 runner 确认 fixture 已删除。只有退出码为 `0`、没有 verdict，或出现 `SMOKE-FAIL` 都不能记作通过。
- `test:native-credentials` 用合成密钥和临时目录验证本机 Electron `safeStorage` 与实际设置服务的加密往返、明文隔离和公开回读。它不调用模型、不使用用户密钥，也不证明 Windows DPAPI 数据可迁移到其他账户或设备。
- `test:eval`、`eval:offline` 与 `eval:review` 只覆盖合成 fixture、loopback 响应、评分器和人工评分导入规则；不能当作真实模型质量、事实正确性或服务商兼容性验证。
- `dist` 当前只生成 Windows 安装包。生成成功不等于已安装验收；要声称安装验收完成，还需另行安装并实际检查启动、保存/导出和卸载。此流程不代表 macOS 或 Linux 发布验证。
- `audit:deps` 只检查 GitHub Advisory 数据中查询到的适用 HIGH / CRITICAL 公告，不证明其他严重度、未收录公告或整个生态不存在风险。执行前运行 `gh auth status`，确认 GitHub CLI 身份为预期账号 `dhasho`，并记录网络状态。完整且没有有效命中时报告 `status=clean`、退出码 0；完整且有有效命中时为 `status=findings`、退出码 1；输入、查询、分页、解析或报告不完整时为 `status=incomplete`、退出码 2。部分查询的零命中不能解释为干净；不完整报告仍应保留已确认命中。已撤回公告单独记录，不算当前有效命中，也不能用来豁免仍有效的公告。该检查不是默认离线检查。
- 当前没有完全离线的验证承诺：Electron 二进制可能需要下载，依赖和工具链也须预先可用。网络或依赖条件不满足时写明跳过/失败原因。
- 若要验收真实 API、模型兼容性或额度，需用户授权或此前已有明确授权，并使用明确记录的真实服务配置。不要用默认 fixture、mock 或本地 smoke 结果代替。

## 验证记录模板

每次需要给出验证证据时，可复制填写下列记录。只写实际执行的命令和观察到的结果；不假设存在自动 summary 文件。

```text
变更/PR：
Commit：
目标基准（分支与 commit）：
Node：
npm：
操作系统/版本：

命令 | 结果（PASS/FAIL/SKIP） | 说明/跳过原因
-----|----------------------|-------------------

日志位置：终端输出，或本地临时日志的实际路径（如有）
证明范围：
未覆盖风险/后续人工步骤：
```

诊断时可先运行针对单个失败的测试以定位问题，但记录必须保留最初的全量失败；定向检查通过不能把整体结论改写为全绿。不要因缺少依赖自动执行 `npm install` 后将其作为干净环境成功的证据。
