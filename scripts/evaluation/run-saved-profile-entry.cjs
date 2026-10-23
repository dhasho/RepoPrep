const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { app } = require('electron')
const { registerSharedAliasHooks, stageEncryptedSettings } = require('./run-saved-profile.cjs')
const { DEFAULT_VARIANTS, appendVariant } = require('./variant-arguments.cjs')
const store = require('../../electron/services/store')
const credentialCrypto = require('../../electron/services/native-credential-crypto')
const SAFE_ERROR_CODES = new Set([
  'invalid-entry-arguments', 'unsafe-directory', 'unsafe-runtime-path',
  'settings-directory-unavailable', 'settings-file-unavailable', 'settings-invalid',
  'settings-schema-unsupported', 'settings-plaintext-credential-refused',
  'settings-default-profile-missing', 'settings-profile-missing',
  'settings-encrypted-credential-missing', 'settings-profile-invalid',
  'credential-store-unavailable', 'saved-profile-unavailable',
  'os-crypt-state-unavailable', 'os-crypt-state-invalid', 'os-crypt-app-bound-unsupported',
  'credential-fixture-path-required'
])

function parseEntryArgs(argv) {
  const values = new Map()
  const cases = []
  const variants = []
  let preflight = false
  let credentialPreflight = false
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--preflight') { preflight = true; continue }
    if (key === '--credential-preflight') { credentialPreflight = true; continue }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('invalid-entry-arguments')
    if (key === '--case') cases.push(value)
    else if (key === '--variant') {
      appendVariant(variants, value, 'invalid-entry-arguments')
      variants.push(value)
    } else if (['--runtime-root', '--repo-root', '--settings-dir', '--profile-id', '--repos-root', '--output', '--max-requests'].includes(key)) values.set(key, value)
    else throw new Error('invalid-entry-arguments')
  }
  if (preflight && credentialPreflight) throw new Error('invalid-entry-arguments')
  if ((preflight || credentialPreflight) && variants.length) throw new Error('invalid-entry-arguments')
  const required = preflight
    ? ['--runtime-root', '--repo-root']
    : credentialPreflight
      ? ['--runtime-root', '--repo-root', '--settings-dir']
      : ['--runtime-root', '--repo-root', '--settings-dir', '--repos-root', '--output', '--max-requests']
  for (const key of required) {
    if (!values.has(key)) throw new Error('invalid-entry-arguments')
  }
  const maxRequests = preflight || credentialPreflight ? 16 : Number(values.get('--max-requests'))
  if (!preflight && !credentialPreflight && (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 16)) throw new Error('invalid-entry-arguments')
  return {
    runtimeRoot: path.resolve(values.get('--runtime-root')),
    repoRoot: path.resolve(values.get('--repo-root')),
    settingsDir: values.has('--settings-dir') ? path.resolve(values.get('--settings-dir')) : '',
    profileId: values.get('--profile-id') || '',
    reposRoot: values.has('--repos-root') ? path.resolve(values.get('--repos-root')) : '',
    outputDir: values.has('--output') ? path.resolve(values.get('--output')) : '',
    maxRequests,
    caseIds: cases,
    variants: variants.length ? variants : [...DEFAULT_VARIANTS],
    preflight,
    credentialPreflight
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
  const logs = path.join(options.runtimeRoot, 'logs')
  for (const directory of [appData, logs]) {
    if (!isPathInside(options.runtimeRoot, directory)) throw new Error('unsafe-runtime-path')
    fs.mkdirSync(directory, { recursive: false })
    assertPlainDirectory(directory)
  }
  app.setPath('appData', appData)
  // Electron stores its OSCrypt Local State under sessionData; use the same isolated folder as settings.
  app.setPath('sessionData', isolated)
  app.setPath('logs', logs)
  app.setPath('userData', isolated)
  return { profileId }
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertSyntheticCredentialFixture(options) {
  if (!options.credentialPreflight) return
  const fixtureDirectory = path.resolve(options.settingsDir)
  const fixtureRoot = path.dirname(fixtureDirectory)
  let fixtureRootStat
  try { fixtureRootStat = fs.lstatSync(fixtureRoot) } catch { throw new Error('credential-fixture-path-required') }
  if (
    !fixtureRootStat.isDirectory() || fixtureRootStat.isSymbolicLink() ||
    !isPathInside(os.tmpdir(), fixtureDirectory) ||
    path.basename(fixtureDirectory) !== 'source-user-data' ||
    !path.basename(fixtureRoot).startsWith('repoprep-native-credential-stage-')
  ) throw new Error('credential-fixture-path-required')
}

async function run(options) {
  try {
    assertSyntheticCredentialFixture(options)
    const { profileId } = establishIsolatedPaths(options)
    await app.whenReady()
    if (options.preflight) {
      for (const [name, expected] of [
        ['appData', path.join(options.runtimeRoot, 'app-data')],
        ['sessionData', path.join(options.runtimeRoot, 'isolated-user-data')],
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
    if (options.credentialPreflight) {
      const expected = /^synthetic-stage-sha256-([a-f0-9]{64})$/u.exec(profile.name)?.[1]
      const actual = createHash('sha256').update(profile.apiKey).digest('hex')
      if (!expected || actual !== expected) throw new Error('credential-preflight-mismatch')
      fs.writeFileSync(path.join(options.runtimeRoot, 'credential-preflight-verdict.json'), JSON.stringify({ decrypted: true }), { flag: 'wx' })
      app.exit(0)
      return
    }
    const runnerPath = path.join(options.repoRoot, 'scripts', 'evaluation', 'real-runner.mjs')
    registerSharedAliasHooks(options.repoRoot)
    const { runRealEvaluation } = await import(require('node:url').pathToFileURL(runnerPath).href)
    const result = await runRealEvaluation({
      reposRoot: options.reposRoot,
      outputDir: options.outputDir,
      profile,
      caseIds: options.caseIds.length ? options.caseIds : undefined,
      variants: options.variants,
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
