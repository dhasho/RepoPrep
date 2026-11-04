import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compactRegionDocumentation, formatSourceRegions, sourceRegionCandidates } from '../../electron/services/snippet-selection.ts'
import { redactSensitiveContent } from '../../electron/services/sensitive.ts'
import { dispatchedCandidate, installSyntheticFetch, observeCandidate, parseContextAuditArgs, runContextAudit } from './context-audit.mjs'

const exec = promisify(execFile)
const tempRoot = path.resolve(process.cwd(), '.tmp')

async function assertNoSymlinkTree(directory) {
  const handle = await opendir(directory)
  for await (const entry of handle) {
    const target = path.join(directory, entry.name)
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) throw new Error('refusing fixture cleanup through a link')
    if (stats.isDirectory()) await assertNoSymlinkTree(target)
  }
}

async function removeFixture(base) {
  const relative = path.relative(tempRoot, path.resolve(base))
  if (!relative.startsWith('context-audit-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('refusing cleanup outside context audit fixture root')
  if (await realpath(tempRoot) !== tempRoot || await realpath(base) !== base) throw new Error('refusing fixture cleanup through a reparse point')
  const stats = await lstat(base)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('refusing unsafe fixture cleanup')
  await assertNoSymlinkTree(base)
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function fixture(t) {
  await mkdir(tempRoot, { recursive: true })
  if (await realpath(tempRoot) !== tempRoot) throw new Error('refusing fixtures through a reparse point')
  const base = await mkdtemp(path.join(tempRoot, 'context-audit-'))
  t.after(() => removeFixture(base))
  const reposRoot = path.join(base, 'repos')
  const directory = path.join(reposRoot, 'case')
  await mkdir(path.join(directory, 'src'), { recursive: true })
  const readme = '# Synthetic context audit\nA small synthetic project.\n'
  const source = 'export function visibleBehavior() {\n  const apiKey = "SOURCE_PRIVATE_SENTINEL_CONTEXT_AUDIT"\n  return "source-only detail"\n}\n'
  await writeFile(path.join(directory, 'README.md'), readme)
  await writeFile(path.join(directory, 'src', 'app.ts'), source)
  await exec('git', ['init', '-q'], { cwd: directory })
  await exec('git', ['config', 'user.name', 'Fixture'], { cwd: directory })
  await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: directory })
  await exec('git', ['add', '.'], { cwd: directory })
  await exec('git', ['commit', '-qm', 'synthetic fixture'], { cwd: directory })
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim()
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/context-audit-case'], { cwd: directory })
  const readmeHash = createHash('sha256').update(readme).digest('hex')
  const sourceHash = createHash('sha256').update(source).digest('hex')
  const manifestPath = path.join(base, 'corpus.json')
  const manifest = {
    schemaVersion: 'repoprep-real-corpus-v1', version: 'repoprep-real-corpus-v1', cases: [{
      id: 'case', repository: 'example/context-audit-case', url: 'https://github.com/example/context-audit-case', commit,
      directory: 'case', license: 'MIT', language: 'TypeScript', split: 'development', granularity: 'medium', roleFocus: 'general',
      readme: 'README.md', runtimeDependencies: { count: 0, notes: '' },
      evidenceFiles: [
        { path: 'README.md', sha256: readmeHash },
        { path: 'src/app.ts', sha256: sourceHash }
      ],
      knownFacts: [{
        id: 'visible-behavior', claim: 'GOLD_ONLY_SENTINEL_CONTEXT_AUDIT', keywords: ['GOLD_ONLY_SENTINEL_CONTEXT_AUDIT'],
        evidence: [{ path: 'src/app.ts', startLine: 1, endLine: 4 }],
        interview: { question: 'What behavior is visible?', referenceAnswer: 'GOLD_ONLY_SENTINEL_CONTEXT_AUDIT', followUps: [] }, pitfalls: []
      }],
      forbiddenAssertions: []
    }]
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { base, reposRoot, directory, manifestPath }
}

test('argument parsing accepts repeated cases and rejects duplicate scalar options', () => {
  assert.deepEqual(parseContextAuditArgs(['--repos-root', 'cases', '--output', 'out', '--case', 'mitt', '--case', 'schedule']), {
    cases: ['mitt', 'schedule'], '--repos-root': 'cases', '--output': 'out'
  })
  assert.throws(() => parseContextAuditArgs(['--repos-root', 'a', '--repos-root', 'b', '--output', 'out']))
})

test('synthetic transport denies every non-synthetic origin and restores global fetch', async () => {
  const original = globalThis.fetch
  const restore = installSyntheticFetch([])
  try {
    await assert.rejects(globalThis.fetch('https://example.com'), /blocked non-synthetic/)
    const response = await globalThis.fetch('https://context-audit.invalid/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic' }] })
    })
    assert.equal(response.status, 200)
  } finally { restore() }
  assert.equal(globalThis.fetch, original)
})

