import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanProject } from '../../electron/services/scanner.ts'
import { generateInterview } from '../../electron/services/generator.ts'
import { sourceRegionCandidates, compactRegionDocumentation } from '../../electron/services/snippet-selection.ts'
import { analyzeSource } from '../../electron/services/source-analysis.ts'
import { redactSensitiveContent } from '../../electron/services/sensitive.ts'
import { estimateMessageTokens } from '../../shared/token-budget.ts'
import { hashSources, verifyRealCorpus } from './real-runner.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.join(here, 'real-corpus/corpus.json')
const syntheticOrigin = 'https://context-audit.invalid'
const hash = value => createHash('sha256').update(value).digest('hex')

export function parseContextAuditArgs(args) {
  const options = { cases: [] }
  const allowed = new Set(['--repos-root', '--output', '--reference-report', '--case'])
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!allowed.has(key)) throw new Error('unknown context audit argument')
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error('missing context audit argument value')
    if (key === '--case') options.cases.push(value)
    else if (options[key]) throw new Error('duplicate context audit argument')
    else options[key] = value
  }
  if (!options['--repos-root'] || !options['--output']) throw new Error('repos-root and output are required')
  return options
}

function readInferenceConfig(reference) {
  if (!reference) return { model: 'context-audit-synthetic', protocol: 'openai', temperature: 0.4, reasoningEffort: 'provider-default', contextWindowTokens: undefined, maxOutputTokens: undefined }
  const config = reference.config ?? reference
  const model = reference.model ?? config.model
  if (typeof model !== 'string' || (config.protocol ?? reference.protocol) !== 'openai') throw new Error('reference report must contain an OpenAI inference configuration')
  const protocol = config.protocol ?? reference.protocol
  if (protocol !== 'openai') throw new Error('context audit supports OpenAI protocol only')
  const reasoningEffort = config.reasoningEffort ?? 'provider-default'
  if (!['low', 'high', 'provider-default'].includes(reasoningEffort)) throw new Error('reference report has an unsupported reasoning effort')
  for (const value of [config.contextWindowTokens, config.maxOutputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_097_152)) throw new Error('reference report has an invalid token limit')
  }
  return {
    model,
    protocol,
    temperature: Number.isFinite(config.temperature) ? config.temperature : 0.4,
    reasoningEffort,
    contextWindowTokens: config.contextWindowTokens,
    maxOutputTokens: config.maxOutputTokens
  }
}

function syntheticCompletion() {
  const questions = Array.from({ length: 20 }, (_, index) => ({
    question: `Synthetic question ${index + 1}?`, answer: 'Synthetic answer.', followUps: []
  }))
  return JSON.stringify({ title: 'Synthetic interview', summary: 'Synthetic only.', sections: [{ title: 'Synthetic', summary: 'Synthetic', questions }], glossary: {} })
}

export function installSyntheticFetch(captures, onCapture) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== syntheticOrigin) throw new Error('context audit blocked non-synthetic network request')
    if (url.pathname.endsWith('/models')) throw new Error('context audit blocked model discovery request')
    if (init.method !== 'POST' || typeof init.body !== 'string') throw new Error('unexpected synthetic request shape')
    const capture = { requestBodyHash: hash(init.body), requestBody: JSON.parse(init.body) }
    captures.push(capture)
    onCapture?.(capture)
    const payload = JSON.stringify({ choices: [{ message: { content: syntheticCompletion() } }] })
    return new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return () => { globalThis.fetch = original }
}

function lineSlice(text, startLine, endLine) {
  return text.split('\n').slice(startLine - 1, endLine).join('\n')
}

export function observeCandidate(candidate, bodyContents) {
  const compact = compactRegionDocumentation(candidate)
  const rawMatched = bodyContents.some(body => body.includes(candidate.text))
  const excerptMarker = '（文档节选，原文有省略）'
  const compactMatched = Boolean(compact.documentationOmitted && bodyContents.some(body => body.includes(`${excerptMarker}\n${compact.text}`)))
  return {
    state: rawMatched ? 'source-region-provided' : compactMatched ? 'documentation-excerpt-provided' : 'file-provided-region-not-observed',
    candidateText: compact.documentationOmitted ? compact.text : candidate.text,
    candidateComplete: candidate.complete,
    documentationOmitted: Boolean(compact.documentationOmitted),
    candidateSha256: hash(candidate.text)
  }
}

