const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CHECKOUT_ROOT = path.resolve(__dirname, '..', '..')
const MAIN_CHECKOUT_ROOT = path.basename(path.dirname(CHECKOUT_ROOT)) === '.worktrees'
  ? path.resolve(CHECKOUT_ROOT, '..', '..')
  : CHECKOUT_ROOT
const DEFAULT_REPOS_ROOT = path.resolve(MAIN_CHECKOUT_ROOT, '..', 'RepoPrep-Eval-Cases')
const DEFAULT_SETTINGS_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ProjectLens')
  : ''
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024

function parseArgs(argv) {
  const options = {
    reposRoot: DEFAULT_REPOS_ROOT,
    repoRoot: CHECKOUT_ROOT,
    outputDir: '',
    settingsDir: DEFAULT_SETTINGS_DIR,
    profileId: '',
    caseIds: [],
    maxRequests: 16,
    verify: false,
    preflight: false,
    help: false
  }
  const valueOptions = new Map([
    ['--repos-root', 'reposRoot'],
    ['--repo-root', 'repoRoot'],
    ['--output', 'outputDir'],
    ['--settings-dir', 'settingsDir'],
    ['--profile-id', 'profileId'],
    ['--case', 'caseId'],
    ['--max-requests', 'maxRequests']
  ])
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { options.help = true; continue }
    if (argument === '--verify') { options.verify = true; continue }
    if (argument === '--preflight') { options.preflight = true; continue }
    const key = valueOptions.get(argument)
    if (!key) throw new Error('unknown-argument')
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('missing-argument-value')
    if (key === 'caseId') options.caseIds.push(value)
    else if (key === 'maxRequests') {
      if (!/^\d+$/.test(value)) throw new Error('invalid-request-limit')
      options.maxRequests = Number(value)
      if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 16) throw new Error('invalid-request-limit')
    } else options[key] = value
  }
  if (options.verify && options.preflight) throw new Error('incompatible-mode-flags')
  if (!options.help && !options.verify && !options.preflight && !options.outputDir) throw new Error('missing-output')
  if (!options.help && !options.verify && !options.preflight && !options.settingsDir) throw new Error('settings-directory-unavailable')
  if (!options.help && !options.verify && !options.preflight && options.outputDir) {
    const outputPath = path.resolve(options.outputDir)
    const settingsPath = path.resolve(options.settingsDir)
    if (isWithin(settingsPath, outputPath) || isWithin(outputPath, settingsPath)) throw new Error('output-settings-overlap')
  }
  return options
}

function validateSettingsSnapshot(bytes, profileId) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_SETTINGS_BYTES) throw new Error('settings-invalid')
  let settings
  try { settings = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('settings-invalid') }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.schemaVersion !== 2 || !Array.isArray(settings.profiles)) throw new Error('settings-schema-unsupported')
  if (settings.profiles.some((profile) => !profile || typeof profile !== 'object' || Array.isArray(profile) || Object.hasOwn(profile, 'apiKey'))) throw new Error('settings-plaintext-credential-refused')
  if (typeof settings.defaultProfileId !== 'string' || !settings.defaultProfileId) throw new Error('settings-default-profile-missing')
  const selectedId = profileId || settings.defaultProfileId
  const profile = settings.profiles.find((item) => item.id === selectedId)
  if (!profile) throw new Error('settings-profile-missing')
  if (!profile.credential || profile.credential.version !== 1 || typeof profile.credential.ciphertext !== 'string' || profile.credential.ciphertext.length === 0) throw new Error('settings-encrypted-credential-missing')
  if (typeof profile.baseUrl !== 'string' || typeof profile.model !== 'string') throw new Error('settings-profile-invalid')
  return { settings, profileId: selectedId }
}

function helpText() {
  return [
    'Run the real-generation evaluation with an encrypted profile saved by this installation.',
    'Usage: node scripts/evaluation/run-saved-profile.cjs --output <directory> [options]',
    `  --repos-root <directory>   Defaults to ${DEFAULT_REPOS_ROOT}`,
    '  --settings-dir <directory> Defaults to this user’s ProjectLens settings directory',
    '  --profile-id <id>          Defaults to the profile selected in settings',
    '  --case <id>                Repeat to select cases',
    '  --max-requests <1..16>     Request cap, defaults to 16',
    '  --verify                   Verify pinned public corpus only; no settings or key access',
    '  --preflight                Start Electron, isolate paths, and load the runner without settings or network',
    '  --help'
  ].join('\n')
}

