// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { summarizeQuestion, summarizeQuestions } from './question-summary.ts'

const width = (value: string) => Array.from(value).reduce((sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/u.test(char) ? 2 : 1), 0)

test('fallback skips prompt framing and long implementation identifiers for question topics', () => {
  const questions = [
    'VeryLongInventoryReconciliationCoordinator.reconcile 对库存流水做了哪些幂等校验？',
    '从现有代码看，UnfamiliarPaymentGateway 为什么要冻结余额再确认扣款？',
    '请根据已提供代码，说明 RoleEmote 从表达决策到媒体结果的主调用链，以及核心库与 AstrBot 插件的边界。',
    'PerformancePlan.from_dict 对模型输出做了哪些兼容和防御？为什么 should_reply 不是布尔值时直接报错，而不是默认成 False？',
    'Router.route 如何决定先试哪个 RendererAdapter？请说明允许生成、配额和媒介校验之间的关系。',
    'VisualExpressionRuntime.express 中“强素材命中”和表达缺口是什么关系？弱命中为什么仍记录缺口？',
    '项目中同时有 MediaBackend 和 RendererAdapter 两套接口，它们各自负责什么？路由器实际依赖哪一套？',
    'EmoteLibrary.search_with_score 的阈值、并列和阻塞 I/O 处理分别是什么语义？',
    '可选生成能力如何装配和失败降级？请结合视频 provider 与 ComfyUI/MCP 路径说明。',
    'OpenAICompatibleSemanticEncoder.encode_many 对 embedding 批处理做了哪些输入和响应约束？哪些保证无法从片段确认？',
    '构建检索语料时为什么按组切分，并强制开发集同时包含正例和无匹配标签？阈值校准如何选出阈值？',
    '前瞻 holdout 的 visible 函数如何判定候选可见？它为什么不使用语义标签？与核心隐私判定有什么差异风险？',
    '学习任务存储启动时如何恢复 RUNNING 状态？为什么无效记录只打固定 warning？',
    'LearningCoordinator.enqueue_gap 在什么条件下把表达缺口转成学习任务？可选任务队列起什么作用？',
    '_produce_while_lease_live 如何把生成过程与租约绑定？为什么取消后还要重新 await 生成任务？',
    '从现有代码看，BasicMediaInspector 和 QualityPolicy 能提供多强的质量保证？哪些结论不能下？',
    'atomic_write_text 与 append_json_line 分别解决什么问题？它们的崩溃一致性边界在哪里？',
    '素材库的 delete 和 purge_expired 为什么都先改 manifest 再删文件？这样能保证什么、不能保证什么？',
    '投递意图的 claim 如何避免重复发送？请说明事务、token、过期和 fail_claim 的作用。',
    '身份注册表如何保证参考图和版本不可抵赖？它的并发与持久化边界是什么？',
    'privacy.is_visible 的作用域和过期规则是什么？有哪些容易误用的边界？',
    'JsonAuditLog 的哈希链如何提供篡改检测？它的安全边界在哪里？'
  ]
  const labels = summarizeQuestions(questions)
  assert.equal(labels.length, questions.length)
  assert.ok(labels.every(label => label.length > 0 && label !== '问题摘要'))
  assert.ok(labels.every(label => width(label) <= 48), labels.join('\n'))
  assert.deepEqual(labels.filter(label => /(?:并强制|它不|在哪里|并|与|和|有|不)$/u.test(label)), [], labels.join('\n'))
  assert.ok(labels[0].includes('幂等'), labels[0])
  assert.ok(labels[1].includes('余额') || labels[1].includes('扣款'), labels[1])
  assert.ok(labels[3].includes('模型') || labels[3].includes('防御'), labels[3])
  assert.ok(labels[4].includes('路由选择') || labels[4].includes('配额') || labels[4].includes('媒介'), labels[4])
  assert.ok(labels[15].includes('质量'), labels[15])
  assert.ok(labels[16].includes('崩溃') || labels[16].includes('一致性'), labels[16])
})

test('fallback keeps short technical names and useful words after a long method name', () => {
  for (const term of ['.gitignore', 'window.api', 'node:fs', 'C++/C#', 'src/cache.ts', 'cache_key', '#include']) {
    assert.ok(summarizeQuestion(`Please explain ${term} request behavior?`).includes(term), term)
  }
  const label = summarizeQuestion('VeryLongInventoryReconciliationCoordinator.reconcile 对库存流水做了哪些幂等校验？')
  assert.ok(!label.includes('VeryLongInventory'), label)
  assert.ok(label.includes('库存') || label.includes('幂等'), label)
  for (const term of ['workflow', 'network', 'keyword']) {
    assert.equal(summarizeQuestion(`What is ${term}?`), term)
  }
  assert.equal(summarizeQuestion('Please explain VeryLongInventoryCoordinator'), 'VeryLongInventoryCoordinator')
})

