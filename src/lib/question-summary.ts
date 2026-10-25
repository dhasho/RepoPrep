interface TopicRule { terms: RegExp[]; summary: string }

// Common concepts, not project names or a table of generated questions.
const topicRules: TopicRule[] = [
  { terms: [/架构/u, /主进程/u, /preload/iu, /渲染进程/u], summary: '整体架构与进程协作' },
  { terms: [/preload/iu, /window\.api/iu, /IPC/u, /契约|通道/u], summary: 'preload接口与IPC契约' },
  { terms: [/页面/u, /状态/u, /流转|协作|管理/u], summary: '页面状态流转' },
  { terms: [/后台/u, /生成任务/u, /建模|隔离/u], summary: '后台生成任务建模与隔离' },
  { terms: [/扫描/u, /\.gitignore|忽略|构建产物|worktree/iu], summary: '项目扫描与忽略规则' },
  { terms: [/缓存/u, /键/u, /失效/u], summary: '缓存键与失效策略' },
  { terms: [/读取内容|内容读取/u, /路径穿越|超大文件|读取失败|读取.*失败/u], summary: '内容读取边界与错误处理' },
  { terms: [/敏感信息/u, /脱敏/u], summary: '敏感信息脱敏流程' },
  { terms: [/生成请求/u, /数据流/u], summary: '生成请求数据流' },
  { terms: [/上下文/u, /组装|预算|限制/u], summary: '上下文组装与预算' },
  { terms: [/题量/u, /目标区间|预算/u, /补偿/u], summary: '题量分配与补偿' },
  { terms: [/流式响应|流式.*响应/u, /错误|中断|事件|DONE/u], summary: '流式响应与异常处理' },
  { terms: [/进程/u, /分层/u, /职责/u], summary: '进程分层与模块职责' },
  { terms: [/\bIPC\b|进程间通信/iu, /命名|契约|漂移|对应/u], summary: 'IPC 通道与契约' },
  { terms: [/IPC|请求|渲染/iu, /可信|来源|授权/u], summary: '请求来源与访问授权' },
  { terms: [/Markdown|富文本/iu, /XSS|外链|安全|防护/iu], summary: 'Markdown 渲染安全' },
  { terms: [/文件树|目录树/u, /上下文|预算|大小|上限/u], summary: '文件树与上下文预算' },
  { terms: [/候选/u, /排除|过滤|筛选/u], summary: '内容筛选与排除规则' },
  { terms: [/快照|snapshot/iu, /扫描|文件系统|realpath/iu], summary: '扫描快照与身份校验' },
  { terms: [/字符/u, /token/iu, /预算|限制|上限/u], summary: '字符与 token 预算' },
  { terms: [/题量|配额/u, /分配|批次|模块批/u], summary: '题量与批次分配' },
  { terms: [/去重|重复/u, /补偿|补足|补齐/u], summary: '问题去重与补偿' },
  { terms: [/术语|glossary/iu, /清理|裁剪|prun/iu], summary: '术语清理与结果裁剪' },
  { terms: [/LLM|模型/iu, /请求/u, /地址|响应|超时|重试/u], summary: '模型请求与响应控制' },
  { terms: [/结果|历史/u, /契约/u, /存储|诊断/u], summary: '结果契约与历史存储' },
  { terms: [/任务/u, /隔离|生命周期/u], summary: '任务生命周期与隔离' },
  { terms: [/导航|前进|后退/u, /历史|状态/u], summary: '导航历史与页面状态' },
  { terms: [/术语|名词/u, /流式|旧事件|停止/u], summary: '术语解释与流式控制' },
  { terms: [/连接测试|模型检测|模型探测/u, /异步|覆盖|状态/u], summary: '异步检测与状态隔离' },
  { terms: [/API\s*Key|凭据|密钥/iu, /加密|存储|保存/u], summary: '凭据加密与存储' },
  { terms: [/评测|评分|scorer/iu, /指标|合同|契约|配额|重复|覆盖|指纹/u], summary: '评测指标与问题指纹' },
  { terms: [/缓存/u, /失效/u], summary: '缓存失效策略' }
]

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

function trimFrame(question: string): string {
  let text = normalize(question).split(/[?？。!！;；\n]|\.(?=\s|$)/u, 1)[0] ?? ''
  const lead = /^(?:请)?(?:从|结合|根据).+?(?:说明|介绍|分析|解释|阐述)\s*(.+)$/u.exec(text)
  if (lead) text = lead[1]
  for (let i = 0; i < 3; i++) {
    text = text
      .replace(/^(?:请问|麻烦|能否|可以|请|帮我|简单地|详细地)+/u, '')
      .replace(/^(?:介绍|说明|解释|描述|讲讲|分析|阐述)(?:一下)?\s*/u, '')
      .replace(/^(?:could you|can you|would you|please|tell me about|explain|describe|introduce)\s+/iu, '')
  }
  return text
    .replace(/^(?:what is|what are|what does|how does|how do|how can|why is|why does|why do)\s+/iu, '')
    .replace(/^(?:the|a|an)\s+/iu, '')
    .replace(/^(?:什么是|什么叫|关于|对于)\s*/u, '')
    .replace(/\s*(?:是什么|有哪些|有什么|是怎样的|如何|怎么(?:样|做)?|为什么|吗|呢)\s*$/u, '')
    .replace(/\s+(?:work|operate|function|happen|occur|handled|implemented|parsed|managed)\s*$/iu, '')
    .replace(/([A-Za-z0-9])\s*的\s*/gu, '$1')
    .replace(/\s*(?:是如何|如何|怎么|怎样)(?:进行|实现|处理|管理|设计|建模)?\s*/gu, '')
    .replace(/^[\s，,：:、-]+|[\s，,：:、-]+$/gu, '').trim()
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

function clip(text: string, maxWidth: number): string {
  const expanded = text.replace(/\b[A-Z][A-Za-z0-9]*\b/gu, identifier => {
    if (width(identifier) <= maxWidth) return identifier
    return identifier.replace(/([A-Z])([A-Z][a-z])/gu, '$1 $2').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/\s+(?:Manager|Service|Controller|Provider|Handler|Factory)$/u, '')
  })
  let value = ''
  for (const token of words(expanded)) {
    if (width(value + token) > maxWidth) break
    value += token
  }
  return value.replace(/\s*[，,、；;：:]+\s*$/u, '').replace(/(?:以及|同时|和|与|及|并|的)\s*$/u, '').trim()
}

function neutral(maxWidth: number): string {
  return width('问题摘要') <= maxWidth ? '问题摘要' : width('问题') <= maxWidth ? '问题' : '题'
}

/** A local navigation caption. The full question remains untouched. */
export function summarizeQuestion(question: string, maxWidth = 32): string {
  const text = normalize(question)
  const topic = topicRules.find(rule => rule.terms.every(term => term.test(text)))?.summary
  if (topic && width(topic) <= maxWidth) return topic
  const phrase = trimFrame(question)
  if (!/[\p{L}\p{N}]/u.test(phrase)) return neutral(maxWidth)
  return clip(phrase, maxWidth) || neutral(maxWidth)
}

/** Distinguish nearby questions sharing a topic without using their row number. */
export function summarizeQuestions(questions: string[], maxWidth = 32): string[] {
  const labels = questions.map(question => summarizeQuestion(question, maxWidth))
  const groups = new Map<string, number[]>()
  labels.forEach((label,index) => groups.set(label,[...(groups.get(label) ?? []),index]))
  for (const [label,indexes] of groups) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      const tokens = Array.from(segmenter.segment(trimFrame(questions[index])))
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
