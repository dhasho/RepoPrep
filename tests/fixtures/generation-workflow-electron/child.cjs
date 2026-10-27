// Isolated native workflow child. This loads the built main/preload/renderer;
// only native picker dialogs and test-window visibility are controlled here.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog } = require('electron')

const fixtureRoot = path.resolve(process.env.REPOPREP_WORKFLOW_FIXTURE || '')
const projectA = path.resolve(process.env.REPOPREP_WORKFLOW_PROJECT_A || '')
const projectB = path.resolve(process.env.REPOPREP_WORKFLOW_PROJECT_B || '')
const exportPath = path.resolve(process.env.REPOPREP_WORKFLOW_EXPORT || '')
const modelControlUrl = process.env.REPOPREP_WORKFLOW_CONTROL_URL || ''
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const expectedRenderer = path.join(repoRoot, 'out', 'renderer', 'index.html')
const appData = path.join(fixtureRoot, 'app-data')
const sessionData = path.join(fixtureRoot, 'session-data')

const assertSafeFixturePath = (value) => {
  const absolute = path.resolve(value)
  const temp = path.resolve(require('node:os').tmpdir())
  const relative = path.relative(temp, absolute)
  assert.ok(path.basename(fixtureRoot).startsWith('repoprep-generation-workflow-'), 'fixture prefix is controlled')
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture stays inside OS temp')
  return absolute
}

let activeFolder = projectA
let activeWindow = null
let finished = false
let timer
const rendererErrors = []
const evidence = {
  status: 'running',
  proofBoundary: {
    rendererInteraction: 'executeJavaScript DOM clicks and input events; not trusted native mouse/keyboard input',
    bridgeCalls: ['settings save/read', 'analysis list/load', 'result read'],
    model: 'loopback synthetic OpenAI-compatible HTTP JSON; no external model service'
  },
  uiActions: [],
  checks: {},
  requests: null,
  scopeUi: 'unobserved'
}

function finish(ok, error) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  evidence.status = ok ? 'passed' : 'failed'
  if (error) evidence.error = error instanceof Error ? error.message : String(error)
  console.log(`EVIDENCE ${JSON.stringify(evidence)}`)
  console.log(`VERDICT WORKFLOW-${ok ? 'OK' : 'FAIL'}`)
  app.exit(ok ? 0 : 1)
}

async function waitFor(description, predicate, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`timeout waiting for ${description}`)
}

async function bodyText() {
  return activeWindow.webContents.executeJavaScript('document.body.innerText')
}

