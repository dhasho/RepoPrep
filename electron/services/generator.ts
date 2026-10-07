// 面试题生成编排：构建上下文 -> 调用大模型 -> 容错解析 JSON -> 合并批次
import { randomUUID } from 'node:crypto'
import type {
  FollowUp,
  Granularity,
  InterviewResult,
  LlmProfile,
  QuestionItem,
  RoleFocus,
  Section
} from '@shared/types'
import { GRANULARITY_META, GRANULARITY_QUESTION_BUDGET, ROLE_META } from '@shared/types'
import { chatCompletion, type ChatMessage } from './llm'
import { buildContext, renderBatch, type ContextBatch } from './context-builder'
import { MAX_QUESTIONS_PER_BATCH, planQuestionQuotas, truncateToQuota, type QuestionPlan } from './question-budget'
import { treeToText, type ScanResult } from './scanner'

export interface GenerateParams {
  scan: ScanResult
  granularity: Granularity
  roleFocus: RoleFocus
  profile: LlmProfile
  signal: AbortSignal
  onProgress: (step: string, detail: string | undefined, percent: number) => void
}

const SYSTEM_PROMPT = `你是一位经验丰富的资深技术面试官，擅长通读候选人的项目代码与文档，围绕真实项目出有深度的面试题。
你的输出必须严格遵守约定：只输出一个合法的 JSON 对象，不输出任何解释性文字、前后缀或 Markdown 代码围栏。`

function jsonSchemaRule(questionCount: string, granularityDesc: string): string {
  return `## 输出 JSON 结构
\`\`\`json
{
  "projectSummary": "对项目的一段整体介绍（80-200字，说明这是什么项目、用了什么技术、整体结构如何）",
  "sections": [
    {
      "title": "主题名称，如：整体架构 / 核心模块：xxx / 性能与安全",
      "summary": "该主题考察点的一句话说明",
      "questions": [
        {
          "question": "面试问题",
          "answer": "参考答案（Markdown 格式）",
          "followUps": [
            { "question": "追问", "answer": "追问参考答案", "followUps": [] }
          ]
        }
      ]
    }
  ],
  "glossary": { "名词": "该名词 1-2 句通俗解释" }
}
\`\`\`

## 出题规则
1. 共 ${questionCount}，按主题分 3-6 个 section；${granularityDesc}
2. 问题必须基于提供的项目真实信息（文件树、配置、源码），禁止编造项目中不存在的技术细节；若某方面信息不足，可基于常见实现合理推断，但答案中要注明"（根据常见实现推断）"。
3. answer 用 Markdown 书写（可用列表、代码块），150-400 字；代码引用要用 \`路径\` 注明出处。
4. 每题配 2-4 个 followUps 追问，模拟面试官顺藤摸瓜的深挖：为什么这样选型/换个方案行不行/性能瓶颈在哪/边界与异常情况怎么处理。追问 answer 50-150 字。追问内部可再嵌套一层 followUps（可为空数组）。
5. 专业名词标记：在 question、answer、followUps 的文本中，把专业术语、框架、库、算法、协议、设计模式等名词用 [[名词]] 双括号包裹（名词内部不能有空格，中英文均可），这些名词就像飞书文档里的专有名词标注。glossary 必须覆盖所有被 [[ ]] 标记过的名词，key 与括号内文本完全一致，给出面向初级工程师的通俗解释。
6. 问题口吻是面试官向候选人提问，例如"你为什么选择 X 而不是 Y？""这个模块的 Y 是怎么实现的？"`
}

const GRANULARITY_TASK: Record<Granularity, string> = {
  coarse: '围绕整体架构层面出题：项目架构与分层、技术选型及理由、模块职责划分、核心设计权衡、部署形态。不深入函数级实现细节。',
  medium: '围绕模块/功能层面出题：各模块的职责与实现方式、数据流转、模块间接口与协作、关键业务流程、状态与存储设计。',
  fine: '围绕代码实现层面出题：关键函数的实现思路、算法与数据结构、边界条件处理、并发/异步控制、性能优化点、错误处理与容错。'
}

