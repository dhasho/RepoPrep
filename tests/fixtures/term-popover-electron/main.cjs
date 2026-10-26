const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const fixtureDir = __dirname
const outputDir = process.argv[process.argv.length - 1]
const evidence = { verdict: 'NATIVE-FAIL', source: 'actual static TermPopover and SelectionExplainPanel bundles in hidden sandboxed Electron Chromium', scenarios: {} }
try { evidence.sourceMetadata = JSON.parse(fs.readFileSync(process.env.PROJECTLENS_NATIVE_METADATA, 'utf8')) }
catch (error) { evidence.metadataError = String(error) }
let win
const timeout = (ms, label) => new Promise((_, reject) => setTimeout(() => reject(new Error(`deadline exceeded: ${label}`)), ms))
const within = (promise, label, ms = 7000) => Promise.race([promise, timeout(ms, label)])

async function waitFor(check, label) {
  const end = Date.now() + 7000
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`deadline exceeded waiting for ${label}`)
}

async function evaluate(expression) {
  return within(win.webContents.executeJavaScript(expression), 'renderer evaluation')
}

async function wheelAt(selector, deltaY) {
  const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); const outside=${JSON.stringify(selector)}==='#outside-scroll'; return outside?{x:Math.round(r.right-30),y:Math.round(r.bottom-30)}:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)} })()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, modifiers: 0
  })
}

function installEvidenceObserver() {
  return `(() => {
    window.__wheelEvidence = { wheels: [], scrolls: [] };
    addEventListener('wheel', e => window.__wheelEvidence.wheels.push({trusted:e.isTrusted,deltaY:e.deltaY,target:e.target?.className||e.target?.id||e.target?.tagName}), true);
    addEventListener('scroll', e => window.__wheelEvidence.scrolls.push({trusted:e.isTrusted,target:e.target?.className||e.target?.id||e.target?.tagName,top:e.target===document?scrollY:e.target?.scrollTop}), true);
  })()`
}

async function snapshot() {
  return evaluate(`({ ...window.__wheelEvidence, popup:!!document.querySelector('[role="dialog"], [aria-label="AI 解释"]'), selectionText:document.querySelector('[aria-label="AI 解释"] blockquote')?.textContent, typography:(()=>{const e=document.querySelector('.md-body');if(!e)return null;const s=getComputedStyle(e);return {fontSize:s.fontSize,lineHeight:s.lineHeight,fontFamily:s.fontFamily}})(), content:(()=>{const e=document.querySelector('[role="dialog"] .overflow-y-auto, [aria-label="AI 解释"] .overflow-y-auto');return e?{top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,max:e.scrollHeight-e.clientHeight,className:e.className,overscrollBehaviorY:getComputedStyle(e).overscrollBehaviorY}:null})(), pageScroll:scrollY, outsideTop:document.querySelector('#outside-scroll').scrollTop })`)
}

async function observedWheel(selector, deltaY, previousCount, label) {
  await wheelAt(selector, deltaY)
  return waitFor(async () => {
    const state = await snapshot()
    return state.wheels.length > previousCount && state.wheels.at(-1)?.trusted ? state : null
  }, label)
}

