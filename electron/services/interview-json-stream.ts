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
