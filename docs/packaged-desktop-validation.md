# Windows 安装版桌面验收

本文记录如何构建、安装并验收 Windows NSIS 安装版。安装态操作应通过原生桌面界面完成：使用鼠标、键盘和 Windows 文件对话框，不注入 DOM，也不替换应用的 Electron、preload、IPC、持久化或页面实现。

## 构建与安装

在仓库根目录构建前先完成项目验证。本次 1.6.1 验收采用的构建和检查结果见“本机验收结果”。生成安装包的命令为：

```powershell
npm run dist -- --config.directories.output=dist/desktop-1.6.1 --publish=never
```

构建成功后，找到输出目录中的 `RepoPrep Setup 1.6.1.exe`，运行它启动 NSIS 向导。按验收要求选择安装目录；本次选择 `G:\下载\RepoPrep`，安装包为 `G:\下载\RepoPrep Setup 1.6.1.exe`。安装完成后确认安装目录中有 `RepoPrep.exe`、`resources\app.asar` 和卸载器，再从该安装目录启动应用。

可先用文件哈希比对安装版 `RepoPrep.exe`、`resources\app.asar` 与构建输出对应文件，确认安装没有改变产物。启动后通过任务管理器或进程检查确认进程映像路径位于所选安装目录。需要隔离验收配置时，把 `--user-data-dir` 指向新的测试目录：

```powershell
& 'G:\下载\RepoPrep\RepoPrep.exe' --user-data-dir 'G:\下载\RepoPrep-evidence\user-data'
```

不传该参数时应用沿用默认配置路径。不要为清理验收数据删除或覆盖默认用户配置目录。

可用 PowerShell 比较构建目录和安装目录文件的 SHA-256：

```powershell
Get-FileHash 'dist\desktop-1.6.1\win-unpacked\RepoPrep.exe' -Algorithm SHA256
Get-FileHash 'G:\下载\RepoPrep\RepoPrep.exe' -Algorithm SHA256
Get-FileHash 'dist\desktop-1.6.1\win-unpacked\resources\app.asar' -Algorithm SHA256
Get-FileHash 'G:\下载\RepoPrep\resources\app.asar' -Algorithm SHA256
```

## 本地合成模型服务

`scripts/packaged-desktop-fixture.mjs` 使用 Node 内建模块在 `127.0.0.1` 启动 HTTP 服务，供桌面安装版通过普通模型 HTTP 客户端调用。它仅提供合成响应，不替代 Electron、preload、IPC、文件选择框、项目扫描、保存或页面行为；最终用户安装应用不需要它。

在仓库根目录运行，`--root` 必须是绝对路径：

```powershell
node scripts/packaged-desktop-fixture.mjs --root 'G:\下载\RepoPrep-evidence\fixture'
```

默认使用空闲端口，也可以指定 `--port <number>`；端口 `0` 表示由系统分配。启动时输出单行 JSON，例如：

```json
{"ready":true,"baseUrl":"http://127.0.0.1:43127/v1","controlUrl":"http://127.0.0.1:43127","projectA":"G:\\下载\\RepoPrep-evidence\\fixture\\packaged-project-a","projectB":"G:\\下载\\RepoPrep-evidence\\fixture\\packaged-project-b","stateFile":"G:\\下载\\RepoPrep-evidence\\fixture\\fixture-state.json"}
```

在应用设置中按正常流程配置兼容 OpenAI 的服务，地址填写输出的 `baseUrl`，模型填写 `packaged-synthetic-model`。如果设置表单要求 API Key，可填合成值；fixture 不读取或保存请求头。用应用里的模型列表、连接测试和保存操作完成配置。

根目录只能是新建目录、空目录或带本工具标记的目录；已有项目子目录也必须有对应的 fixture 标记。工具拒绝向无标记的非空目录写入，也不会覆盖无标记的项目目录。停止服务不会删除项目或证据；按 `Ctrl+C` 退出。

### 生成控制与状态

把启动 JSON 中的 `controlUrl` 保存为 PowerShell 变量，再控制下一次生成请求：

```powershell
$controlUrl = 'http://127.0.0.1:43127'
Invoke-RestMethod -Method Post -Uri "$controlUrl/__fixture/mode" -ContentType 'application/json' -Body '{"mode":"complete"}'
Invoke-RestMethod -Method Post -Uri "$controlUrl/__fixture/mode" -ContentType 'application/json' -Body '{"mode":"hold"}'
Invoke-RestMethod -Method Post -Uri "$controlUrl/__fixture/mode" -ContentType 'application/json' -Body '{"mode":"fail"}'
Invoke-RestMethod -Method Post -Uri "$controlUrl/__fixture/release"
Invoke-RestMethod -Uri "$controlUrl/__fixture/state"
```

`complete` 按题逐条延迟发送；`hold` 发送三道完整题后暂停，供界面取消，再次生成时依据提示中已保存题目补足剩余配额；`/release` 可以让暂停的请求继续，hold 最长五分钟后自动释放。`fail` 让下一次生成返回合成 HTTP 500，之后自动恢复 `complete`。

