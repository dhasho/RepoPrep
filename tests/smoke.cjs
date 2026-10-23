// 构建产物冒烟测试：加载 out/main/index.js，断言窗口能加载、React 能渲染、
// 并且 preload 桥接的 IPC 能真正往返一次。
//
// 用法：npm run test:smoke   （内部会先跑一次 build）
// 说明：这是纯本地检查，不联网、不弹对话框；断言的是「应用能起来并跑通一次 IPC」，
// 选中项目 / 生成 / 导出这些需要交互与真实模型服务的路径仍需人工走一遍（见 README）。
const path = require('node:path')
const os = require('node:os')
const nativeFs = require('original-fs')
const { fileURLToPath } = require('node:url')

// 明确的自检：ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动，此时
// require('electron') 返回二进制路径字符串而不是内建模块，报错会是一句与根因
// 毫无关系的 "Cannot read properties of undefined (reading 'on')"。
// 这里提前拦截，直接指出该环境变量。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error(
    '[smoke] 检测到 ELECTRON_RUN_AS_NODE 已设置，Electron 会以 Node 模式启动，无法运行本测试。\n' +
    '        请先清除该变量再重试：\n' +
    '          Windows PowerShell:  Remove-Item Env:\\ELECTRON_RUN_AS_NODE\n' +
    '          bash / zsh:          unset ELECTRON_RUN_AS_NODE'
  )
  process.exit(1)
}

const { app, BrowserWindow } = require('electron')

if (!app || !BrowserWindow) {
  console.error('[smoke] 未能加载 Electron 内建模块（require("electron") 未返回 app/BrowserWindow）。')
  process.exit(1)
}

const RENDER_WAIT_MS = 6000
const root = path.join(__dirname, '..')
const log = (message) => console.log(`[smoke] ${message}`)
const collectedErrors = []
/** 是否已经输出过判定结论。用于识别「应用自行退出、根本没跑到断言」这种假绿。 */
let verdictEmitted = false
/** 构建产物的绝对路径（用来断言加载的确实是它，而不是 dev server）。 */
function parseArguments(args) {
  if (args.length === 1) return { fixtureRoot: args[0], asarPath: null }
  if (args.length === 3 && args[1] === '--asar' && path.isAbsolute(args[2])) {
    return { fixtureRoot: args[0], asarPath: path.resolve(args[2]) }
  }
  throw new Error('usage: electron tests/smoke.cjs <isolated-temp-dir> [--asar <absolute app.asar>]')
}