test('a provided generated title wins over the same generic legacy fallback for every question', () => {
  const questions = [
    'VeryLongInventoryReconciliationCoordinator.reconcile 对库存流水做了哪些幂等校验？',
    '从现有代码看，UnfamiliarPaymentGateway 为什么要冻结余额再确认扣款？',
    '请根据已提供代码，说明 RoleEmote 从表达决策到媒体结果的主调用链，以及核心库与 AstrBot 插件的边界。',
    'PerformancePlan.from_dict 对模型输出做了哪些兼容和防御？为什么 should_reply 不是布尔值时直接报错，而不是默认成 False？',
    'Router.route 如何决定先试哪个 RendererAdapter？请说明允许生成、配额和媒介校验之间的关系。',
    'VisualExpressionRuntime.express 中“强素材命中”和表达缺口是什么关系？弱命中为什么仍记录缺口？',
    '项目中同时有 MediaBackend 和 RendererAdapter 两套接口，它们各自负责什么？路由器实际依赖哪一套？',
    'EmoteLibrary.search_with_score 的阈值、并列和阻塞 I/O 处理分别是什么语义？',
    '可选生成能力如何装配和失败降级？请结合视频 provider 与 ComfyUI/MCP 路径说明。',
    'OpenAICompatibleSemanticEncoder.encode_many 对 embedding 批处理做了哪些输入和响应约束？哪些保证无法从片段确认？',
    '构建检索语料时为什么按组切分，并强制开发集同时包含正例和无匹配标签？阈值校准如何选出阈值？',
    '前瞻 holdout 的 visible 函数如何判定候选可见？它为什么不使用语义标签？与核心隐私判定有什么差异风险？',
    '学习任务存储启动时如何恢复 RUNNING 状态？为什么无效记录只打固定 warning？',
    'LearningCoordinator.enqueue_gap 在什么条件下把表达缺口转成学习任务？可选任务队列起什么作用？',
    '_produce_while_lease_live 如何把生成过程与租约绑定？为什么取消后还要重新 await 生成任务？',
    '从现有代码看，BasicMediaInspector 和 QualityPolicy 能提供多强的质量保证？哪些结论不能下？',
    'atomic_write_text 与 append_json_line 分别解决什么问题？它们的崩溃一致性边界在哪里？',
    '素材库的 delete 和 purge_expired 为什么都先改 manifest 再删文件？这样能保证什么、不能保证什么？',
    '投递意图的 claim 如何避免重复发送？请说明事务、token、过期和 fail_claim 的作用。',
    '身份注册表如何保证参考图和版本不可抵赖？它的并发与持久化边界是什么？',
    'privacy.is_visible 的作用域和过期规则是什么？有哪些容易误用的边界？',
    'JsonAuditLog 的哈希链如何提供篡改检测？它的安全边界在哪里？'
  ]
  const titles = questions.map((question, index) => ({
    question,
    title: `**Topic ${String(index + 1).padStart(2, '0')}** [[Term]] workflow`
  }))
  assert.deepEqual(
    summarizeQuestions(titles),
    titles.map(({ title }) => title.replace(/\*\*/gu, '').replace(/\[\[([^\]]+)\]\]/gu, '$1'))
  )
  assert.deepEqual(summarizeQuestions([
    { question: questions[0], title: 'Shared title' },
    { question: questions[1], title: 'Shared title' }
  ]), ['Shared title', 'Shared title'])
  assert.equal(summarizeQuestion({ question: questions[0], title: 'addRecentProject 去重策略' }), 'addRecentProject 去重策略')
  assert.notEqual(summarizeQuestion({ question: questions[0], title: '  ' }), '问题摘要')
})

test('different concerns remain distinguishable and summaries obey narrow widths', () => {
  const labels = summarizeQuestions([
    '从现有代码看，UnfamiliarPaymentGateway 为什么要冻结余额再确认扣款？',
    '从现有代码看，UnfamiliarPaymentGateway 为什么要记录支付请求再发送扣款？'
  ], 24)
  assert.notEqual(labels[0], labels[1])
  assert.ok(labels.every(label => width(label) <= 24), labels.join('\n'))
  const tight = summarizeQuestions(['系统扫描缓存失效原因如何快速查找', '系统扫描缓存失效时机如何快速定位'], 14)
  assert.notEqual(tight[0], tight[1])
  assert.ok(tight.every(label => width(label) <= 14 && !/·$/u.test(label)))
})

test('meaningless input may use a neutral caption', () => {
  assert.equal(summarizeQuestion('😀?!'), '问题摘要')
  assert.equal(summarizeQuestion('w'.repeat(200)), '问题摘要')
})

test('two-line captions preserve complete titles and reject a question disguised as a title', () => {
  const title = '类型安全通信契约与跨进程权限校验边界'
  assert.equal(summarizeQuestion({ title, question: '原始完整问题保持不变？' }), title)
  const question = '读取任务如何保证租约一致性？'
  assert.equal(summarizeQuestion({ title: question.slice(0, -1), question }), summarizeQuestion(question))
  assert.equal(summarizeQuestion({ title: 'x'.repeat(120), question }), summarizeQuestion(question))
})