function buildUserPrompt(opts: {
  contextText: string
  granularity: Granularity
  roleFocus: RoleFocus
  isModuleBatch: boolean
  moduleLabel?: string
  /** 本批次被分配的题量（由 question-budget.ts 统一规划），提示词与后置裁剪都以此为准 */
  quota: number
  /** 补偿轮追加的说明（要求模型补充此前未覆盖的考察点、不要重复） */
  extraInstruction?: string
}): string {
  const { contextText, granularity, roleFocus, isModuleBatch, moduleLabel, quota, extraInstruction } = opts
  const g = GRANULARITY_META[granularity]
  const questionCount = isModuleBatch
    ? `严格 ${quota} 题（只针对本模块，不要多出）`
    : granularity === 'fine'
      ? `严格 ${quota} 题（全局架构层面，实现细节由其他批次负责，不要多出）`
      : `约 ${quota} 题`

  const taskLine = isModuleBatch
    ? `本次只分析项目的单个模块「${moduleLabel}」，请只针对该模块的代码生成实现细节级的面试题，section 的 title 以模块名开头（如「模块xxx：子主题」）。projectSummary 固定返回空字符串。`
    : GRANULARITY_TASK[granularity]

  return `# 待分析的项目

${contextText}

# 出题任务

- 颗粒度：${g.label}（${g.sub}）。${taskLine}
- 题量硬性约束：${questionCount}。总题量已由系统预先分配，**超出配额的部分会被丢弃**，因此请把配额用在最有价值的考察点上，不要为了凑数而出题。
- 考察方向：${ROLE_META[roleFocus].label}方向——${ROLE_META[roleFocus].prompt}
${extraInstruction ? `- 补充说明：${extraInstruction}` : ''}
${jsonSchemaRule(questionCount, taskLine)}

再次强调：只输出 JSON 对象本身。`
}

// ---------- JSON 容错解析 ----------

function extractJson(raw: string): string {
  let text = raw.trim()
  // 剥离 markdown 代码围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) text = text.slice(first, last + 1)
  return text
}

interface RawQuestion {
  question?: unknown
  answer?: unknown
  followUps?: unknown
}
interface RawSection {
  title?: unknown
  summary?: unknown
  questions?: unknown
}
interface RawResult {
  projectSummary?: unknown
  sections?: unknown
  glossary?: unknown
}

function normalizeFollowUps(raw: unknown, depth: number): FollowUp[] {
  if (!Array.isArray(raw) || depth > 2) return []
  return raw
    .map((item): FollowUp | null => {
      if (!item || typeof item !== 'object') return null
      const q = item as RawQuestion
      const question = typeof q.question === 'string' ? q.question.trim() : ''
      const answer = typeof q.answer === 'string' ? q.answer.trim() : ''
      if (!question || !answer) return null
      return { question, answer, followUps: normalizeFollowUps(q.followUps, depth + 1) }
    })
    .filter((f): f is FollowUp => f !== null)
}

function normalizeParsed(raw: unknown): { projectSummary: string; sections: Section[]; glossary: Record<string, string> } {
  if (!raw || typeof raw !== 'object') throw new Error('模型输出不是 JSON 对象')
  const obj = raw as RawResult
  const projectSummary = typeof obj.projectSummary === 'string' ? obj.projectSummary.trim() : ''

  const sections: Section[] = []
  if (Array.isArray(obj.sections)) {
    for (const s of obj.sections) {
      if (!s || typeof s !== 'object') continue
      const sec = s as RawSection
      const title = typeof sec.title === 'string' && sec.title.trim() ? sec.title.trim() : '未命名主题'
      const questions: QuestionItem[] = []
      if (Array.isArray(sec.questions)) {
        for (const q of sec.questions) {
          if (!q || typeof q !== 'object') continue
          const qo = q as RawQuestion
          const question = typeof qo.question === 'string' ? qo.question.trim() : ''
          const answer = typeof qo.answer === 'string' ? qo.answer.trim() : ''
          if (!question || !answer) continue
          questions.push({
            id: randomUUID(),
            question,
            answer,
            followUps: normalizeFollowUps(qo.followUps, 1)
          })
        }
      }
      if (questions.length) {
        sections.push({
          id: randomUUID(),
          title,
          summary: typeof sec.summary === 'string' ? sec.summary.trim() : undefined,
          questions
        })
      }
    }
  }
  if (!sections.length) throw new Error('模型输出中没有有效的问题（sections 为空）')

  const glossary: Record<string, string> = {}
  if (obj.glossary && typeof obj.glossary === 'object') {
    for (const [k, v] of Object.entries(obj.glossary as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) glossary[k] = v.trim()
    }
  }
  return { projectSummary, sections, glossary }
}

/** 调用大模型并解析出结构化结果，失败自动带错误重试一次 */
async function callForJson(
  profile: LlmProfile,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<{ projectSummary: string; sections: Section[]; glossary: Record<string, string> }> {
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await chatCompletion(profile, messages, { signal, timeoutMs: 600_000 })
    try {
      return normalizeParsed(JSON.parse(extractJson(reply)))
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      messages = [
        ...messages,
        { role: 'assistant', content: reply.slice(0, 20_000) },
        {
          role: 'user',
          content: `你刚才的输出不是合法 JSON 或缺少必需字段（错误：${lastError}）。请重新输出，务必只输出一个合法的 JSON 对象，不要包含任何其他文字。`
        }
      ]
    }
  }
  throw new Error(`模型两次均未返回合法 JSON：${lastError}`)
}

