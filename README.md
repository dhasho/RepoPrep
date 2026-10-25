# RepoPrep

RepoPrep 是一款 Windows 桌面应用：读取本地项目代码与文档，调用你配置的大模型生成面试问题、参考答案和追问，专业名词点开即有解释，帮你按真实项目准备面试。

![RepoPrep 结果页：项目概览与按主题分组的问题列表](docs/images/result-overview.png)

截图来自 RepoPrep 对自身项目生成的一份真实分析。

## 功能

- 围绕所选项目的架构、模块职责和关键实现出题，可选择通用、前端、后端或算法方向。
- 每题附参考答案与「面试官可能的追问」，逐条展开演练。
- 正文中的专业名词带下划线，点开即显示术语表解释；需要更深入时可让 AI 结合本项目继续解释。
- 结果页可搜索问题、答案和名词；题号稳定，搜索过滤不改变编号。
- 每个项目保留多份历史分析，可随时回看；支持导出 Markdown、后台生成。
- 兼容 OpenAI 与 Claude（Anthropic Messages）接口规范，按服务商配置模型。

问题深度可选粗粒度（架构级，约 8–12 题）、中粒度（模块级，约 15–25 题）和细粒度（实现级，约 25–40 题）。

## 快速启动

需要 Node.js 22.15+（22.x）或 24+。

```bash
git clone https://github.com/dhasho/RepoPrep.git
cd RepoPrep
npm ci
npm run dev
```

1. 在设置中填写接口规范、服务商地址、模型名与 API Key，测试连接。
2. 侧栏「新建」选择项目文件夹，选问题颗粒度和考察方向后开始生成。
3. 查看答案与追问，点开术语解释，按需导出 Markdown 或回看历史分析。

生成时，所选项目的相关代码与文档会发送给你配置的模型服务。

## 界面示例

### 参考答案与追问

![展开的参考答案与追问](docs/images/answer-followup.png)

### 专业名词解释

![术语解释弹卡](docs/images/term-popover.png)

## 更多说明

- [开发指南](docs/development.md)：环境、启动、常见问题。
- [密钥保护](docs/credential-security.md)：API Key 的存储与 IPC 边界。
- [文档索引](docs/README.md)：全部文档与报告入口。
