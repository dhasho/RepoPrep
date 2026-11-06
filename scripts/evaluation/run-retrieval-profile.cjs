const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { registerSharedAliasHooks } = require('./run-saved-profile.cjs')

const CHECKOUT_ROOT = path.resolve(__dirname, '../..')
const DEFAULT_SETTINGS_DIR = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'ProjectLens') : ''

function parseArgs(argv) {
  const options = { repoRoot: CHECKOUT_ROOT, settingsDir: DEFAULT_SETTINGS_DIR, profileId: '', authorizationPath: '', outputDir: '' }
  const map = new Map([['--repo-root', 'repoRoot'], ['--settings-dir', 'settingsDir'], ['--profile-id', 'profileId'], ['--authorization', 'authorizationPath'], ['--output', 'outputDir']])
  for (let i = 0; i < argv.length; i++) {
    const key = map.get(argv[i]); if (!key) throw new Error('invalid-arguments')
    const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('invalid-arguments')
    options[key] = value
  }
  if (!options.authorizationPath || !options.settingsDir) throw new Error('authorization-required')
  options.repoRoot = path.resolve(options.repoRoot); options.settingsDir = path.resolve(options.settingsDir); options.authorizationPath = path.resolve(options.authorizationPath)
  const localRoot = path.resolve(options.repoRoot, '.validation', 'agentic')
  options.outputDir = path.resolve(options.outputDir || path.join(localRoot, `retrieval-${Date.now()}`))
  const relative = path.relative(localRoot, options.outputDir)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('output-path-invalid')
  const overlaps = (a, b) => { const r = path.relative(path.resolve(a), path.resolve(b)); return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)) }
  if (overlaps(options.outputDir, options.settingsDir) || overlaps(options.settingsDir, options.outputDir) || overlaps(options.outputDir, options.authorizationPath) || overlaps(options.authorizationPath, options.outputDir)) throw new Error('path-overlap')
  return options
}

function safeEnv() {
  const keys = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']
  return Object.fromEntries(keys.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
}

async function preflight(options) {
  registerSharedAliasHooks(options.repoRoot)
  const { checkAuthorizationArtifact } = await import(pathToFileURL(path.join(options.repoRoot, 'scripts/agentic/retrieval-eval.mjs')).href)
  return checkAuthorizationArtifact({ repoRoot: options.repoRoot, authorizationPath: options.authorizationPath })
}

function ensureSafeOutputParent(repoRoot, parent) {
  const relative = path.relative(repoRoot, path.resolve(parent))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('output-path-invalid')
  let cursor = repoRoot
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part)
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('output-path-invalid')
      fs.mkdirSync(cursor)
      stat = fs.lstatSync(cursor)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('output-path-invalid')
  }
}

function secureTemporaryDirectory(directory) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('private-runtime-unavailable')
  if (process.platform === 'win32') {
    const username = process.env.USERNAME
    if (!username || /[\\/]/u.test(username)) throw new Error('private-runtime-unavailable')
    const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username
    const result = spawnSync('icacls', [directory, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('private-runtime-unavailable')
  } else {
    fs.chmodSync(directory, 0o700)
    if ((fs.statSync(directory).mode & 0o077) !== 0) throw new Error('private-runtime-unavailable')
  }
  return true
}

async function launch(options) {
  await preflight(options)
  const parent = path.dirname(options.outputDir)
  ensureSafeOutputParent(options.repoRoot, parent)
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-m06-retrieval-'))
  let child, timeout
  const maxDurationMs = 40 * 180_000 + 120_000
  try {
    secureTemporaryDirectory(runtimeRoot)
    const esbuild = require('esbuild')
    const outfile = path.join(runtimeRoot, 'entry.cjs')
    await esbuild.build({ entryPoints: [path.join(__dirname, 'run-retrieval-profile-entry.cjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', tsconfig: path.join(options.repoRoot, 'tsconfig.node.json'), external: ['electron'], outfile, logLevel: 'silent' })
    const electron = require('electron')
    const args = ['--runtime-root', runtimeRoot, '--repo-root', options.repoRoot, '--settings-dir', options.settingsDir, '--authorization', options.authorizationPath, '--output', options.outputDir, ...(options.profileId ? ['--profile-id', options.profileId] : [])]
    child = require('node:child_process').spawn(electron, [outfile, ...args], { cwd: options.repoRoot, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...safeEnv(), NODE_OPTIONS: '--experimental-strip-types' } })
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0))) })
    timeout = setTimeout(() => { child?.kill() }, maxDurationMs)
    process.exitCode = await closed
  } finally {
    clearTimeout(timeout)
    if (child && child.exitCode === null && child.pid) {
      child.kill()
      await new Promise(resolve => child.once('close', resolve))
    }
    const runtime = path.resolve(runtimeRoot), tmp = path.resolve(os.tmpdir())
    const rel = path.relative(tmp, runtime)
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || !path.basename(runtime).startsWith('repoprep-m06-retrieval-')) throw new Error('unsafe-runtime-cleanup')
    const inspect = entry => { const stat = fs.lstatSync(entry); if (stat.isSymbolicLink()) throw new Error('unsafe-runtime-cleanup'); if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) inspect(path.join(entry, name)) }
    inspect(runtime); fs.rmSync(runtime, { recursive: true, force: false })
  }
}

if (require.main === module) {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch { process.stderr.write('Invalid retrieval evaluation arguments.\n'); process.exitCode = 2 }
  if (options) launch(options).catch(() => { process.stderr.write('Retrieval evaluation blocked before credential access or failed safely.\n'); process.exitCode = 1 })
}

module.exports = { parseArgs, preflight, secureTemporaryDirectory }
