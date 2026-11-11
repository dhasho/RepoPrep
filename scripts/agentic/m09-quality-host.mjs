import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { lstat } from 'node:fs/promises'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  SEMANTIC_NATIVE_COLLABORATION_V2, createSemanticJudgeInput,
  createSemanticAdjudicatorInput, freezeSemanticScoringProjection,
  parseSemanticJsonBytes, semanticCanonicalJson, semanticJsonBytes,
  semanticSha256, validateSemanticJudgments
} from './semantic-review.mjs'
import { createSemanticScoringOnlyAdapter } from './semantic-review-score.mjs'
import { claimM09NativeBridge } from './m09-native-collaboration.mjs'
import { loadM09ScopedManifest } from './m09-manifest.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OPTIONS = Object.freeze({ invocationProtocol: SEMANTIC_NATIVE_COLLABORATION_V2 })
const sessions = new WeakMap(); const gatePermits = new WeakMap()
const fail = code => { throw new Error(code) }
const equal = (left, right) => semanticCanonicalJson(left) === semanticCanonicalJson(right)
const immutable = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) immutable(item); Object.freeze(value) } return value }
function fields(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value'))) fail('M09_HOST_CONFIGURATION_INVALID')
}
function realExecution(value) {
  if (!value || value.mode !== 'real' || value.nativeProvenance !== 'parent-observed-native-close' || value.executionComplete !== true || value.cases !== 100 || value.quality !== 'not-evaluated' || value.accounting?.unknownRequests !== 0) fail('M09_REAL_EXECUTION_REQUIRED')
}

/** E1 validates receipts, journals, manifests, plans and byte bindings first.
 * This adds the original time/request/token limits without trusting E2 quality.
 * No grading keys are accessed by this budget pass.
 */
async function originalBudgets(contract, launch, checked) {
  const report = contract.parseSemanticJson(await contract.readSemanticFile(launch.outputDirectory, 'execution.json'))
  const cases = []
  for (const entry of report.cases) cases.push(contract.parseSemanticJson(await contract.readSemanticFile(launch.outputDirectory, entry.file)))
  return measureM09ExecutionBudgets(cases, checked.accounting, contract.semanticBudgets())
}

/** Pure post-E1 arithmetic. It grants no live execution or same-host authority. */
export function measureM09ExecutionBudgets(cases, checkedAccounting, limits) {
  const totals = { requests: 0, inputAdmission: 0, outputReservation: 0, actualInputTokens: 0, actualOutputTokens: 0, unknownRequests: 0 }
  let reviews = 0; let repairs = 0
  if (!Array.isArray(cases) || cases.length !== 100 || !limits?.aggregate || !limits.original) fail('M09_BUDGET_ACCOUNTING_INVALID')
  for (const value of cases) {
    const ledger = value.ledger; const policy = limits[value.kind]
    if (!policy || !ledger || !value.spec || !['review', 'repair'].includes(value.kind) || !Array.isArray(value.requests)) fail('M09_BUDGET_RECEIPTS_REQUIRED')
    if (value.kind === 'review') reviews++; else repairs++
    const requestCap = value.spec.granularity === 'fine' ? limits.original.fineRequests : value.spec.granularity === 'coarse' ? limits.original.coarseRequests : 0
    if (!requestCap || !Number.isFinite(ledger.elapsedMs) || ledger.elapsedMs < 0 || ledger.elapsedMs > limits.original.wallClockMs || !ledger.usageComplete || ledger.blocked || !ledger.overspend || Object.values(ledger.overspend).some(number => number !== 0) || ledger.metrics?.unknownUsageTreatedAsZero !== 0 || value.requests.length > Math.min(requestCap, policy.maxRequests)) fail('M09_ORIGINAL_BUDGET_EXCEEDED')
    let admitted = 0; let reserved = 0; let input = 0; let output = 0
    for (const request of value.requests) {
      if (request.state !== 'known' || request.ledger?.state !== 'settled' || !request.guardIntent || !request.fetchFence || !request.transportComplete || !request.usage || !['inputAdmission', 'outputReservation'].every(key => Number.isSafeInteger(request[key]) && request[key] >= 0) || !Number.isSafeInteger(request.usage.inputTokens) || !Number.isSafeInteger(request.usage.outputTokens) || request.usage.inputTokens < 0 || request.usage.outputTokens < 0 || request.usage.inputTokens > request.inputAdmission || request.usage.outputTokens > request.outputReservation) fail('M09_BUDGET_RECEIPTS_REQUIRED')
      admitted += request.inputAdmission; reserved += request.outputReservation; input += request.usage.inputTokens; output += request.usage.outputTokens
    }
    if (admitted > policy.inputAdmission || reserved > policy.outputReservation || input > limits.original.inputTokens || output > limits.original.outputTokens) fail('M09_ORIGINAL_BUDGET_EXCEEDED')
    totals.requests += value.requests.length; totals.inputAdmission += admitted; totals.outputReservation += reserved; totals.actualInputTokens += input; totals.actualOutputTokens += output
  }
  if (reviews !== 80 || repairs !== 20 || !equal(totals, checkedAccounting) || totals.requests > limits.aggregate.maxRequests || totals.inputAdmission > limits.aggregate.inputAdmission || totals.outputReservation > limits.aggregate.outputReservation) fail('M09_BUDGET_ACCOUNTING_INVALID')
  return immutable({ compliant: true, cases: 100, reviews: 80, repairs: 20, accounting: totals, limits: structuredClone(limits) })
}

