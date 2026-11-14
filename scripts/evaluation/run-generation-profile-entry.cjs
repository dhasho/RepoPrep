const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')
const { stageEncryptedSettings, readEncryptedSettings, registerSharedAliasHooks } = require('./run-saved-profile.cjs')
const startup = require('./run-agentic-profile-startup.cjs')

const PURPOSE = 'm08-generation-v1'
const STARTUP_STAGES = Object.freeze(['authorization', 'claim', 'private-runtime', 'saved-public-profile', 'settings-staging', 'electron-paths', 'app-ready', 'credential-store', 'runner-load', 'profile-decrypt', 'generation-evaluation'])
const SAFE_ERRORS = new Set([
  'authorization-required', 'authorization-invalid', 'authorization-binding-mismatch', 'authorization-claim-invalid', 'authorization-claim-already-started',
  'private-runtime-unavailable', 'settings-directory-unavailable', 'settings-file-unavailable', 'settings-invalid', 'settings-schema-unsupported',
  'settings-plaintext-credential-refused', 'settings-default-profile-missing', 'settings-profile-missing', 'settings-encrypted-credential-missing',
  'settings-profile-invalid', 'os-crypt-state-unavailable', 'os-crypt-state-invalid', 'os-crypt-app-bound-unsupported',
  'profile-binding-mismatch', 'credential-store-unavailable', 'saved-profile-unavailable', 'profile-decrypt-failed',
  'unsafe-directory', 'unsafe-runtime-path', 'claim-path-invalid', 'output-path-invalid', 'path-overlap',
  'generation-evaluation-incomplete', 'startup-failed'
])

function sourceRoot(override) {
  const configured = override ?? (typeof __AGENTIC_REPO_ROOT__ === 'string' ? __AGENTIC_REPO_ROOT__ : path.resolve(__dirname, '..', '..'))
  try { return fs.realpathSync(configured) } catch { throw new Error('authorization-binding-mismatch') }
}

function staticErrorCode(error) {
  const code = error instanceof Error ? error.message : ''
  return SAFE_ERRORS.has(code) ? code : 'startup-failed'
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function overlaps(a, b) {
  const left = path.resolve(a), right = path.resolve(b)
  return left === right || inside(left, right) || inside(right, left)
}

function args(argv, defaults = {}) {
  const allowed = new Set(['--runtime-root', '--repo-root', '--settings-dir', '--profile-id', '--output', '--authorization'])
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--credential-preflight') {
      if (flags.has(key)) throw new Error('invalid-arguments')
      flags.add(key)
      continue
    }
    if (!allowed.has(key) || values.has(key)) throw new Error('invalid-arguments')
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('invalid-arguments')
    values.set(key, value)
  }
  for (const key of ['--runtime-root', '--repo-root', '--authorization']) if (!values.has(key)) throw new Error('invalid-arguments')
  const repoRoot = path.resolve(values.get('--repo-root'))
  const localOutputRoot = path.join(repoRoot, '.validation', 'agentic')
  const outputDir = path.resolve(values.get('--output') || path.join(localOutputRoot, `generation-${Date.now()}`))
  const relativeOutput = path.relative(localOutputRoot, outputDir)
  if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) throw new Error('output-path-invalid')
  const settingsDir = path.resolve(values.get('--settings-dir') || defaults.settingsDir || '')
  if (!settingsDir) throw new Error('settings-directory-unavailable')
  const authorizationPath = path.resolve(values.get('--authorization'))
  if (overlaps(outputDir, settingsDir) || overlaps(outputDir, authorizationPath)) throw new Error('path-overlap')
  return Object.freeze({
    runtimeRoot: path.resolve(values.get('--runtime-root')),
    repoRoot,
    settingsDir,
    profileId: values.get('--profile-id') || '',
    authorizationPath,
    outputDir,
    credentialPreflight: flags.has('--credential-preflight')
  })
}

function assertPlainDirectory(directory, errorCode = 'unsafe-directory') {
  let stat
  try { stat = fs.lstatSync(directory) } catch { throw new Error(errorCode) }
  if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) throw new Error(errorCode)
}

