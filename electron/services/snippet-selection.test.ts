import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { compactRegionDocumentation, formatSourceRegions, selectSourceRegions, sourceRegionCandidates } from './snippet-selection.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { analyzeSource } from './source-analysis.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { renderBatch, renderBatchWithinBudget, type ContextBatch } from './context-builder.ts'

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

test('JavaScript method regions retain distinct class owners for duplicate method names', () => {
  const content = `class Request {\n  prepare() { return 'REQUEST_PREPARE' }\n}\nclass PreparedRequest {\n  prepare() { return 'PREPARED_PREPARE' }\n}\n`
  const analysis = analyzeSource('src/models.ts', content)
  assert.ok(analysis?.parseable)
  const methods = sourceRegionCandidates(content, analysis).filter((region) => region.label === 'prepare')
  assert.deepEqual(methods.map((region) => region.qualifiedName).sort(), ['PreparedRequest.prepare', 'Request.prepare'])
})

test('Python regions retain nested class and function scopes', () => {
  const content = `def factory():\n    class Outer:\n        class Inner:\n            def run(self):\n                return 'NESTED_RUN'\n        def create(self):\n            return Inner()\n    def helper():\n        return 1\n`
  const regions = sourceRegionCandidates(content, null, { extension: 'py' })
  assert.equal(regions.find((region) => region.label === 'run')?.qualifiedName, 'factory.Outer.Inner.run')
  assert.equal(regions.find((region) => region.label === 'create')?.qualifiedName, 'factory.Outer.create')
  assert.equal(regions.find((region) => region.label === 'helper')?.qualifiedName, 'factory.helper')
})

test('direct local calls use source identities and keep same-named class methods separate', () => {
  const tsSource = `class Alpha {\n  invoke() { return this.parse() }\n  parse() { return 'ALPHA' }\n}\nclass Beta {\n  invoke() { return this.other() }\n  parse() { return 'BETA' }\n  other() { return 'OTHER' }\n}\n`
  const tsAnalysis = analyzeSource('src/flow.ts', tsSource)
  assert.ok(tsAnalysis?.parseable)
  const tsRegions = sourceRegionCandidates(tsSource, tsAnalysis, { extension: 'ts' })
  const alphaStart = tsSource.indexOf('invoke()')
  const betaStart = tsSource.indexOf('invoke()', alphaStart + 1)
  const alphaInvoke = tsRegions.find((region) => region.start === alphaStart)
  const betaInvoke = tsRegions.find((region) => region.start === betaStart)
  const alphaParse = tsRegions.find((region) => region.label === 'parse' && region.qualifiedName === 'Alpha.parse')
  const betaParse = tsRegions.find((region) => region.label === 'parse' && region.qualifiedName === 'Beta.parse')
  const betaOther = tsRegions.find((region) => region.label === 'other' && region.qualifiedName === 'Beta.other')
  assert.ok(alphaInvoke && betaInvoke && alphaParse && betaParse && betaOther)
  assert.ok(alphaInvoke.calledDeclarationStarts?.includes(alphaParse.start))
  assert.ok(betaInvoke.calledDeclarationStarts?.includes(betaOther.start))
  assert.ok(!betaInvoke.calledDeclarationStarts?.includes(betaParse.start))

  const pySource = `class Alpha:\n    def invoke(self):\n        return self.parse()\n    def parse(self):\n        return 'ALPHA'\nclass Beta:\n    def invoke(self):\n        return self.other()\n    def parse(self):\n        return 'BETA'\n    def other(self):\n        return 'OTHER'\n`
  const pyRegions = sourceRegionCandidates(pySource, null, { extension: 'py' })
  const pyAlphaInvoke = pyRegions.find((region) => region.label === 'invoke' && region.qualifiedName === 'Alpha.invoke')
  const pyBetaInvoke = pyRegions.find((region) => region.label === 'invoke' && region.qualifiedName === 'Beta.invoke')
  const pyAlphaParse = pyRegions.find((region) => region.label === 'parse' && region.qualifiedName === 'Alpha.parse')
  const pyBetaParse = pyRegions.find((region) => region.label === 'parse' && region.qualifiedName === 'Beta.parse')
  const pyBetaOther = pyRegions.find((region) => region.label === 'other' && region.qualifiedName === 'Beta.other')
  assert.ok(pyAlphaInvoke && pyBetaInvoke && pyAlphaParse && pyBetaParse && pyBetaOther)
  assert.ok(pyAlphaInvoke.calledDeclarationStarts?.includes(pyAlphaParse.start))
  assert.ok(pyBetaInvoke.calledDeclarationStarts?.includes(pyBetaOther.start))
  assert.ok(!pyBetaInvoke.calledDeclarationStarts?.includes(pyBetaParse.start))
})

