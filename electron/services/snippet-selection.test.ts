import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { selectSourceRegions, sourceRegionCandidates } from './snippet-selection.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { analyzeSource } from './source-analysis.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { renderBatchWithinBudget, type ContextBatch } from './context-builder.ts'

test('structure selection keeps complete late and referenced units rather than the file head', () => {
  const content = `${'// front matter\n'.repeat(180)}function lateCore() { return 'late-core-marker' }\n`
  const start = content.indexOf('function lateCore')
  const analysis = {
    parseable: true,
    imports: [],
    symbols: [{ name: 'lateCore', kind: 'function' as const, start, end: content.length, exported: false }]
  }
  const picked = selectSourceRegions(content, analysis, 160, { referencedSymbols: new Set(['lateCore']) })
  assert.equal(picked.truncated, true)
  assert.ok(picked.regions.some((region) => region.text.includes('late-core-marker')))
  assert.ok(picked.regions.every((region) => region.complete))
})

test('class methods in later source positions remain independently selectable', () => {
  const content = `class Cache {\n${'  // filler\n'.repeat(120)}  saveRecord(value) { return value + 'save-marker' }\n}`
  const start = content.indexOf('  saveRecord')
  const end = content.indexOf('\n}', start)
  const analysis = {
    parseable: true,
    imports: [],
    symbols: [
      { name: 'Cache', kind: 'class' as const, start: 0, end: content.length, exported: true },
      { name: 'saveRecord', kind: 'method' as const, start, end, parentName: 'Cache', exported: false }
    ]
  }
  const picked = selectSourceRegions(content, analysis, 200, { referencedSymbols: new Set(['saveRecord']) })
  assert.ok(picked.regions.some((region) => region.text.includes('save-marker')))
})

test('actual TS analysis prioritizes intact late class methods from an oversized class', () => {
  const filler = '  noise: string = "x"\n'.repeat(240)
  const target = `  saveRecord(value: string) { return value + 'REAL_METHOD_MARKER' }\n`
  const content = `export class HugeCache {\n${filler}${target}}\n`
  const analysis = analyzeSource('src/cache.ts', content)
  assert.ok(analysis?.parseable)
  const selected = selectSourceRegions(content, analysis, 200, { referencedSymbols: new Set(['saveRecord']) })
  assert.ok(selected.regions.some((region) => region.complete && region.text.includes('REAL_METHOD_MARKER')))
  assert.ok(selected.regions.every((region) => region.text.length <= 200))
})

test('role focus can lift a matching handler over a later generic function', () => {
  const content = `function handleRequest() { return 'backend-marker' }\n${'// padding\n'.repeat(20)}function renderPage() { return 'frontend-marker' }\n`
  const analysis = analyzeSource('src/handlers.ts', content)
  assert.ok(analysis?.parseable)
  const backend = selectSourceRegions(content, analysis, 75, { roleFocus: 'backend' })
  assert.ok(backend.regions.some((region) => region.text.includes('backend-marker')))
})

test('Python fallback ignores def-shaped text inside triple quoted docstrings', () => {
  const content = `"""\ndef fake():\n    pass\n"""\n\ndef real_method():\n    return 'real-marker'\n`
  const picked = selectSourceRegions(content, null, 48, { extension: '.py' })
  assert.ok(picked.regions.some((region) => region.text.includes('real-marker')))
  assert.ok(picked.regions.every((region) => !region.text.includes('fake')))
})

test('Python triple quoted body lines do not terminate a complete function region', () => {
  const content = `def real_method():\n    """notes\nnot a top-level boundary\n"""\n    return 'METHOD_BODY_AFTER_DOCSTRING'\ndef later():\n    pass\n${'# padding\n'.repeat(24)}`
  const picked = selectSourceRegions(content, null, 130, { extension: '.py', referencedSymbols: new Set(['real_method']) })
  const method = picked.regions.find((region) => region.label === 'real_method')
  assert.ok(method?.complete)
  assert.ok(method.text.includes('METHOD_BODY_AFTER_DOCSTRING'))
})

test('Python multi-line def signatures keep the full body past the closing bracket', () => {
  const content = `async def worker(\n  item: str,\n):\n  result = (\n    item\n  )\n  return 'BODY_SENTINEL'\n\ndef sibling():\n  return 2\n`
  const picked = selectSourceRegions(content, null, 90, { extension: '.py', referencedSymbols: new Set(['worker']) })
  const worker = picked.regions.find((region) => region.label === 'worker')
  assert.ok(worker?.complete)
  assert.ok(worker.text.includes("return 'BODY_SENTINEL'"))
  assert.ok(!worker.text.includes('sibling'))
})

