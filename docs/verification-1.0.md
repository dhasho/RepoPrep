# 1.0.0 验收记录

日期：2026-10-17。应用与测试代码基线：6bc065b。环境：Windows、Node.js v24.16.0、npm 11.13.0、Electron 42.11.10。依赖版本未更改，lockfile 仅同步产品版本。

| 检查 | 实际结果 |
| --- | --- |
| npm run typecheck | Node/Electron 与 Web 均通过 |
| npm run test:ipc | 182/182 通过 |
| npm run test:renderer | 102/102 通过 |
| npm run test:lib | 31/31 通过 |
| npm run test:scan-cache | 46 通过，1 项 Windows 平台跳过 |
| npm run test:question-budget | 75/75 通过 |
| npm run test:security | 77 通过，3 项平台跳过；包含生产构建 |
| npm run test:smoke | SMOKE-OK、进程退出 0、父 runner 确认隔离临时目录清理完成 |
| npm run test:native-credentials | Windows 原生 safeStorage 与实际设置服务往返，NATIVE-CREDENTIAL-OK、退出 0 |
| npm run test:eval | 9/9 通过，含人工评分 CLI 与错配拒绝测试 |
| npm run eval:offline | 三个项目的生产流程及单请求基线均完成，仅 loopback 合成响应 |
| npm run eval:review -- import … | 未填模板保持 pending：0/137，三个维度均分均为 null |

真实来源链测试从扫描含合成密钥的源码开始，经实际脱敏、请求引用解析、隔离 userData 存取，再修改和删除源文件；历史页面展开与 Markdown 仍使用原捕获片段。模型请求、结果、存盘 JSON 和导出均检查不含该合成明文密钥。

首次组合运行曾因测试 harness 缺少 credential-vault 映射失败，6bc065b 修复后独立链路及正式套件复跑通过。Windows smoke 的临时目录句柄问题由父 runner 等待 Electron 退出并有限重试清理解决。失败结果未被当作成功证据。

报告见[离线评测报告](../reports/offline-generation-eval/report.md)。原始 JSON 修复、未知来源 ID 拒绝、补偿请求和来源覆盖是流水线校准；未调用真实模型，人工事实正确性与语义重复评分仍待完成。引用范围合法不等于答案正确。

本记录不代表 macOS/Linux 原生凭据验证、真实服务兼容性、安装态或发布安装包验收；本次未执行 dist 或安装流程。完整命令输出保留在本次任务日志中，正式入口及证明范围见[验证指南](validation.md)。

主目录 main 已再次构建并通过隔离 smoke。该次首次启动自动获取 Electron 二进制，因此本记录不声称冷环境或完全断网验证。报告在主目录重新运行后逐项校验了 69 个源码与 8 个 fixture 哈希；这些哈希对应运行时检出的文件字节，Git 换行转换可能改变字节哈希。
