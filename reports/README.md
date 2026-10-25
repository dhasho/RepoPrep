# 评测报告索引

本目录存放可复核的评测产物。数字、请求回执、源码与 fixture 哈希、题目指纹一律以各 run 目录内的 JSON 为准，Markdown 只是概览。建议先读当前有效对比与原基线；历史实验目录用于追溯中间失败与设计演变，不代表当前结论。评测方法见[生成评测指南](../docs/generation-evaluation.md)与[真实模型评测指南](../docs/real-generation-evaluation.md)。

## 真实模型评测（`real-generation-eval/`）

普通运行以 `report.json` 保存逐题结果、请求与用量、配置、源码/fixture 哈希和 report digest；`report.md` 提供概览，逐事实复核见已有的 `assistant-review-*.json`。对比产物为 `comparison.md`/`comparison.json`。cohort 目录以 `cohort.json` 汇总已有测量，并保存复用证明和来源引用；它不代表重新执行了一次完整运行。

### 当前有效

- [`2026-10-24-grounded-v1-deepseek-v4-flash/`](real-generation-eval/2026-10-24-grounded-v1-deepseek-v4-flash/report.md) — runId `ee69a921-05fe-4d8d-bf44-2ba4bc72ee21`。mitt、p-limit、schedule、Requests 四例全部新生成：80 题、4 次新鲜 HTTP 调用，无格式修复或补偿请求。逐事实复核完整覆盖 23/28（部分 2、缺失 3、矛盾 0），另记 3 条实质错误、5 条不精确表述。相对原基线 generation 组（输入 146,247、总计 260,433 tokens），本轮输入 109,577（少 25.07%）、总计 213,536（少 18.01%）；token 减少不是费用结论，也不是普遍准确率提升。同语料对比见该目录 `comparison.md`。

### 原基线

- [`2026-10-23-deepseek-v4-flash/`](real-generation-eval/2026-10-23-deepseek-v4-flash/report.md) — runId `86f91465-5ac3-4a70-8e5a-9b076bbbf1ab`。四项目各跑生产 generation 组与 README 对照组：共 160 题、9 次真实请求。逐事实复核完整覆盖生产组 23/28、对照组 17/28；逐题错误清单与源码行号见该目录 `report.md`。后续版本与它比较时只使用 generation 组，不混入 README 对照。

### 历史实验（保留失败与诊断记录，不作为当前结论）

- [`2026-10-23-structure-v1-deepseek-v4-flash/`](real-generation-eval/2026-10-23-structure-v1-deepseek-v4-flash/report.md) — 32k 输入预算实验。完整事实覆盖仅 14/28，未通过覆盖回归检查。
- [`2026-10-24-balanced-v1-deepseek-v4-flash/`](real-generation-eval/2026-10-24-balanced-v1-deepseek-v4-flash/report.md) — 64k 预算。复核中发现 Python 多行声明代码单元边界缺陷（函数体被截断仍标记完整），仅完成 mitt、p-limit 两例复核，Python 两例保留为诊断记录。
- [`2026-10-24-logical-v1-deepseek-v4-flash/`](real-generation-eval/2026-10-24-logical-v1-deepseek-v4-flash/report.md) 与 [`2026-10-24-logical-cohort-v1-deepseek-v4-flash/`](real-generation-eval/2026-10-24-logical-cohort-v1-deepseek-v4-flash/report.md) — 修复单元边界后重生成 Python 两例，与 balanced 的两例 JavaScript（请求体逐字节相同的复用实测）组成显式 cohort；保守完整覆盖 18/28，未通过回归。
- [`2026-10-24-weighted-v1-deepseek-v4-flash/`](real-generation-eval/2026-10-24-weighted-v1-deepseek-v4-flash/report.md) 与 [`2026-10-24-weighted-cohort-v1-deepseek-v4-flash/`](real-generation-eval/2026-10-24-weighted-cohort-v1-deepseek-v4-flash/report.md) — 加权检索改进后再次重生成 Python 两例并组 cohort；完整覆盖 22/28，仍低于基线 23/28，保留为未通过的诊断结果。

四个仓库至此都参与了开发迭代与回归检查；Requests 不再是未使用过的 holdout，任何单例表现都不能外推为普遍结论。

## 离线合成校准（`offline-generation-eval/`）

- [`report.md`](offline-generation-eval/report.md) / [`report.json`](offline-generation-eval/report.json) — 固定合成响应下的生产流水线与评分器校准：契约、题量、重复率、关键词覆盖、JSON 修复路径与 baseline 对照。不调用真实模型、不访问外网，可重复验证流程行为；运行 ID、时间和耗时会变化，不代表真实答案质量。[`review-report.md`](offline-generation-eval/review-report.md) 记录人工复核仍为 pending（0/137）。

## 通用边界

- 关键词覆盖只表示配置关键词在文本中命中，不是事实正确率。
- `assistant-review-*.json` 是代理辅助复核（非盲审），不能称为人工评分；各报告人工复核状态仍为 pending。
- 服务商未返回完整回执时真实 token 用量为 `null`，不会用估算值补零；估算输入 token 单列，不冒充真实用量。
- cohort 中复用的测量保持原 run 出处与请求回执，不重标为新生成；`freshNetworkRequests` 与 `selectedMeasurementsRequests` 的口径不同。
- 事实清单位于 `scripts/evaluation/real-corpus/corpus.json`，只用于语料校验与生成后评分，不进入模型请求；见[语料说明](../scripts/evaluation/real-corpus/README.md)。
