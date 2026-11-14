const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')

const PURPOSE_POLICIES = Object.freeze({
  'm06-retrieval-v1': Object.freeze({
    dataField: 'retrievalDataHash',
    sourceFiles: Object.freeze(['projects.json', 'retrieval-tasks.json', 'retrieval-labels.json']),
    maxRuns: 40,
    maxRequests: 120,
    maxInputTokens: 720_000,
    maxOutputTokensTotal: 240_000,
    perRequestOutputCaps: Object.freeze([2000, 6000]),
    defaultPerRequestOutputTokens: 2000,
    ioErrorCode: 'startup-failed'
  }),
  'm08-generation-v1': Object.freeze({
    dataField: 'generationDataHash',
    sourceFiles: Object.freeze(['projects.json', 'generation-tasks.json', 'generation-labels.json']),
    maxRuns: 48,
    maxRequests: 420,
    maxInputTokens: 6_144_000,
    maxOutputTokensTotal: 3_145_728,
    perRequestOutputCaps: Object.freeze([16_384, 32_768]),
    defaultPerRequestOutputTokens: 32_768,
    requireContextAboveOutputCap: true,
    ioErrorCode: 'authorization-binding-mismatch'
  })
})

const HASH = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const REFERENCE = /^[A-Za-z0-9._:/-]{1,160}$/
const AUTHORIZATION_MAX_BYTES = 16 * 1024
const CLAIM_MAX_BYTES = 4096
const DATA_FILE_MAX_BYTES = 16 * 1024 * 1024
const DATA_TOTAL_MAX_BYTES = 64 * 1024 * 1024

function fail(code) { throw new Error(code) }

function policyFor(purpose) {
  if (typeof purpose !== 'string' || !Object.hasOwn(PURPOSE_POLICIES, purpose)) fail('authorization-invalid')
  return PURPOSE_POLICIES[purpose]
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function hashBytes(value) { return createHash('sha256').update(value).digest('hex') }

function assertNoSymlinkPath(root, target, errorCode, missingErrorCode = errorCode) {
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(errorCode)
  let cursor = root
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    let stat
    try { stat = fs.lstatSync(cursor) } catch { fail(missingErrorCode) }
    if (stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) fail(errorCode)
  }
}

function computeDataHashSync(repoRoot, purpose) {
  const policy = policyFor(purpose)
  let root
  try { root = fs.realpathSync(repoRoot) } catch { fail(policy.ioErrorCode) }
  const dataDir = path.join(root, 'scripts', 'agentic', 'datasets', 'v1')
  assertNoSymlinkPath(root, dataDir, 'authorization-binding-mismatch', policy.ioErrorCode)
  const hashes = {}
  let totalBytes = 0
  for (const name of policy.sourceFiles) {
    const filename = path.join(dataDir, name)
    assertNoSymlinkPath(root, filename, 'authorization-binding-mismatch', policy.ioErrorCode)
    let stat
    try { stat = fs.lstatSync(filename) } catch { fail(policy.ioErrorCode) }
    if (!stat.isFile() || stat.size > DATA_FILE_MAX_BYTES) fail('authorization-binding-mismatch')
    totalBytes += stat.size
    if (totalBytes > DATA_TOTAL_MAX_BYTES) fail('authorization-binding-mismatch')
    hashes[name] = hashBytes(fs.readFileSync(filename))
  }
  return hashBytes(Buffer.from(canonicalJson(hashes), 'utf8'))
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)))
}

