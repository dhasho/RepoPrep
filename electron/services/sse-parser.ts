export interface SseEvent {
  event: string
  data: string
}

export interface SseDecoderOptions {
  maxBufferChars?: number
}

const DEFAULT_MAX_BUFFER_CHARS = 1_000_000
const INVALID_LIMIT_MESSAGE = 'SSE buffer limit must be a positive integer.'
const BUFFER_LIMIT_MESSAGE = 'SSE stream exceeds the configured buffer limit.'

/**
 * Incrementally decodes the framing layer of an SSE stream.
 * `finish()` flushes a final unterminated line/event for finite LLM streams; this
 * is an intentional EOF compatibility extension (EventSource drops an event that
 * was not terminated by a blank line).
 */
export class SseDecoder {
  private readonly onEvent: (event: SseEvent) => boolean | void
  private readonly maxBufferChars: number
  private lineBuffer = ''
  private eventName = ''
  private hasEventField = false
  private dataLines: string[] = []
  private dataFields = 0
  private eventDataChars = 0
  private sawFirstCharacter = false
  private skipNextLf = false
  private finished = false
  private isStopped = false

  constructor(onEvent: (event: SseEvent) => boolean | void, options: SseDecoderOptions = {}) {
    const maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS
    if (!Number.isSafeInteger(maxBufferChars) || maxBufferChars <= 0) {
      throw new RangeError(INVALID_LIMIT_MESSAGE)
    }
    this.onEvent = onEvent
    this.maxBufferChars = maxBufferChars
  }

  get stopped(): boolean {
    return this.isStopped
  }

  push(decodedText: string): void {
    if (this.isStopped || this.finished || decodedText.length === 0) return

    for (const character of decodedText) {
      if (!this.sawFirstCharacter) {
        this.sawFirstCharacter = true
        if (character === '\uFEFF') continue
      }

      if (this.skipNextLf) {
        this.skipNextLf = false
        if (character === '\n') continue
      }

      if (character === '\r') {
        this.consumeLine()
        if (this.isStopped) return
        this.skipNextLf = true
        continue
      }
      if (character === '\n') {
        this.consumeLine()
        if (this.isStopped) return
        continue
      }

      this.lineBuffer += character
      this.enforceBufferLimit()
    }
  }

  /** Flushes a final line and frame at EOF for finite LLM responses. */
  finish(): void {
    if (this.isStopped || this.finished) return
    this.finished = true
    if (this.lineBuffer.length > 0) this.consumeLine()
    if (!this.isStopped) this.dispatchEvent()
  }

  private consumeLine(): void {
    const line = this.lineBuffer
    this.lineBuffer = ''
    if (line.length === 0) {
      this.dispatchEvent()
      return
    }
    this.processLine(line)
  }

  private processLine(line: string): void {
    if (line.startsWith(':')) return

    const colonIndex = line.indexOf(':')
    const field = colonIndex < 0 ? line : line.slice(0, colonIndex)
    let value = colonIndex < 0 ? '' : line.slice(colonIndex + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') {
      if (this.dataFields > 0) this.eventDataChars++
      this.dataFields++
      this.eventDataChars += value.length
      this.dataLines.push(value)
      this.enforceBufferLimit()
    } else if (field === 'event') {
      this.eventName = value
      this.hasEventField = true
      this.enforceBufferLimit()
    }
    // id, retry and extension fields have no transport-side action.
  }

  private dispatchEvent(): void {
    if (this.dataFields === 0 && !this.hasEventField) {
      this.resetEvent()
      return
    }

    const event: SseEvent = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n')
    }
    this.resetEvent()
    if (this.onEvent(event) === false) this.isStopped = true
  }

  private resetEvent(): void {
    this.eventName = ''
    this.hasEventField = false
    this.dataLines = []
    this.dataFields = 0
    this.eventDataChars = 0
  }

  private enforceBufferLimit(): void {
    const bufferedChars = this.lineBuffer.length + this.eventDataChars + this.eventName.length
    if (bufferedChars > this.maxBufferChars) {
      this.isStopped = true
      throw new Error(BUFFER_LIMIT_MESSAGE)
    }
  }
}
