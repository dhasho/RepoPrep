# 文档索引

按用途导航。规范与流程正文以各文件为准，本页不重复其内容。

## 开发与日常

- [开发指南](development.md)：环境、启动、常见问题。
- [密钥保护](credential-security.md)：API Key 的存储方式与 IPC 边界。

## 技术参考

- [项目规范](project-standards.md)：架构与职责划分。
- [上下文文件选择](file-selection.md)：文件选择与预算分配的设计。
- [验证指南](validation.md)：各测试命令与适用范围。
- [版本策略](VERSIONING.md)
- [代码审查](review.md)

## 生成质量评测

- [评测指南](generation-evaluation.md)：离线评测方法与限制。
- [真实模型评测](real-generation-evaluation.md)：固定公开语料上的真实模型评测流程。
- [评测报告索引](../reports/README.md)：当前结果、基线与历史报告。

## 历史兼容

- [升级到 1.0.0](upgrade-1.0.md)：数据与 IPC 的不兼容变化及迁移。
- [历史来源字段兼容](source-evidence.md)：旧结果字段的读取策略。

## 模型编排

- [模型编排取舍](model-orchestration.md)：为什么直接使用模型 HTTP 接口而不引入代理框架。
