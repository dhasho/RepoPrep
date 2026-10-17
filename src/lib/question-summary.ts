interface TopicRule {
  matches: (text: string) => boolean
  summary: string
}

const topicRules: TopicRule[] = [
  {
    matches: (text) => /架构/u.test(text) && /主进程/u.test(text) && /preload/iu.test(text) && /渲染进程/u.test(text),
    summary: '整体架构与进程协作'
  },
  {
    matches: (text) => /preload/iu.test(text) && /window\.api/iu.test(text) && /IPC/u.test(text) && /契约|通道/u.test(text),
    summary: 'preload接口与IPC契约'
  },
  {
    matches: (text) => /页面/u.test(text) && /状态/u.test(text) && /流转|协作|管理/u.test(text),
    summary: '页面状态流转'
  },
  {
    matches: (text) => /后台/u.test(text) && /生成任务/u.test(text) && /建模|隔离/u.test(text),
    summary: '后台生成任务建模与隔离'
  },
  {
    matches: (text) => /扫描/u.test(text) && /\.gitignore|忽略|构建产物|worktree/iu.test(text),
    summary: '项目扫描与忽略规则'
  },
  {
    matches: (text) => /缓存/u.test(text) && /键/u.test(text) && /失效/u.test(text),
    summary: '缓存键与失效策略'
  },
  {
    matches: (text) => /读取内容|内容读取/u.test(text) && /路径穿越|超大文件|读取失败|读取.*失败/u.test(text),
    summary: '内容读取边界与错误处理'
  },
  {
    matches: (text) => /敏感信息/u.test(text) && /脱敏/u.test(text),
    summary: '敏感信息脱敏流程'
  },
  {
    matches: (text) => /生成请求/u.test(text) && /数据流/u.test(text),
    summary: '生成请求数据流'
  },
  {
    matches: (text) => /上下文/u.test(text) && /组装|预算|限制/u.test(text),
    summary: '上下文组装与预算'
  },
  {
    matches: (text) => /题量/u.test(text) && /目标区间|预算/u.test(text) && /补偿/u.test(text),
    summary: '题量分配与补偿'
  },
  {
    matches: (text) => /流式响应|流式.*响应/u.test(text) && /错误|中断|事件|DONE/u.test(text),
    summary: '流式响应与异常处理'
  }
]

const SENTENCE_BREAK = /[?？。!！;；\n]|\.(?=\s|$)/u
const CJK = /[\u2e80-\u9fff\uff00-\uffef]/u

