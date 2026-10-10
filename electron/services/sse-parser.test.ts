import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
// @ts-ignore Node 24 direct TypeScript tests require the runtime .ts suffix.
import { SseDecoder } from './sse-parser.ts'

const fixture = (name: string): URL => new URL(`../../tests/fixtures/llm-sse/${name}`, import.meta.url)

function decode(chunks: readonly string[]) {
  const events: Array<{ event: string; data: string }> = []
  const decoder = new SseDecoder((event) => { events.push(event) })
  for (const chunk of chunks) decoder.push(chunk)
  decoder.finish()
  return { events, decoder }
}

test('parses fields, comments, exact case, first-colon values and one-space stripping', () => {
  const { events } = decode([
    '\uFEFF: initial comment\r\n',
    'event: error\r',
    'id: ignored-id\r',
    'retry: 4000\r',
    'Data: ignored uppercase field\r',
    'data: first: colon\r',
    'data:  two leading spaces\r',
    'data:\r\n\r\n',
    'Event: ignored uppercase field\n\n',
    'data: later\n\n'
  ])
  assert.deepEqual(events, [
    { event: 'error', data: 'first: colon\n two leading spaces\n' },
    { event: 'message', data: 'later' }
  ])
})

test('empty frames and comment-only frames do not emit events', () => {
  const { events } = decode(['\n\r\n: comment\r\n\r\n'])
  assert.deepEqual(events, [])
})

test('metadata-only named event emits, including event:error with empty data', () => {
  const { events } = decode(['event:error\n\n'])
  assert.deepEqual(events, [{ event: 'error', data: '' }])
})

test('all two-chunk cut points preserve CR, LF, CRLF and Unicode framing', () => {
  const source = '\uFEFF:ignore\r\nevent: note\rdata: 你好，世界 ✨\r\ndata: line2\n\n'
  const expected = [{ event: 'note', data: '你好，世界 ✨\nline2' }]
  for (let cut = 0; cut <= source.length; cut++) {
    assert.deepEqual(decode([source.slice(0, cut), source.slice(cut)]).events, expected, `cut at UTF-16 index ${cut}`)
  }
  assert.deepEqual(decode([...source]).events, expected, 'one Unicode code point per push')
  assert.deepEqual(decode(source.split('')).events, expected, 'one UTF-16 code unit per push')
})

test('BOM is removed only at stream start', () => {
  const { events } = decode(['\uFEFFdata: before\n\ndata: after\uFEFFinside\n\n'])
  assert.deepEqual(events, [
    { event: 'message', data: 'before' },
    { event: 'message', data: 'after\uFEFFinside' }
  ])
})

test('callback false stops the decoder and discards all later input', () => {
  const events: Array<{ event: string; data: string }> = []
  const decoder = new SseDecoder((event) => {
    events.push(event)
    return false
  })
  decoder.push('data: first\n\ndata: second\n\n')
  decoder.push('data: later\n\n')
  decoder.finish()
  assert.deepEqual(events, [{ event: 'message', data: 'first' }])
  assert.equal(decoder.stopped, true)
})

test('finish flushes final line and event, but finish after stop is a no-op', () => {
  const events: Array<{ event: string; data: string }> = []
  const stopped = new SseDecoder(() => false)
  stopped.push('data: stop\n\n')
  stopped.finish()
  assert.equal(stopped.stopped, true)

  const { events: tailEvents, decoder } = decode(['event: update\ndata: tail without newline'])
  assert.deepEqual(tailEvents, [{ event: 'update', data: 'tail without newline' }])
  decoder.push('data: after-finish\n\n')
  decoder.finish()
  assert.equal(tailEvents.length, 1)
})

test('buffer cap covers incomplete line and accumulated event data with a static error', () => {
  const lineDecoder = new SseDecoder(() => undefined, { maxBufferChars: 8 })
  assert.throws(() => lineDecoder.push('data: external value'), {
    message: 'SSE stream exceeds the configured buffer limit.'
  })
  assert.equal(lineDecoder.stopped, true)
  assert.doesNotThrow(() => lineDecoder.finish())

  const eventDecoder = new SseDecoder(() => undefined, { maxBufferChars: 10 })
  eventDecoder.push('data: ab\n')
  eventDecoder.push('data: cd\n')
  assert.throws(() => eventDecoder.push('data: x'), {
    message: 'SSE stream exceeds the configured buffer limit.'
  })
  assert.equal(eventDecoder.stopped, true)
})

test('rejects invalid buffer limits with a static error', () => {
  for (const maxBufferChars of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new SseDecoder(() => undefined, { maxBufferChars }), {
      message: 'SSE buffer limit must be a positive integer.'
    })
  }
})

test('OpenAI-style fixture covers role, content, stop, usage-only chunk and DONE', async () => {
  const text = await readFile(fixture('openai-chat.sse'), 'utf8')
  const { events } = decode([text])
  const payloads = events.map((event) => event.data)
  const chunks = payloads.filter((data) => data !== '[DONE]').map((data) => JSON.parse(data))
  const deltas = chunks.flatMap((chunk) => chunk.choices.map((choice: { delta?: { role?: string; content?: string } }) => choice.delta ?? {}))
  assert.equal(deltas[0].role, 'assistant')
  assert.equal(deltas.map((delta) => delta.content ?? '').join(''), 'Hello世界')
  assert.equal(chunks[3].choices[0].finish_reason, 'stop')
  assert.deepEqual(chunks[4].choices, [])
  assert.equal(chunks[4].usage.total_tokens, 4)
  assert.equal(payloads.at(-1), '[DONE]')
})

test('compatible multiline fixture joins data fields before JSON parsing', async () => {
  const text = await readFile(fixture('compatible-multiline.sse'), 'utf8')
  const { events } = decode([text])
  assert.equal(events.length, 1)
  const payload = JSON.parse(events[0].data)
  assert.equal(payload.choices[0].delta.content, '你好，世界 ✨')
  assert.equal(payload.choices[0].finish_reason, 'stop')
})

test('tail fixture has no final newline and finish flushes content plus stop reason', async () => {
  const text = await readFile(fixture('finish-stop-tail.sse'), 'utf8')
  assert.equal(/[\r\n]$/.test(text), false)
  const { events } = decode([text])
  assert.equal(events.length, 1)
  const payload = JSON.parse(events[0].data)
  assert.equal(payload.choices[0].delta.content, '尾部✨')
  assert.equal(payload.choices[0].finish_reason, 'stop')
})

test('error fixture emits its explicit event type and preserves its data payload', async () => {
  const text = await readFile(fixture('error-event.sse'), 'utf8')
  const { events } = decode([text])
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'error')
  assert.match(events[0].data, /sk-fake-not-a-real-key/)
})

test('interrupted fixture contains partial text but no completion signal', async () => {
  const text = await readFile(fixture('interrupted.sse'), 'utf8')
  const { events } = decode([text])
  const chunk = JSON.parse(events[0].data)
  assert.equal(chunk.choices[0].delta.content, '部分输出')
  assert.equal(chunk.choices[0].finish_reason, null)
  assert.equal(events.some((event) => event.data === '[DONE]'), false)
})
