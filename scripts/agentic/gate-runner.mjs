import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MANIFEST_PATH = path.join(here, 'manifest.v1.json')
export const GATE_MODES = Object.freeze(['synthetic', 'real'])
const checkOutcome = Symbol('agentic-gate-check-outcome')

export const skippedCheck = (reason) => ({ [checkOutcome]: 'skipped', reason: String(reason) })
export const unknownCheck = (reason) => ({ [checkOutcome]: 'unknown', reason: String(reason) })

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sha256NormalizedText = (value) => sha256(Buffer.from(value.toString('utf8').replaceAll('\r\n', '\n'), 'utf8'))

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value))
}

export function validateManifest(manifest) {
  const problems = []
  if (manifest?.manifestVersion !== 1) problems.push('manifestVersion must be 1')
  if (!/^[0-9a-f]{40}$/.test(manifest?.baselineSourceCommit ?? '')) problems.push('baselineSourceCommit must be a full commit hash')
  if (!manifest?.modules || typeof manifest.modules !== 'object') problems.push('modules are required')
  for (const [moduleId, definition] of Object.entries(manifest?.modules ?? {})) {
    if (!/^M\d{2}$/.test(moduleId)) problems.push(`invalid module id: ${moduleId}`)
    if (!Array.isArray(definition.requiredCheckIds) || definition.requiredCheckIds.length === 0) {
      problems.push(`${moduleId}: requiredCheckIds must be a non-empty array`)
    } else if (new Set(definition.requiredCheckIds).size !== definition.requiredCheckIds.length) {
      problems.push(`${moduleId}: requiredCheckIds contain duplicates`)
    }
    if (!Array.isArray(definition.requiredMetricIds)) problems.push(`${moduleId}: requiredMetricIds must be an array`)
    for (const asset of definition.assets ?? []) {
      if (asset.status === 'not-materialized' && asset.sha256 !== null) {
        problems.push(`${moduleId}/${asset.id}: missing asset must have null SHA256`)
      }
      if (asset.path && !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) problems.push(`${moduleId}/${asset.id}: path asset needs a SHA256`)
    }
  }
  return problems
}

async function sourceTreeHash(sourceRoot) {
  const root = await realpath(sourceRoot)
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024
  }).toString('utf8').split('\0').filter(Boolean)
    .filter((file) => !file.replaceAll('\\', '/').startsWith('.validation/agentic/'))
    .sort((a, b) => a.localeCompare(b, 'en'))
  const digest = createHash('sha256')
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/')
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('unsafe source path')
    let cursor = root
    for (const component of relative.split(path.sep)) {
      cursor = path.join(cursor, component)
      const stats = await lstat(cursor)
      if (stats.isSymbolicLink() || ((stats.attributes ?? 0) & 0x400) !== 0) throw new Error('source path contains a link')
    }
    const contents = await readFile(absolute)
    digest.update(Buffer.from(`${Buffer.byteLength(normalized)}:`))
    digest.update(normalized)
    digest.update(Buffer.from(`${contents.byteLength}:`))
    digest.update(contents)
  }
  return digest.digest('hex')
}

async function verifyAssets(definition, sourceRoot) {
  const missing = []
  const mismatched = []
  let root
  try {
    root = await realpath(sourceRoot)
  } catch {
    return { missing: (definition?.assets ?? []).map((asset) => asset.id), mismatched: (definition?.assets ?? []).filter((asset) => asset.path).map((asset) => asset.id) }
  }
  for (const asset of definition?.assets ?? []) {
    if (asset.status !== 'available') missing.push(asset.id)
    if (!asset.path) continue
    try {
      if (path.isAbsolute(asset.path)) throw new Error('absolute asset path')
      const absolute = path.resolve(root, asset.path)
      const relative = path.relative(root, absolute)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('asset path escapes source root')
      let cursor = root
      for (const component of relative.split(path.sep)) {
        cursor = path.join(cursor, component)
        const stats = await lstat(cursor)
        if (stats.isSymbolicLink() || ((stats.attributes ?? 0) & 0x400) !== 0) throw new Error('asset path contains a link')
      }
      const actual = sha256NormalizedText(await readFile(absolute))
      if (actual !== asset.sha256) mismatched.push(asset.id)
    } catch {
      mismatched.push(asset.id)
    }
  }
  return { missing, mismatched }
}

