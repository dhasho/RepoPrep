// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by direct Node tests.
import { analyzeSource } from './source-analysis.ts'
// @ts-ignore TS5097 -- extension is required by direct Node tests.
import { collectFileSignals, selectProbeFiles } from './file-selection.ts'
// @ts-ignore TS5097 -- extension is required by direct Node tests.
import type { ScannedFile } from './scanner.ts'

const file = (relPath: string, size = 100): ScannedFile => ({ relPath, absPath: `C:/fixture/${relPath}`, size, ext: relPath.split('.').at(-1) ?? '', isContentCandidate: true })

test('AST imports ignore examples in comments and strings and expose complete declarations and class methods', () => {
  const text = `// import { fake } from './not-real'\nconst example = "require('./also-fake')"\nfunction outer() { const local = 1; function inner() { return local } }\nexport interface Contract { run(): void }\nexport class Service { run() { return 1 }; task = () => 2 }\nexport const work = () => import('./real.js'), count = 1\n`
  const result = analyzeSource('src/service.ts', text)
  assert.ok(result)
  assert.equal(result.parseable, true)
  assert.deepEqual(result.imports.map((item) => item.specifier), ['./real.js'])
  assert.ok(result.symbols.some((item) => item.name === 'Contract' && item.kind === 'interface' && item.exported && text.slice(item.start, item.end).includes('run(): void')))
  assert.ok(result.symbols.some((item) => item.name === 'run' && item.kind === 'method' && item.parentName === 'Service' && text.slice(item.start, item.end).includes('return 1')))
  assert.ok(result.symbols.some((item) => item.name === 'task' && item.kind === 'method' && item.parentName === 'Service'))
  assert.ok(result.symbols.some((item) => item.name === 'work' && item.kind === 'function' && item.exported))
  assert.ok(result.symbols.some((item) => item.name === 'count' && item.kind === 'variable'))
  assert.equal(result.symbols.some((item) => item.name === 'inner' || item.name === 'local'), false)
  assert.equal(new Set(result.symbols.filter((item) => item.name === 'work' || item.name === 'count').map((item) => `${item.start}:${item.end}`)).size, 2)
  const importText = "import { one, two as second } from './dep'\nexport { one as publicOne } from './dep'\n"
  const imported = analyzeSource('src/imports.ts', importText)
  assert.ok(imported)
  assert.ok(imported.symbols.filter((item) => item.kind === 'import').every((item) => importText.slice(item.start, item.end).startsWith('import ')))
  assert.ok(imported.symbols.filter((item) => item.kind === 'export').every((item) => importText.slice(item.start, item.end).startsWith('export ')))
  assert.equal(analyzeSource('src/readme.py', 'print("x")'), null)
})

test('JSONC path aliases with bounded local extends resolve only supplied candidate files and retain imported names', () => {
  const files = [file('packages/app/tsconfig.base.json'), file('packages/app/tsconfig.json'), file('packages/app/src/main.ts'), file('packages/app/src/deep/engine.ts'), file('packages/app/src/secrets.ts'), file('outside.ts')]
  const contents = new Map<string, string>([
    ['packages/app/tsconfig.base.json', '{\n // shared alias\n "compilerOptions": { "baseUrl": "./src", "paths": { "@core/*": ["deep/*"], "@local": ["secrets.ts"], "escape/*": ["../../../../outside*"] } }\n}'],
    ['packages/app/tsconfig.json', '{ "extends": "./tsconfig.base" }'],
    ['packages/app/src/main.ts', "import { Engine as Core } from '@core/engine'; import { secret } from '@local'; import '../escape'; import 'escape/outside'; import 'node:fs'"],
    ['packages/app/src/deep/engine.ts', 'export class Engine {}'],
    ['packages/app/src/secrets.ts', 'export const secret = 1'],
    ['outside.ts', 'export const outside = 1']
  ])
  const result = collectFileSignals(files, contents)
  assert.equal(result.importedBy.get('packages/app/src/deep/engine.ts'), 1)
  assert.equal(result.importedBy.get('packages/app/src/secrets.ts'), 1)
  assert.equal(result.importedBy.has('outside.ts'), false)
  assert.deepEqual(result.referencedSymbols?.get('packages/app/src/deep/engine.ts'), ['Engine'])
  assert.ok(result.importEdges?.some((edge) => edge.specifier === '@core/engine' && edge.fromPath === 'packages/app/src/main.ts'))
})

