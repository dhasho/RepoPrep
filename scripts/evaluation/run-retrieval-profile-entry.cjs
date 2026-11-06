const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { stageEncryptedSettings, readEncryptedSettings, registerSharedAliasHooks } = require('./run-saved-profile.cjs')

function args(argv) {
  const values = new Map()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[++i]
    if (!value || value.startsWith('--') || !['--runtime-root', '--repo-root', '--settings-dir', '--profile-id', '--output', '--authorization'].includes(key)) throw new Error('invalid-arguments')
    values.set(key, value)
  }
  for (const key of ['--runtime-root', '--repo-root', '--settings-dir', '--output', '--authorization']) if (!values.has(key)) throw new Error('invalid-arguments')
  return { runtimeRoot: path.resolve(values.get('--runtime-root')), repoRoot: path.resolve(values.get('--repo-root')), settingsDir: path.resolve(values.get('--settings-dir')), profileId: values.get('--profile-id') || '', outputDir: path.resolve(values.get('--output')), authorizationPath: path.resolve(values.get('--authorization')) }
}

function plainDir(p) { const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('unsafe-directory') }
function inside(parent, child) { const r = path.relative(path.resolve(parent), path.resolve(child)); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) }

async function main(options) {
  // Bind local approval and frozen inputs before touching Electron's saved-profile store.
  registerSharedAliasHooks(options.repoRoot)
  const runnerPath = path.join(options.repoRoot, 'scripts/agentic/retrieval-eval.mjs')
  const runner = await import(require('node:url').pathToFileURL(runnerPath).href)
  const binding = await runner.checkAuthorizationArtifact({ repoRoot: options.repoRoot, authorizationPath: options.authorizationPath })
  const claim = await runner.claimAuthorizationArtifact({ repoRoot: options.repoRoot, authorizationPath: options.authorizationPath })
  plainDir(options.runtimeRoot)
  const secured = require('./run-retrieval-profile.cjs').secureTemporaryDirectory(options.runtimeRoot)
  if (!secured) throw new Error('private-runtime-unavailable')
  const beforeStage = readEncryptedSettings(options.settingsDir, options.profileId)
  const beforeSettings = JSON.parse(beforeStage.bytes.toString('utf8'))
  const beforeProfile = beforeSettings.profiles.find(item => item.id === beforeStage.profileId)
  runner.verifyPublicProfileBinding(publicMetadata(beforeProfile), binding.authorization)
  const isolated = path.join(options.runtimeRoot, 'isolated-user-data')
  fs.mkdirSync(isolated, { recursive: false })
  const profileId = stageEncryptedSettings(options.settingsDir, options.runtimeRoot, isolated, options.profileId)
  if (profileId !== beforeStage.profileId) throw new Error('profile-binding-mismatch')
  const stagedSettings = JSON.parse(fs.readFileSync(path.join(isolated, 'settings.json'), 'utf8'))
  const stagedProfile = stagedSettings.profiles.find(item => item.id === profileId)
  runner.verifyPublicProfileBinding(publicMetadata(stagedProfile), binding.authorization)
  const appData = path.join(options.runtimeRoot, 'app-data'), logs = path.join(options.runtimeRoot, 'logs')
  fs.mkdirSync(appData, { recursive: false }); fs.mkdirSync(logs, { recursive: false })
  app.setPath('appData', appData); app.setPath('sessionData', isolated); app.setPath('logs', logs); app.setPath('userData', isolated)
  await app.whenReady()
  const store = require('../../electron/services/store')
  const credentialCrypto = require('../../electron/services/native-credential-crypto')
  if (!await credentialCrypto.nativeCredentialCrypto.isAvailable()) throw new Error('credential-store-unavailable')
  const profile = await store.getPrivateProfile(profileId)
  if (!profile || typeof profile.apiKey !== 'string' || !profile.apiKey) throw new Error('saved-profile-unavailable')
  runner.verifyProfileBinding(profile, binding.authorization)
  const report = await runner.runRetrievalEvaluation({ repoRoot: options.repoRoot, outputDir: options.outputDir, authorizationPath: options.authorizationPath, claimPath: claim.claimPath, scratchRoot: options.runtimeRoot, profile })
  if (report?.verification?.valid !== true) throw new Error('retrieval-evaluation-incomplete')
  return report
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
  if (options) main(options).then(() => { process.stdout.write('Retrieval evaluation report written.\n'); app.exit(0) }, () => { process.stderr.write('Retrieval evaluation blocked or failed; inspect only the nonsecret status code in the local runner.\n'); app.exit(1) })
}

module.exports = { args, inside }
