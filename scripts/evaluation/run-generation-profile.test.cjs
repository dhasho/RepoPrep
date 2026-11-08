const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const { test } = require('node:test')
const startup = require('./run-agentic-profile-startup.cjs')
const launcher = require('./run-generation-profile.cjs')
const { readEncryptedSettings, stageEncryptedSettings } = require('./run-saved-profile.cjs')

const PURPOSE = 'm08-generation-v1'
const syntheticProfile = Object.freeze({
  id: 'native-synthetic-profile', name: 'Native Synthetic', baseUrl: 'https://native.invalid/v1', model: 'native-synthetic-model',
  protocol: 'openai', temperature: 0.4, reasoningEffort: null, contextWindowTokens: 65_536,
  credential: { version: 1, ciphertext: 'NATIVE_SYNTHETIC_CIPHERTEXT_ONLY' }
})
const privateProfile = Object.freeze({ ...syntheticProfile, apiKey: 'NATIVE_SYNTHETIC_PRIVATE_KEY' })
const syntheticLocalState = Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI-native-synthetic-key').toString('base64'), audit_enabled: false, unrelated: 'discarded' } }), 'utf8')
const expectedLocalState = Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI-native-synthetic-key').toString('base64'), audit_enabled: false } }), 'utf8')

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }

function syntheticRepo() {
  const tempBase = path.resolve(__dirname, '..', '..', '.tmp')
  fs.mkdirSync(tempBase, { recursive: true })
  const parent = fs.mkdtempSync(path.join(tempBase, 'repoprep-generation-host-'))
  const root = path.join(parent, 'repo')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, '.gitignore'), '.validation/\n', 'utf8')
  const data = path.join(root, 'scripts', 'agentic', 'datasets', 'v1')
  fs.mkdirSync(data, { recursive: true })
  for (const [name, value] of Object.entries({
    'projects.json': '{"synthetic":"projects"}',
    'generation-tasks.json': '{"synthetic":"tasks"}',
    'generation-labels.json': '{"synthetic":"labels-with-no-gold-data"}'
  })) fs.writeFileSync(path.join(data, name), value, 'utf8')
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', '--local', 'user.name', 'Native Synthetic Test'], { cwd: root })
  execFileSync('git', ['config', '--local', 'user.email', 'native-synthetic@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '.gitignore', 'scripts/agentic/datasets/v1'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'synthetic generation startup fixture'], { cwd: root })
  const authDir = path.join(parent, 'authorization-fixtures')
  fs.mkdirSync(authDir)
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const generationDataHash = startup.computeDataHashSync(root, PURPOSE)
  return {
    parent, root, authDir, sourceCommit, generationDataHash,
    auth(overrides = {}) {
      return {
        purpose: PURPOSE, reference: 'native-synthetic-evaluation', sourceCommit, generationDataHash,
        endpointFingerprint: sha256(Buffer.from('https://native.invalid/v1', 'utf8')),
        model: 'native-synthetic-model', protocol: 'openai', temperature: 0.4, reasoningEffort: null,
        contextWindowTokens: 65_536, maxOutputTokens: 32_768, maxRuns: 48, maxRequests: 420,
        maxInputTokens: 6_144_000, maxOutputTokensTotal: 3_145_728, ...overrides
      }
    },
    authFile(value, filename = 'authorization.json') {
      const full = path.join(authDir, filename)
      fs.writeFileSync(full, JSON.stringify(value), { flag: 'wx' })
      return full
    },
    cleanup() {
      const resolved = path.resolve(parent), relative = path.relative(tempBase, resolved)
      if (!relative.startsWith('repoprep-generation-host-') || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) throw new Error('unsafe-test-cleanup')
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  }
}

function makeSettingsDirectory(parent) {
  const settingsDir = path.join(parent, 'source-user-data')
  fs.mkdirSync(settingsDir)
  const settingsBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, defaultProfileId: syntheticProfile.id, profiles: [syntheticProfile] }), 'utf8')
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), settingsBytes)
  fs.writeFileSync(path.join(settingsDir, 'Local State'), syntheticLocalState)
  return { settingsDir, settingsBytes }
}

