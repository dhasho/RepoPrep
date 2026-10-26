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
  assert.ok(labels.every(label => width(label) <= 32), labels.join('\n'))
  assert.ok(labels.every(label => !/(?:并强制|它不|在哪里|并|与|和|有|不)$/u.test(label)), labels.join('\n'))
  assert.ok(labels[0].includes('幂等'), labels[0])
  assert.ok(labels[1].includes('余额') || labels[1].includes('扣款'), labels[1])
  assert.ok(labels[3].includes('模型') || labels[3].includes('防御'), labels[3])
  assert.ok(labels[4].includes('配额') || labels[4].includes('媒介'), labels[4])
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
  assert.notEqual(summarizeQuestion({ question: questions[0], title: '  ' }), '问题摘要')
})

test('different concerns remain distinguishable and summaries obey narrow widths', () => {
  const labels = summarizeQuestions([
    '从现有代码看，UnfamiliarPaymentGateway 为什么要冻结余额再确认扣款？',
    '从现有代码看，UnfamiliarPaymentGateway 为什么要记录支付请求再发送扣款？'
  ], 24)
  assert.notEqual(labels[0], labels[1])
  assert.ok(labels.every(label => width(label) <= 24), labels.join('\n'))
})

test('meaningless input may use a neutral caption', () => {
  assert.equal(summarizeQuestion('😀?!'), '问题摘要')
  assert.equal(summarizeQuestion('w'.repeat(200)), '问题摘要')
})
