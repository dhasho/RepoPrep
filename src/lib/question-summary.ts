const CJK = /[\u2e80-\u9fff\uff00-\uffef]/u
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const technicalToken = /[.#]?[A-Za-z0-9][A-Za-z0-9_./\\:#@+%-]*/uy

function normalize(text: string): string {
  return text
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

const trailingFrame = /(?:有哪些|有什么|是什么(?:关系|作用|意义)?|是怎样的|如何|怎么(?:样|做|实现)?|为什么|为何|能否|是否|吗|呢|分别负责什么|各自负责什么|各自起什么作用|做了哪些|进行了哪些|包含哪些|有哪些内容|有什么影响|什么作用|什么意义|是什么)$/u
const dangling = /(?:以及|同时|并且|并|和|与|及|的|从|到|在|时|如何|有哪些|包含哪些|哪些|什么|之间|是|有|不|而)$/u
const neutralWords = new Set(['请', '根据', '结合', '现有', '代码', '说明', '介绍', '解释', '分析', '描述', '讲讲', '如何', '怎么', '为什么', '什么', '哪些', '是不是', '是否', '分别', '它', '它们', '这', '那', '是', '有', '要', '能', '在', '从', '对', '的', '与', '和', '并', '而', '及', '之间', '关系', '有什么', '吗', '呢', '问题', '解决', '作用', 'could', 'you', 'please', 'explain', 'describe', 'introduce', 'what', 'how', 'does', 'do', 'is', 'are', 'why', 'which', 'the', 'a', 'an', 'work', '这样', '不能'])

function cleanReferences(text: string): string {
  const alone = text.trim()
  if (/^[A-Za-z_$][A-Za-z0-9_$./:#@+%-]*$/u.test(alone)) return alone
  const han = (text.match(/[\u2e80-\u9fff]/gu) ?? []).length
  if (!han) return text
    .replace(/\b[A-Za-z][A-Za-z0-9.]*\b/gu, token => token.length > 24 && /[a-z][A-Z]/u.test(token) ? ' ' : token)
    .replace(/\s+/gu, ' ').trim()
  // Remove whole implementation tokens, never regex fragments of a path or
  // dotted method. Keep acronyms, short technical names and ordinary English.
  const cleaned = words(text).map(token => {
    if (/\.(?:tsx?|jsx?|[cm]js|kt|py|json|md)$/iu.test(token)) return ' '
    if (han < 4) return token
    const reference = /[a-z][A-Z]|[A-Za-z]_\w|\//u.test(token)
      || (/\./u.test(token) && (token.length > 16 || /^[A-Z][a-z]/u.test(token)))
      || (/[a-z]-[a-z]/u.test(token) && text.trim().startsWith(token))
    return reference && token.length >= 10 ? ' ' : token
  }).join('')
  return cleaned
    .replace(/^[A-Z][a-z][A-Za-z0-9]*(?=\s*(?:的|从|中|在))/u, '')
    .replace(/^\s*[a-z][a-z0-9-]*\s+(?=(?:模块|脚本|函数|方法|的))/u, '')
    .replace(/(?:和|与)\s*(?=(?:和|与|及|分别|都|[，,]|$))/gu, '')
    .replace(/\s+/gu, ' ').trim()
}

function stripLead(text: string): string {
  return text
    .replace(/^(?:请)?(?:从|结合|根据).{1,180}?(?:说明|介绍|分析|解释|阐述)\s*/u, '')
    .replace(/\b(?:PR\s*#?\d+|pull request\s*#?\d+)\b/giu, '')
    .replace(/^(?:你|您|我们|你们)(?:在[^，,]{0,40}?中)?(?:为.{1,12}?)?(?:引入了|增加了|加了|将|把)\s*/u, '')
    .replace(/^(?:这个项目的|项目的)\s*/u, '')
    .replace(/^(?:请)?(?:根据|结合)(?:已提供|已有|现有)?(?:的)?(?:代码|源码|代码片段|片段)[，,、：:]?\s*/u, '')
    .replace(/^(?:从现有代码看|从代码看|结合代码|请结合代码|根据代码)[，,、：:]?\s*/u, '')
    .replace(/^(?:从现有代码看|从代码看|结合代码|请结合代码|根据代码|在项目中|项目中|请问|麻烦|请|帮我|简单地|详细地)\s*/u, '')
    .replace(/^(?:(?:could|can|would) you\s+)?(?:please\s+)?(?:tell me about|explain|describe|introduce)\s+/iu, '')
    .replace(/^(?:could you|can you|would you|please)\s+/iu, '')
    .replace(/^(?:what is|what are|what does|how does|how do|how can|why is|why does|why do)\s+/iu, '')
    .replace(/^(?:它们?|这(?:个)?(?:项目)?|该)\s*/u, '')
    .replace(/^从\s*/u, '')
    .replace(/^(?:the|a|an)\s+/iu, '')
}

function makeTopic(raw: string): string {
  let text = stripLead(raw.trim())
  text = text
    .replace(/^.*?对\s*(.{1,48}?)\s*(?:都?做了哪些|进行了哪些|做了什么)\s*/u, '$1 ')
    .replace(/^.*?中[“「]?(.{1,24}?)[”」]?\s*(?:和|与)\s*[“「]?(.{1,24}?)[”」]?是什么关系.*$/u, '$1与$2关系')
    .replace(/^(.{1,36}?)如何把\s*(.{1,36}?)\s*与\s*(.{1,36}?)绑定.*$/u, '$2与$3绑定')
    .replace(/^(.{1,36}?)如何把\s*(.{1,36}?)\s*转成\s*(.{1,36}?)(?:[?？].*)?$/u, '$2转$3')
    .replace(/^构建(.{1,32}?)时为什么/u, '$1构建')
    .replace(/^(.{1,40}?)是如何(?:设计|实现|配置|使用|处理|管理|组织|划分|调用|消费|构建|装配|校验|保证|工作的).*$/u, '$1')
    .replace(/(?:这样能保证什么|能保证什么|不能保证什么|哪些结论不能下).*$/u, '')
    .replace(/(?:它为什么|为什么|为何)(?:要|会|必须|应该)?/gu, '')
    .replace(/^(?:它们?|该)(?:如何|怎么)(?:处理|应对)/u, '处理')
    .replace(/^(?:它们?|该)(?:如何|怎么)/u, '')
    .replace(/(?:它们?)?分别起到什么作用/gu, '职责')
    .replace(/(?:它们?)?分别是什么作用/gu, '职责')
    .replace(/在什么条件下/u, '')
    .replace(/(?:能)?(?:提供|得到|获得)多(?:强|高|大|少)(?:的)?/u, '')
    .replace(/(?:一次|每次|本次)(?=[\p{L}\p{N}])/gu, '')
    .replace(/从\s*[^，,。；;]{1,24}?\s*到\s*[^，,。；;]{1,24}?的(?=[\p{L}\p{N}])/gu, '')
    .replace(/(?:它们)?(?:分别|各自)负责什么/gu, '职责')
    .replace(/(?:分别|各自)起什么作用/gu, '作用')
    .replace(/(?:有哪些|包含哪些|有什么内容|有什么影响|有什么|什么作用|什么意义|是什么关系|是什么|是怎样的|做了哪些|进行了哪些|如何|怎么(?:样|做|实现)?|能否|是否|吗|呢)/gu, '')
    .replace(/^(?:哪些|什么)(?=[\p{L}\p{N}])/u, '')
    .replace(/在哪里.*$/u, '')
    .replace(/(?:实际)?依赖(?:哪一套|哪套).*$/u, '依赖')
    .replace(/时(?:处理|如何|怎么|为什么|为何).*$/u, '')
    .replace(/\s*\b(?:work|operate|function|happen|occur|handled|implemented|parsed|managed)\b\s*[?？]?$/iu, '')
    .replace(/^(?:请)?(?:说明|介绍|分析|解释|描述|阐述|讲讲)(?:一下)?/u, '')
    .replace(/^[，,：:、\s]+|[?？。!！；;，,：:、\s]+$/gu, '')
    .replace(/\s+/gu, ' ').trim()
  text = cleanReferences(text)
    .replace(/从\s*[A-Za-z][\w./:-]*\s*(?=[\u2e80-\u9fff])/gu, '')
    .replace(/^(?:模块|脚本|函数|方法)\s*(?:的)?/u, '')
    .replace(/([\u2e80-\u9fff\uff00-\uffef])\s+(?=[\u2e80-\u9fff\uff00-\uffef])/gu, '$1')
    .replace(/\b(?:PR\s*#?\d+|pull request\s*#?\d+)\b/giu, '')
    .replace(/^[\s，,：:、-]+|[?？。!！；;，,：:、\s]+$/gu, '')
    .replace(/^(?:和|与|及|并|的|在|中|从|到|分别)\s*/u, '')
    .replace(/^(?:的|和|与|及|并)+/u, '')
    .replace(/(?:中的|里的|上的)(?=和|与|及|分别|职责)/gu, '')
    .replace(/(?:中的|里的|上的)$/u, '')
    .replace(/(?:分别(?:是|什么)?语义|分别|主要)$/u, '')
    .replace(/^(?:同时有|同时存在|存在)(?:和|与|及)?/u, '')
    .replace(/(?:和|与)(?=(?:对应|职责|关系)$)/u, '')
    .replace(/时(?:如何|怎么|为何|为什么).*$/u, '')
    .replace(/^[\s，,：:、-]+|[\s，,：:、-]+$/gu, '')
    .replace(dangling, '')
    .trim()
  return text
}

function candidateScore(text: string): number {
  const tokens = words(text).filter(word => /[\p{L}\p{N}]/u.test(word))
  const meaningful = tokens.filter(word => !neutralWords.has(word.toLocaleLowerCase()))
  if (!meaningful.length) return -1000
  const nonAsciiWords = meaningful.filter(word => /[^\x00-\x7f]/u.test(word)).length
  const punctuation = (text.match(/[.?!？。]/gu) ?? []).length
  return meaningful.length * 4 + nonAsciiWords * 2 + Math.min(width(text), 48) / 20 - punctuation * 3
}

function extractTopic(question: string): string {
  const normalized = normalize(question)
  const clauses = normalized
    .split(/[?？。!！;；\n]+/u)
    .flatMap(statement => statement.split(/[，,]/u))
    .map(raw => {
      // A question often already names its subject before its interrogative.
      // Prefer that complete noun phrase over removing "how" and clipping the
      // resulting long sentence. Pure implementation anchors are not subjects.
      const stem = raw.match(/^(.+?)(?:是如何|如何|怎么|怎样|为什么|为何|是什么|有哪些|包含哪些|分别(?:起到|解决|影响))/u)?.[1]
      const subject = stem ? makeTopic(stem).replace(/(?:而不是|是[「“]).*$/u, '').trim() : ''
      const han = (subject.match(/[\u2e80-\u9fff]/gu) ?? []).length
      if ((han >= 6 || han >= 4 && width(subject) >= 14) && width(subject) <= 48 && !/[在对从]([^，,]{1,12})$/u.test(subject) && candidateScore(subject) > 0) return subject
      return makeTopic(raw)
    })
    .filter(Boolean)
  if (!clauses.length) {
    const loneIdentifier = normalized.replace(/[?？。!！;；]+$/gu, '').trim()
    if (/^[A-Za-z_$][A-Za-z0-9_$./:#@+%-]*$/u.test(loneIdentifier)) return loneIdentifier
    return ''
  }
  return clauses.find(text => candidateScore(text) > 0 && !/^(?:中|在|和|与|的|但)|(?:哪个|什么|怎样|多强|几乎|你提交|你在|改进了|分别做|是设计|和职责)/u.test(text)
    && !/^(?:有|是)?\s*[\d,. -]+(?:[KMG]i?B)?$/iu.test(text))
    ?? clauses.find(text => candidateScore(text) > 0) ?? ''
}

function clip(text: string, maxWidth: number, trimDangling = true): string {
  if (width(text) > maxWidth && trimDangling) {
    // Prefer a whole contrast/coordination branch or quoted concept to an
    // arbitrary sentence prefix. These boundaries are independent of topics.
    const branch = text.split(/而不是|并要求|并且|以及/u)[0].trim()
    if (branch && width(branch) <= maxWidth) return branch.replace(dangling, '').trim()
    const quoted = text.match(/[「“]([^」”]{4,80})[」”]/u)?.[1]
    if (quoted && width(quoted) <= maxWidth) return quoted
  }
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
  return trimDangling ? trimmed.replace(dangling, '').trim() : trimmed
}

function neutral(maxWidth: number): string {
  return width('问题摘要') <= maxWidth ? '问题摘要' : width('问题') <= maxWidth ? '问题' : '题'
}

export type QuestionSummaryInput = string | { question: string; title?: string }

function questionText(input: QuestionSummaryInput): string {
  return typeof input === 'string' ? input : input.question
}

function isUsefulTitle(title: string, maxWidth: number): boolean {
  const cleaned = normalize(title)
  const promptLike = /如何|怎样|怎么|为什么|为何|有哪些|做了哪些|是什么|^(?:请问|请说明|what\b|how\b|why\b|please\b|explain\b)/iu.test(cleaned)
  return width(cleaned) <= maxWidth && /[\p{L}\p{N}]/u.test(cleaned) && !promptLike && !/[?？。!！]$/u.test(cleaned) && !trailingFrame.test(cleaned)
}

/** A local navigation caption. The full question remains untouched. */
export function summarizeQuestion(input: QuestionSummaryInput, maxWidth = 48): string {
  if (typeof input !== 'string' && input.title?.trim() && isUsefulTitle(input.title, maxWidth)) {
    return normalize(input.title)
  }
  const phrase = extractTopic(questionText(input))
  if (!/[\p{L}\p{N}]/u.test(phrase)) return neutral(maxWidth)
  const caption = clip(phrase, maxWidth)
  return /[\p{L}\p{N}]/u.test(caption) ? caption : neutral(maxWidth)
}

/** Distinguish nearby questions sharing a topic without using their row number. */
export function summarizeQuestions(questions: QuestionSummaryInput[], maxWidth = 48): string[] {
  const labels = questions.map(question => summarizeQuestion(question, maxWidth))
  const groups = new Map<string, number[]>()
  labels.forEach((label, index) => groups.set(label, [...(groups.get(label) ?? []), index]))
  for (const [label, indexes] of groups) {
    if (indexes.length < 2) continue
    const topicWords = indexes.map(index => words(extractTopic(questionText(questions[index])))
      .filter(token => /[\p{L}\p{N}]/u.test(token) && !neutralWords.has(token.toLocaleLowerCase())))
    for (const index of indexes) {
      const input = questions[index]
      if (typeof input !== 'string' && input.title?.trim() && isUsefulTitle(input.title, maxWidth)) continue
      const own = indexes.indexOf(index)
      const detail = topicWords[own].filter(token => !label.includes(token)
        && topicWords.every((other, position) => position === own || !other.includes(token))).at(-1)
      if (!detail || width(detail) + 5 >= maxWidth) continue
      const prefix = clip(label, maxWidth - width(detail) - 3)
      if (prefix) labels[index] = `${prefix} · ${detail}`
    }
  }
  return labels
}