function validateAuthorizationRecord(authorization, { purpose, sourceCommit, dataHash }) {
  const policy = policyFor(purpose)
  const dataField = policy.dataField
  const keys = ['purpose', 'reference', 'sourceCommit', dataField, 'endpointFingerprint', 'model', 'protocol', 'temperature', 'reasoningEffort', 'contextWindowTokens', 'maxOutputTokens', 'maxRuns', 'maxRequests', 'maxInputTokens', 'maxOutputTokensTotal']
  if (!exactKeys(authorization, keys)) fail('authorization-invalid')
  if (authorization.purpose !== purpose || typeof authorization.reference !== 'string' || !REFERENCE.test(authorization.reference)) fail('authorization-invalid')
  if (!COMMIT.test(sourceCommit ?? '') || authorization.sourceCommit !== sourceCommit || !HASH.test(dataHash ?? '') || authorization[dataField] !== dataHash) fail('authorization-binding-mismatch')
  if (!HASH.test(authorization.endpointFingerprint ?? '') || typeof authorization.model !== 'string' || !authorization.model || authorization.model.length > 160 || !['openai', 'anthropic'].includes(authorization.protocol) || authorization.temperature !== 0.4 || !(authorization.reasoningEffort === null || ['low', 'high'].includes(authorization.reasoningEffort)) || !Number.isSafeInteger(authorization.contextWindowTokens) || authorization.contextWindowTokens < 4096) fail('authorization-invalid')
  if (!policy.perRequestOutputCaps.includes(authorization.maxOutputTokens) || policy.requireContextAboveOutputCap && authorization.contextWindowTokens <= authorization.maxOutputTokens || authorization.maxRuns !== policy.maxRuns || !Number.isSafeInteger(authorization.maxRequests) || authorization.maxRequests < 1 || authorization.maxRequests > policy.maxRequests || !Number.isSafeInteger(authorization.maxInputTokens) || authorization.maxInputTokens < 1 || authorization.maxInputTokens > policy.maxInputTokens || !Number.isSafeInteger(authorization.maxOutputTokensTotal) || authorization.maxOutputTokensTotal < 1 || authorization.maxOutputTokensTotal > policy.maxOutputTokensTotal) fail('authorization-invalid')
  return authorization
}

function checkAuthorizationSync({ repoRoot, authorizationPath, purpose }) {
  policyFor(purpose)
  if (typeof repoRoot !== 'string' || !repoRoot || typeof authorizationPath !== 'string' || !authorizationPath) fail('authorization-required')
  const policy = policyFor(purpose)
  let root, sourceCommit, dirty
  try {
    root = fs.realpathSync(repoRoot)
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { fail(policy.ioErrorCode) }
  if (!COMMIT.test(sourceCommit) || dirty) fail('authorization-binding-mismatch')
  const dataHash = computeDataHashSync(root, purpose)
  let authStat
  try { authStat = fs.lstatSync(authorizationPath) } catch { fail(policy.ioErrorCode) }
  if (!authStat.isFile() || authStat.isSymbolicLink() || ((authStat.attributes ?? 0) & 0x400) !== 0 || authStat.size > AUTHORIZATION_MAX_BYTES) fail('authorization-invalid')
  let authorization
  try { authorization = JSON.parse(fs.readFileSync(authorizationPath, 'utf8')) } catch { fail(policy.ioErrorCode) }
  validateAuthorizationRecord(authorization, { purpose, sourceCommit, dataHash })
  return Object.freeze({ sourceCommit, dataHash, purpose, reference: authorization.reference, authorization, [policyFor(purpose).dataField]: dataHash })
}

function claimId(binding, purpose) {
  const policy = policyFor(purpose)
  if (!binding || binding.purpose !== purpose || !COMMIT.test(binding.sourceCommit ?? '') || typeof binding.reference !== 'string' || !REFERENCE.test(binding.reference) || !HASH.test(binding[policy.dataField] ?? '')) fail('authorization-binding-mismatch')
  return hashBytes(Buffer.from(`${binding.sourceCommit}\0${purpose}\0${binding.reference}`, 'utf8'))
}

function claimsDirectory(repoRoot, create) {
  let root
  try { root = fs.realpathSync(repoRoot) } catch { fail('claim-path-invalid') }
  let current = root
  for (const part of ['.validation', 'agentic', 'claims']) {
    current = path.join(current, part)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) fail('claim-path-invalid')
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) fail('claim-path-invalid')
      try { fs.mkdirSync(current) } catch { fail('claim-path-invalid') }
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('claim-path-invalid')
    }
  }
  return { root, directory: current }
}

function claimRecord(binding, purpose, id) {
  const policy = policyFor(purpose)
  return {
    schemaVersion: 1,
    claimId: id,
    purpose,
    reference: binding.reference,
    sourceCommit: binding.sourceCommit,
    [policy.dataField]: binding[policy.dataField]
  }
}

function createClaimSync(repoRoot, binding, purpose) {
  const id = claimId(binding, purpose)
  const { directory } = claimsDirectory(repoRoot, true)
  const claimPath = path.join(directory, `${id}.json`)
  let fd
  try { fd = fs.openSync(claimPath, 'wx', 0o600) } catch (error) { if (purpose === 'm06-retrieval-v1') fail('startup-failed'); if (error?.code === 'EEXIST') fail('authorization-claim-invalid'); fail('startup-failed') }
  const record = claimRecord(binding, purpose, id)
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return Object.freeze({ ...record, claimPath })
}