let loadedEntry
function generationEntry() {
  if (loadedEntry) return loadedEntry
  const originalLoad = Module._load
  const fakeElectron = { app: { whenReady: async () => {}, setPath() {}, exit() {} } }
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron
    return originalLoad.call(this, request, parent, isMain)
  }
  try { loadedEntry = require('./run-generation-profile-entry.cjs') }
  finally { Module._load = originalLoad }
  return loadedEntry
}

function startupOptions(repo, parent, settingsDir, authorizationPath, credentialPreflight = false) {
  return {
    repoRoot: repo.root,
    runtimeRoot: path.join(parent, credentialPreflight ? 'preflight-runtime' : 'runtime'),
    settingsDir,
    profileId: syntheticProfile.id,
    authorizationPath,
    outputDir: path.join(repo.root, '.validation', 'agentic', credentialPreflight ? 'preflight-output' : 'generation-output'),
    credentialPreflight
  }
}

function dependencies(repoRoot, events, runner, options = {}) {
  return {
    sourceRoot: repoRoot,
    registerHooks: () => events.push('hooks'),
    checkAuthorization: input => { events.push('auth-check'); return startup.checkAuthorizationSync(input) },
    secureRuntime: () => events.push('secure-runtime'),
    readSettings: (...args) => { events.push('read-encrypted-settings'); return readEncryptedSettings(...args) },
    stageSettings: (...args) => { events.push('stage-encrypted-settings'); return stageEncryptedSettings(...args) },
    appApi: { setPath: name => events.push(`setPath:${name}`) },
    appApi: { setPath: name => events.push(`setPath:${name}`) },
    whenReady: async () => { events.push('app-ready') },
    credentialCrypto: { isAvailable: async () => { events.push('native-crypto'); return true } },
    runner,
    store: options.store
  }
}

function fakeRunner(repo, events, store) {
  return {
    checkGenerationAuthorizationArtifact(input) {
      events.push('runner-auth-recheck')
      return startup.checkAuthorizationSync({ ...input, purpose: PURPOSE })
    },
    verifyGenerationProfileBinding(profile, authorization) {
      events.push('profile-binding')
      startup.assertPublicProfileBinding(profile, authorization)
      if (profile.apiKey !== privateProfile.apiKey) throw new Error('profile-binding-mismatch')
      return Object.freeze({ ...profile, maxOutputTokens: authorization.maxOutputTokens })
    },
    async runGenerationEvaluation(input) {
      events.push('generation-runner')
      const binding = startup.checkAuthorizationSync({ repoRoot: repo.root, authorizationPath: input.authorizationPath, purpose: PURPOSE })
      const claim = startup.verifyClaimSync(repo.root, binding, input.claimPath, PURPOSE)
      assert.equal(fs.existsSync(path.join(path.dirname(claim.claimPath), `${claim.claimId}.started`)), false)
      startup.beginClaimOnceSync(repo.root, binding, input.claimPath, PURPOSE)
      events.push('claim-started')
      const profile = await input.readProfile()
      assert.equal(profile.apiKey, privateProfile.apiKey)
      const temporary = this.verifyGenerationProfileBinding(profile, binding.authorization)
      assert.equal(temporary.maxOutputTokens, binding.authorization.maxOutputTokens)
      return { mode: 'real', executionComplete: true, status: 'awaiting-review', reviewState: 'independent-quality-review-pending', qualityGate: 'not-evaluated' }
    }
  }
}