test('config probing reserves a bounded fair share and source modules remain in the probe set', () => {
  const files = [file('src/core.ts'), ...Array.from({ length: 12 }, (_, i) => file(`packages/p${i}/tsconfig.json`)), ...Array.from({ length: 12 }, (_, i) => file(`packages/p${i}/src/file.ts`))]
  const selected = selectProbeFiles(files, 'fine', 10, 1000)
  assert.ok(selected.length <= 10)
  assert.ok(selected.some((item) => item.relPath.endsWith('.ts') && !item.relPath.endsWith('.json')))
})

test('standard config precedence and named fallback are deterministic under reversed file order', () => {
  const files = [file('tsconfig.named.json'), file('jsconfig.json'), file('tsconfig.json'), file('src/main.ts'), file('src/standard.ts'), file('src/named.ts'), file('src/js.ts')]
  const contents = new Map<string, string>([
    ['tsconfig.named.json', '{"compilerOptions":{"paths":{"@pick":["src/named.ts"]}}}'],
    ['jsconfig.json', '{"compilerOptions":{"paths":{"@pick":["src/js.ts"]}}}'],
    ['tsconfig.json', '{"compilerOptions":{"paths":{"@pick":["src/standard.ts"]}}}'],
    ['src/main.ts', "import '@pick'"]
  ])
  const first = collectFileSignals(files, contents)
  const reversed = collectFileSignals([...files].reverse(), contents)
  assert.equal(first.importedBy.get('src/standard.ts'), 1)
  assert.equal(first.importedBy.has('src/named.ts'), false)
  assert.deepEqual([...first.importedBy], [...reversed.importedBy])

  const noStandard = files.filter((entry) => entry.relPath !== 'tsconfig.json' && entry.relPath !== 'jsconfig.json')
  const fallback = collectFileSignals(noStandard, contents)
  assert.equal(fallback.importedBy.get('src/named.ts'), 1)
  assert.deepEqual([...fallback.importedBy], [...collectFileSignals([...noStandard].reverse(), contents).importedBy])
})

test('nearest nested config overrides inherited paths and baseUrl while exact and specific wildcard paths win', () => {
  const files = [
    file('tsconfig.json'), file('packages/app/tsconfig.json'), file('packages/app/src/main.ts'),
    file('src/shared/base.ts'), file('packages/app/src/tool.ts'), file('packages/app/src/special/item.ts'),
    file('packages/app/src/exact.ts'), file('packages/app/src/wildcard/special.ts'),
    file('packages/app/src/long/special.ts'), file('packages/app/src/short/deep/special.ts')
  ]
  const contents = new Map<string, string>([
    ['tsconfig.json', '{"compilerOptions":{"baseUrl":"./src","paths":{"@inherited/*":["shared/*"],"@replace/*":["shared/*"]}}}'],
    ['packages/app/tsconfig.json', '{"extends":"../../tsconfig.json","compilerOptions":{"baseUrl":"./src","paths":{"@replace/*":["special/*"],"@pick/item":["exact.ts"],"@pick/*":["wildcard/*"],"@scope/*":["short/*"],"@scope/deep/*":["long/*"]}}}'],
    ['packages/app/src/main.ts', "import '@replace/item'; import '@pick/item'; import '@scope/deep/special'; import '@inherited/base'; import 'tool'"]
  ])
  const signals = collectFileSignals(files, contents)
  assert.equal(signals.importedBy.get('packages/app/src/special/item.ts'), 1)
  assert.equal(signals.importedBy.get('packages/app/src/exact.ts'), 1)
  assert.equal(signals.importedBy.get('packages/app/src/long/special.ts'), 1)
  assert.equal(signals.importedBy.get('src/shared/base.ts'), undefined, 'child paths replace inherited paths')
  assert.equal(signals.importedBy.get('packages/app/src/tool.ts'), 1, 'baseUrl resolves bare imports')
})

