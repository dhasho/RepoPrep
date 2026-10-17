import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanProject, treeToText } from '../../electron/services/scanner.ts'
import { generateInterview } from '../../electron/services/generator.ts'
import { chatCompletion } from '../../electron/services/llm.ts'
import { GRANULARITY_QUESTION_BUDGET } from '../../shared/types.ts'
import { scoreCase, CORPUS_VERSION, SCHEMA_VERSION, flattenQuestions, fingerprintQuestion } from './scorer.mjs'
import { makeReviewTemplate } from './review.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const corpus = JSON.parse(await readFile(path.join(here, 'corpus/corpus.json'), 'utf8'))
const hash = data => createHash('sha256').update(data).digest('hex')
const hashFiles = async files => Object.fromEntries(await Promise.all(files.map(async rel => [rel, hash(await readFile(path.join(repo, rel)))])))
const serverRequests = []
let activeFixture
let responseOrdinal = 0
let externalRequestAttempts = 0

function synthesize(body, baseline = false) {
  responseOrdinal++
  const prompt = body.messages.map(message => message.content).join('\n')
  const countMatch = prompt.match(/(?:严格|再补充|补充)\s*(\d+)\s*题/)
  const requested = countMatch ? Number(countMatch[1]) : activeFixture.budget.target
  const facts = activeFixture.knownFacts.filter(fact => fact.keywords.some(keyword => prompt.toLowerCase().includes(keyword.toLowerCase())))
  const count = activeFixture.granularity === 'fine' && !baseline && !prompt.includes('这是补充请求') ? Math.min(5, requested) : requested
  const questions = Array.from({ length: count }, (_unused, index) => {
    const fact = facts[index % Math.max(facts.length, 1)]
    const subject = fact?.keywords[0] ?? 'the displayed implementation'
    const prompts = [
      `How does ${subject} shape the data flow in this project?`,
      `What trade-off follows from using ${subject} here?`,
      `Which boundary should be checked around ${subject}?`,
      `How would you explain the behavior of ${subject} from the shown code?`,
      `What change could affect ${subject}, and how would you verify it?`
    ]
    return { question: `${prompts[index % prompts.length]} (response ${responseOrdinal}, angle ${Math.floor(index / prompts.length) + 1})`, answer: `The supplied context mentions ${subject}. The answer should be limited to that visible behavior; no additional implementation detail is assumed.`, followUps: [{ question: `What detail in the supplied context supports ${subject}?`, answer: `Only the visible mention of ${subject} is used.`, followUps: [] }] }
  })
  const result = { projectSummary: 'Synthetic offline response grounded in keywords present in the submitted prompt.', sections: [{ title: 'Visible implementation', summary: 'Questions use only matched fixture facts.', questions }], glossary: {} }
  return JSON.stringify(result)
}

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  const body = JSON.parse(raw)
  const inputChars = body.messages.reduce((sum, message) => sum + message.content.length, 0)
  serverRequests.push({ inputChars, receivedAt: Date.now(), attempt: body.messages.some(message => message.role === 'assistant') ? 'repair' : 'initial', messages: body.messages, rawResponse: null, elapsedMs: null })
  const requestRecord = serverRequests.at(-1)
  const isBaseline = body.messages[0]?.content.includes('README+tree baseline') ?? false
  const shouldInjectRepairFault = activeFixture.id === 'node-routes' && !isBaseline && requestRecord.attempt === 'initial' && !activeFixture.repairFaultInjected
  let response = synthesize(body, isBaseline)
  if (shouldInjectRepairFault) {
    activeFixture.repairFaultInjected = true
    response = 'synthetic scheduled format fault: this is not JSON'
  }
  let rawJsonValid = true
  try { JSON.parse(response) } catch { rawJsonValid = false }
  requestRecord.rawResponse = response
  requestRecord.rawJsonValid = rawJsonValid
  requestRecord.elapsedMs = Date.now() - requestRecord.receivedAt
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: response } }] }))
})

