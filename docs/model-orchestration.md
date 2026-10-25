# 模型编排的取舍

RepoPrep 当前采用服务模块和显式异步函数组织生成流程：构建上下文、规划题量、调用模型、修复格式、按需补足题量，最后校验并保存结果。相关实现见 [generator.ts](../electron/services/generator.ts)、[context-builder.ts](../electron/services/context-builder.ts) 和 [llm.ts](../electron/services/llm.ts)。

目前保持这一实现，不引入 LangChain 或 LangGraph。生成流程的分支仍然有限，已有两个接口规范覆盖所需模型服务；主要复杂度集中在源码选择、上下文预算和结果协议。迁移框架需要重新验证这些边界，现阶段能省下的适配与编排工作有限。

LangChain 的模型、工具和结构化输出组件适合需要更多不同接口或集成的场景。LangGraph 侧重有状态执行、分支协调和检查点恢复，可以编排现有函数，无需同时迁移模型客户端。它的内存检查点不支持跨重启恢复；即使使用持久化检查点，按当前客户端实现，也不能从一次中断的 HTTP 请求中间继续生成。

如果以后需要跨重启继续多个已完成的分析步骤，或按证据缺口进行多轮补取和局部重写，再比较普通函数与框架的维护成本。框架选择与模型质量评测分开：格式校验约束返回形状，事实核验仍要依靠项目证据；新增审查、重试和补取调用也应计入总用量。

参考：[LangChain 概览](https://docs.langchain.com/oss/javascript/langchain/overview)、[LangGraph 概览](https://docs.langchain.com/oss/javascript/langgraph/overview)、[检查点机制](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)。
