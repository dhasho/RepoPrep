const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const Module = require('node:module')
const { test } = require('node:test')
const startup = require('./run-agentic-profile-startup.cjs')
const { readEncryptedSettings, stageEncryptedSettings } = require('./run-saved-profile.cjs')

const M06 = 'm06-retrieval-v1'
const M08 = 'm08-generation-v1'
const settingsProfile = Object.freeze({
  id: 'synthetic-profile', name: 'Synthetic', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
  protocol: 'openai', temperature: 0.4, reasoningEffort: null, contextWindowTokens: 65_536,
  credential: { version: 1, ciphertext: 'SYNTHETIC_CIPHERTEXT_ONLY' }
})
const syntheticLocalState = Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI-synthetic-encrypted-key').toString('base64'), audit_enabled: true, discard_me: 'synthetic' } }), 'utf8')
const safeStagedLocalState = Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI-synthetic-encrypted-key').toString('base64'), audit_enabled: true } }), 'utf8')

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function hashEvidenceRange(content, startLine, endLine) {
  return sha256(Buffer.from(content.split('\n').slice(startLine - 1, endLine).join('\n'), 'utf8'))
}
function sourceCommit(root) { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }

async function syntheticRepo() {
  const tempBase = path.resolve(__dirname, '..', '..', '.tmp')
  fs.mkdirSync(tempBase, { recursive: true })
  const parent = fs.mkdtempSync(path.join(tempBase, 'repoprep-agentic-startup-'))
  const root = path.join(parent, 'repo')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, '.gitignore'), '.validation/\n', 'utf8')
  const data = path.join(root, 'scripts', 'agentic', 'datasets', 'v1')
  fs.mkdirSync(data, { recursive: true })
  const projectDocuments = makeGenerationDocuments()
  const bytes = {
    'projects.json': Buffer.from(JSON.stringify(projectDocuments.projects), 'utf8'),
    'generation-tasks.json': Buffer.from(JSON.stringify(projectDocuments.tasks), 'utf8'),
    'generation-labels.json': Buffer.from(JSON.stringify(projectDocuments.labels), 'utf8'),
    'retrieval-tasks.json': Buffer.from('{"synthetic":"retrieval"}', 'utf8'),
    'retrieval-labels.json': Buffer.from('{"synthetic":"labels"}', 'utf8')
  }
  for (const [name, value] of Object.entries(bytes)) fs.writeFileSync(path.join(data, name), value)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', '--local', 'user.name', 'Synthetic Startup Test'], { cwd: root })
  execFileSync('git', ['config', '--local', 'user.email', 'synthetic-startup@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '.gitignore', 'scripts/agentic/datasets/v1'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'synthetic datasets'], { cwd: root })
  const authDir = path.join(parent, 'authorization-fixtures')
  fs.mkdirSync(authDir)
  return {
    parent, root, authDir, bytes, projectDocuments,
    commit: sourceCommit(root),
    hash(purpose) { return startup.computeDataHashSync(root, purpose) },
    writeAuthorization(auth, name = 'authorization.json') {
      const filename = path.join(authDir, name)
      fs.writeFileSync(filename, JSON.stringify(auth), { flag: 'wx' })
      return filename
    },
    cleanup() {
      const root = path.resolve(parent), relative = path.relative(tempBase, root)
      if (!relative.startsWith('repoprep-agentic-startup-') || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) throw new Error('unsafe-test-cleanup')
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

function makeGenerationDocuments() {
  const languages = ['Python', 'JavaScript', 'TypeScript']
  const projects = languages.map((language, index) => {
    const id = `synthetic-project-${index}`
    const content = `synthetic ${language} fixture\n`
    const fileHash = sha256(Buffer.from(content, 'utf8'))
    const files = [{ path: 'src/fixture.txt', content, sha256: fileHash }]
    const summary = { id, language, files: files.map(({ path: relative, sha256: hash }) => ({ path: relative, sha256: hash })) }
    return { id, language, sourceKind: 'authored-fixture', files, contentSha256: sha256(Buffer.from(canonicalJson(summary), 'utf8')) }
  })
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: `synthetic-task-${index}`,
    projectId: projects[Math.floor(index / 4)].id,
    objective: `Inspect synthetic implementation dimension ${index}`,
    roleFocus: 'general',
    granularity: index < 7 ? 'medium' : 'fine',
    topic: `Synthetic topic ${index}`
  }))
  const labels = tasks.map((task, index) => ({
    taskId: task.id,
    evidence: [{ path: 'src/fixture.txt', startLine: 1, endLine: 1, sha256: sha256(Buffer.from(`synthetic ${languages[Math.floor(index / 4)]} fixture`, 'utf8')) }],
    expectedFacts: [],
    pitfalls: []
  }))
  return {
    projects: { schemaVersion: 1, split: 'development-synthetic', projects },
    tasks: { schemaVersion: 1, tasks },
    labels: { schemaVersion: 1, labels }
  }
}

function endpointFingerprint() { return sha256(Buffer.from('https://synthetic.invalid/v1', 'utf8')) }

function authorization(purpose, sourceCommit, dataHash, outputCap = purpose === M06 ? 2000 : 32768) {
  const generation = purpose === M08
  return {
    purpose,
    reference: generation ? 'synthetic-m08-reference' : 'synthetic-m06-reference',
    sourceCommit,
    [generation ? 'generationDataHash' : 'retrievalDataHash']: dataHash,
    endpointFingerprint: endpointFingerprint(),
    model: 'synthetic-model',
    protocol: 'openai',
    temperature: 0.4,
    reasoningEffort: null,
    contextWindowTokens: 65_536,
    maxOutputTokens: outputCap,
    maxRuns: generation ? 48 : 40,
    maxRequests: generation ? 420 : 120,
    maxInputTokens: generation ? 6_144_000 : 720_000,
    maxOutputTokensTotal: generation ? 3_145_728 : 240_000
  }
}

function installSyntheticElectron() {
  const originalLoad = Module._load
  const paths = []
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { setPath: (name, value) => { paths.push([name, value]) }, exit() {} } }
    return originalLoad.call(this, request, parent, isMain)
  }
  try { return { entry: require('./run-retrieval-profile-entry.cjs'), paths } }
  finally { Module._load = originalLoad }
}