test('bare calls resolve only to a unique same-file declaration', () => {
  const tsSource = `function caller() { return helper() }\nfunction shadowedCaller(helper: () => number) { return helper() }\nfunction helper() { return 1 }\nfunction ambiguousCaller() { return duplicate() }\nfunction duplicate() { return 1 }\nfunction duplicate() { return 2 }\n`
  const tsAnalysis = analyzeSource('src/flow.ts', tsSource)
  assert.ok(tsAnalysis?.parseable)
  const tsRegions = sourceRegionCandidates(tsSource, tsAnalysis, { extension: 'ts' })
  const tsCaller = tsRegions.find((region) => region.label === 'caller')
  const tsShadowedCaller = tsRegions.find((region) => region.label === 'shadowedCaller')
  const tsHelper = tsRegions.find((region) => region.label === 'helper')
  const tsAmbiguousCaller = tsRegions.find((region) => region.label === 'ambiguousCaller')
  const tsDuplicates = tsRegions.filter((region) => region.label === 'duplicate')
  assert.ok(tsCaller && tsShadowedCaller && tsHelper && tsAmbiguousCaller)
  assert.deepEqual(tsCaller.calledDeclarationStarts, [tsHelper.start])
  assert.equal(tsShadowedCaller.calledDeclarationStarts?.length ?? 0, 0)
  assert.equal(tsDuplicates.length, 2)
  assert.equal(tsAmbiguousCaller.calledDeclarationStarts?.length ?? 0, 0)

  const pySource = `def caller():\n    return helper()\ndef helper():\n    return 1\ndef ambiguous_caller():\n    return duplicate()\ndef duplicate():\n    return 1\ndef duplicate():\n    return 2\n`
  const pyRegions = sourceRegionCandidates(pySource, null, { extension: 'py' })
  const pyCaller = pyRegions.find((region) => region.label === 'caller')
  const pyHelper = pyRegions.find((region) => region.label === 'helper')
  const pyAmbiguousCaller = pyRegions.find((region) => region.label === 'ambiguous_caller')
  assert.ok(pyCaller && pyHelper && pyAmbiguousCaller)
  assert.deepEqual(pyCaller.calledDeclarationStarts, [pyHelper.start])
  assert.equal(pyAmbiguousCaller.calledDeclarationStarts?.length ?? 0, 0)

  const pyMembers = `def foo():\n    return 'module'\nclass Thing:\n    def call_member(self):\n        return self.foo()\n    def foo(self):\n        return 'member'\n    def call_bare(self):\n        return foo()\n`
  const pyMemberRegions = sourceRegionCandidates(pyMembers, null, { extension: 'py' })
  const pyCallMember = pyMemberRegions.find((region) => region.qualifiedName === 'Thing.call_member')
  const pyMemberFoo = pyMemberRegions.find((region) => region.qualifiedName === 'Thing.foo')
  const pyCallBare = pyMemberRegions.find((region) => region.qualifiedName === 'Thing.call_bare')
  const pyModuleFoo = pyMemberRegions.find((region) => region.qualifiedName === 'foo')
  assert.ok(pyCallMember && pyMemberFoo && pyCallBare && pyModuleFoo)
  assert.deepEqual(pyCallMember.calledDeclarationStarts, [pyMemberFoo.start])
  assert.deepEqual(pyCallBare.calledDeclarationStarts, [pyModuleFoo.start])
})

test('Python direct call targets follow first lexical bare/member call order in either direction', () => {
  const sources = [
    `def begin():\n    return 1\nclass Workflow:\n    def finish(self):\n        return 2\n    def run(self):\n        begin()\n        self.finish()\n`,
    `def begin():\n    return 1\nclass Workflow:\n    def finish(self):\n        return 2\n    def run(self):\n        self.finish()\n        begin()\n`
  ]
  for (const [index, content] of sources.entries()) {
    const regions = sourceRegionCandidates(content, null, { extension: 'py' })
    const caller = regions.find((region) => region.qualifiedName === 'Workflow.run')
    const begin = regions.find((region) => region.qualifiedName === 'begin')
    const finish = regions.find((region) => region.qualifiedName === 'Workflow.finish')
    assert.ok(caller && begin && finish)
    assert.deepEqual(caller.calledDeclarationStarts, index === 0 ? [begin.start, finish.start] : [finish.start, begin.start])
  }
})

test('Python same-named bare and member calls stay distinct and deduplicate targets by first appearance', () => {
  const content = `def shared():\n    return 'MODULE'\nclass Worker:\n    def shared(self):\n        return 'MEMBER'\n    def run(self):\n        shared()\n        self.shared()\n        shared()\n`
  const regions = sourceRegionCandidates(content, null, { extension: 'py' })
  const caller = regions.find((region) => region.qualifiedName === 'Worker.run')
  const module = regions.find((region) => region.qualifiedName === 'shared')
  const member = regions.find((region) => region.qualifiedName === 'Worker.shared')
  assert.ok(caller && module && member)
  assert.deepEqual(caller.calledDeclarationStarts, [module.start, member.start])
})

test('Python direct call graph keeps the first eight unique targets per caller', () => {
  const calls = Array.from({ length: 10 }, (_, index) => `        self.target_${index}()`).join('\n')
  const content = `class Worker:\n    def run(self):\n${calls}\n${Array.from({ length: 10 }, (_, index) => `    def target_${index}(self):\n        return ${index}\n`).join('')}`
  const regions = sourceRegionCandidates(content, null, { extension: 'py' })
  const caller = regions.find((region) => region.qualifiedName === 'Worker.run')
  const targets = Array.from({ length: 10 }, (_, index) => regions.find((region) => region.qualifiedName === `Worker.target_${index}`))
  assert.ok(caller && targets.every(Boolean))
  assert.deepEqual(caller.calledDeclarationStarts, targets.slice(0, 8).map((target) => target!.start))
})