test('Python multiline class headers include the body past the closing bracket', () => {
  const content = `class Config(\n  a: int,\n  b: str = 'x',\n):\n  value = 'CLASS_BODY_MARKER'\n\ndef tail():\n  return 3\n`
  const picked = selectSourceRegions(content, null, 80, { extension: '.py', referencedSymbols: new Set(['Config']) })
  const config = picked.regions.find((region) => region.label === 'Config')
  assert.ok(config?.complete)
  assert.ok(config.text.includes('CLASS_BODY_MARKER'))
  assert.ok(!config.text.includes('tail'))
})

test('Python brackets inside comments and strings do not bound function regions', () => {
  const content = `def brackets():\n  x = (  # ( fake open\n  'str ( nested ('\n  )\n  return 'BRACKET_BODY'\n\ndef tail():\n  return 4\n`
  const picked = selectSourceRegions(content, null, 90, { extension: '.py', referencedSymbols: new Set(['brackets']) })
  const fn = picked.regions.find((region) => region.label === 'brackets')
  assert.ok(fn?.complete)
  assert.ok(fn.text.includes('BRACKET_BODY'))
  assert.ok(!fn.text.includes('tail'))
})

test('Python backslash continuation keeps wrapped signatures one logical statement', () => {
  const content = `def wrapped(a, \\\n      b):\n  return 'WRAPPED_MARKER'\n\ndef tail():\n  return 5\n`
  const picked = selectSourceRegions(content, null, 60, { extension: '.py', referencedSymbols: new Set(['wrapped']) })
  const wrapped = picked.regions.find((region) => region.label === 'wrapped')
  assert.ok(wrapped?.complete)
  assert.ok(wrapped.text.includes('WRAPPED_MARKER'))
  assert.ok(!wrapped.text.includes('tail'))
})

test('Python headers left open at EOF stay partial instead of claiming a complete body', () => {
  const content = `def opened(\n  x,\n\nother = 'TAIL_SENTINEL'\n`
  const candidates = sourceRegionCandidates(content, null, { extension: '.py' })
  const opened = candidates.find((region) => region.label === 'opened')
  assert.ok(opened)
  assert.equal(opened.complete, false)
})

test('Python decorator blocks start their region and never leak into the previous sibling', () => {
  const padding = '# module padding\n'.repeat(20)
  const content = `${padding}def plain():\n  return 'PLAIN_BODY'\n\n@retry(times=3)\n@app.route('/x')\ndef handler():\n  return 'HANDLER_BODY'\n\ndef tail():\n  return 'TAIL_BODY'\n`
  const picked = selectSourceRegions(content, null, 200, { extension: '.py', referencedSymbols: new Set(['plain', 'handler', 'tail']) })
  const plain = picked.regions.find((region) => region.label === 'plain')
  const handler = picked.regions.find((region) => region.label === 'handler')
  const tail = picked.regions.find((region) => region.label === 'tail')
  assert.ok(plain && handler && tail, 'all three declarations stay independently selectable')
  assert.ok(plain.complete)
  assert.ok(plain.text.includes('PLAIN_BODY'))
  assert.ok(!plain.text.includes('@retry'), 'the previous sibling must not swallow the next decorator block')
  assert.ok(handler.complete)
  assert.ok(handler.text.includes('@retry(times=3)'))
  assert.ok(handler.text.includes("@app.route('/x')"))
  assert.ok(handler.text.includes('HANDLER_BODY'))
  assert.ok(!handler.text.includes('def plain'))
  assert.ok(!handler.text.includes('def tail'))
  assert.ok(tail.complete)
  assert.ok(tail.text.includes('TAIL_BODY'))
  assert.ok(!tail.text.includes('@'), 'an undecorated sibling starts at its own def line')
})

test('Python multi-line decorator calls and async methods keep decorators inside one region', () => {
  const content = `class Service:\n  @cache(\n    maxsize=8,\n  )\n  @route('/x')\n  async def fetch(self):\n    return 'FETCH_BODY'\n`
  const candidates = sourceRegionCandidates(content, null, { extension: '.py' })
  const fetch = candidates.find((region) => region.label === 'fetch')
  const service = candidates.find((region) => region.label === 'Service')
  assert.ok(fetch && service)
  assert.ok(fetch.complete)
  assert.ok(fetch.text.trimStart().startsWith('@cache('), 'the region starts at the first decorator of the block')
  assert.ok(fetch.text.includes('maxsize=8'))
  assert.ok(fetch.text.includes("@route('/x')"))
  assert.ok(fetch.text.includes('async def fetch'))
  assert.ok(fetch.text.includes('FETCH_BODY'))
  assert.ok(service.complete)
  assert.ok(service.text.startsWith('class Service:'))
})