async function run() {
  if (evidence.metadataError || !evidence.sourceMetadata?.productCommit || !evidence.sourceMetadata?.componentSha256) {
    throw new Error(`missing source provenance: ${evidence.metadataError || 'incomplete metadata'}`)
  }
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  win = new BrowserWindow({
    show: false, width: 900, height: 700, paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(fixtureDir, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, backgroundThrottling: false
    }
  })
  win.webContents.debugger.attach('1.3')
  await within(win.loadFile(path.join(fixtureDir, 'index.html')), 'fixture load')
  await evaluate(installEvidenceObserver())
  await waitFor(() => evaluate(`document.querySelector('#fixture-ready')?.textContent === 'ready' && !!document.querySelector('[role="dialog"] .overflow-y-auto, [aria-label="AI 解释"] .overflow-y-auto')`), 'initial static glossary mount')
  const glossaryBefore = await snapshot()
  const glossaryInitialApi = await evaluate('window.nativeTest.state()')
  if (glossaryBefore.typography?.fontSize !== '15px') throw new Error(`definition has inconsistent typography: ${JSON.stringify(glossaryBefore.typography)}`)
  if (glossaryInitialApi.explains.length !== 0 || glossaryInitialApi.subscriptions !== 0 || glossaryInitialApi.cancels.length !== 0) throw new Error(`static glossary unexpectedly started AI lifecycle: ${JSON.stringify(glossaryInitialApi)}`)
  await observedWheel('.overflow-y-auto', 520, glossaryBefore.wheels.length, 'trusted glossary wheel scroll')
  await waitFor(async () => (await snapshot()).content?.top>0, 'glossary scroll position change')
  const glossaryState = await evaluate('window.nativeTest.state()')
  const glossaryAfter = await snapshot()
  fs.writeFileSync(path.join(outputDir, 'definition-preview.png'), (await win.webContents.capturePage()).toPNG())
  if (!glossaryAfter.popup || glossaryState.cancels.length !== 0 || glossaryState.explains.length !== 0 || glossaryState.pending.length !== 0 ||
      glossaryState.subscriptions !== 0 || glossaryState.unsubscriptions !== 0) throw new Error('glossary internal wheel closed the static popover or started AI lifecycle')
  if (!glossaryAfter.content.className.split(/\s+/).includes('overscroll-contain') || glossaryAfter.content.overscrollBehaviorY !== 'contain') {
    throw new Error(`fixture did not apply the production overscroll utility: ${JSON.stringify(glossaryAfter.content)}`)
  }

  let edgeState = glossaryAfter
  const edgeWheelLimit = Math.ceil(glossaryAfter.content.max / 560) + 4
  for (let i = 0; i < edgeWheelLimit && edgeState.content.top < edgeState.content.max - 1; i++) {
    edgeState = await observedWheel('.overflow-y-auto', 560, edgeState.wheels.length, `glossary scroll toward bottom (${i + 1})`)
  }
  await waitFor(async () => { const s=await snapshot(); return s.content?.top >= s.content?.max - 1 }, 'glossary bottom boundary')
  const bottomBefore = await snapshot()
  const bottomEdge = await observedWheel('.overflow-y-auto', 620, bottomBefore.wheels.length, 'trusted downward wheel at glossary bottom edge')
  if (!bottomEdge.popup || bottomEdge.content.top < bottomEdge.content.max - 1 || bottomEdge.outsideTop !== 0 ||
      bottomEdge.wheels.at(-1)?.deltaY <= 0 || (await evaluate('window.nativeTest.state()')).cancels.length !== 0) {
    throw new Error(`downward edge wheel chained outside or closed/cancelled: ${JSON.stringify(bottomEdge)}`)
  }

  edgeState = bottomEdge
  for (let i = 0; i < edgeWheelLimit && edgeState.content.top > 1; i++) {
    edgeState = await observedWheel('.overflow-y-auto', -560, edgeState.wheels.length, `glossary scroll toward top (${i + 1})`)
  }
  await waitFor(async () => { const s=await snapshot(); return s.content?.top <= 1 }, 'glossary top boundary')
  const topBefore = await snapshot()
  const topEdge = await observedWheel('.overflow-y-auto', -620, topBefore.wheels.length, 'trusted upward wheel at glossary top edge')
  const edgeApi = await evaluate('window.nativeTest.state()')
  if (!topEdge.popup || topEdge.content.top > 1 || topEdge.outsideTop !== 0 || topEdge.wheels.at(-1)?.deltaY >= 0 ||
      edgeApi.cancels.length !== 0 || edgeApi.explains.length !== 0 || edgeApi.pending.length !== 0 || edgeApi.subscriptions !== 0) {
    throw new Error(`upward edge wheel chained outside or closed/started AI lifecycle: ${JSON.stringify(topEdge)}`)
  }
  const glossaryExternalBefore = await snapshot()
  await wheelAt('#outside-scroll', 540)
  await waitFor(async () => { const s = await snapshot(); return !s.popup && s.outsideTop > 0 && s.wheels.length > glossaryExternalBefore.wheels.length && s.wheels.at(-1)?.trusted }, 'external glossary wheel closes static popover')
  const glossaryExternal = await snapshot()
  const glossaryExternalApi = await evaluate('window.nativeTest.state()')
  if (glossaryExternalApi.explains.length !== 0 || glossaryExternalApi.cancels.length !== 0 || glossaryExternalApi.subscriptions !== 0 || glossaryExternalApi.unsubscriptions !== 0) throw new Error(`external glossary wheel started or cancelled AI lifecycle: ${JSON.stringify(glossaryExternalApi)}`)
  evidence.scenarios.glossary = { before: glossaryBefore, after: glossaryAfter, bottomBefore, bottomEdge, topBefore, topEdge, externalBefore: glossaryExternalBefore, external: glossaryExternal, api: glossaryState, edgeApi, externalApi: glossaryExternalApi,
    layoutBoundary: 'uses production renderer CSS captured from the current build; fixture CSS only lays out the test host and external scroll container; exercises the actual static TermPopover in Chromium and does not claim installed-app coverage' }

  const beforeDialogMount = await evaluate('window.nativeTest.state()')
  if (beforeDialogMount.explains.length !== 0 || beforeDialogMount.cancels.length !== 0 || beforeDialogMount.subscriptions !== 0 || beforeDialogMount.unsubscriptions !== 0) throw new Error(`static glossary changed AI lifecycle before dialog mounting: ${JSON.stringify(beforeDialogMount)}`)
  await evaluate(`window.dispatchEvent(new CustomEvent('native-test-scenario', { detail: 'stream', bubbles: true }))`)
  await waitFor(async () => (await evaluate('window.nativeTest.state()')).explains.length === 1, 'explicit selection ask mounts stream dialog')
  const streamStateAtMount = await evaluate('window.nativeTest.state()')
  const streamSnapshot = await snapshot()
  if (streamSnapshot.selectionText !== 'SYNTHETIC_SELECTED_TEXT') throw new Error(`dialog did not show the synthetic selected text: ${JSON.stringify(streamSnapshot.selectionText)}`)
  if (streamStateAtMount.subscriptions !== 1 || streamStateAtMount.pending.length !== 1) throw new Error(`dialog did not start exactly one explain lifecycle: ${JSON.stringify(streamStateAtMount)}`)
  const streamBeforeDelta = await snapshot()
  const longDelta = Array.from({length:90},(_,i)=>`Stream paragraph ${i}: native auto-scroll must keep this explanation open.\n\n`).join('')
  await evaluate(`window.nativeTest.pushDelta(${JSON.stringify(longDelta)})`)
  await waitFor(async () => {const s=await snapshot();return s.content?.top>streamBeforeDelta.content?.top && s.scrolls.length>streamBeforeDelta.scrolls.length}, 'streaming content auto-scroll event')
  const streamState = await evaluate('window.nativeTest.state()')
  const afterAutoScroll = await snapshot()
  if (JSON.stringify(afterAutoScroll.typography) !== JSON.stringify(glossaryBefore.typography)) throw new Error('definition and streamed explanation use different typography')
  fs.writeFileSync(path.join(outputDir, 'detail-preview.png'), (await win.webContents.capturePage()).toPNG())
  if (!afterAutoScroll.popup || streamState.cancels.length !== 0 || streamState.pending.length !== 1) throw new Error('streaming auto-scroll closed the dialog or cancelled explain')
  await wheelAt('.overflow-y-auto', -240)
  await waitFor(async () => {const s=await snapshot();return s.content?.top<afterAutoScroll.content?.top && s.wheels.length>afterAutoScroll.wheels.length && s.wheels.at(-1)?.trusted}, 'trusted upward stream wheel')
  const afterStreamWheel = await snapshot()
  const afterInternalWheelApi = await evaluate('window.nativeTest.state()')
  if (!afterStreamWheel.popup || afterInternalWheelApi.cancels.length !== 0 || afterInternalWheelApi.pending.length !== 1) throw new Error('streaming internal wheel closed the dialog or cancelled explain')
  evidence.scenarios.streaming = { beforeDelta: streamBeforeDelta, afterAutoScroll, afterInternalWheel: afterStreamWheel, api: afterInternalWheelApi,
    lifecycleBoundary: 'resetScenario(stream) simulates the report mounting the dialog after an explicit user Ask action; no requirement is asserted for external scroll closing the modal' }

  await evaluate(`document.querySelector('[aria-label="AI 解释"] button[aria-label="关闭 AI 解释"]').click()`)
  await waitFor(async () => { const s = await evaluate('window.nativeTest.state()'); return s.cancels.length === 1 && s.unsubscriptions === 1 && s.pending.length === 0 }, 'explicit dialog close cancels/unsubscribes')
  const dialogClose = await evaluate('window.nativeTest.state()')
  if (dialogClose.cancels[0] !== dialogClose.explains[0] || dialogClose.cancels.length !== 1 || dialogClose.unsubscriptions !== 1) throw new Error(`dialog close did not cancel its UUID exactly once: ${JSON.stringify(dialogClose)}`)
  evidence.scenarios.streaming.close = dialogClose
  evidence.scenarios.external = { boundary: 'external wheel behavior is not asserted to close the AI dialog' }
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outputDir, 'screenshot.png'), image.toPNG())
  evidence.verdict = 'NATIVE-OK'
}

const userDataPath = path.join(outputDir, 'electron-user-data')
fs.mkdirSync(userDataPath, { recursive: true })
app.setPath('userData', userDataPath)
app.setPath('sessionData', path.join(userDataPath, 'session'))

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file://') })
  })
  try { await run() }
  catch (error) { evidence.error = error?.stack || String(error) }
  finally {
    try { if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy() } } catch {}
    try { fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`) }
    catch (error) { console.error(`NATIVE-FAIL could not write evidence: ${error}`); app.exit(2); return }
    console.log(`VERDICT ${evidence.verdict}`)
    console.log(`EVIDENCE ${path.join(outputDir, 'evidence.json')}`)
    app.exit(evidence.verdict === 'NATIVE-OK' ? 0 : 1)
  }
})
