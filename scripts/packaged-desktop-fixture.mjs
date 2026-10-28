#!/usr/bin/env node
// Local-only synthetic model endpoint for installed desktop acceptance.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'

const MARKER = '.repoprep-packaged-fixture.json'
const STATE_FILE = 'fixture-state.json'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 200
const HOLD_TIMEOUT_MS = 5 * 60 * 1000
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function argumentsOf(argv) {
  let root
  let port = 0
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i]
    else if (argv[i] === '--port') port = Number(argv[++i])
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!root || !path.isAbsolute(root)) throw new Error('--root must be an absolute path')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  return { root: path.resolve(root), port }
}

async function exists(target) {
  try { await fs.access(target); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function initializeRoot(root) {
  const rootExisted = await exists(root)
  if (!rootExisted) await fs.mkdir(root, { recursive: true })
  const entries = await fs.readdir(root)
  const markerPath = path.join(root, MARKER)
  if (entries.length && !entries.includes(MARKER)) {
    throw new Error('root is non-empty and has no fixture marker; refusing to touch existing content')
  }
  const marker = { tool: 'RepoPrep packaged desktop fixture', version: 1 }
  if (entries.includes(MARKER)) {
    let current
    try { current = JSON.parse(await fs.readFile(markerPath, 'utf8')) } catch { throw new Error('fixture marker is invalid; refusing to modify root') }
    if (current?.tool !== marker.tool || current?.version !== marker.version) throw new Error('fixture marker is not recognized; refusing to modify root')
  } else {
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' })
  }

  const projectA = path.join(root, 'packaged-project-a')
  const projectB = path.join(root, 'packaged-project-b')
  for (const [project, id, description] of [
    [projectA, 'A', 'A small TypeScript library that formats a greeting.'],
    [projectB, 'B', 'A small TypeScript library that validates a parcel tracking code.']
  ]) {
    const projectMarker = path.join(project, '.packaged-fixture-project')
    if (await exists(project)) {
      let owned = false
      try { owned = (await fs.readFile(projectMarker, 'utf8')).trim() === `PACKAGED_FIXTURE_PROJECT_${id}` } catch { /* reject below */ }
      if (!owned) throw new Error(`${path.basename(project)} already exists without its ownership marker; refusing to overwrite it`)
    } else {
      await fs.mkdir(path.join(project, 'src'), { recursive: true })
      await fs.writeFile(projectMarker, `PACKAGED_FIXTURE_PROJECT_${id}\n`, { flag: 'wx' })
      await fs.writeFile(path.join(project, 'package.json'), `${JSON.stringify({ name: `packaged-project-${id.toLowerCase()}`, private: true, type: 'module' }, null, 2)}\n`, { flag: 'wx' })
      await fs.writeFile(path.join(project, 'README.md'), `# Packaged fixture project ${id}\n\n${description}\n\nThis is synthetic local acceptance data created by RepoPrep's packaged desktop fixture tool. It does not represent a real user project.\n\nFixture marker: PACKAGED_FIXTURE_PROJECT_${id}\n`, { flag: 'wx' })
      const source = id === 'A'
        ? `export function formatGreeting(name: string): string {\n  return name.trim() ? \`Hello, \${name.trim()}!\` : 'Hello!';\n}\n`
        : `export function isTrackingCode(value: string): boolean {\n  return /^PKG-[A-Z0-9]{6}$/.test(value);\n}\n`
      await fs.writeFile(path.join(project, 'src', 'index.ts'), source, { flag: 'wx' })
    }
  }
  const stateFile = path.join(root, STATE_FILE)
  if (!(await exists(stateFile))) await fs.writeFile(stateFile, `${JSON.stringify({ version: 1, requests: [], nextMode: 'complete' }, null, 2)}\n`, { flag: 'wx' })
  return { projectA, projectB, stateFile }
}

function safeQuestions(projectId) {
  const noun = projectId === 'B' ? '追踪码校验' : '问候语格式化'
  const dimensions = [
    ['输入边界', '空输入和空白输入的处理'], ['函数契约', '返回类型与调用方约定'], ['模块职责', '导出函数的职责边界'],
    ['数据流', '输入值如何进入结果'], ['测试策略', '正常值与异常值的测试'], ['类型设计', 'TypeScript 类型的约束作用'],
    ['可读性', '实现结构对维护的影响'], ['扩展方案', '新增业务规则时的修改点'], ['错误处理', '无效输入时的行为'],
    ['兼容性', '修改返回规则时的兼容风险'], ['性能观察', '当前实现的主要成本'], ['命名约定', '函数名称表达的语义'],
    ['边界测试', '边界条件的覆盖方式'], ['替代设计', '不同实现方式的权衡'], ['调用示例', '调用方如何使用导出函数'],
    ['依赖关系', '模块对外部依赖的情况'], ['数据校验', '校验规则的表达方式'], ['结果稳定性', '相同输入的结果一致性'],
    ['代码组织', '源文件组织对发现代码的帮助'], ['需求变化', '需求变化后的维护步骤'], ['文档作用', 'README 与源码的对应关系'],
    ['安全考虑', '输入内容对实现的影响'], ['验收方法', '如何验证合成项目行为'], ['设计总结', '该函数最重要的设计取舍']
  ]
  const questions = dimensions.map(([title, focus], index) => {
    const number = String(index + 1).padStart(2, '0')
    const term = ['[[TypeScript]]', '[[模块]]', '[[Electron]]', '[[IPC]]'][index % 4]
    return {
      title: `合成${projectId} ${number} ${title}`,
      question: `针对合成项目 ${projectId} 的${noun}，请分析${focus}如何体现在代码中？这与 ${term} 边界有什么关系？`,
      answer: `这是合成验收题 ${projectId}-${number}，内容只根据本地 fixture 源码设计，不代表真实项目质量结论。\n\n- 先沿着 src/index.ts 的输入和返回值核对当前行为。\n- 再结合题目关注点说明一种可验证的测试或设计权衡；若源码没有提供证据，应明确标为建议。\n\n该合成项目标识为 PACKAGED_FIXTURE_PROJECT_${projectId}。`,
      followUps: [{ question: `如果合成${projectId}的${focus}发生变化，你会补充哪类测试？`, answer: `可以增加覆盖该变化的输入输出用例，并检查调用方契约。对合成 fixture 的说明不能推断实际用户项目行为。`, followUps: [] }]
    }
  })
  const glossary = {
    TypeScript: 'TypeScript 是在 JavaScript 上增加静态类型检查的编程语言。编译工具会根据类型声明检查代码并生成可运行的 JavaScript。',
    模块: '模块是把相关代码组织并通过明确接口提供给其他代码的单元。导出与导入关系定义了模块之间可使用的能力。',
    Electron: 'Electron 是使用 Web 技术构建桌面应用的运行时框架。它把 Chromium 渲染能力与 Node.js 主进程能力组合起来。',
    IPC: 'IPC 是不同进程之间交换消息的通信方式。通信双方通过约定的通道与数据格式传递请求和结果。'
  }
  return {
    projectSummary: `这是 RepoPrep 本地生成的合成验收项目 ${projectId}，功能是${noun}。项目仅包含 package.json、README 和一段 TypeScript 源码，供安装态桌面流程检查使用，不代表真实模型生成质量。`,
    sections: [{ title: `合成项目 ${projectId}：${noun}`, summary: '以下内容是用于安装态流程验证的合成题目，不是对真实项目或模型质量的评估。', questions }],
    glossary
  }
}

function classify(messages) {
  const joined = Array.isArray(messages) ? messages.map((m) => typeof m?.content === 'string' ? m.content : '').join('\n') : ''
  if (/请只回复\s*[:：]?\s*[“"']?ok/i.test(joined) || /连通性测试助手/.test(joined)) return { category: 'connection', joined }
  if (/划词|解释.*术语|术语.*解释|用户请求解释的内容|选中原文及相关上下文|explain|explanation/i.test(joined) && !/输出 JSON 结构|合法的 JSON|题量硬性约束/.test(joined)) return { category: 'explanation', joined }
  if (/输出 JSON 结构|只输出.*JSON|题量硬性约束|sections.*questions/i.test(joined)) return { category: 'generation', joined }
  return { category: 'chat', joined }
}

function projectIdFrom(prompt) { return prompt.includes('PACKAGED_FIXTURE_PROJECT_B') ? 'B' : 'A' }
function completionBody(content) { return { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } } }
function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function emitSse(response, content) {
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
}
function emitAnthropicText(response, content) {
  response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } })}\n\n`)
}
function emitText(response, protocol, content) {
  if (protocol === 'anthropic') emitAnthropicText(response, content)
  else emitSse(response, content)
}
function emitFinish(response) {
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

const { root, port } = argumentsOf(process.argv.slice(2))
const fixture = await initializeRoot(root)
let persistent = JSON.parse(await fs.readFile(fixture.stateFile, 'utf8'))
if (!persistent || persistent.version !== 1 || !Array.isArray(persistent.requests)) persistent = { version: 1, requests: [], nextMode: 'complete' }
if (!['complete', 'hold', 'fail'].includes(persistent.nextMode)) persistent.nextMode = 'complete'
const held = new Map()
let requestCount = 0
let closing = false
let persistChain = Promise.resolve()

function persist() {
  const snapshot = `${JSON.stringify(persistent, null, 2)}\n`
  persistChain = persistChain.then(async () => {
    const temporary = `${fixture.stateFile}.tmp-${process.pid}`
    await fs.writeFile(temporary, snapshot)
    await fs.rename(temporary, fixture.stateFile)
  })
  return persistChain
}
function recordStatus(record, status, questionCount = record.questionCount) {
  record.status = status
  if (typeof questionCount === 'number') record.questionCount = questionCount
  void persist().catch(() => {})
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/__fixture/state') {
    sendJson(response, 200, { requests: persistent.requests.map(({ index, category, protocol, status, questionCount, mode }) => ({ index, category, protocol, status, questionCount, mode })), nextMode: persistent.nextMode })
    return
  }
  if (request.method === 'POST' && url.pathname === '/__fixture/mode') {
    try {
      const body = await readJson(request)
      if (!['complete', 'hold', 'fail'].includes(body?.mode)) return sendJson(response, 400, { error: 'mode must be complete, hold, or fail' })
      persistent.nextMode = body.mode
      await persist()
      return sendJson(response, 200, { mode: persistent.nextMode })
    } catch { return sendJson(response, 400, { error: 'invalid control request' }) }
  }
  if (request.method === 'POST' && url.pathname === '/__fixture/release') {
    for (const [index, entry] of held) {
      held.delete(index)
      clearTimeout(entry.timer)
      entry.release()
    }
    return sendJson(response, 200, { released: true })
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(response, 200, { data: [{ id: 'packaged-synthetic-model', object: 'model', created: 0, owned_by: 'local-fixture' }], has_more: false })
  }
  const protocol = url.pathname === '/v1/messages' ? 'anthropic' : 'openai'
  if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/messages'].includes(url.pathname)) {
    return sendJson(response, 404, { error: { message: 'not found' } })
  }
  if (++requestCount > MAX_REQUESTS) return sendJson(response, 429, { error: { message: 'fixture request limit reached' } })
  let body
  try { body = await readJson(request) } catch (error) { return sendJson(response, error.message === 'body-too-large' ? 413 : 400, { error: { message: 'invalid request' } }) }
  const messages = protocol === 'openai' ? body?.messages : [...(body?.system ? [{ role: 'system', content: body.system }] : []), ...(Array.isArray(body?.messages) ? body.messages : [])]
  const { category, joined } = classify(messages)
  if (persistent.requests.length >= MAX_REQUESTS) return sendJson(response, 429, { error: { message: 'fixture state request limit reached' } })
  const record = { index: persistent.requests.length + 1, category, protocol, status: 'pending', questionCount: 0, mode: 'complete' }
  persistent.requests.push(record)
  await persist()
  response.on('close', () => {
    if (!response.writableEnded && record.status === 'pending') {
      const heldEntry = held.get(record.index)
      if (heldEntry) {
        clearTimeout(heldEntry.timer)
        held.delete(record.index)
        heldEntry.release()
      }
      recordStatus(record, 'aborted')
    }
  })
  if (response.destroyed) {
    recordStatus(record, 'aborted')
    return
  }
  if (category === 'connection') {
    const content = 'OK'
    recordStatus(record, 'completed', 0)
    if (protocol === 'anthropic') return sendJson(response, 200, { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'packaged-synthetic-model', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    return sendJson(response, 200, completionBody(content))
  }
  if (category === 'explanation') {
    const content = '**这是本地合成解释。** 所选内容用于验证桌面应用的解释面板和流式显示；请结合相邻问题与项目上下文理解。该固定响应不代表已经核实用户项目中的具体实现。'
    if (body?.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
      response.flushHeaders?.()
      if (protocol === 'anthropic') {
        response.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'packaged-synthetic-model', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } })}\n\n`)
      }
      const chunks = ['**这是本地合成解释。** ', '所选内容用于验证桌面应用的解释面板和流式显示；', '请结合相邻问题与项目上下文理解。', '该固定响应不代表已经核实用户项目中的具体实现。']
      for (const chunk of chunks) {
        if (response.destroyed || closing) return
        emitText(response, protocol, chunk)
        await delay(100)
      }
      if (response.destroyed || closing) return
      if (protocol === 'anthropic') {
        response.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 32 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`)
        response.end()
      } else emitFinish(response)
      recordStatus(record, 'completed', 0)
      return
    }
    if (protocol === 'anthropic') {
      recordStatus(record, 'completed', 0)
      return sendJson(response, 200, { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'packaged-synthetic-model', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 12 } })
    }
    recordStatus(record, 'completed', 0)
    return sendJson(response, 200, completionBody(content))
  }
  if (category !== 'generation') {
    recordStatus(record, 'completed', 0)
    return sendJson(response, 200, protocol === 'openai' ? completionBody('OK') : { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'packaged-synthetic-model', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
  }
  const mode = persistent.nextMode
  persistent.nextMode = 'complete'
  record.mode = mode
  await persist()
  if (response.destroyed || closing) {
    recordStatus(record, 'aborted')
    return
  }
  if (mode === 'fail') {
    recordStatus(record, 'failed', 0)
    if (protocol === 'anthropic') return sendJson(response, 500, { type: 'error', error: { type: 'api_error', message: 'synthetic fixture failure' } })
    return sendJson(response, 500, { error: { message: 'synthetic fixture failure' } })
  }
  const projectId = projectIdFrom(joined)
  const result = safeQuestions(projectId)
  const knownQuestions = result.sections[0].questions
  const completed = knownQuestions.filter((question) => joined.includes(question.question))
  const resumeCount = Number(/本次只补充剩余\s+(\d+)\s+道/.exec(joined)?.[1] || knownQuestions.length)
  const questions = knownQuestions.filter((question) => !completed.includes(question)).slice(0, Math.max(0, Math.min(resumeCount, knownQuestions.length)))
  result.sections[0].questions = questions
  const streaming = body?.stream === true
  if (!streaming) {
    recordStatus(record, 'completed', questions.length)
    if (protocol === 'anthropic') return sendJson(response, 200, { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'packaged-synthetic-model', content: [{ type: 'text', text: JSON.stringify(result) }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 100 } })
    return sendJson(response, 200, completionBody(JSON.stringify(result)))
  }
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
  response.flushHeaders?.()
  if (protocol === 'anthropic') {
    response.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'packaged-synthetic-model', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } })}\n\n`)
  }
  const section = result.sections[0]
  const prefix = `{"projectSummary":${JSON.stringify(result.projectSummary)},"sections":[{"title":${JSON.stringify(section.title)},"summary":${JSON.stringify(section.summary)},"questions":[`
  emitText(response, protocol, prefix)
  const questionLimit = mode === 'hold' ? Math.min(3, questions.length) : questions.length
  for (let index = 0; index < questionLimit; index++) {
    if (response.destroyed || closing) return
    await delay(180)
    emitText(response, protocol, `${index === 0 ? '' : ','}${JSON.stringify(questions[index])}`)
    recordStatus(record, 'pending', index + 1)
  }
  if (mode === 'hold' && questions.length > questionLimit) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        held.delete(record.index)
        resolve()
      }, HOLD_TIMEOUT_MS)
      held.set(record.index, { timer, release: resolve })
    })
  }
  if (response.destroyed || closing) return
  for (let index = questionLimit; index < questions.length; index++) {
    await delay(180)
    emitText(response, protocol, `,${JSON.stringify(questions[index])}`)
    recordStatus(record, 'pending', index + 1)
    if (response.destroyed || closing) return
  }
  emitText(response, protocol, `]}],"glossary":${JSON.stringify(result.glossary)}}`)
  if (protocol === 'anthropic') {
    response.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`)
    response.end()
  } else emitFinish(response)
  recordStatus(record, 'completed', questions.length)
})

server.requestTimeout = 30_000
server.headersTimeout = 35_000
server.keepAliveTimeout = 5_000
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('failed to bind loopback server')
const origin = `http://127.0.0.1:${address.port}`
console.log(JSON.stringify({ ready: true, baseUrl: `${origin}/v1`, controlUrl: origin, projectA: fixture.projectA, projectB: fixture.projectB, stateFile: fixture.stateFile }))

async function shutdown() {
  if (closing) return
  closing = true
  for (const entry of held.values()) { clearTimeout(entry.timer); entry.release() }
  held.clear()
  await persist().catch(() => {})
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
