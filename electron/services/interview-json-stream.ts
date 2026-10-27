import { RESULT_LIMITS } from '@shared/result-contract'

export interface StreamedInterviewQuestion {
  sectionIndex: number
  questionIndex: number
  section: { title: string; summary?: string }
  question: unknown
}

const MAX_CHARS = 1_000_000
const MAX_DEPTH = 128
const UNKNOWN_SECTION = '未命名主题'
const UTF8 = new TextEncoder()
const PREVIEW_LIMIT = RESULT_LIMITS.totalChars - 250_000
type PreviewFollowUp = { question: string; answer: string; followUps: PreviewFollowUp[] }

export interface InterviewJsonPreview {
  projectSummary: string
  activeQuestion?: {
    sectionIndex: number
    questionIndex: number
    sectionTitle?: string
    sectionSummary?: string
    title?: string
    question?: string
    answer?: string
    followUps: PreviewFollowUp[]
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type Frame = {
  kind: 'object' | 'array'
  value: JsonValue[] | { [key: string]: JsonValue }
  path: Array<string | number>
  state: 'first' | 'key' | 'colon' | 'value' | 'comma' | 'done'
  key?: string
  keys: Set<string>
}

/** Incremental, bounded JSON parser for the existing interview report shape. */
export class InterviewJsonStream {
  private frames: Frame[] = []
  private root: JsonValue | undefined
  private rootSet = false
  private cursor = 0
  private source = ''
  private sourceBytes = 0
  private token: { kind: 'string' | 'number' | 'literal'; raw: string; escaped: boolean } | null = null
  private pending: StreamedInterviewQuestion[] = []
  private emitted = new Set<string>()
  private summary: string | undefined
  private glossary: Record<string, string> = {}
  private complete = false
  private failed = false

  push(delta: string): StreamedInterviewQuestion[] {
    this.assertLive()
    if (typeof delta !== 'string' || this.source.length + delta.length > MAX_CHARS) return this.fail()
    this.sourceBytes += UTF8.encode(delta).byteLength
    if (this.sourceBytes > 4 * 1024 * 1024) return this.fail()
    this.source += delta
    this.parseAvailable()
    return this.drain()
  }

  drain(): StreamedInterviewQuestion[] {
    const result = this.pending
    this.pending = []
    return result
  }

  metadata(): { projectSummary: string; glossary: Record<string, string> } {
    return { projectSummary: this.summary ?? '', glossary: { ...this.glossary } }
  }

  /** Return only safe, user-facing report fields currently available in the open JSON object. */
  preview(): InterviewJsonPreview {
    const root = this.root as Record<string, JsonValue> | undefined
    const projectSummary = (this.summary ?? this.partialStringAt(['projectSummary']) ?? '').replaceAll('\0', '')
    const questionFrame = [...this.frames].reverse().find(frame =>
      frame.kind === 'object' && frame.path.length === 4 && frame.path[0] === 'sections' &&
      typeof frame.path[1] === 'number' && frame.path[2] === 'questions' && typeof frame.path[3] === 'number'
    )
    if (!questionFrame) return { projectSummary: projectSummary.slice(0, RESULT_LIMITS.projectSummary) }

    const [sectionIndex, questionIndex] = [questionFrame.path[1], questionFrame.path[3]] as [number, number]
    const sections = root && Array.isArray(root.sections) ? root.sections : []
    const section = sections[sectionIndex]
    const sectionObject = isRecord(section) ? section : {}
    const question = questionFrame.value as Record<string, JsonValue>
    const followUpsFrame = [...this.frames].reverse().find(frame => frame.kind === 'array' && frame.path.length === 5 &&
      frame.path[0] === 'sections' && frame.path[1] === sectionIndex && frame.path[2] === 'questions' &&
      frame.path[3] === questionIndex && frame.path[4] === 'followUps')
    const followUpValues = followUpsFrame ? followUpsFrame.value as JsonValue[] : question.followUps
    const followUps = safeFollowUps(followUpValues)
    const activeFollowUpFrame = [...this.frames].reverse().find(frame => frame.kind === 'object' && frame.path.length === 6 &&
      frame.path[0] === 'sections' && frame.path[1] === sectionIndex && frame.path[2] === 'questions' &&
      frame.path[3] === questionIndex && frame.path[4] === 'followUps' && typeof frame.path[5] === 'number')
    if (activeFollowUpFrame) {
      const followValue = activeFollowUpFrame.value as Record<string, JsonValue>
      const followQuestion = typeof followValue.question === 'string' ? followValue.question : this.partialStringAt([...activeFollowUpFrame.path, 'question'])
      const followAnswer = typeof followValue.answer === 'string' ? followValue.answer : this.partialStringAt([...activeFollowUpFrame.path, 'answer'])
      if (followQuestion?.trim() && !followUps.some(item => item.question === followQuestion && item.answer === (followAnswer ?? ''))) {
        followUps.push({ question: followQuestion.slice(0, RESULT_LIMITS.question), answer: (followAnswer ?? '').replaceAll('\0', '').slice(0, RESULT_LIMITS.answer), followUps: [] })
      }
    }
    const read = (source: Record<string, JsonValue>, key: string, path: Array<string | number>, limit: number): string | undefined => {
      const value = source[key]
      const partial = this.partialStringAt(path)
      const text = typeof value === 'string' ? value : partial
      return typeof text === 'string' ? text.replaceAll('\0', '').slice(0, limit) : undefined
    }
    const sectionTitle = read(sectionObject, 'title', ['sections', sectionIndex, 'title'], RESULT_LIMITS.sectionTitle)
    const sectionSummary = read(sectionObject, 'summary', ['sections', sectionIndex, 'summary'], RESULT_LIMITS.sectionSummary)
    const title = read(question, 'title', [...questionFrame.path, 'title'], RESULT_LIMITS.questionTitle)
    const questionText = read(question, 'question', [...questionFrame.path, 'question'], RESULT_LIMITS.question)
    const answer = read(question, 'answer', [...questionFrame.path, 'answer'], RESULT_LIMITS.answer)
    const result: InterviewJsonPreview = {
      projectSummary: projectSummary.slice(0, RESULT_LIMITS.projectSummary),
      activeQuestion: {
        sectionIndex,
        questionIndex,
        sectionTitle: sectionTitle || UNKNOWN_SECTION,
        ...(sectionSummary ? { sectionSummary } : {}),
        ...(title ? { title } : {}),
        ...(questionText !== undefined ? { question: questionText } : {}),
        ...(answer !== undefined ? { answer } : {}),
        followUps
      }
    }
    trimPreview(result, PREVIEW_LIMIT)
    return result
  }

  finish(): unknown {
    this.assertLive()
    this.parseAvailable()
    this.skipWhitespace()
    if (!this.rootSet || this.frames.length || this.token || this.cursor !== this.source.length || !this.complete) return this.fail()
    return this.root
  }

  private assertLive(): void {
    if (this.failed) throw new SyntaxError('Invalid interview JSON stream')
  }

  private fail(): never {
    this.failed = true
    throw new SyntaxError('Invalid interview JSON stream')
  }

  private parseAvailable(): void {
    while (this.cursor < this.source.length) {
      if (this.token) {
        if (!this.readToken()) return
        continue
      }
      this.skipWhitespace()
      if (this.cursor >= this.source.length) break
      const frame = this.frames[this.frames.length - 1]
      if (!frame) {
        if (this.rootSet) this.fail()
        this.readValue([])
        continue
      }
      const ch = this.source[this.cursor]
      if (frame.kind === 'object') this.readObject(frame, ch)
      else this.readArray(frame, ch)
    }
  }

  private skipWhitespace(): void {
    while (this.cursor < this.source.length && /[\u0009\u000a\u000d\u0020]/.test(this.source[this.cursor])) this.cursor++
  }

  private readObject(frame: Frame, ch: string): void {
    if (frame.state === 'first' || frame.state === 'key') {
      if (frame.state === 'first' && ch === '}') { this.cursor++; this.closeFrame(frame); return }
      if (ch !== '"') this.fail()
      frame.state = 'colon'
      this.startToken('string', true)
      return
    }
    if (frame.state === 'colon') {
      if (ch !== ':') this.fail()
      this.cursor++
      frame.state = 'value'
      return
    }
    if (frame.state === 'value') { this.readValue([...frame.path, frame.key as string]); return }
    if (frame.state === 'comma') {
      if (ch === ',') { this.cursor++; frame.state = 'key'; return }
      if (ch === '}') { this.cursor++; this.closeFrame(frame); return }
      this.fail()
    }
    this.fail()
  }

  private readArray(frame: Frame, ch: string): void {
    if (frame.state === 'first' && ch === ']') { this.cursor++; this.closeFrame(frame); return }
    if (frame.state === 'first' || frame.state === 'value') { this.readValue([...frame.path, (frame.value as JsonValue[]).length]); return }
    if (frame.state === 'comma') {
      if (ch === ',') { this.cursor++; frame.state = 'value'; return }
      if (ch === ']') { this.cursor++; this.closeFrame(frame); return }
      this.fail()
    }
    this.fail()
  }

  private readValue(path: Array<string | number>): void {
    const ch = this.source[this.cursor]
    if (ch === '{' || ch === '[') {
      if (this.frames.length >= MAX_DEPTH) this.fail()
      this.cursor++
      const value: JsonValue[] | Record<string, JsonValue> = ch === '{' ? {} : []
      this.attach(value, path)
      this.frames.push({ kind: ch === '{' ? 'object' : 'array', value, path, state: 'first', keys: new Set() })
      return
    }
    if (ch === '"') { this.startToken('string', false); return }
    if (ch === '-' || (ch >= '0' && ch <= '9')) { this.startToken('number', false); return }
    if (ch === 't' || ch === 'f' || ch === 'n') { this.startToken('literal', false); return }
    this.fail()
  }

  private startToken(kind: 'string' | 'number' | 'literal', isKey: boolean): void {
    const start = this.cursor
    this.cursor++
    this.token = { kind: isKey ? 'string' : kind, raw: this.source[start], escaped: false }
    if (isKey) this.token.raw = '\u0001KEY' + this.token.raw
  }

  private readToken(): boolean {
    const token = this.token!
    while (this.cursor < this.source.length) {
      const ch = this.source[this.cursor]
      token.raw += ch
      this.cursor++
      if (token.kind === 'string') {
        if (token.escaped) token.escaped = false
        else if (ch === '\\') token.escaped = true
        else if (ch === '"') {
          this.token = null
          const isKey = token.raw.startsWith('\u0001KEY')
          const raw = isKey ? token.raw.slice(4) : token.raw
          let value: JsonValue
          try { value = JSON.parse(raw) as JsonValue } catch { this.fail() }
          if (isKey) {
            const frame = this.frames[this.frames.length - 1]
            if (!frame || frame.kind !== 'object' || typeof value !== 'string') this.fail()
            if (frame.keys.has(value)) this.fail()
            frame.keys.add(value)
            frame.key = value
          } else this.attach(value!, this.valuePath())
          return true
        }
      } else if (token.kind === 'literal') {
        const target = token.raw[0] === 't' ? 'true' : token.raw[0] === 'f' ? 'false' : 'null'
        if (!target.startsWith(token.raw)) this.fail()
        if (token.raw === target) {
          this.token = null
          this.attach(target === 'true' ? true : target === 'false' ? false : null, this.valuePath())
          return true
        }
      } else if (/[\u0009\u000a\u000d\u0020,}\]]/.test(ch)) {
        token.raw = token.raw.slice(0, -1)
        this.cursor--
        let number: number
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token.raw)) this.fail()
        number = Number(token.raw)
        if (!Number.isFinite(number)) this.fail()
        this.token = null
        this.attach(number, this.valuePath())
        return true
      }
    }
    return false
  }

  private valuePath(): Array<string | number> {
    const parent = this.frames[this.frames.length - 1]
    if (!parent) return []
    if (parent.kind === 'object') return [...parent.path, parent.key as string]
    return [...parent.path, (parent.value as JsonValue[]).length]
  }

  private attach(value: JsonValue, path: Array<string | number>): void {
    const parent = this.frames[this.frames.length - 1]
    if (!parent) {
      if (this.rootSet) this.fail()
      this.root = value
      this.rootSet = true
      if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail()
      if (this.cursor === this.source.length && !this.frames.length) this.complete = true
      return
    }
    if (parent.kind === 'object') {
      if (parent.state !== 'value' || parent.key === undefined) this.fail()
      Object.defineProperty(parent.value, parent.key, { value, enumerable: true, configurable: true, writable: true })
      this.updateMetadata(parent.path, parent.key, value)
      parent.key = undefined
      parent.state = 'comma'
    } else {
      if (parent.state !== 'first' && parent.state !== 'value') this.fail()
      ;(parent.value as JsonValue[]).push(value)
      parent.state = 'comma'
    }
    void path
  }

  private updateMetadata(parentPath: Array<string | number>, key: string, value: JsonValue): void {
    if (parentPath.length === 0 && key === 'projectSummary' && typeof value === 'string') this.summary = value
    if (parentPath.length === 1 && parentPath[0] === 'glossary' && typeof value === 'string') {
      Object.defineProperty(this.glossary, key, { value, enumerable: true, configurable: true, writable: true })
    }
  }

  private partialStringAt(path: Array<string | number>): string | undefined {
    if (this.token?.kind !== 'string' || this.token.raw.startsWith('\u0001KEY')) return undefined
    const tokenPath = this.valuePath()
    if (tokenPath.length !== path.length || tokenPath.some((part, index) => part !== path[index])) return undefined
    return decodePartialJsonString(this.token.raw)
  }

  private closeFrame(frame: Frame): void {
    if (frame.state === 'colon' || frame.state === 'value' || frame.state === 'key') this.fail()
    this.frames.pop()
    if (frame.path.length === 4 && frame.path[0] === 'sections' && typeof frame.path[1] === 'number' && frame.path[2] === 'questions' && typeof frame.path[3] === 'number' && frame.kind === 'object') {
      const [sectionIndex, questionIndex] = [frame.path[1], frame.path[3]] as [number, number]
      const sectionValue = (this.root as Record<string, JsonValue> | undefined)?.sections
      const section = Array.isArray(sectionValue) ? sectionValue[sectionIndex] : undefined
      const sectionObject = section && typeof section === 'object' && !Array.isArray(section) ? section as Record<string, JsonValue> : {}
      const title = typeof sectionObject.title === 'string' && sectionObject.title.length ? sectionObject.title : UNKNOWN_SECTION
      const result: StreamedInterviewQuestion = { sectionIndex, questionIndex, section: { title }, question: frame.value }
      if (typeof sectionObject.summary === 'string') result.section.summary = sectionObject.summary
      const id = `${sectionIndex}:${questionIndex}`
      if (!this.emitted.has(id)) { this.emitted.add(id); this.pending.push(result) }
    }
    if (!this.frames.length) this.complete = true
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeFollowUps(value: JsonValue | undefined, depth = 1): PreviewFollowUp[] {
  if (!Array.isArray(value) || depth > 2) return []
  const result: PreviewFollowUp[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.question !== 'string' || typeof item.answer !== 'string') continue
    const question = item.question.replaceAll('\0', '').slice(0, RESULT_LIMITS.question)
    if (!question.trim()) continue
    result.push({
      question,
      answer: item.answer.replaceAll('\0', '').slice(0, RESULT_LIMITS.answer),
      followUps: depth < 2 ? safeFollowUps(item.followUps, depth + 1) : []
    })
    if (result.length >= RESULT_LIMITS.followUpsPerItem) break
  }
  return result
}