test('inherited path targets keep their declaring config origin when no baseUrl is set', () => {
  const files = [file('tsconfig.json'), file('packages/app/tsconfig.json'), file('packages/app/src/main.ts'), file('shared/item.ts')]
  const contents = new Map<string, string>([
    ['tsconfig.json', '{"compilerOptions":{"paths":{"@base/*":["shared/*"]}}}'],
    ['packages/app/tsconfig.json', '{"extends":"../../tsconfig.json"}'],
    ['packages/app/src/main.ts', "import '@base/item'"]
  ])
  assert.equal(collectFileSignals(files, contents).importedBy.get('shared/item.ts'), 1)
})

test('child baseUrl override governs inherited paths while no baseUrl falls back to path declaration origin', () => {
  const files = [file('tsconfig.json'), file('packages/app/tsconfig.json'), file('packages/app/src/main.ts'), file('packages/app/src/item.ts'), file('src/item.ts')]
  const contents = new Map<string, string>([
    ['tsconfig.json', '{"compilerOptions":{"paths":{"@item":["item.ts"]}}}'],
    ['packages/app/tsconfig.json', '{"extends":"../../tsconfig.json","compilerOptions":{"baseUrl":"./src"}}'],
    ['packages/app/src/main.ts', "import '@item'"]
  ])
  const signals = collectFileSignals(files, contents)
  assert.equal(signals.importedBy.get('packages/app/src/item.ts'), 1)
  assert.equal(signals.importedBy.has('src/item.ts'), false)
})

test('baseUrl alone resolves bare imports and inherited baseUrl keeps its declaring origin', () => {
  const files = [
    file('tsconfig.json'), file('packages/app/tsconfig.json'), file('packages/app/src/main.ts'),
    file('source/plain.ts'), file('source/inherited.ts')
  ]
  const contents = new Map<string, string>([
    ['tsconfig.json', '{"compilerOptions":{"baseUrl":"./source"}}'],
    ['packages/app/tsconfig.json', '{"extends":"../../tsconfig.json"}'],
    ['packages/app/src/main.ts', "import 'plain'; import 'inherited'"]
  ])
  const signals = collectFileSignals(files, contents)
  assert.equal(signals.importedBy.get('source/plain.ts'), 1)
  assert.equal(signals.importedBy.get('source/inherited.ts'), 1)
})

test('a supplied relative JSON extends target can define aliases without disk lookup', () => {
  const files = [file('tsconfig.json'), file('config/base.json'), file('src/main.ts'), file('src/feature.ts')]
  const contents = new Map<string, string>([
    ['tsconfig.json', '{"extends":"./config/base.json"}'],
    ['config/base.json', '{"compilerOptions":{"paths":{"@feature":["../src/feature.ts"]}}}'],
    ['src/main.ts', "import '@feature'"]
  ])
  assert.equal(collectFileSignals(files, contents).importedBy.get('src/feature.ts'), 1)
})