function assertOutputParent(repoRoot, outputDir) {
  const relative = path.relative(repoRoot, path.dirname(outputDir))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('output-path-invalid')
  let cursor = path.resolve(repoRoot)
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part)
    try {
      const stat = fs.lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0) throw new Error('output-path-invalid')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('output-path-invalid')
      fs.mkdirSync(cursor)
      assertPlainDirectory(cursor, 'output-path-invalid')
    }
  }
  try { fs.lstatSync(outputDir); throw new Error('output-path-invalid') } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

function publicMetadata(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('profile-binding-mismatch')
  return {
    baseUrl: profile.baseUrl,
    model: profile.model,
    protocol: profile.protocol,
    temperature: profile.temperature,
    reasoningEffort: profile.reasoningEffort,
    contextWindowTokens: profile.contextWindowTokens
  }
}

function prepareStartupSynchronously(options, dependencies = {}) {
  const setStage = dependencies.setStage || (() => {})
  const expectedRoot = sourceRoot(dependencies.sourceRoot)
  let actualRoot
  try { actualRoot = fs.realpathSync(options.repoRoot) } catch { throw new Error('authorization-binding-mismatch') }
  if (actualRoot !== expectedRoot) throw new Error('authorization-binding-mismatch')
  const appApi = dependencies.appApi || app
  const checkAuthorization = dependencies.checkAuthorization || startup.checkAuthorizationSync
  const secureRuntime = dependencies.secureRuntime || (() => require('./run-retrieval-profile.cjs').secureTemporaryDirectory(options.runtimeRoot))
  const readSettings = dependencies.readSettings || readEncryptedSettings
  const stageSettings = dependencies.stageSettings || stageEncryptedSettings
  const registerHooks = dependencies.registerHooks || registerSharedAliasHooks

  setStage('authorization')
  registerHooks(options.repoRoot)
  const binding = checkAuthorization({ repoRoot: options.repoRoot, authorizationPath: options.authorizationPath, purpose: PURPOSE })
  if (!options.credentialPreflight) assertOutputParent(options.repoRoot, options.outputDir)
  setStage('claim')
  const claim = options.credentialPreflight
    ? startup.existingUnstartedClaimSync(options.repoRoot, binding, PURPOSE)
    : startup.createClaimSync(options.repoRoot, binding, PURPOSE)
  dependencies.onClaim?.(claim)

  setStage('private-runtime')
  assertPlainDirectory(options.runtimeRoot)
  secureRuntime()
  setStage('saved-public-profile')
  const beforeStage = readSettings(options.settingsDir, options.profileId)
  const beforeSettings = JSON.parse(beforeStage.bytes.toString('utf8'))
  const beforeProfile = beforeSettings.profiles.find(item => item.id === beforeStage.profileId)
  startup.assertPublicProfileBinding(publicMetadata(beforeProfile), binding.authorization)

  setStage('settings-staging')
  const isolated = path.join(options.runtimeRoot, 'isolated-user-data')
  fs.mkdirSync(isolated, { recursive: false })
  const profileId = stageSettings(options.settingsDir, options.runtimeRoot, isolated, options.profileId)
  if (profileId !== beforeStage.profileId) throw new Error('profile-binding-mismatch')
  const stagedSettings = JSON.parse(fs.readFileSync(path.join(isolated, 'settings.json'), 'utf8'))
  const stagedProfile = stagedSettings.profiles.find(item => item.id === profileId)
  startup.assertPublicProfileBinding(publicMetadata(stagedProfile), binding.authorization)

  setStage('electron-paths')
  const appData = path.join(options.runtimeRoot, 'app-data')
  const logs = path.join(options.runtimeRoot, 'logs')
  for (const directory of [appData, logs]) {
    if (!inside(options.runtimeRoot, directory)) throw new Error('unsafe-runtime-path')
    fs.mkdirSync(directory, { recursive: false })
    assertPlainDirectory(directory)
  }
  appApi.setPath('appData', appData)
  appApi.setPath('sessionData', isolated)
  appApi.setPath('logs', logs)
  appApi.setPath('userData', isolated)
  return Object.freeze({ binding, claim, profileId, isolated, appData, logs })
}

function sameBinding(first, second) {
  return first.sourceCommit === second.sourceCommit && first.generationDataHash === second.generationDataHash && first.reference === second.reference
}

