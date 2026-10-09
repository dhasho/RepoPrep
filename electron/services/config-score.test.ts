// 关键配置文件评分的大小写与目录深度测试（issue #18）
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { isCoarseCandidate, scoreFile } from './context-builder.ts'

const CONFIG_SIZE = 1000 // 介于 200 与 100_000 之间，不触发大小修正

test('验收：Dockerfile / Makefile / Cargo.toml 等混合大小写配置按配置分评分', () => {
  for (const rel of ['Dockerfile', 'Makefile', 'Cargo.toml', 'CMakeLists.txt']) {
    assert.equal(scoreFile(rel, CONFIG_SIZE), 900, `${rel} 应得到根配置分 900`)
  }
})

test('大小写策略统一：小写变体同样按配置评分', () => {
  assert.equal(scoreFile('dockerfile', CONFIG_SIZE), 900)
  assert.equal(scoreFile('makefile', CONFIG_SIZE), 900)
  assert.equal(scoreFile('cargo.toml', CONFIG_SIZE), 900)
})

test('验收：补齐的 Electron / Tailwind / PostCSS 配置被识别', () => {
  for (const rel of [
    'electron.vite.config.ts',
    'electron-builder.yml',
    'tailwind.config.js',
    'tailwind.config.ts',
    'postcss.config.cjs',
    'postcss.config.mjs'
  ]) {
    assert.equal(scoreFile(rel, CONFIG_SIZE), 900, `${rel} 应得到配置分`)
    assert.ok(isCoarseCandidate(rel), `${rel} 应进入粗粒度候选`)
  }
})

test('目录深度：子目录同名配置仍按配置评分但低于根配置（不冒充根配置）', () => {
  const root = scoreFile('package.json', CONFIG_SIZE)
  const nested = scoreFile('packages/app/package.json', CONFIG_SIZE)
  const deep = scoreFile('a/b/c/package.json', CONFIG_SIZE)
  assert.equal(root, 900)
  assert.equal(nested, 800)
  assert.ok(deep < nested, '越深分越低')
  assert.ok(nested > scoreFile('packages/app/util.ts', CONFIG_SIZE), '浅层配置仍应高于同目录普通代码')
  assert.ok(isCoarseCandidate('packages/app/package.json'), '子目录配置仍进入粗粒度候选')
})

test('深度惩罚单调递减，深层同名文件逐渐失去配置优势', () => {
  const deepConfig = scoreFile('a/b/c/d/package.json', CONFIG_SIZE)
  assert.equal(deepConfig, 700)
  assert.ok(deepConfig > scoreFile('src/util.ts', CONFIG_SIZE), '中等深度的配置仍优先于普通代码')
  // 越深越接近普通代码分（900 - (d-1)*50 单调递减）
  const deeper = scoreFile('a/b/c/d/e/f/g/package.json', CONFIG_SIZE)
  assert.equal(deeper, 550)
  assert.ok(deeper < deepConfig)
})

test('粗粒度候选：文档/配置入选，业务源码排除', () => {
  assert.ok(isCoarseCandidate('README.md'))
  assert.ok(isCoarseCandidate('docs/notes.txt'))
  assert.ok(isCoarseCandidate('docker-compose.yml'))
  assert.ok(!isCoarseCandidate('src/app.ts'), '业务源码不进入粗粒度')
  assert.ok(!isCoarseCandidate('lib/utils.py'), '业务源码不进入粗粒度')
})
