import path from 'node:path'

/** True only for lexical filesystem roots; paths with parent segments are not normalized into roots. */
export function isFilesystemRoot(value: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(value) || value === '/'
}

/** Derive a stable, non-empty display name without changing the scanned path. */
export function projectDisplayName(projectPath: string): string {
  const driveRoot = projectPath.match(/^([A-Za-z]):[\\/]$/)
  if (driveRoot) return `磁盘 ${driveRoot[1].toUpperCase()}`
  if (projectPath === '/') return '文件系统根目录'

  const windowsPath = /^[A-Za-z]:[\\/]|^(?:\\\\|\/\/)/.test(projectPath)
  const name = windowsPath ? path.win32.basename(projectPath) : path.posix.basename(projectPath)
  return name
}
