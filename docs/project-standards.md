# 项目规范

本文定义 ProjectLens 当前架构下的共享实现约束。它是模块边界和技术规范的权威来源；协作流程由根目录 `AGENTS.md` 管理，审查、验证和版本规则分别见 `docs/review.md`、`docs/validation.md`、`docs/VERSIONING.md`。

## 变更与职责

每项需求应写清五项内容：

1. **Why**：要解决的用户或工程问题。
2. **Scope**：涉及和明确不涉及的范围。
3. **Constraints**：兼容性、安全、资源或实现限制。
4. **Acceptance criteria**：可观察、可判定的完成条件。
5. **Test plan**：要运行的检查及预期结果；文档变更说明适用的轻量校验。

先按职责、接口和可独立验收结果拆模块，再根据依赖关系决定串行或并行；共享接口、持久化格式或安全边界的改动要先确定契约。主代理维护计划与模块依赖，审阅集成结果并对照验收条件复核。

## 架构边界

| 主题 | 权威来源 | 责任与检查 |
| --- | --- | --- |
| 跨进程数据与能力 | `shared/types.ts`、`shared/ipc.ts` | 两端、preload 和运行时 schema 同步；不在各层另造一套契约。 |
| 环境、命令与产品版本 | `package.json` 的 `engines`、`scripts`、`version` | 文档与实际清单一致；版本同步规则见 `docs/VERSIONING.md`。 |
| 依赖解析 | `package-lock.json` | 锁文件随依赖变更提交，验证环境用 `npm ci`。 |
| 项目扫描 | 实际文件、`project-snapshot.ts` | 文件是输入事实，快照判断变化，缓存只提供可失效的复用。 |
| 已保存设置与结果 | `electron/services/store.ts` 管理的 userData 文件 | UI 表达当前交互与展示，不把临时状态当作已持久化成功的证据。 |

调用方向为 UI → `window.api` → preload → 主进程 guard → service。`shared/` 可包含类型、共享常量和纯函数，但不得依赖 Electron 或 `src/`；renderer 不导入主进程模块，preload 只映射经过审查的能力。

- 题量唯一来源是 `shared/types.ts` 中的 `GRANULARITY_QUESTION_BUDGET`；`electron/services/question-budget.ts` 负责批次配额规划，生成器负责合并与裁剪。改动预算时同步检查 `GRANULARITY_META`、README 和 UI 承诺，并运行相关题量检查。`[[术语]]` 标记、`glossary` 键和值、渲染展示与 Markdown 导出构成结果协议；调整任一部分时审查生成归一化、结果持久化、renderer 展示、导出和旧结果兼容。
- `shared/types.ts` 定义主、渲染进程共享数据类型；`shared/ipc.ts` 定义 IPC 通道和 `window.api` 契约。跨进程变更应同时检查调用、桥接、校验和两端类型。
- `electron/main.ts` 负责窗口生命周期和业务编排。Electron 能力、文件系统、模型网络请求和持久化留在主进程及 `electron/services/`；renderer 通过 `electron/preload.ts` 暴露的窄接口请求能力，不直接获得 Node 或 Electron 通用 API。
- preload 只映射经过审查的 IPC 接口。新增通道需在共享契约、preload、主进程处理器及 `electron/services/ipc-validation.ts` 的运行时校验中保持一致，并复用 `electron/services/ipc-handler-guards.ts` 统一守卫。
- `electron/services/` 按扫描、上下文构建、生成、模型访问、导出、存储、安全与授权等职责组织。避免把业务策略塞入 preload，也避免让 UI 承担文件访问、授权或模型调用。
- renderer 的页面和组件负责交互与展示；共享数据形状以 shared 类型为准。新增状态订阅应在组件卸载时解除监听。

## 安全与数据

- 把 renderer 输入、项目文件、配置内容和模型输出都视作不可信。IPC 边界要做发送方、参数 schema 与项目授权校验；不能以 TypeScript 类型替代运行时校验。
- 新增或修改 IPC 处理器必须继续走统一 guard。返回 renderer 的错误只允许暴露安全的静态业务提示；外部错误、文件系统细节及上游响应不得原样回显。
- 保持 BrowserWindow 的 `sandbox`、`contextIsolation` 开启，`nodeIntegration` 与 `webviewTag` 关闭；窗口导航、权限请求和加载入口须继续受 `electron/window-security.ts` 的策略约束。
- API Key 仅用于配置与模型请求路径；禁止写入日志、错误消息、生成结果或导出内容。当前设置契约含 `apiKey`，`settings:get` 会把完整 Settings 返回 renderer，设置页也读取并编辑该值；当前 `settings.json` 是普通 JSON，不能宣称密钥已加密或 renderer 从不接触密钥。涉及这些路径时应明确风险并避免扩大暴露面。
- 扫描项目文件前遵守授权和排除规则；对敏感信息做过滤，限制扫描量、上下文和模型输出。不要把未授权路径或被过滤数据放入缓存、日志、模型请求、结果或导出。
- 扫描缓存只是可失效的性能优化，不是事实来源；复用前需确认快照仍有效，项目移除或文件变化时正确失效。
- `electron/services/store.ts` 当前以 JSON 文件保存设置、近期项目和结果，写入不是原子操作。改变存储格式时考虑旧数据兼容、损坏恢复与升级路径；不得假定现有数据已有加密、原子写入或迁移机制。
- 长任务与流式请求须有明确的运行、成功、失败和取消状态生命周期；完成、失败、超时或取消时释放 abort/controller、监听器和其他临时资源，避免旧任务覆盖新任务或重复响应。
- 对模型输出设置有界请求与结果预算，校验和归一化后再展示、保存或导出；模型生成内容不能被当作指令执行，也不能覆盖系统安全规则。

## TypeScript 与实现

- 遵循现有 TypeScript 严格检查和项目格式：缩进 2 空格、单引号、不加分号；优先明确类型、窄化 `unknown`、小型纯函数和清晰异步边界；避免无理由的 `any`、类型断言、重复状态及隐藏的全局副作用。直接用 Node 测试 `.ts` 时，现有测试会使用显式 `.ts` 导入扩展名和共享别名注册器；这是测试运行方式的例外，不应误认为构建代码普遍忽略模块解析边界。
- 类型只描述可信形状，不代替外部数据校验。不要用宽泛 catch 静默吞掉可诊断错误；对用户提示与日志分开处理，并过滤敏感值。
- 新增代码应沿用现有命名、模块和依赖方向。除非需求必要且有理由，不增加依赖或引入新的架构层。
- 违反上述约束的例外应在变更说明中写明原因、影响范围和补偿措施。

## 当前自动化边界

项目已有 `typecheck`、构建、IPC、安全、扫描缓存、冒烟、题量预算与依赖审计等 npm 脚本，具体选择见 `docs/validation.md`。目前没有全局 lint、提交 hook 或自动版本一致性检查；相关风格和版本约束由人工审查落实。不要将目标规则描述成已有自动门禁。

本规范借鉴 Koine 的分层责任、接口契约和可追溯证据思路，依据其根目录 `AGENTS.md` 与 `CLAUDE.md`；ProjectLens 的规则以本项目已有 Electron、IPC、React 和 JSON 存储结构为准。
