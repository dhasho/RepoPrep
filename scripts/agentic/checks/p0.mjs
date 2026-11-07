import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDatasetBundle, validateDatasetBundle, createBlindReviewPacket, canonicalJson } from '../dataset-contract.mjs'

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const normalizedHash = bytes => createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex')
const json = async relative => JSON.parse(await readFile(path.join(base, relative), 'utf8'))
const fingerprint = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const scoreKeys = ['relevance', 'mechanismDepth', 'evidenceSpecificity', 'followupProgression']

function assertReview(review, role, bundle, packetHash) {
  assert.equal(review.schemaVersion, 1)
  assert.equal(review.protocol, 'agent-review-v1')
  assert.equal(review.reviewerKind, 'subagent')
  assert.equal(review.model, 'gpt-6-luna')
  assert.equal(review.reviewerId, role.id)
  assert.equal(review.taskName, role.taskName)
  assert.equal(review.inputPacketSha256, packetHash)
  assert.deepEqual(review.isolation, { inheritedImplementationContext: false, authorLabelsProvided: false, otherReviewProvided: false })
  assert.equal(review.samples.length, 80)
  const samples = new Map(bundle.reviewPacket.samples.map(sample => [sample.id, sample]))
  const seen = new Set()
  for (const item of review.samples) {
    const sample = samples.get(item.sampleId)
    assert.ok(sample && !seen.has(item.sampleId))
    seen.add(item.sampleId)
    assert.equal(item.answerFingerprint, sample.answerFingerprint)
    assert.equal(typeof item.materialError, 'boolean')
    assert.ok(typeof item.explanation === 'string' && item.explanation.trim().length >= 10)
    for (const key of scoreKeys) assert.ok(Number.isInteger(item.topicValue?.[key]) && item.topicValue[key] >= 1 && item.topicValue[key] <= 5)
    assert.ok(Array.isArray(item.evidence) && item.evidence.length > 0)
    const project = bundle.projects.projects.find(project => project.id === sample.projectId)
    for (const ref of item.evidence) {
      const file = project.files.find(file => file.path === ref.path)
      assert.ok(file && Number.isInteger(ref.startLine) && Number.isInteger(ref.endLine) && ref.startLine >= 1 && ref.endLine >= ref.startLine && ref.endLine <= file.content.split('\n').length)
    }
  }
}