// ---------- 主流程 ----------

export async function generateInterview(params: GenerateParams): Promise<InterviewResult> {
  const { scan, granularity, roleFocus, profile, signal, onProgress } = params

  onProgress('构建项目上下文', `颗粒度：${GRANULARITY_META[granularity].label}`, 8)
  const built = await buildContext(scan, granularity)
  const treeText = treeToText(scan.tree)
  onProgress(
    '上下文就绪',
    `${built.batches.length} 个分析批次，共 ${Math.round(built.batches.reduce((a, b) => a + b.totalChars, 0) / 1000)}k 字符；已排除 ${scan.security.excludedFiles} 个敏感文件，脱敏 ${built.contentSecurity.redactedFiles} 个文件（${built.contentSecurity.redactionMatches} 处）`,
    15
  )

  // 题量预算：在发起任何模型调用之前就把总量分配到各批次，
  // 这是 issue #9 的核心修复——此前全局批 10-15 题 + 每模块 6-10 题最多可得 70-115 题。
  const budget = GRANULARITY_QUESTION_BUDGET[granularity]
  const plan: QuestionPlan = planQuestionQuotas(
    granularity,
    built.batches.map((b) => ({ label: b.label, weight: b.weight, kind: b.kind }))
  )

  // 合并各批次产出，并在总量低于下限时对"少给的批次"发起一轮补偿请求。
  const mergeResult = await mergeWithCompensation({
    budget,
    batches: built.batches,
    quotas: plan.quotas.map((q) => q.quota),
    total: plan.total,
    // 每批的进度：合并阶段占 15%→95%
    onBatch: (index, detail, fraction) =>
      onProgress(
        `调用大模型分析（${index + 1}/${built.batches.length}）：${built.batches[index].label}`,
        detail,
        Math.round(15 + fraction * 80)
      ),
    // 补偿轮使用同一进度条末端，文案由调用方给
    onCompensate: (detail) => onProgress('补充请求（题量不足）', detail, 94),
    requestBatch: (index, quota, extraInstruction) =>
      callForJson(
        profile,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserPrompt({
              contextText: renderBatch(built.headerText, treeText, built.batches[index]),
              granularity,
              roleFocus,
              isModuleBatch: built.batches[index].kind === 'module',
              moduleLabel:
                built.batches[index].kind === 'module'
                  ? built.batches[index].label.replace(/^模块「|」$/g, '')
                  : undefined,
              quota,
              extraInstruction
            })
          }
        ],
        signal
      )
  })

  const merged = mergeResult
  const capped = capSectionsToMax(merged.sections, budget.max)
  // 裁剪后收敛 glossary：丢弃不再被引用的孤儿词条（多批合并 + 裁剪会明显膨胀）
  const glossary = pruneGlossary(merged.glossary, capped.sections)

  const totalQuestions = capped.sections.reduce((a, s) => a + s.questions.length, 0)
  const shortfall = Math.max(0, budget.min - totalQuestions)
  const droppedTotal = merged.droppedByQuota + capped.dropped
  const orphanTerms = Object.keys(merged.glossary).length - Object.keys(glossary).length
  onProgress(
    '整理结果',
    `${capped.sections.length} 个主题，共 ${totalQuestions} 题（预算 ${budget.min}–${budget.max}）` +
      `${merged.compensated > 0 ? `；补偿请求补回 ${merged.compensated} 题` : ''}` +
      `${droppedTotal > 0 ? `；超出配额已丢弃 ${droppedTotal} 题` : ''}` +
      `${orphanTerms > 0 ? `；已清理 ${orphanTerms} 个未再引用的名词` : ''}` +
      `${shortfall > 0 ? `；模型输出不足，比下限少 ${shortfall} 题，可换用能力更强的模型或提高颗粒度` : ''}`,
    98
  )

  const result: InterviewResult = {
    version: 1,
    createdAt: new Date().toISOString(),
    projectName: scan.name,
    projectPath: scan.root,
    granularity,
    roleFocus,
    profileId: profile.id,
    modelUsed: `${profile.name} / ${profile.model}`,
    projectSummary: merged.projectSummary,
    sections: capped.sections,
    glossary,
    security: {
      excludedFiles: scan.security.excludedFiles,
      redactedFiles: built.contentSecurity.redactedFiles,
      redactionMatches: built.contentSecurity.redactionMatches,
      categories: Object.fromEntries([
        ...Object.entries(scan.security.categories),
        ...Object.entries(built.contentSecurity.matchesByCategory)
      ].reduce((entries, [category, count]) => {
        const existing = entries.find(([name]) => name === category)
        if (existing) existing[1] += Number(count)
        else entries.push([category, Number(count)])
        return entries
      }, [] as Array<[string, number]>))
    }
  }
  onProgress('完成', undefined, 100)
  return result
}

