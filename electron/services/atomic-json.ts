import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type BoundedRead =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'missing' }
  | { status: 'unreadable' }

const ORPHAN_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
const ORPHAN_TEMP_CLEANUP_LIMIT = 10
const ORPHAN_TEMP_SCAN_LIMIT = 512

function tempPrefix(file: string): string {
  return `.${path.basename(file)}.projectlens-`
}

function isMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function readBounded(file: string, maxBytes: number): BoundedRead {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch (error) {
    return isMissingError(error) ? { status: 'missing' } : { status: 'unreadable' }
  }
  let result: BoundedRead = { status: 'unreadable' }
  let closeFailed = false
  try {
    const before = fs.fstatSync(fd)
    if (before.isFile() && before.size <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, before.size + 1))
      let offset = 0
      while (offset < buffer.byteLength) {
        const read = fs.readSync(fd, buffer, offset, buffer.byteLength - offset, offset)
        if (read === 0) break
        offset += read
      }
      const after = fs.fstatSync(fd)
      if (offset <= maxBytes && offset === before.size && after.size === before.size) {
        result = { status: 'ok', bytes: Buffer.from(buffer.subarray(0, offset)) }
      }
    }
  } catch {
    result = { status: 'unreadable' }
  } finally {
    try { fs.closeSync(fd) } catch {
      closeFailed = true
      try { fs.closeSync(fd) } catch { /* best effort descriptor cleanup */ }
    }
  }
  return closeFailed ? { status: 'unreadable' } : result
}

function writeTemp(file: string, bytes: Buffer): string {
  const directory = path.resolve(path.dirname(file))
  const prefix = tempPrefix(file)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temp = path.resolve(directory, `${prefix}${process.pid}-${randomBytes(12).toString('hex')}.tmp`)
    if (path.dirname(temp) !== directory) throw new Error('Invalid temporary storage path')
    let fd: number | undefined
    let created = false
    try {
      fd = fs.openSync(temp, 'wx', 0o600)
      created = true
      let offset = 0
      while (offset < bytes.byteLength) {
        const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset)
        if (written <= 0) throw new Error('Temporary storage write did not progress')
        offset += written
      }
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      return temp
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* best effort descriptor cleanup */ }
      }
      if (created) {
        try { fs.rmSync(temp, { force: true }) } catch { /* best effort temporary cleanup */ }
      }
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('Could not allocate temporary storage file')
}

function replaceBytes(destination: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temp = writeTemp(destination, bytes)
  try {
    fs.renameSync(temp, destination)
  } catch (error) {
    try { fs.rmSync(temp, { force: true }) } catch { /* best effort temporary cleanup */ }
    throw error
  }
}

/** Atomically replace a file from fully written, synced, and closed same-directory bytes. */
export function atomicReplaceBytes(destination: string, bytes: Buffer): void {
  replaceBytes(destination, bytes)
}

/** Keep a single atomic snapshot beside the target. */
export function writeBackup(target: string, bytes: Buffer): void {
  replaceBytes(`${target}.bak`, bytes)
}

/** Keep a single atomic copy of corrupt source bytes beside the target. */
export function archiveCorrupt(target: string, bytes: Buffer): void {
  replaceBytes(`${target}.corrupt`, bytes)
}

/** Remove only old temp files bearing this target's private helper prefix. */
export function cleanupOrphanTemps(target: string, now = Date.now()): number {
  const directory = path.resolve(path.dirname(target))
  const prefixes = [tempPrefix(target), tempPrefix(`${target}.bak`), tempPrefix(`${target}.corrupt`)]
  let handle: fs.Dir
  try {
    handle = fs.opendirSync(directory)
  } catch {
    return 0
  }
  let removed = 0
  let inspected = 0
  try {
    while (removed < ORPHAN_TEMP_CLEANUP_LIMIT && inspected < ORPHAN_TEMP_SCAN_LIMIT) {
      const entry = handle.readSync()
      if (!entry) break
      inspected += 1
      const name = entry.name
      const prefix = prefixes.find((candidate) => name.startsWith(candidate))
      if (!prefix) continue
      const match = /^(\d+)-[a-f0-9]{24}\.tmp$/.exec(name.slice(prefix.length))
      if (!match) continue
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue
      try {
        process.kill(pid, 0)
        continue
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        if (code !== 'ESRCH') continue
      }
      const candidate = path.resolve(directory, name)
      if (path.dirname(candidate) !== directory) continue
      try {
        const stat = fs.lstatSync(candidate)
        if (!stat.isFile() || now - stat.mtimeMs < ORPHAN_TEMP_MAX_AGE_MS) continue
        fs.rmSync(candidate)
        removed += 1
      } catch {
        // Orphan cleanup is best effort and never changes the read outcome.
      }
    }
  } finally {
    try { handle.closeSync() } catch {
      try { handle.closeSync() } catch { /* best effort directory cleanup */ }
    }
  }
  return removed
}
