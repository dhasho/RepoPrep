# RepoPrep

RepoPrep 是一款桌面应用：读取本地项目代码与文档，生成面试问题、参考答案和追问，帮助你按项目准备面试。

## 功能

- 聚焦项目本身的架构、模块和实现生成问题。
- 提供答案中的专业名词解释，并支持结合项目继续追问。
- 可配置 OpenAI 兼容模型服务与模型。
- 按项目保存生成结果，支持导出 Markdown。
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

1. 在设置中填写模型服务的 Base URL、模型名及服务要求的 API Key，并测试连接。
2. 选择项目文件夹，再选择问题深度和考察方向（通用、前端、后端或算法）。
3. 生成问题，查看答案与追问；需要时解释术语或导出 Markdown。

所选项目的相关代码与文档会发送给你配置的模型服务，用于生成内容。

开发环境与常见问题见[开发指南](docs/development.md)。项目规范、验证命令和版本策略见[项目规范](docs/project-standards.md)、[验证指南](docs/validation.md)和[版本策略](docs/VERSIONING.md)。
