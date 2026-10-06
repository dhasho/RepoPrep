import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createServer, loadConfigFromFile } from 'vite'

const securityPath = new URL('../electron/window-security.ts', import.meta.url)
const source = await readFile(securityPath, 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const securityUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
const { getTrustedDevUrl, isAllowedAppUrl, isTrustedIpcSender, installWindowSecurity, installPermissionDenials } = await import(securityUrl)

test('development renderer URL only trusts unpackaged loopback origins at the expected path', () => {
  for (const url of [
    'http://localhost:5173/',
    'https://127.0.0.1:5173/',
    'http://[::1]:5173/'
  ]) assert.ok(getTrustedDevUrl(url, false)?.startsWith(url.slice(0, -1)), url)
  assert.equal(getTrustedDevUrl(undefined, false), null)
  assert.equal(getTrustedDevUrl('http://localhost:5173/', true), null)
  assert.equal(getTrustedDevUrl('http://localhost:5173/renderer', false, '/renderer'), 'http://localhost:5173/renderer')

  for (const url of [
    'https://attacker.example/',
    'http://localhost.evil:5173/',
    'http://user:pass@localhost:5173/',
    'http://localhost:5173/other',
    'http://localhost:5173/?query=1',
    'file:///index.html',
    'not a URL'
  ]) assert.throws(() => getTrustedDevUrl(url, false), undefined, url)
})

test('loopback matching relies on the parser-normalised bracketed IPv6 host', () => {
  // URL 解析器会把 IPv6 主机名规范化成带方括号的形式，所以 '[::1]' 是唯一需要匹配的写法；
  // 裸写的 '::1' 永远不可能出现在 hostname 上，对应的分支是死代码。
  assert.equal(new URL('http://[::1]:5173/').hostname, '[::1]')
  assert.equal(getTrustedDevUrl('http://[::1]:5173/', false), 'http://[::1]:5173/')
  // 裸写 IPv6 的 URL 本身就解析不了，必须被拒绝而不是静默放行。
  assert.throws(() => getTrustedDevUrl('http://::1:5173/', false))
})

test('development URL allowlist matches exact origin and entry path while allowing fragments', () => {
  const entry = 'http://localhost:5173/index.html'
  for (const url of [entry, `${entry}#settings`]) {
    assert.equal(isAllowedAppUrl(url, entry), true, url)
  }
  for (const url of [
    'http://localhost.evil:5173/index.html',
    'http://localhost:5174/index.html',
    'http://127.0.0.1:5173/index.html',
    'http://localhost:5173/other.html',
    'http://localhost:5173/index.html?x=1',
    'https://localhost:5173/index.html',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///index.html'
  ]) assert.equal(isAllowedAppUrl(url, entry), false, url)
})

test('file entry permits the same entry and fragment but rejects other files and remote URLs', () => {
  const entry = new URL('../out/renderer/index.html', import.meta.url).href
  assert.equal(isAllowedAppUrl(entry, entry), true)
  assert.equal(isAllowedAppUrl(`${entry}#app`, entry), true)
  assert.equal(isAllowedAppUrl(new URL('../out/renderer/other.html', import.meta.url).href, entry), false)
  assert.equal(isAllowedAppUrl('file://remote-host/out/renderer/index.html', entry), false)
  assert.equal(isAllowedAppUrl('https://example.com/', entry), false)
})

test('IPC trusts only the main window main frame at the exact app entry', () => {
  const entry = 'http://localhost:5173/index.html?mode=app'
  assert.equal(isTrustedIpcSender(true, true, entry, entry), true)
  assert.equal(isTrustedIpcSender(true, true, `${entry}#section`, entry), true)

  for (const [isMainWindow, isMainFrame, frameUrl, appUrl] of [
    [true, true, 'about:blank', entry],
    [true, true, 'https://attacker.example/', entry],
    [true, true, 'http://localhost:5173/index.html?mode=other', entry],
    [false, true, entry, entry],
    [true, false, entry, entry],
    [true, true, null, entry],
    [true, true, entry, null]
  ]) {
    assert.equal(isTrustedIpcSender(isMainWindow, isMainFrame, frameUrl, appUrl), false,
      `${isMainWindow}/${isMainFrame}/${frameUrl}/${appUrl}`)
  }
})

test('installed WebContents handlers prevent every navigation path except app entry', () => {
  const listeners = new Map()
  let openHandler
  const contents = {
    setWindowOpenHandler(handler) { openHandler = handler },
    on(name, handler) { listeners.set(name, handler) }
  }
  installWindowSecurity({ webContents: contents }, 'http://localhost:5173/index.html')
  assert.deepEqual(openHandler({ url: 'http://localhost:5173/index.html' }), { action: 'deny' })

  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
    const url = 'https://attacker.example/payload'
    const event = { url, prevented: false, preventDefault() { this.prevented = true } }
    if (eventName === 'will-frame-navigate') listeners.get(eventName)(event, { url })
    else if (eventName === 'will-attach-webview') listeners.get(eventName)(event, {})
    else listeners.get(eventName)(event, url)
    assert.equal(event.prevented, true, eventName)
  }

  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    const url = 'http://localhost:5173/index.html#allowed'
    const event = { url, prevented: false, preventDefault() { this.prevented = true } }
    if (eventName === 'will-frame-navigate') listeners.get(eventName)(event, { url })
    else listeners.get(eventName)(event, url)
    assert.equal(event.prevented, false, eventName)
  }
})

