import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { BrowserWindow, Session, WebContents } from 'electron'

/** Return a trusted loopback dev-server URL, null when it should not be used. */
export function getTrustedDevUrl(
  raw: string | undefined,
  isPackaged: boolean,
  expectedDevPath = '/'
): string | null {
  if (isPackaged || raw === undefined) return null

  try {
    const candidate = new URL(raw)
    const hostname = candidate.hostname.toLowerCase()
    // WHATWG URL 会把 IPv6 主机名规范化成带方括号的形式（new URL('http://[::1]/').hostname === '[::1]'），
    // 因此这里只需要匹配 '[::1]'，写成 '::1' 是永远不可达的分支。
    const loopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    const valid = (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
      loopbackHost &&
      candidate.username === '' &&
      candidate.password === '' &&
      candidate.pathname === expectedDevPath &&
      candidate.search === ''
    if (valid) return candidate.href
  } catch {
    throw new Error('ELECTRON_RENDERER_URL is not a valid URL')
  }

  throw new Error('ELECTRON_RENDERER_URL must be a loopback HTTP(S) URL without credentials and use the expected renderer path')
}

/** Allow only the configured renderer entry point; fragments are app-local navigation. */
export function isAllowedAppUrl(candidate: string, appEntryUrl: string): boolean {
  let actual: URL
  let expected: URL
  try {
    actual = new URL(candidate)
    expected = new URL(appEntryUrl)
  } catch {
    return false
  }

  if (actual.protocol !== expected.protocol) return false

  if (expected.protocol === 'file:') {
    if (actual.hostname !== '' || expected.hostname !== '') return false
    try {
      const actualPath = path.resolve(fileURLToPath(actual))
      const expectedPath = path.resolve(fileURLToPath(expected))
      const samePath = process.platform === 'win32'
        ? actualPath.toLocaleLowerCase() === expectedPath.toLocaleLowerCase()
        : actualPath === expectedPath
      return samePath && actual.search === expected.search
    } catch {
      return false
    }
  }

  // Development server origin and entry pathname must both match exactly.
  // Comparing URL.origin avoids prefix matches such as localhost.evil.
  return (expected.protocol === 'http:' || expected.protocol === 'https:') &&
    actual.origin === expected.origin &&
    actual.pathname === expected.pathname &&
    actual.search === expected.search
}

/** Pure sender policy shared by IPC registration and unit tests. */
export function isTrustedIpcSender(
  isMainWindow: boolean,
  isMainFrame: boolean,
  senderFrameUrl: string | null,
  appEntryUrl: string | null
): boolean {
  return isMainWindow && isMainFrame && !!senderFrameUrl && !!appEntryUrl &&
    isAllowedAppUrl(senderFrameUrl, appEntryUrl)
}

export function installWindowSecurity(window: BrowserWindow, appEntryUrl: string): void {
  const contents: WebContents = window.webContents
  const allowNavigation = (url: string): boolean => isAllowedAppUrl(url, appEntryUrl)

  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!allowNavigation(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!allowNavigation(url)) event.preventDefault()
  })
  contents.on('will-frame-navigate', (event) => {
    if (!allowNavigation(event.url)) event.preventDefault()
  })
  // Special URLs such as about:blank can bypass cancellable will-* events.
  // Wait until the main-frame document commits before restoring the app entry;
  // starting loadURL during did-start-navigation can race the pending commit.
  contents.on('did-navigate', (_event, url) => {
    if (!allowNavigation(url)) {
      console.error('[security] 检测到不可信页面，正在恢复应用入口')
      void contents.loadURL(appEntryUrl).catch((error: unknown) => {
        console.error('[security] 恢复应用入口失败:', error)
        if (!window.isDestroyed()) window.close()
      })
    }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

export function installPermissionDenials(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
}
