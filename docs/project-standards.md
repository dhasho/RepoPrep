# 项目规范

RepoPrep 是 Electron 桌面应用：renderer（React）负责交互展示，主进程及 `electron/services/` 负责扫描、上下文构建、生成、模型访问、导出与持久化，双方通过受守卫的 IPC 通信。本文记录跨模块共享的架构事实与技术约束；协作流程、审查、验证和版本规则见根目录 `AGENTS.md` 及 `docs/` 下对应文档。

## 架构

RepoPrep 是 Electron 桌面应用，调用方向为 renderer → `window.api` → preload → 主进程 guard → service：

- `shared/types.ts` 定义主、渲染进程共享的数据类型，`shared/ipc.ts` 定义 IPC 通道和 `window.api` 契约。跨进程变更需同时更新调用方、preload、主进程处理器及 `electron/services/ipc-validation.ts` 的运行时校验，并复用 `electron/services/ipc-handler-guards.ts` 统一守卫。
- `electron/main.ts` 负责窗口生命周期和业务编排；Electron 能力、文件系统、模型网络请求和持久化留在主进程及 `electron/services/`。preload 只映射经过审查的 IPC 接口，renderer 不直接获得 Node 或 Electron 通用 API。
- `electron/services/` 按扫描、上下文构建、生成、模型访问、导出、存储、安全与授权等职责组织；业务策略不塞入 preload，UI 不承担文件访问、授权或模型调用。
- renderer 页面与组件负责交互与展示，共享数据形状以 shared 类型为准；状态订阅在组件卸载时解除监听。
- `shared/` 可包含类型、共享常量和纯函数，不依赖 Electron 或 `src/`。
- 项目扫描以实际文件为输入事实（`scanner.ts`），`project-snapshot.ts` 判断变化，`scan-cache.ts` 只提供可失效的复用；已保存设置与结果由 `electron/services/store.ts` 管理的 userData 文件持久化，UI 不把临时状态当作持久化成功的证据。

## 关键约束

### 题量与结果协议

- 题量唯一来源是 `shared/types.ts` 的 `GRANULARITY_QUESTION_BUDGET`（coarse 8/10/12、medium 15/20/25、fine 25/32/40，单位 min/target/max）；`electron/services/question-budget.ts` 负责批次配额规划，生成器负责合并与裁剪。改动预算时同步检查 `GRANULARITY_META`、README 和 UI 承诺，并运行 `npm run test:question-budget`。
- `[[术语]]` 标记、`glossary` 键和值、渲染展示与 Markdown 导出构成结果协议；调整任一部分时审查生成归一化、结果持久化、renderer 展示、导出和旧结果兼容。
- 问题目录优先使用有效的简短主题标题；旧报告缺少标题时走同一通用提炼逻辑，不按项目或报告硬编码。标题一行放不下时自然换行，不用裁切或省略号隐藏内容；完整问题与答案保留原文。

### IPC 与安全

- renderer 输入、项目文件、配置内容和模型输出都视作不可信；IPC 边界做发送方、参数 schema 与项目授权校验，TypeScript 类型不能替代运行时校验。
- 返回 renderer 的错误只暴露安全的静态业务提示；外部错误、文件系统细节及上游响应不得原样回显。
- 保持 BrowserWindow 的 `sandbox`、`contextIsolation` 开启，`nodeIntegration` 与 `webviewTag` 关闭；窗口导航、权限请求和加载入口受 `electron/window-security.ts` 约束。
- API Key 只在主进程私有配置和模型请求中解密；公开设置只返回模型配置元数据、密钥是否存在及凭据状态，保存使用 keep/replace/clear 意图。密钥不得进入 IPC 返回、日志、错误消息、生成结果或导出。持久化密钥使用 Electron `safeStorage` 的异步 OS 加密，不可用时拒绝新密钥写入或解密，不回退明文；细节见 [`credential-security.md`](credential-security.md)。
- 扫描遵守授权和排除规则并过滤敏感信息；未授权路径或被过滤数据不进入缓存、日志、模型请求、结果或导出；缓存复用前确认快照仍有效。
- 上下文只消费经过授权读取与脱敏的项目文本；解析器不创建会自动发现项目文件的编译器 host，也不执行项目代码。输入 token 是估算（`shared/token-budget.ts`），实际 provider usage 独立记录，二者不能互换。
- 长任务与流式请求有明确的运行、成功、失败、取消状态生命周期；结束或取消时释放 abort/controller、监听器和临时资源，旧任务不能覆盖新任务或重复响应。
- 模型输出经有界请求与结果预算校验、归一化后再展示、保存或导出；生成内容不作为指令执行。自动格式修复与补偿是有限次数的兜底，格式正确不代表事实正确。

### 持久化

- `electron/services/store.ts` 通过 `electron/services/atomic-json.ts` 在目标同目录写临时文件、fsync 后原子重命名；成功替换前保留一个 `.bak`，损坏源另存 `.corrupt`，由受控恢复显式替换。该保证针对单个文件，不构成设置主文件、备份及损坏快照间的跨文件事务；密钥迁移逐文件原子替换，中途失败保持 migration-pending，并在后续读取私有凭据、保存或受控恢复时安全重试。

### 依赖与清单

- 依赖解析以 `package-lock.json` 为准，锁文件随依赖变更提交，验证环境用 `npm ci`；文档中的命令与 `package.json` scripts 保持一致。
- 除非确有必要，不增加依赖或引入新的架构层；例外在变更说明中写明原因与补偿措施。

## TypeScript 约定

- 遵循现有严格检查与格式：缩进 2 空格、单引号、不加分号；优先明确类型、窄化 `unknown`、小型纯函数和清晰异步边界；避免无理由的 `any`、类型断言、重复状态及隐藏的全局副作用。
- 直接用 Node 测试 `.ts` 时使用显式 `.ts` 导入扩展名和共享别名注册器，这是测试运行方式的例外，不代表构建代码可以忽略模块解析边界。
- 类型只描述可信形状，不代替外部数据校验；不用宽泛 catch 静默吞掉可诊断错误，用户提示与日志分开处理并过滤敏感值。

## 自动化边界

已有 `typecheck`、构建、IPC、安全、扫描缓存、冒烟、题量预算与依赖审计等 npm 脚本，选择方式见 [`validation.md`](validation.md)。目前没有全局 lint、提交 hook 或自动版本一致性检查，相关约束由人工审查落实；不要把目标规则描述成已有自动门禁。

## 安装与本地数据兼容

`com.projectlens.app` 是沿用的 Electron 安装标识，让 RepoPrep 安装包升级现有 ProjectLens 安装。主进程在 Electron 就绪前显式保留旧 `userData` 目录名称（开发环境 `projectlens`，打包环境 `ProjectLens`），旧设置、近期项目与结果仍可读取。
