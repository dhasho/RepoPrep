# 局部上下文修复的离线验证

本轮修复 Python 混合 bare/member 调用的词法顺序和全局边阈值，并让父代码区域能够节选已确认的嵌套文档字符串。未调整排名权重或预算；没有新增真实模型调用，实际 provider usage 为 null。

当前代码的四例请求体捕获中，mitt、p-limit、schedule 与上轮实测的正文哈希逐字节相同；Requests 因调用顺序修复而变化。嵌套文档模块没有在这四例中进一步改变正文。旧四例的 25/28 核心覆盖、8 类实质错误和 213,010 tokens 仍只代表原测量源码，不能标作当前代码的新实测结果。

| 项目 | 上轮正文是否相同 | 当前估算输入 tokens | 实际 tokens |
| --- | --- | ---: | --- |
| mitt | 是 | 14,570 | 未测量 |
| p-limit | 是 | 27,013 | 未测量 |
| schedule | 是 | 63,997 | 未测量 |
| Requests | 否 | 63,995 | 未测量 |

所有估算都在原 64,000 输入目标内，字符、文件、读取及窗口硬限制没有提高。比较覆盖语料 manifest 指定的 598 个候选区域：原始边界和文本哈希保持，已观察到的区域没有新增或丢失，28 个固定事实的聚合源证据状态也未变化。这里没有覆盖所有被扫描文件，且聚合状态不等于实现完整性或答案正确性；Requests 正文仍发生了变化，不能据此宣称所有上下文相同。`SessionRedirectMixin.resolve_redirects` 原本就未完整观察到，不能把它说成已保留的完整实现；既有辅助实现与属性缺口仍待处理。

具体改变是：

- Python 记录有界的(kind,name)首次调用事件，按既有唯一声明与作用域规则解析，避免先分组成员调用再处理裸调用。重复目标按首次出现去重，每调用者最多 8 个、全局严格最多 1024 条边，不增加继承、别名或动态派发推断。
- 已确认的自身与嵌套文档范围按原始 offset 收集，每区域最多 64 个；短文档和含反斜杠文档分别保持原样，其他长文档单次拼接节选。任何省略仍明确标记不完整；whole-fit 保留原字节，`__doc__` 和行位置不保证原值。

主目录 typecheck、102 项文件选择测试、118 项预算测试通过。Electron 构建冒烟为 `SMOKE-OK`、退出 0，隔离 fixture 已清理。另用 Python 3.12.10 的隔离 AST 解析检查三个固定源码文件中的 11 个可节选候选：遮蔽文档字符串值并忽略位置后，其余 AST 一致。只解析 region.text，不执行语料代码；这不是运行时语义等价或完整 AST 身份保证。

## 排名实验的取舍

四个仅离线捕获的重排实验均未采用，详细增失见 [rejected-policies.json](rejected-policies.json)。A/B 加入 prepare_hooks，却丢失此前提供的 IDNA 辅助函数和 __iter__；C 的统一属性加分补上 next、text、raise_for_status，却挤掉 prepare 等关键实现；D 只加入 apparent_encoding，仍未填补目标缺口，且丢失两个原有区域。未把这些有失有得的观察称为质量改善，也没有继续搜索常数。

这些案例已参与开发迭代，不是独立 holdout。所有新捕获均使用生产扫描、生成器和客户端序列化，但 fetch 仅在进程内向 `https://context-audit.invalid` 返回合成响应，不读取用户设置或密钥、不访问上游。机器证据见 [report.json](report.json)、[comparison.json](comparison.json)、[ast-proof.json](ast-proof.json) 与 [provenance.json](provenance.json)。候选字段描述可节选性，实际是否提供应看 `state`、`originalProvided`、`documentationExcerptProvided`，不能只看 `documentationOmitted`。

复现当前生产捕获可运行 `npm run eval:context -- --repos-root <公开语料父目录> --reference-report reports/real-generation-eval/2026-11-04-doc-excerpt-requests/report.json --output <新目录>`。原 5 次付费授权均已用完；本目录不能作为新增真实质量或货币成本收益的证明。
