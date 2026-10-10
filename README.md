# 🔭 ProjectLens — 项目面试题生成器

Electron 桌面应用：选择本地项目文件夹，AI 面试官通读代码与文档，自动生成「**面试问题 + 参考答案 + 追问**」的准备材料。答案中的专业名词带下划线（飞书风格），点击即可查看解释，还能让 AI 结合项目语境继续深挖。

## 功能

- **项目分析**：原生文件夹选择；自动扫描文件树、统计语言分布、识别 README / 配置 / 入口等关键文件；尊重 `.gitignore` 并内置常见忽略项（node_modules、构建产物、二进制文件等）
- **三档问题颗粒度**：
  | 档位 | 定位 | 题量 | 说明 |
  | --- | --- | --- | --- |
  | 粗粒度·架构级 | 整体架构、技术选型、模块职责 | 约 8–12 题 | 只分析文件树 + 文档 + 配置，最快 |
  | 中粒度·模块级 | 模块实现、数据流、接口设计 | 约 15–25 题 | 附核心源码 |
  | 细粒度·实现级 | 函数实现、算法、边界、性能 | 约 25–40 题 | 按模块分批多次调用，最深入 |

  题量是**预先分配的硬预算**：细粒度会先按模块体量把总题量分配到「全局批 + 各模块批」，
  提示词里下达明确配额，模型超额输出的部分会被丢弃，因此不会出现远超承诺题量的情况。
  表中题量与 `shared/types.ts` 的 `GRANULARITY_QUESTION_BUDGET` 保持一致（界面文案
  `GRANULARITY_META.count` 由它生成，并有测试断言与本文档一致）。
- **考察方向**：通用 / 前端 / 后端 / 算法，影响提问侧重
- **追问链**：每题 2–4 个面试官式深挖追问，支持嵌套
- **飞书式名词解释**：答案中专业名词显示为下划线词条，点击弹出解释卡片（术语表 + AI 详细解释，流式输出，结合项目上下文）
- **大模型自由接入**：OpenAI 兼容接口，支持 DeepSeek / 智谱 GLM / 通义千问 / Kimi / OpenAI / Ollama 等，可保存多套配置随时切换、一键测试连通性
- **模型列表自动检测**：填好 Base URL + API Key 后（或粘贴 Key 失焦时自动触发），一键拉取该 Key 可用的全部模型，在可搜索下拉列表中直接点选；不支持该接口的服务商仍可手动填写
- **结果管理**：按项目自动保存，重新打开免生成；支持导出 Markdown（含问题、答案、追问、名词表）
- **后台生成**：生成期间进入设置或切换项目时，可选择后台继续、取消生成并离开或留在生成页；后台完成后从任务入口主动查看结果，不会打断正在查看的项目。关闭应用窗口会中止进行中的生成。

## 快速开始

> 开发与测试支持 **Node.js 22.x（最低 22.15.0）或 Node.js 24.0.0 及以上**，以 `package.json` 的 `engines` 为准。Node.js 23 不在支持范围内；组件测试使用兼容这些开发版本的 JSDOM 29。

```bash
npm install    # 首次安装（约 620 个包，不含 Electron 二进制）
npm run dev    # 开发模式（热更新）
npm run build  # 生产构建（输出到 out/）
npm run dist   # 打包 Windows 安装包（electron-builder）
```

> **注意**：Electron 42 起官方不再通过 `postinstall` 下载二进制。二进制会在**首次通过
> Electron CLI 运行**时（`npm run dev`、`npm run test:smoke`、`npx electron .`）自动下载，
> 体积约 142MB，缓存在 `%LOCALAPPDATA%\electron\Cache` 供后续复用，因此只需下载一次。
> `npm run dist` 的下载是另一条路径（由 electron-builder 管理），与上面的缓存无关。
> `npm run build` 与 `npm run typecheck` 不需要该二进制。
> 如需提前下载：`node node_modules/electron/install.js`

自检与测试：

```bash
npm run typecheck      # TypeScript 类型检查
npm run test:security  # 敏感信息过滤 + 窗口安全策略（含构建产物 CSP 断言）
npm run test:ipc       # IPC 发送方校验 / 运行时 schema / 项目授权
npm run test:scan-cache# 扫描缓存与快照校验
npm run test:renderer  # 组件渲染、解释流与弹卡真实挂载测试
npm run test:question-budget # 题量预算与生成合并测试
npm run test:smoke     # 构建产物冒烟：窗口能否加载、React 能否渲染、IPC 能否往返
npm run audit:deps     # 依赖公告审计（查 GitHub Advisory，需 gh CLI 已登录）
```

打包后直接运行：`npx electron .`

## 使用流程

