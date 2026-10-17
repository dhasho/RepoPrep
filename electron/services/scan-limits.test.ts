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
import { renderScanWarnings } from './context-builder.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { ProjectScanCache } from './scan-cache.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { resolveScanLimits, scanLimitsKey, scanProject } from './scanner.ts'
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