async function click(selector, description) {
  const result = await activeWindow.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    element.click()
    return true
  })()`)
  assert.equal(result, true, `missing UI control: ${description}`)
  evidence.uiActions.push(description)
}

async function clickButton(text, description = text, mode = 'exact') {
  const result = await activeWindow.webContents.executeJavaScript(`(() => {
    const wanted = ${JSON.stringify(text)}
    const button = [...document.querySelectorAll('button')].find((item) => {
      const value = item.innerText.trim()
      return ${JSON.stringify(mode)} === 'starts' ? value.startsWith(wanted) : value === wanted
    })
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  assert.equal(result, true, `missing or disabled UI button: ${description}`)
  evidence.uiActions.push(description)
}

async function setInputByPlaceholder(placeholder, value, description) {
  const result = await activeWindow.webContents.executeJavaScript(`(() => {
    const wanted = ${JSON.stringify(placeholder)}
    const input = [...document.querySelectorAll('input')].find((item) => item.getAttribute('placeholder') === wanted)
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert.equal(result, true, `missing UI input: ${description}`)
  evidence.uiActions.push(description)
}

async function bridge(expression, description) {
  evidence.proofBoundary.bridgeCalls.push(description)
  return activeWindow.webContents.executeJavaScript(expression)
}

async function modelState() {
  const response = await fetch(`${modelControlUrl}/__workflow/state`)
  assert.equal(response.ok, true)
  return response.json()
}

async function waitForRequest(count) {
  await waitFor(`loopback model request ${count}`, async () => (await modelState()).requests.length >= count)
}

async function waitForModelCompletion(count) {
  await waitFor(`loopback model completion ${count}`, async () => (await modelState()).completed >= count)
}

async function waitForPage(label, predicate) {
  await waitFor(label, async () => predicate(await bodyText()))
}

async function clickProject(pathValue, name) {
  const result = await activeWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[data-project-path]')].find((item) => item.dataset.projectPath === ${JSON.stringify(pathValue)})
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.equal(result, true, `missing project row: ${name}`)
  evidence.uiActions.push(`switch project ${name}`)
}

async function runWorkflow() {
  assertSafeFixturePath(fixtureRoot)
  assertSafeFixturePath(appData)
  assertSafeFixturePath(sessionData)
  assertSafeFixturePath(projectA)
  assertSafeFixturePath(projectB)
  assertSafeFixturePath(exportPath)
  assert.ok(modelControlUrl.startsWith('http://127.0.0.1:'), 'model must be a local loopback server')

  app.setPath('appData', appData)
  app.setPath('sessionData', sessionData)
  app.setPath('cache', path.join(fixtureRoot, 'cache'))
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [activeFolder] })
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath })

  // The dedicated Electron child must not display a second application window.
  BrowserWindow.prototype.show = function hideWorkflowWindow() { this.hide() }
  app.on('browser-window-created', (_event, win) => {
    activeWindow = win
    win.webContents.setBackgroundThrottling(false)
    win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`render-process-gone:${details.reason}`))
    win.webContents.on('did-fail-load', (_event, code, description) => rendererErrors.push(`did-fail-load:${code}:${description}`))
    win.webContents.on('preload-error', (_event, preloadPath, error) => rendererErrors.push(`preload-error:${preloadPath}:${error.message}`))
  })

  require(path.join(repoRoot, 'out', 'main', 'index.js'))
  await app.whenReady()
  await waitFor('production renderer and preload', async () => activeWindow && activeWindow.webContents.getURL().startsWith('file://') &&
    await activeWindow.webContents.executeJavaScript('document.readyState === "complete" && Boolean(document.getElementById("root")?.children.length)'))
  const actualUrl = activeWindow.webContents.getURL()
  assert.equal(actualUrl, pathToFileURL(expectedRenderer).href, 'must load the built production renderer file URL')
  const runtime = await activeWindow.webContents.executeJavaScript(`({
    api: typeof window.api === 'object' && window.api !== null,
    title: document.title,
    rootChildren: document.getElementById('root')?.children.length ?? 0,
    nodeBridgeUnavailable: typeof require === 'undefined' && typeof process === 'undefined'
  })`)
  assert.equal(runtime.api, true, 'the production preload must expose window.api')
  assert.ok(runtime.rootChildren > 0, 'the production React renderer must mount')
  evidence.checks.renderer = { url: actualUrl, title: runtime.title, rootChildren: runtime.rootChildren, preloadApi: runtime.api, nodeBridgeUnavailable: runtime.nodeBridgeUnavailable }

  // Create a no-secret profile through the actual Settings UI and real settings IPC.
  await click('button[aria-label="设置"]', 'open settings page')
  await waitForPage('settings page', (text) => text.includes('新增配置') && text.includes('扫描安全上限'))
  await clickButton('新增配置', 'add synthetic profile')
  const profileName = `Loopback workflow ${Date.now()}`
  await setInputByPlaceholder('如：DeepSeek 日常用', profileName, 'set profile name')
  await setInputByPlaceholder('https://api.deepseek.com/v1', process.env.REPOPREP_WORKFLOW_MODEL_URL, 'set loopback endpoint')
  await setInputByPlaceholder('deepseek-chat，或点右侧按钮检测', 'workflow-synthetic-model', 'set synthetic model')
  await activeWindow.webContents.executeJavaScript(`(() => { const input = [...document.querySelectorAll('input[type="checkbox"]')].find((item) => item.closest('label')?.innerText.includes('设为默认')); if (!input) return false; if (!input.checked) input.click(); return true })()`).then((ok) => assert.equal(ok, true))
  evidence.uiActions.push('set synthetic profile as default')
  await clickButton('保存', 'save synthetic profile', 'starts')
  await waitForPage('saved settings', (text) => text.includes('已保存') && text.includes(profileName))
  const settings = await bridge('window.api.getSettings()', 'get public settings')
  const profile = settings.profiles.find((item) => item.name === profileName)
  assert.ok(profile, 'saved profile must round-trip over the public settings API')
  assert.equal(profile.hasApiKey, false)
  assert.equal(Object.hasOwn(profile, 'apiKey'), false, 'public settings must not expose credentials')
  const settingsFile = await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')
  assert.ok(!settingsFile.includes('apiKey'))
  evidence.checks.profile = { idPresent: Boolean(profile.id), defaultProfileIdMatches: settings.defaultProfileId === profile.id, credentialAbsent: true }
  await clickButton('返回', 'return from settings')
  await waitForPage('project selection page', (text) => text.includes('选择一个项目'))

  const firstProjectName = path.basename(projectA)
  const draftDirectory = assertSafeFixturePath(path.join(app.getPath('userData'), 'generation-drafts'))
  const corruptDraftFile = path.join(draftDirectory, `${require('node:crypto').createHash('sha256').update(projectA).digest('hex')}.json`)
  await fs.mkdir(draftDirectory, { recursive: true })
  await fs.writeFile(corruptDraftFile, '{synthetic interrupted checkpoint')
  activeFolder = projectA
  await click('button[aria-label="新建分析"]', 'select and scan project A through UI')
  await waitForPage('project A configuration', (text) => text.includes(firstProjectName) && text.includes('开始生成面试题'))
  await waitForPage('corrupt draft is actionable over actual Electron IPC', (text) => text.includes('丢弃损坏草稿'))
  await clickButton('丢弃损坏草稿', 'explicitly archive corrupt generation draft')
  await waitForPage('corrupt draft discarded without generation', (text) => !text.includes('读取生成草稿失败') && !text.includes('正在检查可继续'))
  const archivedDrafts = (await fs.readdir(draftDirectory)).filter((name) => name.includes('.corrupt-'))
  assert.equal(archivedDrafts.length, 1)
  assert.equal(await fs.readFile(path.join(draftDirectory, archivedDrafts[0]), 'utf8'), '{synthetic interrupted checkpoint')
  assert.equal((await modelState()).requests.length, 0, 'corrupt cleanup never invokes a model')
  evidence.checks.corruptDraft = { explicitArchive: true, originalBytesPreserved: true, modelCalls: 0 }
  const recentAfterScan = await bridge('window.api.getRecentProjects()', 'verify project A entered recents')
  assert.ok(recentAfterScan.some((project) => project.path === projectA))
  await clickButton('后端', 'choose backend direction')
  const startGeneration = async () => {
    await waitFor('draft inspection settled', () => activeWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(b=>!b.disabled && (b.innerText==='继续生成' || b.innerText.startsWith('开始生成面试题')))`))
    if ((await bodyText()).includes('可继续的生成任务')) await clickButton('继续生成', 'resume saved generation draft')
    else await clickButton('开始生成面试题', 'start generation', 'starts')
  }

  // Wait for three durable streamed questions before cancelling the held request.
  await startGeneration()
  await waitForRequest(1)
  await waitForPage('active generation UI', (text) => text.includes('正在为') && text.includes('取消生成'))
  await waitForPage('three saved streamed questions', (text) => text.includes('已保存 3/20 题'))
  const partialDraft = await bridge(`window.api.getGenerationDraft(${JSON.stringify(projectA)})`, 'verify three-question progress through guarded draft IPC')
  assert.equal(partialDraft.completedQuestions, 3)
  assert.equal(partialDraft.completedBatches, 0)
  assert.equal(partialDraft.totalBatches, 1)
  assert.equal(Object.hasOwn(partialDraft, 'checkpoint'), false, 'public draft summary must not expose private checkpoint contents')
  const partialDraftBytes = await fs.readFile(corruptDraftFile)
  const partialRecord = JSON.parse(partialDraftBytes.toString('utf8'))
  const initialQuestions = partialRecord.checkpoint.pending.batch.sections.flatMap((section) => section.questions)
  assert.equal(initialQuestions.length, 3)
  const initialQuestionBytes = initialQuestions.map((question) => JSON.stringify(question))
  evidence.checks.partialStream = { savedQuestions: 3, completedBatches: 0, modelCalls: 1, checkpointPrivate: true }
  await clickButton('取消生成', 'cancel generation through production UI')
  await waitForPage('cancelled generation returns to configuration', (text) => text.includes('开始生成面试题') && !text.includes('正在为'))
  await waitFor('first model stream abort', async () => (await modelState()).aborted.includes(1))
  const afterCancelAnalyses = await bridge(`window.api.listAnalyses(${JSON.stringify(projectA)})`, 'verify cancelled run has no analysis record')
  const afterCancelResult = await bridge(`window.api.loadResult(${JSON.stringify(projectA)})`, 'verify cancelled run has no latest result')
  assert.equal(afterCancelAnalyses.items.length, 0)
  assert.equal(afterCancelResult, null)
  const cancelledDraft = await bridge(`window.api.getGenerationDraft(${JSON.stringify(projectA)})`, 'verify cancelled run preserves a private draft')
  assert.ok(cancelledDraft && !cancelledDraft.ready)
  assert.equal(cancelledDraft.completedBatches, 0)
  assert.equal(cancelledDraft.completedQuestions, 3)
  assert.deepEqual(await fs.readFile(corruptDraftFile), partialDraftBytes, 'cancellation leaves the last complete-question snapshot byte-identical')
  assert.equal(Object.hasOwn(cancelledDraft, 'checkpoint'), false)
  evidence.checks.cancel = { requestAborted: true, analysisCount: 0, latestResultNull: true, resumableDraftQuestions: 3, snapshotByteIdentical: true }

  // Resume the saved prefix with one stream that supplies only the remaining 17 questions.
  await startGeneration()
  await waitForRequest(2)
  const resumedModelState = await modelState()
  assert.equal(resumedModelState.requests[1].stream, true)
  assert.equal(resumedModelState.requests[1].requestedQuota, 17)
  assert.equal(resumedModelState.requests[1].includesSavedQuestion01, true)
  assert.equal(resumedModelState.requests[1].includesSavedQuestion02, true)
  assert.equal(resumedModelState.requests[1].includesSavedQuestion03, true)
  assert.equal(resumedModelState.requests[1].model, resumedModelState.requests[0].model)
  await waitForPage('successful result', (text) => text.includes('SYNTHETIC_WORKFLOW_QUESTION_01'))
  const savedAnalyses = await bridge(`window.api.listAnalyses(${JSON.stringify(projectA)})`, 'list saved analyses for project A')
  assert.equal(savedAnalyses.items.length, 1)
  const analysisId = savedAnalyses.items[0].id
  const loadedAnalysis = await bridge(`window.api.loadAnalysis(${JSON.stringify(projectA)}, ${JSON.stringify(analysisId)})`, 'load saved analysis for project A')
  const loadedResult = await bridge(`window.api.loadResult(${JSON.stringify(projectA)})`, 'load latest saved result for project A')
  assert.ok(loadedAnalysis)
  assert.ok(loadedResult)
  const totalQuestions = loadedResult.sections.reduce((sum, section) => sum + section.questions.length, 0)
  assert.equal(totalQuestions, 20)
  assert.ok(loadedResult.sections[0].questions[0].question.includes('SYNTHETIC_WORKFLOW_QUESTION_01'))
  assert.deepEqual(loadedResult.sections[0].questions.slice(0, 3), initialQuestions, 'resumption preserves the accepted question objects, including IDs and metadata')
  assert.deepEqual(loadedResult.sections[0].questions.slice(0, 3).map((question) => JSON.stringify(question)), initialQuestionBytes, 'published questions retain their exact serialized snapshots')
  assert.equal(await bridge(`window.api.getGenerationDraft(${JSON.stringify(projectA)})`, 'published report no longer needs a draft'), null)
  assert.equal((await modelState()).requests.length, 2, 'resume adds exactly one model request')
  assert.equal((await modelState()).completed, 1)
  assert.equal(loadedResult.generationDiagnostics.status, 'succeeded')
  assert.equal(loadedResult.generationDiagnostics.requestCount, 1)
  assert.equal(loadedResult.generationDiagnostics.inputTokenBudget, 64_000)
  assert.equal(loadedResult.generationDiagnostics.usageComplete, true)
  assert.deepEqual(loadedResult.generationDiagnostics.actualUsage, { inputTokens: 37, outputTokens: 19, totalTokens: 56 })
  assert.deepEqual(loadedAnalysis.generationDiagnostics, loadedResult.generationDiagnostics)
  await click('button[aria-label="项目分析目录"]', 'open project and history sidebar')
  await waitFor('project A sidebar row', async () => activeWindow.webContents.executeJavaScript(`Boolean([...document.querySelectorAll('[data-project-path]')].find((item) => item.dataset.projectPath === ${JSON.stringify(projectA)}))`))
  await activeWindow.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === ${JSON.stringify(`展开 ${firstProjectName} 的分析`)}); if (!button) return false; button.click(); return true })()`).then((ok) => assert.equal(ok, true))
  evidence.uiActions.push('expand project A analysis history')
  await waitFor('history row for project A analysis', async () => activeWindow.webContents.executeJavaScript(`Boolean(document.querySelector('[data-analysis-id="${analysisId}"]'))`))
  await activeWindow.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.dataset.analysisId === ${JSON.stringify(analysisId)}); if (!button) return false; button.click(); return true })()`).then((ok) => assert.equal(ok, true))
  evidence.uiActions.push('open saved A analysis from history list')
  await waitForPage('history analysis opened', (text) => text.includes('SYNTHETIC_WORKFLOW_QUESTION_01'))
  const resultText = await bodyText()
  assert.ok(!resultText.includes('分析范围与用量'))
  assert.ok(!resultText.includes('系统估算输入'))
  assert.ok(!resultText.includes('服务商回执'))
  evidence.scopeUi = 'absent'
  await activeWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))')
  const scopeImage = await activeWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  await fs.writeFile(process.env.REPOPREP_WORKFLOW_SCREENSHOT, scopeImage.toPNG())

  // Export the actual rendered result through IPC and the patched native save picker.
  await clickButton('导出 Markdown', 'export Markdown from result UI')
  await waitForPage('export confirmation', (text) => text.includes('导出成功') || text.includes('已导出'))
  const markdown = await fs.readFile(exportPath, 'utf8')
  assert.ok(markdown.includes('SYNTHETIC_WORKFLOW_QUESTION_01'))
  assert.ok(markdown.includes('Loopback workflow') || markdown.includes('中粒度'))
  assert.ok(!markdown.includes('## 分析范围与用量'))
  assert.ok(!markdown.includes('系统估算输入'))
  assert.ok(!markdown.includes('服务商回执'))
  evidence.checks.export = { wroteFile: true, containsGeneratedQuestion: true, bytes: Buffer.byteLength(markdown) }

  // Start a second A generation, move to B in the background, then deliver A's
  // delayed response and verify it cannot navigate or overwrite B's page.
  await clickButton('重新生成', 'reopen project A configuration')
  await waitForPage('project A reconfiguration', (text) => text.includes(firstProjectName) && text.includes('开始生成面试题'))
  await startGeneration()
  await waitForRequest(3)
  await click('button[aria-label="新建分析"]', 'request navigation away from active A run')
  await waitForPage('leave generation dialog', (text) => text.includes('仍在生成') && text.includes('后台继续'))
  activeFolder = projectB
  await clickButton('后台继续', 'continue A run in background')
  await waitForPage('project B configuration', (text) => text.includes(path.basename(projectB)) && text.includes('开始生成面试题'))
  await fetch(`${modelControlUrl}/__workflow/release/3`, { method: 'POST' }).then((response) => assert.equal(response.ok, true))
  await waitForModelCompletion(2)
  await waitFor('background A result persisted', async () => {
    const page = await bridge(`window.api.listAnalyses(${JSON.stringify(projectA)})`, 'poll A history after delayed response')
    return page.items.length === 2
  })
  await new Promise((resolve) => setTimeout(resolve, 350))
  const pageAfterLateResponse = await bodyText()
  assert.ok(pageAfterLateResponse.includes(path.basename(projectB)), 'late A completion must leave project B visible')
  assert.ok(pageAfterLateResponse.includes('开始生成面试题'))

  // Exercise explicit project switching in both directions after the delayed A completion.
  await clickProject(projectA, firstProjectName)
  await waitForPage('switch from B back to A', (text) => text.includes(firstProjectName) && text.includes('开始生成面试题'))
  await clickProject(projectB, path.basename(projectB))
  await waitForPage('switch from A to B', (text) => text.includes(path.basename(projectB)) && text.includes('开始生成面试题'))
  const aHistory = await bridge(`window.api.listAnalyses(${JSON.stringify(projectA)})`, 'verify A history count after late success')
  assert.equal(aHistory.items.length, 2)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.ok(rendererErrors.length === 0, `renderer lifecycle errors: ${rendererErrors.join('; ')}`)

  evidence.checks.generation = { cancelledThenResumed: true, resumedQuota: resumedModelState.requests[1].requestedQuota, savedQuestionCount: totalQuestions, analysisCountAfterBackgroundCompletion: aHistory.items.length }
  evidence.checks.projectSwitch = { currentProject: path.basename(projectB), lateACompletionDidNotNavigate: true }
  evidence.requests = await modelState()
  assert.equal(evidence.requests.requests.length, 3)
  assert.equal(evidence.requests.completed, 2)
  assert.deepEqual(evidence.requests.aborted, [1])
  evidence.checks.ipcBoundary = 'settings and storage assertions used real window.api → preload → guarded main-process IPC; only picker dialogs were replaced'
  evidence.checks.rendererErrors = rendererErrors
}

assertSafeFixturePath(fixtureRoot)
app.setPath('appData', appData)
app.setPath('sessionData', sessionData)
timer = setTimeout(() => finish(false, new Error('WORKFLOW-HARD-TIMEOUT')), 120_000)
timer.unref?.()
process.on('unhandledRejection', (error) => finish(false, error))
process.on('uncaughtException', (error) => finish(false, error))
runWorkflow().then(() => finish(true), (error) => finish(false, error))