function safeChildEnvironment(overrides = {}) {
  const inherited = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']
  return {
    ...Object.fromEntries(inherited.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : [])),
    ...overrides
  }
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertExistingPlainDirectory(directory, errorCode) {
  const resolved = path.resolve(directory)
  let stat
  try { stat = fs.lstatSync(resolved) } catch { throw new Error(errorCode) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(errorCode)
  return resolved
}

function readEncryptedSettings(settingsDir, profileId) {
  const directory = assertExistingPlainDirectory(settingsDir, 'settings-directory-unavailable')
  const filename = path.join(directory, 'settings.json')
  let stat
  try { stat = fs.lstatSync(filename) } catch { throw new Error('settings-file-unavailable') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) throw new Error('settings-file-unavailable')
  const bytes = fs.readFileSync(filename)
  const validated = validateSettingsSnapshot(bytes, profileId)
  return { bytes, profileId: validated.profileId }
}

function stageEncryptedSettings(settingsDir, runtimeRoot, userDataDir, profileId) {
  const runtime = assertExistingPlainDirectory(runtimeRoot, 'unsafe-runtime-path')
  const userData = path.resolve(userDataDir)
  if (!isWithin(runtime, userData) || userData === runtime) throw new Error('unsafe-runtime-path')
  const { bytes, profileId: selectedProfileId } = readEncryptedSettings(settingsDir, profileId)
  assertExistingPlainDirectory(userData)
  const target = path.join(userData, 'settings.json')
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
  return selectedProfileId
}

async function verifyCorpus(options, repoRoot) {
  const script = 'const path=require("node:path");import(require("node:url").pathToFileURL(path.join(process.argv[1],"scripts/evaluation/real-runner.mjs")).href).then(({verifyRealCorpus})=>verifyRealCorpus({reposRoot:process.argv[2]})).then(()=>process.stdout.write("CORPUS-VERIFIED\\n"),()=>{process.stderr.write("CORPUS-VERIFY-FAILED\\n");process.exitCode=1})'
  const result = require('node:child_process').spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--import', sharedAliasImportUrl(repoRoot),
    '-e', script,
    repoRoot,
    options.reposRoot
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: safeChildEnvironment() })
  if (result.error || result.status !== 0 || !result.stdout.includes('CORPUS-VERIFIED')) throw new Error('corpus-verification-failed')
  return true
}

function sharedAliasImportUrl(repoRoot) {
  return require('node:url').pathToFileURL(path.join(repoRoot, 'tests', 'register-shared-alias.mjs')).href
}