连接测试返回 `OK`。AI 解释返回合成中文 Markdown；流式请求会分段延迟发送，兼容 OpenAI 和 Anthropic SSE 格式。`/v1/models` 兼容 OpenAI 模型列表和 Anthropic 的 `data`/`has_more` 形状；服务也支持 `/v1/messages`。

`GET /__fixture/state` 与 `fixture-state.json` 仅记录请求序号、分类、协议、状态、题数和生成模式，不保存 prompt、请求体、headers、API Key 或源码。服务只绑定 loopback，请求体上限为 2 MiB，请求数上限为 200，不访问外网。A、B 是带有 `PACKAGED_FIXTURE_PROJECT_A` / `_B` 标记的小型合成 TypeScript 项目，生成内容同样是合成演示数据。

## 安装版验收步骤

1. 在应用中创建模型配置，选择 fixture 地址和模型；运行模型列表检测、连接测试，保存合成 API Key。检查设置能回读，并确认设置文件中没有明文保存该 Key。
2. 用系统文件夹选择框选择待验收项目并启动扫描，确认页面显示扫描/生成流程。该步骤使用真实文件对话框与安装版扫描代码。
3. 在启动生成前将模式设为 `hold`。看到三道逐步出现且已保存的题目后，在应用中取消生成。关闭应用并重新启动，再执行恢复；确认提示要求只补剩余 17 道，结果共 20 道，原三题问答未变且没有重复 ID。
4. 检查生成结果页：展开题目答案和追问，打开 Electron/IPC 术语弹卡；用鼠标选择答案文字并请求 AI 解释，确认中文解释分段出现。
5. 搜索一个仅命中第 16 题的词，确认筛选后题号仍为原题号。通过应用自己的保存对话框导出 Markdown，检查文件包含完整 20 题；即使页面处于筛选状态，导出内容仍应完整。
6. 打开历史记录并回读该结果，确认保存结果可重新显示。若测试卸载，先确认测试用户数据和证据已另行保留；卸载本身须作为独立实测项目记录。

验收时同时记录安装路径、安装包路径、应用版本、`RepoPrep.exe` 和 `app.asar` 的哈希、用户数据目录、模型协议、fixture 的状态文件、导出文件及未完成项目。证据放入新的验收目录；不要把真实默认配置目录用作可清理的临时目录。

## 本机验收结果（2026-10-28）

| 项目 | 结果 |
| --- | --- |
| 版本与构建 | 版本升级到 1.6.1；`npm run dist -- --config.directories.output=dist/desktop-1.6.1 --publish=never` 成功。 |
| 类型与测试 | `npm run typecheck` 通过；安全套件 77 passed、3 skipped；IPC 套件 265 passed；真实 Electron smoke 通过。 |
| 安装位置 | NSIS 向导将 `G:\下载\RepoPrep Setup 1.6.1.exe` 安装到 `G:\下载\RepoPrep`。安装版 EXE、asar 与构建产物逐字节一致，卸载器存在；C 盘没有生成安装目录。 |
| 安装运行 | 安装版真实页面为 `file:///G:/下载/RepoPrep/resources/app.asar/out/renderer/index.html`。进程 PATH 仅有 `C:\WINDOWS\System32;C:\WINDOWS`，启动不依赖 Node/npm 或源码目录。 |
| 用户流程 | 设置、合成 API Key 由操作系统加密保存、真实目录选择与扫描、逐题生成后取消、重启恢复、追问/术语/划词解释、搜索、真实保存对话框导出及历史回读均已通过。恢复后共 20 题；原三题问答逐字保持，ID 唯一；导出 Markdown 为 17,166 字节且包含完整 20 题。 |
| 后台与项目隔离 | A 项目后台生成完成后，当前 B 项目配置页保持不变；A 的两份报告都出现在历史列表，B 的结果另行保存。 |
| 两种接口协议 | OpenAI 与 Anthropic Messages 的模型检测、连接、生成和分段解释均通过真实安装版验证；B 项目合成 HTTP 500 后显示失败，返回配置重试后成功保存报告。 |
| 快捷方式与既有数据 | 桌面、开始菜单快捷方式均指向 G 盘安装版；原有配置及最近项目主文件、备份共四个文件的 SHA-256 保持不变。 |
| 证据 | 本次证据目录为 `.validation/packaged-desktop-20261028`。fixture 只留下元数据，不记录 prompt 或 headers。 |

## 未覆盖项与本机异常

- 本次未执行卸载流程；有卸载器文件不代表卸载已验收。
- 合成模型只能证明应用到模型 HTTP 层的集成链路和界面恢复行为，不能证明真实服务的模型质量、额度或外部服务表现。本次不是干净虚拟机或多平台验收。
- 尝试安装到 C 盘时，NSIS 因 `uninstallerIcon` 写入失败而中止，未留下安装目录。workspace 中的 dist 产物直接运行出现 `EXCEPTION_BREAKPOINT`；安装到 G 盘后，同哈希 EXE 正常运行。原因尚未确认，不据此推断根因或声称已修复；失败日志保留在验收证据中。
- 安装包未签名。本次仅完成本机安装验收，没有发布 GitHub Release。