test('dispatch source path prevents another file with identical text from counting as evidence', () => {
  const candidate = { start: 0, end: 4, text: 'same', label: 'value', complete: true, priority: 1 }
  const regionMap = new Map([['0:4', candidate]])
  const capture = [{ requestBody: { messages: [{ role: 'user', content: 'same' }] } }]
  const otherPath = [{ sourceSelections: [{ relPath: 'src/other.ts', wholeFile: true, regions: [] }] }]
  assert.equal(dispatchedCandidate(candidate, otherPath, capture, 'src/app.ts', regionMap).state, 'file-not-observed-in-final-request')
  const selectedPath = [{ sourceSelections: [{ relPath: 'src/app.ts', wholeFile: true, regions: [] }] }]
  assert.equal(dispatchedCandidate(candidate, selectedPath, capture, 'src/app.ts', regionMap).state, 'source-region-provided')
})

test('documentation compaction distinguishes excerpt from original and preserves partial status', () => {
  const body = `"""${'A'.repeat(170)}${'B'.repeat(420)}"""`
  const raw = { start: 0, end: body.length, text: body, label: 'doc', complete: false, priority: 1, documentationRanges: [{ start: 3, end: body.length - 3 }] }
  const excerpt = compactRegionDocumentation(raw)
  assert.equal(excerpt.documentationOmitted, true)
  assert.equal(excerpt.complete, false)
  assert.equal(raw.complete, false)
  assert.notEqual(excerpt.text, raw.text)
  assert.match(excerpt.text, /文档其余内容省略/)
  assert.equal(observeCandidate(raw, raw.text).state, 'source-region-provided')
  assert.equal(observeCandidate(raw, formatSourceRegions([excerpt], '.py').replace(/^.*\n/u, '')).state, 'file-provided-region-not-observed')
  const excerptedBody = `（文档节选，原文有省略）\n${excerpt.text}`
  assert.equal(observeCandidate(raw, excerptedBody).state, 'documentation-excerpt-provided')
  const noDocs = compactRegionDocumentation({ ...raw, documentationRanges: undefined })
  assert.equal(noDocs.text, raw.text)
})

test('multiline Python header docstring candidate distinguishes raw and excerpt without upgrading partial', () => {
  const source = `def sample(\n    value\n):\n    """${'😀'.repeat(300)}${' tail'.repeat(100)}\n    documentation\n    """\n    return value\n`
  const candidate = sourceRegionCandidates(source, null, { extension: '.py' }).find(region => region.label === 'sample')
  assert.ok(candidate?.documentationRanges)
  assert.equal(candidate.complete, true)
  const rawBody = formatSourceRegions([candidate], '.py')
  assert.equal(observeCandidate(candidate, rawBody).state, 'source-region-provided')
  const excerpt = compactRegionDocumentation(candidate)
  assert.equal(observeCandidate(candidate, formatSourceRegions([excerpt], '.py')).state, 'documentation-excerpt-provided')
  const partial = { ...candidate, complete: false }
  const partialObservation = observeCandidate(partial, formatSourceRegions([compactRegionDocumentation(partial)], '.py'))
  assert.equal(partialObservation.state, 'documentation-excerpt-provided')
  assert.equal(partialObservation.candidateComplete, false)
})

