import fs from 'node:fs/promises'
import path from 'node:path'
import type { ScanResult } from './scanner'

export interface ProjectIdentity {
  realPath: string
  key: string
}

export interface SnapshotEntry {
  path: string
  type: 'file' | 'dir' | 'missing'
  size?: number
  mtimeMs?: number
  ctimeMs?: number
  /** Exact names returned by readdir when this directory was captured. */
  names?: string[]
}

export interface ProjectSnapshot {
  identity: ProjectIdentity
  entries: SnapshotEntry[]
  valid: boolean
}

const snapshots = new WeakMap<ScanResult, ProjectSnapshot>()

/** Called by the scanner with metadata observed during traversal. */
export function recordProjectSnapshot(scan: ScanResult, snapshot: ProjectSnapshot): void {
  snapshots.set(scan, snapshot)
}

export async function resolveProjectIdentity(inputPath: string): Promise<ProjectIdentity> {
  const realPath = await fs.realpath(path.resolve(inputPath))
  const normalized = path.normalize(realPath)
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return { realPath, key }
}

export async function captureProjectSnapshot(scan: ScanResult): Promise<ProjectSnapshot> {
  const snapshot = snapshots.get(scan)
  if (!snapshot) return { identity: await resolveProjectIdentity(scan.root), entries: [], valid: false }
  return snapshot
}

/** 并发上限：校验是纯 I/O，串行等待会让大项目多付一整轮遍历的墙钟时间。 */
const VALIDATION_CONCURRENCY = 32

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 校验快照是否仍然对应当前磁盘状态。
 *
 * 这里会对项目做一遍完整的元数据遍历，也就是一次 `getFresh` 总共有两轮遍历
 * （扫描一轮 + 校验一轮），首轮生成也要付这个代价。这是为消除“扫描期间项目发生变化”
 * 的竞态而做的有意取舍：一次扫描是跨越许多次系统调用的过程，单靠扫描过程中读到的
 * 元数据无法证明扫描结果对应某一个一致的时间点；扫描结束后再独立校验一遍，才能
 * 保证“要么快照与结果一致，要么判定为变化”。另有一轮校验来自 scanAndStore 的自校验。
 *
 * 边界要说清楚：校验只覆盖本次扫描真正物化出来的条目（含各目录的 names）。因此
 * 被 MAX_WALK_FILES / MAX_TREE_NODES 截断在外的目录，其内容变化不会被发现 —— 那也
 * 是安全的，因为那些文件本来就不在扫描结果里，扫描的截断点由确定性的遍历顺序决定，
 * 不会因为它们的增删而改变可见集合。真正的优化方向是让 scanner 输出它已经读到的
 * 元数据、把两轮合成一轮，而不是放松校验。
 *
 * 每个条目的 stat 仍然必须逐个比对，但按目录并发执行，避免在几千个文件的项目上
 * 串行等待。
 */
export async function isProjectSnapshotCurrent(snapshot: ProjectSnapshot): Promise<boolean> {
  try {
    if (!snapshot || snapshot.valid !== true || !snapshot.identity || !Array.isArray(snapshot.entries)) return false
    const identity = await resolveProjectIdentity(snapshot.identity.realPath)
    if (identity.key !== snapshot.identity.key) return false

    const resolveEntryPath = (entry: SnapshotEntry): string =>
      entry.path ? path.join(identity.realPath, ...entry.path.split('/')) : identity.realPath

    const checkEntry = async (entry: SnapshotEntry): Promise<boolean> => {
      const absPath = resolveEntryPath(entry)
      if (entry.type === 'missing') {
        try {
          await fs.stat(absPath)
          return false
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
          return true
        }
      }

      const stats = await fs.stat(absPath)
      if ((entry.type === 'dir' && !stats.isDirectory()) || (entry.type === 'file' && !stats.isFile())) return false
      if (stats.size !== entry.size || stats.mtimeMs !== entry.mtimeMs || stats.ctimeMs !== entry.ctimeMs) return false

      if (entry.type !== 'dir') return true
      if (!entry.names) return false
      // 必须用与 scanner 完全相同的排序规则：scanner 记录 names 时用的是默认的
      // Array.prototype.sort()（即字符串的 UTF-16 码元序），这里换成 localeCompare
      // 会让含非 ASCII 名称的项目在排序结果不同时被误判为“已变化”并反复重扫。
      const currentNames = ((await fs.readdir(absPath)) as string[]).sort()
      if (currentNames.length !== entry.names.length) return false
      for (let i = 0; i < currentNames.length; i++) {
        if (currentNames[i] !== entry.names[i]) return false
      }
      return true
    }

    const results = await mapWithConcurrency(snapshot.entries, VALIDATION_CONCURRENCY, checkEntry)
    return results.every(Boolean)
  } catch {
    return false
  }
}