function makeEncryptedSettings() {
  return Buffer.from(JSON.stringify({ schemaVersion: 2, defaultProfileId: settingsProfile.id, profiles: [settingsProfile] }), 'utf8')
}

test('closed startup policies retain M06 caps and admit only the fixed M08 limits', async t => {
  const repo = await syntheticRepo()
  t.after(repo.cleanup)
  const { validateGenerationAuthorization, projectGenerationData } = await import('../../scripts/agentic/generation-eval-contract.mjs')
  const fileHashes = Object.fromEntries(['projects.json', 'generation-tasks.json', 'generation-labels.json'].map(name => [name, sha256(repo.bytes[name])]))
  const bundle = projectGenerationData({
    projectsDocument: repo.projectDocuments.projects,
    generationTasksDocument: repo.projectDocuments.tasks,
    generationLabelsDocument: repo.projectDocuments.labels,
    sourceHashes: fileHashes
  })
  const expectedM08Hash = bundle.generationDataHash
  assert.equal(expectedM08Hash, repo.hash(M08))
  const expectedM06Hash = repo.hash(M06)
  const m06Expected = { sourceCommit: repo.commit, dataHash: expectedM06Hash }
  const m08Expected = { sourceCommit: repo.commit, dataHash: expectedM08Hash }

  for (const cap of [2000, 6000]) {
    const auth = authorization(M06, repo.commit, expectedM06Hash, cap)
    assert.equal(startup.validateAuthorizationRecord(auth, { ...m06Expected, purpose: M06 }), auth)
  }
  for (const cap of [16_384, 32_768]) {
    const auth = authorization(M08, repo.commit, expectedM08Hash, cap)
    assert.equal(startup.validateAuthorizationRecord(auth, { ...m08Expected, purpose: M08 }), auth)
    assert.equal(validateGenerationAuthorization(auth, { bundle, sourceCommit: repo.commit, generationDataHash: expectedM08Hash }), auth)
  }

  assert.throws(() => startup.validateAuthorizationRecord(authorization(M06, repo.commit, expectedM06Hash, 32_768), { ...m06Expected, purpose: M06 }), /authorization-invalid/u)
  assert.throws(() => startup.validateAuthorizationRecord(authorization(M08, repo.commit, expectedM08Hash, 6000), { ...m08Expected, purpose: M08 }), /authorization-invalid/u)
  assert.throws(() => startup.validateAuthorizationRecord(authorization(M08, repo.commit, expectedM08Hash, 32_768), { ...m06Expected, purpose: M06 }), /authorization-invalid|authorization-binding-mismatch/u)
  assert.throws(() => startup.validateAuthorizationRecord(authorization(M08, repo.commit, 'a'.repeat(64)), { ...m08Expected, purpose: M08 }), /authorization-binding-mismatch/u)

  const tooSmallContext = authorization(M08, repo.commit, expectedM08Hash, 32_768)
  tooSmallContext.contextWindowTokens = 32_768
  assert.throws(() => startup.validateAuthorizationRecord(tooSmallContext, { ...m08Expected, purpose: M08 }), /authorization-invalid/u)
})