function normalizeQuestion(question: string): string {
  return question
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/[`*_#]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function cleanQuestionFrame(question: string): string {
  let text = normalizeQuestion(question)
  for (let pass = 0; pass < 3; pass++) {
    text = text
      .replace(/^(?:请问|麻烦|能否|可以|请|帮我|简单地|详细地)+/u, '')
      .replace(/^(?:could you|can you|would you|please|tell me about)\s+/iu, '')
      .replace(/^(?:介绍|说明|解释|描述|讲讲|分析|阐述)(?:一下)?/u, '')
      .replace(/^(?:explain|describe|introduce|tell me about)\s+/iu, '')
  }
  text = text
    .replace(/^(?:what is|what are|what does|how does|how do|how can|why is|why does|why do)\s+/iu, '')
    .replace(/^(?:the|a|an)\s+/iu, '')
    .replace(/^(?:什么是|什么叫)\s*/u, '')
    .replace(/\s*(?:是什么|有哪些|有什么|是怎样的|如何|怎么(?:样|做)?|为什么|吗|呢)\s*[?？。.!！]*$/u, '')
    .replace(/\s+(?:work|operate|function|happen|occur|handled|implemented|parsed|managed)\s*$/iu, '')
    .replace(/\s+的\s*/gu, '')
    .replace(/([A-Za-z0-9])的/gu, '$1')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s，,：:、-]+|[\s，,：:、-]+$/gu, '')
  return text
}

function widthUnits(text: string): number {
  return Array.from(text).reduce((width, char) => width + (CJK.test(char) ? 2 : 1), 0)
}

function neutralSummary(maxWidth: number): string {
  if (widthUnits('问题摘要') <= maxWidth) return '问题摘要'
  if (widthUnits('问题') <= maxWidth) return '问题'
  return '题'
}

function splitLongIdentifiers(text: string, maxWidth: number): string {
  return text.replace(/\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)*\b/gu, (identifier) => {
    if (widthUnits(identifier) <= maxWidth) return identifier
    const words = identifier
      .replace(/([A-Z])([A-Z][a-z])/gu, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .split(/\s+/u)
    const tail = words.at(-1)?.toLowerCase()
    if (words.length > 1 && ['manager', 'service', 'controller', 'provider', 'handler', 'factory'].includes(tail ?? '')) {
      words.pop()
    }
    return words.join(' ')
  })
}

function takeWholeWords(text: string, maxWidth: number): string {
  const locale = /[\u2e80-\u9fff\uff00-\uffef]/u.test(text) ? 'zh' : 'en'
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  let summary = ''
  let width = 0
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    const nextWidth = widthUnits(segment)
    const next = summary ? `${summary}${locale === 'zh' ? '' : ' '}${segment}` : segment
    const separatorWidth = summary && locale !== 'zh' ? 1 : 0
    if (width + separatorWidth + nextWidth > maxWidth) break
    summary = next
    width += separatorWidth + nextWidth
  }
  return summary.trim()
}

function generalSummary(text: string, maxWidth: number): string {
  const firstClause = text.split(SENTENCE_BREAK, 1)[0]?.trim() ?? ''
  const compact = splitLongIdentifiers(cleanQuestionFrame(firstClause), maxWidth)
    .replace(/^(?:在|对于|关于)\s*/u, '')
    .replace(/\s*(?:是如何|如何|怎么|怎样)(?:进行|实现|处理|管理|设计|建模)?\s*/gu, '')
    .replace(/\s*(?:设计|实现|管理|处理|说明|介绍)\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!compact || widthUnits(compact) <= maxWidth) return compact
  return takeWholeWords(compact, maxWidth)
}

/** Produce a compact noun phrase for navigation while leaving the source question untouched. */
export function summarizeQuestion(question: string, maxWidth = 32): string {
  const normalized = normalizeQuestion(question)
  const technical = topicRules.find((rule) => rule.matches(normalized))?.summary
  if (technical && widthUnits(technical) <= maxWidth) return technical

  const compact = generalSummary(normalized, maxWidth)
  if (compact) return compact
  return takeWholeWords(normalized, maxWidth) || neutralSummary(maxWidth)
}

/** Add a short distinguishing detail when different questions have the same main topic. */
export function summarizeQuestions(questions: string[], maxWidth = 32): string[] {
  const summaries = questions.map((question) => summarizeQuestion(question, maxWidth))
  const groups = new Map<string, number[]>()
  summaries.forEach((summary, index) => groups.set(summary, [...(groups.get(summary) ?? []), index]))

  for (const [summary, indexes] of groups) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      const fullText = normalizeQuestion(questions[index])
      const remainder = cleanQuestionFrame(fullText).replace(summary, '').trim()
      const tokens = Array.from(new Intl.Segmenter(/[\u2e80-\u9fff\uff00-\uffef]/u.test(fullText) ? 'zh' : 'en', { granularity: 'word' }).segment(remainder || fullText))
        .filter(({ isWordLike }) => isWordLike)
        .map(({ segment }) => segment)
        .filter((word) => !/^(?:如何|怎么|怎样|进行|快速|具体|哪些|什么|work|handle|managed|implemented)$/iu.test(word))
      const descriptor = tokens.at(-1) ?? ''
      if (!descriptor || descriptor === summary) continue
      const separatorWidth = widthUnits(' · ')
      const descriptorWidth = widthUnits(descriptor)
      if (descriptorWidth >= maxWidth - separatorWidth) continue
      const prefix = takeWholeWords(summary, maxWidth - separatorWidth - descriptorWidth)
      if (!prefix) continue
      const combined = `${prefix} · ${descriptor}`
      if (widthUnits(combined) <= maxWidth) summaries[index] = combined
    }
  }
  return summaries
}
