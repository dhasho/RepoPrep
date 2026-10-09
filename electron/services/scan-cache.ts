import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import type { ScanLimits } from '../../shared/types'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { captureProjectSnapshot, isProjectSnapshotCurrent, resolveProjectIdentity } from './project-snapshot.ts'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { resolveScanLimits, scanLimitsKey, scanProject, type ScanResult } from './scanner.ts'

type Snapshot = Awaited<ReturnType<typeof captureProjectSnapshot>>
type CacheEntry = { scan: ScanResult; snapshot: Snapshot; identityKey: string }
export type ProjectScanCacheResult = {
  scan: ScanResult
  status: 'reused' | 'scanned'
  reason?: 'missing' | 'changed' | 'forced'
}

function lexicalKey(input: string): string {
  const normalized = path.resolve(input)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 缓存键 = 项目身份 + 生效扫描上限（issue #17）：
 * 上限不同的扫描结果不同（截断状态不同），必须分开存放，否则改上限后
 * 会一直复用旧上限的扫描结果，截断提示也随之失真。
 * 分隔符用 '\\0'：路径里不可能出现，因此按 `${identityKey}\\0` 前缀清理
 * 某项目的全部上限变体时，绝不会误扫到身份键恰好以它为前缀的兄弟项目。
 */
function composedKey(identityKey: string, limits?: Partial<ScanLimits>): string {
  return `${identityKey}\0${scanLimitsKey(resolveScanLimits(limits))}`
}

export class ProjectScanCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly aliases = new Map<string, string>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly capacity: number

  constructor(capacity = 8) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer')
    this.capacity = capacity
  }

  get size(): number { return this.entries.size }

  async getFresh(projectPath: string, limits?: Partial<ScanLimits>): Promise<ProjectScanCacheResult> {
    return this.withIdentity(projectPath, async (identity) => {
      const key = composedKey(identity.key, limits)
      const cached = this.entries.get(key)
      if (cached) {
        if (await isProjectSnapshotCurrent(cached.snapshot)) {
          this.touch(key, cached)
          return { scan: cached.scan, status: 'reused' }
        }
        this.entries.delete(key)
        return this.scanAndStore(key, identity.key, identity.realPath, 'changed', limits)
      }
      return this.scanAndStore(key, identity.key, identity.realPath, 'missing', limits)
    })
  }

  async refresh(projectPath: string, limits?: Partial<ScanLimits>): Promise<ProjectScanCacheResult> {
    return this.withIdentity(projectPath, async (identity) => {
      this.dropAllLimits(identity.key)
      return this.scanAndStore(composedKey(identity.key, limits), identity.key, identity.realPath, 'forced', limits)
    })
  }

  async invalidate(projectPath: string): Promise<void> {
    const lexical = lexicalKey(projectPath)
    let key = this.aliases.get(lexical) ?? lexical
    try {
      const identity = await resolveProjectIdentity(projectPath)
      key = identity.key
      this.linkAlias(lexical, key)
    } catch { /* A deleted path is still invalidated by its lexical identity. */ }
    await this.withKey(key, async () => {
      this.dropAllLimits(key)
      this.clearAliases(key)
    })
  }

  /** 删除某项目身份下所有上限变体的缓存条目 */
  private dropAllLimits(identityKey: string): void {
    this.entries.delete(identityKey)
    for (const existing of [...this.entries.keys()]) {
      if (existing.startsWith(`${identityKey}\0`)) this.entries.delete(existing)
    }
  }

  private async withIdentity<T>(projectPath: string, operation: (identity: Awaited<ReturnType<typeof resolveProjectIdentity>>) => Promise<T>): Promise<T> {
    const lexical = lexicalKey(projectPath)
    let identity: Awaited<ReturnType<typeof resolveProjectIdentity>>
    try {
      identity = await resolveProjectIdentity(projectPath)
    } catch (error) {
      const oldKey = this.aliases.get(lexical) ?? lexical
      await this.withKey(oldKey, async () => {
        // 项目目录已删除等情况：连同所有上限变体的缓存一起清掉
        this.dropAllLimits(oldKey)
        this.entries.delete(lexical)
        this.clearAliases(oldKey)
      })
      throw error
    }
    this.linkAlias(lexical, identity.key)
    return this.withKey(identity.key, () => operation(identity))
  }

  private async withKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => gate)
    this.queues.set(key, queued)
    await previous
    try { return await operation() }
    finally {
      release()
      if (this.queues.get(key) === queued) this.queues.delete(key)
    }
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.enforceCapacity()
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      const entry = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (entry) this.clearAliases(entry.identityKey)
    }
  }

  /**
   * 扫描并（在快照可信且稳定时）写入缓存。
   *
   * 注意这里的代价：每轮 attempt 是「扫描一遍 + 校验一遍」两轮完整元数据遍历，
   * 校验失败时最多重试一轮，因此单次调用最多产生 4 轮遍历；首轮生成没有可复用
   * 的缓存，同样要付这个代价。这是为换取「不复用中途发生变化的扫描结果」而做的
   * 有意取舍，取舍的细节记在 project-snapshot.ts 的 isProjectSnapshotCurrent 上。
   */
  private async scanAndStore(
    key: string,
    identityKey: string,
    realPath: string,
    reason: 'missing' | 'changed' | 'forced',
    limits?: Partial<ScanLimits>
  ): Promise<ProjectScanCacheResult> {
    this.entries.delete(key)
    for (let attempt = 0; attempt < 2; attempt++) {
      let scan: ScanResult
      let snapshot: Snapshot
      try {
        scan = await scanProject(realPath, limits)
        snapshot = await captureProjectSnapshot(scan)
      } catch (error) {
        this.entries.delete(key)
        this.clearAliases(identityKey)
        throw error
      }
      if (!snapshot.valid) {
        this.entries.delete(key)
        this.clearAliases(identityKey)
        return { scan, status: 'scanned', reason }
      }
      if (!(await isProjectSnapshotCurrent(snapshot))) continue
      this.entries.set(key, { scan, snapshot, identityKey })
      this.enforceCapacity()
      return { scan, status: 'scanned', reason }
    }
    this.entries.delete(key)
    this.clearAliases(identityKey)
    throw new Error(`项目在扫描期间持续变化，请稍后重试：${realPath}`)
  }

  private linkAlias(alias: string, key: string): void {
    this.aliases.delete(alias)
    this.aliases.set(alias, key)
    while (this.aliases.size > this.capacity * 4) {
      const oldest = this.aliases.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.aliases.delete(oldest)
    }
  }

  private clearAliases(key: string): void {
    for (const [alias, target] of this.aliases) if (target === key) this.aliases.delete(alias)
  }
}
