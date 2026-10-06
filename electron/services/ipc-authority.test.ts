import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertTrustedIpcSender,
  AuthorizedProjectRegistry,
  canonicalizeProjectPath,
  type IpcEventLike,
  type IpcFrameLike,
  type IpcWebContentsLike
  // @ts-expect-error Node 24 strip-types requires the explicit extension; project bundler resolution does not.
} from './ipc-authority.ts'

function makeSender(url: string): { expected: IpcWebContentsLike; event: IpcEventLike } {
  const mainFrame: IpcFrameLike = { url }
  const expected: IpcWebContentsLike = { mainFrame }
  return { expected, event: { sender: expected, senderFrame: mainFrame } }
}

test('accepts the configured dev page and its root/index document alias', () => {
  const { expected, event } = makeSender('http://localhost:5173/')
  assert.doesNotThrow(() => assertTrustedIpcSender(event, expected, 'http://localhost:5173/'))

  const indexPage = makeSender('http://localhost:5173/index.html')
  assert.doesNotThrow(() =>
    assertTrustedIpcSender(indexPage.event, indexPage.expected, 'http://localhost:5173/')
  )

  const queryAndHash = makeSender('http://localhost:5173/?mode=dev#app')
  assert.doesNotThrow(() =>
    assertTrustedIpcSender(
      queryAndHash.event,
      queryAndHash.expected,
      'http://localhost:5173/?mode=dev#app'
    )
  )
})

test('rejects same-origin routes and URL variants outside the configured page', () => {
  for (const url of [
    'http://localhost:5173/another-route',
    'http://localhost:5173/index.html/child',
    'http://localhost:5173/?mode=other',
    'http://user@localhost:5173/',
    'file:///localhost:5173/',
    'javascript:alert(1)'
  ]) {
    const { expected, event } = makeSender(url)
    assert.throws(
      () => assertTrustedIpcSender(event, expected, 'http://localhost:5173/'),
      `should reject ${url}`
    )
  }

  const configuredWithCredentials = makeSender('http://localhost:5173/')
  assert.throws(() =>
    assertTrustedIpcSender(
      configuredWithCredentials.event,
      configuredWithCredentials.expected,
      'http://user@localhost:5173/'
    )
  )
})

test('rejects untrusted origins without revealing their URL', () => {
  const { expected, event } = makeSender('https://attacker.invalid/secret')
  assert.throws(
    () => assertTrustedIpcSender(event, expected, 'http://localhost:5173/'),
    (error: Error) => !error.message.includes('attacker.invalid')
  )
})

test('rejects a non-main frame, a different window, and a different packaged file', () => {
  // 子框架：URL 与可信入口完全一致，但 senderFrame 不是主框架。
  const iframe = makeSender('file:///app/renderer/index.html')
  iframe.event.senderFrame = { url: 'file:///app/renderer/index.html' }
  assert.throws(() => assertTrustedIpcSender(iframe.event, iframe.expected, 'file:///app/renderer/index.html'))

  // 其他窗口：event.sender 与期望的 webContents 是两个不同的对象。
  const otherWindow = makeSender('file:///app/renderer/index.html')
  const mainWindow = makeSender('file:///app/renderer/index.html')
  assert.throws(() =>
    assertTrustedIpcSender(otherWindow.event, mainWindow.expected, 'file:///app/renderer/index.html')
  )

  const packaged = makeSender('file:///app/renderer/other.html')
  assert.throws(() =>
    assertTrustedIpcSender(packaged.event, packaged.expected, 'file:///app/renderer/index.html')
  )
})

test('trusts only the exact dev entry: origin, entry path and query all match', () => {
  // 这段语义原先由 window-security.ts 的 isTrustedIpcSender 承担。发送方判定统一到本模块后，
  // 对应的覆盖也移到这里，避免这条策略在合并后失去测试。
  const entry = 'http://localhost:5173/index.html?mode=app'
  for (const url of [entry, `${entry}#section`]) {
    const { expected, event } = makeSender(url)
    assert.doesNotThrow(() => assertTrustedIpcSender(event, expected, entry), url)
  }

  for (const url of [
    'about:blank',
    'https://attacker.example/',
    'http://localhost:5173/index.html?mode=other',
    'javascript:alert(1)'
  ]) {
    const { expected, event } = makeSender(url)
    assert.throws(() => assertTrustedIpcSender(event, expected, entry), `should reject ${url}`)
  }
})

