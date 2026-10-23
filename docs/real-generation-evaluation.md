# 本机已保存模型的真实生成评测

离线评测使用合成响应，适合验证流水线和评分器；它不能代表真实模型表现。本入口读取当前 Windows 用户由 Electron OS 凭据存储加密的已保存 profile，在同一个 Electron 主进程内解密并运行真实生成评测。密钥只在该进程内存中，不经命令行、环境变量、临时 profile 文件或输出报告传递。

真实评测固定使用 `scripts/evaluation/real-corpus/corpus.json` 指定的公开仓库和 SHA。四个仓库均为低依赖公开样本；先运行 `npm run eval:real -- verify --repos-root 'E:\Vibe Coding\RepoPrep-Eval-Cases'` 检查固定 revision 和工作树。验证不读取用户设置、不解密凭据，也不调用模型。

## 已完成的首版基线

[2026-10-23 真实报告](../reports/real-generation-eval/2026-10-23-deepseek-v4-flash/report.md)使用 `deepseek-v4-flash`，对 mitt、p-limit、schedule、Requests 各运行生产上下文与 README 对照组，8 组各生成 20 题，共 160 题、9 次真实 HTTP 请求。固定提交、28 条核心事实、参考问答和源码行号见[事实语料](../scripts/evaluation/real-corpus/README.md)。扫描源码无需安装上游项目的开发依赖。

报告包含代理辅助的逐事实复核及主代理审查，完整覆盖的事实为生产组 23/28、对照组 17/28；这不是全部答案的正确率，也不是人工盲审结果。Requests 生产组仍有可变性与流式缓存相关错误，不能据此宣称增加上下文总能提升质量。原始问题、追问、调用用量、源码哈希及复核指纹均保留在同目录 JSON 中。

## 运行前

- 确认目标 profile 已在当前 RepoPrep/ProjectLens 安装中保存，且其凭据状态可由当前 Windows 用户解密。默认使用设置中当前选择的 profile；可使用 `--profile-id` 覆盖。默认设置目录为 `%APPDATA%\ProjectLens`，可用 `--settings-dir` 指定已有目录。
- 确认公开评测仓库已检出在 `E:\Vibe Coding\RepoPrep-Eval-Cases`。可以通过 `--repos-root` 指定位置。
- 选择一个新的输出目录。此流程会访问真实模型服务，可能产生费用或受账户额度限制；本入口把 generation 与 README/tree baseline 的总请求数限制在 16 次，runner 总时限为 20 分钟。真实请求只在运行评测命令时发出。
- 评测只读取 schemaVersion 2 设置快照和 `userData/Local State` 中的加密字段，将它们复制到短生命周期的隔离 Electron `userData`/`sessionData`。Local State 仅保留 `os_crypt.encrypted_key` 和可选的布尔型 `audit_enabled`；其中密钥仍由 Windows DPAPI 保护，遇到 app-bound 状态会拒绝运行。不会复制浏览器历史、偏好或其他浏览器状态。旧版 schema、包含 legacy 明文 `apiKey` 的配置、缺失文件或不可用的 OS 加密都会 fail-closed。原始设置、Local State、备份和损坏副本不会迁移或修改。隔离副本和打包 runtime 在子进程退出后按绝对路径、目录边界和链接状态检查后清理。

## 命令

```powershell
npm run eval:real -- verify --repos-root 'E:\Vibe Coding\RepoPrep-Eval-Cases'
npm run eval:real:saved -- --repos-root 'E:\Vibe Coding\RepoPrep-Eval-Cases' --output '.\reports\real-generation-eval\run-next'
npm run eval:real:saved -- --repos-root 'E:\Vibe Coding\RepoPrep-Eval-Cases' --output '.\reports\real-generation-eval\candidate-generation-only' --variant generation
npm run eval:real:saved -- --preflight
```

可用参数：`--case <id>`（重复以选择 case）、`--variant generation|baseline`（重复选择 variant；缺省运行两组）、`--profile-id <id>`、`--settings-dir <directory>`、`--max-requests <1..16>`。不支持的或重复的 variant 会在读取设置和凭据前拒绝。生成组使用完整生产扫描；README 对照组仍只把 README 正文作为候选，同时保留项目树和扫描元数据。`--preflight` 会启动真实 Electron、建立隔离目录并导入生产 TypeScript runner，不读取设置或凭据、不发出网络请求。使用 `--help` 查看命令。wrapper 子进程以隐藏窗口方式启动，不打开 BrowserWindow，不获取项目单实例锁。运行期间不要退出终端；超过硬时限会终止 Electron 子进程。

输出报告记录 profile 的 context window、实际输出 token cap、应用输入 token 预算与预留策略。每组还记录独立的输入 token 估算、provider usage receipt、请求/格式修复计数与 context/model 阶段时间。provider 未返回完整 usage 时真实 token 用量为 `null`；输入估算不会冒充真实用量。报告不包含 API key、设置快照或认证头。

可用比较器对旧报告中的 generation 组和新候选报告进行同语料比较：

```powershell
node --experimental-strip-types --import ./tests/register-shared-alias.mjs scripts/evaluation/compare-real-runs.mjs '.\reports\real-generation-eval\2026-10-23-deepseek-v4-flash\report.json' '.\reports\real-generation-eval\candidate-generation-only\report.json'
node --test scripts/evaluation/compare-real-runs.test.mjs
```

比较器要求两份完整报告的 corpus version、generation 变体、case revision、fixture hashes、模型/协议、颗粒度和题量预算匹配。它校验 canonical output、generation question 列表与 report question 指纹的对应关系；也记录两份输入报告的整体 SHA-256、source hashes 与 token/context 策略的变化。旧版 review digest 只绑定 canonical output 和 questions，没有绑定 generation metadata，因此比较器会明确报告这项限制。比较结果是整版观察；它不把关键词命中当作准确率，不把代理辅助复核称为人工复核，也不推测费用。

模型生成的问题/答案须逐项核对源码；`pending` 人工评价不等于通过。关键词覆盖只能表示字符串命中，不能用于宣称事实正确率。即使 HTTP 请求成功或结果通过结构契约，也不能单独证明模型回答准确。

`test:eval:real` 同时包含合成 HTTP 回归和两个真实 Electron 进程间的合成凭据往返。后者验证当前平台的 OS 加密快照链路，不读取真实用户凭据，也不代表真实 API 验收；正式模型调用必须以实际报告为证。
