# 本机已保存模型的真实生成评测

离线评测使用合成响应，适合验证流水线和评分器；它不能代表真实模型表现。本入口读取当前 Windows 用户由 Electron OS 凭据存储加密的已保存 profile，在同一个 Electron 主进程内解密并运行真实生成评测。密钥只在该进程内存中，不经命令行、环境变量、临时 profile 文件或输出报告传递。

真实评测固定使用 `scripts/evaluation/real-corpus/corpus.json` 指定的公开仓库和 SHA。四个仓库均为低依赖公开样本；先运行 `npm run eval:real -- verify --repos-root 'E:\Vibe Coding\RepoPrep-Eval-Cases'` 检查固定 revision 和工作树。验证不读取用户设置、不解密凭据，也不调用模型。

## 运行前

- 确认目标 profile 已在当前 RepoPrep/ProjectLens 安装中保存，且其凭据状态可由当前 Windows 用户解密。默认使用设置中当前选择的 profile；可使用 `--profile-id` 覆盖。默认设置目录为 `%APPDATA%\ProjectLens`，可用 `--settings-dir` 指定已有目录。
- 确认公开评测仓库已检出在 `E:\Vibe Coding\RepoPrep-Eval-Cases`。可以通过 `--repos-root` 指定位置。
- 选择一个新的输出目录。此流程会访问真实模型服务，可能产生费用或受账户额度限制；本入口把 generation 与 README/tree baseline 的总请求数限制在 16 次，runner 总时限为 20 分钟。真实请求只在运行评测命令时发出。
- 评测只读取并复制 schemaVersion 2 设置快照中的加密字段到短生命周期的隔离 Electron `userData`。旧版 schema、包含 legacy 明文 `apiKey` 的配置、缺失设置或不可用的 OS 加密都会 fail-closed。设置目录、原始 `settings.json`、备份和损坏副本不会迁移或修改。隔离副本和打包 runtime 在子进程退出后按绝对路径、目录边界和链接状态检查后清理。

## 命令

```powershell
npm run eval:real -- verify --repos-root 'E:\Vibe Coding\RepoPrep-Eval-Cases'
npm run eval:real:saved -- --repos-root 'E:\Vibe Coding\RepoPrep-Eval-Cases' --output '.\reports\real-generation-eval'
npm run eval:real:saved -- --preflight
```

可用参数：`--case <id>`（重复以选择 case）、`--profile-id <id>`、`--settings-dir <directory>`、`--max-requests <1..16>`。`--preflight` 会启动真实 Electron、建立隔离目录并导入生产 TypeScript runner，不读取设置或凭据、不发出网络请求。使用 `--help` 查看命令。wrapper 子进程以隐藏窗口方式启动，不打开 BrowserWindow，不获取项目单实例锁。运行期间不要退出终端；超过硬时限会终止 Electron 子进程。

输出报告应记录实际 model、协议、评测版本和请求数，但不应包含 API key、设置快照或认证头。模型生成的问题/答案须人工逐项核对源码；`pending` 人工评价不等于通过。关键词覆盖只能表示字符串命中，不能用于宣称事实正确率。即使 HTTP 请求成功或结果通过结构契约，也不能单独证明模型回答准确。自动复核可能阻止真实服务调用；mock 测试不绕过或模拟该复核。

开发期间的 mock 测试只验证参数、隔离和调用边界，不等同于本机 OS 解密或真实 API 验收。