test('compares packaged file senders by resolved path instead of raw URL bytes', () => {
  // 用真实文件路径构造 URL：POSIX 风格的 file:///app/... 在 Windows 上无法解析为路径
  // （fileURLToPath 抛 ERR_INVALID_FILE_URL_PATH），只能靠“比较失败即拒绝”蒙对结果。
  const spaced = path.join(os.tmpdir(), 'ProjectLens Review', 'index.html')
  const trusted = pathToFileURL(spaced).href
  assert.ok(trusted.includes('%20'), 'fixture must exercise percent-encoding')

  // 窗口可能由 loadFile 加载、也可能由 loadURL(pathToFileURL(...)) 加载，两者对分隔符、
  // 盘符大小写的规范化未必逐字节一致；比较解析后的路径可以容忍这种差异，而 href 全等
  // 会把差异放大成“整机所有 IPC 被拒”。
  const aliases = [trusted, `file:///${spaced.replace(/\\/g, '/')}`]
  if (process.platform === 'win32') {
    aliases.push(`file:///${spaced.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)}`)
  }
  for (const alias of aliases) {
    const { expected, event } = makeSender(alias)
    assert.doesNotThrow(() => assertTrustedIpcSender(event, expected, trusted), alias)
  }

  // 百分号编码与非 ASCII 字面量指向同一路径，也应视为可信。
  const unicode = path.join(os.tmpdir(), 'ProjectLens 评审', 'index.html')
  const literal = makeSender(`file:///${unicode.replace(/\\/g, '/')}`)
  assert.doesNotThrow(() =>
    assertTrustedIpcSender(literal.event, literal.expected, pathToFileURL(unicode).href)
  )

  // 片段与导航策略保持一致：应用内跳转放行的片段，不应该让后续 IPC 全部失效。
  for (const frameUrl of [`${trusted}#a`, `${trusted}#b`]) {
    const { expected, event } = makeSender(frameUrl)
    assert.doesNotThrow(() => assertTrustedIpcSender(event, expected, trusted), frameUrl)
  }

  // 路径与查询串的差异仍然必须拒绝。
  const other = pathToFileURL(path.join(os.tmpdir(), 'ProjectLens Review', 'other.html')).href
  for (const [trustedUrl, frameUrl] of [
    [trusted, other],
    [trusted, 'file://remote-host/app/renderer/index.html'],
    [`${trusted}?v=1`, `${trusted}?v=2`],
    [`${trusted}?v=1`, trusted],
    [trusted, 'https://example.com/']
  ] as Array<[string, string]>) {
    const { expected, event } = makeSender(frameUrl)
    assert.throws(() => assertTrustedIpcSender(event, expected, trustedUrl), `${trustedUrl} vs ${frameUrl}`)
  }
})

test('authorizes selected and recent paths, returning the registered original path', () => {
  const registry = new AuthorizedProjectRegistry()
  registry.registerSelected('C:\\Users\\Ada\\Project')
  registry.registerRecent(['D:\\Work\\Moved Project'])

  assert.equal(registry.requireAuthorized('c:/users/ada/project'), 'C:\\Users\\Ada\\Project')
  // Recent entries remain usable even when the project directory was later moved away.
  assert.equal(registry.requireAuthorized('D:\\Work\\Moved Project'), 'D:\\Work\\Moved Project')
})

test('removing a recent entry revokes recent-only authorization but preserves a selected path', () => {
  const registry = new AuthorizedProjectRegistry()
  registry.registerRecent(['C:\\Work\\Recent-only', 'C:\\Work\\Also-selected'])
  registry.registerSelected('C:\\Work\\Also-selected')

  registry.removeRecent('c:/work/recent-only')
  registry.removeRecent('C:\\Work\\Also-selected')

  assert.throws(() => registry.requireAuthorized('C:\\Work\\Recent-only'))
  assert.equal(registry.requireAuthorized('C:\\Work\\Also-selected'), 'C:\\Work\\Also-selected')
})

test('ignores malformed recent entries while explicit selections still reject invalid paths', () => {
  const registry = new AuthorizedProjectRegistry()
  registry.registerRecent(['C:\\Valid\\Recent', '..\\bad', 'D:\\Valid\\Also-recent'])

  assert.equal(registry.requireAuthorized('C:\\Valid\\Recent'), 'C:\\Valid\\Recent')
  assert.equal(registry.requireAuthorized('D:\\Valid\\Also-recent'), 'D:\\Valid\\Also-recent')
  assert.throws(() => registry.requireAuthorized('..\\bad'))
  assert.throws(() => registry.registerSelected('..\\bad'))
})

test('rejects unregistered, relative, traversal, NUL, device-alias, and overlong paths', () => {
  const registry = new AuthorizedProjectRegistry()
  registry.registerSelected('C:\\Users\\Ada\\Project')

  for (const value of [
    'C:\\Users\\Ada\\Other',
    '..\\Project',
    'C:\\Users\\Ada\\..\\Project',
    'C:\\Users\\Ada\\Project\\..\\Other',
    'C:\\Users\\Ada\\Project. ',
    '\\\\?\\C:\\Users\\Ada\\Project',
    `C:\\Users\\Ada\\${'x'.repeat(4_097)}`,
    'C:\\Users\\Ada\\bad\0path'
  ]) {
    assert.throws(
      () => registry.requireAuthorized(value),
      () => true,
      `should reject ${value.slice(0, 40)}`
    )
  }
})

test('canonicalizes paths with the requested platform rules and rejects ambiguous Windows roots', () => {
  assert.deepEqual(canonicalizeProjectPath('C:/Work/Project', 'win32'), {
    key: 'c:\\work\\project',
    original: 'C:/Work/Project'
  })
  assert.equal(canonicalizeProjectPath('/work/project', 'linux').key, '/work/project')

  for (const value of [
    '\\Work\\Project',
    '/Work/Project',
    '\\\\?\\C:\\Work\\Project',
    '//?/C:/Work/Project',
    '\\\\.\\C:\\Work\\Project'
  ]) {
    assert.throws(() => canonicalizeProjectPath(value, 'win32'), `should reject ${value}`)
  }
})
