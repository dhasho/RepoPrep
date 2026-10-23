import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { selectSourceRegions } from './snippet-selection.ts'
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
  const tightened = renderBatchWithinBudget('header'.repeat(30), 'tree', batch, 320)
  assert.equal(tightened.truncated, true)
  assert.ok(tightened.text.includes('complete-marker'))
  assert.ok(tightened.text.includes('```'))
})