function trimPreview(preview: InterviewJsonPreview, budget: number): void {
  let used = preview.projectSummary.length
  const active = preview.activeQuestion
  if (!active) return
  for (const key of ['sectionTitle', 'sectionSummary', 'title', 'question', 'answer'] as const) {
    const value = active[key]
    if (value === undefined) continue
    active[key] = value.slice(0, Math.max(0, budget - used))
    used += active[key]!.length
  }
  const trimFollow = (items: NonNullable<InterviewJsonPreview['activeQuestion']>['followUps']): void => {
    for (const follow of items) {
      const remaining = Math.max(0, budget - used)
      if (!remaining) { items.length = 0; break }
      follow.question = follow.question.slice(0, remaining)
      used += follow.question.length
      follow.answer = follow.answer.slice(0, Math.max(0, budget - used))
      used += follow.answer.length
      trimFollow(follow.followUps)
    }
  }
  trimFollow(active.followUps)
}

/** Decode only the complete, valid prefix of an unfinished JSON string token. */
function decodePartialJsonString(raw: string): string {
  let decoded = ''
  for (let index = 1; index < raw.length; index++) {
    const ch = raw[index]
    if (ch === '"') break
    if (ch !== '\\') {
      if (ch.charCodeAt(0) < 0x20) break
      decoded += ch
      continue
    }
    const escape = raw[index + 1]
    if (escape === undefined) break
    if (escape === '"' || escape === '\\' || escape === '/') { decoded += escape; index++; continue }
    if (escape === 'b' || escape === 'f' || escape === 'n' || escape === 'r' || escape === 't') {
      decoded += ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as const)[escape]
      index++
      continue
    }
    if (escape !== 'u' || index + 5 >= raw.length) break
    const hex = raw.slice(index + 2, index + 6)
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
    const code = Number.parseInt(hex, 16)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (raw.slice(index + 6, index + 8) !== '\\u' || index + 11 >= raw.length) break
      const lowHex = raw.slice(index + 8, index + 12)
      if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) break
      const low = Number.parseInt(lowHex, 16)
      if (low < 0xdc00 || low > 0xdfff) break
      decoded += String.fromCharCode(code, low)
      index += 11
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) break
    decoded += String.fromCharCode(code)
    index += 5
  }
  if (decoded.length && /[\uD800-\uDBFF]$/.test(decoded)) return decoded.slice(0, -1)
  return decoded
}