test('dispatch metadata distinguishes full, excerpted, and partial nested source units', () => {
  const parent = { start: 0, end: 100, text: 'P'.repeat(100), label: 'parent', complete: true, priority: 1 }
  const child = { start: 10, end: 20, text: 'P'.repeat(10), label: 'child', complete: true, priority: 2 }
  const map = new Map([['0:100', parent], ['10:20', child]])
  const captures = [{ requestBody: { messages: [{ role: 'user', content: 'P'.repeat(100) }] } }]
  const dispatch = [{ sourceSelections: [{ relPath: 'src/a.ts', wholeFile: false, regions: [{ start: 0, end: 100, complete: true }] }] }]
  assert.equal(dispatchedCandidate(child, dispatch, captures, 'src/a.ts', map).state, 'source-region-provided')
  const doc = { start: 0, end: 600, text: `"""${'D'.repeat(600)}"""`, label: 'doc', complete: true, priority: 1, documentationRanges: [{ start: 3, end: 603 }] }
  const compact = compactRegionDocumentation(doc)
  const docMap = new Map([['0:600', doc]])
  const docDispatch = [{ sourceSelections: [{ relPath: 'src/doc.py', wholeFile: false, regions: [{ start: 0, end: 600, complete: false, documentationOmitted: true }] }] }]
  const docCapture = [{ requestBody: { messages: [{ role: 'user', content: `（文档节选，原文有省略）\n${compact.text}` }] } }]
  const excerpt = dispatchedCandidate(doc, docDispatch, docCapture, 'src/doc.py', docMap)
  assert.equal(excerpt.state, 'documentation-excerpt-provided')
  assert.equal(excerpt.originalProvided, false)
  const partial = { ...child, complete: false }
  const partialDispatch = [{ sourceSelections: [{ relPath: 'src/a.ts', wholeFile: false, regions: [{ start: 10, end: 20, complete: false }] }] }]
  assert.equal(dispatchedCandidate(partial, partialDispatch, captures, 'src/a.ts', map).state, 'partial-source-region-provided')
})

test('reference protocol rejection writes a static incomplete report and existing output is untouched', async t => {
  const values = await fixture(t)
  const output = path.join(values.base, 'existing')
  await mkdir(output)
  const keepPath = path.join(output, 'keep')
  await writeFile(keepPath, 'keep')
  await assert.rejects(runContextAudit({ reposRoot: values.reposRoot, outputDir: output, testManifestPath: values.manifestPath }), /already exists/)
  assert.equal(await readFile(keepPath, 'utf8'), 'keep')
  const rejected = path.join(values.base, 'rejected')
  await assert.rejects(runContextAudit({ reposRoot: values.reposRoot, outputDir: rejected, testManifestPath: values.manifestPath, referenceReport: { model: 'x', protocol: 'anthropic' } }), /incomplete/)
  const failure = JSON.parse(await readFile(path.join(rejected, 'report.json'), 'utf8'))
  assert.equal(failure.status, 'incomplete')
  assert.deepEqual(failure.failure, { stage: 'configuration', code: 'context_audit_incomplete' })
  assert.equal(failure.networkRequests, 0)
  assert.doesNotMatch(JSON.stringify(failure), /anthropic|model/iu)
})

test('reference token limits honor profile bounds and output must remain below a known context window', async t => {
  const values = await fixture(t)
  const invalid = [
    { contextWindowTokens: 4095 },
    { contextWindowTokens: 4096, maxOutputTokens: 4096 },
    { contextWindowTokens: 1_000_000, maxOutputTokens: 255 },
    { contextWindowTokens: 1_000_000, profileMaxOutputTokens: 393_217 }
  ]
  for (let index = 0; index < invalid.length; index++) {
    const output = path.join(values.base, `invalid-limits-${index}`)
    await assert.rejects(runContextAudit({
      reposRoot: values.reposRoot,
      outputDir: output,
      testManifestPath: values.manifestPath,
      referenceReport: { model: 'synthetic', protocol: 'openai', config: { ...invalid[index] } }
    }), /incomplete/)
    const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'))
    assert.deepEqual(report.failure, { stage: 'configuration', code: 'context_audit_incomplete' })
    assert.equal(report.syntheticCaptures, 0)
  }
})

test('CLI reports damaged reference input without echoing its contents', async t => {
  const values = await fixture(t)
  const referencePath = path.join(values.base, 'broken-reference.json')
  const secret = 'CLI_REFERENCE_SECRET_SENTINEL'
  await writeFile(referencePath, `{"profile":"${secret}"`)
  const script = path.resolve('scripts/evaluation/context-audit.mjs')
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', '--import', './tests/register-shared-alias.mjs', script, '--repos-root', values.reposRoot, '--output', path.join(values.base, 'cli-out'), '--reference-report', referencePath], { cwd: process.cwd() }), error => {
    assert.notEqual(error.code, 0)
    assert.doesNotMatch(error.stderr, new RegExp(secret))
    assert.match(error.stderr, /context audit failed/u)
    return true
  })
})

