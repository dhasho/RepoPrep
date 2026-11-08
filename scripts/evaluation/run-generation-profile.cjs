const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const startup = require('./run-agentic-profile-startup.cjs')
const { secureTemporaryDirectory, safeEnv } = require('./run-retrieval-profile.cjs')

const CHECKOUT_ROOT = path.resolve(__dirname, '..', '..')
const PURPOSE = 'm08-generation-v1'
const OUTPUT_ROOT = path.join(CHECKOUT_ROOT, '.validation', 'agentic')
const MAX_EXECUTION_MS = 48 * 600_000 + 120_000
const SAFE_CODES = new Set([
  'authorization-required', 'authorization-invalid', 'authorization-binding-mismatch', 'authorization-claim-invalid', 'authorization-claim-already-started',
  'private-runtime-unavailable', 'settings-directory-unavailable', 'settings-file-unavailable', 'settings-invalid', 'settings-schema-unsupported',
  'settings-plaintext-credential-refused', 'settings-default-profile-missing', 'settings-profile-missing', 'settings-encrypted-credential-missing',
  'settings-profile-invalid', 'os-crypt-state-unavailable', 'os-crypt-state-invalid', 'os-crypt-app-bound-unsupported',
  'profile-binding-mismatch', 'credential-store-unavailable', 'saved-profile-unavailable', 'profile-decrypt-failed',
  'unsafe-directory', 'unsafe-runtime-path', 'claim-path-invalid', 'output-path-invalid', 'path-overlap',
  'generation-evaluation-incomplete', 'startup-failed'
])

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function overlaps(first, second) {
  const left = path.resolve(first), right = path.resolve(second)
  return left === right || inside(left, right) || inside(right, left)
}

function settingsDefault(environment = process.env) {
  return process.platform === 'win32'
    ? path.join(environment.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ProjectLens')
    : ''
}

function assertSourceRoot(repoRoot, actualCheckoutRoot = CHECKOUT_ROOT) {
  let actual, expected
  try { actual = fs.realpathSync(repoRoot); expected = fs.realpathSync(actualCheckoutRoot) } catch { throw new Error('authorization-binding-mismatch') }
  if (actual !== expected) throw new Error('authorization-binding-mismatch')
  return actual
}

function assertPlainDirectory(directory, code = 'unsafe-directory') {
  let stat
  try { stat = fs.lstatSync(directory) } catch { throw new Error(code) }
  if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) throw new Error(code)
}

function ensureOutputParent(repoRoot, outputDir) {
  const relative = path.relative(repoRoot, path.dirname(outputDir))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('output-path-invalid')
  let cursor = path.resolve(repoRoot)
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part)
    try { assertPlainDirectory(cursor, 'output-path-invalid') }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.message !== 'output-path-invalid') throw error
      try { fs.mkdirSync(cursor) } catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw new Error('output-path-invalid') }
      assertPlainDirectory(cursor, 'output-path-invalid')
    }
  }
  try { fs.lstatSync(outputDir); throw new Error('output-path-invalid') } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

function parseArgs(argv, defaults = {}) {
  const keys = new Set(['--repo-root', '--settings-dir', '--profile-id', '--authorization', '--output'])
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--credential-preflight') {
      if (flags.has(key)) throw new Error('invalid-arguments')
      flags.add(key)
      continue
    }
    if (!keys.has(key) || values.has(key)) throw new Error('invalid-arguments')
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('invalid-arguments')
    values.set(key, value)
  }
  if (!values.has('--authorization')) throw new Error('authorization-required')
  const repoRoot = path.resolve(values.get('--repo-root') || CHECKOUT_ROOT)
  const settingsValue = values.get('--settings-dir') || defaults.settingsDir || settingsDefault()
  if (!settingsValue) throw new Error('settings-directory-unavailable')
  const settingsDir = path.resolve(settingsValue)
  const authorizationPath = path.resolve(values.get('--authorization'))
  const credentialPreflight = flags.has('--credential-preflight')
  const outputDir = path.resolve(values.get('--output') || path.join(repoRoot, '.validation', 'agentic', `generation-${Date.now()}`))
  const relative = path.relative(path.resolve(repoRoot, '.validation', 'agentic'), outputDir)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('output-path-invalid')
  if (!credentialPreflight && (overlaps(outputDir, settingsDir) || overlaps(outputDir, authorizationPath))) throw new Error('path-overlap')
  return Object.freeze({ repoRoot, settingsDir, profileId: values.get('--profile-id') || '', authorizationPath, outputDir, credentialPreflight })
}

function preflight(options, actualCheckoutRoot = CHECKOUT_ROOT) {
  const repoRoot = assertSourceRoot(options.repoRoot, actualCheckoutRoot)
  const binding = startup.checkAuthorizationSync({ repoRoot, authorizationPath: options.authorizationPath, purpose: PURPOSE })
  const settings = path.resolve(options.settingsDir)
  const auth = path.resolve(options.authorizationPath)
  const localOutputRoot = path.join(repoRoot, '.validation', 'agentic')
  const relativeOutput = path.relative(localOutputRoot, path.resolve(options.outputDir))
  if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) throw new Error('output-path-invalid')
  if (!options.credentialPreflight && (overlaps(options.outputDir, settings) || overlaps(options.outputDir, auth))) throw new Error('path-overlap')
  if (!options.credentialPreflight) ensureOutputParent(repoRoot, options.outputDir)
  return binding
}