async function auditEvidence(item, root, scan, captured) {
  const fileMap = new Map(scan.files.map(file => [file.relPath, file]))
  const results = []
  for (const fact of item.knownFacts) for (const evidence of fact.evidence) {
    const file = fileMap.get(evidence.path)
    if (!file) { results.push({ factId: fact.id, path: evidence.path, state: 'file-not-provided', regionGuarantee: 'file-level only' }); continue }
    let content
    try { content = await readFile(path.join(root, evidence.path), 'utf8') }
    catch { results.push({ factId: fact.id, path: evidence.path, state: 'file-unreadable', regionGuarantee: 'file-level only' }); continue }
    const safeContent = redactSensitiveContent(content).content
    const startOffset = safeContent.split('\n').slice(0, evidence.startLine - 1).join('\n').length + (evidence.startLine > 1 ? 1 : 0)
    const source = lineSlice(safeContent, evidence.startLine, evidence.endLine)
    const candidates = sourceRegionCandidates(safeContent, analyzeSource(evidence.path, safeContent), { extension: path.extname(evidence.path) })
    const containing = candidates.filter(region => region.start <= startOffset && region.end >= startOffset + source.length)
    if (containing.length !== 1) {
      results.push({ factId: fact.id, path: evidence.path, state: containing.length ? 'ambiguous-candidate-boundary' : 'candidate-boundary-unavailable', fileProvided: true, regionGuarantee: 'file-level only; no AST completeness claim' })
      continue
    }
    const candidate = containing[0]
    const bodies = captured.flatMap(entry => (entry.requestBody.messages ?? []).map(message => message.content))
    const observation = observeCandidate(candidate, bodies, path.extname(evidence.path))
    results.push({
      factId: fact.id, path: evidence.path, startLine: evidence.startLine, endLine: evidence.endLine,
      ...observation,
      regionGuarantee: 'heuristic text candidate; no unique AST-node identity or completeness claim'
    })
  }
  return results
}

export async function runContextAudit({ reposRoot, outputDir, referenceReport, caseIds = [], onCapture }) {
  const out = path.resolve(outputDir)
  const parent = path.dirname(out)
  if (await realpath(parent) !== parent) throw new Error('output parent must be a canonical directory')
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('output parent must be a real directory')
  try { await lstat(out); throw new Error('output directory already exists') }
  catch (error) { if (error.message === 'output directory already exists') throw error; if (error.code !== 'ENOENT') throw error }
  const report = { schemaVersion: 'repoprep-context-audit-v1', status: 'incomplete', mode: 'context-only', networkRequests: 0, syntheticCaptures: 0, captures: [], actualProviderUsage: null, cases: [], limitations: ['No provider call or provider usage was observed.', 'Text membership is not AST-node identity, implementation completeness, factual accuracy, or answer quality.'] }
  await mkdir(out, { recursive: false })
  try {
    const config = readInferenceConfig(referenceReport)
    const verification = await verifyRealCorpus({ reposRoot, manifestPath })
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const selected = manifest.cases.filter(item => !caseIds.length || caseIds.includes(item.id))
    if (!selected.length || selected.length !== new Set(caseIds).size && caseIds.length) throw new Error('requested corpus case was not found')
    const sourceHashes = await hashSources(manifestPath)
    for (const item of selected) {
      const root = path.resolve(reposRoot, item.directory)
      const scan = await scanProject(root)
      const captures = []
      const restore = installSyntheticFetch(captures, onCapture)
      try {
        await generateInterview({ scan, granularity: 'medium', roleFocus: item.roleFocus ?? 'general', profile: {
          id: 'context-audit', name: 'Synthetic context audit', baseUrl: syntheticOrigin, apiKey: 'SYNTHETIC_ONLY',
          model: config.model, protocol: 'openai', temperature: config.temperature,
          ...(config.reasoningEffort !== 'provider-default' ? { reasoningEffort: config.reasoningEffort } : {}),
          ...(config.contextWindowTokens ? { contextWindowTokens: config.contextWindowTokens } : {}),
          ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {})
        }, signal: AbortSignal.timeout(120_000), onProgress: () => {} })
      } finally { restore() }
      report.syntheticCaptures += captures.length
      report.captures.push(...captures.map(({ requestBodyHash }) => ({ caseId: item.id, requestBodyHash })))
      report.cases.push({ id: item.id, commit: item.commit, repository: item.repository, fixtureHashes: Object.fromEntries(item.evidenceFiles.map(file => [file.path, file.sha256])), evidence: await auditEvidence(item, root, scan, captures), estimatedInputTokens: captures.reduce((n, item) => n + estimateMessageTokens(item.requestBody.messages ?? []), 0), requestBodyHashes: captures.map(item => item.requestBodyHash) })
      captures.length = 0
    }
    report.sourceHashes = sourceHashes
    report.corpus = verification
    report.configuration = config
    report.status = 'complete'
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'audit failed'
  } finally {
    await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  if (report.status !== 'complete') throw new Error(`context audit incomplete; report: ${path.join(out, 'report.json')}`)
  return report
}

async function main() {
  if (process.argv.includes('--help')) { console.log('eval:context --repos-root <dir> --output <new-dir> [--reference-report <report.json>] [--case <id>]'); return }
  const args = parseContextAuditArgs(process.argv.slice(2))
  const reference = args['--reference-report'] ? JSON.parse(await readFile(args['--reference-report'], 'utf8')) : undefined
  const report = await runContextAudit({ reposRoot: args['--repos-root'], outputDir: args['--output'], referenceReport: reference, caseIds: args.cases })
  console.log(JSON.stringify({ status: report.status, report: path.join(path.resolve(args['--output']), 'report.json') }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
