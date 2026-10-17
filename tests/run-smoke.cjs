// Starts Electron as a child so its temporary appData/sessionData can be removed
// after every native handle has closed. Cleanup is bounded and part of the verdict.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assertSafeFixture(target) {
  const absolute = path.resolve(target)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, absolute)
  if (!path.basename(absolute).startsWith('repoprep-smoke-') || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('unsafe-smoke-fixture-path')
  }
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
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-smoke-'))
  assertSafeFixture(fixtureRoot)
  let childExitCode = 1
  let sawVerdict = false
  let spawnError = null
  try {
    const child = spawn(electronPath, [path.join(__dirname, 'smoke.cjs'), fixtureRoot], {
      cwd: root,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text) })
    child.stderr.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text) })
    const timeout = setTimeout(() => child.kill(), 120_000)
    const result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error, code: 1 }))
      child.once('close', (code) => resolve({ code: typeof code === 'number' ? code : 1 }))
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
