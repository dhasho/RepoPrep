import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')
const cases = [
  { id: 'requests', directory: 'reports/real-generation-eval/2026-11-04-doc-excerpt-requests' },
  { id: 'mitt', directory: 'reports/real-generation-eval/2026-11-05-doc-excerpt-mitt-schedule' }
]

function argumentsFor(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    assert.ok(['--root', '--repos-root', '--output'].includes(key), 'unknown argument')
    assert.ok(!options[key], 'duplicate argument')
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), 'missing argument value')
    options[key] = args[index + 1]
  }
  for (const key of ['--root', '--repos-root', '--output']) assert.ok(options[key], 'required argument missing')
  return options
}

function relativeFile(file) {
  assert.equal(typeof file, 'string')
  assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'invalid relative source path')
  return file
}

async function run(options) {
  const root = path.resolve(options['--root'])
  const reposRoot = path.resolve(options['--repos-root'])
  const output = path.resolve(options['--output'])
  assert.equal(await realpath(root), root, 'root must be canonical')
  const outputParent = path.dirname(output)
  assert.equal(await realpath(outputParent), outputParent, 'output parent must be canonical')
  assert.ok((await lstat(outputParent)).isDirectory())
  try { await lstat(output); throw new Error('output already exists') }
  catch (error) { if (error.code !== 'ENOENT') throw error }

  const local = file => import(pathToFileURL(path.join(root, file)).href)
  const [scanner, generator, snippets, analysis, sensitive, reader, scorer, reviewer, realRunner, audit] = await Promise.all([
    local('electron/services/scanner.ts'), local('electron/services/generator.ts'),
    local('electron/services/snippet-selection.ts'), local('electron/services/source-analysis.ts'),
    local('electron/services/sensitive.ts'), local('electron/services/project-content-reader.ts'),
    local('scripts/evaluation/scorer.mjs'), local('scripts/evaluation/review.mjs'),
    local('scripts/evaluation/real-runner.mjs'), local('scripts/evaluation/context-audit.mjs')
  ])
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))
  const manifestPath = path.join(root, 'scripts/evaluation/real-corpus/corpus.json')
  const corpus = await json('scripts/evaluation/real-corpus/corpus.json')
  await realRunner.verifyRealCorpus({ reposRoot, manifestPath })
  const sourceHashes = await realRunner.hashSources(manifestPath)
  const sourceMapHash = hash(JSON.stringify(Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)))))
  const results = []
  for (const spec of cases) {
    const reportPath = `${spec.directory}/report.json`
    const reviewPath = `${spec.directory}/assistant-review-${spec.id}.json`
    const reportBytes = await readFile(path.join(root, reportPath))
    const reviewBytes = await readFile(path.join(root, reviewPath))
    const report = JSON.parse(reportBytes)
    const review = JSON.parse(reviewBytes)
    assert.equal(report.status, 'complete')
    assert.equal(reviewer.calculateReportDigest(report), report.reportDigest)
    assert.equal(review.runId, report.runId)
    assert.equal(review.reportDigest, report.reportDigest)
    assert.equal(review.caseId, spec.id)
    assert.deepEqual(sourceHashes, report.sourceHashes, 'producer source drift')
    const reviewSummary = await json(`${spec.directory}/assistant-review-summary.json`)
    assert.equal(reviewSummary.reviewFiles.find(file => file.filename === `assistant-review-${spec.id}.json`).sha256, hash(reviewBytes))
    const variant = review.variants.find(value => value.variant === 'generation')
    const questions = report.questions.filter(value => value.caseId === spec.id && value.variant === 'generation')
    const fingerprints = questions.map(question => scorer.fingerprintQuestion(question.question, {
      caseId: spec.id, variant: 'generation', answer: question.answer ?? '',
      followUps: question.followUps ?? [], sourceEvidence: question.sourceEvidence ?? []
    }))
    assert.deepEqual([...fingerprints].sort(), [...variant.questionFingerprints].sort())
    assert.equal(variant.findings.length, 4, 'frozen review finding set changed')
    for (const finding of variant.findings) assert.equal(finding.questionFingerprint, variant.questionFingerprints[finding.questionNumber - 1])
    const refs = [...new Map(variant.findings.flatMap(finding => finding.sourceRefs).map(ref => [`${ref.path}:${ref.startLine}:${ref.endLine}`, ref])).values()]
    const item = corpus.cases.find(value => value.id === spec.id)
    const scan = await scanner.scanProject(path.join(reposRoot, item.directory))
    const captures = []
    const dispatches = []
    const restore = audit.installSyntheticFetch(captures)
    try {
      assert.equal(report.protocol, 'openai')
      await generator.generateInterview({ scan, granularity: 'medium', roleFocus: item.roleFocus ?? 'general', profile: {
        id: 'context-audit', name: 'Synthetic context audit', baseUrl: 'https://context-audit.invalid', apiKey: 'SYNTHETIC_ONLY',
        model: report.model, protocol: report.protocol, temperature: report.config.temperature,
        ...(report.config.reasoningEffort !== 'provider-default' ? { reasoningEffort: report.config.reasoningEffort } : {}),
        ...(report.config.contextWindowTokens != null ? { contextWindowTokens: report.config.contextWindowTokens } : {}),
        ...(report.config.maxOutputTokens != null ? { maxOutputTokens: report.config.maxOutputTokens } : {})
      }, signal: AbortSignal.timeout(120_000), onProgress: () => {}, onContextDispatch: selection => dispatches.push(selection) })
    } finally { restore() }
    const generation = report.cases.find(value => value.id === spec.id).generation
    assert.equal(captures.length, 1)
    assert.equal(dispatches.length, 1)
    assert.equal(generation.requests.length, 1)
    assert.equal(captures[0].requestBodyHash, generation.requests[0].promptHash, 'request body drift')
    const bodyMessages = captures[0].requestBody.messages
    const bodyContains = text => bodyMessages.some(message => typeof message.content === 'string' && message.content.includes(text))
    const selections = dispatches[0].sourceSelections
    assert.ok(Array.isArray(selections))
    for (const selection of selections) relativeFile(selection.relPath)
    const observations = []
    for (const ref of refs) {
      const relative = relativeFile(ref.path)
      const basic = { path: relative, startLine: ref.startLine, endLine: ref.endLine }
      const file = scan.files.find(value => value.relPath === relative)
      if (!file?.isContentCandidate) { observations.push({ ...basic, state: 'unknown-file-unavailable' }); continue }
      const raw = await reader.readProjectContent(scan, file)
      const safe = sensitive.redactSensitiveContent(raw).content
      const fileHashes = { sourceSha256: hash(raw), redactedSourceSha256: hash(safe) }
      if (raw.split(/\r?\n/u).length !== safe.split(/\r?\n/u).length) {
        observations.push({ ...basic, ...fileHashes, state: 'unknown-redaction-line-mapping' }); continue
      }
      const offsets = [0]
      for (let index = 0; index < safe.length; index++) if (safe[index] === '\n') offsets.push(index + 1)
      assert.ok(Number.isSafeInteger(ref.startLine) && Number.isSafeInteger(ref.endLine) && ref.startLine > 0 && ref.endLine >= ref.startLine && ref.endLine <= offsets.length)
      const start = offsets[ref.startLine - 1]
      let end = offsets[ref.endLine] ?? safe.length
      if (safe[end - 1] === '\n') end--
      if (safe[end - 1] === '\r') end--
      const refText = safe.slice(start, end)
      assert.ok(refText.length > 0)
      const candidates = snippets.sourceRegionCandidates(safe, analysis.analyzeSource(relative, safe), { extension: path.extname(relative) })
      const byBounds = new Map(candidates.map(candidate => [`${candidate.start}:${candidate.end}`, candidate]))
      const selected = selections.filter(selection => selection.relPath === relative)
      let rawProvided = false
      let verifiedOverlap = false
      let documentationOverlap = false
      let unknownOverlap = false
      const spanEvidence = []
      for (const selection of selected) {
        if (selection.wholeFile) {
          const matched = bodyContains(safe)
          spanEvidence.push({ wholeFile: true, renderedSha256: hash(safe), matchedInFinalBody: matched })
          if (matched) { rawProvided = true; verifiedOverlap = true }
          else unknownOverlap = true
        }
        for (const region of selection.regions) {
          if (region.start >= end || region.end <= start) continue
          const parent = byBounds.get(`${region.start}:${region.end}`)
          const renderedParent = parent && (region.documentationOmitted ? snippets.compactRegionDocumentation(parent) : parent)
          if (!renderedParent || (region.documentationOmitted && !renderedParent.documentationOmitted)) { unknownOverlap = true; continue }
          const rendered = snippets.formatSourceRegions([renderedParent], path.extname(relative))
          const matched = bodyContains(rendered)
          const coversReference = region.start <= start && region.end >= end
          const intersectsDocumentation = Boolean(region.documentationOmitted && parent.documentationRanges?.some(range => parent.start + range.start < end && parent.start + range.end > start))
          spanEvidence.push({ start: region.start, end: region.end, complete: region.complete,
            documentationOmitted: Boolean(region.documentationOmitted), renderedSha256: hash(rendered),
            matchedInFinalBody: matched, coversReference, intersectsDocumentation })
          if (!matched) { unknownOverlap = true; continue }
          verifiedOverlap = true
          documentationOverlap ||= intersectsDocumentation
          if (coversReference && !intersectsDocumentation && renderedParent.text.includes(refText)) rawProvided = true
        }
      }
      const state = rawProvided ? 'raw-reference-provided'
        : verifiedOverlap ? (documentationOverlap ? 'partial-reference-with-documentation-excerpt' : 'partial-reference-across-rendered-spans')
          : unknownOverlap ? 'unknown-dispatched-span-not-verified'
            : selected.length ? 'file-dispatched-no-reference-overlap' : 'file-not-dispatched'
      observations.push({ ...basic, ...fileHashes, startOffset: start, endOffset: end,
        referenceSha256: hash(refText), state, spanEvidence })
    }
    const counts = Object.fromEntries([...new Set(observations.map(value => value.state))].sort().map(state => [state, observations.filter(value => value.state === state).length]))
    results.push({ caseId: spec.id, repository: item.repository, commit: item.commit,
      originalReport: reportPath, originalRunId: report.runId, originalReportDigest: report.reportDigest,
      originalReportSha256: hash(reportBytes), originalReview: reviewPath, originalReviewSha256: hash(reviewBytes),
      questionFingerprints: variant.questionFingerprints, requestBodyHash: captures[0].requestBodyHash,
      requestHashMatched: true, providerRequests: 0, syntheticCaptures: 1,
      dispatchSelections: selections, referenceCounts: counts, sourceReferences: observations,
      findings: variant.findings.map(finding => ({ kind: finding.kind, questionNumber: finding.questionNumber,
        questionFingerprint: finding.questionFingerprint,
        sourceReferences: finding.sourceRefs.map(ref => `${ref.path}:${ref.startLine}-${ref.endLine}`),
        evidenceLimit: spec.id === 'mitt' && finding.questionNumber === 18
          ? 'The project script is visible; external npm-run-all mixed-group semantics were not included.'
          : spec.id === 'mitt' && finding.questionNumber === 7
            ? 'The source signatures are visible; the later TypeScript 5.9.3 probe was not generation context.' : null })) })
    captures.length = 0
  }
  await realRunner.verifyRealCorpus({ reposRoot, manifestPath })
  assert.deepEqual(await realRunner.hashSources(manifestPath), sourceHashes, 'producer changed during capture')
  const result = { schemaVersion: 'repoprep-finding-context-audit-v1', status: 'complete', mode: 'context-only',
    providerRequests: 0, syntheticCaptures: 2, producerSourceFiles: Object.keys(sourceHashes).length,
    producerSourceMapSha256: sourceMapHash, sourceHashesMatchOriginalRuns: true,
    method: 'Production serialization and dispatch metadata; same-file span text is verified in the in-memory final request. No Markdown header parsing.',
    cases: results, limitations: [
      'Reference text visibility does not prove answer correctness, unique AST identity, or a cause of an error.',
      'A partially provided reference is distinct from a wholly unobserved reference.',
      'Project source visibility does not establish that all external language or dependency semantics were supplied.',
      'The frozen assistant reviews are non-blind; this audit adds no human review or fresh model-quality measurement.'
    ] }
  await mkdir(output)
  await writeFile(path.join(output, 'finding-context-audit.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ status: 'complete', providerRequests: 0, sourceFiles: Object.keys(sourceHashes).length,
    cases: results.map(value => ({ caseId: value.caseId, requestHashMatched: value.requestHashMatched, referenceCounts: value.referenceCounts })) }))
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('audit-finding-context.mjs --root <repo> --repos-root <public-corpus-parent> --output <new-directory>')
    return
  }
  await run(argumentsFor(process.argv.slice(2)))
}
main().catch(() => { console.error('Finding context audit failed'); process.exitCode = 1 })