test('Python direct call graph enforces the global 1024 edge budget exactly', () => {
  const callers = [
    `def caller_0():\n    target_0()\n`,
    ...Array.from({ length: 128 }, (_, index) => `def caller_${index + 1}():\n${Array.from({ length: 8 }, (_, target) => `    target_${target}()\n`).join('')}`)
  ].join('')
  const targets = Array.from({ length: 8 }, (_, index) => `def target_${index}():\n    return ${index}\n`).join('')
  const regions = sourceRegionCandidates(`${callers}${targets}`, null, { extension: 'py' })
  const callerRegions = Array.from({ length: 129 }, (_, index) => regions.find((region) => region.label === `caller_${index}`))
  assert.ok(callerRegions.every(Boolean))
  assert.equal(callerRegions.reduce((total, caller) => total + (caller?.calledDeclarationStarts?.length ?? 0), 0), 1024)
  assert.equal(callerRegions[128]?.calledDeclarationStarts?.length, 7)
})

test('this calls inside nested ordinary functions are not attributed to the outer method', () => {
  const content = `class Runner {\n  run() {\n    function nested() { return this.finish() }\n    return nested()\n  }\n  finish() { return 1 }\n}\n`
  const analysis = analyzeSource('src/runner.ts', content)
  assert.ok(analysis?.parseable)
  const regions = sourceRegionCandidates(content, analysis, { extension: 'ts' })
  const run = regions.find((region) => region.qualifiedName === 'Runner.run')
  const finish = regions.find((region) => region.qualifiedName === 'Runner.finish')
  assert.ok(run && finish)
  assert.equal(Boolean(run.calledDeclarationStarts?.includes(finish.start)), false)
})

test('constructor calls skip parameter shadowing and resolve an unshadowed local class', () => {
  const content = `class Helper {}\nfunction shadowed(Helper: new () => unknown) { return new Helper() }\nfunction unshadowed() { return new Helper() }\nfunction topLevelThis() { return this.Helper() }\n`
  const analysis = analyzeSource('src/factory.ts', content)
  assert.ok(analysis?.parseable)
  const regions = sourceRegionCandidates(content, analysis, { extension: 'ts' })
  const helper = regions.find((region) => region.label === 'Helper')
  const shadowed = regions.find((region) => region.label === 'shadowed')
  const unshadowed = regions.find((region) => region.label === 'unshadowed')
  const topLevelThis = regions.find((region) => region.label === 'topLevelThis')
  assert.ok(helper && shadowed && unshadowed && topLevelThis)
  assert.equal(shadowed.calledDeclarationStarts?.length ?? 0, 0)
  assert.deepEqual(unshadowed.calledDeclarationStarts, [helper.start])
  assert.equal(topLevelThis.calledDeclarationStarts?.length ?? 0, 0)
})

test('source selection uses the updated callee priority ordering', () => {
  const largeMiddle = `function middle() {\n${'  const value = 1\n'.repeat(16)}  return value\n}\n`
  const content = `function helper() { return 'CALLEE' }\n${largeMiddle}function caller() {\n${'  const value = 1\n'.repeat(16)}  return helper()\n}\n`
  const analysis = analyzeSource('src/flow.ts', content)
  assert.ok(analysis?.parseable)
  const candidates = sourceRegionCandidates(content, analysis, { referencedSymbols: new Set(['caller']), extension: 'ts' })
  const helper = candidates.find((region) => region.label === 'helper')
  const middle = candidates.find((region) => region.label === 'middle')
  const caller = candidates.find((region) => region.label === 'caller')
  assert.ok(helper && middle && caller)
  assert.ok(helper.priority > middle.priority)
  const budget = caller.text.length + middle.text.length + 25
  const picked = selectSourceRegions(content, analysis, budget, { referencedSymbols: new Set(['caller']), extension: 'ts' })
  assert.ok(picked.regions.some((region) => region.label === 'caller'))
  assert.ok(picked.regions.some((region) => region.label === 'helper'))
  assert.ok(!picked.regions.some((region) => region.label === 'middle'))
})

