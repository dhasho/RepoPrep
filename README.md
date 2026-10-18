# RepoPrep

RepoPrep 是一款桌面应用：读取本地项目代码与文档，生成面试问题、参考答案和追问，帮助你按项目准备面试。

## 功能

- 聚焦项目本身的架构、模块和实现生成问题。
- 提供答案中的专业名词解释，并支持结合项目继续追问。
- 可配置 OpenAI 兼容模型服务与模型。
- 在项目侧栏中按时间和问题深度保留多份分析，支持导出 Markdown。
- 支持后台生成，完成后再查看结果。

可选择问题深度：

- 粗粒度（架构级）：约 8–12 题
- 中粒度（模块级）：约 15–25 题
- 细粒度（实现级）：约 25–40 题

## 开始使用

需要 Node.js 22.15.0+（22.x）或 24.0.0+；推荐 Node.js 24 或更高版本。

```bash
git clone https://github.com/dhasho/RepoPrep.git
cd RepoPrep
npm ci
npm run dev
```

1. 点击左下角设置，填写模型服务的 Base URL、模型名及服务要求的 API Key，并测试连接。
2. 点击侧栏上方的「新建」选择项目文件夹，在右侧选择问题深度和考察方向（通用、前端、后端或算法）。
3. 生成问题，查看答案与追问；需要时解释术语或导出 Markdown。
4. 展开侧栏中的项目，按时间和问题深度打开以前的分析。最左侧的两个目录图标可切换项目列表与最近打开分析的问题目录，左上角箭头用于上一步、下一步。

旧版保存的结果会出现在对应项目下。再次生成会保留已有分析；从侧栏移除项目只移除最近项目入口，不会删除已保存的分析。

所选项目的相关代码与文档会发送给你配置的模型服务，用于生成内容。

扫描默认最多纳入 50,000 个文件和 100,000 个树节点，单个文件最多读取 1 MiB；可在「设置 → 扫描安全上限」调整，最高分别为 250,000 个文件、500,000 个树节点和 8 MiB。扫描会排除 Git 元数据、常见构建产物与 worktree 容器，并跳过嵌套 Git linked worktree，避免把其他 checkout 当作所选项目内容。

安全细节见[历史来源字段兼容说明](docs/source-evidence.md)、[密钥保护](docs/credential-security.md)和[1.0 升级说明](docs/upgrade-1.0.md)。

开发环境与常见问题见[开发指南](docs/development.md)。项目规范、验证命令和版本策略见[项目规范](docs/project-standards.md)、[验证指南](docs/validation.md)和[版本策略](docs/VERSIONING.md)。

离线生成评测见[评测指南](docs/generation-evaluation.md)和[基准报告](reports/offline-generation-eval/report.md)。