test('extends cycles and depth are bounded and unavailable config text never triggers filesystem discovery', () => {
  const files = [file('tsconfig.json'), file('tsconfig.layer0.json'), file('tsconfig.layer1.json'), file('tsconfig.layer2.json'), file('tsconfig.layer3.json'), file('tsconfig.layer4.json'), file('tsconfig.layer5.json'), file('tsconfig.layer6.json'), file('tsconfig.layer7.json'), file('tsconfig.layer8.json'), file('src/main.ts'), file('src/from-cycle.ts'), file('src/from-disk.ts')]
  const contents = new Map<string, string>([
    ['tsconfig.json', '{"extends":"./tsconfig.layer0.json","compilerOptions":{"paths":{"@cycle":["src/from-cycle.ts"]}}}'],
    ['tsconfig.layer0.json', '{"extends":"./tsconfig.layer1.json"}'],
    ['tsconfig.layer1.json', '{"extends":"./tsconfig.layer2.json"}'],
    ['tsconfig.layer2.json', '{"extends":"./tsconfig.layer3.json"}'],
    ['tsconfig.layer3.json', '{"extends":"./tsconfig.layer4.json"}'],
    ['tsconfig.layer4.json', '{"extends":"./tsconfig.layer5.json"}'],
    ['tsconfig.layer5.json', '{"extends":"./tsconfig.layer6.json"}'],
    ['tsconfig.layer6.json', '{"extends":"./tsconfig.layer7.json"}'],
    ['tsconfig.layer7.json', '{"extends":"./tsconfig.layer8.json"}'],
    ['tsconfig.layer8.json', '{"extends":"./tsconfig.layer0.json","compilerOptions":{"paths":{"@too-deep":["src/from-cycle.ts"]}}}'],
    ['src/main.ts', "import '@cycle'; import '@too-deep'; import '@unprovided'"]
  ])
  const signals = collectFileSignals(files, contents)
  assert.equal(signals.importedBy.get('src/from-cycle.ts'), 1)
  assert.equal(signals.importedBy.has('src/from-disk.ts'), false)
  assert.equal(signals.importEdges?.some((edge) => edge.specifier === '@unprovided'), false)
  assert.equal(signals.importEdges?.some((edge) => edge.specifier === '@too-deep'), false)

  const noConfigText = collectFileSignals(files, new Map([['src/main.ts', "import '@unprovided'"]]))
  assert.equal(noConfigText.importedBy.size, 0)
  const noPaths = collectFileSignals(files, new Map([
    ['tsconfig.json', '{"compilerOptions":{}}'],
    ['src/main.ts', "import '@unprovided'"]
  ]))
  assert.equal(noPaths.importedBy.size, 0)
})

test('alias mapping rejects paths outside project, absolute paths and noncandidate targets', () => {
  const files = [file('tsconfig.json'), file('src/main.ts'), file('src/real.ts'), file('outside.ts'), file('../unsafe.ts'), { ...file('secret.ts'), sensitive: { category: 'credential', reason: 'fixture' } }, { ...file('src/blocked.ts'), isContentCandidate: false }]
  const contents = new Map<string, string>([
    ['tsconfig.json', '{"compilerOptions":{"paths":{"@escape":["../../outside.ts"],"@disk":["C:/private.ts"],"@blocked":["src/blocked.ts"],"@secret":["secret.ts"],"@unsafe":["../unsafe.ts"],"@safe":["src/real.ts"]}}}'],
    ['src/main.ts', "import '@escape'; import '@disk'; import '@blocked'; import '@secret'; import '@unsafe'; import '@safe'"]
  ])
  const signals = collectFileSignals(files, contents)
  assert.equal(signals.importedBy.get('src/real.ts'), 1)
  assert.equal(signals.importedBy.has('outside.ts'), false)
  assert.equal(signals.importedBy.has('src/blocked.ts'), false)
  assert.equal(signals.importedBy.has('secret.ts'), false)
})

test('repeated imports from one source merge names and count that source once', () => {
  const files = [file('src/main.ts'), file('src/target.ts')]
  const contents = new Map([['src/main.ts', "import { Alpha } from './target'; import { Beta as LocalBeta } from './target'"]])
  const signals = collectFileSignals(files, contents)
  assert.equal(signals.importedBy.get('src/target.ts'), 1)
  assert.equal(signals.importEdges?.length, 1)
  assert.deepEqual(signals.referencedSymbols?.get('src/target.ts'), ['Alpha', 'Beta'])
})
