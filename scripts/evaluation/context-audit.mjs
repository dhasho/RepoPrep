import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanProject } from '../../electron/services/scanner.ts'
import { generateInterview } from '../../electron/services/generator.ts'
import { sourceRegionCandidates, formatSourceRegions, compactRegionDocumentation } from '../../electron/services/snippet-selection.ts'
import { analyzeSource } from '../../electron/services/source-analysis.ts'
import { redactSensitiveContent } from '../../electron/services/sensitive.ts'
import { readProjectContent } from '../../electron/services/project-content-reader.ts'
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
  if (typeof model !== 'string' || model.length === 0 || model.length > 256 || (config.protocol ?? reference.protocol) !== 'openai') throw new Error('reference report must contain an OpenAI inference configuration')
  const protocol = config.protocol ?? reference.protocol
  if (protocol !== 'openai') throw new Error('context audit supports OpenAI protocol only')
  const reasoningEffort = config.reasoningEffort ?? 'provider-default'
  if (!['low', 'high', 'provider-default'].includes(reasoningEffort)) throw new Error('reference report has an unsupported reasoning effort')
  const temperature = config.temperature ?? 0.4
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('reference report has an invalid temperature')
  for (const value of [config.contextWindowTokens, config.maxOutputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_097_152)) throw new Error('reference report has an invalid token limit')
  }
  return {
    model,
    protocol,
    temperature,
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

export function dispatchedCandidate(candidate, dispatches, captures, relPath, regionMap) {
  let selectedForPath = false
  let wholeFile = false
  let originalProvided = false
  let excerptProvided = false
  let partialProvided = false
  for (let index = 0; index < dispatches.length; index++) {
    const source = dispatches[index].sourceSelections?.find(entry => entry.relPath === relPath)
    if (!source) continue
    selectedForPath = true
    if (source.wholeFile) { wholeFile = true; continue }
    for (const region of source.regions) {
      if (region.start > candidate.start || region.end < candidate.end) continue
      if (region.documentationOmitted) {
        const parent = regionMap.get(`${region.start}:${region.end}`)
        if (!parent) continue
        const compactParent = compactRegionDocumentation(parent)
        const bodyMessages = captures[index]?.requestBody.messages ?? []
        const excerptMarker = '（文档节选，原文有省略）\n'
        const inFinalBody = bodyMessages.some(message => message.content.includes(`${excerptMarker}${compactParent.text}`))
        if (!inFinalBody) continue
        const compactCandidate = compactRegionDocumentation(candidate)
        if (compactParent.text.includes(candidate.text)) originalProvided = true
        else if (compactCandidate.documentationOmitted && compactParent.text.includes(compactCandidate.text)) excerptProvided = true
      } else if (region.complete) {
        originalProvided = true
      } else if (region.start === candidate.start && region.end === candidate.end) {
        partialProvided = true
      }
    }
  }
  if (wholeFile) originalProvided = true
  const state = originalProvided ? 'source-region-provided'
    : excerptProvided ? 'documentation-excerpt-provided'
      : partialProvided ? 'partial-source-region-provided'
        : selectedForPath ? 'file-dispatched-region-not-observed'
          : 'file-not-observed-in-final-request'
  return { state, originalProvided, documentationExcerptProvided: excerptProvided, selectedForPath, wholeFile }
}

export function observeCandidate(candidate, fileContent, fileProvided = true) {
  const compact = compactRegionDocumentation(candidate)
  const rawMatched = fileProvided && fileContent.includes(candidate.text)
  const excerptMarker = '（文档节选，原文有省略）'
  const compactMatched = Boolean(fileProvided && compact.documentationOmitted && fileContent.includes(`${excerptMarker}\n${compact.text}`))
  return {
    state: rawMatched ? 'source-region-provided' : compactMatched ? 'documentation-excerpt-provided' : 'file-provided-region-not-observed',
    candidateComplete: candidate.complete,
    documentationOmitted: Boolean(compact.documentationOmitted),
    candidateSha256: hash(candidate.text),
    compactCandidateSha256: hash(compact.text),
    originalProvided: rawMatched,
    documentationExcerptProvided: compactMatched
  }
}

function offsetForLine(offsets, line, textLength) {
  return offsets[line - 1] ?? textLength
}

function endOffsetForLine(offsets, line, text) {
  let end = offsetForLine(offsets, line + 1, text.length)
  if (text[end - 1] === '\n') end--
  if (text[end - 1] === '\r') end--
  return end
}

async function auditEvidence(item, scan, captured, dispatches) {
  const fileMap = new Map(scan.files.map(file => [file.relPath, file]))
  const sourceUnits = []
  const byPath = new Map()
  for (const evidenceFile of item.evidenceFiles) {
    const file = fileMap.get(evidenceFile.path)
    if (!file) {
      byPath.set(evidenceFile.path, { state: 'file-not-provided', unitIndexes: [] })
      continue
    }
    if (!file.isContentCandidate) {
      byPath.set(evidenceFile.path, { state: 'file-not-authorized', unitIndexes: [] })
      continue
    }
    let raw
    try { raw = await readProjectContent(scan, file) }
    catch {
      byPath.set(evidenceFile.path, { state: 'file-read-failed', unitIndexes: [] })
      continue
    }
    const safeContent = redactSensitiveContent(raw).content
    const lineMappingAvailable = raw.split(/\r?\n/u).length === safeContent.split(/\r?\n/u).length
    const candidates = sourceRegionCandidates(safeContent, analyzeSource(evidenceFile.path, safeContent), { extension: path.extname(evidenceFile.path) })
    const pathDispatches = dispatches.map((dispatch, index) => ({ dispatch, capture: captured[index] }))
      .filter(entry => entry.dispatch.sourceSelections.some(source => source.relPath === evidenceFile.path))
      .map(entry => ({ ...entry, source: entry.dispatch.sourceSelections.find(source => source.relPath === evidenceFile.path) }))
    const lineOffsets = [0]
    for (let index = 0; index < safeContent.length; index++) if (safeContent[index] === '\n') lineOffsets.push(index + 1)
    const wholeFileSelected = pathDispatches.some(entry => entry.source.wholeFile)
    const hasRegionSelections = pathDispatches.some(entry => entry.source.regions.length > 0)
    const fileState = wholeFileSelected ? 'whole-file-dispatched'
      : hasRegionSelections ? 'source-regions-dispatched'
        : pathDispatches.length ? 'file-dispatched-boundary-unavailable'
          : 'file-not-observed-in-final-request'
    const unitIndexes = []
    const units = candidates.length ? candidates : [{ start: 0, end: safeContent.length, text: safeContent, label: 'file-level', complete: false, priority: 0 }]
    const regionMap = new Map(units.map(region => [`${region.start}:${region.end}`, region]))
    for (const candidate of units) {
      const observation = dispatchedCandidate(candidate, dispatches, captured, evidenceFile.path, regionMap)
      const compact = compactRegionDocumentation(candidate)
      unitIndexes.push(sourceUnits.length)
      const startLine = Math.max(1, lineOffsets.findLastIndex(offset => offset <= candidate.start) + 1)
      const endLine = Math.max(startLine, lineOffsets.findLastIndex(offset => offset < Math.max(candidate.start + 1, candidate.end)) + 1)
      sourceUnits.push({
        path: evidenceFile.path,
        symbol: candidate.qualifiedName ?? candidate.label,
        sourceSha256: evidenceFile.sha256,
        redactedSourceSha256: hash(safeContent),
        startOffset: candidate.start,
        endOffset: candidate.end,
        startLine,
        endLine,
        documentationOmitted: Boolean(compact.documentationOmitted),
        candidateSha256: hash(candidate.text),
        compactCandidateSha256: hash(compact.text),
        candidateComplete: candidate.complete,
        originalProvided: observation.originalProvided,
        documentationExcerptProvided: observation.documentationExcerptProvided,
        selectedDispatches: pathDispatches.length,
        state: observation.state === 'file-not-observed-in-final-request' && fileState === 'file-dispatched-boundary-unavailable'
          ? fileState
          : observation.state,
        regionGuarantee: candidates.length ? 'candidate text boundary; not unique AST-node identity or implementation-completeness proof' : 'file-level only'
      })
    }
    byPath.set(evidenceFile.path, { state: fileState, unitIndexes, contentLength: safeContent.length, lineOffsets, safeContent, lineMappingAvailable })
  }
  const facts = item.knownFacts.map(fact => ({
    id: fact.id,
    evidence: fact.evidence.map(evidence => {
      const fileResult = byPath.get(evidence.path)
      if (!fileResult || fileResult.state === 'file-not-observed-in-final-request' || fileResult.state === 'file-dispatched-boundary-unavailable') return { path: evidence.path, startLine: evidence.startLine, endLine: evidence.endLine, state: fileResult?.state ?? 'file-not-in-evidence-manifest', unitIndexes: [] }
      if (!fileResult.lineMappingAvailable) return { path: evidence.path, startLine: evidence.startLine, endLine: evidence.endLine, state: 'line-mapping-unavailable', unitIndexes: [] }
      const evidenceStart = offsetForLine(fileResult.lineOffsets, evidence.startLine, fileResult.contentLength)
      const evidenceEnd = endOffsetForLine(fileResult.lineOffsets, evidence.endLine, fileResult.safeContent)
      const matchingUnits = fileResult.unitIndexes.filter(index => {
        const unit = sourceUnits[index]
        return unit.startOffset <= evidenceStart && unit.endOffset >= evidenceEnd
      })
      const smallestSize = matchingUnits.length ? Math.min(...matchingUnits.map(index => sourceUnits[index].endOffset - sourceUnits[index].startOffset)) : Infinity
      const smallest = matchingUnits.filter(index => sourceUnits[index].endOffset - sourceUnits[index].startOffset === smallestSize)
      const overlapping = fileResult.unitIndexes.filter(index => sourceUnits[index].startOffset < evidenceEnd && sourceUnits[index].endOffset > evidenceStart)
      const selected = smallest.length ? smallest : overlapping
      const state = smallest.length > 1 ? 'ambiguous-candidate-unit'
        : smallest.length === 1 ? sourceUnits[smallest[0]].state
          : overlapping.length ? 'cross-unit-evidence'
            : 'file-provided-boundary-unavailable'
      return { path: evidence.path, startLine: evidence.startLine, endLine: evidence.endLine, state, unitIndexes: selected }
    })
  }))
  return { sourceUnits, facts }
}

function validDispatch(selection) {
  if (!Array.isArray(selection?.sourceSelections)) return false
  return selection.sourceSelections.every(source => typeof source.relPath === 'string' && source.relPath.length > 0 &&
    !path.posix.isAbsolute(source.relPath) && !source.relPath.split('/').includes('..') && typeof source.wholeFile === 'boolean' &&
    Array.isArray(source.regions) && source.regions.every(region => Number.isSafeInteger(region.start) && Number.isSafeInteger(region.end) &&
      region.start >= 0 && region.end >= region.start && typeof region.complete === 'boolean' &&
      (region.documentationOmitted === undefined || region.documentationOmitted === true)))
}

export async function runContextAudit({ reposRoot, outputDir, referenceReport, caseIds = [], onCapture, testManifestPath }) {
  const out = path.resolve(outputDir)
  const parent = path.dirname(out)
  if (await realpath(parent) !== parent) throw new Error('output parent must be a canonical directory')
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('output parent must be a real directory')
  let outputExists = false
  try { await lstat(out); outputExists = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (outputExists) throw new Error('output directory already exists')
  const report = { schemaVersion: 'repoprep-context-audit-v1', status: 'incomplete', mode: 'context-only', networkRequests: 0, syntheticCaptures: 0, captures: [], actualProviderUsage: null, cases: [], limitations: ['No provider call or provider usage was observed.', 'Text membership is not AST-node identity, implementation completeness, factual accuracy, or answer quality.'] }
  await mkdir(out, { recursive: false })
  let failureStage = 'configuration'
  let failureCode = 'context_audit_incomplete'
  try {
    const config = readInferenceConfig(referenceReport)
    const activeManifestPath = testManifestPath ?? manifestPath
    failureStage = 'corpus-verification'
    const verification = await verifyRealCorpus({ reposRoot, manifestPath: activeManifestPath })
    const manifest = JSON.parse(await readFile(activeManifestPath, 'utf8'))
    const selected = manifest.cases.filter(item => !caseIds.length || caseIds.includes(item.id))
    if (!selected.length || selected.length !== new Set(caseIds).size && caseIds.length) throw new Error('requested corpus case was not found')
    failureStage = 'source-hashing'
    const sourceHashes = await hashSources(activeManifestPath)
    for (const item of selected) {
      failureStage = 'project-scan'
      const root = path.resolve(reposRoot, item.directory)
      const scan = await scanProject(root)
      const captures = []
      const dispatches = []
      const restore = installSyntheticFetch(captures, onCapture)
      try {
        failureStage = 'generation'
        await generateInterview({ scan, granularity: 'medium', roleFocus: item.roleFocus ?? 'general', profile: {
          id: 'context-audit', name: 'Synthetic context audit', baseUrl: syntheticOrigin, apiKey: 'SYNTHETIC_ONLY',
          model: config.model, protocol: 'openai', temperature: config.temperature,
          ...(config.reasoningEffort !== 'provider-default' ? { reasoningEffort: config.reasoningEffort } : {}),
          ...(config.contextWindowTokens ? { contextWindowTokens: config.contextWindowTokens } : {}),
          ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {})
        }, signal: AbortSignal.timeout(120_000), onProgress: () => {}, onContextDispatch: selection => { dispatches.push(selection) } })
      } finally {
        restore()
        report.syntheticCaptures += captures.length
        report.captures.push(...captures.map(({ requestBodyHash }) => ({ caseId: item.id, requestBodyHash })))
      }
      failureStage = 'dispatch-validation'
      if (!captures.length || captures.length !== dispatches.length || dispatches.some(selection => !validDispatch(selection))) {
        failureCode = 'dispatch_capture_mismatch'
        throw new Error('context dispatch proof unavailable')
      }
      failureStage = 'evidence-audit'
      const audit = await auditEvidence(item, scan, captures, dispatches)
      const sourceUnitStatusCounts = Object.fromEntries([...new Set(audit.sourceUnits.map(unit => unit.state))].sort().map(state => [state, audit.sourceUnits.filter(unit => unit.state === state).length]))
      report.cases.push({ id: item.id, commit: item.commit, repository: item.repository, fixtureHashes: Object.fromEntries(item.evidenceFiles.map(file => [file.path, file.sha256])), dispatchCount: dispatches.length, sourceUnitCount: audit.sourceUnits.length, sourceUnitStatusCounts, sourceUnits: audit.sourceUnits, facts: audit.facts, estimatedInputTokens: captures.reduce((n, item) => n + estimateMessageTokens(item.requestBody.messages ?? []), 0), requestBodyHashes: captures.map(item => item.requestBodyHash) })
      captures.length = 0
    }
    report.sourceHashes = sourceHashes
    report.corpus = verification
    report.configuration = config
    report.status = 'complete'
  } catch (error) {
    report.failure = { stage: failureStage, code: failureCode }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('context audit failed'); process.exitCode = 1 })
