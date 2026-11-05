# 误述对应源码的可见性

本审计仅重建生产请求并使用进程内合成响应，真实模型调用为 0。Requests 与 mitt 的请求体哈希分别与原测量逐字节一致，107 项生成源码哈希也与两份原报告相同。结果见 [finding-context-audit.json](finding-context-audit.json)，复现脚本见 [audit-finding-context.mjs](audit-finding-context.mjs)。原始生成结果和逐事实评分没有改动。

审计覆盖已计入复核的 8 类表述问题（6 类 incorrect、2 条 imprecise）及其全部 21 个不同源码引用范围。

| 项目 | 完整提供的引用 | 部分提供的引用 | 与派发区域不相交的引用 |
| --- | ---: | ---: | ---: |
| Requests | 7 | 1 | 4 |
| mitt | 9 | 0 | 0 |

“完整提供”要求实际 dispatch 元数据属于同一文件，派发区域覆盖引用范围，并且该区域的脱敏原文在最终请求中得到核验。文档节选范围单独处理；不通过 Markdown 标题猜测文件边界，也不凭另一个文件的同名字符串判定可见性。“部分提供”与整段未观测区分，元数据或行号无法确认时保持未知。

- Requests Q2：`prepare` 与鉴权器注册 hooks 的引用已提供；`register_hook`、`prepare_auth`、`prepare_hooks` 的三个引用未与任何派发区域相交。这是辅助实现缺口的观察，不能据此断言它造成了错误解释。
- Requests Q3：Session 中写入下一请求的引用已提供，`Response.next` getter 的引用未提供。
- Requests Q9：请求 cookie 字典归一化、合并与 CookieJar 更新的三个引用均完整提供；该次误述不能仅归因于这三个引用缺失。
- Requests Q17：907–927 行的引用只部分提供，跨越未入选的声明与文档节选；958–965 行的运行时 guard 完整提供。不能把父函数有文档节选等同于 guard 缺失。
- mitt Q5、Q7、Q16、Q18：九个项目源码引用均完整提供。Q7 引用的 TypeScript 5.9.3 探针是在生成后执行的，Q18 的 npm-run-all 混合分组语义来自外部文档；两者均未进入模型上下文。因此，项目源码可见不等于判断所需的全部语言或依赖语义都已提供。

下一轮应分别验证两条方向：在固定预算下保留相关辅助调用和属性实现，以及减少已有源码证据下的无条件断言。涉及外部语义时应明确证据前提。现有提示词已经包含源码依据、假设、泛型结构约束与 guard 要求；增加类似措辞本身不能当作有效修复。任何质量或 token 收益仍须新的匹配生成测量来证明。

## 复现

在与原报告 `sourceHashes` 一致的 RepoPrep 源码目录运行，输出目录必须尚不存在：

```powershell
node --experimental-strip-types --import ./tests/register-shared-alias.mjs reports/real-generation-eval/2026-11-04-doc-excerpt-requests/audit-finding-context.mjs --root . --repos-root '..\RepoPrep-Eval-Cases' --output '.validation/finding-context-next'
```

脚本先后核验固定语料和源码字节哈希，读取已绑定的报告及复核文件，再用只允许 `https://context-audit.invalid` 的合成 fetch 捕获生产序列化结果。源码或请求哈希漂移会拒绝运行。脚本不读取用户设置或凭据，不访问模型服务、不执行上游项目；仅保存相对路径、行号/offset、哈希、问题指纹和派发元数据，不保存源码正文或完整请求。

本审计是非盲的代理辅助证据分析，不能证明答案正确性、唯一因果关系或所有 AST 节点身份；没有新增人工评分或真实模型质量测量。原授权调用数仍为 4/4，p-limit 的额外调用尚未获授权。
