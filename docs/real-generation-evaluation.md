# 本机已保存模型的真实生成评测

离线评测使用合成响应，适合验证流水线和评分器；它不能代表真实模型表现。本入口读取当前 Windows 用户由 Electron OS 凭据存储加密的已保存 profile，在同一个 Electron 主进程内解密并运行真实生成评测。密钥只在该进程内存中，不经命令行、环境变量、临时 profile 文件或输出报告传递。

真实评测固定使用 `scripts/evaluation/real-corpus/corpus.json` 指定的公开仓库和 SHA。四个仓库均为低依赖公开样本；先运行语料校验确认固定 revision 与工作树，再运行评测。验证不读取用户设置、不解密凭据，也不调用模型。

## 结果与报告入口

已完成的真实运行与逐事实复核结果统一索引在[报告索引](../reports/README.md)：最新单例筛查为 2026-11-04 Requests low，完整事实覆盖持平、总 token 增加，未继续其余三例；2026-11-01 scoped 是最近的四例运行，也未证明收益。2026-10-24 grounded 保留为较低用量参考，原始基线为 2026-10-23 运行。核对存量报告只需读取各目录的 JSON（runId、源码/fixture 哈希、题目指纹、请求回执），不需要发起新的模型调用。显式降低推理强度不保证用量下降，必须以实际回执和逐事实复核为准。

## 运行前

### 零网络上下文证据审计

在准备真实评测前，可运行 `npm run eval:context -- --repos-root <公开语料父目录> --output <新目录>`。它先核验固定语料，再通过生产扫描与生成器构造最终请求；进程内 fetch 仅允许 `https://context-audit.invalid` 并返回合成 20 题。该命令不读取设置或凭据，不访问模型服务。可重复传入 `--case <id>`；`--reference-report <report.json>` 只读取模型、协议、温度、推理强度、上下文窗和输出上限等非私密推理配置，并且仅支持 OpenAI 协议。报告标记为 context-only，实际 provider usage 为 null；请求体只记录哈希，不保存完整提示词、未脱敏源码或合成响应。证据字段会记录脱敏的候选区域原文或文档节选。源码证据匹配是文本证据，不等于唯一 AST 节点身份、完整实现保证或答案正确性评分；没有可靠候选边界时只报告文件级状态。

仅在获得明确授权后运行真实评测：此流程会访问真实模型服务，可能产生费用或受账户额度限制。

- 确认目标 profile 已在当前 RepoPrep/ProjectLens 安装中保存，且其凭据状态可由当前 Windows 用户解密。默认使用设置中当前选择的 profile；可使用 `--profile-id` 覆盖。默认设置目录为 `%APPDATA%\ProjectLens`，可用 `--settings-dir` 指定已有目录。
- 按[语料说明](../scripts/evaluation/real-corpus/README.md)检出四个公开仓库，并通过 `--repos-root` 指向它们共同的父目录。建议放在 RepoPrep 工作目录之外，例如相邻的 `RepoPrep-Eval-Cases` 文件夹。
- 选择一个新的输出目录。generation 与 README/tree baseline 的总请求数限制在 16 次，runner 总时限为 20 分钟。真实请求只在运行评测命令时发出。
- 评测只读取 schemaVersion 2 设置快照和 `userData/Local State` 中的加密字段，将它们复制到短生命周期的隔离 Electron `userData`/`sessionData`。Local State 仅保留 `os_crypt.encrypted_key` 和可选的布尔型 `audit_enabled`；其中密钥仍由 Windows DPAPI 保护，遇到 app-bound 状态会拒绝运行。不会复制浏览器历史、偏好或其他浏览器状态。旧版 schema、包含 legacy 明文 `apiKey` 的配置、缺失文件或不可用的 OS 加密都会 fail-closed。原始设置、Local State、备份和损坏副本不会迁移或修改。隔离副本和打包 runtime 在子进程退出后按绝对路径、目录边界和链接状态检查后清理。

## 命令

```powershell
npm run eval:real -- verify --repos-root '..\RepoPrep-Eval-Cases'
npm run eval:real:saved -- --repos-root '..\RepoPrep-Eval-Cases' --output '.\reports\real-generation-eval\run-next'
npm run eval:real:saved -- --repos-root '..\RepoPrep-Eval-Cases' --output '.\reports\real-generation-eval\candidate-generation-only' --variant generation
npm run eval:real:saved -- --repos-root '..\RepoPrep-Eval-Cases' --output '.\reports\real-generation-eval\candidate-reasoning-low' --variant generation --reasoning-effort low
npm run eval:real:saved -- --preflight
```

可用参数：`--case <id>`（重复以选择 case）、`--variant generation|baseline`（重复选择 variant；缺省运行两组）、`--profile-id <id>`、`--settings-dir <directory>`、`--max-requests <1..16>`、`--reasoning-effort low|high`。推理强度只对 OpenAI 协议有效；未指定时使用已保存值，缺省等同服务商默认值。CLI 覆盖只用于本次隔离子进程的内存 profile，不保存回用户设置；传入值在读取设置和凭据前校验，协议不兼容时拒绝运行。DeepSeek thinking 模式下 temperature 不生效，但报告仍如实记录配置值。比较运行时缺省要求 reasoning effort 一致，只有显式传入 `--allow-reasoning-change` 才允许跨推理强度对比。报告与配置哈希记录实际强度；low/high 不改变应用现有输入预算及输出预留。其他不支持或重复的 variant 会在读取设置和凭据前拒绝。生成组使用完整生产扫描；README 对照组仍只把 README 正文作为候选，同时保留项目树和扫描元数据。`--preflight` 启动真实 Electron、建立隔离目录并导入生产 TypeScript runner，不读取设置或凭据、不发出网络请求；`--credential-preflight` 在同样隔离的流程里额外验证已保存凭据可解密，仍不发出网络请求。使用 `--help` 查看命令。wrapper 子进程以隐藏窗口方式启动，不打开 BrowserWindow，不获取项目单实例锁。运行期间不要退出终端；超过硬时限会终止 Electron 子进程。