export function createChecks() {
  let loaded
  const data = () => loaded ??= (async () => {
    const bundle = await loadDatasetBundle(path.join(base, 'datasets', 'v1'))
    const [roles, a, b, adjudication, invocations, packetBytes] = await Promise.all([
      json('reviews/v1/roles.json'), json('reviews/v1/reviewer-a.json'), json('reviews/v1/reviewer-b.json'),
      json('reviews/v1/adjudication.json'), json('reviews/v1/invocations.json'), readFile(path.join(base, 'reviews/v1/blind-packet.json'))
    ])
    return { bundle, roles, a, b, adjudication, invocations, packet: JSON.parse(packetBytes.toString('utf8')), packetHash: normalizedHash(packetBytes) }
  })()
  const metric = (ctx, id, value) => ctx.recordMetric(id, value, `assertion:${ctx.module}:${id}`)
  return new Map([
    ['p0:task-matrix', async ctx => {
      const { bundle } = await data()
      const validation = validateDatasetBundle(bundle)
      assert.equal(validation.valid, true)
      assert.equal(validation.counts.retrievalTasks, 20)
      assert.equal(validation.counts.generationTasks, 12)
      for (const count of Object.values(validation.coverage)) assert.ok(count >= 2)
      metric(ctx, 'taskMatrixComplete', true)
      return { counts: validation.counts, coverage: validation.coverage }
    }],
    ['p0:source-evidence-integrity', async ctx => {
      assert.equal(validateDatasetBundle((await data()).bundle).valid, true)
      metric(ctx, 'sourceEvidenceValid', true)
    }],
    ['p0:review-balance', async ctx => {
      const { bundle, adjudication } = await data()
      assert.equal(bundle.reviewKey.labels.filter(label => label.materialError).length, 40)
      assert.equal(bundle.reviewKey.labels.filter(label => !label.materialError).length, 40)
      assert.equal(adjudication.finalLabels.length, 80)
      assert.equal(adjudication.finalLabels.filter(label => label.materialError).length, 40)
      metric(ctx, 'reviewSamplesBalanced', true)
    }],
    ['p0:repair-independence', async ctx => {
      const { bundle } = await data()
      const existing = new Set(bundle.reviewPacket.samples.map(sample => sample.answerFingerprint))
      assert.equal(bundle.repairSamples.samples.length, 20)
      assert.ok(bundle.repairSamples.samples.every(sample => !existing.has(sample.answerFingerprint)))
      metric(ctx, 'repairSamplesIndependent', true)
    }],
    ['p0:oracle-isolation', async ctx => {
      const { bundle, packet } = await data()
      const publicPacket = createBlindReviewPacket(bundle)
      assert.deepEqual(packet.samples, publicPacket.reviewPacket.samples)
      assert.deepEqual(packet.projects, bundle.projects.projects)
      assert.equal(Object.hasOwn(packet, 'reviewKey'), false)
      assert.equal(Object.hasOwn(packet, 'labels'), false)
      assert.equal(fingerprint(packet.samples), fingerprint(bundle.reviewPacket.samples))
      metric(ctx, 'oracleIsolated', true)
    }],
    ['p0:independent-review-a', async ctx => {
      const { bundle, roles, a, packetHash } = await data()
      assertReview(a, roles.reviewers[0], bundle, packetHash)
      assert.notEqual(roles.reviewers[0].taskName, roles.author.taskName)
      return { reviewedSamples: a.samples.length }
    }],
    ['p0:independent-review-b', async ctx => {
      const { bundle, roles, a, b, packetHash, invocations } = await data()
      assertReview(a, roles.reviewers[0], bundle, packetHash)
      assertReview(b, roles.reviewers[1], bundle, packetHash)
      assert.notEqual(roles.reviewers[1].taskName, roles.reviewers[0].taskName)
      assert.notEqual(roles.reviewers[1].taskName, roles.author.taskName)
      assert.equal(invocations.kind, 'coordinator-observed-collaboration-invocations')
      assert.equal(invocations.observedBy, '/root')
      assert.equal(invocations.invocations.length, 2)
      assert.equal(new Set(invocations.invocations.map(item => item.invocationId)).size, 2)
      for (const [index, invocation] of invocations.invocations.entries()) {
        const role = roles.reviewers[index]
        const outputPath = `scripts/agentic/reviews/v1/reviewer-${index ? 'b' : 'a'}.json`
        assert.equal(invocation.taskName, role.taskName)
        assert.equal(invocation.tool, 'collaboration.spawn_agent')
        assert.equal(invocation.forkTurns, 'none')
        assert.equal(invocation.model, 'gpt-6-luna')
        assert.equal(invocation.inputPacketSha256, packetHash)
        assert.equal(invocation.outputCommit, role.commit)
        assert.match(invocation.integratedCommit, /^[a-f0-9]{40}$/)
        assert.equal(invocation.outputPath, outputPath)
        const committed = execFileSync('git', ['show', `${invocation.integratedCommit}:${outputPath}`], { cwd: base, maxBuffer: 2 * 1024 * 1024 })
        assert.equal(normalizedHash(committed), invocation.outputSha256)
        assert.equal(normalizedHash(await readFile(path.resolve(base, '..', '..', outputPath))), invocation.outputSha256)
      }
      metric(ctx, 'independentReviewers', 2)
    }],
    ['p0:adjudication', async ctx => {
      const { bundle, roles, a, b, adjudication, packetHash } = await data()
      assert.equal(adjudication.protocol, 'agent-review-v1')
      assert.equal(adjudication.reviewerKind, 'subagent')
      assert.equal(adjudication.taskName, roles.adjudicator.taskName)
      assert.notEqual(adjudication.taskName, a.taskName)
      assert.notEqual(adjudication.taskName, b.taskName)
      assert.equal(adjudication.inputPacketSha256, packetHash)
      assert.equal(adjudication.reviewHashes.a, normalizedHash(await readFile(path.join(base, 'reviews/v1/reviewer-a.json'))))
      assert.equal(adjudication.reviewHashes.b, normalizedHash(await readFile(path.join(base, 'reviews/v1/reviewer-b.json'))))
      const aById = new Map(a.samples.map(sample => [sample.sampleId, sample]))
      const bById = new Map(b.samples.map(sample => [sample.sampleId, sample]))
      const expected = new Set(a.samples.filter(item => {
        const peer = bById.get(item.sampleId)
        return item.materialError !== peer.materialError || scoreKeys.some(key => item.topicValue[key] !== peer.topicValue[key])
      }).map(sample => sample.sampleId))
      assert.equal(new Set(adjudication.resolutions.map(item => item.sampleId)).size, expected.size)
      assert.deepEqual([...expected].sort(), adjudication.resolutions.map(item => item.sampleId).sort())
      const finals = new Map(adjudication.finalLabels.map(item => [item.sampleId, item]))
      const resolutions = new Map(adjudication.resolutions.map(item => [item.sampleId, item]))
      assert.equal(finals.size, 80)
      for (const sample of bundle.reviewPacket.samples) {
        const final = finals.get(sample.id)
        assert.ok(final && final.answerFingerprint === sample.answerFingerprint && typeof final.materialError === 'boolean')
        assert.ok(typeof final.reason === 'string' && final.reason.trim().length >= 10)
        for (const key of scoreKeys) assert.ok(Number.isInteger(final.topicValue?.[key]) && final.topicValue[key] >= 1 && final.topicValue[key] <= 5)
        const decision = expected.has(sample.id) ? resolutions.get(sample.id) : aById.get(sample.id)
        assert.equal(final.materialError, decision.materialError)
        assert.deepEqual(final.topicValue, decision.topicValue)
        if (expected.has(sample.id)) assert.ok(typeof decision.reason === 'string' && decision.reason.trim().length >= 10)
        assert.ok(Array.isArray(final.evidence) && final.evidence.length > 0)
        const project = bundle.projects.projects.find(project => project.id === sample.projectId)
        for (const ref of final.evidence) {
          const file = project.files.find(file => file.path === ref.path)
          assert.ok(file && Number.isInteger(ref.startLine) && Number.isInteger(ref.endLine) && ref.startLine >= 1 && ref.endLine >= ref.startLine && ref.endLine <= file.content.split('\n').length)
        }
        if (!expected.has(sample.id)) assert.equal(final.materialError, aById.get(sample.id).materialError)
        assert.equal(final.materialError, bundle.reviewKey.labels.find(label => label.sampleId === sample.id).materialError)
      }
      const audit = adjudication.annotationAudit
      assert.deepEqual(audit.issues, [])
      for (const file of ['projects', 'retrieval-tasks', 'retrieval-labels', 'generation-tasks', 'generation-labels', 'review-key', 'repair-samples', 'repair-key']) {
        assert.equal(audit.inputHashes[file], normalizedHash(await readFile(path.join(base, `datasets/v1/${file}.json`))))
      }
      for (const [name, originals, key, resultKey] of [
        ['retrievalTasks', bundle.retrievalTasks.tasks, 'taskId', 'evidenceSufficient'],
        ['generationTasks', bundle.generationTasks.tasks, 'taskId', 'evidenceSufficient'],
        ['repairSamples', bundle.repairSamples.samples, 'sampleId', 'repairFactsValid']
      ]) {
        assert.deepEqual(audit[name].map(item => item[key]).sort(), originals.map(item => item.id).sort())
        for (const item of audit[name]) {
          assert.equal(item[resultKey], true)
          assert.ok(typeof item.reason === 'string' && item.reason.trim().length >= 10)
          const original = originals.find(original => original.id === item[key])
          const project = bundle.projects.projects.find(project => project.id === original.projectId)
          assert.ok(Array.isArray(item.evidence) && item.evidence.length > 0)
          for (const ref of item.evidence) {
            const file = project.files.find(file => file.path === ref.path)
            assert.ok(file && Number.isInteger(ref.startLine) && Number.isInteger(ref.endLine) && ref.startLine >= 1 && ref.endLine >= ref.startLine && ref.endLine <= file.content.split('\n').length)
          }
        }
      }
      metric(ctx, 'adjudicationComplete', true)
      return { disagreements: expected.size, finalLabels: finals.size }
    }],
    ['p0:holdout-freeze', async ctx => {
      const { validateHoldoutSources } = await import('../holdout-contract.mjs')
      const labels = await json('assets/holdout-labels.v1.json')
      const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: base, encoding: 'utf8' }).trim()
      const primary = path.dirname(path.resolve(base, commonDir))
      const result = await validateHoldoutSources(labels, path.join(primary, '.validation', 'agentic-holdout-sources'))
      assert.equal(result.valid, true)
      assert.equal(result.repositories, 4)
      assert.ok(result.facts >= 48)
      metric(ctx, 'holdoutFrozen', true)
      return { repositories: result.repositories, facts: result.facts }
    }],
    ['p0:review-protocol', async ctx => {
      const { roles } = await data()
      const rubric = await json('assets/review-rubric.v2.json')
      assert.equal(roles.protocol, 'agent-review-v1')
      assert.equal(roles.kind, 'subagent')
      assert.equal(roles.reviewers.length, 2)
      assert.equal(rubric.blindReview.protocol, roles.protocol)
      assert.equal(rubric.blindReview.hideAuthorLabels, true)
      assert.deepEqual(ctx.manifest.configuration.reviewProtocol, {
        version: 1, kind: 'independent-subagent', model: 'gpt-6-luna', reviewers: 2,
        adjudicatorOnDisagreement: true, hideStrategyAndAuthorLabels: true,
        numericThresholdsUnchanged: true, externalModelAuthorizationUnchanged: true
      })
      metric(ctx, 'reviewProtocolBound', true)
    }],
    ['p0:baseline-and-thresholds', async ctx => {
      const original = await json('manifest.v1.json')
      assert.equal(ctx.manifest.baselineSourceCommit, original.baselineSourceCommit)
      assert.deepEqual(ctx.manifest.configuration.quality, original.configuration.quality)
      assert.deepEqual(ctx.manifest.configuration.limits, original.configuration.limits)
      for (const [id, definition] of Object.entries(original.modules)) {
        assert.deepEqual(ctx.manifest.modules[id].limits, definition.limits)
        assert.ok(definition.requiredCheckIds.every(checkId => ctx.manifest.modules[id].requiredCheckIds.includes(checkId)))
        if (definition.requiredSpans) assert.deepEqual(ctx.manifest.modules[id].requiredSpans, definition.requiredSpans)
      }
      metric(ctx, 'thresholdsUnchanged', true)
    }]
  ])
}