test('synchronous authorization preflight binds each purpose to its own three source hashes', async t => {
  const repo = await syntheticRepo()
  t.after(repo.cleanup)
  for (const purpose of [M06, M08]) {
    const field = purpose === M06 ? 'retrievalDataHash' : 'generationDataHash'
    const auth = authorization(purpose, repo.commit, repo.hash(purpose))
    const authorizationPath = repo.writeAuthorization(auth, `${purpose}.json`)
    const binding = startup.checkAuthorizationSync({ repoRoot: repo.root, authorizationPath, purpose })
    assert.equal(binding.sourceCommit, repo.commit)
    assert.equal(binding.dataHash, auth[field])
    assert.equal(binding[field], auth[field])
    assert.equal(binding.purpose, purpose)
  }
  const m06AuthPath = path.join(repo.authDir, `${M06}.json`)
  assert.throws(() => startup.checkAuthorizationSync({ repoRoot: repo.root, authorizationPath: m06AuthPath, purpose: M08 }), /authorization-binding-mismatch|authorization-invalid/u)
})

test('M06 claim ID and JSON bytes remain byte-for-byte stable; M08 uses an independent field and one-shot claim', async t => {
  const repo = await syntheticRepo()
  t.after(repo.cleanup)
  const m06DataHash = repo.hash(M06)
  const m06AuthorizationPath = repo.writeAuthorization(authorization(M06, repo.commit, m06DataHash), 'claim-m06.json')
  const m06Binding = startup.checkAuthorizationSync({ repoRoot: repo.root, authorizationPath: m06AuthorizationPath, purpose: M06 })
  const m06Claim = startup.createClaimSync(repo.root, m06Binding, M06)
  const expectedM06ClaimId = sha256(Buffer.from(`${repo.commit}\0${M06}\0${m06Binding.reference}`, 'utf8'))
  assert.equal(m06Claim.claimId, expectedM06ClaimId)
  const legacyM06Record = { schemaVersion: 1, claimId: expectedM06ClaimId, purpose: M06, reference: m06Binding.reference, sourceCommit: repo.commit, retrievalDataHash: m06DataHash }
  assert.deepEqual(fs.readFileSync(m06Claim.claimPath), Buffer.from(JSON.stringify(legacyM06Record), 'utf8'))

  const m08DataHash = repo.hash(M08)
  const m08AuthorizationPath = repo.writeAuthorization(authorization(M08, repo.commit, m08DataHash), 'claim-m08.json')
  const m08Binding = startup.checkAuthorizationSync({ repoRoot: repo.root, authorizationPath: m08AuthorizationPath, purpose: M08 })
  const m08Claim = startup.createClaimSync(repo.root, m08Binding, M08)
  assert.notEqual(m08Claim.claimId, m06Claim.claimId)
  const m08Record = JSON.parse(fs.readFileSync(m08Claim.claimPath, 'utf8'))
  assert.deepEqual(Object.keys(m08Record), ['schemaVersion', 'claimId', 'purpose', 'reference', 'sourceCommit', 'generationDataHash'])
  assert.equal(m08Record.generationDataHash, m08DataHash)
  assert.equal(startup.verifyClaimSync(repo.root, m08Binding, m08Claim.claimPath, M08).claimId, m08Claim.claimId)
  assert.equal(startup.existingUnstartedClaimSync(repo.root, m08Binding, M08).claimId, m08Claim.claimId)
  startup.beginClaimOnceSync(repo.root, m08Binding, m08Claim.claimPath, M08)
  assert.equal(startup.verifyStartedClaimSync(repo.root, m08Binding, m08Claim.claimPath, M08).claimId, m08Claim.claimId)
  assert.throws(() => startup.beginClaimOnceSync(repo.root, m08Binding, m08Claim.claimPath, M08), /authorization-claim-already-started/u)
  assert.throws(() => startup.existingUnstartedClaimSync(repo.root, m08Binding, M08), /authorization-claim-already-started/u)
})

