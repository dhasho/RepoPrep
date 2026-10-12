import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { mkdir, copyFile, readFile, writeFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'tests', 'fixtures', 'term-popover-electron')
const artifactDir = path.join(root, '.render-test', 'issue92-native-wheel')
const productionRendererDir = path.join(root, 'out', 'renderer')
const evidenceDir = path.join(root, '.validation', 'issue-cycle', 'issue-92', 'native-electron')

async function buildFixture(evidenceDir) {
  await mkdir(artifactDir, { recursive: true })
  await mkdir(evidenceDir, { recursive: true })
  const builtHtmlPath = path.join(productionRendererDir, 'index.html')
  let builtHtml
  try { builtHtml = await readFile(builtHtmlPath, 'utf8') }
  catch (error) { throw new Error(`production renderer build is missing at ${builtHtmlPath}; run npm run build before the native wheel test (${error.message})`) }
  const stylesheetHrefs = [...builtHtml.matchAll(/<link\b(?=[^>]*\brel=["'][^"']*stylesheet[^"']*["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1])
  if (stylesheetHrefs.length !== 1) throw new Error(`expected one production renderer stylesheet in ${builtHtmlPath}, found ${stylesheetHrefs.length}`)
  const stylesheetUrl = new URL(stylesheetHrefs[0], pathToFileURL(builtHtmlPath))
  if (stylesheetUrl.protocol !== 'file:' || stylesheetUrl.host || stylesheetUrl.search || stylesheetUrl.hash) {
    throw new Error(`unsupported production stylesheet reference: ${stylesheetHrefs[0]}`)
  }
  const stylesheetPath = fileURLToPath(stylesheetUrl)
  const rendererRealPath = await realpath(productionRendererDir)
  const stylesheetRealPath = await realpath(stylesheetPath).catch((error) => {
    throw new Error(`production stylesheet is missing at ${stylesheetPath}; run npm run build before the native wheel test (${error.message})`)
  })
  const relativeCssPath = path.relative(rendererRealPath, stylesheetRealPath)
  if (!relativeCssPath || relativeCssPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCssPath) || !(await stat(stylesheetRealPath)).isFile()) {
    throw new Error(`production stylesheet must resolve to a file inside ${rendererRealPath}: ${stylesheetHrefs[0]}`)
  }
  const fixtureHtml = (await readFile(path.join(fixture, 'index.html'), 'utf8')).replace(
    /<link\b[^>]*\bdata-production-stylesheet[^>]*>/i,
    '<link rel="stylesheet" href="./production.css">'
  )
  if (fixtureHtml === await readFile(path.join(fixture, 'index.html'), 'utf8')) throw new Error('fixture HTML lacks its production stylesheet link placeholder')
  await writeFile(path.join(artifactDir, 'index.html'), fixtureHtml)
  await copyFile(stylesheetRealPath, path.join(artifactDir, 'production.css'))
  for (const name of ['preload.cjs', 'main.cjs']) await copyFile(path.join(fixture, name), path.join(artifactDir, name))
  const componentSource = await readFile(path.join(root, 'src', 'components', 'TermPopover.tsx'))
  const rendererSource = await readFile(path.join(fixture, 'renderer.tsx'))
  const productionCss = await readFile(stylesheetRealPath)
  const metadata = {
    productCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    componentSha256: createHash('sha256').update(componentSource).digest('hex'),
    productionCssSha256: createHash('sha256').update(productionCss).digest('hex'),
    fixtureSha256: createHash('sha256').update(rendererSource).digest('hex')
  }
  await writeFile(path.join(artifactDir, 'metadata.json'), JSON.stringify(metadata))
  await build({
    entryPoints: [path.join(fixture, 'renderer.tsx')],
    outfile: path.join(artifactDir, 'renderer.cjs'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    logLevel: 'silent',
    alias: { '@shared': path.join(root, 'shared') }
  })
}

function runElectron(executable, evidenceDir) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', PROJECTLENS_NATIVE_METADATA: path.join(artifactDir, 'metadata.json') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, [path.join(artifactDir, 'main.cjs'), evidenceDir], {
      cwd: root,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    let spawnError
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => finish(spawnError ? { error: spawnError, code, signal } : { code, signal }))
    const timer = setTimeout(() => {
      child.kill()
      setTimeout(() => finish({ error: new Error('Electron native test exceeded 45 second process deadline') }), 3000).unref()
    }, 45_000)
  })
}

test('TermPopover internal and external scrolling follows real Chromium wheel input', { timeout: 60_000 }, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`
  const evidenceDir = path.join(root, '.validation', 'issue-cycle', 'issue-92', 'native-electron', runId)
  try {
    console.log(`NATIVE_EVIDENCE_DIR ${evidenceDir}`)
    await buildFixture(evidenceDir)
    const electron = await import('electron').then((module) => module.default ?? module)
    assert.equal(typeof electron, 'string', 'installed Electron executable must be available; native test cannot skip')
    const result = await runElectron(electron, evidenceDir)
    let evidence = null
    try { evidence = JSON.parse(await readFile(path.join(evidenceDir, 'evidence.json'), 'utf8')) } catch {}
    assert.equal(result.error, undefined, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    assert.equal(result.code, 0, `Electron exit ${result.code}; expected VERDICT NATIVE-OK\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /VERDICT NATIVE-OK/, result.stdout)
    assert.equal(evidence?.verdict, 'NATIVE-OK', JSON.stringify(evidence, null, 2))
    assert.match(evidence?.sourceMetadata?.productCommit ?? '', /^[0-9a-f]{40}$/)
    assert.match(evidence?.sourceMetadata?.componentSha256 ?? '', /^[0-9a-f]{64}$/)
    assert.match(evidence?.sourceMetadata?.productionCssSha256 ?? '', /^[0-9a-f]{64}$/)
    assert.ok(evidence.scenarios.glossary && evidence.scenarios.streaming && evidence.scenarios.external)
  } catch (error) {
    const message = error?.stack || String(error)
    console.error(`VERDICT NATIVE-FAIL\n${message}`)
    try {
      await mkdir(evidenceDir, { recursive: true })
      await writeFile(path.join(evidenceDir, 'wrapper-failure.json'), JSON.stringify({ verdict: 'NATIVE-FAIL', runId, error: message }, null, 2))
    } catch (writeError) { console.error(`Could not persist wrapper failure evidence: ${writeError}`) }
    throw error
  }
})
