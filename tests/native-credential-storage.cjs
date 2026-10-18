const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const electron = require('electron')

const { app } = electron
const sourceRoot = path.resolve(__dirname, '..')
let fixtureRoot = ''
const loaded = new Map()
let finished = false
let hardTimeout

function loadTs(relativePath) {
  const filename = path.resolve(sourceRoot, relativePath)
  if (loaded.has(filename)) return loaded.get(filename).exports
  const source = fs.readFileSync(filename, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const module = { exports: {} }
  loaded.set(filename, module)
  const requireFromSource = (id) => {
    const aliases = {
      '@shared/types': 'shared/types.ts',
      '@shared/result-contract': 'shared/result-contract.ts',
      '@shared/storage-contract': 'shared/storage-contract.ts',
      './atomic-json': 'electron/services/atomic-json.ts',
      './credential-vault': 'electron/services/credential-vault.ts',
      './native-credential-crypto': 'electron/services/native-credential-crypto.ts',
      './project-display-name': 'electron/services/project-display-name.ts',
      './content-read.ts': 'shared/content-read.ts'
    }
    if (aliases[id]) return loadTs(aliases[id])
    return require(id)
  }
  const factory = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname) { ${js}\n})`, { filename })
  factory(module.exports, requireFromSource, module, filename, path.dirname(filename))
  return module.exports
}

function finish(ok, detail) {
  if (finished) return
  finished = true
  clearTimeout(hardTimeout)
  console.log(`[native-credentials] ${detail}`)
  console.log(`[native-credentials] VERDICT ${ok ? 'NATIVE-CREDENTIAL-OK' : 'NATIVE-CREDENTIAL-FAIL'}`)
  app.exit(ok ? 0 : 1)
}

function removeFixtureIfSafe() {
  if (!fixtureRoot) return
  const resolved = path.resolve(fixtureRoot)
  const allowedRoot = path.resolve(os.tmpdir())
  if (!path.basename(resolved).startsWith('repoprep-native-credentials-') || path.relative(allowedRoot, resolved).startsWith('..') || path.isAbsolute(path.relative(allowedRoot, resolved))) {
    throw new Error('unsafe-test-fixture-cleanup')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('[native-credentials] ELECTRON_RUN_AS_NODE is set; the native Electron test did not run.')
  process.exit(1)
}

try {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-native-credentials-'))
  const resolvedFixture = path.resolve(fixtureRoot)
  if (!path.relative(path.resolve(os.tmpdir()), resolvedFixture).startsWith('repoprep-native-credentials-')) throw new Error('unsafe-test-fixture')
  app.setPath('appData', path.join(fixtureRoot, 'app-data'))
  app.setPath('sessionData', path.join(fixtureRoot, 'session-data'))
  app.setPath('userData', path.join(fixtureRoot, 'user-data'))
} catch {
  finish(false, 'could not establish an isolated temporary Electron data directory')
}

hardTimeout = setTimeout(() => finish(false, 'hard timeout waiting for native credential verification'), 30_000)
hardTimeout.unref?.()
app.on('will-quit', () => {
  if (!finished) {
    console.error('[native-credentials] Electron quit before verification produced a verdict.')
    app.exit(1)
  }
})
process.on('unhandledRejection', () => finish(false, 'unhandled rejection during native credential verification'))
process.on('uncaughtException', () => finish(false, 'uncaught exception during native credential verification'))

app.whenReady().then(async () => {
  try {
    const { safeStorage } = electron
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('async-safe-storage-unavailable')
    let backend = 'platform-native'
    if (process.platform === 'linux') {
      if (typeof safeStorage.getSelectedStorageBackend !== 'function') throw new Error('linux-backend-probe-unavailable')
      backend = safeStorage.getSelectedStorageBackend()
      if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) throw new Error('linux-os-credential-provider-unavailable')
    }
    const store = loadTs('electron/services/store.ts')
    const key = `synthetic-native-key-${Date.now()}`
    await store.saveSettings({
      profiles: [
        { id: 'native-profile', name: 'Legacy fixture', baseUrl: 'https://native.invalid/v1', apiKey: key, model: 'synthetic-model', credentialAction: 'replace' },
        { id: 'native-claude', name: 'Claude fixture', baseUrl: 'https://native.invalid/v1', apiKey: key, model: 'synthetic-model', protocol: 'anthropic', credentialAction: 'replace' }
      ],
      defaultProfileId: 'native-profile'
    })
    const settingsPath = path.join(app.getPath('userData'), 'settings.json')
    const persisted = fs.readFileSync(settingsPath, 'utf8')
    if (persisted.includes(key)) throw new Error('plaintext-key-persisted')
    const publicSettings = await store.getSettings()
    if (publicSettings.profiles.some((profile) => 'apiKey' in profile || 'credential' in profile) || JSON.stringify(publicSettings).includes(key)) throw new Error('key-leaked-by-public-settings')
    if ('protocol' in publicSettings.profiles[0] || publicSettings.profiles[1].protocol !== 'anthropic') throw new Error('native-protocol-public-roundtrip-mismatch')
    const decrypted = await store.getPrivateProfile('native-profile')
    if (!decrypted || decrypted.apiKey !== key) throw new Error('native-roundtrip-mismatch')
    const claude = await store.getPrivateProfile('native-claude')
    if (!claude || claude.apiKey !== key || claude.protocol !== 'anthropic') throw new Error('native-claude-roundtrip-mismatch')
    let protocolChangeRejected = false
    try {
      await store.saveSettings({
        profiles: publicSettings.profiles.map((profile) => ({ ...profile, protocol: 'openai', credentialAction: 'keep' })),
        defaultProfileId: publicSettings.defaultProfileId
      })
    } catch (error) {
      protocolChangeRejected = error instanceof Error && error.message === '修改接口协议前，请先替换或清除已保存的 API Key。'
    }
    if (!protocolChangeRejected) throw new Error('native-protocol-credential-binding-not-enforced')
    const unchanged = await store.getPrivateProfile('native-claude')
    if (!unchanged || unchanged.protocol !== 'anthropic' || unchanged.apiKey !== key) throw new Error('native-rejected-save-changed-credential')
    console.log(`[native-credentials] platform=${process.platform} backend=${backend} asyncAvailable=true`)
    removeFixtureIfSafe()
    finish(true, 'native safeStorage and the actual settings service round-tripped a synthetic key in isolated userData')
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown-error'
    try { removeFixtureIfSafe() } catch { /* best-effort fixture cleanup */ }
    finish(false, `native credential verification failed (${code})`)
  }
}).catch(() => finish(false, 'Electron failed before the isolated credential test started'))