输出报告记录 profile 的 context window、实际输出 token cap、应用输入 token 预算与预留策略。每组还记录独立的输入 token 估算、provider usage receipt、请求/格式修复计数与 context/model 阶段时间。provider 未返回完整 usage 时真实 token 用量为 `null`；输入估算不会冒充真实用量。每 case 失败会记录 failure stage 并使运行不完整。报告不包含 API key、设置快照或认证头。

流式响应立即交给生产生成器，评测观察器异步逐事件读取副本，单事件缓冲限制为 64 Ki 字符；非 SSE JSON 响应仍限制整体 1 MiB。每组写入报告前等待用量汇总，遇协议终止事件即可结束观察，无需等待 HTTP 连接关闭。OpenAI SSE 使用最后一份 usage 对象；Anthropic SSE 合并开始事件中的输入与结束前的输出计数，并要求结束事件。截流、无效回执或网络失败的未知用量保留为 `null`，不会补零。若已有完整的生产生成诊断用量，报告与比较器会独立使用这份 provider 记录，并保留原始 transport 字段的未知状态。

## 比较与 cohort

可用比较器对旧报告中的 generation 组和新候选报告进行同语料比较：

```powershell
npm run eval:real:compare -- '.\reports\real-generation-eval\2026-10-23-deepseek-v4-flash\report.json' '.\reports\real-generation-eval\candidate-generation-only\report.json'
npm run eval:real:compare -- '.\reports\real-generation-eval\provider-default.json' '.\reports\real-generation-eval\reasoning-low.json' --allow-reasoning-change
npm run test:eval:real
```

比较器要求两份完整报告的 corpus version、generation 变体、case revision、fixture hashes、模型/协议、颗粒度和题量预算匹配，并默认要求 reasoning effort 一致。旧报告未记录该字段会按 `provider-default` 解释，和新版显式 `provider-default` 等同。比较不同强度时，CLI 使用 `--allow-reasoning-change`；条件表和 caveat 会明确列出变化，并将其视作不同推理条件。比较器校验 canonical output、generation question 列表与 report question 指纹的对应关系；也记录两份输入报告的整体 SHA-256、source hashes 与 token/context 策略的变化。旧版 review digest 只绑定 canonical output 和 questions，没有绑定 generation metadata，因此比较器会明确报告这项限制。比较结果是整版观察；它不把关键词命中当作准确率，不把代理辅助复核称作人工复核，也不推测费用。

只重新生成受影响的项目时，可把完成的子集运行与先前测量组成显式 cohort（来源报告都必须完整结束；中断运行和未完成 case 会被拒绝）。模型配置中的 reasoning effort 也须匹配；旧报告缺省值按 `provider-default` 解释。旧结果仅在当前生产扫描、上下文、提示与客户端构造出的请求体 SHA-256 和原请求完全相同，且模型配置、项目 revision、fixture hashes 及当前源码哈希均绑定后复用；还应审查生成后的解析与归一化代码没有改变旧输出的解释。证明须来自实际的合成传输捕获，不能只把旧哈希填入 JSON。

```powershell
npm run eval:real:cohort -- <baseline-report.json> <current-subset-report.json> <prior-report.json> <current-request-proof.json> <new-output-directory>
npm run eval:real:cohort -- <baseline-report.json> <current-subset-report.json> <prior-report.json> <current-request-proof.json> <new-output-directory> --allow-reasoning-change
```

默认要求 baseline 与 current 的 reasoning effort 一致。只有 baseline→current 的对照可在显式追加末尾 `--allow-reasoning-change` 后跨强度组合；输出会记录两端强度并加入不同推理条件的 caveat。current 与 reuse 的强度及 reuse proof 配置仍须一致，不能由此开关放宽。

该命令生成 `repoprep-real-eval-cohort-v1` 格式的 `cohort.json` 和 `report.md`，保留各 case 的来源 run、报告引用、请求回执与问题指纹。proof 的 `cases` 是以 case id 为键的对象，每项包含 `identical`、`originalPromptHash` 和 `currentPromptHash`，并须提供完整的 `currentSourceHashes` 与 `configuration`；其中包含 `reasoningEffort`，旧 proof 缺省按 `provider-default` 处理。工具校验哈希绑定和输出对应关系；它不会替调用者生成或证明未执行过的观测。

`selectedMeasurementsRequests` 是选中 generation 测量所含的调用总数，可能包含历史调用；`freshNetworkRequests` 是 current 来源运行全部捕获的 HTTP 次数，包含其 README 对照等额外调用。缺少总回执且无法确定范围时保留未知。token 汇总仍只对应选中的 generation 测量，不能作为本次研究全部账单。复用结果不重新标成新生成，代理复核也不重新标成人工盲审。

`test:eval:real` 同时包含合成 HTTP 回归和两个真实 Electron 进程间的合成凭据往返。后者验证当前平台的 OS 加密快照链路，不读取真实用户凭据，也不代表真实 API 验收；正式模型调用必须以实际报告为证。

## 边界

- 模型生成的问题/答案须逐项核对源码；人工评价 `pending` 不等于通过。关键词覆盖只能表示字符串命中，不能用于宣称事实正确率。即使 HTTP 请求成功或结果通过结构契约，也不能单独证明模型回答准确。
- 代理辅助复核不是人工盲审，也不能换算成全部答案正确率。
- 重新运行真实评测产生的是新测量，模型输出不保证逐字复现。存量结论以已保存报告及其哈希、指纹、回执为准。