function cleanupRuntime(runtimeRoot) {
  const runtime = path.resolve(runtimeRoot), temp = path.resolve(os.tmpdir())
  const relative = path.relative(temp, runtime)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.basename(runtime).startsWith('repoprep-m08-generation-')) throw new Error('unsafe-runtime-path')
  const inspect = current => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) throw new Error('unsafe-runtime-path')
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) inspect(path.join(current, name))
  }
  inspect(runtime)
  fs.rmSync(runtime, { recursive: true, force: false })
}

function safeErrorCode(error) {
  const code = error instanceof Error ? error.message : ''
  return SAFE_CODES.has(code) ? code : 'startup-failed'
}

async function launch(options, dependencies = {}) {
  let stage = 'authorization'
  let child, timeout, childClosed = false, runtimeRoot
  try {
    preflight(options, dependencies.actualCheckoutRoot)
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-m08-generation-'))
    stage = 'private-runtime'
    ;(dependencies.secureTemporaryDirectory || secureTemporaryDirectory)(runtimeRoot)
    stage = 'bundle'
    const outfile = path.join(runtimeRoot, 'entry.cjs')
    const build = dependencies.build || require('esbuild').build
    await build({
      entryPoints: [path.join(__dirname, 'run-generation-profile-entry.cjs')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      tsconfig: path.join(options.repoRoot, 'tsconfig.node.json'),
      external: ['electron'], outfile, logLevel: 'silent',
      define: { __AGENTIC_REPO_ROOT__: JSON.stringify(options.repoRoot) }
    })
    stage = 'electron-spawn'
    const electron = dependencies.electronPath || require('electron')
    const cli = [
      '--runtime-root', runtimeRoot,
      '--repo-root', options.repoRoot,
      '--settings-dir', options.settingsDir,
      '--authorization', options.authorizationPath,
      '--output', options.outputDir,
      ...(options.profileId ? ['--profile-id', options.profileId] : []),
      ...(options.credentialPreflight ? ['--credential-preflight'] : [])
    ]
    child = (dependencies.spawn || require('node:child_process').spawn)(electron, [outfile, ...cli], {
      cwd: options.repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...(dependencies.safeEnv || safeEnv)(), NODE_OPTIONS: '--experimental-strip-types' }
    })
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { childClosed = true; resolve(code ?? (signal ? 1 : 0)) })
    })
    timeout = setTimeout(() => { child?.kill() }, MAX_EXECUTION_MS)
    const exitCode = await closed
    process.exitCode = exitCode === 0 ? 0 : 1
    if (exitCode !== 0) throw new Error('generation-evaluation-incomplete')
    if (options.credentialPreflight) {
      const verdictPath = path.join(runtimeRoot, 'credential-preflight-verdict.json')
      const stat = fs.lstatSync(verdictPath)
      if (!stat.isFile() || stat.isSymbolicLink() || JSON.parse(fs.readFileSync(verdictPath, 'utf8')).decrypted !== true) throw new Error('startup-failed')
    } else {
      const reportPath = path.join(options.outputDir, 'generation-evaluation.json')
      const stat = fs.lstatSync(reportPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('generation-evaluation-incomplete')
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      if (report?.executionComplete !== true || report?.status !== 'awaiting-review' || report?.reviewState !== 'independent-quality-review-pending' || report?.qualityGate !== 'not-evaluated') throw new Error('generation-evaluation-incomplete')
    }
    return 0
  } catch (error) {
    process.exitCode = 1
    throw Object.assign(new Error(safeErrorCode(error)), { startupStage: stage })
  } finally {
    clearTimeout(timeout)
    if (child && !childClosed && child.pid) {
      child.kill()
      await new Promise(resolve => child.once('close', () => { childClosed = true; resolve() }))
    }
    if (runtimeRoot) cleanupRuntime(runtimeRoot)
  }
}

if (require.main === module) {
  let options
  try { options = parseArgs(process.argv.slice(2), { settingsDir: settingsDefault() }) } catch {
    process.stderr.write('Generation evaluation received invalid arguments.\n')
    process.exitCode = 2
  }
  if (options) launch(options).catch(error => {
    const stage = ['authorization', 'private-runtime', 'bundle', 'electron-spawn'].includes(error?.startupStage) ? error.startupStage : 'launcher'
    process.stderr.write(`${JSON.stringify({ type: 'generation-startup', stage, code: safeErrorCode(error) })}\n`)
    process.exitCode = 1
  })
}

module.exports = { MAX_EXECUTION_MS, assertSourceRoot, cleanupRuntime, ensureOutputParent, launch, parseArgs, preflight, safeErrorCode }
