import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Minimal Electron-shaped types keep the authority checks directly unit-testable. */
export interface IpcFrameLike {
  url: string
  processId?: number
  routingId?: number
}

export interface IpcWebContentsLike {
  mainFrame: IpcFrameLike
}

export interface IpcEventLike {
  sender: IpcWebContentsLike
  senderFrame: IpcFrameLike | null
}

const MAX_PROJECT_PATH_LENGTH = 4_096

function trustedUrlMatches(actualValue: string, trustedValue: string): boolean {
  try {
    const actual = new URL(actualValue)
    const trusted = new URL(trustedValue)

    if (trusted.protocol === 'http:' || trusted.protocol === 'https:') {
      if (
        actual.protocol !== trusted.protocol ||
        actual.origin !== trusted.origin ||
        actual.username !== '' ||
        actual.password !== '' ||
        trusted.username !== '' ||
        trusted.password !== ''
      ) {
        return false
      }

      // The renderer has no client-side routes. Treat only the root document and
      // its conventional index filename as aliases; keep all other path bytes and
      // query parameters exact so URL tricks cannot widen trust.
      //
      // 片段（hash）不参与比对，且这是有意与 installWindowSecurity 的导航策略保持一致：
      // 那里把片段导航当作应用内跳转放行（"fragments are app-local navigation"）。
      // 若这里要求 hash 逐字节相等，应用内跳到 #anchor 之后所有 IPC 都会被拒。
      // 片段只在渲染进程内部生效，不参与任何网络或文件解析，放宽它不会扩大信任边界。
      const pagePath = (url: URL): string =>
        url.pathname === '/' ? '/index.html' : url.pathname

      return pagePath(actual) === pagePath(trusted) && actual.search === trusted.search
    }

    // 打包后只信任一个确切的本地文件。比较解析后的文件路径而不是 URL 字符串：
    // 窗口既可能由 loadFile 加载、也可能由 loadURL(pathToFileURL(...)) 加载，
    // 两者对空格、非 ASCII 字符的百分号编码未必逐字节一致，而 href 全等会让
    // 这种差异表现为“所有 IPC 被拒”。
    if (trusted.protocol !== 'file:') return false
    if (actual.hostname !== '' || trusted.hostname !== '') return false
    const actualPath = path.resolve(fileURLToPath(actual))
    const trustedPath = path.resolve(fileURLToPath(trusted))
    const samePath = process.platform === 'win32'
      ? actualPath.toLowerCase() === trustedPath.toLowerCase()
      : actualPath === trustedPath
    return samePath && actual.search === trusted.search
  } catch {
    return false
  }
}

/** Reject IPC messages unless they come from the current window's trusted main frame. */
export function assertTrustedIpcSender(
  event: IpcEventLike,
  expectedWebContents: IpcWebContentsLike,
  trustedRendererUrl: string
): void {
  const frame = event.senderFrame
  if (
    event.sender !== expectedWebContents ||
    !frame ||
    frame !== event.sender.mainFrame ||
    frame !== expectedWebContents.mainFrame ||
    !trustedUrlMatches(frame.url, trustedRendererUrl)
  ) {
    // Do not include attacker-controlled frame URL in the error.
    throw new Error('拒绝来自未授权渲染器的 IPC 请求')
  }
}

/** 当前窗口的主框架是否就是这条 IPC 的发送者。纯函数，便于在测试中直接断言。 */
export function isTrustedIpcSender(event: IpcEventLike, expectedWebContents: IpcWebContentsLike): boolean {
  const frame = event.senderFrame
  return event.sender === expectedWebContents && !!frame && frame === event.sender.mainFrame
}

export function canonicalizeProjectPath(
  value: string,
  platform: NodeJS.Platform = process.platform
): { key: string; original: string } {
  const isWindows = platform === 'win32'
  const pathApi = isWindows ? path.win32 : path.posix
  const hasWindowsDevicePrefix = isWindows && /^(?:\\\\[.?]\\|\/\/[.?]\/)/i.test(value)
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PROJECT_PATH_LENGTH ||
    value.includes('\0') ||
    hasWindowsDevicePrefix ||
    !pathApi.isAbsolute(value)
  ) {
    throw new Error('项目路径无效或未授权')
  }

  const segments = value.split(isWindows ? /[\\/]+/ : /\/+/)
  if (
    segments.some((segment) => segment === '.' || segment === '..') ||
    (isWindows && segments.some((segment) => /[. ]$/.test(segment)))
  ) {
    throw new Error('项目路径无效或未授权')
  }

  // Win32 treats a single-rooted path (for example, `\Projects`) as absolute,
  // but it inherits the current drive and is not a stable project identity.
  if (isWindows && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value)) {
    throw new Error('项目路径无效或未授权')
  }

  const normalized = pathApi.normalize(value)
  return {
    key: isWindows ? normalized.toLocaleLowerCase('en-US') : normalized,
    original: value
  }
}

/**
 * Tracks project paths explicitly selected by the user or loaded from recent-project
 * storage. Call requireAuthorized before any operation that uses a renderer path.
 */
export class AuthorizedProjectRegistry {
  private readonly selected = new Map<string, string>()
  private readonly recent = new Map<string, string>()

  registerSelected(projectPath: string): void {
    const { key, original } = canonicalizeProjectPath(projectPath)
    this.selected.set(key, original)
  }

  registerRecent(projectPaths: readonly string[]): void {
    for (const projectPath of projectPaths) {
      try {
        const { key, original } = canonicalizeProjectPath(projectPath)
        this.recent.set(key, original)
      } catch {
        // Ignore corrupt legacy entries; a single bad item must not block startup.
      }
    }
  }

  removeRecent(projectPath: string): void {
    const { key } = canonicalizeProjectPath(projectPath)
    this.recent.delete(key)
  }

  requireAuthorized(projectPath: string): string {
    const { key } = canonicalizeProjectPath(projectPath)
    const registered = this.selected.get(key) ?? this.recent.get(key)
    if (!registered) throw new Error('项目路径尚未授权')
    return registered
  }
}