test('whole source anchors and path examples do not leave filename or sentence fragments', () => {
  assert.match(summarizeQuestion('请从 electron/main.ts、preload.ts 与 src/App.tsx 说明 ProductAlpha 的进程分层与模块职责。'), /进程分层与模块职责/u)
  assert.equal(summarizeQuestion('electron.vite.config.ts 中如何配置多个构建目标？'), '配置多个构建目标')
  for (const topic of ['租约一致性', '权限边界', '完整数据流']) {
    const caption = summarizeQuestion(`每次读取任务从 Reader.load 到 Response.publish 的${topic}是什么？`)
    assert.ok(caption.includes(topic), caption)
    assert.doesNotMatch(caption, /Reader|Response|从|到/u)
  }
  assert.match(summarizeQuestion('结束后 prepareBatch 和 trimItems 分别做什么？trimItems 的裁剪策略有什么取舍？'), /裁剪策略/u)
})

test('RepoPrep legacy screenshot captions retain each question topic, including its distinguishing end', () => {
  const questions = [
    '请介绍 RepoPrep 的整体架构，主进程、preload、渲染进程各自负责什么？为什么这样划分？',
    'preload 暴露的 window.api 是如何设计的？IPC 通道契约如何保证两端类型一致？新增通道要改哪些文件？',
    '渲染进程的页面状态流转如何管理？navigationEpoch 和 foregroundRunId 解决了什么竞态？',
    '后台生成任务在渲染进程如何建模？GenerationSession 如何隔离不同 runId 的进度与结果？',
    'scanner 扫描本地项目时如何处理 .gitignore、构建产物和嵌套 worktree？扫描安全上限如何生效？',
    'ProjectScanCache 的缓存键与失效策略是什么？为什么 removeRecent 时要同时 invalidate 缓存并撤销授权？',
    'project-content-reader 读取内容时如何防止路径穿越和超大文件？读取失败如何汇总给用户和模型？',
    'sensitive 模块的敏感信息脱敏流程是怎样的？脱敏统计如何进入结果？',
    '一次生成请求从 IPC generateRun 到 saveResult 的完整数据流是怎样的？',
    'context-builder 如何按粒度组装上下文？CONTEXT_CHAR_BUDGETS 为什么 coarse/medium/fine 不同？截断如何标记？',
    'question-budget 如何保证题量落在目标区间？它与 GRANULARITY_QUESTION_BUDGET 是什么关系？',
    'llm.ts 与 sse-parser 如何消费流式响应？如何处理 [DONE]、错误事件、超时和取消？',
    'generation-tasks 的 begin/finish/cancel 如何防止并发和 stale finish？ExplainAbortRegistry 有什么类似设计？',
    'IPC 守卫链 registerGuardedIpcHandler 做了哪些校验？为什么 trustedAppEntryUrl 为 null 时拒绝所有 IPC？',
    '凭据存储如何保证 API Key 不进入渲染进程？为什么修改 baseUrl 前要先替换 Key？',
    'installWindowSecurity 如何限制导航、新窗口和权限请求？CSP 在构建时如何注入？',
    'store 的原子写与备份恢复机制是怎样的？storage-recovery 如何生成诊断并恢复？',
    'result-contract 如何校验不可信的历史结果？为什么要限制树深度、节点数、总字符和总字节？',
    'verify.mjs 的验证流水线包含哪些阶段？它如何处理前置条件失败和 BLOCKED？',
    'audit-deps 脚本如何从 lockfile 解析依赖并查询 GitHub 安全公告？为什么要处理分页、无效 range 和响应错误？'
  ]
  const expected = [
    /整体架构/u,
    /window\.api|IPC.*契约/u,
    /页面状态流转/u,
    /后台生成任务|生成任务.*建模/u,
    /本地项目.*扫描|扫描本地项目/u,
    /缓存键.*失效策略/u,
    /内容读取.*路径穿越|路径穿越/u,
    /敏感信息.*脱敏/u,
    /完整数据流/u,
    /组装.*上下文/u,
    /题量.*目标区间/u,
    /流式响应/u,
    /任务.*并发.*(?:防护|控制)|并发.*(?:防止|控制|保护)|防止并发/u,
    /守卫链.*校验/u,
    /API Key.*渲染进程/u,
    /导航.*新窗口.*权限|窗口安全/u,
    /原子写.*备份恢复/u,
    /历史结果.*校验|校验.*历史结果/u,
    /验证流水线/u,
    /依赖.*安全公告/u
  ]
  const labels = summarizeQuestions(questions)
  assert.equal(labels.length, 20)
  labels.forEach((label, index) => {
    assert.ok(label.length > 0 && width(label) <= 48, `${index}: ${label}`)
    assert.match(label, expected[index], `${index}: ${label}`)
    assert.ok(!label.startsWith('的') && !/(?:从|到|在|时|如何|有哪些|包含哪些|和|与)$/u.test(label), `${index}: ${label}`)
  })
})