test('Python decorator-shaped text in comments and docstrings never starts or attaches a region', () => {
  const content = `# @ghost_dec\ndef plain():\n  return 'PLAIN_BODY'\n\ndef holder():\n  \"\"\"\n  @ghost2\n  def ghost():\n  \"\"\"\n  return 'HOLDER_BODY'\n\ndef tail():\n  return 'TAIL_BODY'\n`
  const candidates = sourceRegionCandidates(content, null, { extension: '.py' })
  const plain = candidates.find((region) => region.label === 'plain')
  const holder = candidates.find((region) => region.label === 'holder')
  const tail = candidates.find((region) => region.label === 'tail')
  assert.ok(plain && holder && tail)
  assert.ok(!candidates.some((region) => region.label === 'ghost'))
  assert.ok(!plain.text.includes('@ghost_dec'), 'a commented-out decorator does not become the region start')
  assert.ok(holder.text.startsWith('def holder():'))
  assert.ok(holder.complete)
  assert.ok(holder.text.includes('HOLDER_BODY'))
  assert.ok(!tail.text.includes('@ghost2'), 'a docstring decorator cannot attach to a later sibling')
  assert.ok(tail.text.includes('TAIL_BODY'))
})

test('Python unclosed bracket bodies at EOF leave the trailing region partial', () => {
  const content = `def fine():\n  return 'FINE_BODY'\n\ndef last():\n  data = [\n`
  const candidates = sourceRegionCandidates(content, null, { extension: '.py' })
  const fine = candidates.find((region) => region.label === 'fine')
  const last = candidates.find((region) => region.label === 'last')
  assert.ok(fine && last)
  assert.equal(fine.complete, true)
  assert.ok(last.text.includes('data = ['))
  assert.equal(last.complete, false)
})

test('tiny budgets remain bounded even when the fallback marker is longer than the budget', () => {
  const source = '😀'.repeat(60)
  for (const budget of [0, 1, 8, 12]) {
    const selected = selectSourceRegions(source, null, budget, { extension: '.unknown' })
    assert.ok(selected.regions.every((region) => region.text.length <= budget))
    assert.ok(selected.regions.every((region) => !/^[\uDC00-\uDFFF]/.test(region.text)))
    assert.ok(selected.regions.every((region) => !/[\uD800-\uDBFF]$/.test(region.text)))
  }
})

test('final prompt fitting keeps complete selected regions and drops the rest', () => {
  const region = { start: 120, end: 190, text: 'function keepThis() { return "complete-marker" }', label: 'keepThis', complete: true, priority: 50 }
  const batch: ContextBatch = {
    label: 'module', kind: 'module', weight: 1, totalChars: 0,
    files: [{ relPath: 'src/core.ts', content: `${region.text}\n${'filler'.repeat(60)}`, truncated: true, redacted: false, redactionMatches: 0, selectionRegions: [region] }]
  }
  const first = renderBatchWithinBudget('header', 'tree', batch, 1_000)
  assert.equal(first.truncated, false)
  assert.deepEqual(first.selection, { filePaths: ['src/core.ts'], selectedRegions: 1, providedChars: batch.files[0].content.length })
  const tightened = renderBatchWithinBudget('header'.repeat(30), 'tree', batch, 320)
  assert.equal(tightened.truncated, true)
  assert.ok(tightened.text.includes('complete-marker'))
  assert.ok(tightened.text.includes('```'))
  assert.deepEqual(tightened.selection, { filePaths: ['src/core.ts'], selectedRegions: 1, providedChars: region.text.length })
})

test('final fitting keeps bounded head and tail excerpts for documents but never slices code', () => {
  const document = {
    relPath: 'README.md', content: `README-IMPORTANT-START\n${'x'.repeat(600)}\nREADME_KEEP_END`,
    truncated: false, redacted: false, redactionMatches: 0
  }
  const batch: ContextBatch = { label: 'overview', kind: 'global', weight: 1, totalChars: 0, files: [document] }
  const rendered = renderBatchWithinBudget('header', 'tree', batch, 180)
  assert.ok(rendered.truncated)
  assert.ok(rendered.text.includes('README-IMPORTANT-START'))
  assert.ok(rendered.text.includes('README_KEEP_END'))
  assert.ok(rendered.text.includes('文档片段已截断'))
  assert.ok(rendered.text.length <= 180)
  assert.deepEqual(rendered.selection, { filePaths: ['README.md'], selectedRegions: 1, providedChars: documentExcerptLength(rendered.text) })

  const codeBatch: ContextBatch = {
    ...batch, files: [{ ...document, relPath: 'src/core.ts', content: 'function doNotCut() { return "body" }'.repeat(40) }]
  }
  const code = renderBatchWithinBudget('header', 'tree', codeBatch, 180)
  assert.ok(code.truncated)
  assert.ok(!code.text.includes('doNotCut'))
  assert.deepEqual(code.selection, { filePaths: [], selectedRegions: 0, providedChars: 0 })
})

function documentExcerptLength(rendered: string): number {
  const match = rendered.match(/### 文件：README\.md（内容过长已截断）\n```\n([\s\S]*?)\n```/)
  return match?.[1]?.length ?? -1
}