const smokeOptions = (() => {
  try { return parseArguments(process.argv.slice(2)) } catch (error) {
    console.error(`[smoke] invalid arguments: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
})()
const expectedEntry = smokeOptions.asarPath
  ? path.join(smokeOptions.asarPath, 'out', 'renderer', 'index.html')
  : path.join(root, 'out', 'renderer', 'index.html')

app.on('browser-window-created', (_event, win) => {
  const contents = win.webContents
  contents.on('did-fail-load', (_e, code, desc, url) => collectedErrors.push(`did-fail-load code=${code} desc=${desc} url=${url}`))
  contents.on('render-process-gone', (_e, details) => collectedErrors.push(`render-process-gone reason=${details.reason}`))
  contents.on('preload-error', (_e, preloadPath, error) => collectedErrors.push(`preload-error path=${preloadPath} err=${error && error.message}`))
  // Electron 42 起第一个参数是 details 对象，details.level 为 'info'|'warning'|'error'|'debug'，
  // 旧的数值型 level 参数已标记弃用。两种形态都兼容，避免上游移除后这里静默失效、永远通过。
  contents.on('console-message', (...args) => {
    const [first, second] = args
    const level = first && typeof first === 'object' && typeof first.level === 'string' ? first.level : null
    const message = level ? first.message : second
    const isProblem = level ? (level === 'warning' || level === 'error') : typeof second === 'number' && second >= 2
    if (isProblem) collectedErrors.push(`renderer-${level || 'error'}: ${message}`)
  })
})

// 父 runner 为该 Electron 子进程创建唯一临时目录，并在子进程完全退出后清理。
try {
  const fixtureRoot = path.resolve(smokeOptions.fixtureRoot || '')
  const relative = path.relative(path.resolve(os.tmpdir()), fixtureRoot)
  const fixtureInfo = nativeFs.lstatSync(fixtureRoot)
  if (!path.basename(fixtureRoot).startsWith('repoprep-smoke-') || path.dirname(fixtureRoot) !== path.resolve(os.tmpdir()) ||
      !relative || relative.startsWith('..') || path.isAbsolute(relative) || !fixtureInfo.isDirectory() || fixtureInfo.isSymbolicLink() ||
      nativeFs.realpathSync(fixtureRoot) !== fixtureRoot) {
    throw new Error('unsafe-smoke-fixture')
  }
  app.setPath('appData', path.join(fixtureRoot, 'app-data'))
  app.setPath('sessionData', path.join(fixtureRoot, 'session-data'))
  if (smokeOptions.asarPath) {
    const expectedAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')
    const asarInfo = nativeFs.lstatSync(smokeOptions.asarPath)
    if (smokeOptions.asarPath.toLowerCase() !== expectedAsar.toLowerCase()) throw new Error('asar-path-mismatch')
    if (!asarInfo.isFile() || asarInfo.isSymbolicLink()) throw new Error('asar-is-not-an-ordinary-file')
    if (nativeFs.realpathSync(smokeOptions.asarPath).toLowerCase() !== smokeOptions.asarPath.toLowerCase()) throw new Error('asar-realpath-mismatch')
    if (process.env.ELECTRON_RENDERER_URL) throw new Error('renderer-url-env-present-in-asar-smoke')
  }
} catch (error) {
  console.error(`[smoke] 无法建立隔离的临时 Electron 数据目录：${error && error.message ? error.message : String(error)}`)
  process.exit(1)
}
const mainEntry = smokeOptions.asarPath
  ? path.join(smokeOptions.asarPath, 'out', 'main', 'index.js')
  : path.join(root, 'out', 'main', 'index.js')
let loadedMainEntry = ''
let loadedTypeScriptPath = ''
let packagedTypeScriptVerified = false
try {
  loadedMainEntry = require.resolve(mainEntry)
  if (smokeOptions.asarPath) {
    if (!loadedMainEntry.toLowerCase().startsWith(`${smokeOptions.asarPath.toLowerCase()}${path.sep}`)) {
      throw new Error('main-entry-did-not-resolve-from-app-asar')
    }
    loadedTypeScriptPath = require.resolve('typescript', { paths: [path.join(smokeOptions.asarPath, 'out', 'main')] })
    if (!loadedTypeScriptPath.toLowerCase().startsWith(`${smokeOptions.asarPath.toLowerCase()}${path.sep}`)) {
      throw new Error('typescript-did-not-resolve-from-app-asar')
    }
    const typescript = require(loadedTypeScriptPath)
    const source = typescript.createSourceFile('smoke.ts', 'export const smoke = 1', typescript.ScriptTarget.Latest, true)
    if (source.statements.length !== 1) throw new Error('packaged-typescript-parser-did-not-run')
    packagedTypeScriptVerified = true
  }
  require(mainEntry)
} catch (error) {
  console.error(`[smoke] packaged entry preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 兜底超时：任何意外路径（未捕获异常、渲染进程卡死、窗口始终不出现）都必须
// 以明确的失败退出，而不是让进程挂着等 CI 超时。
let finished = false
const HARD_TIMEOUT_MS = RENDER_WAIT_MS + 20000
const hardTimeout = setTimeout(() => {
  if (finished) return
  finished = true
  log('HARD-TIMEOUT：等待窗口/渲染超时')
  log('VERDICT SMOKE-FAIL')
  app.exit(1)
}, HARD_TIMEOUT_MS)
hardTimeout.unref?.()

/** 统一的收尾出口：写结论、设置退出码、结束进程。只允许生效一次。 */
function finish(ok) {
  if (finished) return
  finished = true
  verdictEmitted = true
  clearTimeout(hardTimeout)
  log(`VERDICT ${ok ? 'SMOKE-OK' : 'SMOKE-FAIL'}`)
  app.exit(ok ? 0 : 1)
}

/** 意外失败（不应发生）：打印原因并以失败退出，避免未处理 rejection 导致挂起。 */
function failUnexpected(error) {
  if (finished) return
  log(`UNEXPECTED-ERROR ${error && error.stack ? error.stack : String(error)}`)
  finish(false)
}

process.on('unhandledRejection', failUnexpected)
process.on('uncaughtException', failUnexpected)

// 关键防线：主进程里有 window-all-closed -> app.quit()，一旦窗口提前关闭，
// Electron 会**以退出码 0 结束**，而此时断言根本没跑、VERDICT 也不会打印 ——
// 只看退出码的调用方（npm / CI）会把它当成通过。这里在真正退出前兜住这种情况。
// 注意：在 will-quit 里只设 process.exitCode 是**无效**的（实测退出码仍为 0，
// 因为 Electron 的 quit 流程不经过 Node 的正常退出路径），必须直接 app.exit(1)。
// app.exit() 不触发 will-quit，因此不会递归。
app.on('will-quit', () => {
  if (verdictEmitted) return
  console.error('[smoke] 应用在输出判定结论前就退出了（可能是窗口被提前关闭）。判定为失败。')
  app.exit(1)
})

app.whenReady().then(async () => {
  await sleep(RENDER_WAIT_MS)
  const windows = BrowserWindow.getAllWindows()
  const result = { windowCount: windows.length }

  // 断言逻辑整体放在 try 内：窗口未创建时 win 为 undefined，这类访问也必须被
  // 捕获成「记录到 evalError 并判定失败」，而不是抛到 try 之外。
  try {
    if (!windows.length) throw new Error('没有创建任何窗口')
    const win = windows[0]
    result.crashed = win.webContents.isCrashed()
    result.url = win.webContents.getURL()
    result.title = await win.webContents.executeJavaScript('document.title')
    result.rootChildren = await win.webContents.executeJavaScript(
      'document.getElementById("root") ? document.getElementById("root").children.length : -1'
    )
    result.hasApi = await win.webContents.executeJavaScript('typeof window.api === "object" && window.api !== null')
    result.bodyText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 200)')
    // 走一次真实 IPC：会经过发送方校验与运行时 schema 校验。
    // 注意 project:recent 不在需要项目授权的通道集合内，因此这里只覆盖授权之外的那部分链路。
    result.ipc = await win.webContents.executeJavaScript(
      'window.api.getRecentProjects().then(r => "OK count=" + r.length).catch(e => "IPC-ERR: " + e.message)'
    )
  } catch (error) {
    result.evalError = error && error.message
  }

  // 断言加载的确实是构建产物。未打包时主进程会优先采用 ELECTRON_RENDERER_URL，
  // 若该变量在环境里（例如从某个 dev 会话泄漏），测试会去校验 dev server 而全部通过 ——
  // 那对「构建产物冒烟」这个目的是假绿。
  let loadedIsBuildOutput = false
  try {
    loadedIsBuildOutput = !!result.url && result.url.startsWith('file://') &&
      path.resolve(fileURLToPath(result.url.split('#')[0].split('?')[0])) === path.resolve(expectedEntry)
  } catch {
    loadedIsBuildOutput = false
  }
  result.loadedIsBuildOutput = loadedIsBuildOutput
  result.loadedMainEntry = loadedMainEntry
  result.loadedMainFromAsar = smokeOptions.asarPath
    ? loadedMainEntry.toLowerCase().startsWith(`${smokeOptions.asarPath.toLowerCase()}${path.sep}`)
    : false
  result.loadedRendererFromAsar = smokeOptions.asarPath
    ? loadedIsBuildOutput && path.resolve(fileURLToPath(result.url.split('#')[0].split('?')[0])).toLowerCase() === path.resolve(expectedEntry).toLowerCase()
    : false
  result.packagedTypeScriptPath = loadedTypeScriptPath
  result.packagedTypeScriptVerified = packagedTypeScriptVerified

  log(`windowCount=${result.windowCount} crashed=${result.crashed}`)
  log(`url=${result.url}`)
  log(`title=${JSON.stringify(result.title)} rootChildren=${result.rootChildren} hasApi=${result.hasApi}`)
  log(`loadedIsBuildOutput=${result.loadedIsBuildOutput} (expected ${expectedEntry})`)
  if (smokeOptions.asarPath) {
    log(`loadedMainFromAsar=${result.loadedMainFromAsar} main=${result.loadedMainEntry}`)
    log(`loadedRendererFromAsar=${result.loadedRendererFromAsar}`)
    log(`packagedTypeScriptVerified=${result.packagedTypeScriptVerified} path=${result.packagedTypeScriptPath}`)
  }
  log(`ipc=${JSON.stringify(result.ipc)}`)
  if (result.evalError) log(`evalError=${result.evalError}`)
  for (const error of collectedErrors) log(`collected-error: ${error}`)
  if (!result.loadedIsBuildOutput && process.env.ELECTRON_RENDERER_URL) {
    log(`提示：环境里存在 ELECTRON_RENDERER_URL=${process.env.ELECTRON_RENDERER_URL}，主进程会优先加载它而不是构建产物。`)
  }

  const ok =
    result.windowCount > 0 &&
    result.crashed === false &&
    result.loadedIsBuildOutput &&
    typeof result.bodyText === 'string' &&
    result.bodyText.length > 0 &&
    result.rootChildren > 0 &&
    result.hasApi === true &&
    typeof result.ipc === 'string' &&
    result.ipc.startsWith('OK') &&
    !result.evalError &&
    (!smokeOptions.asarPath || (result.loadedMainFromAsar && result.loadedRendererFromAsar && result.packagedTypeScriptVerified)) &&
    collectedErrors.length === 0

  finish(ok)
}).catch(failUnexpected)
