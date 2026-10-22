// 文件选择策略的行为回归。
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { collectFileSignals, isCoarseCandidate, orderFilesForContext, selectProbeFiles, type FileSelectionSignals } from './file-selection.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import type { ScannedFile } from './scanner.ts'

function file(relPath: string, size = 1000, isContentCandidate = true): ScannedFile {
  return { relPath, absPath: `C:/project/${relPath}`, size, ext: relPath.split('.').pop()?.toLowerCase() ?? '', isContentCandidate }
}

function paths(files: readonly ScannedFile[]): string[] {
  return files.map((item) => item.relPath)
}

const emptySignals: FileSelectionSignals = { entryPaths: new Set(), importedBy: new Map() }

test('入口与被业务源码引用的深层核心文件优先于浅层普通源码', () => {
  const input = [file('src/util.ts'), file('packages/app/src/deep/engine.ts'), file('packages/app/src/deep/util.ts'), file('packages/app/src/main.ts'), file('README.ts')]
  const signals = { entryPaths: new Set(['packages/app/src/main.ts']), importedBy: new Map([['packages/app/src/deep/engine.ts', 2]]) }
  const ordered = paths(orderFilesForContext(input, 'fine', signals))
  assert.ok(ordered.indexOf('README.ts') < ordered.indexOf('packages/app/src/main.ts'))
  assert.ok(ordered.indexOf('packages/app/src/main.ts') < ordered.indexOf('packages/app/src/deep/engine.ts'))
  assert.ok(ordered.indexOf('packages/app/src/deep/engine.ts') < ordered.indexOf('packages/app/src/deep/util.ts'))
})

test('输入顺序变化不改变排序', () => {
  const input = [file('src/a.ts'), file('src/b.ts'), file('packages/b/src/index.ts'), file('packages/a/src/index.ts'), file('docs/guide.md')]
  const first = paths(orderFilesForContext(input, 'fine', emptySignals))
  const second = paths(orderFilesForContext([...input].reverse(), 'fine', emptySignals))
  assert.deepEqual(first, second)
})

test('相同优先级按模块轮转，覆盖 monorepo package 和嵌套 app 模块', () => {
  const input = [
    file('packages/foo/src/a.ts'), file('packages/foo/src/b.ts'), file('packages/foo/apps/foo/src/c.ts'),
    file('packages/bar/src/a.ts'), file('src/one/a.ts'), file('src/two/a.ts')
  ]
  const ordered = paths(orderFilesForContext(input, 'fine', emptySignals))
  const sourceOnly = ordered.filter((item) => item.endsWith('.ts'))
  assert.equal(new Set(sourceOnly.slice(0, 4).map((item) => item.split('/').slice(0, 3).join('/'))).size, 4)
  assert.ok(ordered.indexOf('packages/foo/apps/foo/src/c.ts') >= 0)
})

test('热模块有 100 个被引用文件时，冷模块源码仍进入前 64 项', () => {
  const input = Array.from({ length: 100 }, (_, index) => file(`src/a/core${index}.ts`))
  input.push(file('src/b/worker.ts'))
  const signals = {
    entryPaths: new Set<string>(),
    importedBy: new Map(input.slice(0, 100).map((item) => [item.relPath, 2]))
  }
  const ordered = paths(orderFilesForContext(input, 'fine', signals))
  assert.ok(ordered.slice(0, 64).includes('src/b/worker.ts'))
})

test('monorepo 热 package 与冷 app 同时获得前部覆盖', () => {
  const input = Array.from({ length: 100 }, (_, index) => file(`packages/hot/src/core${index}.ts`))
  input.push(file('apps/cold/src/worker.ts'))
  const signals = {
    entryPaths: new Set<string>(),
    importedBy: new Map(input.slice(0, 100).map((item) => [item.relPath, 2]))
  }
  const ordered = paths(orderFilesForContext(input, 'fine', signals))
  assert.ok(ordered.slice(0, 64).includes('apps/cold/src/worker.ts'))
})