await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
const endpoint = `http://127.0.0.1:${server.address().port}/v1`
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1' || url.port !== String(server.address().port)) {
    externalRequestAttempts++
    throw new Error('offline evaluator blocked a non-loopback HTTP request')
  }
  return nativeFetch(input, init)
}
const outputDir = path.resolve(process.argv[2] ?? path.join(repo, 'reports/offline-generation-eval'))
const config = { mode: 'offline-pipeline-and-scorer-calibration', responseId: 'fixture-context-keyword-v1-json-repair', temperature: 0, roleFocus: 'general', timeoutMs: 600000, baseline: 'same case budget and synthetic profile; one request containing README plus production-rendered file tree; always valid JSON', syntheticFaultSchedule: 'node-routes generation: first raw reply is malformed JSON; production repair returns valid JSON' }
const configHash = hash(JSON.stringify(config))
async function collectTypescript(root, current = root) {
  const entries = await readdir(path.join(repo, current), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = path.posix.join(current.replaceAll('\\', '/'), entry.name)
    if (entry.isDirectory()) files.push(...await collectTypescript(root, relative))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(relative)
  }
  return files
}
const productionSources = [...await collectTypescript('electron/services'), ...await collectTypescript('shared')].sort()
const evaluatorSources = ['scripts/evaluation/scorer.mjs', 'scripts/evaluation/review.mjs', 'scripts/evaluation/offline-runner.mjs', 'scripts/evaluation/scorer.test.mjs', 'scripts/evaluation/review-cli.test.mjs', 'package.json', 'package-lock.json']
const sourceHashes = await hashFiles([...productionSources, ...evaluatorSources])
const fixtureHashes = {}
for (const item of corpus.cases) {
  const directory = path.join(here, 'corpus', item.directory)
  for (const name of await readdir(directory)) fixtureHashes[`${item.directory}/${name}`] = hash(await readFile(path.join(directory, name)))
}
fixtureHashes['corpus.json'] = hash(await readFile(path.join(here, 'corpus/corpus.json')))

