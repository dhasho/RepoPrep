// 扫描安全上限与截断提示的测试（issue #17）
//
// 覆盖验收标准：文件数 / 树节点 / 单文件大小三种上限的边界行为、
// 未触发上限时无警告、越界配置的夹取、以及不同上限的扫描缓存互不串用。
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { buildContext, renderScanWarnings } from './context-builder.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { ProjectScanCache } from './scan-cache.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { resolveScanLimits, scanLimitsKey, scanProject } from './scanner.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { CODE_EXTS, collectFileSignals, orderFilesForContext } from './file-selection.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { DEFAULT_SCAN_LIMITS, type ScanTruncation } from '../../shared/types.ts'

const createdRoots = new Set<string>()

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-limits-'))
  createdRoots.add(path.resolve(root))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf-8')
  }
  return root
}

async function removeProject(root: string): Promise<void> {
  const resolved = path.resolve(root)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, resolved)
  if (!createdRoots.has(resolved) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove path outside the controlled test root: ${resolved}`)
  }
  await fs.rm(resolved, { recursive: true, force: true })
  createdRoots.delete(resolved)
}

test('边界：文件数上限（达到上限才截断，恰好等于上限不截断）', async () => {
  const files = { 'a.ts': 'x', 'b.ts': 'x', 'c.ts': 'x' }
  const root = await makeProject(files)
  try {
    const atLimit = await scanProject(root, { maxFiles: 2 })
    assert.ok(atLimit.truncation, '超过上限必须产生截断信息')
    assert.equal(atLimit.truncation!.byFileCount, true)
    assert.equal(atLimit.truncation!.byTreeNodes, false, '只触发文件上限时不得误报树节点上限')
    assert.equal(atLimit.totalFiles, 2)
    assert.ok(atLimit.truncation!.estimatedSkipped >= 1, '至少 1 项未扫描')

    const exact = await scanProject(root, { maxFiles: 3 })
    assert.equal(exact.truncation, undefined, '恰好等于上限不应触发截断')
    assert.equal(exact.totalFiles, 3)
  } finally {
    await removeProject(root)
  }
})

test('公平调度：根清单优先，深层 z-core 入口不会被大量 a-files 源码挤掉', async () => {
  const files: Record<string, string> = { 'package.json': '{"name":"fixture"}', 'z-core/deep/entry.ts': 'export const core = true' }
  for (let index = 0; index < 40; index++) files[`a-files/file-${String(index).padStart(2, '0')}.ts`] = 'export const value = 1'
  const root = await makeProject(files)
  try {
    const scan = await scanProject(root, { maxFiles: 5, maxTreeNodes: 100 })
    const selected = new Set(scan.files.map((file) => file.relPath))
    assert.ok(selected.has('package.json'), '根目录清单应在普通目录内容前调度')
    assert.ok(selected.has('z-core/deep/entry.ts'), '较后目录中的深层入口应能竞争有限文件预算')
    assert.ok(scan.truncation?.byFileCount, '硬预算仍须准确报告发生截断')
    assert.ok(scan.truncation!.estimatedSkipped > 0)
    assert.equal(scan.files.length, 5)
  } finally {
    await removeProject(root)
  }
})

test('扫描调度与文件选择契约：选择器支持的常见入口扩展名在硬上限下仍可达', async () => {
  const selectorEntryExts = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java']
  for (const ext of selectorEntryExts) {
    assert.ok(CODE_EXTS.has(ext), `${ext} 应仍是文件选择器支持的代码扩展名`)
    const entryPath = `main.${ext}`
    const files = {
      'package.json': JSON.stringify({ main: entryPath }),
      [entryPath]: 'export const entry = true',
      [`src/main.${ext}`]: 'export const nestedEntry = true',
      [`a000.${ext}`]: 'export const ordinary = true'
    }
    const root = await makeProject(files)
    try {
      for (const limits of [{ maxFiles: 2, maxTreeNodes: 50 }, { maxFiles: 50, maxTreeNodes: 2 }]) {
        const scan = await scanProject(root, limits)
        const selected = new Set(scan.files.map((file) => file.relPath))
        assert.ok(selected.has('package.json'), `${ext}: manifest should fit the hard budget`)
        assert.ok(selected.has(entryPath), `${ext}: declared root entry should fit the hard budget`)
        assert.ok(scan.truncation, `${ext}: the independent hard budget should still report truncation`)

        const contents = new Map(scan.files.map((file) => [file.relPath, files[file.relPath as keyof typeof files]]))
        const signals = collectFileSignals(scan.files, contents)
        assert.ok(signals.entryPaths.has(entryPath), `${ext}: manifest entry should remain visible to file selection`)
        const fineOrder = orderFilesForContext(scan.files, 'fine', signals).map((file) => file.relPath)
        assert.ok(fineOrder.indexOf(entryPath) >= 0, `${ext}: declared entry should remain selectable for fine context`)
        assert.ok(!orderFilesForContext(scan.files, 'coarse', signals).some((file) => file.relPath === entryPath), `${ext}: code entry should remain outside coarse context`)
      }

      if (ext === 'mts' || ext === 'cts' || ext === 'mjs' || ext === 'cjs') {
        const scan = await scanProject(root, { maxFiles: 20, maxTreeNodes: 20 })
        const keyPaths = new Set(scan.keyFiles.map((file) => file.path))
        assert.ok(keyPaths.has(entryPath), `${ext}: root entry should be reported as a key file`)
        assert.ok(keyPaths.has(`src/main.${ext}`), `${ext}: shallow entry should be reported as a key file`)
      }
    } finally {
      await removeProject(root)
    }
  }
})

test('深层入口在文件数与树节点硬上限下优先于同目录普通源码', async () => {
  const deepEntryExts = ['mts', 'cts', 'mjs', 'cjs', 'rs', 'c']
  const deepEntries = ['lib.rs', 'mod.rs', 'main.c']
  for (const entryName of [...deepEntryExts.map((ext) => `main.${ext}`), ...deepEntries]) {
    const entryPath = `src/deep/${entryName}`
    const ordinaryPath = `src/deep/a000.${entryName.endsWith('.rs') ? 'rs' : entryName.endsWith('.c') ? 'c' : entryName.split('.').at(-1)}`
    const files = {
      'package.json': JSON.stringify({ main: entryPath }),
      [ordinaryPath]: 'ordinary source',
      [entryPath]: 'export const entry = true'
    }
    const root = await makeProject(files)
    try {
      for (const { limits, truncationFlag } of [
        { limits: { maxFiles: 2, maxTreeNodes: 50 }, truncationFlag: 'byFileCount' },
        { limits: { maxFiles: 50, maxTreeNodes: 4 }, truncationFlag: 'byTreeNodes' }
      ] as const) {
        const scan = await scanProject(root, limits)
        const selected = new Set(scan.files.map((file) => file.relPath))
        assert.ok(selected.has('package.json'), `${entryName}: manifest should fit the hard budget`)
        assert.ok(selected.has(entryPath), `${entryName}: deep entry should beat its same-directory ordinary source`)
        assert.ok(!selected.has(ordinaryPath), `${entryName}: ordinary source should not consume the remaining budget first`)
        assert.equal(scan.truncation?.[truncationFlag], true, `${entryName}: the reached hard budget should be reported`)

        const contents = new Map(scan.files.map((file) => [file.relPath, files[file.relPath as keyof typeof files]]))
        const signals = collectFileSignals(scan.files, contents)
        assert.ok(signals.entryPaths.has(entryPath), `${entryName}: manifest entry should remain visible to file selection`)
        assert.ok(orderFilesForContext(scan.files, 'fine', signals).some((file) => file.relPath === entryPath), `${entryName}: deep entry should remain selectable for fine context`)
      }
    } finally {
      await removeProject(root)
    }
  }
})

test('公平调度：创建顺序不影响选择顺序和最终文件树顺序', async () => {
  const entries = [
    ['package.json', '{}'], ['a-files/z.ts', 'z'], ['a-files/a.ts', 'a'],
    ['z-core/deep/entry.ts', 'core'], ['z-core/README.md', 'readme']
  ] as const
  const first = await makeProject(Object.fromEntries(entries))
  const second = await makeProject(Object.fromEntries([...entries].reverse()))
  try {
    const limits = { maxFiles: 4, maxTreeNodes: 20 }
    const a = await scanProject(first, limits)
    const b = await scanProject(second, limits)
    assert.deepEqual(a.files.map((file) => file.relPath), b.files.map((file) => file.relPath))
    assert.deepEqual((a.tree.children ?? []).map((node) => node.path), (b.tree.children ?? []).map((node) => node.path))
    assert.deepEqual((a.tree.children ?? []).map((node) => node.name), ['a-files', 'z-core', 'package.json'])
  } finally {
    await removeProject(first)
    await removeProject(second)
  }
})

test('深层常见入口优先：超过 1000 个 a-files 时仍选入 z-core/deep/main.ts', async () => {
  const files: Record<string, string> = {
    'package.json': '{}',
    'z-core/deep/aaa.ts': 'lower priority source',
    'z-core/deep/main.ts': 'export const core = true'
  }
  for (let index = 0; index < 1200; index++) files[`a-files/file-${String(index).padStart(4, '0')}.ts`] = 'export const value = 1'
  const root = await makeProject(files)
  try {
    const scan = await scanProject(root, { maxFiles: 5, maxTreeNodes: 100 })
    const selected = new Set(scan.files.map((file) => file.relPath))
    assert.ok(selected.has('z-core/deep/main.ts'), '常见入口优先级应与目录深度无关')
    assert.ok(!selected.has('z-core/deep/aaa.ts'), '同目录普通文件不能抢在入口前耗尽预算')
    assert.ok(scan.truncation?.byFileCount)
    assert.equal(scan.files.length, 5)
  } finally {
    await removeProject(root)
  }
})

test('边界：树节点上限（目录与文件都计入）', async () => {
  // 树节点：根不计，2 个目录 + 4 个文件 = 6
  const root = await makeProject({
    'd1/a.ts': 'x',
    'd1/b.ts': 'x',
    'd2/c.ts': 'x',
    'd2/d.ts': 'x'
  })
  try {
    const scan = await scanProject(root, { maxTreeNodes: 4 })
    assert.ok(scan.truncation, '低于树节点总数必须截断')
    assert.equal(scan.truncation!.byTreeNodes, true)
    assert.equal(scan.truncation!.byFileCount, false, '文件数远低于上限时不得误报')

    const exact = await scanProject(root, { maxTreeNodes: 6 })
    assert.equal(exact.truncation, undefined, '恰好等于树节点总数不应截断')
  } finally {
    await removeProject(root)
  }
})

test('锁文件保留在树和快照中但不批准正文，正文变化仍使缓存失效', async () => {
  const lockNames = [
    'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-lock.yml', 'yarn.lock',
    'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock',
    'Gemfile.lock', 'go.sum', 'packages.lock.json', 'gradle.lockfile'
  ]
  const files = Object.fromEntries(lockNames.map((name) => [`locks/${name}`, `synthetic-lock-secret-${name}`]))
  const root = await makeProject({ ...files, 'src/main.ts': 'export const main = true' })
  try {
    const cache = new ProjectScanCache()
    const first = await cache.getFresh(root)
    assert.equal(first.status, 'scanned')
    const byPath = new Map(first.scan.files.map((file) => [file.relPath, file]))
    for (const name of lockNames) {
      const relPath = `locks/${name}`
      assert.ok(byPath.has(relPath), `${relPath} remains visible in the scan tree`)
      assert.equal(byPath.get(relPath)!.isContentCandidate, false, `${relPath} must not be approved for body reads`)
    }
    const context = await buildContext(first.scan, 'fine')
    const contextText = JSON.stringify(context)
    for (const name of lockNames) assert.ok(context.treeText.includes(name), `${name} remains visible in the context tree`)
    assert.doesNotMatch(contextText, /synthetic-lock-secret|changed-lock-body/)

    const changedLock = path.join(root, 'locks', 'Cargo.lock')
    await fs.writeFile(changedLock, 'changed-lock-body')
    const refreshed = await cache.getFresh(root)
    assert.equal(refreshed.status, 'scanned')
    assert.equal(refreshed.reason, 'changed', 'snapshot metadata still observes changes to excluded bodies')
    assert.equal(refreshed.scan.files.find((file) => file.relPath === 'locks/Cargo.lock')!.isContentCandidate, false)
  } finally {
    await removeProject(root)
  }
})

test('边界：单文件大小上限（恰好等于上限仍纳入，超过才排除）', async () => {
  const root = await makeProject({
    'equal.ts': 'ab'.repeat(1024), // 2048 字节
    'over.ts': 'x'.repeat(3000) // 3000 字节
  })
  try {
    const scan = await scanProject(root, { maxContentFileBytes: 2048 })
    assert.ok(scan.truncation, '有文件超限必须产生截断信息')
    assert.equal(scan.truncation!.byFileCount, false)
    assert.equal(scan.truncation!.byTreeNodes, false)
    assert.equal(scan.truncation!.oversizedFiles, 1, '只有超过上限的文件被计入 oversized')

    const byPath = new Map(scan.files.map((f) => [f.relPath, f]))
    assert.equal(byPath.get('equal.ts')!.isContentCandidate, true, '恰好等于上限的文件仍纳入阅读')
    assert.equal(byPath.get('over.ts')!.isContentCandidate, false, '超过上限的文件不纳入阅读')

    const none = await scanProject(root, { maxContentFileBytes: 3000 })
    assert.equal(none.truncation, undefined, '全部文件不超限时不应有截断信息')
  } finally {
    await removeProject(root)
  }
})

test('resolveScanLimits：缺省用默认值，越界与非法值被夹取', () => {
  assert.deepEqual(resolveScanLimits(undefined), DEFAULT_SCAN_LIMITS)
  assert.deepEqual(resolveScanLimits({}), DEFAULT_SCAN_LIMITS)
  assert.deepEqual(resolveScanLimits({ maxFiles: 100 }), { ...DEFAULT_SCAN_LIMITS, maxFiles: 100 })
  // 越界夹取
  assert.equal(resolveScanLimits({ maxFiles: 0 }).maxFiles, 1)
  assert.equal(resolveScanLimits({ maxFiles: 999_999 }).maxFiles, 250_000)
  assert.equal(resolveScanLimits({ maxTreeNodes: -5 }).maxTreeNodes, 1)
  assert.equal(resolveScanLimits({ maxContentFileBytes: 999_999_999 }).maxContentFileBytes, 8 * 1024 * 1024)
  // 非法值回退默认
  assert.equal(resolveScanLimits({ maxFiles: Number.NaN }).maxFiles, DEFAULT_SCAN_LIMITS.maxFiles)
  assert.equal(resolveScanLimits({ maxFiles: 1.5 }).maxFiles, 1, '小数向下取整')
})

test('scanLimitsKey：不同上限产生不同缓存键，相同上限键一致', () => {
  const a = resolveScanLimits({ maxFiles: 2 })
  const b = resolveScanLimits({ maxFiles: 3 })
  assert.notEqual(scanLimitsKey(a), scanLimitsKey(b))
  assert.equal(scanLimitsKey(resolveScanLimits({ maxFiles: 2 })), scanLimitsKey(a), '部分覆盖 + 默认值合成后应稳定')
})

test('扫描缓存：不同上限的结果互不串用，同上限可复用', async () => {
  const root = await makeProject({ 'a.ts': 'x', 'b.ts': 'x', 'c.ts': 'x' })
  try {
    const cache = new ProjectScanCache()
    const first = await cache.getFresh(root, { maxFiles: 2 })
    assert.equal(first.status, 'scanned')
    assert.equal(first.scan.truncation?.byFileCount, true)

    const other = await cache.getFresh(root, { maxFiles: 3 })
    assert.equal(other.status, 'scanned', '不同上限不得复用另一个上限的缓存')
    assert.equal(other.scan.truncation, undefined, '上限放宽后不应再带截断信息')

    const again = await cache.getFresh(root, { maxFiles: 2 })
    assert.equal(again.status, 'reused', '同上限应复用缓存')
    assert.ok(again.scan.truncation?.byFileCount, '复用的结果保留其截断信息')
  } finally {
    await removeProject(root)
  }
})

test('renderScanWarnings：按触发原因渲染警告，未触发返回空串', () => {
  const limits = { maxFiles: 50_000, maxTreeNodes: 100_000, maxContentFileBytes: 1024 * 1024 }
  const base: ScanTruncation = {
    byFileCount: false,
    byTreeNodes: false,
    oversizedFiles: 0,
    estimatedSkipped: 0,
    limits
  }
  assert.equal(renderScanWarnings(base), '', '未触发任何上限时不应有警告')

  const file = renderScanWarnings({ ...base, byFileCount: true, estimatedSkipped: 7 })
  assert.ok(file.includes('文件数达到上限（50000）'))
  assert.ok(file.includes('至少还有 7 项未扫描'))
  assert.ok(file.includes('不完整'), '警告必须说明上下文不完整')

  const tree = renderScanWarnings({ ...base, byTreeNodes: true })
  assert.ok(tree.includes('树节点数达到上限（100000）'))

  const oversize = renderScanWarnings({ ...base, oversizedFiles: 3 })
  assert.ok(oversize.includes('3 个文件超过单文件大小上限'))
  assert.ok(oversize.includes('1024KB'))
})