test('did-navigate restores the trusted entry after about:blank commits but leaves trusted navigation alone', async () => {
  const listeners = new Map()
  const reloads = []
  const contents = {
    setWindowOpenHandler() {},
    on(name, handler) { listeners.set(name, handler) },
    loadURL(url) { reloads.push(url); return Promise.resolve() }
  }
  const window = { webContents: contents, isDestroyed: () => false, close() {} }
  const entry = 'http://localhost:5173/index.html'
  installWindowSecurity(window, entry)
  const handler = listeners.get('did-navigate')
  assert.equal(typeof handler, 'function')

  handler({}, entry)
  assert.deepEqual(reloads, [])

  handler({}, 'about:blank')
  await new Promise((resolveTurn) => setImmediate(resolveTurn))
  assert.deepEqual(reloads, [entry])
})

test('failed restoration closes a live window and does not close an already destroyed window', async () => {
  const entry = 'http://localhost:5173/index.html'
  const originalConsoleError = console.error
  console.error = () => {}

  try {
    const makeWindow = (destroyed) => {
      const listeners = new Map()
      let closed = false
      const contents = {
        setWindowOpenHandler() {},
        on(name, handler) { listeners.set(name, handler) },
        loadURL() { return Promise.reject(new Error('renderer unavailable')) }
      }
      const window = {
        webContents: contents,
        isDestroyed: () => destroyed,
        close() { closed = true }
      }
      installWindowSecurity(window, entry)
      listeners.get('did-navigate')({}, 'about:blank')
      return {
        wasClosed: () => closed,
        restorationSettled: new Promise((resolveTurn) => setImmediate(resolveTurn))
      }
    }

    const live = makeWindow(false)
    await live.restorationSettled
    assert.equal(live.wasClosed(), true)

    const destroyed = makeWindow(true)
    await destroyed.restorationSettled
    assert.equal(destroyed.wasClosed(), false)
  } finally {
    console.error = originalConsoleError
  }
})

test('session permission request and check handlers deny every permission', () => {
  let requestHandler
  let checkHandler
  installPermissionDenials({
    setPermissionRequestHandler(handler) { requestHandler = handler },
    setPermissionCheckHandler(handler) { checkHandler = handler }
  })
  for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read']) {
    let result
    requestHandler({}, permission, (allowed) => { result = allowed })
    assert.equal(result, false, permission)
    assert.equal(checkHandler({}, permission), false, permission)
  }
})

test('production renderer HTML applies restrictive CSP and references bundled local assets', async () => {
  const htmlPath = new URL('../out/renderer/index.html', import.meta.url)
  const html = await readFile(htmlPath, 'utf8')

  const policy = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1]
  assert.ok(policy, 'CSP meta tag exists')
  assert.doesNotMatch(policy, /script-src[^;]*(?:'unsafe-inline'|'unsafe-eval'|https?:\/\/|\*)/i)
  assert.match(policy, /script-src[^;]*'self'/i)
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script\s*>/i, 'production HTML has no inline scripts')

  const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^\"]*)?)"/gi)].map((m) => m[1])
  assert.ok(assetRefs.some((ref) => ref.startsWith('./assets/')), 'renderer references bundled assets')
  for (const ref of assetRefs) {
    assert.equal(/^(?:https?:)?\/\//i.test(ref), false, `asset must be local: ${ref}`)
    assert.equal(ref.startsWith('data:'), false, `asset must be bundled: ${ref}`)
  }
})

test('renderer dev server hashes React preamble before it executes and limits HMR to localhost', async () => {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('electron.vite.config.ts'))
  assert.ok(loaded?.config.renderer, 'loads the actual electron-vite renderer configuration')
  const server = await createServer({
    ...loaded.config.renderer,
    configFile: false,
    root: resolve('src'),
    server: { host: '127.0.0.1', port: 0, strictPort: false }
  })
  try {
    await server.listen()
    const response = await fetch(server.resolvedUrls.local[0])
    assert.equal(response.ok, true)
    const html = await response.text()
    const cspTag = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"[^>]*>/i)
    assert.ok(cspTag, 'dev HTML includes CSP')
    const preambleMatch = html.match(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/i)
    assert.ok(preambleMatch, 'React refresh preamble is inline')
    assert.ok(html.indexOf(cspTag[0]) < html.indexOf(preambleMatch[0]), 'CSP precedes React preamble')
    const expectedHash = `'sha256-${createHash('sha256').update(preambleMatch[2]).digest('base64')}'`
    assert.match(cspTag[1], /script-src[^;]*'self'/i)
    assert.ok(cspTag[1].includes(expectedHash), `CSP permits exact preamble hash ${expectedHash}`)
    const connectSrc = cspTag[1].match(/(?:^|;)\s*connect-src\s+([^;]+)/i)?.[1] ?? ''
    const allowed = connectSrc.trim().split(/\s+/).filter(Boolean)
    assert.ok(allowed.length > 0, 'dev CSP includes HMR connect sources')
    assert.ok(allowed.every((origin) => origin === "'self'" || /^https?:\/\/127\.0\.0\.1:\d+$|^wss?:\/\/127\.0\.0\.1:\d+$/.test(origin)), connectSrc)
  } finally {
    await server.close()
  }
})