async function main(options, dependencies = {}) {
  let claim, currentStage = 'authorization'
  try {
    const prepared = prepareStartupSynchronously(options, { ...dependencies, setStage: stage => { currentStage = stage; dependencies.setStage?.(stage) }, onClaim: value => { claim = value; dependencies.onClaim?.(value) } })
    claim = prepared.claim
    currentStage = 'app-ready'
    await (dependencies.whenReady || (() => app.whenReady()))()
    currentStage = 'credential-store'
    const credentialCrypto = dependencies.credentialCrypto || require('../../electron/services/native-credential-crypto').nativeCredentialCrypto
    if (!await credentialCrypto.isAvailable()) throw new Error('credential-store-unavailable')

    currentStage = 'runner-load'
    const runnerPath = path.join(options.repoRoot, 'scripts', 'agentic', 'generation-eval.mjs')
    const runner = dependencies.runner || await import(require('node:url').pathToFileURL(runnerPath).href)
    const verified = startup.checkAuthorizationSync({ repoRoot: options.repoRoot, authorizationPath: options.authorizationPath, purpose: PURPOSE })
    if (!sameBinding(prepared.binding, verified)) throw new Error('authorization-binding-mismatch')
    const canonical = await runner.checkGenerationAuthorizationArtifact({ repoRoot: options.repoRoot, authorizationPath: options.authorizationPath })
    if (!sameBinding(prepared.binding, canonical)) throw new Error('authorization-binding-mismatch')

    const storeApi = dependencies.store || require('../../electron/services/store')
    if (options.credentialPreflight) {
      currentStage = 'profile-decrypt'
      const profile = await storeApi.getPrivateProfile(prepared.profileId)
      if (!profile || typeof profile.apiKey !== 'string' || !profile.apiKey) throw new Error('saved-profile-unavailable')
      runner.verifyGenerationProfileBinding(profile, prepared.binding.authorization)
      fs.writeFileSync(path.join(options.runtimeRoot, 'credential-preflight-verdict.json'), JSON.stringify({ decrypted: true }), { flag: 'wx', mode: 0o600 })
      return null
    }

    currentStage = 'generation-evaluation'
    const report = await runner.runGenerationEvaluation({
      repoRoot: options.repoRoot,
      authorizationPath: options.authorizationPath,
      outputDir: options.outputDir,
      claimPath: prepared.claim.claimPath,
      scratchRoot: options.runtimeRoot,
      readProfile: async () => {
        currentStage = 'profile-decrypt'
        const profile = await storeApi.getPrivateProfile(prepared.profileId)
        currentStage = 'generation-evaluation'
        return profile
      }
    })
    if (report?.mode !== 'real' || report?.executionComplete !== true || report?.status !== 'awaiting-review' || report?.reviewState !== 'independent-quality-review-pending' || report?.qualityGate !== 'not-evaluated') throw new Error('generation-evaluation-incomplete')
    return report
  } catch (error) {
    throw Object.assign(new Error(staticErrorCode(error)), { startupStage: currentStage })
  }
}

function staticErrorCode(error) {
  const code = error instanceof Error ? error.message : ''
  return SAFE_ERRORS.has(code) ? code : 'startup-failed'
}

const entry = Boolean(process.versions.electron && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))
if (entry) {
  if (process.env.ELECTRON_RUN_AS_NODE) { process.stderr.write('Native Electron mode is required.\n'); process.exit(1) }
  let options
  try { options = args(process.argv.slice(2), { settingsDir: process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ProjectLens') : '' }) }
  catch { process.stderr.write('Generation evaluation received invalid arguments.\n'); app.exit(2) }
  if (options) main(options).then(() => {
    process.stdout.write(options.credentialPreflight ? 'Credential preflight passed without provider requests.\n' : 'Generation execution complete; independent quality review is pending.\n')
    app.exit(0)
  }, error => {
    const stage = STARTUP_STAGES.includes(error?.startupStage) ? error.startupStage : 'authorization'
    process.stderr.write(`${JSON.stringify({ type: 'generation-startup', stage, code: staticErrorCode(error) })}\n`)
    app.exit(1)
  })
}

module.exports = { args, assertOutputParent, inside, main, parseArgs: args, prepareStartupSynchronously, sameBinding, staticErrorCode }