test('native entry stages encrypted data and four Electron paths before first await, then starts claim before private read', async t => {
  const repo = syntheticRepo()
  t.after(repo.cleanup)
  const { settingsDir, settingsBytes } = makeSettingsDirectory(repo.parent)
  const authorizationPath = repo.authFile(repo.auth())
  const runtimeRoot = path.join(repo.parent, 'runtime')
  fs.mkdirSync(runtimeRoot)
  const events = []
  const fakeStore = { async getPrivateProfile(profileId) { events.push('decrypt-profile'); assert.equal(profileId, syntheticProfile.id); return privateProfile } }
  const runner = fakeRunner(repo, events, fakeStore)
  const deps = dependencies(repo.root, events, runner, { store: fakeStore })
  const options = startupOptions(repo, repo.parent, settingsDir, authorizationPath)
  const output = await generationEntry().main(options, deps)
  assert.equal(output.status, 'awaiting-review')
  assert.deepEqual(events.slice(0, 3), ['hooks', 'auth-check', 'secure-runtime'])
  const pathIndexes = ['appData', 'sessionData', 'logs', 'userData'].map(name => events.indexOf(`setPath:${name}`))
  assert.ok(pathIndexes.every(index => index >= 0))
  assert.ok(Math.max(...pathIndexes) < events.indexOf('app-ready'))
  assert.ok(events.indexOf('app-ready') < events.indexOf('native-crypto'))
  assert.ok(events.indexOf('runner-auth-recheck') < events.indexOf('generation-runner'))
  assert.ok(events.indexOf('claim-started') < events.indexOf('decrypt-profile'))
  assert.ok(events.indexOf('stage-encrypted-settings') < events.indexOf('app-ready'))
  const claim = startup.checkAuthorizationSync({ repoRoot: repo.root, authorizationPath, purpose: PURPOSE })
  const claimId = startup.claimId(claim, PURPOSE)
  assert.equal(fs.existsSync(path.join(repo.root, '.validation', 'agentic', 'claims', `${claimId}.started`)), true)
  const stagedSettings = fs.readFileSync(path.join(options.runtimeRoot, 'isolated-user-data', 'settings.json'))
  assert.deepEqual(stagedSettings, settingsBytes)
  assert.deepEqual(fs.readFileSync(path.join(options.runtimeRoot, 'isolated-user-data', 'Local State')), expectedLocalState)
  assert.equal(fs.readFileSync(path.join(settingsDir, 'settings.json')).includes(Buffer.from(privateProfile.apiKey)), false)
})

test('credential preflight requires an existing unstarted claim and never starts it or invokes evaluation', async t => {
  const repo = syntheticRepo()
  t.after(repo.cleanup)
  const { settingsDir } = makeSettingsDirectory(repo.parent)
  const authorizationPath = repo.authFile(repo.auth())
  const binding = startup.checkAuthorizationSync({ repoRoot: repo.root, authorizationPath, purpose: PURPOSE })
  const claim = startup.createClaimSync(repo.root, binding, PURPOSE)
  const events = []
  const fakeStore = { async getPrivateProfile() { events.push('decrypt-profile'); return privateProfile } }
  const runner = fakeRunner(repo, events, fakeStore)
  let evaluations = 0
  runner.runGenerationEvaluation = async () => { evaluations++; throw new Error('must-not-run') }
  const options = startupOptions(repo, repo.parent, settingsDir, authorizationPath, true)
  fs.mkdirSync(options.runtimeRoot)
  const result = await generationEntry().main(options, dependencies(repo.root, events, runner, { store: fakeStore }))
  assert.equal(result, null)
  assert.equal(evaluations, 0)
  assert.equal(fs.existsSync(path.join(path.dirname(claim.claimPath), `${claim.claimId}.started`)), false)
  assert.equal(fs.readFileSync(path.join(options.runtimeRoot, 'credential-preflight-verdict.json'), 'utf8'), JSON.stringify({ decrypted: true }))
})

test('invalid purpose, data binding, source binding, or budget blocks M08 before settings or decryption', async t => {
  const repo = syntheticRepo()
  t.after(repo.cleanup)
  const { settingsDir } = makeSettingsDirectory(repo.parent)
  const invalidAuths = [
    repo.auth({ purpose: 'm06-retrieval-v1' }),
    repo.auth({ generationDataHash: 'a'.repeat(64) }),
    repo.auth({ sourceCommit: 'b'.repeat(40) }),
    repo.auth({ maxRequests: 421 })
  ]
  for (const [index, auth] of invalidAuths.entries()) {
    const authorizationPath = repo.authFile(auth, `invalid-${index}.json`)
    const events = []
    const fakeStore = { async getPrivateProfile() { events.push('decrypt-profile'); return privateProfile } }
    const options = startupOptions(repo, repo.parent, settingsDir, authorizationPath)
    await assert.rejects(generationEntry().main(options, dependencies(repo.root, events, fakeRunner(repo, events, fakeStore), { store: fakeStore })), (error) => error.message === 'authorization-invalid' || error.message === 'authorization-binding-mismatch')
    assert.equal(events.includes('read-encrypted-settings'), false)
    assert.equal(events.includes('secure-runtime'), false)
    assert.equal(events.some(event => event.startsWith('setPath:')), false)
    assert.equal(events.includes('decrypt-profile'), false)
  }
})