test('本地 TS/JS 引用、扩展补全、index 解析和 package manifest 入口只指向白名单文件', () => {
  const candidates = [
    file('package.json'), file('src/main.ts'), file('src/engine.ts'), file('src/widgets/index.tsx'),
    file('src/util.py'), file('src/app.py'), file('outside.ts')
  ]
  const contents = new Map<string, string>([
    ['package.json', JSON.stringify({ main: 'src/main.js', exports: { '.': { import: './src/engine.js' } }, scripts: { start: 'do-not-execute' } })],
    ['src/main.ts', "import { run } from './engine.js'; export * from './widgets'"],
    ['src/app.py', 'from .util import run\nimport os'],
    ['src/engine.ts', "require('../../outside'); import('./missing')"]
  ])
  const signals = collectFileSignals(candidates, contents)
  assert.ok(signals.entryPaths.has('src/main.ts'))
  assert.ok(signals.entryPaths.has('src/engine.ts'))
  assert.equal(signals.importedBy.get('src/engine.ts'), 1)
  assert.equal(signals.importedBy.get('src/widgets/index.tsx'), 1)
  assert.equal(signals.importedBy.get('src/util.py'), 1)
  assert.equal(signals.importedBy.has('outside.ts'), false)
})

test('引用计数按独立来源去重，测试文件不会提升核心权重', () => {
  const candidates = [file('src/core.ts'), file('src/a.ts'), file('src/b.ts'), file('tests/core.test.ts')]
  const contents = new Map([
    ['src/a.ts', "import './core'; import './core'"],
    ['src/b.ts', "export * from './core'"],
    ['tests/core.test.ts', Array.from({ length: 80 }, () => "import '../src/core'").join('\n')]
  ])
  const signals = collectFileSignals(candidates, contents)
  assert.equal(signals.importedBy.get('src/core.ts'), 2)
  assert.ok(paths(orderFilesForContext(candidates, 'fine', signals)).indexOf('src/core.ts') < paths(orderFilesForContext(candidates, 'fine', signals)).indexOf('tests/core.test.ts'))
})

test('同一模块中被三个独立源码引用的核心排在单一来源引用核心前', () => {
  const input = [file('src/core-one.ts'), file('src/core-many.ts'), file('src/a.ts'), file('src/b.ts'), file('src/c.ts')]
  const signals = {
    entryPaths: new Set<string>(),
    importedBy: new Map([['src/core-one.ts', 1], ['src/core-many.ts', 3]])
  }
  const ordered = paths(orderFilesForContext(input, 'fine', signals))
  assert.ok(ordered.indexOf('src/core-many.ts') < ordered.indexOf('src/core-one.ts'))
})

test('粗粒度兼容 README.* 与大小写不敏感配置，排除业务源码', () => {
  for (const rel of ['README.md', 'README.ts', 'docs/readme.rst', 'Dockerfile', 'Makefile', 'Cargo.toml', 'electron.vite.config.ts', 'postcss.config.mjs']) {
    assert.ok(isCoarseCandidate(rel), `${rel} should remain a coarse candidate`)
  }
  assert.ok(!isCoarseCandidate('src/app.ts'))
  assert.ok(!isCoarseCandidate('lib/utils.py'))
})

test('无引用信号时稳定 fallback 到源码，配置与文档不耗尽源码优先空间', () => {
  const input = [file('docs/guide.md'), file('packages/a/package.json'), file('vite.config.ts'), file('src/core.ts'), file('packages/a/src/app.py')]
  const ordered = paths(orderFilesForContext(input, 'fine'))
  assert.ok(ordered.indexOf('src/core.ts') < ordered.indexOf('vite.config.ts'))
  assert.ok(ordered.indexOf('packages/a/src/app.py') < ordered.indexOf('docs/guide.md'))
})

test('无 manifest 声明时，深层常见入口优先于普通源码', () => {
  const input = [file('src/a.ts'), file('packages/app/src/deep/main.ts'), file('packages/app/src/deep/core.ts')]
  const ordered = paths(orderFilesForContext(input, 'fine'))
  assert.ok(ordered.indexOf('packages/app/src/deep/main.ts') < ordered.indexOf('src/a.ts'))
})

test('大量 fixtures/tests 约定入口不会挤掉业务核心，真实引用高于普通 index 入口', () => {
  const input = [file('src/core.ts'), file('src/app.ts')]
  for (let index = 0; index < 40; index++) {
    input.push(file(`fixtures/f${index}/index.ts`), file(`tests/t${index}/main.ts`), file(`generated/g${index}/app.ts`))
  }
  const contents = new Map([['src/app.ts', "import './core'"]])
  const signals = collectFileSignals(input, contents)
  const ordered = paths(orderFilesForContext(input, 'fine', signals))
  assert.ok(ordered.indexOf('src/core.ts') < ordered.indexOf('fixtures/f0/index.ts'))
  assert.ok(ordered.indexOf('src/core.ts') < ordered.indexOf('tests/t0/main.ts'))
  assert.ok(ordered.indexOf('src/core.ts') < ordered.indexOf('generated/g0/app.ts'))
})