function normalizeChecks(checks) {
  if (checks instanceof Map) return [...checks.entries()]
  if (Array.isArray(checks)) return checks
  if (checks && typeof checks === 'object') return Object.entries(checks)
  return []
}

function resultSummary(report) {
  return {
    module: report.module,
    status: report.status,
    failed: report.counts.failed,
    missing: report.counts.missing,
    skipped: report.counts.skipped,
    unknown: report.counts.unknown,
    report: report.reportPath
  }
}

async function writeExclusive(filePath, content) {
  const file = await open(filePath, 'wx')
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

/**
 * A check is passed only when its registered function actually runs to completion.
 * Its return value is recorded as measurement data; fields such as `status: pass`
 * are never consulted. Throw/reject to fail an assertion. Every required check
 * must be registered and every callback must be a function.
 */
export async function runGate({
  module: moduleId,
  mode = 'synthetic',
  manifest,
  manifestPath = DEFAULT_MANIFEST_PATH,
  checks,
  sourceRoot = process.cwd(),
  outRoot = path.join(sourceRoot, '.validation', 'agentic'),
  authorization = null,
  expectedHashes = null,
  manifestLockPath = path.join(path.dirname(manifestPath), 'manifest.lock.json'),
  printSummary = false
}) {
  const rawManifest = manifest === undefined ? await readFile(manifestPath) : null
  const frozenManifest = manifest ?? JSON.parse(rawManifest.toString('utf8'))
  let effectiveExpectedHashes = expectedHashes ?? {}
  let lockError = null
  if (manifest === undefined) {
    try {
      const lock = JSON.parse(await readFile(manifestLockPath, 'utf8'))
      if (lock.baselineSourceCommit !== frozenManifest.baselineSourceCommit) throw new Error('invalid lock')
      effectiveExpectedHashes = { ...effectiveExpectedHashes, ...lock.hashes, manifestSha256: lock.manifestSha256 }
    } catch {
      lockError = 'MANIFEST_LOCK_UNAVAILABLE_OR_INVALID'
    }
  }
  const malformed = validateManifest(frozenManifest)
  const definition = frozenManifest.modules?.[moduleId]
  const safeModuleId = /^M\d{2}$/.test(moduleId ?? '') ? moduleId : null
  const validMode = GATE_MODES.includes(mode)
  const checkEntries = normalizeChecks(checks)
  const byId = new Map()
  const duplicateIds = []
  for (const [id, implementation] of checkEntries) {
    if (byId.has(id)) duplicateIds.push(id)
    else byId.set(id, implementation)
  }
  const required = definition?.requiredCheckIds ?? []
  const requiredSet = new Set(required)
  const missingIds = required.filter((id) => !byId.has(id))
  const unknownIds = [...byId.keys()].filter((id) => !requiredSet.has(id))
  const invalidImplementations = [...byId.entries()].filter(([id, fn]) => requiredSet.has(id) && typeof fn !== 'function').map(([id]) => id)

  let hashes
  let hashError = null
  const assetVerification = await verifyAssets(definition, sourceRoot)
  try {
    hashes = {
      sourceSha256: await sourceTreeHash(sourceRoot),
      configurationSha256: sha256(canonicalJson(frozenManifest.configuration)),
      dataSha256: sha256(canonicalJson(Object.fromEntries(Object.entries(frozenManifest.modules ?? {}).map(([key, value]) => [key, value.assets ?? []])))),
      schemaSha256: sha256(canonicalJson(frozenManifest.schema ?? null)),
      manifestSha256: rawManifest ? sha256NormalizedText(rawManifest) : sha256(canonicalJson(frozenManifest))
    }
  } catch (error) {
    hashError = 'SOURCE_FINGERPRINT_UNAVAILABLE'
    hashes = { sourceSha256: null, configurationSha256: sha256(canonicalJson(frozenManifest.configuration ?? null)), dataSha256: null, schemaSha256: sha256(canonicalJson(frozenManifest.schema ?? null)), manifestSha256: rawManifest ? sha256NormalizedText(rawManifest) : null }
  }

  const checkResults = []
  const metrics = {}
  const rawReferences = []
  let failed = 0
  const isRealOnly = (frozenManifest.realOnlyModules ?? []).includes(moduleId)
  const realAuthorized = authorization?.authorized === true && typeof authorization.reference === 'string' && authorization.reference.trim().length > 0
  const blockedReal = validMode && mode === 'real' && isRealOnly && !realAuthorized
  let activeCheckId = null

  const ctx = Object.freeze({
    module: safeModuleId,
    mode,
    manifest: frozenManifest,
    definition,
    hashes,
    recordMetric(id, value, rawReference = null) {
      if (!definition?.requiredMetricIds?.includes(id)) throw new Error(`Metric is not declared by frozen manifest: ${id}`)
      if (Object.hasOwn(metrics, id)) throw new Error(`Metric recorded more than once: ${id}`)
      if (typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) throw new Error('METRIC_MUST_BE_BOOLEAN_OR_FINITE_NUMBER')
      metrics[id] = value
      if (rawReference !== null) {
        if (typeof rawReference !== 'string' || rawReference.length === 0) throw new Error('rawReference must be a non-empty string')
        rawReferences.push({ checkId: activeCheckId, kind: 'measurement', metricId: id, reference: rawReference })
      }
    },
    addRawReference(reference, kind = 'assertion-output') {
      if (typeof reference !== 'string' || reference.length === 0) throw new Error('raw reference must be a non-empty string')
      rawReferences.push({ checkId: activeCheckId, kind, reference })
    }
  })

  if (definition && !blockedReal && !hashError) {
    for (const id of required) {
      const implementation = byId.get(id)
      if (typeof implementation !== 'function') continue
      activeCheckId = id
      const firstReferenceIndex = rawReferences.length
      try {
        const measurement = await implementation(ctx)
        if (measurement?.[checkOutcome] === 'skipped' || measurement?.[checkOutcome] === 'unknown') {
          checkResults.push({ id, status: measurement[checkOutcome], errorCode: measurement[checkOutcome] === 'skipped' ? 'CHECK_SKIPPED' : 'CHECK_RESULT_UNKNOWN', rawReferences: rawReferences.slice(firstReferenceIndex) })
        } else if (measurement && typeof measurement === 'object' && Object.hasOwn(measurement, 'status')) {
          throw new Error('CHECKER_RETURNED_STATUS')
        } else {
          checkResults.push({ id, status: 'pass', measurement: measurement === undefined ? null : measurement, rawReferences: rawReferences.slice(firstReferenceIndex) })
        }
      } catch (error) {
        failed += 1
        checkResults.push({ id, status: 'failed', errorCode: error?.message === 'CHECKER_RETURNED_STATUS' ? 'CHECKER_RETURNED_STATUS' : 'ASSERTION_FAILED', rawReferences: rawReferences.slice(firstReferenceIndex) })
      }
      activeCheckId = null
    }
  }

  if (!hashError && hashes.sourceSha256) {
    try {
      const endingSourceHash = await sourceTreeHash(sourceRoot)
      if (endingSourceHash !== hashes.sourceSha256) {
        failed += 1
        checkResults.push({ id: 'hash:source-stability', status: 'failed', errorCode: 'SOURCE_CHANGED_DURING_GATE' })
      }
    } catch {
      failed += 1
      checkResults.push({ id: 'hash:source-stability', status: 'failed', errorCode: 'SOURCE_FINGERPRINT_UNAVAILABLE' })
    }
  }

  for (const id of invalidImplementations) {
    checkResults.push({ id, status: 'unknown', errorCode: 'CHECKER_NOT_FUNCTION' })
  }
  for (const id of duplicateIds) {
    checkResults.push({ id, status: 'unknown', errorCode: 'DUPLICATE_CHECKER_ID' })
  }
  for (const id of unknownIds) {
    checkResults.push({ id, status: 'unknown', errorCode: 'UNKNOWN_CHECKER_ID' })
  }
  for (const id of missingIds) checkResults.push({ id, status: 'missing' })
  if (malformed.length) {
    failed += 1
    checkResults.push({ id: 'manifest:validation', status: 'failed', errorCode: 'INVALID_FROZEN_MANIFEST' })
  }
  if (!validMode) {
    failed += 1
    checkResults.push({ id: 'runner:mode', status: 'failed', errorCode: 'INVALID_MODE' })
  }
  if (!definition) {
    failed += 1
    checkResults.push({ id: 'runner:module', status: 'failed', errorCode: 'UNKNOWN_MODULE' })
  }
  if (hashError) {
    failed += 1
    checkResults.push({ id: 'hash:source', status: 'failed', errorCode: hashError })
  }
  if (lockError) {
    failed += 1
    checkResults.push({ id: 'manifest:lock', status: 'failed', errorCode: lockError })
  }
  for (const id of assetVerification.mismatched) {
    failed += 1
    checkResults.push({ id: `asset:${id}`, status: 'failed', errorCode: 'ASSET_HASH_MISMATCH' })
  }
  for (const id of assetVerification.missing) {
    checkResults.push({ id: `asset:${id}`, status: 'missing' })
  }
  if (blockedReal) {
    checkResults.push({ id: 'authorization:real-mode', status: 'unknown', errorCode: 'REAL_MODE_NOT_AUTHORIZED' })
  }

  const missingMetrics = (definition?.requiredMetricIds ?? []).filter((id) => !Object.hasOwn(metrics, id))
  for (const id of missingMetrics) checkResults.push({ id: `metric:${id}`, status: 'missing' })
  const skippedChecks = checkResults.filter((item) => item.status === 'skipped').length
  const unknownChecks = checkResults.filter((item) => item.status === 'unknown').length
  const missingChecks = missingIds.length + missingMetrics.length + assetVerification.missing.length
  const hashMismatches = []
  for (const [key, expected] of Object.entries(effectiveExpectedHashes)) {
    if (hashes[key] !== expected) hashMismatches.push({ key, expected, actual: hashes[key] })
  }
  if (hashMismatches.length) {
    failed += hashMismatches.length
    for (const mismatch of hashMismatches) checkResults.push({ id: `hash:${mismatch.key}`, status: 'failed', errorCode: 'HASH_BINDING_MISMATCH', hashKey: mismatch.key, expected: mismatch.expected, actual: mismatch.actual })
  }

  const counts = { failed, missing: missingChecks, skipped: skippedChecks, unknown: unknownChecks }
  const status = blockedReal ? 'blocked' : failed || unknownChecks || skippedChecks ? 'failed' : missingChecks ? 'incomplete' : 'pass'
  const runId = randomUUID()
  const runDirectory = path.join(outRoot, runId)
  await mkdir(runDirectory, { recursive: true })
  const reportPath = path.join(runDirectory, `${safeModuleId ?? 'unknown'}.json`)
  const report = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    module: safeModuleId,
    mode,
    status,
    counts,
    hashes,
    expectedHashes: effectiveExpectedHashes,
    hashMismatches,
    manifest: { version: frozenManifest.manifestVersion, planVersion: frozenManifest.planVersion, baselineSourceCommit: frozenManifest.baselineSourceCommit },
    authorization: mode === 'real' ? { authorized: realAuthorized, reference: realAuthorized ? authorization.reference : null } : null,
    checks: checkResults,
    metrics,
    rawReferences,
    missingMetrics,
    freezeStatus: frozenManifest.freezeStatus,
    reportPath
  }
  await writeExclusive(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const summary = resultSummary(report)
  if (printSummary) process.stdout.write(`${JSON.stringify(summary)}\n`)
  return { ...report, summary }
}

export async function loadDefaultManifest() {
  return JSON.parse(await readFile(DEFAULT_MANIFEST_PATH, 'utf8'))
}
