const CJK = /[\u2e80-\u9fff\uff00-\uffef]/u
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const technicalToken = /[.#]?[A-Za-z0-9][A-Za-z0-9_./\\:#@+%-]*/uy

function normalize(question: string): string {
  return question
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/(`+)(.*?)\1/gu, '$2')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/(?<![\w])\*([^*]+)\*(?![\w])/gu, '$1')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/\s+/gu, ' ').trim()
}

function width(text: string): number {
  return Array.from(text).reduce((total, char) => total + (CJK.test(char) ? 2 : 1), 0)
}

const scoringStopWords = new Set([
  '请', '根据', '结合', '现有', '代码', '说明', '介绍', '解释', '分析', '描述', '讲讲', '如何', '怎么', '为什么', '什么', '哪些', '是不是', '是否', '分别',
  '它', '它们', '这', '那', '是', '有', '要', '能', '在', '从', '对', '的', '与', '和', '并', '而', '及', '之间', '哪些', '关系', '有什么', '吗', '呢',
  'could', 'you', 'please', 'explain', 'describe', 'introduce', 'what', 'how', 'does', 'do', 'is', 'are', 'why', 'which', 'the', 'a', 'an', 'work', '这样', '不能'
])

function stripPromptFrame(text: string): string {
  return text
    .replace(/^(?:请)?根据[^，,。]{1,40}[，,]\s*(?:请)?(?:说明|介绍|分析|解释|阐述)\s*/u, '')
    .replace(/^(?:从现有代码看|从代码看|结合代码|在项目中|项目中|请问|麻烦|请|帮我|简单地|详细地)\s*/u, '')
    .replace(/^(?:(?:could|can|would) you\s+)?(?:please\s+)?(?:tell me about|explain|describe|introduce)\s+/iu, '')
    .replace(/^(?:could you|can you|would you|please)\s+/iu, '')
    .replace(/^(?:what is|what are|what does|how does|how do|how can|why is|why does|why do)\s+/iu, '')
}

function rewriteQuestionFrame(text: string): string {
  const rewrites: Array<[RegExp, string]> = [
    [/^.*?对\s*(.{1,32}?)\s*做了哪些\s*(.+?)[?？。]*$/u, '$1 $2'],
    [/^.*?中[“「]?(.{1,20}?)[”」]?\s*(?:和|与)\s*[“「]?(.{1,20}?)[”」]?是什么关系.*$/u, '$1与$2'],
    [/^.*?在什么条件下把\s*(.{1,24}?)\s*转成\s*(.{1,24}?)(?:[?？].*)?$/u, '$1转$2条件'],
    [/^.*?能提供多强的\s*(.{1,24}(?:保证|保障)?)(?:[?？].*)?$/u, '$1'],
    [/^.*?(?:有|存在)\s*(?:.{1,32}?和\s*)?(?:两套|两个|两种)\s*(.{1,16}?)\s*(?:它们)?(?:各自|分别)负责什么.*$/u, '$1职责'],
    [/^.*?(?:两套|两个|两种)\s*(.{1,16}?)\s*[,，]?\s*(?:它们)?(?:各自|分别)负责什么.*$/u, '$1职责'],
    [/^构建(.{1,24}?)时为什么(.+)$/u, '$1$2'],
    [/^(.{1,24}?)如何提供\s*(.{1,24}?)(?:[?？].*)?$/u, '$1与$2'],
    [/^(.{1,24}?)如何保证\s*(.{1,24}?)(?:[?？].*)?$/u, '$2'],
    [/^(.{1,24}?)如何判定\s*(.{1,24}?)(?:[?？].*)?$/u, '$2判定'],
    [/^(.{1,24}?)如何把\s*(.{1,24}?)\s*与\s*(.{1,24}?)绑定.*$/u, '$2与$3绑定'],
    [/^(.{1,24}?)如何把\s*(.{1,24}?)\s*转成\s*(.{1,24}?)(?:[?？].*)?$/u, '$2转$3'],
    [/^(.{0,24}?)如何\s*(.{1,32}?)(?:[?？].*)?$/u, '$1$2']
  ]
  for (const [pattern, replacement] of rewrites) {
    if (pattern.test(text)) return text.replace(pattern, replacement)
  }
  return text
}

function removeCodeReferences(text: string): string {
  const withoutRefs = text
    .replace(/(?<![/\\])\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/gu, value => /^[A-Z]/u.test(value) || width(value) > 16 ? ' ' : value)
    .replace(/\b[A-Z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/gu, ' ')
    .replace(/(?<![A-Za-z0-9])[A-Za-z_][A-Za-z0-9]*_[A-Za-z0-9_]+\b/gu, value => value.length > 14 ? ' ' : value)
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
  const naturalWordCount = words(withoutRefs).filter(word => /[\p{L}\p{N}]/u.test(word) && !scoringStopWords.has(word.toLocaleLowerCase())).length
  return naturalWordCount >= 2 ? withoutRefs : text
}

function candidatePhrase(raw: string): string {
  let text = stripPromptFrame(raw.trim())
  text = removeCodeReferences(text)
  text = rewriteQuestionFrame(text)
    .replace(/^(?:为什么|为何)(?:要|会|必须|应该)?/u, '')
    .replace(/^(?:决定|选择|确定)?先(?:试|选)哪个.*$/u, '')
    .replace(/^(?:分别|各自)(?:解决|负责)什么(?:问题|事情).*$/u, '')
    .replace(/(?:能保证什么|不能保证什么|这样能保证什么|哪些结论不能下).*$/u, '')
    .replace(/(?:之间的关系|之间关系|是什么关系|是什么|有哪些|有什么|是怎样的|如何|怎么(?:样|做)?|为什么|吗|呢|分别).*$/u, '')
    .replace(/\s*\b(?:work|operate|function|happen|occur|handled|implemented|parsed|managed)\b\s*[?？]?$/iu, '')
    .replace(/^(?:请)?(?:说明|介绍|分析|解释|描述|阐述|讲讲)(?:一下)?/u, '')
    .replace(/\s+/gu, ' ')
    .replace(/([\u2e80-\u9fff\uff00-\uffef])\s+(?=[\u2e80-\u9fff\uff00-\uffef])/gu, '$1')
    .replace(/^(?:它们?的?|这类|项目中|在项目中|同时有|的|与|和|及|并)[，,：:\s]*/u, '')
    .replace(/[\s，,：:、]*(?:并|与|和|它|它们|有|不|在哪里|之间|是什么)$/u, '')
    .replace(/^[\s，,：:、-]+|[\s，,：:、-]+$/gu, '').trim()
  return text
}

function extractTopic(question: string): string {
  const statements = normalize(question).split(/[?？。!！;；\n]+/u).filter(Boolean)
  const rawClauses = statements.flatMap(statement => {
    const rewritten = rewriteQuestionFrame(stripPromptFrame(statement))
    return rewritten.split(/[，,]/u)
  })
  const candidates = rawClauses.map(candidatePhrase).filter(Boolean)
  return candidates.find(text => words(text).some(word => /[\p{L}\p{N}]/u.test(word) && !scoringStopWords.has(word.toLocaleLowerCase()))) ?? ''
}

function words(text: string): string[] {
  const output: string[] = []
  for (let index = 0; index < text.length;) {
    technicalToken.lastIndex = index
    const token = technicalToken.exec(text)
    if (token) { output.push(token[0]); index += token[0].length; continue }
    const rest = text.slice(index)
    const chinese = /^[\u2e80-\u9fff]+/u.exec(rest)
    if (chinese) {
      output.push(...Array.from(segmenter.segment(chinese[0]), item => item.segment))
      index += chinese[0].length
    } else {
      const char = Array.from(rest)[0]
      output.push(char)
      index += char.length
    }
  }
  return output
}

function clip(text: string, maxWidth: number, trimDangling = true): string {
  // Keep a code name when it is the only topic; split its natural case/path
  // boundaries only when the complete token cannot fit the caption.
  const expanded = text
    .replace(/\b[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)+\b/gu, value => width(value) > maxWidth ? value.replace(/\./gu, ' ') : value)
    .replace(/\b[A-Z][A-Za-z0-9]*\b/gu, value => width(value) > maxWidth
      ? value.replace(/([A-Z])([A-Z][a-z])/gu, '$1 $2').replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      : value)
  let value = ''
  for (const token of words(expanded)) {
    if (width(value + token) > maxWidth) break
    value += token
  }
  const trimmed = value.replace(/\s*[，,、；;：:]+\s*$/u, '').trim()
  return trimDangling ? trimmed.replace(/(?:以及|同时|和|与|及|并|的)\s*$/u, '').trim() : trimmed
}

function neutral(maxWidth: number): string {
  return width('问题摘要') <= maxWidth ? '问题摘要' : width('问题') <= maxWidth ? '问题' : '题'
}

export type QuestionSummaryInput = string | { question: string; title?: string }

function questionText(input: QuestionSummaryInput): string {
  return typeof input === 'string' ? input : input.question
}

/** A local navigation caption. The full question remains untouched. */
export function summarizeQuestion(input: QuestionSummaryInput, maxWidth = 32): string {
  if (typeof input !== 'string' && input.title?.trim()) {
    const title = clip(normalize(input.title), maxWidth, false)
    if (/[\p{L}\p{N}]/u.test(title)) return title
  }
  const phrase = extractTopic(questionText(input))
  if (!/[\p{L}\p{N}]/u.test(phrase)) return neutral(maxWidth)
  const caption = clip(phrase, maxWidth)
  return /[\p{L}\p{N}]/u.test(caption) ? caption : neutral(maxWidth)
}

/** Distinguish nearby questions sharing a topic without using their row number. */
export function summarizeQuestions(questions: QuestionSummaryInput[], maxWidth = 32): string[] {
  const labels = questions.map(question => summarizeQuestion(question, maxWidth))
  const groups = new Map<string, number[]>()
  labels.forEach((label,index) => groups.set(label,[...(groups.get(label) ?? []),index]))
  for (const [label,indexes] of groups) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      const input = questions[index]
      if (typeof input !== 'string' && input.title?.trim()) continue
      const tokens = Array.from(segmenter.segment(extractTopic(questionText(questions[index]))))
        .filter(item => item.isWordLike)
        .map(item => item.segment)
        .filter(word => !label.includes(word) && !/^(?:如何|怎么|怎样|进行|快速|具体|哪些|什么|查找|定位|work|handle|managed|implemented)$/iu.test(word))
      const detail = tokens.at(-1)
      if (!detail || width(detail) + 5 >= maxWidth) continue
      const prefix = clip(label,maxWidth - width(detail) - 3)
      if (prefix) labels[index] = `${prefix} · ${detail}`
    }
  }
  return labels
}
