import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import { getProjectContentApproval, identityFromBigIntStats, sameFileSystemIdentity } from './project-snapshot.ts'
import type { FileSystemIdentity } from './project-snapshot.ts'
// @ts-ignore TS5097 -- Node executes this module through the direct TypeScript runner.
import type { ScanResult, ScannedFile } from './scanner.ts'

const BOUNDARY_MESSAGE = '项目文件在读取期间发生变化，请重新扫描后重试。'

export class ProjectContentBoundaryError extends Error {
  constructor() {
    super(BOUNDARY_MESSAGE)
    this.name = 'ProjectContentBoundaryError'
  }
}

export interface ProjectContentIO {
  lstat(path: string): Promise<import('node:fs').BigIntStats>
  realpath(path: string): Promise<string>
  open(path: string, flags: string | number): Promise<ProjectContentHandle>
}

export interface ProjectContentHandle {
  stat(options: { bigint: true }): Promise<import('node:fs').BigIntStats>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>
  close(): Promise<void>
}

const defaultIO: ProjectContentIO = {
  lstat: (filePath) => fs.lstat(filePath, { bigint: true }),
  realpath: (filePath) => fs.realpath(filePath),
  open: (filePath, flags) => fs.open(filePath, flags)
}

function rejectBoundary(): never {
  throw new ProjectContentBoundaryError()
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function validatedSegments(relPath: string): string[] {
  if (!relPath || (process.platform === 'win32' && relPath.includes('\\')) || path.posix.isAbsolute(relPath)) return rejectBoundary()
  const segments = relPath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) return rejectBoundary()
  return segments
}

function assertIdentity(expected: FileSystemIdentity | undefined, stats: import('node:fs').BigIntStats): void {
  if (!stats.isFile() && !stats.isDirectory()) rejectBoundary()
  const current = identityFromBigIntStats(stats)
  if (!current || !sameFileSystemIdentity(expected, current)) rejectBoundary()
}

export function createProjectContentReader(io: Partial<ProjectContentIO> = {}): (scan: ScanResult, file: ScannedFile) => Promise<string> {
  const filesystem = { ...defaultIO, ...io }
  return async (scan, file) => {
    if (!file?.isContentCandidate) return rejectBoundary()
    const segments = validatedSegments(file.relPath)
    const approval = getProjectContentApproval(scan, file.relPath)
    if (!approval) return rejectBoundary()
    const { snapshot, file: approvedFile, directories } = approval
    const root = snapshot.identity.realPath
    const candidate = path.resolve(root, ...segments)
    if (!isContained(root, candidate) || segments.join('/') !== approvedFile.path) return rejectBoundary()
    const limit = snapshot.maxContentFileBytes
    const capturedSize = approvedFile.identity?.size
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || !Number.isSafeInteger(file.size) || file.size < 0 || capturedSize === undefined || capturedSize !== BigInt(file.size) || capturedSize > BigInt(limit) || capturedSize > BigInt(Number.MAX_SAFE_INTEGER)) return rejectBoundary()

    const checkPathChain = async (): Promise<void> => {
      if (await filesystem.realpath(root) !== root) rejectBoundary()
      const rootStats = await filesystem.lstat(root)
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) rejectBoundary()
      assertIdentity(directories[0]?.identity, rootStats)
      for (let index = 1; index < directories.length; index++) {
        const entry = directories[index]
        const directoryPath = path.join(root, ...entry.path.split('/'))
        const stats = await filesystem.lstat(directoryPath)
        if (!stats.isDirectory() || stats.isSymbolicLink()) rejectBoundary()
        assertIdentity(entry.identity, stats)
      }
      const fileStats = await filesystem.lstat(candidate)
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) rejectBoundary()
      assertIdentity(approvedFile.identity, fileStats)
    }

    let handle: ProjectContentHandle | undefined
    try {
      await checkPathChain()
      const flags = process.platform === 'win32'
        ? fsSync.constants.O_RDONLY
        : fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0)
      handle = await filesystem.open(candidate, flags)
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile()) rejectBoundary()
      assertIdentity(approvedFile.identity, opened)

      const byteLength = Number(capturedSize)
      const buffer = Buffer.alloc(byteLength)
      let offset = 0
      while (offset < byteLength) {
        const result = await handle.read(buffer, offset, byteLength - offset, offset)
        if (result.bytesRead <= 0 || result.bytesRead > byteLength - offset) rejectBoundary()
        offset += result.bytesRead
      }
      if (offset !== byteLength) rejectBoundary()

      const afterRead = await handle.stat({ bigint: true })
      if (!afterRead.isFile()) rejectBoundary()
      assertIdentity(approvedFile.identity, afterRead)
      await checkPathChain()
      return buffer.toString('utf-8')
    } catch (error) {
      if (error instanceof ProjectContentBoundaryError) throw error
      return rejectBoundary()
    } finally {
      if (handle) await handle.close().catch(() => undefined)
    }
  }
}

export const readProjectContent = createProjectContentReader()
