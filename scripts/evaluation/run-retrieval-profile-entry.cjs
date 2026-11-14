const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { stageEncryptedSettings, readEncryptedSettings, registerSharedAliasHooks } = require('./run-saved-profile.cjs')
const startupPolicy = require('./run-agentic-profile-startup.cjs')

const STARTUP_STAGES = Object.freeze(['authorization', 'claim', 'private-runtime', 'saved-public-profile', 'settings-staging', 'electron-paths', 'app-ready', 'credential-store', 'profile-decrypt', 'profile-binding', 'evaluation'])
const SAFE_ERRORS = new Set([
  'authorization-required', 'authorization-invalid', 'authorization-binding-mismatch', 'authorization-claim-invalid', 'authorization-claim-already-started',
  'private-runtime-unavailable', 'settings-directory-unavailable', 'settings-file-unavailable', 'settings-invalid', 'settings-schema-unsupported',
  'settings-plaintext-credential-refused', 'settings-default-profile-missing', 'settings-profile-missing', 'settings-encrypted-credential-missing',
  'settings-profile-invalid', 'os-crypt-state-unavailable', 'os-crypt-state-invalid', 'os-crypt-app-bound-unsupported',
  'profile-binding-mismatch', 'credential-store-unavailable', 'saved-profile-unavailable', 'profile-unavailable', 'profile-decrypt-failed',
  'unsafe-directory', 'unsafe-runtime-path', 'claim-path-invalid', 'evaluation-startup-failed', 'retrieval-evaluation-incomplete'
])

function staticErrorCode(error) {
  const code = error instanceof Error ? error.message : ''
  return SAFE_ERRORS.has(code) ? code : 'startup-failed'
}

function runStartupStages(steps) {
  return async (context) => {
    for (const [stage, action] of steps) {
      context.stage = stage
      context.setStage?.(stage)
      context.value = await action(context)
    }
    return context.value
  }
}

async function atomicStatusWrite(filename, status) {
  const directory = path.dirname(filename)
  const tmp = path.join(directory, `.${path.basename(filename)}.${process.pid}.tmp`)
  const bytes = JSON.stringify({ schemaVersion: 1, ...status })
  const handle = await fs.promises.open(tmp, 'wx', 0o600)
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync() } finally { await handle.close() }
  await fs.promises.rename(tmp, filename)
}

async function writeStartupStatus(options, claim, stage, errorCode, state = 'blocked') {
  if (!claim?.claimId || !/^[a-f0-9]{64}$/.test(claim.claimId)) return
  if (!STARTUP_STAGES.includes(stage) || !['blocked', 'ok'].includes(state) || (errorCode !== 'ok' && !SAFE_ERRORS.has(errorCode) && errorCode !== 'startup-failed')) throw new Error('startup-failed')
  const claimsDir = path.join(options.repoRoot, '.validation', 'agentic', 'claims')
  const statusPath = path.join(claimsDir, `${claim.claimId}.startup-status.json`)
  const stat = fs.lstatSync(claimsDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('claim-path-invalid')
  await atomicStatusWrite(statusPath, { claimId: claim.claimId, state, stage, errorCode })
}

function args(argv) {
  const values = new Map()
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--credential-preflight') { flags.add(key); continue }
    const value = argv[++i]
    if (!value || value.startsWith('--') || !['--runtime-root', '--repo-root', '--settings-dir', '--profile-id', '--output', '--authorization'].includes(key)) throw new Error('invalid-arguments')
    values.set(key, value)
  }
  for (const key of ['--runtime-root', '--repo-root', '--settings-dir', '--output', '--authorization']) if (!values.has(key)) throw new Error('invalid-arguments')
  return { runtimeRoot: path.resolve(values.get('--runtime-root')), repoRoot: path.resolve(values.get('--repo-root')), settingsDir: path.resolve(values.get('--settings-dir')), profileId: values.get('--profile-id') || '', outputDir: path.resolve(values.get('--output')), authorizationPath: path.resolve(values.get('--authorization')), credentialPreflight: flags.has('--credential-preflight') }
}

function plainDir(p) { const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('unsafe-directory') }
function inside(parent, child) { const r = path.relative(path.resolve(parent), path.resolve(child)); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) }

