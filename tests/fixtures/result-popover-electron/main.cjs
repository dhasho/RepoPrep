const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const fixtureDir = __dirname
const outputDir = process.argv[process.argv.length - 1]
const evidence = {
  verdict: 'NATIVE-FAIL',
  source: 'actual bundled src/App.tsx and production renderer CSS in isolated sandboxed Electron Chromium; all app interactions use CDP keyboard input',
  scenarios: {},
  userData: 'isolated per run',
  provider: 'mock only; no credentials or user data',
  rendererConsole: [],
  rendererFailures: []
}
try { evidence.sourceMetadata = JSON.parse(fs.readFileSync(process.env.PROJECTLENS_NATIVE_METADATA, 'utf8')) }
catch (error) { evidence.metadataError = String(error) }

let win
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function within(promise, label, ms = 8000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label}`)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function evaluate(expression) { return within(win.webContents.executeJavaScript(expression), 'renderer evaluation') }
async function waitFor(check, label, ms = 8000) {
  evidence.currentStep = `waiting for ${label}`
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = await check()
    if (found) return found
    await delay(40)
  }
  throw new Error(`deadline exceeded waiting for ${label}`)
}
async function enterButton(text, occurrence = 0) {
  evidence.currentStep = `keyboard button ${text}`
  const focused = await evaluate(`(() => {
    const candidates = [...document.querySelectorAll('button')].filter((item) => (item.getAttribute('aria-label') || item.innerText || item.textContent || '').trim().includes(${JSON.stringify(text)}));
    const target = candidates[${occurrence}];
    if (!target) return null;
    target.focus(); return {text:(target.getAttribute('aria-label')||target.innerText||target.textContent||'').trim(),tag:target.tagName,active:document.activeElement===target};
  })()`)
  if (!focused?.active) throw new Error(`button not focusable/found for keyboard activation: ${text}`)
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  evidence.keyboardSteps.push({ target: focused.text, activeBeforeKey: focused.active, input: 'CDP Input.dispatchKeyEvent Enter' })
  return focused
}
async function tabToButton(fromText, targetText) {
  evidence.currentStep = `native Tab ${fromText} -> ${targetText}`
  const focused = await evaluate(`(() => {const start=[...document.querySelectorAll('button')].find((item)=>(item.getAttribute('aria-label')||item.innerText||item.textContent||'').trim().includes(${JSON.stringify(fromText)}));if(!start)return null;start.focus();return document.activeElement===start})()`)
  if (!focused) throw new Error(`Tab start button missing: ${fromText}`)
  let activeText = ''
  let tabCount = 0
  while (tabCount < 40 && !activeText.includes(targetText)) {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    activeText = await evaluate(`(document.activeElement?.getAttribute('aria-label')||document.activeElement?.innerText||document.activeElement?.textContent||'').trim()`)
    tabCount++
  }
  if (!activeText.includes(targetText)) throw new Error(`native Tab moved to unexpected target: ${activeText}; expected ${targetText}`)
  evidence.keyboardSteps.push({ target: activeText, from: fromText, input: 'CDP Input.dispatchKeyEvent Tab', tabCount, activeAfterTab: true })
}
async function enterFocusedButton(text) {
  evidence.currentStep = `keyboard focused button ${text}`
  const activeText = await evaluate(`(document.activeElement?.innerText||document.activeElement?.textContent||'').trim()`)
  if (!activeText.includes(text)) throw new Error(`expected ${text} focused before Enter; found ${activeText}`)
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  evidence.keyboardSteps.push({ target: activeText, activeBeforeKey: true, input: 'CDP Input.dispatchKeyEvent Enter' })
}
async function enterTerm(term) {
  evidence.currentStep = `native Enter question title term ${term}`
  const clicksBefore = await evaluate('window.__issue93Events.clicks.length')
  const focused = await evaluate(`(() => {const target=[...document.querySelectorAll('.term-link')].find((item)=>(item.textContent||'').trim()===${JSON.stringify(term)});if(!target)return null;target.focus();return {text:target.textContent.trim(),active:document.activeElement===target}})()`)
  if (!focused?.active) throw new Error(`term keyboard target missing: ${term}`)
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  const targetEvidence = await evaluate(`(() => {
    const target = [...document.querySelectorAll('.term-link')].find((item) => (item.textContent || '').trim() === ${JSON.stringify(term)});
    const parentButton = target?.closest('button');
    const questionTitleText = (parentButton?.innerText || '').trim();
    return {
      term: target?.textContent.trim(),
      active: document.activeElement === target,
      inQuestionHeader: questionTitleText.includes(${JSON.stringify(`QUESTION_${term.slice(-1)}`)}),
      questionTitleText,
      parentQuestionButtonText: questionTitleText,
      clickCount: window.__issue93Events.clicks.length,
      keyEvents: window.__issue93Events.keys.slice(-1),
      keyPresses: window.__issue93Events.keyPresses.slice(-1),
      keyUps: window.__issue93Events.keyUps.slice(-1),
      clicksSinceStart: window.__issue93Events.clicks.slice(${clicksBefore}),
      popoverVisible: !!document.querySelector('.z-50')
    };
  })()`)
  const parentDefaultClicks = targetEvidence.clicksSinceStart.filter((event) => event.trusted && event.activationTarget?.tag === 'BUTTON' && event.activationTarget.text === targetEvidence.parentQuestionButtonText)
  if (!targetEvidence.inQuestionHeader || !targetEvidence.keyEvents[0]?.trusted || parentDefaultClicks.length !== 0) {
    throw new Error(`question-title Enter activated an unexpected parent button or missed the real term target: ${JSON.stringify(targetEvidence)}`)
  }
  targetEvidence.clickStartIndex = clicksBefore
  targetEvidence.questionCardDefaultClicks = parentDefaultClicks
  evidence.keyboardSteps.push({ target: `question title term ${term}`, activeBeforeKey: focused.active, input: 'CDP Input.dispatchKeyEvent Enter', termActivation: targetEvidence, questionCardDefaultClicks: parentDefaultClicks })
  return targetEvidence
}
function recorder() {
  return `(() => {
    const describe = node => ({tag:node?.tagName||node?.nodeName||'',id:node?.id||'',className:typeof node?.className==='string'?node.className:'',text:(node?.getAttribute?.('aria-label')||node?.innerText||node?.textContent||'').toString().trim().slice(0,120),scrollTop:typeof node?.scrollTop==='number'?node.scrollTop:null,scrollHeight:typeof node?.scrollHeight==='number'?node.scrollHeight:null,clientHeight:typeof node?.clientHeight==='number'?node.clientHeight:null});
    const scroll = target => ({target:describe(target),active:describe(document.activeElement),windowX:scrollX,windowY:scrollY,documentX:document.documentElement.scrollLeft,documentY:document.documentElement.scrollTop,bodyY:document.body.scrollTop});
    window.__issue93Events={keys:[],keyPresses:[],keyUps:[],clicks:[],mouseDowns:[],wheels:[],scrolls:[],errors:[],rejections:[]};
    addEventListener('keydown',e=>window.__issue93Events.keys.push({key:e.key,code:e.code,trusted:e.isTrusted,target:describe(e.target),active:describe(document.activeElement),scroll:scroll(e.target)}),true);
    addEventListener('keypress',e=>window.__issue93Events.keyPresses.push({key:e.key,code:e.code,trusted:e.isTrusted,target:describe(e.target),active:describe(document.activeElement),scroll:scroll(e.target)}),true);
    addEventListener('keyup',e=>window.__issue93Events.keyUps.push({key:e.key,code:e.code,trusted:e.isTrusted,target:describe(e.target),active:describe(document.activeElement),scroll:scroll(e.target)}),true);
    addEventListener('click',e=>window.__issue93Events.clicks.push({trusted:e.isTrusted,detail:e.detail,target:describe(e.target),activationTarget:describe(e.target?.closest?.('button,[role=button]')),active:describe(document.activeElement),scroll:scroll(e.target)}),true);
    addEventListener('mousedown',e=>window.__issue93Events.mouseDowns.push({trusted:e.isTrusted,target:describe(e.target),active:describe(document.activeElement),scroll:scroll(e.target)}),true);
    addEventListener('wheel',e=>window.__issue93Events.wheels.push({trusted:e.isTrusted,deltaX:e.deltaX,deltaY:e.deltaY,target:describe(e.target),active:describe(document.activeElement),scroll:scroll(e.target)}),true);
    addEventListener('scroll',e=>window.__issue93Events.scrolls.push({trusted:e.isTrusted,target:describe(e.target),active:describe(document.activeElement),state:scroll(e.target)}),true);
    addEventListener('error',e=>window.__issue93Events.errors.push({message:e.message,filename:e.filename,line:e.lineno,col:e.colno,target:describe(e.target),scroll:scroll(e.target)}),true);
    addEventListener('unhandledrejection',e=>window.__issue93Events.rejections.push({reason:String(e.reason),active:describe(document.activeElement),scroll:scroll(document.activeElement)}),true);
  })()`
}
async function snapshot() {
  return evaluate(`(() => {const describe=node=>({tag:node?.tagName||node?.nodeName||'',id:node?.id||'',className:typeof node?.className==='string'?node.className:'',text:(node?.innerText||node?.textContent||'').toString().trim().slice(0,180),scrollTop:typeof node?.scrollTop==='number'?node.scrollTop:null,scrollHeight:typeof node?.scrollHeight==='number'?node.scrollHeight:null,clientHeight:typeof node?.clientHeight==='number'?node.clientHeight:null});return {title:document.body.innerText.slice(0,6000),bodyHtml:document.body.innerHTML.slice(0,24000),popover:[...document.querySelectorAll('.z-50')].map(e=>({text:e.innerText,html:e.outerHTML.slice(0,9000)})),termElements:[...document.querySelectorAll('.term-link')].map(e=>({text:e.textContent.trim(),active:document.activeElement===e,detail:describe(e)})),activeElement:describe(document.activeElement),scroll:{windowX:scrollX,windowY:scrollY,documentX:document.documentElement.scrollLeft,documentY:document.documentElement.scrollTop,bodyY:document.body.scrollTop,bodyHeight:document.body.scrollHeight,viewportHeight:innerHeight},events:window.__issue93Events,api:window.nativeControl.state()}})()`)
}
async function run() {
  if (!evidence.sourceMetadata?.appSha256 || !evidence.sourceMetadata?.markdownViewSha256 || !evidence.sourceMetadata?.productionCssSha256) throw new Error(`missing source provenance: ${evidence.metadataError || 'incomplete metadata'}`)
  evidence.keyboardSteps = []
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  win = new BrowserWindow({ show: false, width: 1280, height: 900, paintWhenInitiallyHidden: true, webPreferences: {
    preload: path.join(fixtureDir, 'preload.cjs'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, webSecurity: true, backgroundThrottling: false
  } })
  win.webContents.on('console-message', (_event, ...details) => {
    const first = details[0]
    if (first && typeof first === 'object') evidence.rendererConsole.push({ level: first.level, message: first.message, line: first.lineNumber, sourceId: first.sourceId })
    else evidence.rendererConsole.push({ level: first, message: details[1], line: details[2], sourceId: details[3] })
  })
  win.webContents.on('render-process-gone', (_event, details) => evidence.rendererFailures.push({ type: 'render-process-gone', ...details }))
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => evidence.rendererFailures.push({ type: 'did-fail-load', code, description, url, isMainFrame }))
  win.webContents.debugger.attach('1.3')
  await within(win.loadFile(path.join(fixtureDir, 'index.html')), 'fixture load')
  await evaluate(recorder())
  await waitFor(() => evaluate(`document.body.innerText.includes('新建') && document.body.innerText.includes('ProjectA') && !!window.nativeControl`), 'initial App render')
  await enterButton('新建')
  await waitFor(() => evaluate(`document.body.innerText.includes('ProjectB') && document.body.innerText.includes('开始生成面试题')`), 'B configuration')
  await tabToButton('设置', '开始生成面试题')
  await enterFocusedButton('开始生成面试题')
  await waitFor(() => evaluate(`window.nativeControl.state().generationRequests.length===1`), 'B generation request')
  const generatedB = await evaluate('window.nativeControl.state().generationRequests[0]')
  if (generatedB.projectPath !== 'C:\\Fixture\\ProjectB' || generatedB.profileId !== 'profile-B') throw new Error(`B generation used unexpected project/profile: ${JSON.stringify(generatedB)}`)
  await enterButton('上一步')
  await waitFor(() => evaluate(`document.body.innerText.includes('仍在生成')`), 'leave generation choice')
  await enterButton('后台继续')
  await waitFor(() => evaluate(`document.body.innerText.includes('开始生成面试题')`), 'configuration after background continuation')
  await evaluate('window.nativeControl.completeB()')
  await waitFor(() => evaluate(`window.nativeControl.state().pendingB===false`), 'background B completion')
  await enterButton('展开 ProjectA 的分析')
  await waitFor(() => evaluate(`!!document.querySelector('button[data-analysis-id="analysis-A"]')`), 'saved A analysis')
  const analysisLabel = await evaluate(`document.querySelector('button[data-analysis-id="analysis-A"]').innerText.trim()`)
  await enterButton(analysisLabel)
  await waitFor(() => evaluate(`document.body.innerText.includes('ProjectA · 面试题')`), 'history A result')

  const termAActivation = await enterTerm('TERM_A')
  await waitFor(() => evaluate(`!!document.querySelector('.z-50')`), 'A term popover')
  const afterAEnter = await snapshot()
  termAActivation.popoverOpened = afterAEnter.popover.some((item) => item.text.includes('TERM_A'))
  termAActivation.clicksAfterActivation = afterAEnter.events.clicks.slice(termAActivation.clickStartIndex)
  termAActivation.questionCardDefaultClicks = termAActivation.clicksAfterActivation.filter((event) => event.trusted && event.activationTarget?.tag === 'BUTTON' && event.activationTarget.text === termAActivation.parentQuestionButtonText)
  if (!termAActivation.popoverOpened || termAActivation.questionCardDefaultClicks.length !== 0) throw new Error(`A question-title Enter did not open its popover cleanly: ${JSON.stringify(termAActivation)}`)
  await waitFor(() => evaluate(`window.nativeControl.state().explainRequests.length===1`), 'A explain request')
  const requestA = (await evaluate('window.nativeControl.state().explainRequests[0]'))
  if (requestA.term !== 'TERM_A' || requestA.profileId !== 'profile-A' || requestA.projectSummary !== 'SUMMARY_A' || requestA.question !== 'QUESTION_A TERM_A' || requestA.snippet !== 'ANSWER_A TERM_A context' || requestA.glossaryHint !== 'GLOSSARY_A') {
    throw new Error(`A explain request context mismatch: ${JSON.stringify(requestA)}`)
  }
  const beforeSwitch = await snapshot()
  await enterButton('后台生成')
  await waitFor(() => evaluate(`document.body.innerText.includes('ProjectB') && document.body.innerText.includes('查看结果')`), 'background task panel')
  await enterButton('查看结果')
  await waitFor(() => evaluate(`document.body.innerText.includes('ProjectB · 面试题')`), 'B viewed result')
  const afterSwitch = await snapshot()
  if (afterSwitch.popover.length !== 0) throw new Error(`A popover remained after keyboard navigation to B: ${JSON.stringify(afterSwitch.popover)}`)
  if (afterSwitch.api.explainCancels.length !== 1 || afterSwitch.api.explainCancels[0] !== requestA.requestId) throw new Error(`A explain was not cancelled exactly once by UUID: ${JSON.stringify(afterSwitch.api.explainCancels)}`)

  const termBActivation = await enterTerm('TERM_B')
  await waitFor(() => evaluate(`!!document.querySelector('.z-50')`), 'B term popover')
  const afterBEnter = await snapshot()
  termBActivation.popoverOpened = afterBEnter.popover.some((item) => item.text.includes('TERM_B'))
  termBActivation.clicksAfterActivation = afterBEnter.events.clicks.slice(termBActivation.clickStartIndex)
  termBActivation.questionCardDefaultClicks = termBActivation.clicksAfterActivation.filter((event) => event.trusted && event.activationTarget?.tag === 'BUTTON' && event.activationTarget.text === termBActivation.parentQuestionButtonText)
  if (!termBActivation.popoverOpened || termBActivation.questionCardDefaultClicks.length !== 0) throw new Error(`B question-title Enter did not open its popover cleanly: ${JSON.stringify(termBActivation)}`)
  await waitFor(() => evaluate(`window.nativeControl.state().explainRequests.length===2`), 'B explain request')
  const requestB = await evaluate('window.nativeControl.state().explainRequests[1]')
  if (requestB.term !== 'TERM_B' || requestB.profileId !== 'profile-B' || requestB.projectSummary !== 'SUMMARY_B' || requestB.question !== 'QUESTION_B TERM_B' || requestB.snippet !== 'ANSWER_B TERM_B context' || requestB.glossaryHint !== 'GLOSSARY_B') {
    throw new Error(`B explain request mixed result contexts: ${JSON.stringify(requestB)}`)
  }
  await evaluate(`window.nativeControl.lateAEvents(${JSON.stringify(requestA.requestId)})`)
  await delay(150)
  const afterLate = await snapshot()
  const visibleBPopover = afterLate.popover[0]?.text || ''
  if (!visibleBPopover.includes('TERM_B') || !visibleBPopover.includes('生成中') || visibleBPopover.includes('LATE_A_')) throw new Error(`late A events changed B popover/stream state: ${JSON.stringify(afterLate.popover)}`)
  const lateEvents = afterLate.api.lateEventEvidence
  if (lateEvents.length !== 3 || lateEvents.some((event) => event.requestId !== requestA.requestId || event.activeListenerCount < 1) || lateEvents.map((event) => event.type).join(',') !== 'delta,done,error') {
    throw new Error(`valid late A IPC events were not broadcast to B's current subscription: ${JSON.stringify(lateEvents)}`)
  }
  const trustedEnterKeys = afterLate.events.keys.filter((event) => event.key === 'Enter' && event.trusted)
  const trustedTabKeys = afterLate.events.keys.filter((event) => event.key === 'Tab' && event.trusted)
  const keyboardClicks = afterLate.events.clicks.filter((event) => event.trusted && event.detail === 0)
  if (trustedEnterKeys.length < 8 || trustedTabKeys.length < 1 || keyboardClicks.length < 7) throw new Error(`insufficient trusted native keyboard/default activation evidence: Enter=${trustedEnterKeys.length}, Tab=${trustedTabKeys.length}, clicks=${keyboardClicks.length}`)
  if (keyboardClicks.some((event) => event.activationTarget?.tag !== 'BUTTON') || keyboardClicks.some((event) => /QUESTION_[AB]/.test(event.activationTarget?.text || ''))) {
    throw new Error(`keyboard-generated clicks included a non-button or question-card parent activation: ${JSON.stringify(keyboardClicks)}`)
  }
  const allowedNativeTargets = [/新建/, /开始生成面试题/, /上一步/, /后台继续/, /展开 ProjectA 的分析/, /^2026/, /查看结果/, /后台生成/]
  if (keyboardClicks.some((event) => !allowedNativeTargets.some((pattern) => pattern.test(event.activationTarget?.text || '')))) {
    throw new Error(`unexpected keyboard default button activation: ${JSON.stringify(keyboardClicks)}`)
  }
  if (afterLate.events.mouseDowns.length !== 0) throw new Error(`native sequence unexpectedly used mouseDown: ${JSON.stringify(afterLate.events.mouseDowns)}`)
  evidence.scenarios = {
    backgroundBThenHistoryA: { generationRequest: generatedB, historyTitle: beforeSwitch.title.includes('ProjectA · 面试题') },
    keyboardOpenedA: { request: requestA, popover: beforeSwitch.popover, termActivation: termAActivation, evidence: beforeSwitch.events },
    keyboardViewedB: { popover: afterSwitch.popover, explainCancels: afterSwitch.api.explainCancels, events: afterSwitch.events },
    freshBExplain: { request: requestB, popover: afterLate.popover, termActivation: termBActivation },
    lateAEvents: { emittedRequestId: requestA.requestId, deliveredToCurrentListeners: lateEvents, after: afterLate.popover },
    keyboardEvidence: { trustedEnterKeys, trustedTabKeys, keyboardClicks, nativeButtonClickTargets: keyboardClicks.map((event) => event.activationTarget.text), mouseDowns: afterLate.events.mouseDowns }
  }
  evidence.verdict = 'NATIVE-OK'
}

