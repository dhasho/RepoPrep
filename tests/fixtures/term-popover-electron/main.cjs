const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const fixtureDir = __dirname
const outputDir = process.argv[process.argv.length - 1]
const evidence = { verdict: 'NATIVE-FAIL', source: 'actual TermPopover bundle in hidden sandboxed Electron Chromium', scenarios: {} }
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
  return evaluate(`({ ...window.__wheelEvidence, popup:!!document.querySelector('.z-50'), typography:(()=>{const e=document.querySelector('.md-body');if(!e)return null;const s=getComputedStyle(e);return {fontSize:s.fontSize,lineHeight:s.lineHeight,fontFamily:s.fontFamily}})(), content:(()=>{const e=document.querySelector('.overflow-y-auto');return e?{top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,max:e.scrollHeight-e.clientHeight,className:e.className,overscrollBehaviorY:getComputedStyle(e).overscrollBehaviorY}:null})(), pageScroll:scrollY, outsideTop:document.querySelector('#outside-scroll').scrollTop })`)
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
  await waitFor(() => evaluate(`document.querySelector('#fixture-ready')?.textContent === 'ready' && !!document.querySelector('.overflow-y-auto')`), 'initial component mount')

  await waitFor(async () => (await evaluate('window.nativeTest.state()')).explains.length === 1, 'glossary explain start')
  const glossaryBefore = await snapshot()
  if (glossaryBefore.typography?.fontSize !== '15px') throw new Error(`definition has inconsistent typography: ${JSON.stringify(glossaryBefore.typography)}`)
  await observedWheel('.overflow-y-auto', 520, glossaryBefore.wheels.length, 'trusted glossary wheel scroll')
  await waitFor(async () => (await snapshot()).content?.top>0, 'glossary scroll position change')
  const glossaryState = await evaluate('window.nativeTest.state()')
  const glossaryAfter = await snapshot()
  fs.writeFileSync(path.join(outputDir, 'definition-preview.png'), (await win.webContents.capturePage()).toPNG())
  if (!glossaryAfter.popup || glossaryState.cancels.length !== 0 || glossaryState.pending.length !== 1 ||
      glossaryState.subscriptions !== 1 || glossaryState.unsubscriptions !== 0) throw new Error('glossary internal wheel closed the popover or changed its pending explain lifecycle')
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
      edgeApi.cancels.length !== 0 || edgeApi.pending.length !== 1) {
    throw new Error(`upward edge wheel chained outside or closed/cancelled: ${JSON.stringify(topEdge)}`)
  }
  evidence.scenarios.glossary = { before: glossaryBefore, after: glossaryAfter, bottomBefore, bottomEdge, topBefore, topEdge, api: glossaryState, edgeApi,
    layoutBoundary: 'uses production renderer CSS captured from the current build; fixture CSS only lays out the test host and external scroll container; exercises the actual TermPopover component in Chromium and does not claim installed-app coverage' }

  await evaluate(`window.nativeTest.resetScenario('stream')`)
  await waitFor(async () => (await evaluate('window.nativeTest.state()')).explains.length === 1, 'stream explain start')
  const streamBeforeDelta = await snapshot()
  const longDelta = Array.from({length:90},(_,i)=>`Stream paragraph ${i}: native auto-scroll must keep this explanation open.\n\n`).join('')
  await evaluate(`window.nativeTest.pushDelta(${JSON.stringify(longDelta)})`)
  await waitFor(async () => {const s=await snapshot();return s.content?.top>streamBeforeDelta.content?.top && s.scrolls.length>streamBeforeDelta.scrolls.length}, 'streaming content auto-scroll event')
  const streamState = await evaluate('window.nativeTest.state()')
  const afterAutoScroll = await snapshot()
  if (JSON.stringify(afterAutoScroll.typography) !== JSON.stringify(glossaryBefore.typography)) throw new Error('definition and streamed explanation use different typography')
  fs.writeFileSync(path.join(outputDir, 'detail-preview.png'), (await win.webContents.capturePage()).toPNG())
  if (!afterAutoScroll.popup || streamState.cancels.length !== 0 || streamState.pending.length !== 1) throw new Error('streaming auto-scroll closed the popover or cancelled explain')
  await wheelAt('.overflow-y-auto', -240)
  await waitFor(async () => {const s=await snapshot();return s.content?.top<afterAutoScroll.content?.top && s.wheels.length>afterAutoScroll.wheels.length && s.wheels.at(-1)?.trusted}, 'trusted upward stream wheel')
  const afterStreamWheel = await snapshot()
  const afterInternalWheelApi = await evaluate('window.nativeTest.state()')
  if (!afterStreamWheel.popup || afterInternalWheelApi.cancels.length !== 0 || afterInternalWheelApi.pending.length !== 1) throw new Error('streaming internal wheel closed the popover or cancelled explain')
  evidence.scenarios.streaming = { beforeDelta: streamBeforeDelta, afterAutoScroll, afterInternalWheel: afterStreamWheel, api: afterInternalWheelApi }

  await waitFor(async () => {const s=await snapshot(); return s.popup && s.content?.height>s.content?.client}, 'external wheel fixture ready')
  const externalBefore = await snapshot()
  await wheelAt('#outside-scroll', 540)
  await waitFor(async () => {const s=await snapshot();const a=await evaluate('window.nativeTest.state()');return !s.popup && s.outsideTop>0 && s.wheels.length>externalBefore.wheels.length && s.wheels.at(-1)?.trusted && a.cancels.length===1}, 'external native wheel close and cancellation')
  const external = await snapshot()
  const externalApi = await evaluate('window.nativeTest.state()')
  const transition = externalApi.transitions[0]?.beforeReset
  if (!transition || transition.cancels.length !== 1 || transition.cancels[0] !== transition.explains[0] || transition.unsubscriptions !== 1) throw new Error('glossary-to-stream unmount cleanup evidence failed')
  if (!evidence.scenarios.streaming.afterInternalWheel.wheels.some(e => e.trusted) || !external.wheels.some(e => e.trusted) ||
      externalApi.cancels.length !== 1 || externalApi.cancels[0] !== externalApi.explains[0] || externalApi.unsubscriptions !== 1 || externalApi.pending.length !== 0) throw new Error('external wheel evidence or exactly-once matching cancellation failed')
  evidence.scenarios.glossary.transitionCleanup = transition
  evidence.scenarios.external = { before: externalBefore, after: external, api: externalApi }
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
