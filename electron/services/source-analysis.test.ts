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
  const text = `// import { fake } from './not-real'\nconst example = "require('./also-fake')"\nexport interface Contract { run(): void }\nexport class Service { run() { return 1 } }\nexport const work = () => import('./real.js')\n`
  const result = analyzeSource('src/service.ts', text)
  assert.ok(result)
  assert.equal(result.parseable, true)
  assert.deepEqual(result.imports.map((item) => item.specifier), ['./real.js'])
  assert.ok(result.symbols.some((item) => item.name === 'Contract' && item.kind === 'interface' && item.exported && text.slice(item.start, item.end).includes('run(): void')))
  assert.ok(result.symbols.some((item) => item.name === 'run' && item.kind === 'method' && item.parentName === 'Service' && text.slice(item.start, item.end).includes('return 1')))
  assert.ok(result.symbols.some((item) => item.name === 'work' && item.kind === 'function' && item.exported))
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