const cases = []
try {
  for (const caseDef of corpus.cases) {
    activeFixture = { ...caseDef, budget: GRANULARITY_QUESTION_BUDGET[caseDef.granularity], repairFaultInjected: false }
    if (JSON.stringify(activeFixture.budget) !== JSON.stringify(caseDef.budget)) throw new Error(`fixture budget disagrees with shared source: ${caseDef.id}`)
    const fixtureRoot = path.join(here, 'corpus', caseDef.directory)
    const scan = await scanProject(fixtureRoot)
    const requestStart = serverRequests.length
    const started = Date.now()
    const profile = { id: 'synthetic-offline', name: 'Offline synthetic', baseUrl: endpoint, apiKey: 'synthetic-never-log', model: config.responseId, temperature: 0 }
    const progressEvents = []
    const result = await generateInterview({ scan, granularity: caseDef.granularity, roleFocus: config.roleFocus, profile, signal: new AbortController().signal, onProgress: (step, detail) => progressEvents.push({ step, detail }) })
    const requests = serverRequests.slice(requestStart)
    const questions = flattenQuestions(result)
    const scored = scoreCase(result, activeFixture)
    if (!scored.contract.pass) throw new Error(`production result failed result contract: ${caseDef.id}`)
    if (caseDef.granularity === 'fine' && !progressEvents.some(event => event.step === '补充请求（题量不足）')) throw new Error('fine-granularity calibration did not exercise production compensation')
    const repairRequestCount = requests.filter(request => request.attempt === 'repair').length
    const rawJsonInvalidCount = requests.filter(request => !request.rawJsonValid).length
    const rawJsonValidCount = requests.filter(request => request.rawJsonValid).length
    if (caseDef.id === 'node-routes' && (rawJsonInvalidCount !== 1 || repairRequestCount < 1 || rawJsonValidCount < 1)) throw new Error('scheduled malformed-JSON response did not exercise successful production repair')
    if (caseDef.id === 'node-routes' && !requests.some(request => request.attempt === 'initial' && !request.rawJsonValid && request.rawResponse.includes('not JSON')) || caseDef.id === 'node-routes' && !requests.some(request => request.attempt === 'repair' && request.rawJsonValid)) throw new Error('Node repair trace does not contain both invalid and repaired raw JSON')
    const sanitizedResult = { ...result, projectPath: `/fixtures/${caseDef.id}`, profileId: 'synthetic-offline', modelUsed: config.responseId }
    if (requests.some(request => /sourceRefs|sourceId|\b\d+ \| /.test(request.messages.map(message => message.content).join('\n')))) throw new Error(`generation prompt contains source-evidence overhead: ${caseDef.id}`)
    if (questions.some(question => Object.hasOwn(question, 'sourceEvidence')) || Object.hasOwn(result, 'sourceEvidenceSummary')) throw new Error(`generation result contains legacy source evidence: ${caseDef.id}`)
    cases.push({ id: caseDef.id, granularity: caseDef.granularity, budget: caseDef.budget, elapsedMs: Date.now() - started, requestCount: requests.length, failedRequests: 0, repairRequestCount, rawJson: { validResponses: rawJsonValidCount, invalidResponses: rawJsonInvalidCount }, finalContract: scored.contract, inputChars: requests.reduce((n, req) => n + req.inputChars, 0), tokens: null, progressEvents, requests, scored, questions, output: sanitizedResult, baseline: null })

    const readme = await readFile(path.join(fixtureRoot, 'README.md'), 'utf8')
    const tree = treeToText(scan.tree, 10_000, fixtureRoot)
    const baselineMessages = [
      { role: 'system', content: 'Offline README+tree baseline. Return only JSON using facts present in the provided context.' },
      { role: 'user', content: `${readme}\n\n## Project tree\n${tree}\n\nGenerate exactly ${caseDef.budget.target} questions based only on this context.` }
    ]
    const baselineStart = serverRequests.length
    const baselineStarted = Date.now()
    const baselineReply = await chatCompletion(profile, baselineMessages, { signal: new AbortController().signal, timeoutMs: 600000 })
    const baselineRequests = serverRequests.slice(baselineStart)
    const baselineParsed = JSON.parse(baselineReply)
    const baselineQuestions = baselineParsed.sections.flatMap(section => section.questions.map(q => ({ ...q, section: section.title })))
    const baselineResult = { ...sanitizedResult, sections: baselineParsed.sections.map((section, i) => ({ id: `baseline-${i}`, title: section.title, summary: section.summary, questions: section.questions.map((q, j) => ({ id: `bq-${i}-${j}`, ...q })) })), projectSummary: baselineParsed.projectSummary, glossary: baselineParsed.glossary }
    const baselineScored = scoreCase(baselineResult, activeFixture)
    cases.at(-1).baseline = { definition: config.baseline, elapsedMs: Date.now() - baselineStarted, requestCount: baselineRequests.length, failedRequests: 0, repairRequestCount: baselineRequests.filter(request => request.attempt === 'repair').length, rawJson: { validResponses: baselineRequests.filter(request => request.rawJsonValid).length, invalidResponses: baselineRequests.filter(request => !request.rawJsonValid).length }, finalContract: baselineScored.contract, inputChars: baselineRequests.reduce((n, req) => n + req.inputChars, 0), tokens: null, requests: baselineRequests, scored: baselineScored, questions: baselineQuestions }
  }
} finally {
  globalThis.fetch = nativeFetch
  await new Promise(resolve => server.close(resolve))
}

