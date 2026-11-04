import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compactRegionDocumentation, formatSourceRegions, sourceRegionCandidates } from '../../electron/services/snippet-selection.ts'
import { redactSensitiveContent } from '../../electron/services/sensitive.ts'
import { installSyntheticFetch, observeCandidate, parseContextAuditArgs, runContextAudit } from './context-audit.mjs'

const workspace = path.resolve(process.cwd(), '..', '..', '..', 'RepoPrep-Eval-Cases')

test('argument parsing accepts repeated cases and rejects duplicate scalar options', () => {
  assert.deepEqual(parseContextAuditArgs(['--repos-root', 'cases', '--output', 'out', '--case', 'mitt', '--case', 'schedule']), {
    cases: ['mitt', 'schedule'], '--repos-root': 'cases', '--output': 'out'
  })
  assert.throws(() => parseContextAuditArgs(['--repos-root', 'a', '--repos-root', 'b', '--output', 'out']))
})

test('synthetic transport denies any non-synthetic origin and restores global fetch', async () => {
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

test('documentation compaction distinguishes excerpt from raw text and preserves partial status', () => {
  const body = `"""${'A'.repeat(170)}${'B'.repeat(420)}"""`
  const raw = { start: 0, end: body.length, text: body, label: 'doc', complete: false, priority: 1, documentationRanges: [{ start: 3, end: body.length - 3 }] }
  const excerpt = compactRegionDocumentation(raw)
  assert.equal(excerpt.documentationOmitted, true)
  assert.equal(excerpt.complete, false)
  assert.equal(raw.complete, false)
  assert.notEqual(excerpt.text, raw.text)
  assert.match(excerpt.text, /文档其余内容省略/)
  const noDocs = compactRegionDocumentation({ ...raw, documentationRanges: undefined })
  assert.equal(noDocs.text, raw.text)
})

test('multiline Python header docstring candidate distinguishes raw and excerpt evidence without upgrading partial', () => {
  const source = `def sample(\n    value\n):\n    """${'😀'.repeat(300)}${' tail'.repeat(100)}\n    documentation\n    """\n    return value\n`
  const candidate = sourceRegionCandidates(source, null, { extension: '.py' }).find(region => region.label === 'sample')
  assert.ok(candidate?.documentationRanges, JSON.stringify(sourceRegionCandidates(source, null, { extension: '.py' }).map(region => ({ label: region.label, complete: region.complete, text: region.text.slice(0, 90), ranges: region.documentationRanges }))))
  assert.equal(candidate.complete, true)
  const rawBody = formatSourceRegions([candidate], '.py')
  assert.equal(observeCandidate(candidate, [rawBody], '.py').state, 'source-region-provided')
  const excerpt = compactRegionDocumentation(candidate)
  assert.equal(observeCandidate(candidate, [formatSourceRegions([excerpt], '.py')], '.py').state, 'documentation-excerpt-provided')
  const partial = { ...candidate, complete: false }
  const partialObservation = observeCandidate(partial, [formatSourceRegions([compactRegionDocumentation(partial)], '.py')], '.py')
  assert.equal(partialObservation.state, 'documentation-excerpt-provided')
  assert.equal(partialObservation.candidateComplete, false)
})

test('reference report must be OpenAI and existing output is never overwritten', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'context-audit-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const existing = path.join(temp, 'existing')
  const reportPath = path.join(existing, 'report.json')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(existing)
  await writeFile(reportPath, 'keep')
  await assert.rejects(runContextAudit({ reposRoot: workspace, outputDir: existing }), /already exists/)
  assert.equal(await readFile(reportPath, 'utf8'), 'keep')
  const rejected = path.join(temp, 'rejected')
  await assert.rejects(runContextAudit({ reposRoot: workspace, outputDir: rejected, referenceReport: { model: 'x', protocol: 'anthropic' } }), /incomplete/)
  const failure = JSON.parse(await readFile(path.join(rejected, 'report.json'), 'utf8'))
  assert.equal(failure.status, 'incomplete')
  assert.equal(failure.networkRequests, 0)
})

test('production final request is captured with synthetic response; gold answers stay out of request', { timeout: 180_000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'context-audit-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const bodies = []
  const nativeFetch = globalThis.fetch
  const report = await runContextAudit({ reposRoot: workspace, outputDir: path.join(temp, 'out'), caseIds: ['mitt'], referenceReport: { model: 'reference-model', protocol: 'openai', config: { temperature: 0.2, reasoningEffort: 'low', contextWindowTokens: 64000, maxOutputTokens: 4096 } }, onCapture: capture => bodies.push(capture.requestBody) })
  assert.equal(globalThis.fetch, nativeFetch)
  assert.equal(report.status, 'complete')
  assert.equal(report.mode, 'context-only')
  assert.equal(report.networkRequests, 0)
  assert.ok(report.syntheticCaptures > 0)
  assert.equal(report.actualProviderUsage, null)
  assert.ok(bodies.some(body => body.model && body.messages?.length && body.stream === true))
  assert.ok(bodies.every(body => body.model === 'reference-model' && body.temperature === 0.2 && body.reasoning_effort === 'low' && body.max_tokens === 4096))
  const manifest = JSON.parse(await readFile(new URL('./real-corpus/corpus.json', import.meta.url), 'utf8'))
  for (const fact of manifest.cases.find(item => item.id === 'mitt').knownFacts) {
    assert.ok(!bodies.some(body => JSON.stringify(body.messages).includes(fact.interview.referenceAnswer)))
    assert.ok(!bodies.some(body => JSON.stringify(body.messages).includes(JSON.stringify(fact.keywords))))
  }
  assert.ok(report.cases[0].evidence.every(item => !Object.hasOwn(item, 'referenceAnswer') && !Object.hasOwn(item, 'keywords')))
  assert.ok(report.cases[0].requestBodyHashes.every(value => /^[a-f0-9]{64}$/.test(value)))
  assert.ok(report.sourceHashes['scripts/evaluation/context-audit.mjs'])
  assert.ok(report.cases[0].fixtureHashes['src/index.ts'])
  const saved = JSON.parse(await readFile(path.join(temp, 'out', 'report.json'), 'utf8'))
  const keys = value => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keys(item)]) : []
  assert.ok(!keys(saved).some(key => ['requestBody', 'messages', 'prompt', 'responseBody', 'apiKey'].includes(key)))
  assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC_ONLY/u)
})

test('redaction occurs before source matching', () => {
  const value = redactSensitiveContent('const apiKey = "sensitive-marker"')
  assert.doesNotMatch(value.content, /sensitive-marker/)
  assert.match(value.content, /REDACTED/)
  const candidate = { start: 0, end: value.content.length, text: value.content, label: 'config', complete: false, priority: 1 }
  const matched = observeCandidate(candidate, [formatSourceRegions([candidate], '.js')], '.js')
  assert.equal(matched.state, 'source-region-provided')
  assert.doesNotMatch(matched.candidateText, /sensitive-marker/)
  assert.equal(observeCandidate(candidate, [formatSourceRegions([{ ...candidate, text: 'const apiKey = "sensitive-marker"' }], '.js')], '.js').state, 'file-provided-region-not-observed')
})