test('final fitting keeps TS and Python method owners within budget while whole files stay byte-identical', () => {
  const tsFiller = '  cached: string = "filler-value"\n'.repeat(100)
  const tsSource = `class Request {\n${tsFiller}  prepare() { return 'REQUEST_PREPARE' }\n}\nclass PreparedRequest {\n${tsFiller}  prepare() { return 'PREPARED_PREPARE' }\n}\n`
  const tsAnalysis = analyzeSource('src/models.ts', tsSource)
  assert.ok(tsAnalysis?.parseable)
  const tsCandidates = sourceRegionCandidates(tsSource, tsAnalysis, { extension: 'ts' })
  const tsBatch: ContextBatch = {
    label: 'global', kind: 'global', weight: 1, totalChars: tsSource.length,
    files: [{ relPath: 'src/models.ts', content: tsSource, truncated: false, redacted: false, redactionMatches: 0, selectionCandidates: tsCandidates }]
  }
  const tsBase = renderBatchWithinBudget('header', 'tree', { ...tsBatch, files: [] }, 10_000).text
  const tsMaxChars = tsBase.length + 500
  assert.ok(renderBatch('header', 'tree', tsBatch).length > tsMaxChars, 'the full request must exceed the final-fit limit')
  const tsFitted = renderBatchWithinBudget('header', 'tree', tsBatch, tsMaxChars)
  assert.equal(tsFitted.truncated, true)
  assert.ok(tsFitted.text.length <= tsMaxChars)
  assert.ok(tsFitted.text.includes('// 代码单元：Request.prepare'))
  assert.ok(tsFitted.text.includes('// 代码单元：PreparedRequest.prepare'))

  const pyFiller = '    cached = "filler-value"\n'.repeat(100)
  const pySource = `class Request:\n${pyFiller}    def prepare(self):\n        return 'REQUEST_PREPARE'\nclass PreparedRequest:\n${pyFiller}    def prepare(self):\n        return 'PREPARED_PREPARE'\n`
  const pyCandidates = sourceRegionCandidates(pySource, null, { extension: 'py' })
  const pyBatch: ContextBatch = {
    label: 'global', kind: 'global', weight: 1, totalChars: pySource.length,
    files: [{ relPath: 'src/models.py', content: pySource, truncated: false, redacted: false, redactionMatches: 0, selectionCandidates: pyCandidates }]
  }
  const pyBase = renderBatchWithinBudget('header', 'tree', { ...pyBatch, files: [] }, 10_000).text
  const pyMaxChars = pyBase.length + 500
  assert.ok(renderBatch('header', 'tree', pyBatch).length > pyMaxChars, 'the full Python request must exceed the final-fit limit')
  const pyFitted = renderBatchWithinBudget('header', 'tree', pyBatch, pyMaxChars)
  assert.equal(pyFitted.truncated, true)
  assert.ok(pyFitted.text.length <= pyMaxChars)
  assert.ok(pyFitted.text.includes('# 代码单元：Request.prepare'))
  assert.ok(pyFitted.text.includes('# 代码单元：PreparedRequest.prepare'))

  const whole = renderBatchWithinBudget('header', 'tree', tsBatch, 10_000)
  assert.equal(whole.text, renderBatch('header', 'tree', tsBatch))
  assert.ok(!whole.text.includes('代码单元：'))
})