const runId = randomUUID()
const questions = cases.flatMap(c => [
  ...c.questions.map(q => ({ caseId: c.id, variant: 'generation', question: q.question, answer: q.answer, followUps: q.followUps })),
  ...c.baseline.questions.map(q => ({ caseId: c.id, variant: 'baseline', question: q.question, answer: q.answer, followUps: q.followUps }))
].map(q => ({ ...q, fingerprint: fingerprintQuestion(q.question, { caseId: q.caseId, variant: q.variant, answer: q.answer, followUps: q.followUps }) })))
const reportDigest = `sha256:${hash(JSON.stringify({ runId, corpusVersion: CORPUS_VERSION, configHash, sourceHashes, fixtureHashes, cases: cases.map(c => ({ id: c.id, output: c.output, baseline: c.baseline })), questions }))}`
const run = { schemaVersion: SCHEMA_VERSION, runId, corpusVersion: CORPUS_VERSION, mode: config.mode, responseId: config.responseId, runtime: { node: process.version }, networkPolicy: { externalHttpAllowed: false, blockedAttempts: externalRequestAttempts, localEndpoint: '127.0.0.1 loopback only' }, config, configHash, sourceHashes, fixtureHashes, reportDigest, baselineDefinition: config.baseline, generatedAt: new Date().toISOString(), cases, questions, humanReview: { status: 'pending', reviewedCount: 0, coverage: 0, templatePath: 'review-template.json' }, limitations: ['This is offline pipeline and scorer calibration using deterministic local responses.', 'Keyword coverage is not factual correctness and does not measure real model quality.', 'Synthetic token counts are unavailable and reported as null.', 'Human review has not been completed; pending is not a passing result.'] }
const reportDir = outputDir
await (await import('node:fs/promises')).mkdir(reportDir, { recursive: true })
await writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(run, null, 2)}\n`)
await writeFile(path.join(reportDir, 'review-template.json'), `${JSON.stringify(makeReviewTemplate(run), null, 2)}\n`)
const md = [
  '# Offline generation evaluation', '',
  `- Mode: ${run.mode}`, `- Run: ${run.runId}`, `- Corpus: ${run.corpusVersion}`, `- Synthetic response: ${run.responseId}`, `- Node: ${run.runtime.node}`,
  `- Config hash: ${run.configHash}`, '- Scope: offline pipeline and scorer calibration; not a real model quality claim.', '',
  `Baseline: ${config.baseline}. Synthetic fault schedule: ${config.syntheticFaultSchedule}. Baseline uses one valid JSON response; the Node generation case separately calibrates production repair.`, '',
  '| Case | Granularity | Pipeline q | Baseline q | Δ q | Pipeline fact keywords | Baseline fact keywords | Pipeline duplicate rate | Baseline duplicate rate | Pipeline/base requests | Raw JSON valid/invalid (pipeline/base) | Repair requests (pipeline/base) | Final contract (pipeline/base) |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...cases.map(c => {
    return `| ${c.id} | ${c.granularity} | ${c.scored.quota.actual} | ${c.baseline.scored.quota.actual} | ${c.scored.quota.actual - c.baseline.scored.quota.actual} | ${c.scored.knownFactCoverage.covered}/${c.scored.knownFactCoverage.total} | ${c.baseline.scored.knownFactCoverage.covered}/${c.baseline.scored.knownFactCoverage.total} | ${(c.scored.duplicateRate.rate * 100).toFixed(1)}% | ${(c.baseline.scored.duplicateRate.rate * 100).toFixed(1)}% | ${c.requestCount}/${c.baseline.requestCount} | ${c.rawJson.validResponses}/${c.rawJson.invalidResponses} (${c.baseline.rawJson.validResponses}/${c.baseline.rawJson.invalidResponses}) | ${c.repairRequestCount}/${c.baseline.repairRequestCount} | ${c.finalContract.pass}/${c.baseline.finalContract.pass} |`
  }), '',
  ...cases.flatMap(c => [`### ${c.id}`, '', `Pipeline alerts: ${c.scored.alerts.length ? c.scored.alerts.join(', ') : 'none'}; forbidden hits ${c.scored.forbiddenAssertionHits.length}; input ${c.inputChars} chars; ${c.elapsedMs} ms.`, `Baseline alerts: ${c.baseline.scored.alerts.length ? c.baseline.scored.alerts.join(', ') : 'none'}; forbidden hits ${c.baseline.scored.forbiddenAssertionHits.length}; input ${c.baseline.inputChars} chars; ${c.baseline.elapsedMs} ms.`, '']),
  `Human review coverage: 0/${questions.length} pending. See review-template.json.`, '',
  'Limitations: keyword coverage only shows that configured terms appeared in generated text; it is not a factual accuracy score. No real model was called. Tokens are null because synthetic token usage is not measured.', '',
  'Full outputs, raw synthetic replies, per-request messages, hashes, and case-level metrics are in report.json.'
].join('\n')
await writeFile(path.join(reportDir, 'report.md'), `${md}\n`)
console.log(JSON.stringify({ report: path.relative(repo, path.join(reportDir, 'report.json')), cases: cases.map(c => ({ id: c.id, requests: c.requestCount, questionCount: c.scored.quota.actual, alerts: c.scored.alerts })), runId }))
