import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
// @ts-ignore TS5097 -- direct Node test runner.
import { readReportSelection, selectReportText, copyReportSelection } from './report-selection.ts'

function fixture() {
  const dom = new JSDOM('<aside>private sidebar</aside><article><section data-report-question="2"><p>shared 契约分层</p></section><section data-report-question="3"><p>other question</p></section><textarea>form value</textarea></article>')
  const root = dom.window.document.querySelector('article')!
  const select = (start: Node, end = start) => {
    const range = dom.window.document.createRange()
    range.setStart(start, 0)
    range.setEnd(end, end.textContent!.length)
    const selection = dom.window.document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return { dom, root, select }
}

test('report selection captures exact text and containing question, and rejects outside or editable selections', () => {
  const { dom, root, select } = fixture()
  const node = root.querySelector('p')!.firstChild!
  select(node)
  const selected = readReportSelection(root, { x: 20, y: 30 })!
  assert.equal(selected.text, 'shared 契约分层')
  assert.equal(selected.questionIndex, 2)
  assert.equal(selected.anchor.left, 20)
  select(dom.window.document.querySelector('aside')!.firstChild!)
  assert.equal(readReportSelection(root), null)
  select(dom.window.document.querySelector('aside')!.firstChild!, node)
  assert.equal(readReportSelection(root), null, 'crossing the report boundary is not model input')
  select(root.querySelector('textarea')!.firstChild!)
  assert.equal(readReportSelection(root), null)
  select(node, root.querySelectorAll('p')[1].firstChild!)
  assert.equal(readReportSelection(root)?.questionIndex, null, 'cross-question selection uses report context')
  dom.window.close()
})

test('select all stays inside the report and copy writes only the captured text', async () => {
  const { dom, root } = fixture()
  const selected = selectReportText(root)!
  assert.ok(selected.text.includes('shared 契约分层'))
  assert.ok(!selected.text.includes('private sidebar'))
  const copied: string[] = []
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  assert.equal(await copyReportSelection(root, selected), true)
  assert.deepEqual(copied, [selected.text])
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
  Object.defineProperty(dom.window.document, 'execCommand', { configurable: true, value: (command: string) => command === 'copy' })
  assert.equal(await copyReportSelection(root, selected), true, 'denied Clipboard API uses the still-owned native selection')
  dom.window.close()
})

test('selected code keeps its indentation and trailing line breaks for Copy and AI context', () => {
  const { dom, root, select } = fixture()
  const paragraph = root.querySelector('p')!
  paragraph.textContent = '    return value\n'
  select(paragraph.firstChild!)
  assert.equal(readReportSelection(root)?.text, '    return value\n')
  dom.window.close()
})