/** All authority callbacks below are private closures built from canonical E3b.
 * The exported synthetic driver uses the phases but is never in sessions.
 */
function phases(capabilities, nativeBridge, privateKeyBindings, normalizedPrivateKeyHashes, synthetic) {
  let phase = 'configured'; let busy = false; let stoppedFlag = false; let adapter; let executionHandle; let judgmentHandle
  let executionBytes; let projection; let packets; let judgmentBytes; let quality; let budget; let verifiedExecution; let publicationUsed = false
  const diagnostics = []; let transport; let api
  const stopped = code => {
    stoppedFlag = true
    if (phase !== 'failed') { phase = 'failed'; diagnostics.push(Object.freeze({ code, at: new Date().toISOString() })); transport?.stop() }
  }
  const transition = next => { if (stoppedFlag) fail('M09_SESSION_FAILED'); phase = next }
  const requirePhase = expected => { if (stoppedFlag || phase !== expected || busy) fail('M09_PHASE_INVALID') }
  const action = (expected, operation) => async () => {
    try { requirePhase(expected); busy = true; const result = await operation(); if (stoppedFlag) fail('M09_SESSION_FAILED'); return result }
    catch (error) { const code = /^M09_[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'M09_SESSION_VERIFICATION_FAILED'; stopped(code); throw new Error(code) }
    finally { busy = false }
  }
  const reverifyExecution = async () => {
    const result = await capabilities.reverify(Buffer.from(executionBytes))
    if (!equal(result.projection, projection) || !equal(result.execution, verifiedExecution) || !equal(result.budget, budget)) fail('M09_EXECUTION_CHANGED')
    return result
  }
  const reverifyJudgments = async () => {
    transport.assertComplete()
    const document = parseSemanticJsonBytes(judgmentBytes)
    const invocations = []
    const inputs = await import('./semantic-review.mjs').then(module => module.semanticInvocationInputs(packets.publicPackets, document.submissions, OPTIONS))
    for (const submission of document.submissions) invocations.push(transport.verifyInvocation({ role: submission.role, inputBytes: inputs[submission.role], outputBytes: Buffer.from(submission.output, 'utf8') }))
    const result = validateSemanticJudgments(projection, packets, judgmentBytes, invocations, OPTIONS)
    if (quality && result.judgmentsHash !== quality.judgmentsHash) fail('M09_JUDGMENTS_CHANGED')
    return result
  }
  try {
    transport = claimM09NativeBridge(nativeBridge, () => stopped('M09_NATIVE_OBSERVATION_INVALID'))
    adapter = createSemanticScoringOnlyAdapter({
      invocationProtocol: SEMANTIC_NATIVE_COLLABORATION_V2, privateKeyBindings, normalizedPrivateKeyHashes,
      verifyExecutionFreeze: async bytes => { if (!bytes.equals(executionBytes)) fail('M09_EXECUTION_CHANGED'); return (await reverifyExecution()).projection },
      verifyJudgeInvocation: observation => transport.verifyInvocation(observation)
    })
  } catch { stopped('M09_HOST_CONFIGURATION_INVALID'); throw new Error('M09_HOST_CONFIGURATION_INVALID') }
  api = Object.freeze({
    snapshot() { return immutable({ kind: synthetic ? 'synthetic-m09-session' : 'same-host-m09-session', phase, diagnostics: [...diagnostics], nativeObservations: transport.audit(), executionHash: projection?.executionHash ?? null, judgmentsHash: quality?.judgmentsHash ?? null }) },
    execute: action('configured', async () => {
      transition('executing')
      const launched = await capabilities.execute()
      if (stoppedFlag) fail('M09_SESSION_FAILED')
      executionBytes = Buffer.from(launched.executionBytes)
      projection = freezeSemanticScoringProjection(launched.projection)
      verifiedExecution = immutable(structuredClone(launched.execution)); budget = immutable(structuredClone(launched.budget))
      if (projection.executionHash !== semanticSha256(executionBytes)) fail('M09_EXECUTION_CHANGED')
      executionHandle = await adapter.freezeExecution(Buffer.from(executionBytes)); transition('execution-frozen')
      packets = adapter.buildPackets(executionHandle)
      const bytes = createSemanticJudgeInput(packets.publicPackets, OPTIONS)
      transport.dispatch('A', bytes); transport.dispatch('B', Buffer.from(bytes)); transition('A/B')
      return api.snapshot()
    }),
    adjudicate: action('A/B', async () => {
      await reverifyExecution()
      if (stoppedFlag) fail('M09_SESSION_FAILED')
      const a = transport.output('A'); const b = transport.output('B')
      const input = createSemanticAdjudicatorInput(packets.publicPackets, a, b, OPTIONS)
      transport.dispatch('adjudicator', input); transition('adjudicating')
      return api.snapshot()
    }),
    freezeJudgments: action('adjudicating', async () => {
      await reverifyExecution(); transport.assertComplete()
      if (stoppedFlag) fail('M09_SESSION_FAILED')
      const submissions = ['A', 'B', 'adjudicator'].map(role => ({ role, output: transport.output(role).toString('utf8') }))
      judgmentBytes = semanticJsonBytes({ schemaVersion: 1, submissions })
      judgmentHandle = await adapter.freezeJudgments(executionHandle, packets, judgmentBytes)
      await reverifyJudgments(); transition('judgments-frozen')
      return api.snapshot()
    }),
    score: action('judgments-frozen', async () => {
      await reverifyExecution(); await reverifyJudgments()
      if (stoppedFlag) fail('M09_SESSION_FAILED')
      quality = await adapter.scorePrivateFiles(judgmentHandle)
      if (synthetic) await capabilities.afterPrivateScore?.()
      transition('scored')
      return immutable({ kind: synthetic ? 'synthetic-m09-quality' : 'same-host-m09-quality', quality, budget })
    }),
    gate: action('scored', async () => {
      if (synthetic) {
        if (typeof capabilities.syntheticGate !== 'function') fail('M09_SYNTHETIC_CANNOT_AUTHORIZE')
        // A deterministic async phase seam, never the real gate runner.
        await capabilities.syntheticGate(Object.freeze({ publishReport }))
        transition('gated')
        return immutable({ kind: 'synthetic-m09-gate', status: 'synthetic-complete', formalGate: false })
      }
      await reverifyExecution(); await reverifyJudgments()
      if (stoppedFlag) fail('M09_SESSION_FAILED')
      const result = await capabilities.gate(api)
      if (result.status === 'pass') transition('gated'); else stopped('M09_GATE_NOT_PASSED')
      return result
    }),
    cancel() { stopped('M09_SESSION_CANCELLED'); return api.snapshot() }
  })
  const capture = async () => {
    if (stoppedFlag || !['scored', 'gated'].includes(phase) || synthetic || busy) fail('M09_SAME_HOST_SCORED_SESSION_REQUIRED')
    try { await reverifyExecution(); await reverifyJudgments(); if (stoppedFlag) fail('M09_SESSION_FAILED'); return immutable({ mode: 'real', execution: verifiedExecution, budget, quality }) }
    catch { stopped('M09_SESSION_VERIFICATION_FAILED'); fail('M09_SESSION_VERIFICATION_FAILED') }
  }
  // Gate calls capture while its public action is busy. Only the private
  // canonical gate closure receives this capture function.
  const captureDuringGate = async () => {
    if (stoppedFlag || phase !== 'scored' || synthetic || !busy) fail('M09_SAME_HOST_SCORED_SESSION_REQUIRED')
    await reverifyExecution(); await reverifyJudgments()
    if (stoppedFlag) fail('M09_SESSION_FAILED')
    return immutable({ mode: 'real', execution: verifiedExecution, budget, quality })
  }
  const assertPublicationLive = () => {
    if (stoppedFlag || phase !== 'scored' || !busy) fail('M09_LIVE_SESSION_LOST_BEFORE_PUBLICATION')
    transport.assertComplete()
  }
  // This exact private path is shared with explicitly synthetic phase tests.
  // Only the canonical registry+permit can expose it to the production runner.
  const publishReport = async report => {
    try {
      if (publicationUsed) fail('M09_REPORT_PUBLICATION_REPLAYED')
      publicationUsed = true
      const candidate = structuredClone(report)
      if (candidate.module !== 'M09' || !path.isAbsolute(candidate.reportPath ?? '')) fail('M09_REPORT_PUBLICATION_INVALID')
      if (synthetic) {
        if (candidate.kind !== 'synthetic-m09-gate-report' || candidate.mode !== 'synthetic' || !['synthetic-complete', 'failed', 'incomplete'].includes(candidate.status) || path.basename(candidate.reportPath) !== 'M09.synthetic.json') fail('M09_SYNTHETIC_CANNOT_AUTHORIZE')
        await reverifyExecution(); await reverifyJudgments()
      } else {
        if (candidate.mode !== 'real' || path.basename(candidate.reportPath) !== 'M09.json') fail('M09_REPORT_PUBLICATION_INVALID')
        await captureDuringGate()
      }
      // All async work, including the runner's final source hash/mkdir, is now
      // behind us. The final fence and rename below have no await/event-loop gap.
      assertPublicationLive()
      const directory = path.dirname(candidate.reportPath)
      const identity = lstatSync(directory)
      if (!identity.isDirectory() || identity.isSymbolicLink() || ((identity.attributes ?? 0) & 0x400) !== 0 || existsSync(candidate.reportPath)) fail('M09_REPORT_PUBLICATION_INVALID')
      const unpublished = path.join(directory, `.M09.unpublished-${randomUUID()}.pending`)
      let descriptor
      try {
        descriptor = openSync(unpublished, 'wx', 0o600)
        writeFileSync(descriptor, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
        fsyncSync(descriptor)
      } finally { if (descriptor !== undefined) closeSync(descriptor) }
      const current = lstatSync(directory)
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || existsSync(candidate.reportPath)) fail('M09_REPORT_PUBLICATION_INVALID')
      assertPublicationLive()
      // Atomic formal publication. An IO failure leaves only an explicitly
      // unpublished recovery artifact; it never creates the final report path.
      renameSync(unpublished, candidate.reportPath)
      if (candidate.status === 'pass' || candidate.status === 'synthetic-complete') transition('gated')
      return candidate
    } catch (error) {
      stopped('M09_REPORT_PUBLICATION_FAILED')
      throw new Error(/^M09_[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'M09_REPORT_PUBLICATION_FAILED')
    }
  }
  return { api, capture, captureDuringGate, publishReport, stopped }
}

/** No arbitrary launch, validator, scoring, gate or provider callbacks accepted. */
export async function createM09QualityHost(options) {
  fields(options, ['sourceRoot', 'launchOptions', 'nativeBridge', 'privateKeyBindings'])
  if (path.resolve(options.sourceRoot) !== ROOT || process.versions.electron) fail('M09_CANONICAL_HOST_REQUIRED')
  fields(options.launchOptions, ['repoRoot', 'settingsDirectory', 'profileId', 'reference', 'outputDirectory'])
  if (path.resolve(options.launchOptions.repoRoot) !== ROOT || !path.isAbsolute(options.launchOptions.settingsDirectory) || !path.isAbsolute(options.launchOptions.outputDirectory) || typeof options.launchOptions.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(options.launchOptions.reference)) fail('M09_HOST_CONFIGURATION_INVALID')
  const launchOptions = Object.freeze({ ...options.launchOptions })
  const keyRoot = path.join(ROOT, 'scripts/agentic/datasets/v1')
  if (options.privateKeyBindings?.rootDir !== keyRoot) fail('M09_PRIVATE_KEY_ROOT_INVALID')
  const launcherUrl = pathToFileURL(path.join(ROOT, 'scripts/evaluation/run-semantic-profile.cjs'))
  // Presence is checked before imports, settings access or any paid work.
  try { await lstat(fileURLToPath(launcherUrl)) } catch { fail('M09_CANONICAL_E3B_UNAVAILABLE') }
  const scoped = await loadM09ScopedManifest(ROOT)
  const launcher = (await import(launcherUrl.href)).default
  if (typeof launcher?.launch !== 'function' || typeof launcher?.verifySemanticParentProof !== 'function') fail('M09_CANONICAL_E3B_UNAVAILABLE')
  createRequire(import.meta.url)('../evaluation/run-saved-profile.cjs').registerSharedAliasHooks(ROOT)
  const contract = await import('./semantic-eval-contract.mjs')
  const evaluation = await import('./semantic-eval.mjs')
  const configuredSource = await evaluation.inspectSemanticSource(ROOT)
  let launch; const source = configuredSource; let authorization; let owner
  const reverify = async bytes => {
    if (!launch || !Buffer.from(launch.expectedFreezeBytes).equals(bytes)) fail('M09_LIVE_LAUNCH_REQUIRED')
    if (!equal(await evaluation.inspectSemanticSource(ROOT), source)) fail('M09_SOURCE_CHANGED')
    await loadM09ScopedManifest(ROOT)
    const execution = await contract.validateFrozenSemanticExecution(launch.outputDirectory, { requireReal: true, expectedFreezeBytes: Buffer.from(bytes), nativeParentProof: launch.nativeParentProof })
    realExecution(execution)
    const frozen = contract.parseSemanticJson(bytes)
    if (!equal(frozen.source, source)) fail('M09_SOURCE_CHANGED')
    const actualAuthorization = contract.parseSemanticJson(await contract.readSemanticFile(launch.outputDirectory, 'authorization.json'))
    if (actualAuthorization.mode !== 'real' || actualAuthorization.reference !== launchOptions.reference || !equal(actualAuthorization.source, source) || !equal(actualAuthorization.budgets, contract.semanticBudgets()) || (authorization && !equal(actualAuthorization, authorization))) fail('M09_AUTHORIZATION_INVALID')
    authorization = immutable(structuredClone(actualAuthorization))
    const projection = contract.projectSemanticScoringInputs(execution)
    return { execution, projection, budget: await originalBudgets(contract, launch, execution) }
  }
  const capabilities = {
    async execute() {
      if (!equal(await evaluation.inspectSemanticSource(ROOT), source)) fail('M09_SOURCE_CHANGED')
      await loadM09ScopedManifest(ROOT)
      launch = await launcher.launch(launchOptions)
      if (!launch?.nativeParentProof || !(launch.expectedFreezeBytes instanceof Uint8Array)) fail('M09_LIVE_LAUNCH_REQUIRED')
      realExecution(launch.validation)
      const executionBytes = Buffer.from(launch.expectedFreezeBytes)
      const verified = await reverify(executionBytes)
      if (!equal(launch.validation, verified.execution)) fail('M09_EXECUTION_CHANGED')
      return { executionBytes, ...verified }
    },
    reverify,
    async gate(session) {
      const permit = Object.freeze({}); gatePermits.set(permit, session)
      const { createChecks } = await import('./checks/m09.mjs')
      const { runGate } = await import('./gate-runner.mjs')
      try { return await runGate({ module: 'M09', mode: 'real', sourceRoot: ROOT, manifestPath: scoped.manifestPath, manifestLockPath: scoped.manifestLockPath, checks: createChecks({ qualitySession: session }), authorization: { authorized: true, reference: authorization.reference }, m09Session: session, m09GatePermit: permit }) }
      finally { gatePermits.delete(permit) }
    }
  }
  owner = phases(capabilities, options.nativeBridge, options.privateKeyBindings, scoped.normalizedPrivateKeyHashes, false)
  sessions.set(owner.api, owner)
  return owner.api
}

/** Object identity plus canonical E3b revalidation; JSON/copies/restarts fail. */
export async function captureM09QualitySession(session) {
  const owner = session && sessions.get(session)
  if (!owner) fail('M09_SAME_HOST_SCORED_SESSION_REQUIRED')
  return owner.capture()
}
/** Only host.gate creates a permit. Generic/CLI gate calls cannot import one. */
export async function preflightM09Gate(session, permit) {
  const owner = session && sessions.get(session)
  if (!owner || gatePermits.get(permit) !== session) fail('M09_SAME_HOST_GATE_REQUIRED')
  gatePermits.delete(permit)
  await owner.captureDuringGate()
  return Object.freeze({ publishReport: owner.publishReport })
}
/** The canonical checker may run while the same host owns its gate action. */
export async function captureM09CheckerSession(session) {
  const owner = session && sessions.get(session)
  if (!owner) fail('M09_SAME_HOST_SCORED_SESSION_REQUIRED')
  try { return await owner.capture() } catch (error) {
    if (error.message !== 'M09_SAME_HOST_SCORED_SESSION_REQUIRED') throw error
    return owner.captureDuringGate()
  }
}

/** OFFLINE ONLY. Injected callbacks/projections are deliberately synthetic.
 * The returned object has no production session brand and cannot pass M09.
 */
export function createSyntheticM09QualityDriver({ nativeBridge, privateKeyBindings, execute, reverify, normalizedPrivateKeyHashes, afterPrivateScore, syntheticGate }) {
  if (typeof execute !== 'function' || typeof reverify !== 'function') fail('M09_SYNTHETIC_CALLBACKS_REQUIRED')
  return phases({ execute, reverify, afterPrivateScore, syntheticGate }, nativeBridge, privateKeyBindings, normalizedPrivateKeyHashes, true).api
}
