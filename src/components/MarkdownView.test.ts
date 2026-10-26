import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const { default: MarkdownView, TermText } = require('../../.render-test/markdown-view.cjs')

test('Markdown terms stay clickable in prose while inline and fenced code remain literal', () => {
  const markdown = [
    '说明 [[IPC]]，代码示例 `[[术语]]`，保留 **加粗**。',
    '', '```ts', 'const marker = "[[代码占位词]]"', '```',
    '', '> 引用 [[React]]', '', '| 术语 |', '| --- |', '| [[TypeScript]] |'
  ].join('\n')
  const html = renderToStaticMarkup(React.createElement(MarkdownView, { markdown, onTerm: () => undefined }))
  const dom = new JSDOM(html)
  assert.deepEqual([...dom.window.document.querySelectorAll('.term-link')].map((item) => item.textContent), ['IPC', 'React', 'TypeScript'])
  assert.equal(dom.window.document.querySelector('p code')?.textContent, '[[术语]]')
  assert.match(dom.window.document.querySelector('pre')?.textContent ?? '', /\[\[代码占位词\]\]/)
  assert.equal(dom.window.document.querySelectorAll('code .term-link, pre .term-link').length, 0)
  assert.equal(dom.window.document.querySelector('strong')?.textContent, '加粗')
  dom.window.close()
})

test('plain question titles protect single/double/unclosed backtick examples without changing their text', () => {
  const text = '说明 [[IPC]]，`[[术语]]`，``带 ` 的 [[例子]]``，[[React]]，`[[未闭合]]'
  const html = renderToStaticMarkup(React.createElement(TermText, { text, onTerm: () => undefined }))
  const dom = new JSDOM(html)
  assert.deepEqual([...dom.window.document.querySelectorAll('.term-link')].map((item) => item.textContent), ['IPC', 'React'])
  assert.equal(dom.window.document.body.textContent, text.replace('[[IPC]]', 'IPC').replace('[[React]]', 'React'))
  for (const term of dom.window.document.querySelectorAll('.term-link')) {
    assert.equal(term.getAttribute('role'), 'button')
    assert.equal(term.getAttribute('tabindex'), '0')
  }
  dom.window.close()
})