test('探测阶段先覆盖根与嵌套 package 清单，再继续选择源码', () => {
  const input = [file('src/a.ts', 10), file('src/b.ts', 10), file('package.json', 10), file('packages/app/package.json', 10), file('apps/web/package.json', 10)]
  const chosen = paths(selectProbeFiles(input, 'fine', 4, 100))
  assert.deepEqual(chosen.slice(0, 3), ['package.json', 'apps/web/package.json', 'packages/app/package.json'])
  assert.ok(chosen.includes('src/a.ts'))
})

test('极不均衡模块保持稳定轮转，耗尽单文件模块后只继续遍历活跃模块', () => {
  const input = Array.from({ length: 120 }, (_, index) => file(`packages/large/src/file${String(index).padStart(3, '0')}.ts`))
  for (let index = 0; index < 60; index++) input.push(file(`packages/small-${String(index).padStart(2, '0')}/src/file.ts`))
  const ordered = paths(orderFilesForContext(input, 'fine'))
  assert.equal(ordered.length, input.length)
  assert.deepEqual(ordered.slice(0, 4), [
    'packages/large/src/file000.ts',
    'packages/small-00/src/file.ts',
    'packages/small-01/src/file.ts',
    'packages/small-02/src/file.ts'
  ])
  assert.equal(ordered[61], 'packages/large/src/file001.ts')
  assert.equal(ordered.at(-1), 'packages/large/src/file119.ts')
})

test('root 项目清单优先于普通源码，lint 配置仍排在源码之后', () => {
  const input = [file('src/app.ts'), file('Cargo.toml'), file('go.mod'), file('pyproject.toml'), file('pom.xml'), file('build.gradle'), file('composer.json'), file('eslint.config.js')]
  const ordered = paths(orderFilesForContext(input, 'fine'))
  for (const manifest of input.slice(1, 7)) assert.ok(ordered.indexOf(manifest.relPath) < ordered.indexOf('src/app.ts'))
  assert.ok(ordered.indexOf('src/app.ts') < ordered.indexOf('eslint.config.js'))
})

test('探测文件严格受数量与字节预算限制，过大的前置候选不会阻塞小文件', () => {
  const input = [file('src/huge.ts', 5000), file('src/small.ts', 20), file('tests/skip.ts', 10, false), file('docs/readme.md', 30)]
  const chosen = selectProbeFiles(input, 'fine', 2, 50)
  assert.deepEqual(paths(chosen), ['src/small.ts', 'docs/readme.md'])
  assert.ok(chosen.length <= 2)
  assert.ok(chosen.reduce((sum, item) => sum + item.size, 0) <= 50)
  assert.deepEqual(selectProbeFiles(input, 'fine', 0, 50), [])
})

test('相对与绝对本地 Python 导入解析，包括 from . import child', () => {
  const candidates = [file('pkg/app.py'), file('pkg/core.py'), file('pkg/child.py'), file('pkg/util.py')]
  const contents = new Map([
    ['pkg/app.py', 'import pkg.core\nfrom . import child\nfrom .util import run\nfrom pkg.core import Thing']
  ])
  const signals = collectFileSignals(candidates, contents)
  assert.equal(signals.importedBy.get('pkg/core.py'), 1)
  assert.equal(signals.importedBy.get('pkg/child.py'), 1)
  assert.equal(signals.importedBy.get('pkg/util.py'), 1)
})

test('ESM 与 CommonJS 显式扩展映射到 mts/cts，目录解析支持 index.mts/cts', () => {
  const candidates = [file('src/main.ts'), file('src/modern.mts'), file('src/legacy.cts'), file('src/widgets/index.mts'), file('src/plugins/index.cts')]
  const contents = new Map([
    ['src/main.ts', "import './modern.mjs'; require('./legacy.cjs'); export * from './widgets'; export * from './plugins'"]
  ])
  const signals = collectFileSignals(candidates, contents)
  assert.equal(signals.importedBy.get('src/modern.mts'), 1)
  assert.equal(signals.importedBy.get('src/legacy.cts'), 1)
  assert.equal(signals.importedBy.get('src/widgets/index.mts'), 1)
  assert.equal(signals.importedBy.get('src/plugins/index.cts'), 1)
})
