# 生成质量评测

运行 `npm run test:eval` 检查指标与人工复核导入器，再运行 `npm run eval:offline` 生成完整离线评测报告。CLI 默认只绑定 `127.0.0.1`，不访问外部网络，不读取设置、appData 或用户密钥，也不调用真实或收费模型。runner 临时创建 synthetic profile，密钥仅为内存占位值。

## 评测范围

当前报告描述的是离线流水线和评分器校准。它通过生产 `scanProject`、`generateInterview`、context builder、题量规划、合并/补偿、result contract 和 LLM HTTP client 跑三份版本化小型 fixture。React 状态与 Node HTTP 路由使用 medium，Python CLI 使用 fine。Python fine 模式的本地响应服务在初轮每批只返回一题，确认生产生成器会走补偿请求；Node HTTP 路由 case 的首个原始回复故意为非法 JSON，runner 验证 repair 请求能够恢复生成，同时确认模型提示和新结果不包含来源引用字段或行号开销。

`reports/offline-generation-eval/report.json` 保存逐题结果、每次本地请求消息与原始返回文本、case 指标、baseline、hash 和配置；`report.md` 是概览。输出路径可作为 `npm run eval:offline -- <directory>` 传入。报告使用 `/fixtures/<case>` 作为跨平台 absolute path contract 占位，不包含机器绝对路径或 API key。响应固定标识 `fixture-context-keyword-v1-json-repair`，baseline 每 case 返回一次有效 JSON 且不提供代码内容 manifest；Node 生成 case 的格式修复校准独立记录，不表示质量提升。`tokens` 为 `null`，字符数仅为请求输入字符数。报告记录生成时的 Node 版本。

## 指标含义

- Contract：生产结果是否通过 `assertInterviewResultContract`。
- Raw format/repair：按本地 HTTP 返回记录 JSON 可解析/不可解析次数和 repair 请求数；Node case 注入一次无效 JSON，再确认生产 repair 得到有效 JSON。最终 contract 单独记分，不能用它覆盖原始格式失败。
- Quota：题量是否处于 `shared/types.ts` 对应 granularity 的 min/max 范围。
- Duplicate rate：将题面交给生产 `normalizeQuestionKey` 后，重复键数除以题量。它只检查文字重复，不识别语义重复。
- Known fact keyword coverage：每个 fixture 事实配置的关键词是否至少在题目、答案或追问中出现。它是可观察关键词覆盖，不代表事实正确率。
- Forbidden assertion hits：在题目、答案和追问中查找 fixture 明确禁止的断言模式；命中只提示需复核，不代表通用内容审核。
- Requests、failed requests、elapsed ms、input chars：生产生成过程及 baseline 请求数、失败数、耗时与输入字符量。每 case 失败会使 CLI 非零退出，不生成“成功”报告。
- Source hashes：完整记录 `electron/services` 与 `shared` 下的 TypeScript 文件，以及评测脚本、`package.json` 和 `package-lock.json` 的 SHA-256。
- Baseline：每 case 用同一个 synthetic profile 和同一预算，向本地响应器发出一次请求，上下文仅包含 README 与生产渲染的文件树。Pipeline 与 baseline 的差异不能解释为模型质量改进。

## 人工评价

`review-template.json` 为 pipeline 与 baseline 的每个问题创建题面、答案、追问和 SHA-256 fingerprint，并绑定 runId、corpusVersion、configHash 和包含报告题目 sidecar 的 report digest。将模板复制后，为每题填写 1–5 分：

| 维度 | 1 分 | 3 分 | 5 分 |
|---|---|---|---|
| 事实正确性 | 有不支持或错误断言 | 信息混合或无法确定 | 每项实质主张均有 fixture 支持 |
| 项目相关性 | 与项目无关 | 泛化但能套用 | 指向项目核心实现选择 |
| 语义重复 | 与其他题重复 | 部分重叠 | 清楚考察不同内容 |

2 分与 4 分分别表示低于或高于相邻锚点之间的表现。示例：问题询问 `useState` 如何保存搜索词且代码中可见 `useState`，事实正确性可给 5；问 Redis 集群如何故障转移，而 fixture 没有 Redis，应给 1。

导入器的 `validateReview(review, manifest)` API 严格校验 run、corpus、config、fingerprint 是否存在且唯一，分数必须是整数 1–5 或 `null`。未知题、重复题、越界分数和错 run 会拒绝。未填或部分填写均保持 pending，`reviewedCount` 仅统计三个维度齐全的题，coverage 以题目数为分母；不把 pending 当作通过，也不把缺失分数纳入平均值。将来对真实生成结果复用同一流程时，生成符合 report manifest 的题目 fingerprint 并构造同样绑定字段即可；本次未运行真实模型评价。

人工复核 CLI 通过 `npm run eval:review --` 启动，它使用项目的 TypeScript strip 和 shared alias 注册器。人工模板将题面、答案和追问与报告绑定。评分事实正确性时应独立检查答案主张是否被 fixture 支持：

```bash
npm run eval:review -- template reports/offline-generation-eval/report.json review-template.json
npm run eval:review -- import reports/offline-generation-eval/report.json <filled-review.json>
```

成功导入会校验绑定并更新报告中的 coverage、reviewedCount 和仅基于完整评分的维度均分；同时写出 `review-report.md`。任一绑定或评分错误会非零退出。

## 校准边界

负例测试证明非法结果、重复题、禁用断言、缺少已知事实关键词、错 run、重复或未知 fingerprint、越界分数会触发告警或拒绝导入。这个校准没有判断复杂语义事实、答案深度、可读性、偏见或真实模型能力。任何对真实生成质量的结论都需要盲审和多份真实项目样本，并应另行记录模型、提示词和服务配置。
