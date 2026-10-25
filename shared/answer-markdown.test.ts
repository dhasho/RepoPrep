import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- direct Node tests use explicit TypeScript extensions.
import { formatAnswerMarkdown } from './answer-markdown.ts'

const textOnly = (text: string) => text.replace(/^\s*- /gm, '').replace(/\s+/gu, '')

test('multiple responsibilities become an indented list without changing words or punctuation', () => {
  const source = '应用职责分为三项：主模块读取输入；桥接模块校验参数；页面展示结果。所有模块共享数据契约。'
  const formatted = formatAnswerMarkdown(source)
  assert.match(formatted, /职责分为三项：\n\n- /)
  assert.equal((formatted.match(/\n- /g) ?? []).length, 3)
  assert.equal(textOnly(formatted), textOnly(source))
})

test('existing Markdown blocks and nested indentation stay byte-for-byte unchanged', () => {
  for (const source of [
    '先说明结论。\n\n- 主模块\n  - 校验参数\n  - 读取内容\n- 页面模块',
    '1. 读取\n2. 校验\n   1. 缺失字段\n   2. 非法类型',
    '```ts\nconst text = "第一；第二。"\nconsole.log(text)\n```',
    '~~~js\nconst text = "第一；第二。"\n~~~',
    '> 警告\n> 原内容',
    '| 名称 | 说明 |\n|---|---|\n|a|说明。|',
    '## 责任划分\n\n正文。'
  ]) assert.equal(formatAnswerMarkdown(source), source)
})

test('single-backtick code and marked terms protect their internal punctuation', () => {
  const source = '流程包含三项：读取 `source；still。同源`；核对 [[状态；机。]]；返回结果。'
  const formatted = formatAnswerMarkdown(source)
  assert.ok(formatted.includes('`source；still。同源`'))
  assert.ok(formatted.includes('[[状态；机。]]'))
  assert.equal((formatted.match(/\n- /g) ?? []).length, 3)
  assert.equal(textOnly(formatted), textOnly(source))
})

test('ambiguous inline Markdown, links and URLs are left intact', () => {
  const prefix = '说明包含多个职责：第一项负责读取；第二项负责校验；第三项负责显示。'
  for (const suffix of [
    '使用 ``literal；code。body`` 保留代码。',
    '说明见 [路径。说明](https://example.test/a；b)。',
    '说明见 https://example.test/路径。说明；details 。',
    '说明见 ![路径。说明](/image.png)。',
    '使用 **连续。加粗。内容** 表达。',
    '使用 _连续。强调。内容_ 表达。',
    '使用 <https://example.test/a；b> 表达。'
  ]) assert.equal(formatAnswerMarkdown(prefix + suffix), prefix + suffix)
})

test('unterminated protected spans do not cause partial formatting', () => {
  for (const source of ['职责：读取；校验；处理 `尚未结束。后续内容。', '职责：读取；校验；处理 [[尚未结束。后续内容。']) {
    assert.equal(formatAnswerMarkdown(source), source)
  }
})

test('long plain prose gets paragraph spacing while short answers remain simple', () => {
  const source = '第一部分负责读取输入并检查必需字段，只有满足条件才会继续处理，不会直接执行用户提供的代码。第二部分负责准备当前请求所需的数据，将读取失败与内容缺失分开记录，避免把缺失当作空内容。第三部分负责返回结构化结果，调用方可以独立决定如何展示错误和重试。'
  const formatted = formatAnswerMarkdown(source)
  assert.ok(formatted.includes('\n\n'))
  assert.ok(!formatted.includes('\n- '))
  assert.equal(textOnly(formatted), textOnly(source))
  assert.equal(formatAnswerMarkdown('读取失败时返回错误。'), '读取失败时返回错误。')
  assert.equal(formatAnswerMarkdown(''), '')
})
