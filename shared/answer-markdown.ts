// 已保存答案的保守显示/导出格式化：只重排布局，不改写任何文字、标点或顺序。
//
// 约定（与第一版问答展示保持一致，不引入新依赖、不写通用 Markdown 解析器）：
// - 只处理"不含换行的单段落"答案；已是块级 Markdown（列表/标题/表格/引用/代码块）的内容原样返回。
// - 分号列表：句内出现"引入句：要点；要点；…"（分隔符为中文分号；）时，渲染为引入行 + 无序列表。
//   分隔的；保留在条目末尾，句末标点保留，不增删任何字符（列表标记除外）。
// - 超长纯段落：长度超过阈值且至少 3 个句子时，按句号边界拆成多个段落；普通短句不拆。
// - 行内代码（`...`）与 [[术语]] 内部的分隔符不参与切分；反引号不成对或无法确定时原样返回。

const MIN_PARAGRAPH_WIDTH = 240
const MIN_SENTENCES = 3

/** 是否包含块级 Markdown 结构（此时答案已是正常排版，不再改写）。 */
function hasBlockMarkdown(answer: string): boolean {
  return /(^|\n)\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s|\|)/u.test(answer) || answer.includes('```')
}

/** 找出不在行内代码（`…`）和 [[术语]] 内部的分隔符位置；反引号不成对时返回 null。 */
function outsideProtectedSpans(text: string, separator: string): number[] | null {
  const positions: number[] = []
  let inCode = false
  let inTerm = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '`') {
      inCode = !inCode
      continue
    }
    if (!inCode && char === '[' && text[i + 1] === '[') {
      inTerm = true
      i++
      continue
    }
    if (inTerm && char === ']' && text[i + 1] === ']') {
      inTerm = false
      i++
      continue
    }
    if (!inCode && !inTerm && char === separator) positions.push(i)
  }
  if (inCode || inTerm) return null
  return positions
}

/** 按句末标点（。！？!?) 切句，保留标点；切分同样避开代码与术语。 */
function splitSentences(text: string): string[] | null {
  const bounds = outsideProtectedSpans(text, '。')
  if (bounds === null) return null
  const sentences: string[] = []
  let start = 0
  const push = (end: number): void => {
    const sentence = text.slice(start, end).trim()
    if (sentence) sentences.push(sentence)
    start = end
  }
  for (const bound of bounds) {
    // 句号后跟引号/括号时一并归入该句
    let end = bound + 1
    while (end < text.length && /^[”』）)」]$/u.test(text[end])) end++
    push(end)
    start = end
  }
  if (start < text.length) {
    const tail = text.slice(start).trim()
    if (tail) sentences.push(tail)
  }
  return sentences
}

function isListSentence(sentence: string): boolean {
  const semicolons = outsideProtectedSpans(sentence, '；')
  if (!semicolons || semicolons.length < 2) return false
  const colons = outsideProtectedSpans(sentence, '：')
  if (!colons || colons.length === 0) return false
  return colons[0] < semicolons[0]
}

function widthUnits(text: string): number {
  return Array.from(text).reduce((width, char) => width + (/[\u2e80-\u9fff\uff00-\uffef]/u.test(char) ? 2 : 1), 0)
}

/** 把"引入句：要点；要点；…。"渲染为引入行 + 无序列表；所有原有字符（含；。）保持不变。 */
function renderListSentence(sentence: string): string[] {
  const semicolons = outsideProtectedSpans(sentence, '；')!
  const colons = outsideProtectedSpans(sentence, '：')!
  const introEnd = colons[0] + 1
  const intro = sentence.slice(0, introEnd).trim()
  const lines = [intro, '']
  let start = 0
  const separators = semicolons.filter((position) => position > introEnd)
  for (const position of separators) {
    const item = sentence.slice(introEnd + start, position + 1).trim()
    if (item) lines.push(`- ${item}`)
    start = position + 1 - introEnd
  }
  const last = sentence.slice(introEnd + start).trim()
  if (last) lines.push(`- ${last}`)
  return lines
}

/**
 * 保守地把单段落答案排成易读的分点/分段。任何不确定的情况（多行、已有块级 Markdown、
 * 代码定界不完整、长度不足）都原样返回输入。仅用于答案与追问的显示和导出，
 * 不改写项目概览，也不改已保存的原始数据。
 */
export function formatAnswerMarkdown(answer: string): string {
  if (!answer || answer.includes('\n') || hasBlockMarkdown(answer)) return answer

  // Existing inline markup/links may span punctuation. Leave ambiguous input intact.
  // Single-backtick code and [[terms]] are handled by the bounded scanner below.
  if (/``|~~~|\*|__|[a-z][a-z\d+.-]*:\/\/|mailto:|\[[^\]\n]*\]\s*(?:\(|\[)|<[^>\n]+>/iu.test(answer)) return answer
  if (/(?:^|[^\p{L}\p{N}_])_[^_]+_(?=$|[^\p{L}\p{N}_])/u.test(answer)) return answer

  const sentences = splitSentences(answer)
  if (!sentences || sentences.length === 0) return answer

  const hasList = sentences.some(isListSentence)
  if (!hasList && (widthUnits(answer) < MIN_PARAGRAPH_WIDTH || sentences.length < MIN_SENTENCES)) {
    return answer
  }

  const blocks: string[] = []
  for (const sentence of sentences) {
    if (isListSentence(sentence)) blocks.push(renderListSentence(sentence).join('\n'))
    else blocks.push(sentence)
  }
  return blocks.join('\n\n')
}
