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
import { GRANULARITY_META, ROLE_META } from '@shared/types'
import { chatCompletion, type ChatMessage } from './llm'
import { buildContext, renderBatch, type ContextBatch } from './context-builder'
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
}): string {
  const { contextText, granularity, roleFocus, isModuleBatch, moduleLabel } = opts
  const g = GRANULARITY_META[granularity]
  const questionCount = isModuleBatch
    ? '6-10 题（只针对本模块）'
    : granularity === 'coarse'
      ? '约 8-12 题'
      : granularity === 'medium'
        ? '约 15-25 题'
        : '约 10-15 题（全局架构层面，实现细节由其他批次负责）'

  const taskLine = isModuleBatch
    ? `本次只分析项目的单个模块「${moduleLabel}」，请只针对该模块的代码生成实现细节级的面试题，section 的 title 以模块名开头（如「模块xxx：子主题」）。projectSummary 固定返回空字符串。`
    : GRANULARITY_TASK[granularity]

  return `# 待分析的项目

${contextText}

# 出题任务

- 颗粒度：${g.label}（${g.sub}）。${taskLine}
- 考察方向：${ROLE_META[roleFocus].label}方向——${ROLE_META[roleFocus].prompt}
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
    `${built.batches.length} 个分析批次，共 ${Math.round(built.batches.reduce((a, b) => a + b.totalChars, 0) / 1000)}k 字符`,
    15
  )

  const merged = { projectSummary: '', sections: [] as Section[], glossary: {} as Record<string, string> }

  for (let i = 0; i < built.batches.length; i++) {
    const batch: ContextBatch = built.batches[i]
    const isModuleBatch = i > 0 && granularity === 'fine'
    const span = 80 / built.batches.length
    onProgress(
      `调用大模型分析（${i + 1}/${built.batches.length}）：${batch.label}`,
      `模型 ${profile.model}，上下文 ${Math.round(batch.totalChars / 1000)}k 字符`,
      Math.round(15 + i * span)
    )

    const contextText = renderBatch(built.headerText, treeText, batch)
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildUserPrompt({
          contextText,
          granularity,
          roleFocus,
          isModuleBatch,
          moduleLabel: isModuleBatch ? batch.label.replace(/^模块「|」$/g, '') : undefined
        })
      }
    ]
    const parsed = await callForJson(profile, messages, signal)
    if (!merged.projectSummary && parsed.projectSummary) merged.projectSummary = parsed.projectSummary
    merged.sections.push(...parsed.sections)
    Object.assign(merged.glossary, parsed.glossary)
  }

  onProgress('整理结果', `${merged.sections.length} 个主题，共 ${merged.sections.reduce((a, s) => a + s.questions.length, 0)} 题`, 98)

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
    sections: merged.sections,
    glossary: merged.glossary
  }
  onProgress('完成', undefined, 100)
  return result
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
