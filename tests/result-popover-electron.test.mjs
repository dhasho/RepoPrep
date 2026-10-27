import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, copyFile, readFile, writeFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'tests', 'fixtures', 'result-popover-electron')
const artifactDir = path.join(root, '.render-test', 'issue93-native-keyboard')
const rendererDir = path.join(root, 'out', 'renderer')
const evidenceRoot = path.join(root, '.validation', 'issue-cycle', 'issue-93', 'native-electron')
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function buildFixture(evidenceDir) {
  await mkdir(artifactDir, { recursive: true })
  await mkdir(evidenceDir, { recursive: true })
  const htmlPath = path.join(rendererDir, 'index.html')
  const html = await readFile(htmlPath, 'utf8').catch((error) => {
    throw new Error(`production renderer build missing at ${htmlPath}; run npm run build before this native test (${error.message})`)
  })
  const hrefs = [...html.matchAll(/<link\b(?=[^>]*\brel=["'][^"']*stylesheet[^"']*["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1])
  if (hrefs.length !== 1) throw new Error(`expected one production stylesheet in ${htmlPath}, found ${hrefs.length}`)
  const url = new URL(hrefs[0], pathToFileURL(htmlPath))
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) throw new Error(`unsafe stylesheet reference: ${hrefs[0]}`)
  const cssPath = fileURLToPath(url)
  const rendererReal = await realpath(rendererDir)
  const cssReal = await realpath(cssPath)
  const relative = path.relative(rendererReal, cssReal)
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(cssReal)).isFile()) {
    throw new Error(`production stylesheet must resolve inside ${rendererReal}: ${hrefs[0]}`)
  }
  const sourceHtml = await readFile(path.join(fixture, 'index.html'), 'utf8')
  const fixtureHtml = sourceHtml.replace(/<link\b[^>]*\bdata-production-stylesheet[^>]*>/i, '<link rel="stylesheet" href="./production.css">')
  if (fixtureHtml === sourceHtml) throw new Error('native fixture is missing its production stylesheet placeholder')
  await writeFile(path.join(artifactDir, 'index.html'), fixtureHtml)
  await copyFile(cssReal, path.join(artifactDir, 'production.css'))
  for (const filename of ['main.cjs', 'preload.cjs']) await copyFile(path.join(fixture, filename), path.join(artifactDir, filename))
  const sourcePaths = [path.join(root, 'src', 'App.tsx'), path.join(root, 'src', 'pages', 'ResultPage.tsx'), path.join(root, 'src', 'components', 'MarkdownView.tsx'), path.join(fixture, 'renderer.tsx'), path.join(fixture, 'main.cjs'), path.join(fixture, 'preload.cjs'), path.join(root, 'src', 'lib', 'question-summary.ts'), path.join(root, 'src', 'components', 'ResizableQuestionOutline.tsx'), path.join(root, 'src', 'components', 'ReadingSplitPane.tsx')]
  const [appSource, resultPageSource, markdownViewSource, rendererSource, mainSource, preloadSource, questionSummarySource, outlineSource, splitSource, cssSource] = await Promise.all([...sourcePaths, cssReal].map((item) => readFile(item)))
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const metadata = {
    sourceCommit: commit,
    appSha256: sha(appSource), resultPageSha256: sha(resultPageSource), markdownViewSha256: sha(markdownViewSource), rendererSha256: sha(rendererSource), mainSha256: sha(mainSource),
    preloadSha256: sha(preloadSource), productionCssSha256: sha(cssSource),
    questionSummarySha256: sha(questionSummarySource), questionOutlineSha256: sha(outlineSource), readingSplitSha256: sha(splitSource),
    harness: 'complete App; isolated mock window.api; Chromium CDP native keyDown/keyUp; no element.click keyboard claim'
  }
  await writeFile(path.join(artifactDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
  await build({
    entryPoints: [path.join(fixture, 'renderer.tsx')], outfile: path.join(artifactDir, 'renderer.cjs'),
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    alias: { '@shared': path.join(root, 'shared') }
  })
  const bundle = await readFile(path.join(artifactDir, 'renderer.cjs'))
  metadata.rendererBundleSha256 = sha(bundle)
  await writeFile(path.join(artifactDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
}

function runElectron(executable, evidenceDir) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', PROJECTLENS_NATIVE_METADATA: path.join(artifactDir, 'metadata.json') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, [path.join(artifactDir, 'main.cjs'), evidenceDir], {
      cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let spawnError
    let finished = false
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => finish(spawnError ? { error: spawnError, code, signal } : { code, signal }))
    const timer = setTimeout(() => {
      child.kill()
      setTimeout(() => finish({ error: new Error('Electron keyboard test exceeded 60 second process deadline') }), 2500).unref()
    }, 60_000)
  })
}

test('complete App clears old result popover on trusted native keyboard navigation', { timeout: 75_000 }, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`
  const evidenceDir = path.join(evidenceRoot, runId)
  console.log(`NATIVE_EVIDENCE_DIR ${evidenceDir}`)
  try {
    await buildFixture(evidenceDir)
    const electron = await import('electron').then((module) => module.default ?? module)
    assert.equal(typeof electron, 'string', 'installed Electron executable must be available; native test cannot skip')
    const result = await runElectron(electron, evidenceDir)
    let evidence
    try { evidence = JSON.parse(await readFile(path.join(evidenceDir, 'evidence.json'), 'utf8')) } catch {}
    assert.equal(result.error, undefined, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    assert.equal(result.code, 0, `Electron exit ${result.code}; expected VERDICT NATIVE-OK\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /VERDICT NATIVE-OK/, result.stdout)
    assert.equal(evidence?.verdict, 'NATIVE-OK', JSON.stringify(evidence, null, 2))
    for (const field of ['appSha256', 'resultPageSha256', 'markdownViewSha256', 'rendererSha256', 'rendererBundleSha256', 'mainSha256', 'preloadSha256', 'productionCssSha256', 'questionSummarySha256', 'questionOutlineSha256', 'readingSplitSha256']) {
      assert.match(evidence?.sourceMetadata?.[field] ?? '', /^[0-9a-f]{64}$/, `missing ${field} provenance`)
    }
    assert.match(evidence?.sourceMetadata?.sourceCommit ?? '', /^[0-9a-f]{40}$/)
    assert.ok(evidence.scenarios.backgroundBThenHistoryA && evidence.scenarios.keyboardViewedB && evidence.scenarios.freshBExplain && evidence.scenarios.lateAEvents)
    assert.ok(evidence.questionDirectory?.twoCompleteLines && evidence.questionDirectory.actualMouseDrag && evidence.questionDirectory.independentScrolling && evidence.questionDirectory.navigationRailUnchanged)
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