async function main(options) {
  // Validate authorization and claim synchronously; stage OSCrypt state and set all Electron paths before yielding.
  let claim, currentStage = 'authorization'
  try {
    const prepared = prepareStartupSynchronously(options, { setStage: stage => { currentStage = stage }, onClaim: value => { claim = value } })
    claim = prepared.claim
    const { binding, profileId } = prepared
    currentStage = 'app-ready'
    const runnerPath = path.join(options.repoRoot, 'scripts/agentic/retrieval-eval.mjs')
    const runner = await import(require('node:url').pathToFileURL(runnerPath).href)
    const verifiedBinding = await runner.checkAuthorizationArtifact({ repoRoot: options.repoRoot, authorizationPath: options.authorizationPath })
    if (verifiedBinding.sourceCommit !== binding.sourceCommit || verifiedBinding.retrievalDataHash !== binding.retrievalDataHash || verifiedBinding.reference !== binding.reference) throw new Error('authorization-binding-mismatch')
    const steps = [
      ['app-ready', async context => { await app.whenReady(); return context.value }],
      ['credential-store', async context => { const crypto = require('../../electron/services/native-credential-crypto'); if (!await crypto.nativeCredentialCrypto.isAvailable()) throw new Error('credential-store-unavailable'); return context.value }],
      ['profile-decrypt', async context => { const profile = await require('../../electron/services/store').getPrivateProfile(profileId); if (!profile || typeof profile.apiKey !== 'string' || !profile.apiKey) throw new Error('saved-profile-unavailable'); return { profile } }],
      ['profile-binding', async context => ({ profile: runner.verifyProfileBinding(context.value.profile, binding.authorization) })]
    ]
    if (options.credentialPreflight) {
      await runStartupStages(steps)({ setStage: stage => { currentStage = stage }, value: undefined })
      await writeStartupStatus(options, claim, 'profile-binding', 'ok', 'ok')
      fs.writeFileSync(path.join(options.runtimeRoot, 'credential-preflight-verdict.json'), JSON.stringify({ decrypted: true }), { flag: 'wx', mode: 0o600 })
      return null
    }
    steps.push(['evaluation', async context => {
      const report = await runner.runRetrievalEvaluation({ repoRoot: options.repoRoot, outputDir: options.outputDir, authorizationPath: options.authorizationPath, claimPath: claim.claimPath, scratchRoot: options.runtimeRoot, profile: context.value.profile })
      return report
    }])
    const report = await runStartupStages(steps)({ setStage: stage => { currentStage = stage }, value: undefined })
    if (report?.verification?.valid !== true) throw new Error('retrieval-evaluation-incomplete')
    await writeStartupStatus(options, claim, 'evaluation', 'ok', 'ok')
    return report
  } catch (error) {
    const code = staticErrorCode(error)
    if (claim) {
      try { await writeStartupStatus(options, claim, currentStage, code) } catch { /* preserve generic process result */ }
    }
    throw Object.assign(new Error(code), { startupStage: currentStage })
  }
}