const userDataPath = path.join(outputDir, 'electron-user-data')
fs.mkdirSync(userDataPath, { recursive: true })
app.setPath('userData', userDataPath)
app.setPath('sessionData', path.join(userDataPath, 'session'))
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://') }))
  try { await run() } catch (error) {
    evidence.error = error?.stack || String(error)
    evidence.failureDiagnostics = { step: evidence.currentStep || 'unknown', capturedAt: new Date().toISOString() }
    try { evidence.failureDiagnostics.lastSnapshot = await within(snapshot(), 'failure snapshot', 2500) }
    catch (snapshotError) { evidence.failureDiagnostics.snapshotError = snapshotError?.stack || String(snapshotError) }
    try {
      const image = await within(win.webContents.capturePage(), 'failure screenshot', 3500)
      const screenshotPath = path.join(outputDir, 'failure-screenshot.png')
      fs.writeFileSync(screenshotPath, image.toPNG())
      evidence.failureDiagnostics.screenshot = screenshotPath
    } catch (screenshotError) { evidence.failureDiagnostics.screenshotError = screenshotError?.stack || String(screenshotError) }
  }
  finally {
    try { if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy() } } catch {}
    try { fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`) }
    catch (error) { console.error(`NATIVE-FAIL could not write evidence: ${error}`); app.exit(2); return }
    console.log(`VERDICT ${evidence.verdict}`)
    console.log(`EVIDENCE ${path.join(outputDir, 'evidence.json')}`)
    app.exit(evidence.verdict === 'NATIVE-OK' ? 0 : 1)
  }
})