function registerSharedAliasHooks(repoRoot) {
  const { registerHooks } = require('node:module')
  const { existsSync } = fs
  const { fileURLToPath, pathToFileURL } = require('node:url')
  const sharedDir = path.join(repoRoot, 'shared')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@shared' || specifier.startsWith('@shared/')) {
        const subpath = specifier === '@shared' ? 'index' : specifier.slice('@shared/'.length)
        const candidate = path.join(sharedDir, `${subpath}.ts`)
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
      if (/^\.{1,2}\//.test(specifier) && !path.extname(specifier) && context.parentURL?.startsWith('file:')) {
        const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`)
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    }
  })
}

function buildChildArgs(options, runtimeRoot, repoRoot) {
  const common = ['--runtime-root', runtimeRoot, '--repo-root', repoRoot]
  if (options.preflight) return [...common, '--preflight']
  return [
    ...common,
    '--settings-dir', path.resolve(options.settingsDir),
    ...(options.profileId ? ['--profile-id', options.profileId] : []),
    '--repos-root', path.resolve(options.reposRoot),
    '--output', path.resolve(options.outputDir),
    '--max-requests', String(options.maxRequests),
    ...options.caseIds.flatMap((id) => ['--case', id])
  ]
}

module.exports = {
  DEFAULT_REPOS_ROOT,
  DEFAULT_SETTINGS_DIR,
  buildChildArgs,
  helpText,
  isWithin,
  parseArgs,
  readEncryptedSettings,
  registerSharedAliasHooks,
  safeChildEnvironment,
  sharedAliasImportUrl,
  stageEncryptedSettings,
  validateSettingsSnapshot
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('Real evaluation launcher failed. Check settings schema, encrypted credential availability, corpus path, and runner diagnostics.\n')
    process.exitCode = 1
  })
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    const code = error instanceof Error ? error.message : ''
    process.stderr.write(`Invalid real evaluation arguments (${code}). Use --help for usage.\n`)
    process.exitCode = 2
    return
  }
  if (options.help) { process.stdout.write(`${helpText()}\n`); return }
  const repoRoot = path.resolve(options.repoRoot || CHECKOUT_ROOT)
  if (options.verify) {
    try {
      const result = await verifyCorpus(options, repoRoot)
      void result
      process.stdout.write('Verified the four pinned public evaluation repositories.\n')
      return
    } catch {
      process.stderr.write('Pinned public evaluation corpus verification failed.\n')
      process.exitCode = 1
      return
    }
  }
  const runtimeParent = path.resolve(os.tmpdir())
  const runtimeRoot = fs.mkdtempSync(path.join(runtimeParent, 'repoprep-real-eval-saved-'))
  let child
  let hardTimeout
  let stopChild
  try {
    const stat = fs.lstatSync(runtimeRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(runtimeParent, runtimeRoot) || path.basename(runtimeRoot).startsWith('repoprep-real-eval-saved-') === false) throw new Error('unsafe-runtime')
    if (isWithin(runtimeRoot, path.resolve(options.outputDir))) throw new Error('output-runtime-overlap')
    const entrySource = path.join(__dirname, 'run-saved-profile-entry.cjs')
    const entryOutput = path.join(runtimeRoot, 'entry.cjs')
    const esbuild = require('esbuild')
    await esbuild.build({
      entryPoints: [entrySource],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      tsconfig: path.join(repoRoot, 'tsconfig.node.json'),
      external: ['electron'],
      outfile: entryOutput,
      logLevel: 'silent'
    })
    const electronBinary = require('electron')
    child = require('node:child_process').spawn(electronBinary, [entryOutput, ...buildChildArgs(options, runtimeRoot, repoRoot)], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: safeChildEnvironment({ NODE_OPTIONS: '--experimental-strip-types' })
    })
    stopChild = () => { if (child && child.exitCode === null) child.kill() }
    process.once('SIGINT', stopChild)
    process.once('SIGTERM', stopChild)
    const timeoutMs = 21 * 60 * 1000
    hardTimeout = setTimeout(() => { child?.kill(); process.stderr.write('Real evaluation exceeded the 21 minute process limit.\n') }, timeoutMs)
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    if (options.preflight && exitCode === 0) {
      const verdict = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'preflight-verdict.json'), 'utf8'))
      if (verdict?.status !== 'ok') throw new Error('preflight-verdict-missing')
      process.stdout.write('VERDICT SAVED-PROFILE-PREFLIGHT-OK\n')
    }
    process.exitCode = exitCode
  } finally {
    clearTimeout(hardTimeout)
    if (stopChild) {
      process.removeListener('SIGINT', stopChild)
      process.removeListener('SIGTERM', stopChild)
    }
    if (child && child.exitCode === null) child.kill()
    removeRuntimeIfSafe(runtimeParent, runtimeRoot)
  }
}

function removeRuntimeIfSafe(runtimeParent, runtimeRoot) {
  const resolvedParent = path.resolve(runtimeParent)
  const resolved = path.resolve(runtimeRoot)
  if (!isWithin(resolvedParent, resolved) || resolved === resolvedParent || !path.basename(resolved).startsWith('repoprep-real-eval-saved-')) throw new Error('unsafe-runtime-cleanup')
  const inspect = (entry) => {
    const stat = fs.lstatSync(entry)
    if (stat.isSymbolicLink()) throw new Error('unsafe-runtime-cleanup')
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) inspect(path.join(entry, name))
  }
  inspect(resolved)
  fs.rmSync(resolved, { recursive: true, force: false })
}