test('M06 synchronous startup keeps auth, claim, encrypted staging, then four path writes in order', async t => {
  const repo = await syntheticRepo()
  t.after(repo.cleanup)
  const sourceUserData = path.join(repo.parent, 'source-user-data')
  const runtimeRoot = path.join(repo.parent, 'runtime')
  fs.mkdirSync(sourceUserData)
  fs.mkdirSync(runtimeRoot)
  const settingsBytes = makeEncryptedSettings()
  fs.writeFileSync(path.join(sourceUserData, 'settings.json'), settingsBytes)
  fs.writeFileSync(path.join(sourceUserData, 'Local State'), syntheticLocalState)
  const auth = authorization(M06, repo.commit, repo.hash(M06))
  const authorizationPath = repo.writeAuthorization(auth, 'm06-entry.json')
  const { entry, paths } = installSyntheticElectron()
  const events = []
  const appApi = { setPath(name, value) { events.push(`setPath:${name}`); paths.push([name, value]) } }
  const result = entry.prepareStartupSynchronously({
    runtimeRoot, repoRoot: repo.root, settingsDir: sourceUserData, profileId: settingsProfile.id,
    authorizationPath, outputDir: path.join(repo.parent, 'output'), credentialPreflight: false
  }, {
    setStage: stage => events.push(`stage:${stage}`),
    registerHooks: () => events.push('register-hooks'),
    secureRuntime: () => events.push('secure-runtime'),
    readSettings: (...args) => { events.push('read-encrypted-settings'); return readEncryptedSettings(...args) },
    stageSettings: (...args) => { events.push('stage-encrypted-settings'); return stageEncryptedSettings(...args) },
    appApi
  })
  assert.equal(result.profileId, settingsProfile.id)
  assert.deepEqual(events.slice(0, 5), ['stage:authorization', 'register-hooks', 'stage:claim', 'stage:private-runtime', 'secure-runtime'])
  assert.ok(events.indexOf('stage:saved-public-profile') < events.indexOf('read-encrypted-settings'))
  assert.ok(events.indexOf('stage:settings-staging') < events.indexOf('stage-encrypted-settings'))
  assert.deepEqual(paths.slice(-4).map(([name]) => name), ['appData', 'sessionData', 'logs', 'userData'])
  assert.deepEqual(fs.readFileSync(path.join(result.isolated, 'settings.json')), settingsBytes)
  assert.deepEqual(fs.readFileSync(path.join(result.isolated, 'Local State')), safeStagedLocalState)
  assert.deepEqual(fs.readFileSync(path.join(sourceUserData, 'settings.json')), settingsBytes)
  assert.equal(settingsBytes.includes(Buffer.from('SYNTHETIC_PLAINTEXT_KEY')), false)
})