test('a scoped signature fallback is rejected when its owner annotation exceeds the budget', () => {
  const owner = 'VeryLongCacheOwnerNameThatMakesTheQualifiedAnnotationLong'
  const longBody = 'long-body'.repeat(40)
  const content = `class ${owner} extends VeryLongBaseClassNameThatKeepsTheClassSignatureOutsideTheBudget {\n  prepare(input: string) { return input + '${longBody}' }\n}\n`
  const analysis = analyzeSource('src/cache.ts', content)
  assert.ok(analysis?.parseable)
  const method = analysis.symbols.find((symbol) => symbol.kind === 'method' && symbol.name === 'prepare')
  assert.ok(method?.signatureEnd)
  const signatureLength = method.signatureEnd - method.start
  const budget = signatureLength + 2
  assert.ok(signatureLength <= budget)
  assert.ok(formatSourceRegions([{ start: method.start, end: method.signatureEnd, text: content.slice(method.start, method.signatureEnd), label: 'prepare', qualifiedName: `${owner}.prepare`, complete: false, priority: 0 }], 'ts').length > budget)
  const selected = selectSourceRegions(content, analysis, budget)
  assert.ok(selected.truncated)
  assert.ok(!selected.regions.some((region) => region.label.endsWith('(signature)')))
  assert.ok(selected.regions.every((region) => region.text.length <= budget))
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

test('Python real implementation outranks overload stubs and inner closures under a fitting budget', () => {
  const content = `class Streamer:
    @overload
    def iter_chunks(self, size: int) -> bytes: ...
    @overload
    def iter_chunks(self, size: str) -> str: ...
    def iter_chunks(self, size=None):
        def inner_closure():
            return 'CLOSURE_MARKER'
        value = inner_closure()
        self.iter_chunks(size)
        return 'REAL_ITER_CHUNKS_BODY'
    def late_tiny_a(self):
        return 1
    def late_tiny_b(self):
        return 2
    def late_tiny_c(self):
        return 3
`
  const candidates = sourceRegionCandidates(content, null, { extension: 'py' })
  const real = candidates.find((region) => region.label === 'iter_chunks' && region.text.includes('REAL_ITER_CHUNKS_BODY'))
  const stub = candidates.find((region) => region.label === 'iter_chunks' && !region.text.includes('REAL_ITER_CHUNKS_BODY'))
  const closure = candidates.find((region) => region.label === 'inner_closure')
  const lateTiny = candidates.find((region) => region.label === 'late_tiny_c')
  assert.ok(real && stub && closure && lateTiny)
  assert.ok(real.complete)
  assert.ok(stub.complete, 'a signature-only region is still textually complete, just ranked lower')
  assert.ok(real.priority > stub.priority, 'the real implementation outranks its @overload signature stubs')
  assert.ok(real.priority > closure.priority, 'the parent method outranks its inner closure')
  const picked = selectSourceRegions(content, null, formatSourceRegions([real], 'py').length + 30, { extension: 'py' })
  const pickedReal = picked.regions.find((region) => region.label === 'iter_chunks')
  assert.ok(pickedReal?.complete)
  assert.ok(pickedReal.text.includes('REAL_ITER_CHUNKS_BODY'))
  assert.ok(!picked.regions.some((region) => region.label === 'inner_closure'), 'a fitting parent keeps its closure out via overlap')
})

test('Python oversized parents keep a bounded nested fallback instead of nothing', () => {
  const filler = `${'    # deliberate filler so the parent cannot fit\n'.repeat(40)}`
  const content = `def giant_parent():\n${filler}    def useful_nested():\n        return 'NESTED_FALLBACK_MARKER'\n${filler}    return 'GIANT_PARENT_MARKER'\n`
  const candidates = sourceRegionCandidates(content, null, { extension: 'py' })
  const nested = candidates.find((region) => region.label === 'useful_nested')
  const giant = candidates.find((region) => region.label === 'giant_parent')
  assert.ok(nested && giant)
  assert.ok(giant.priority < nested.priority + 10, 'the fallback stays explainable: the parent is not buried infinitely far below')
  const picked = selectSourceRegions(content, null, formatSourceRegions([nested], 'py').length + 10, { extension: 'py' })
  assert.ok(picked.truncated)
  assert.equal(picked.regions.length, 1)
  assert.equal(picked.regions[0].label, 'useful_nested')
  assert.ok(picked.regions[0].complete)
  assert.ok(picked.regions[0].text.includes('NESTED_FALLBACK_MARKER'))
})

test('Python early orchestration methods survive via real calls while docstring and comment pseudo calls do not count', () => {
  const content = `def format_report(value):
    return value

class Pipeline:
    def run(self):
        first = self.load()
        second = self.transform(first)
        report = format_report(second)
        return 'RUN_BODY' + self.save(report)

    def load(self):
        return 'LOAD_BODY'

    def transform(self, value):
        return 'TRANSFORM_BODY'

    def save(self, report):
        return 'SAVE_BODY'

    def late_unused(self):
        """
        self.load()
        self.save(None)
        """
        # self.transform(None)
        return 'UNUSED_BODY'
`
  const candidates = sourceRegionCandidates(content, null, { extension: 'py' })
  const run = candidates.find((region) => region.label === 'run')
  const lateUnused = candidates.find((region) => region.label === 'late_unused')
  assert.ok(run && lateUnused)
  assert.ok(run.priority > lateUnused.priority, 'real local calls beat file position for unreferenced helpers')
  const picked = selectSourceRegions(content, null, run.text.length + 50, { extension: 'py' })
  const pickedRun = picked.regions.find((region) => region.label === 'run')
  assert.ok(pickedRun?.complete)
  assert.ok(pickedRun.text.includes('RUN_BODY'))
  assert.ok(!picked.regions.some((region) => region.text.includes('UNUSED_BODY')), 'docstring and comment pseudo references must not earn selection')
})

test('Python same-name methods in different classes keep owner-aware ranking', () => {
  const padding = '# module level background that keeps the fixture oversized\n'.repeat(8)
  const content = `${padding}class Alpha:
    def encode(self):
        return 'A_ENC_BODY'

class Beta:
    def go(self):
        return self.encode()

    def encode(self):
        return 'B_ENC_BODY'
`
  const candidates = sourceRegionCandidates(content, null, { extension: 'py' })
  const encodes = candidates.filter((region) => region.label === 'encode')
  assert.equal(encodes.length, 2)
  const betaEncode = encodes.find((region) => region.text.includes('B_ENC_BODY'))
  const alphaEncode = encodes.find((region) => region.text.includes('A_ENC_BODY'))
  assert.ok(betaEncode && alphaEncode)
  assert.ok(betaEncode.complete && alphaEncode.complete)
  assert.ok(betaEncode.priority > alphaEncode.priority, 'only the class whose code really calls encode gets the member-use signal')
  const budget = Math.min(
    candidates.reduce((sum, region) => sum + region.text.length, 0) + candidates.length * 20,
    content.length - 1
  )
  const picked = selectSourceRegions(content, null, budget, { extension: 'py' })
  const pickedEncodes = picked.regions.filter((region) => region.label === 'encode')
  assert.equal(pickedEncodes.length, 2)
  assert.ok(picked.regions.some((region) => region.text.includes('A_ENC_BODY')))
  assert.ok(picked.regions.some((region) => region.text.includes('B_ENC_BODY')))
})

test('Python ancestors structurally outrank closures with stronger local coupling', () => {
  const source = `def one():
  return 1
def two():
  return 2
def three():
  return 3
def combine(a, b, c):
  return a + b + c
def public_api():
  def inner():
    return combine(one(), two(), three())
  return inner()
`
  const candidates = sourceRegionCandidates(source, null, { extension: 'py' })
  const parent = candidates.find((region) => region.label === 'public_api')
  const inner = candidates.find((region) => region.label === 'inner')
  assert.ok(parent && inner)
  assert.ok(inner.priority <= parent.priority, 'a closure can never outrank its ancestor function regardless of coupling bonuses')
  const chosen = selectSourceRegions(source, null, parent.text.length, { extension: 'py' })
  assert.ok(chosen.regions.some((region) => region.label === 'public_api'), 'the complete fitting parent must survive a higher-coupling closure')
  assert.ok(!chosen.regions.some((region) => region.label === 'inner'))
})

test('Python ordinary dedented statements retire class scopes instead of borrowing them', () => {
  const base = `class First:
  def target(self):
    return 'TARGET'
`
  const before = sourceRegionCandidates(base, null, { extension: 'py' }).find((region) => region.label === 'target')?.priority
  const after = sourceRegionCandidates(`${base}if enabled:
  self.target()
`, null, { extension: 'py' }).find((region) => region.label === 'target')?.priority
  assert.ok(before !== undefined && after !== undefined)
  assert.equal(after, before, 'a module conditional must not count self usage for the retired class')
})

test('Python nested classes with the same simple name keep separate lexical identities', () => {
  const build = (use: string) => `class Alpha:
  class Node:
    def exposed(self):
      return 'A_SOURCE'
    def use(self):
      ${use}
class Beta:
  class Node:
    def exposed(self):
      return 'B_SOURCE'
`
  const priority = (text: string) =>
    sourceRegionCandidates(text, null, { extension: 'py' }).find((region) => region.label === 'exposed' && region.text.includes('B_SOURCE'))?.priority
  const withCall = priority(build('return self.exposed()'))
  const withoutCall = priority(build('return None'))
  assert.ok(withCall !== undefined && withoutCall !== undefined)
  assert.equal(withCall, withoutCall, 'member-use keys must include the full lexical class chain, not the bare class name')
})

test('Python f-string statements are executable bodies while plain docstrings stay inert', () => {
  const source = `def action():
  f"effect {external()}"
  pass
def docstring_only():
  """
  notes that carry no logic
  """
def signature():
  ...
`
  const candidates = sourceRegionCandidates(source, null, { extension: 'py' })
  const action = candidates.find((region) => region.label === 'action')
  const docstringOnly = candidates.find((region) => region.label === 'docstring_only')
  const signature = candidates.find((region) => region.label === 'signature')
  assert.ok(action && docstringOnly && signature)
  assert.ok(action.priority > signature.priority, 'an f-string statement can execute calls and must not be treated as a signature-only stub')
  assert.ok(docstringOnly.priority > signature.priority, 'a docstring without pass/ellipsis markers is not demoted either')
  const chosen = selectSourceRegions(source, null, action.text.length, { extension: 'py' })
  assert.ok(chosen.regions.some((region) => region.label === 'action'))
})

test('Python fallback prefers the nearest fitting parent over a deeper coupled closure', () => {
  const source = `def one(): ...\ndef two(): ...\ndef three(): ...\ndef combine(a,b,c): ...\ndef public_api():\n${'  # outer-only background\n'.repeat(60)}  def middle():\n    def leaf():\n      return combine(one(), two(), three())\n    return leaf()\n  return middle()\n`
  const middle = sourceRegionCandidates(source, null, { extension: 'py' }).find(region => region.label === 'middle')
  assert.ok(middle)
  const selected = selectSourceRegions(source, null, formatSourceRegions([middle], 'py').length, { extension: 'py' })
  assert.ok(selected.regions.some(region => region.label === 'middle' && region.text === middle.text))
  assert.ok(!selected.regions.some(region => region.label === 'public_api'), 'the outer ancestor genuinely exceeds the budget')
})

test('Python same-named factory classes do not borrow member-use scores', () => {
  const source = (use: string): string => `def factory_alpha():\n  class Node:\n    def exposed(self):\n      return 'A_SOURCE'\n    def use(self):\n      ${use}\n  return Node\ndef factory_beta():\n  class Node:\n    def exposed(self):\n      return 'B_SOURCE'\n  return Node\n`
  const beta = (text: string) => sourceRegionCandidates(text, null, { extension: 'py' })
    .find(region => region.label === 'exposed' && region.text.includes('B_SOURCE'))
  const withoutForeignUse = beta(source('return None'))
  const withForeignUse = beta(source('return self.exposed()'))
  assert.ok(withoutForeignUse && withForeignUse)
  assert.equal(withForeignUse.priority, withoutForeignUse.priority)
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

test('Python docstring ranges identify only standalone ordinary first body strings', () => {
  const source = `@decorator\nclass Outer:\n  """${'😀'.repeat(300)}\ndef ghost(): pass\n  """\n  class Inner:\n    r'''${'n'.repeat(600)}'''\n    def method(self):\n      """${'m'.repeat(600)}"""\n      return 1\n\ndef joined():\n  '''${'j'.repeat(600)}''' + run()\n  return 2\n\ndef assigned():\n  text = """${'a'.repeat(600)}"""\n  return text\n\ndef formatted():\n  f"""${'f'.repeat(600)}{run()}"""\n\ndef bytes_doc():\n  b"""${'b'.repeat(600)}"""\n`
  const candidates = sourceRegionCandidates(source, null, { extension: '.py' })
  const outer = candidates.find(region => region.label === 'Outer')
  const inner = candidates.find(region => region.label === 'Inner')
  const method = candidates.find(region => region.label === 'method')
  assert.ok(outer?.documentationRanges)
  assert.ok(inner?.documentationRanges)
  assert.ok(method?.documentationRanges)
  assert.equal(outer.text.slice(outer.documentationRanges[0].start, outer.documentationRanges[0].end), '😀'.repeat(300) + '\ndef ghost(): pass\n  ')
  for (const name of ['joined', 'assigned', 'formatted', 'bytes_doc']) {
    assert.equal(candidates.find(region => region.label === name)?.documentationRanges, undefined, `${name} is not a standalone plain docstring`)
  }
})

test('Python docstring compaction is bounded, visible, preserves code, and marks the region incomplete', () => {
  const source = `def documented():\n  """${'A'.repeat(159)}😀${'B'.repeat(500)}"""\n  return 'KEEP_CODE'\n`
  const region = sourceRegionCandidates(source, null, { extension: 'py' }).find(item => item.label === 'documented')
  assert.ok(region?.documentationRanges)
  const compacted = compactRegionDocumentation(region)
  assert.equal(compacted.complete, false)
  assert.equal(compacted.documentationOmitted, true)
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(compacted.text), 'the 160-unit cutoff must not split a surrogate pair')
  assert.ok(compacted.text.includes('文档其余内容省略'))
  assert.ok(compacted.text.includes("return 'KEEP_CODE'"))
  assert.ok(formatSourceRegions([compacted], 'py').includes('文档节选'))
  assert.equal(compactRegionDocumentation({ ...region, text: region.text + 'changed' }).documentationOmitted, true)
  const overlapping = { ...region, documentationRanges: [{ start: 1, end: 8 }, { start: 7, end: 20 }] }
  assert.equal(compactRegionDocumentation(overlapping), overlapping, 'overlapping ranges fail closed without altering the region')
})

test('decorated multiline Python signatures locate the actual triple-quoted docstring', () => {
  const source = `@decorate(\n  mode='safe',\n)\ndef execute(\n  self,\n  note="not a docstring",\n) -> str:\n  """${'PUBLIC_DOC_SENTINEL '.repeat(40)}"""\n  return 'KEEP_AFTER_DOC'\n`
  const region = sourceRegionCandidates(source, null, { extension: 'py' }).find(item => item.label === 'execute')
  assert.ok(region?.documentationRanges, 'the long body docstring is found after the closing signature line')
  const range = region.documentationRanges[0]
  assert.ok(region.text.slice(range.start, range.end).startsWith('PUBLIC_DOC_SENTINEL'))
  const compacted = compactRegionDocumentation(region)
  assert.ok(compacted.documentationOmitted)
  assert.ok(compacted.text.includes("return 'KEEP_AFTER_DOC'"))
  assert.equal(compacted.text.slice(0, range.start), region.text.slice(0, range.start))
  const marker = '\n…（文档其余内容省略）…\n'
  const markerStart = compacted.text.indexOf(marker, range.start)
  assert.ok(markerStart >= range.start)
  assert.equal(compacted.text.slice(markerStart + marker.length), region.text.slice(range.end), 'everything after the docstring content remains byte-identical')
  const simple = `def sample(\n    value\n):\n    """${'😀'.repeat(300)}${'tail'.repeat(100)}"""\n    return 1\n`
  const simpleRegion = sourceRegionCandidates(simple, null, { extension: 'py' }).find(item => item.label === 'sample')
  assert.ok(simpleRegion?.documentationRanges, 'a signature whose close paren and colon begin at column zero still finds its body docstring')
})

test('long docstrings with Python escapes remain unchanged instead of cutting an escape', () => {
  const source = 'def escaped():\n  """' + 'A'.repeat(159) + '\\u0041\\U0001f600\\x41\\N{LATIN CAPITAL LETTER A}' + 'B'.repeat(500) + '"""\n  return \'KEEP_ESCAPE_NEIGHBOR\'\n'
  const region = sourceRegionCandidates(source, null, { extension: 'py' }).find(item => item.label === 'escaped')
  assert.ok(region?.documentationRanges)
  const unchanged = compactRegionDocumentation(region)
  assert.equal(unchanged, region)
  assert.equal(unchanged.documentationOmitted, undefined)
  assert.ok(unchanged.text.includes("return 'KEEP_ESCAPE_NEIGHBOR'"))
})

test('parent regions collect nested confirmed docs with a bounded cap and preserve declaration source', () => {
  const methods = Array.from({ length: 66 }, (_, index) => `  def method_${index}():\n    """${'D'.repeat(600)}\ndef ghost(): pass\n    """\n    return 'BODY_${index}'\n`).join('')
  const source = `class Parent:\n  """${'P'.repeat(600)}"""\n${methods}`
  const candidates = sourceRegionCandidates(source, null, { extension: 'py' })
  const parent = candidates.find(region => region.label === 'Parent')
  assert.ok(parent?.documentationRanges)
  assert.equal(parent.documentationRanges.length, 64)
  const compacted = compactRegionDocumentation(parent)
  assert.equal(compacted.documentationOmitted, true)
  const scrubDocs = (text: string): string => text.replace(/"""[\s\S]*?"""/g, '"""DOCUMENTATION"""')
  assert.equal(scrubDocs(compacted.text), scrubDocs(parent.text), 'all fixture source outside confirmed doc contents remains byte-identical')
  const last = parent.documentationRanges.at(-1)!
  assert.ok(compacted.text.endsWith(parent.text.slice(last.end)), 'the unprocessed tail after the64-range cap remains byte-identical, including its long docs')
  assert.ok(compacted.text.includes("return 'BODY_65'"), 'tail source after the cap remains intact')
  assert.ok(compacted.text.includes('def ghost(): pass'), 'doc text resembling a declaration remains ordinary string contents')
  for (let index = 0; index < 66; index++) assert.ok(compacted.text.includes(`return 'BODY_${index}'`))
  const first = parent.documentationRanges[0]
  assert.ok(first.start > 0, 'the parent range list includes nested docs in source order')
  const nestedSource = `def factory():\n  def inner():\n    """${'N'.repeat(700)}"""\n    return 'NESTED_BODY'\n  return inner()\n`
  const nested = sourceRegionCandidates(nestedSource, null, { extension: 'py' }).find(region => region.label === 'factory')
  assert.ok(nested?.documentationRanges?.length === 1)
  const nestedCompact = compactRegionDocumentation(nested)
  assert.ok(nestedCompact.documentationOmitted)
  assert.ok(nestedCompact.text.includes("return 'NESTED_BODY'"))
})

test('mixed escaped and plain long doc ranges compact independently', () => {
  const first = 'A'.repeat(600)
  const escaped = 'E'.repeat(200) + '\\u0041' + 'F'.repeat(400)
  const last = 'B'.repeat(600)
  const text = `pre${first}mid${escaped}post${last}tail`
  const rangeA = { start: 3, end: 3 + first.length }
  const rangeB = { start: rangeA.end + 3, end: rangeA.end + 3 + escaped.length }
  const rangeC = { start: rangeB.end + 4, end: rangeB.end + 4 + last.length }
  const region = { start: 0, end: text.length, text, label: 'mixed', complete: true, priority: 1, documentationRanges: [rangeA, rangeB, rangeC] }
  const compacted = compactRegionDocumentation(region)
  assert.equal(compacted.documentationOmitted, true)
  assert.ok(compacted.text.includes(`mid${escaped}post`), 'the escaped range remains byte-identical')
  assert.ok(compacted.text.includes('A'.repeat(160) + '\n…（文档其余内容省略）…\n'))
  assert.ok(compacted.text.includes('B'.repeat(160) + '\n…（文档其余内容省略）…\n'))
  assert.ok(compacted.text.endsWith('tail'))
  const overlap = { ...region, documentationRanges: [rangeA, { start: rangeA.start + 1, end: rangeA.end }] }
  assert.equal(compactRegionDocumentation(overlap), overlap)
  const invalid = { ...region, documentationRanges: [{ start: -1, end: 2 }] }
  assert.equal(compactRegionDocumentation(invalid), invalid)
})

test('short Python docstrings and whole-file fits remain byte-for-byte unchanged', () => {
  const source = `def documented():\n  """short note"""\n  return 1\n`
  const region = sourceRegionCandidates(source, null, { extension: 'py' }).find(item => item.label === 'documented')
  assert.ok(region)
  assert.equal(compactRegionDocumentation(region).text, region.text)
  const whole = selectSourceRegions(source, null, source.length, { extension: 'py' })
  assert.equal(whole.regions[0].text, source)
  assert.equal(whole.regions[0].documentationOmitted, undefined)
  const singleQuoted = `def ordinary_string():\n  "${'x'.repeat(700)}"\n  return 3\n`
  assert.equal(sourceRegionCandidates(singleQuoted, null, { extension: 'py' }).find(item => item.label === 'ordinary_string')?.documentationRanges, undefined, 'single-quoted strings stay intact to avoid injecting newlines into their syntax')
})

test('tight Python selection includes every docstring marker in its actual formatting budget', () => {
  const source = `def oversized():\n  """${'D'.repeat(900)}"""\n  return 'CODE_SENTINEL'\n\ndef extra():\n  return 2\n`
  const budget = 300
  const selected = selectSourceRegions(source, null, budget, { extension: 'py' })
  assert.ok(selected.truncated)
  assert.ok(selected.regions.some(region => region.documentationOmitted))
  assert.ok(formatSourceRegions(selected.regions, 'py').length <= budget)
  assert.ok(selected.regions.some(region => region.text.includes('CODE_SENTINEL')))
})
