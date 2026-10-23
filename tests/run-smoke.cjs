// Starts Electron as a child so its temporary appData/sessionData can be removed
// after every native handle has closed. Cleanup is bounded and part of the verdict.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const asar = require('@electron/asar')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function parseArguments(args) {
  if (args.length === 0) return { asarPath: null }
  if (args.length !== 2 || args[0] !== '--asar' || !path.isAbsolute(args[1])) {
    throw new Error('usage: node tests/run-smoke.cjs [--asar <absolute dist/win-unpacked/resources/app.asar>]')
  }
  return { asarPath: args[1] }
}

function assertPackagedAsar(target) {
  const absolute = path.resolve(target)
  const distRoot = path.resolve(root, 'dist')
  const expected = path.join(distRoot, 'win-unpacked', 'resources', 'app.asar')
  if (absolute.toLowerCase() !== expected.toLowerCase() || !isInside(distRoot, absolute)) {
    throw new Error('asar-path-outside-owned-dist')
  }

  for (const directory of [distRoot, path.dirname(path.dirname(absolute)), path.dirname(absolute)]) {
    const info = fs.lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('asar-parent-is-not-a-physical-directory')
    if (fs.realpathSync(directory).toLowerCase() !== path.resolve(directory).toLowerCase()) {
      throw new Error('asar-parent-realpath-mismatch')
    }
  }
  const info = fs.lstatSync(absolute)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('asar-is-not-an-ordinary-file')
  if (fs.realpathSync(absolute).toLowerCase() !== absolute.toLowerCase()) throw new Error('asar-realpath-mismatch')

  const entries = new Set(asar.listPackage(absolute).map((entry) => entry.replace(/^[\\/]+/, '').replace(/\\/g, '/')))
  for (const entry of [
    'package.json',
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'node_modules/typescript/lib/typescript.js',
    'node_modules/typescript/package.json'
  ]) {
    if (!entries.has(entry)) throw new Error(`asar-missing-required-entry:${entry}`)
  }

  const packageJson = JSON.parse(asar.extractFile(absolute, 'package.json').toString('utf8'))
  if (typeof packageJson.dependencies?.typescript !== 'string') throw new Error('asar-typescript-is-not-a-production-dependency')
  const typescriptPackagePath = path.join('node_modules', 'typescript', 'package.json')
  const typescriptRuntimePath = path.join('node_modules', 'typescript', 'lib', 'typescript.js')
  const typescriptPackage = JSON.parse(asar.extractFile(absolute, typescriptPackagePath).toString('utf8'))
  if (!typescriptPackage.version || !typescriptPackage.main) throw new Error('asar-typescript-package-metadata-invalid')
  const typescriptRuntimeBytes = asar.extractFile(absolute, typescriptRuntimePath)
  if (typescriptRuntimeBytes.length === 0) throw new Error('asar-typescript-runtime-empty')

  const archiveHash = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
  return {
    path: absolute,
    sizeBytes: info.size,
    sha256: archiveHash,
    appVersion: packageJson.version,
    typescriptDependency: packageJson.dependencies.typescript,
    packagedTypeScriptVersion: typescriptPackage.version,
    packagedTypeScriptBytes: typescriptRuntimeBytes.length
  }
}

function assertSafeFixture(target) {
  const absolute = path.resolve(target)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, absolute)
  if (!path.basename(absolute).startsWith('repoprep-smoke-') || path.dirname(absolute) !== tempRoot || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('unsafe-smoke-fixture-path')
  }
  const info = fs.lstatSync(absolute)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe-smoke-fixture-type')
  if (fs.realpathSync(absolute) !== absolute) throw new Error('unsafe-smoke-fixture-realpath')
  return absolute
}

async function removeFixtureAfterExit(target) {
  const absolute = assertSafeFixture(target)
  let lastError
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 0 })
      if (!fs.existsSync(absolute)) return
      lastError = new Error('fixture-still-exists')
    } catch (error) {
      lastError = error
    }
    if (attempt < 9) await wait(250)
  }
  throw new Error(`fixture-cleanup-failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function main() {
  const { asarPath } = parseArguments(process.argv.slice(2))
  const asarInfo = asarPath ? assertPackagedAsar(asarPath) : null
  if (asarInfo) {
    console.log(`[smoke-runner] ASAR=${asarInfo.path}`)
    console.log(`[smoke-runner] appVersion=${asarInfo.appVersion} typescriptDependency=${asarInfo.typescriptDependency} packagedTypeScript=${asarInfo.packagedTypeScriptVersion} bytes=${asarInfo.packagedTypeScriptBytes}`)
    console.log(`[smoke-runner] ASAR sizeBytes=${asarInfo.sizeBytes} sha256=${asarInfo.sha256}`)
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-smoke-'))
  assertSafeFixture(fixtureRoot)
  let childExitCode = 1
  let sawVerdict = false
  let spawnError = null
  try {
    const childArgs = [path.join(__dirname, 'smoke.cjs'), fixtureRoot]
    if (asarPath) childArgs.push('--asar', asarInfo.path)
    const childEnv = { ...process.env }
    if (asarPath) delete childEnv.ELECTRON_RENDERER_URL
    const child = spawn(electronPath, childArgs, {
      cwd: root,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text) })
    child.stderr.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text) })
    const timeout = setTimeout(() => {
      console.error('[smoke-runner] child timeout; terminating Electron before fixture cleanup')
      child.kill()
    }, 120_000)
    const result = await new Promise((resolve) => {
      let spawnError = null
      child.once('error', (error) => { spawnError = error })
      child.once('close', (code) => resolve({ error: spawnError, code: typeof code === 'number' ? code : 1 }))
    })
    clearTimeout(timeout)
    spawnError = result.error ?? null
    childExitCode = result.code
    sawVerdict = output.includes('VERDICT SMOKE-OK') && !output.includes('VERDICT SMOKE-FAIL')
    if (spawnError) throw spawnError
  } finally {
    await removeFixtureAfterExit(fixtureRoot)
  }

  if (!sawVerdict) throw new Error('Electron smoke did not emit VERDICT SMOKE-OK')
  if (childExitCode !== 0) throw new Error(`Electron smoke exited with ${childExitCode}`)
  console.log('[smoke-runner] fixture cleaned after Electron exit')
}

main().catch((error) => {
  console.error(`[smoke-runner] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