/** 单个批次返回的解析结果（callForJson 的产出） */
type ParsedBatch = { projectSummary: string; sections: Section[]; glossary: Record<string, string> }

export interface MergeInput {
  /** 该颗粒度的题量预算 */
  budget: { min: number; target: number; max: number }
  /** 各批次的标识（仅用于进度文案） */
  batches: ReadonlyArray<{ label: string }>
  /** 各批次被分配的配额 */
  quotas: readonly number[]
  /** 配额之和（= 规划总量） */
  total: number
  /** 发起一次模型请求：quota 为本次要求的题量，extraInstruction 用于补偿轮追加说明 */
  requestBatch: (index: number, quota: number, extraInstruction?: string) => Promise<ParsedBatch>
  /** 每个批次开始/结束时的进度回调，fraction ∈ [0,1] 为该批在合并阶段内的位置 */
  onBatch?: (index: number, detail: string, fraction: number) => void
  /** 需要补偿时调用一次，用于提示进度 */
  onCompensate?: (detail: string) => void
}

export interface MergeResult {
  projectSummary: string
  sections: Section[]
  glossary: Record<string, string>
  /** 因超出配额被丢弃的题量 */
  droppedByQuota: number
  /** 补偿轮实际补回的题量 */
  compensated: number
  /** 补偿轮的请求次数 */
  compensationRounds: number
  /** 最终合并的题量 */
  collected: number
}

/**
 * 合并各批次产出，并在总量低于下限时发起补偿请求。
 *
 * 两个关键行为：
 * 1. **超额裁剪**：每批产出超过its配额时只保留前 N 题（提示词已要求按重要性排序）。
 * 2. **不足补偿**：所有批次都跑完后，若总量仍低于预算下限，就挑"给得最少"的批次
 *    再请求一次，且只要求补足缺口（`quota = 缺口`），最多补偿 `maxCompensationRounds` 轮。
 *    这是 issue #9 明确要求的"对模型不足输出做补偿"。
 *    （注意：仅靠"把剩余预算转给后续批次"是做不到补偿的——由于 kept_j ≤ quota_j，
 *    后续批次的可用预算恒不小于其配额，那个分支永远不会触发。）
 */
export async function mergeWithCompensation(
  input: MergeInput,
  maxCompensationRounds = 2
): Promise<MergeResult> {
  const { budget, batches, quotas, total, requestBatch, onBatch, onCompensate } = input
  const merged: MergeResult = {
    projectSummary: '',
    sections: [],
    glossary: {},
    droppedByQuota: 0,
    compensated: 0,
    compensationRounds: 0,
    collected: 0
  }
  /** 每批实际贡献的题量，用于挑出"给得最少"的批次做补偿 */
  const delivered = quotas.map(() => 0)

  const absorb = (parsed: ParsedBatch, quota: number, index: number): number => {
    const trimmed = truncateToQuota(parsed.sections, quota)
    const keptSections = trimmed.sections.filter((s) => s.questions.length > 0)
    merged.droppedByQuota += trimmed.dropped
    if (!merged.projectSummary && parsed.projectSummary) merged.projectSummary = parsed.projectSummary
    merged.sections.push(...keptSections)
    Object.assign(merged.glossary, parsed.glossary)
    delivered[index] += trimmed.kept
    merged.collected += trimmed.kept
    return trimmed.kept
  }

  for (let i = 0; i < batches.length; i++) {
    const quota = quotas[i]
    const span = 1 / Math.max(1, batches.length)
    onBatch?.(
      i,
      `本批目标 ${quota} 题，累计 ${merged.collected}/${total} 题（预算 ${budget.min}–${budget.max}）`,
      i * span
    )
    const parsed = await requestBatch(i, quota)
    const kept = absorb(parsed, quota, i)
    onBatch?.(
      i,
      `本批 ${kept}/${quota} 题${kept < quota ? `（少 ${quota - kept} 题）` : ''}，累计 ${merged.collected} 题`,
      (i + 1) * span
    )
  }

  // 补偿：总量低于下限时，挑贡献最少的批次补一次，只要求补足缺口。
  for (let round = 0; round < maxCompensationRounds; round++) {
    const gap = budget.min - merged.collected
    if (gap <= 0) break
    let target = 0
    for (let i = 1; i < delivered.length; i++) {
      if (delivered[i] < delivered[target]) target = i
    }
    if (!batches.length) break
    const ask = Math.min(gap, MAX_QUESTIONS_PER_BATCH)
    onCompensate?.(
      `第 ${round + 1} 轮：累计 ${merged.collected} 题，比下限少 ${gap} 题，向「${batches[target].label}」补充请求 ${ask} 题`
    )
    merged.compensationRounds++
    try {
      const parsed = await requestBatch(
        target,
        ask,
        `这是补充请求：上一次该部分只产出了 ${delivered[target]} 题，总量还差 ${gap} 题。` +
          `请**再补充 ${ask} 个此前没有覆盖到的考察点**，不要重复已有问题。`
      )
      merged.compensated += absorb(parsed, ask, target)
    } catch {
      // 补偿属于尽力而为：失败不应让整个生成流程失败，已有结果照常返回
      break
    }
  }

  return merged
}