test('production final request is captured; gold metadata and source text stay out of the report', { timeout: 180_000 }, async t => {
  const values = await fixture(t)
  const bodies = []
  const nativeFetch = globalThis.fetch
  const output = path.join(values.base, 'out')
  const report = await runContextAudit({
    reposRoot: values.reposRoot, outputDir: output, testManifestPath: values.manifestPath, caseIds: ['case'],
    referenceReport: { model: 'reference-model', protocol: 'openai', config: { temperature: 0.2, reasoningEffort: 'low', contextWindowTokens: 64000, maxOutputTokens: 4096 } },
    onCapture: capture => bodies.push(capture.requestBody)
  })
  assert.equal(globalThis.fetch, nativeFetch)
  assert.equal(report.status, 'complete')
  assert.equal(report.mode, 'context-only')
  assert.equal(report.networkRequests, 0)
  assert.ok(report.syntheticCaptures > 0)
  assert.equal(report.actualProviderUsage, null)
  assert.ok(bodies.some(body => body.model && body.messages?.length && body.stream === true))
  assert.ok(bodies.every(body => body.model === 'reference-model' && body.temperature === 0.2 && body.reasoning_effort === 'low' && body.max_tokens === 4096))
  assert.ok(!bodies.some(body => JSON.stringify(body.messages).includes('GOLD_ONLY_SENTINEL_CONTEXT_AUDIT')))
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /GOLD_ONLY_SENTINEL_CONTEXT_AUDIT|SOURCE_PRIVATE_SENTINEL_CONTEXT_AUDIT/u)
  assert.equal(report.cases[0].facts[0].evidence[0].state, 'source-region-provided')
  assert.ok(report.cases[0].sourceUnits.some(unit => unit.path === 'src/app.ts' && unit.state === 'source-region-provided'))
  assert.equal(report.cases[0].dispatchCount, report.cases[0].requestBodyHashes.length)
  assert.equal(Object.values(report.cases[0].sourceUnitStatusCounts).reduce((sum, value) => sum + value, 0), report.cases[0].sourceUnitCount)
  assert.equal(report.cases[0].sourceUnitCount, 2)
  assert.deepEqual(report.cases[0].sourceUnitStatusCounts, { 'source-region-provided': 2 })
  assert.ok(report.cases[0].sourceUnits.every(unit => !['candidateText', 'sourceText', 'rawText', 'excerptText'].some(key => Object.hasOwn(unit, key))))
  assert.ok(report.cases[0].requestBodyHashes.every(value => /^[a-f0-9]{64}$/.test(value)))
  assert.ok(report.sourceHashes['scripts/evaluation/context-audit.mjs'])
  assert.ok(report.cases[0].fixtureHashes['src/app.ts'])
  assert.ok(!Object.keys(report.cases[0]).some(key => ['requestBody', 'messages', 'prompt', 'responseBody', 'apiKey'].includes(key)))
})

test('real-report null output cap is provider-default and hashes like an explicit undefined cap', { timeout: 180_000 }, async t => {
  const values = await fixture(t)
  const captures = []
  const baseReference = {
    model: 'deepseek-v4-flash', protocol: 'openai',
    config: { reasoningEffort: 'low', temperature: 0.4, contextWindowTokens: 1_000_000, maxOutputTokens: null, profileMaxOutputTokens: null }
  }
  const first = await runContextAudit({
    reposRoot: values.reposRoot, outputDir: path.join(values.base, 'provider-default'),
    testManifestPath: values.manifestPath, referenceReport: baseReference,
    onCapture: capture => captures.push(capture.requestBody)
  })
  const second = await runContextAudit({
    reposRoot: values.reposRoot, outputDir: path.join(values.base, 'provider-default-undefined'),
    testManifestPath: values.manifestPath,
    referenceReport: { ...baseReference, config: { ...baseReference.config, maxOutputTokens: undefined, profileMaxOutputTokens: undefined } }
  })
  assert.equal(first.status, 'complete')
  assert.equal(first.configuration.maxOutputTokens, null)
  assert.equal(first.configuration.profileMaxOutputTokens, null)
  assert.equal(first.configuration.contextWindowTokens, 1_000_000)
  assert.ok(captures.length > 0)
  assert.ok(captures.every(body => body.model === 'deepseek-v4-flash' && body.reasoning_effort === 'low' && !Object.hasOwn(body, 'max_tokens')))
  assert.deepEqual(first.cases[0].requestBodyHashes, second.cases[0].requestBodyHashes)
  assert.equal(first.networkRequests, 0)
})

test('sensitive content is redacted before candidate matching', () => {
  const value = redactSensitiveContent('const apiKey = "sensitive-marker"')
  assert.doesNotMatch(value.content, /sensitive-marker/)
  assert.match(value.content, /REDACTED/)
  const candidate = { start: 0, end: value.content.length, text: value.content, label: 'config', complete: false, priority: 1 }
  const matched = observeCandidate(candidate, value.content)
  assert.equal(matched.state, 'source-region-provided')
  assert.equal(matched.originalProvided, true)
  assert.equal(JSON.stringify(matched).includes('sensitive-marker'), false)
})
