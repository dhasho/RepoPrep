const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { registerSharedAliasHooks, stageEncryptedSettings } = require('./run-saved-profile.cjs')
const store = require('../../electron/services/store')
const credentialCrypto = require('../../electron/services/native-credential-crypto')
const SAFE_ERROR_CODES = new Set([
  'invalid-entry-arguments', 'unsafe-directory', 'unsafe-runtime-path',
  'settings-directory-unavailable', 'settings-file-unavailable', 'settings-invalid',
  'settings-schema-unsupported', 'settings-plaintext-credential-refused',
  'settings-default-profile-missing', 'settings-profile-missing',
  'settings-encrypted-credential-missing', 'settings-profile-invalid',
  'credential-store-unavailable', 'saved-profile-unavailable'
])

function parseEntryArgs(argv) {
  const values = new Map()
  const cases = []
  let preflight = false
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--preflight') { preflight = true; continue }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('invalid-entry-arguments')
    if (key === '--case') cases.push(value)
    else if (['--runtime-root', '--repo-root', '--settings-dir', '--profile-id', '--repos-root', '--output', '--max-requests'].includes(key)) values.set(key, value)
    else throw new Error('invalid-entry-arguments')
  }
  const required = preflight
    ? ['--runtime-root', '--repo-root']
    : ['--runtime-root', '--repo-root', '--settings-dir', '--repos-root', '--output', '--max-requests']
  for (const key of required) {
    if (!values.has(key)) throw new Error('invalid-entry-arguments')
  }
  const maxRequests = preflight ? 16 : Number(values.get('--max-requests'))
  if (!preflight && (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 16)) throw new Error('invalid-entry-arguments')
  return {
    runtimeRoot: path.resolve(values.get('--runtime-root')),
    repoRoot: path.resolve(values.get('--repo-root')),
    settingsDir: values.has('--settings-dir') ? path.resolve(values.get('--settings-dir')) : '',
    profileId: values.get('--profile-id') || '',
    reposRoot: values.has('--repos-root') ? path.resolve(values.get('--repos-root')) : '',
    outputDir: values.has('--output') ? path.resolve(values.get('--output')) : '',
    maxRequests,
    caseIds: cases,
    preflight
  }
}

function assertPlainDirectory(directory) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-directory')
}

function establishIsolatedPaths(options) {
  assertPlainDirectory(options.runtimeRoot)
  const isolated = path.join(options.runtimeRoot, 'isolated-user-data')
  fs.mkdirSync(isolated, { recursive: false })
  const profileId = options.preflight ? '' : stageEncryptedSettings(options.settingsDir, options.runtimeRoot, isolated, options.profileId)
  const appData = path.join(options.runtimeRoot, 'app-data')
  const sessionData = path.join(options.runtimeRoot, 'session-data')
  const logs = path.join(options.runtimeRoot, 'logs')
  for (const directory of [appData, sessionData, logs]) {
    if (!isPathInside(options.runtimeRoot, directory)) throw new Error('unsafe-runtime-path')
    fs.mkdirSync(directory, { recursive: false })
    assertPlainDirectory(directory)
  }
  app.setPath('appData', appData)
  app.setPath('sessionData', sessionData)
  app.setPath('logs', logs)
  app.setPath('userData', isolated)
  return { profileId }
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function run(options) {
  try {
    const { profileId } = establishIsolatedPaths(options)
    await app.whenReady()
    if (options.preflight) {
      for (const [name, expected] of [
        ['appData', path.join(options.runtimeRoot, 'app-data')],
        ['sessionData', path.join(options.runtimeRoot, 'session-data')],
        ['logs', path.join(options.runtimeRoot, 'logs')],
        ['userData', path.join(options.runtimeRoot, 'isolated-user-data')]
      ]) {
        if (path.resolve(app.getPath(name)) !== path.resolve(expected)) throw new Error('preflight-path-mismatch')
        assertPlainDirectory(expected)
      }
      if (fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) throw new Error('preflight-settings-unexpected')
      registerSharedAliasHooks(options.repoRoot)
      const runnerPath = path.join(options.repoRoot, 'scripts', 'evaluation', 'real-runner.mjs')
      const runner = await import(require('node:url').pathToFileURL(runnerPath).href)
      if (typeof runner.verifyRealCorpus !== 'function' || typeof runner.runRealEvaluation !== 'function') throw new Error('preflight-runner-invalid')
      fs.writeFileSync(path.join(options.runtimeRoot, 'preflight-verdict.json'), JSON.stringify({ status: 'ok' }), { flag: 'wx' })
      app.exit(0)
      return
    }
    if (!await credentialCrypto.nativeCredentialCrypto.isAvailable()) throw new Error('credential-store-unavailable')
    const profile = await store.getPrivateProfile(profileId)
    if (!profile || typeof profile.apiKey !== 'string' || !profile.apiKey) throw new Error('saved-profile-unavailable')
    const runnerPath = path.join(options.repoRoot, 'scripts', 'evaluation', 'real-runner.mjs')
    registerSharedAliasHooks(options.repoRoot)
    const { runRealEvaluation } = await import(require('node:url').pathToFileURL(runnerPath).href)
    const result = await runRealEvaluation({
      reposRoot: options.reposRoot,
      outputDir: options.outputDir,
      profile,
      caseIds: options.caseIds.length ? options.caseIds : undefined,
      variants: ['generation', 'baseline'],
      maxRequests: options.maxRequests,
      maxDurationMs: 20 * 60 * 1000
    })
    if (result?.status !== 'complete') {
      process.stderr.write('Real evaluation finished with partial or failed cases; inspect the report for pending results.\n')
      app.exit(1)
      return
    }
    process.stdout.write(`Real evaluation completed. Report directory: ${options.outputDir}\n`)
    app.exit(0)
  } catch (error) {
    const code = error instanceof Error && SAFE_ERROR_CODES.has(error.message) ? error.message : 'real-evaluation-failed'
    process.stderr.write(`Real evaluation failed (${code}). No credential value was included.\n`)
    app.exit(1)
  }
}

const isElectronEntry = Boolean(process.versions.electron && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))

if (isElectronEntry) {
  if (process.env.ELECTRON_RUN_AS_NODE) {
    process.stderr.write('Electron did not start in native application mode.\n')
    process.exit(1)
  }
  let options
  try { options = parseEntryArgs(process.argv.slice(2)) } catch {
    process.stderr.write('Real evaluation runtime received invalid arguments.\n')
    app.exit(2)
  }
  if (options) run(options).catch(() => {
    process.stderr.write('Real evaluation runtime failed unexpectedly.\n')
    app.exit(1)
  })
}

module.exports = { establishIsolatedPaths, parseEntryArgs }
