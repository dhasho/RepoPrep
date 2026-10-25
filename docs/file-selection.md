# 上下文文件选择

本文描述当前实现中项目文本如何被选中、分配预算并送入模型，对应 `electron/services/file-selection.ts`、`context-builder.ts`、`snippet-selection.ts`、`source-analysis.ts` 与 `shared/token-budget.ts`、`shared/context-budget.ts`。

## 流程

1. 扫描结果（`scanner.ts`）是文件读取的唯一授权来源；`context-builder.ts` 只通过 `readProjectContent` 读取已批准内容。项目身份变化抛出 boundary error，普通 I/O 错误按静态分类汇总。
2. `selectProbeFiles` 选取有界探测样本：默认最多 128 个文件、2 MiB。package.json 清单最先，其次 tsconfig/jsconfig（合计不超过文件数的 1/8、上限 16 个，且有独立的 256 KiB 预算）。探测内容先脱敏再用于信号分析，脱敏文本只在本次调用内缓存。Coarse 在探测前就过滤掉业务源码。
3. `collectFileSignals` 从脱敏样本推断入口与本地引用，`orderFilesForContext` 按角色分层并做模块轮转排序。
4. 预算充足时保留全部候选全文；不足时进入最多 64 个文件的窗口，按权重分配正文空间并按完整代码单元裁剪。
5. 最终请求拟合（`renderBatchWithinBudget`）再次按文件条目分配空间，保持 Markdown 围栏配对。

## 信号分析：实际支持与限制

- **JS/TS**：使用项目已安装依赖中的 TypeScript 语法 API（`source-analysis.ts`），支持 js/jsx/ts/tsx/mjs/cjs/mts/cts。提取 import 与顶层符号（函数、类及其方法、接口、类型别名、变量、导入绑定、导出）；动态 `import()` 和 `require()` 只有在说明符是字符串字面量时才能被静态解析，拼接或变量说明符不会产生引用。这是语法层分析，不做类型检查，也不创建会自动发现项目文件的编译器 host。
- **tsconfig/jsconfig 路径别名**：解析 `compilerOptions.paths`（最多 128 个模式、每模式单个 `*`、最多 16 个目标）和 `baseUrl`，支持项目内相对 `extends` 链（只解析已知配置文件，深度上限 8，带环检测）。绝对路径、盘符和逃逸出项目的 `..` 被拒绝。非相对、非 `#` 开头的说明符依次尝试 paths 映射和 baseUrl，按 `.ts/.tsx/.mts/.cts/.d.ts/.js/...` 后缀及 `index.*` 猜测实际文件。
- **Python**：用正则解析 `from X import Y` / `import X`（含相对点号），映射到模块路径与 `__init__.py`；不是完整 AST，也不执行项目代码。
- **入口信号**：来自 package.json 的 `main`/`module`/`bin`/`exports` 字段（有界遍历，拒绝越界路径）。
- **其他文本源码**：回退到确定性的相对 `from`/`import`/`require` 正则匹配。
- 汇总为入口路径、被本地引用计数（`importedBy`）、引用边和被引用符号名。测试与 generated/dist/vendor 类路径不参与信号。
- 只解析项目内候选文件：node_modules 包、`#` 导入和由动态运行时逻辑加载的依赖不会被解析。

## 排序与分配

- 角色优先级：根目录 README/清单等项目事实 > manifest 声明入口 > 被本地引用的业务源码 > main/index/app/server/cli 等入口命名 > 其他业务源码 > 配置 > 文档 > 测试/生成物源码。同层内按模块分组轮转，保证多模块都有机会进入正文；模块键能识别 `packages/apps/modules` 容器和常见源码根目录。
- 字符预算按 JavaScript UTF-16 计数（`shared/context-budget.ts`：coarse 60k、medium 220k、fine 160k；文件树最多 12k 且不超过预算的 20%），覆盖头部、路径标题、围栏、分隔符、脱敏扩张和警告预留。
- 全部候选的估算内容、渲染开销和读取量（≤16 MiB）能容纳时，选中文件保留全文并用实际长度复核；否则最多选 64 项，每项先预留约 1 KiB，再按权重 water-fill：manifest 入口权重最高（8），被引用源码为 3+min(5, 2×被引数)，普通源码 2，结构化配置 4，测试/生成物/叙述性文档 1；权重夹在 1–8，短文件饱和后把余量还给其余文件，过程确定性。
- 选中文件的额外磁盘读取最多 16 MiB，加探测 2 MiB，单次调用合计最多 18 MiB；读取失败或超限的候选跳过后继续回填后续候选。
- token 侧（`shared/token-budget.ts`）：输入目标 coarse 16k / medium 64k / fine 24k（有 `contextWindowTokens` 时与窗口减输出预留取小）；`estimateTextTokens` 是保守的 mixed-text-v1 估算，不是 provider 分词；实际 provider usage 独立记录，两者不互换。

## 截断与完整代码单元

- 文件被裁剪时由 `snippet-selection.ts` 选择完整代码单元：TS/JS 用符号区域（放不下整个符号时退到签名）；Python 用保守的逻辑行缩进解析器——跟踪单/三引号字符串与转义、括号深度、反斜杠续行和装饰器块，识别 def/class 声明，并按文件内成员使用与本地调用排序，签名-only 声明（`...`/`pass`、`@overload`）降级；其他语言回退到确定性声明块启发式并显式标记为不完整。整个流水线不执行项目代码。
- 最终请求拟合优先为代码文件保留条目框架，其次文档；文档超出分配时保留头尾片段并显式标记截断。只有实际省略或裁剪才标记内容截断；读取失败保留独立警告，不与截断混用。
- 依赖锁文件（`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml` 等，见 `project-file-policy.ts`）保留在项目树中用于结构参考，但不进入任何粒度的上下文正文；项目清单（如 `package.json`）仍可作为配置上下文。

## fine 分批

fine 粒度 = 全局批（文档+配置，即 coarse 候选）+ 按顶层目录分组的模块批，模块批上限 10 个，按文件数与内容量（单文件按上限截断计）合成权重，用于把总题量预算分配到各批次；全局批权重等于模块批数量，保证全局题量下限。超过批数上限时如实标记内容截断。

## 验证

- `npm run test:file-selection`：选择策略与真实扫描、上下文构建、snippet 选择集成用例。
- `npm run test:question-budget`：生成请求预算、警告与合并行为。
- `npm run typecheck`：两套严格类型检查。