function verifyClaimSync(repoRoot, binding, claimPath, purpose) {
  const id = claimId(binding, purpose)
  const { directory } = claimsDirectory(repoRoot, false)
  const expectedPath = path.join(directory, `${id}.json`)
  if (typeof claimPath !== 'string' || path.resolve(claimPath) !== path.resolve(expectedPath)) fail('authorization-claim-invalid')
  let stat
  try { stat = fs.lstatSync(claimPath) } catch { fail('authorization-claim-invalid') }
  if (!stat.isFile() || stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0 || stat.size > CLAIM_MAX_BYTES) fail('authorization-claim-invalid')
  let record
  try { record = JSON.parse(fs.readFileSync(claimPath, 'utf8')) } catch { fail('authorization-claim-invalid') }
  const expected = claimRecord(binding, purpose, id)
  if (!exactKeys(record, Object.keys(expected)) || Object.keys(expected).some(key => record[key] !== expected[key])) fail('authorization-claim-invalid')
  return Object.freeze({ ...record, claimPath })
}

function existingUnstartedClaimSync(repoRoot, binding, purpose) {
  const claim = verifyClaimSync(repoRoot, binding, path.join(claimsDirectory(repoRoot, false).directory, `${claimId(binding, purpose)}.json`), purpose)
  const startedPath = path.join(path.dirname(claim.claimPath), `${claim.claimId}.started`)
  try { fs.lstatSync(startedPath) } catch (error) {
    if (error?.code === 'ENOENT') return claim
    fail('authorization-claim-invalid')
  }
  fail('authorization-claim-already-started')
}

function beginClaimOnceSync(repoRoot, binding, claimPath, purpose) {
  const claim = verifyClaimSync(repoRoot, binding, claimPath, purpose)
  const markerPath = path.join(path.dirname(claim.claimPath), `${claim.claimId}.started`)
  let fd
  try { fd = fs.openSync(markerPath, 'wx', 0o600) } catch { fail('authorization-claim-already-started') }
  try { fs.writeFileSync(fd, JSON.stringify({ claimId: claim.claimId, state: 'started' })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return claim
}

function verifyStartedClaimSync(repoRoot, binding, claimPath, purpose) {
  const claim = verifyClaimSync(repoRoot, binding, claimPath, purpose)
  const markerPath = path.join(path.dirname(claim.claimPath), `${claim.claimId}.started`)
  let stat, marker
  try { stat = fs.lstatSync(markerPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) fail('authorization-claim-invalid'); marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) } catch (error) { if (error?.message === 'authorization-claim-invalid') throw error; fail('authorization-claim-invalid') }
  if (!exactKeys(marker, ['claimId', 'state']) || marker.claimId !== claim.claimId || marker.state !== 'started') fail('authorization-claim-invalid')
  return claim
}

function normalizeBaseUrl(raw) {
  let base = raw.trim().replace(/\/+$/, '')
  if (!/\/v\d+(\/|$)/.test(base)) base += '/v1'
  return base
}

function assertPublicProfileBinding(profile, authorization) {
  if (!profile || typeof profile !== 'object' || typeof profile.baseUrl !== 'string') fail('profile-binding-mismatch')
  let endpointFingerprint
  try { endpointFingerprint = hashBytes(Buffer.from(normalizeBaseUrl(profile.baseUrl), 'utf8')) } catch { fail('profile-binding-mismatch') }
  if (endpointFingerprint !== authorization.endpointFingerprint || profile.model !== authorization.model || (profile.protocol ?? 'openai') !== authorization.protocol || (profile.temperature ?? 0.4) !== authorization.temperature || (profile.reasoningEffort ?? null) !== authorization.reasoningEffort || profile.contextWindowTokens !== authorization.contextWindowTokens) fail('profile-binding-mismatch')
  return true
}

module.exports = {
  PURPOSE_POLICIES,
  assertPublicProfileBinding,
  beginClaimOnceSync,
  checkAuthorizationSync,
  claimId,
  computeDataHashSync,
  createClaimSync,
  existingUnstartedClaimSync,
  validateAuthorizationRecord,
  verifyClaimSync,
  verifyStartedClaimSync
}