1. 首次使用先到 **⚙️ 设置** 添加大模型配置（Base URL + API Key + 模型名，可点快捷模板），点「测试连接」验证
2. 首页「选择项目文件夹」→ 查看项目概览（文件树 / 语言分布 / 关键文件）
3. 选择问题颗粒度与考察方向 → 「开始生成面试题」，生成过程有实时进度，可取消；离开生成页时可选择后台继续，从「后台生成」恢复进度或查看完成结果
4. 结果页：左侧大纲导航 + 搜索；点击问题展开答案；点击答案中的**下划线名词**查看解释，需要更深入就点「让 AI 结合本项目详细解释」
5. 顶部可导出 Markdown 或重新生成

## 技术架构

```
├── electron/               # Electron 主进程
│   ├── main.ts             # 窗口管理 + IPC 注册（文件对话框、生成、解释、设置、导出）
│   ├── preload.ts          # contextBridge 类型安全桥接
│   └── services/
│       ├── scanner.ts          # 目录扫描（gitignore/黑名单/大小与数量上限/语言统计）
│       ├── context-builder.ts  # 按颗粒度组装上下文（字符预算、文件打分、细粒度分批）
│       ├── llm.ts              # OpenAI 兼容客户端（非流式 + SSE 流式、连通性测试）
│       ├── generator.ts        # 生成编排（提示词、JSON 容错解析与重试、批次合并）
│       ├── exporter.ts         # Markdown 导出（保存对话框）
│       └── store.ts            # 设置与结果持久化（userData 目录）
├── shared/                 # 主进程/渲染进程共享类型与 IPC 契约
├── tests/
│   ├── security.test.mjs   # 窗口安全策略与构建产物 CSP 断言
│   └── smoke.cjs           # 构建产物冒烟（窗口加载 / React 渲染 / IPC 往返）
└── src/                    # React 渲染进程
    ├── pages/              # 选择项目 / 配置 / 生成中 / 结果 / 设置
    └── components/         # MarkdownView（[[名词]]→下划线词条）、TermPopover（解释弹卡）等
```

工具链版本（升级策略与残留风险见 [docs/toolchain-upgrade.md](docs/toolchain-upgrade.md)）：

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Electron | 42.x | 官方支持最近 3 个稳定大版本（当前 44/43/42） |
| electron-builder | 26.x | 打包链 |
| electron-vite | 5.x | 构建编排 |
| Vite | 7.x | electron-vite 5 的 peer 上限是 Vite 7，暂不能升到 8 |
| TypeScript | 5.9.x | 暂不升 TS 7（原生编译器为独立大版本） |
| @types/node | 24.x | 对齐 Electron 42 内嵌的 Node 24 |

关键设计：

- **名词标记协议**：生成时要求模型在答案中用 `[[名词]]` 内联标记，并在 `glossary` 中给出解释；渲染层把标记转为可点击词条，解释弹卡优先展示术语表，缺失时自动触发 AI 解释
- **上下文预算**：按字符预算（token≈字符/3）挑选文件，优先级 README > 配置 > 入口 > 核心源码，超长文件截断；细粒度按顶层模块分批多轮调用后合并
- **JSON 容错**：剥离代码围栏、截取首尾大括号，解析失败自动携带错误信息让模型重试一次
- **安全**：contextIsolation 开启、nodeIntegration 关闭；API Key 配置保存在本机 userData。设置页通过受限 IPC 读取和编辑配置，当前存储为普通 JSON，详见项目安全规范

## 项目规范

- [协作入口](AGENTS.md)：Git、worktree 与协作流程
- [项目架构与实现约束](docs/project-standards.md)
- [代码审查约定](docs/review.md)
- [GitHub Review 配置](docs/github-review-setup.md)
- [验证命令与证据](docs/validation.md)
- [版本策略](docs/VERSIONING.md)

## 常见问题

- **模型输出的 JSON 解析失败**：应用会自动重试一次；仍失败请换用能力更强的模型（如 deepseek-chat / GLM-4 系列）
- **大项目生成慢**：细粒度会分批多次调用；可先用粗/中粒度出稿，再针对重点模块单独细分析
- **Electron 二进制下载慢或失败**：用官方支持的环境变量指定镜像。项目 `.npmrc` 里刻意不再写
  `electron_mirror` 这类旧式配置 —— 它们目前仍生效，但 npm 提示下个大版本起失效，留着会变成静默失效：
  ```bash
  # Windows PowerShell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  node node_modules/electron/install.js
  ```
  打包时若还需下载 electron-builder 的辅助二进制，同理设置 `ELECTRON_BUILDER_BINARIES_MIRROR`
- **`npm audit` 报 registry 错误**：本机若使用第三方 registry，其安全公告接口可能未实现；可临时指定官方源：
  `npm audit --registry=https://registry.npmjs.org/`