function prepareStartupSynchronously(options, dependencies = {}) {
  const setStage = dependencies.setStage || (() => {})
  const appApi = dependencies.appApi || app
  const checkAuthorization = dependencies.checkAuthorization || checkAuthorizationSync
  const secureRuntime = dependencies.secureRuntime || (() => require('./run-retrieval-profile.cjs').secureTemporaryDirectory(options.runtimeRoot))
  const readSettings = dependencies.readSettings || readEncryptedSettings
  const stageSettings = dependencies.stageSettings || stageEncryptedSettings
  const registerHooks = dependencies.registerHooks || registerSharedAliasHooks
  setStage('authorization')
  registerHooks(options.repoRoot)
  const binding = checkAuthorization(options.repoRoot, options.authorizationPath)
  setStage('claim')
  const claim = options.credentialPreflight ? existingUnstartedClaimSync(options, binding) : createClaimSync(options.repoRoot, binding)
  dependencies.onClaim?.(claim)
  setStage('private-runtime')
  plainDir(options.runtimeRoot)
  secureRuntime()
  setStage('saved-public-profile')
  const beforeStage = readSettings(options.settingsDir, options.profileId)
  const beforeSettings = JSON.parse(beforeStage.bytes.toString('utf8'))
  const beforeProfile = beforeSettings.profiles.find(item => item.id === beforeStage.profileId)
  assertPublicProfileBinding(publicMetadata(beforeProfile), binding.authorization)
  setStage('settings-staging')
  const isolated = path.join(options.runtimeRoot, 'isolated-user-data')
  fs.mkdirSync(isolated, { recursive: false })
  const profileId = stageSettings(options.settingsDir, options.runtimeRoot, isolated, options.profileId)
  if (profileId !== beforeStage.profileId) throw new Error('profile-binding-mismatch')
  const stagedSettings = JSON.parse(fs.readFileSync(path.join(isolated, 'settings.json'), 'utf8'))
  assertPublicProfileBinding(publicMetadata(stagedSettings.profiles.find(item => item.id === profileId)), binding.authorization)
  setStage('electron-paths')
  const appData = path.join(options.runtimeRoot, 'app-data'), logs = path.join(options.runtimeRoot, 'logs')
  fs.mkdirSync(appData, { recursive: false }); fs.mkdirSync(logs, { recursive: false })
  appApi.setPath('appData', appData); appApi.setPath('sessionData', isolated); appApi.setPath('logs', logs); appApi.setPath('userData', isolated)
  return { binding, claim, profileId, isolated, appData, logs }
}

function checkAuthorizationSync(repoRoot, authorizationPath) {
  const binding = startupPolicy.checkAuthorizationSync({ repoRoot, authorizationPath, purpose: 'm06-retrieval-v1' })
  return { sourceCommit: binding.sourceCommit, retrievalDataHash: binding.dataHash, reference: binding.reference, authorization: binding.authorization, purpose: binding.purpose }
}

function m06Binding(binding) {
  if (!binding || binding.purpose === undefined) return { ...binding, purpose: 'm06-retrieval-v1' }
  if (binding.purpose !== 'm06-retrieval-v1') throw new Error('authorization-binding-mismatch')
  return binding
}

function claimId(binding) { return startupPolicy.claimId(m06Binding(binding), 'm06-retrieval-v1') }

function isAllowedAuthorizationOutputCap(value) { return value === 2000 || value === 6000 }

function createClaimSync(repoRoot, binding) {
  return startupPolicy.createClaimSync(repoRoot, m06Binding(binding), 'm06-retrieval-v1')
}

function existingUnstartedClaimSync(options, binding) {
  return startupPolicy.existingUnstartedClaimSync(options.repoRoot, m06Binding(binding), 'm06-retrieval-v1')
}

function assertPublicProfileBinding(profile, auth) {
  if (auth.protocol !== 'openai') throw new Error('profile-binding-mismatch')
  startupPolicy.assertPublicProfileBinding(profile, auth)
  return true
}

function publicMetadata(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('profile-binding-mismatch')
  return { id: profile.id, baseUrl: profile.baseUrl, model: profile.model, protocol: profile.protocol, temperature: profile.temperature, reasoningEffort: profile.reasoningEffort, contextWindowTokens: profile.contextWindowTokens }
}

const entry = Boolean(process.versions.electron && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))
if (entry) {
  if (process.env.ELECTRON_RUN_AS_NODE) { process.stderr.write('Native Electron mode is required.\n'); process.exit(1) }
  let options
  try { options = args(process.argv.slice(2)) } catch { process.stderr.write('Retrieval evaluation received invalid arguments.\n'); app.exit(2) }
  if (options) main(options).then(() => { process.stdout.write(options.credentialPreflight ? 'Credential preflight passed without provider requests.\n' : 'Retrieval evaluation report written.\n'); app.exit(0) }, error => { process.stderr.write(`${JSON.stringify({ type: 'retrieval-startup', stage: STARTUP_STAGES.includes(error?.startupStage) ? error.startupStage : 'authorization', code: staticErrorCode(error) })}\n`); app.exit(1) })
}

module.exports = { args, inside, prepareStartupSynchronously, runStartupStages, staticErrorCode, writeStartupStatus, claimId, existingUnstartedClaimSync, isAllowedAuthorizationOutputCap }