/**
 * 只保留被最终结果真正引用的名词解释。
 *
 * 裁剪题量后，被丢弃的题里标记过的名词会变成"有解释但没人引用"的孤儿词条；
 * 提示词要求 glossary 覆盖所有 [[ ]] 标记，因此模型每批都会带上自己的词条，
 * 多批合并后会明显膨胀（旧行为下 115 题可产出上千词条，而 IPC 校验对对象键数
 * 有 256 的上限，会导致导出被拒）。这里按最终 sections 里实际出现的标记收敛。
 *
 * 只做删减、不做补全：渲染层对缺失词条有 AI 现取作为兜底。
 */
export function collectReferencedTerms(sections: Section[]): Set<string> {
  const terms = new Set<string>()
  const fromText = (text: string): void => {
    for (const match of text.matchAll(/\[\[([^\[\]]+)\]\]/g)) terms.add(match[1])
  }
  const walkFollowUps = (list: FollowUp[]): void => {
    for (const f of list) {
      fromText(f.question)
      fromText(f.answer)
      if (f.followUps?.length) walkFollowUps(f.followUps)
    }
  }
  for (const section of sections) {
    for (const q of section.questions) {
      fromText(q.question)
      fromText(q.answer)
      walkFollowUps(q.followUps)
    }
  }
  return terms
}

export function pruneGlossary(glossary: Record<string, string>, sections: Section[]): Record<string, string> {
  const referenced = collectReferencedTerms(sections)
  const pruned: Record<string, string> = {}
  for (const [term, definition] of Object.entries(glossary)) {
    if (referenced.has(term)) pruned[term] = definition
  }
  return pruned
}

/**
 * 把总题量压到上限以内：从题量最少的 section 开始整段移除。
 * 整段移除而不是删单题，是为了不留下"半截"主题；同题量时按原顺序靠后者先移除，保证确定性。
 */
export function capSectionsToMax(sections: Section[], max: number): { sections: Section[]; dropped: number } {
  let total = sections.reduce((a, s) => a + s.questions.length, 0)
  if (total <= max) return { sections, dropped: 0 }

  const indexed = sections.map((section, index) => ({ section, index }))
  indexed.sort((a, b) => {
    const bySize = a.section.questions.length - b.section.questions.length
    return bySize !== 0 ? bySize : b.index - a.index
  })

  const removed = new Set<number>()
  let dropped = 0
  for (const { section, index } of indexed) {
    if (total <= max) break
    removed.add(index)
    total -= section.questions.length
    dropped += section.questions.length
  }

  return { sections: sections.filter((_s, i) => !removed.has(i)), dropped }
}

/** 名词解释（弹卡内的"让 AI 详细解释"） */
export function buildExplainMessages(req: {
  term: string
  projectSummary: string
  question: string
  snippet: string
  glossaryHint?: string
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是技术名词解释助手。用通俗易懂的语言解释技术名词，面向准备面试的工程师。如术语在当前项目语境中有具体含义，请结合项目说明它在本项目中的作用。输出 Markdown，300 字以内，不要客套。'
    },
    {
      role: 'user',
      content: [
        `项目概况：${req.projectSummary || '（未知）'}`,
        '',
        `面试问题：${req.question}`,
        '',
        `答案中出现了名词「${req.term}」，其所在片段：${req.snippet}`,
        '',
        `术语表已有的简短解释：${req.glossaryHint || '（无）'}`,
        '',
        `请解释「${req.term}」这个名词。`
      ].join('\n')
    }
  ]
}