test('launcher enforces the checkout/output boundary and reports only full execution after child close', async t => {
  const repo = syntheticRepo()
  t.after(repo.cleanup)
  const settingsDir = path.join(repo.parent, 'source-user-data')
  fs.mkdirSync(settingsDir)
  const authorizationPath = repo.authFile(repo.auth())
  const outputDir = path.join(repo.root, '.validation', 'agentic', 'generation-launch-output')
  const options = { repoRoot: repo.root, settingsDir, authorizationPath, outputDir, profileId: '' , credentialPreflight: false }
  assert.throws(() => launcher.preflight(options, path.join(repo.root, 'other-checkout')), /authorization-binding-mismatch/u)
  assert.throws(() => launcher.preflight({ ...options, outputDir: path.join(repo.parent, 'outside') }, repo.root), /output-path-invalid/u)
  const nestedSettings = path.join(repo.root, '.validation', 'agentic', 'generation-launch-output', 'settings')
  assert.throws(() => launcher.preflight({ ...options, settingsDir: nestedSettings }, repo.root), /path-overlap/u)

  const oldExitCode = process.exitCode
  let seenSpawnOptions, seenRuntimeRoot
  const fakeReport = { mode: 'real', executionComplete: true, status: 'awaiting-review', reviewState: 'independent-quality-review-pending', qualityGate: 'not-evaluated' }
  const exitCode = await launcher.launch(options, {
    actualCheckoutRoot: repo.root,
    secureTemporaryDirectory: () => true,
    safeEnv: () => ({ PATH: 'synthetic-path', SYSTEMROOT: 'synthetic-root' }),
    build: async configuration => { fs.writeFileSync(configuration.outfile, 'synthetic bundle') },
    electronPath: 'synthetic-electron',
    spawn: (_electron, args, spawnOptions) => {
      seenSpawnOptions = spawnOptions
      seenRuntimeRoot = path.dirname(args[0])
      const child = new EventEmitter()
      child.pid = 123
      child.exitCode = null
      child.kill = () => { child.exitCode = 1; child.emit('close', 1, null) }
      setImmediate(() => {
        fs.mkdirSync(outputDir)
        fs.writeFileSync(path.join(outputDir, 'generation-evaluation.json'), JSON.stringify(fakeReport))
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    }
  })
  assert.equal(exitCode, 0)
  assert.equal(seenSpawnOptions.windowsHide, true)
  assert.equal(seenSpawnOptions.env.NODE_OPTIONS, '--experimental-strip-types')
  assert.equal(seenSpawnOptions.env.NATIVE_SYNTHETIC_PRIVATE_KEY, undefined)
  assert.equal(fs.existsSync(seenRuntimeRoot), false)
  process.exitCode = oldExitCode
})

test('launcher rejects a partial or gate-shaped report even when the child exits zero', async t => {
  const repo = syntheticRepo()
  t.after(repo.cleanup)
  const settingsDir = path.join(repo.parent, 'source-user-data')
  fs.mkdirSync(settingsDir)
  const authorizationPath = repo.authFile(repo.auth())
  const outputDir = path.join(repo.root, '.validation', 'agentic', 'generation-incomplete-output')
  const options = { repoRoot: repo.root, settingsDir, authorizationPath, outputDir, profileId: '', credentialPreflight: false }
  const oldExitCode = process.exitCode
  await assert.rejects(launcher.launch(options, {
    actualCheckoutRoot: repo.root,
    secureTemporaryDirectory: () => true,
    safeEnv: () => ({ PATH: 'synthetic-path' }),
    build: async configuration => { fs.writeFileSync(configuration.outfile, 'synthetic bundle') },
    electronPath: 'synthetic-electron',
    spawn: (_electron, args) => {
      const child = new EventEmitter()
      child.pid = 456
      child.exitCode = null
      child.kill = () => { child.exitCode = 1; child.emit('close', 1, null) }
      setImmediate(() => {
        fs.mkdirSync(outputDir)
        fs.writeFileSync(path.join(outputDir, 'generation-evaluation.json'), JSON.stringify({ mode: 'real', executionComplete: false, status: 'awaiting-review', reviewState: 'independent-quality-review-pending', qualityGate: 'pass' }))
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    }
  }), /generation-evaluation-incomplete/u)
  assert.equal(process.exitCode, 1)
  process.exitCode = oldExitCode
})
