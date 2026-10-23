const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const launcher = require('./run-saved-profile.cjs')
const variantArguments = require('./variant-arguments.cjs')

function settingsFixture(overrides = {}) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: 'saved-profile',
    profiles: [{
      id: 'saved-profile', name: 'Saved profile', baseUrl: 'https://api.example.invalid/v1',
      model: 'test-model', credential: { version: 1, ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0' }
    }],
    ...overrides
  }))
}

test('importing the launcher does not start Electron or a runner', () => {
  assert.equal(typeof launcher.parseArgs, 'function')
  assert.equal(typeof launcher.validateSettingsSnapshot, 'function')
})

test('parses bounded metadata arguments and repeated cases', () => {
  const parsed = launcher.parseArgs(['--output', 'reports/run', '--case', 'one', '--case', 'two', '--max-requests', '16'])
  assert.deepEqual(parsed.caseIds, ['one', 'two'])
  assert.deepEqual(parsed.variants, ['generation', 'baseline'])
  assert.equal(parsed.maxRequests, 16)
  assert.equal(parsed.profileId, '')
  assert.throws(() => launcher.parseArgs(['--output', 'x', '--max-requests', '17']), /invalid-request-limit/)
  assert.deepEqual(launcher.parseArgs(['--output', 'x', '--variant', 'generation']).variants, ['generation'])
  assert.deepEqual(launcher.parseArgs(['--output', 'x', '--variant', 'baseline', '--variant', 'generation']).variants, ['baseline', 'generation'])
  assert.throws(() => launcher.parseArgs(['--output', 'x', '--variant', 'invalid', '--settings-dir', 'missing']), /invalid-variant/)
  assert.throws(() => launcher.parseArgs(['--output', 'x', '--variant', 'generation', '--variant', 'generation']), /invalid-variant/)
  assert.throws(() => launcher.parseArgs(['--output']), /missing-argument-value/)
  assert.throws(() => launcher.parseArgs(['--settings-dir', 'C:\\Users\\test\\ProjectLens', '--output', 'C:\\Users\\test\\ProjectLens\\reports']), /output-settings-overlap/)
})

test('Electron entry variant contract defaults to both and rejects invalid duplicates', () => {
  assert.deepEqual(variantArguments.resolveVariants([]), ['generation', 'baseline'])
  const selected = variantArguments.appendVariant([], 'generation', 'invalid-entry-arguments')
  assert.deepEqual(variantArguments.appendVariant(selected, 'baseline', 'invalid-entry-arguments'), ['generation', 'baseline'])
  assert.throws(() => variantArguments.appendVariant(selected, 'generation', 'invalid-entry-arguments'), /invalid-entry-arguments/)
  assert.throws(() => variantArguments.appendVariant([], 'bad', 'invalid-entry-arguments'), /invalid-entry-arguments/)
})

test('--verify and --help do not require output or settings paths', () => {
  assert.equal(launcher.parseArgs(['--verify']).verify, true)
  assert.equal(launcher.parseArgs(['--help']).help, true)
  const preflight = launcher.parseArgs(['--preflight', '--repo-root', process.cwd()])
  assert.equal(preflight.preflight, true)
  assert.equal(preflight.outputDir, '')
  assert.throws(() => launcher.parseArgs(['--verify', '--preflight']), /incompatible-mode-flags/)
  assert.throws(() => launcher.parseArgs(['--credential-preflight']), /credential-fixture-path-required/)
})

test('Node can execute the shared alias --import hook as a URL', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--import', launcher.sharedAliasImportUrl(process.cwd()),
    '--input-type=module',
    '-e', "import('@shared/types').then(() => process.stdout.write('ALIAS-IMPORT-OK\\n'))"
  ], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, env: launcher.safeChildEnvironment() })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ALIAS-IMPORT-OK/)
})

test('native Electron preflight creates isolated paths and imports the real TypeScript runner without settings or network', () => {
  const runnerRoot = process.env.REPOPREP_EVAL_SOURCE_ROOT || path.resolve(__dirname, '../..')
  assert.ok(fs.existsSync(path.join(runnerRoot, 'scripts', 'evaluation', 'real-runner.mjs')), 'real-runner.mjs is required for the native preflight')
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'run-saved-profile.cjs'),
    '--preflight',
    '--repo-root', runnerRoot
  ], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
    env: launcher.safeChildEnvironment()
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /VERDICT SAVED-PROFILE-PREFLIGHT-OK/)
})

test('child arguments contain metadata only and never accept credential values', () => {
  const parsed = launcher.parseArgs(['--output', 'reports/run', '--profile-id', 'saved-profile'])
  const args = launcher.buildChildArgs(parsed, 'C:\\tmp\\runtime', 'C:\\repo')
  assert.deepEqual(args.slice(args.indexOf('--variant')), ['--variant', 'generation', '--variant', 'baseline'])
  const generationOnly = launcher.buildChildArgs(launcher.parseArgs(['--output', 'reports/run', '--variant', 'generation']), 'C:\\tmp\\runtime', 'C:\\repo')
  assert.deepEqual(generationOnly.slice(generationOnly.indexOf('--variant')), ['--variant', 'generation'])
  assert.equal(args.includes('apiKey'), false)
  assert.equal(args.some((value) => value.includes('synthetic-secret')), false)
  assert.equal(args.includes('saved-profile'), true)
})

test('child environments omit arbitrary credential-like variables', (context) => {
  const name = 'REPOP_REP_TEST_API_KEY'
  const previous = process.env[name]
  process.env[name] = 'synthetic-secret'
  context.after(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
  assert.equal(launcher.safeChildEnvironment()[name], undefined)
})

test('accepts a schema 2 encrypted profile without exposing parsed credential material', () => {
  const validated = launcher.validateSettingsSnapshot(settingsFixture(), 'saved-profile')
  assert.equal(validated.profileId, 'saved-profile')
  assert.equal(validated.settings.profiles[0].credential.ciphertext, 'ZmFrZS1jaXBoZXJ0ZXh0')
})

test('fails closed on legacy schemas, plaintext keys, missing profiles, and missing ciphertext', () => {
  assert.throws(() => launcher.validateSettingsSnapshot(settingsFixture({ schemaVersion: 1 }), 'saved-profile'), /settings-schema-unsupported/)
  assert.throws(() => launcher.validateSettingsSnapshot(settingsFixture({ profiles: [{ ...JSON.parse(settingsFixture().toString()).profiles[0], apiKey: 'synthetic-secret' }] }), 'saved-profile'), /settings-plaintext-credential-refused/)
  assert.throws(() => launcher.validateSettingsSnapshot(settingsFixture(), 'unknown-profile'), /settings-profile-missing/)
  const noCredential = settingsFixture({ profiles: [{ id: 'saved-profile', baseUrl: 'https://example.invalid', model: 'test' }] })
  assert.throws(() => launcher.validateSettingsSnapshot(noCredential, 'saved-profile'), /settings-encrypted-credential-missing/)
})

test('Local State staging keeps only the non-app-bound encrypted OSCrypt key fields', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-local-state-test-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const encryptedKey = Buffer.concat([Buffer.from('DPAPI'), Buffer.from('synthetic-protected-master-key')]).toString('base64')
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: encryptedKey, audit_enabled: true, unrelated: 'discard-me' },
    browser: { history: ['must-not-copy'] }
  }))
  const snapshot = JSON.parse(launcher.readOsCryptSnapshot(root).toString('utf8'))
  assert.deepEqual(snapshot, { os_crypt: { encrypted_key: encryptedKey, audit_enabled: true } })
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ os_crypt: { app_bound_encrypted_key: encryptedKey, encrypted_key: encryptedKey } }))
  assert.throws(() => launcher.readOsCryptSnapshot(root), /os-crypt-app-bound-unsupported/)
})

test('settings directory and settings file must exist as plain paths', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-saved-profile-test-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => launcher.readEncryptedSettings(path.join(root, 'missing'), 'saved-profile'), /settings-directory-unavailable/)
  fs.writeFileSync(path.join(root, 'settings.json'), settingsFixture())
  const loaded = launcher.readEncryptedSettings(root, 'saved-profile')
  assert.equal(loaded.profileId, 'saved-profile')
  fs.unlinkSync(path.join(root, 'settings.json'))
  assert.throws(() => launcher.readEncryptedSettings(root, 'saved-profile'), /settings-file-unavailable/)
})

test('stages only the unchanged encrypted snapshot inside an isolated userData directory', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-saved-profile-stage-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const settingsDir = path.join(root, 'source')
  const runtimeRoot = path.join(root, 'runtime')
  const isolatedUserData = path.join(runtimeRoot, 'user-data')
  fs.mkdirSync(settingsDir)
  fs.mkdirSync(runtimeRoot)
  fs.mkdirSync(isolatedUserData)
  const source = settingsFixture()
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), source)
  const protectedKey = Buffer.concat([Buffer.from('DPAPI'), Buffer.from('test-protected-key')]).toString('base64')
  const sourceLocalState = Buffer.from(JSON.stringify({
    os_crypt: { encrypted_key: protectedKey, audit_enabled: false, unrelated: 'drop' },
    browser: { history: ['do-not-copy'] }
  }))
  fs.writeFileSync(path.join(settingsDir, 'Local State'), sourceLocalState)
  fs.writeFileSync(path.join(settingsDir, 'settings.json.bak'), Buffer.from('backup sentinel'))
  assert.equal(launcher.stageEncryptedSettings(settingsDir, runtimeRoot, isolatedUserData, 'saved-profile'), 'saved-profile')
  assert.deepEqual(fs.readFileSync(path.join(isolatedUserData, 'settings.json')), source)
  assert.deepEqual(fs.readFileSync(path.join(settingsDir, 'settings.json')), source)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolatedUserData, 'Local State'), 'utf8')), { os_crypt: { encrypted_key: protectedKey, audit_enabled: false } })
  assert.equal(fs.existsSync(path.join(isolatedUserData, 'Local State')), true)
  assert.equal(fs.readFileSync(path.join(settingsDir, 'settings.json.bak'), 'utf8'), 'backup sentinel')
  assert.deepEqual(fs.readFileSync(path.join(settingsDir, 'Local State')), sourceLocalState)
})

test('native OS encryption decrypts through the isolated snapshot in a second Electron process', (context) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoprep-native-credential-stage-'))
  assert.ok(launcher.isWithin(os.tmpdir(), fixtureRoot))
  context.after(() => {
    const inspect = (entry) => {
      const stat = fs.lstatSync(entry)
      assert.equal(stat.isSymbolicLink(), false, 'fixture cleanup refuses linked entries')
      if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) inspect(path.join(entry, name))
    }
    inspect(fixtureRoot)
    fs.rmSync(fixtureRoot, { recursive: true, force: false })
  })

  const writer = spawnSync(require('electron'), [
    path.join(__dirname, '..', '..', 'tests', 'native-credential-stage-writer.cjs'),
    fixtureRoot
  ], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: launcher.safeChildEnvironment()
  })
  assert.equal(writer.error, undefined)
  assert.equal(writer.status, 0, writer.stderr)

  const sourceUserData = path.join(fixtureRoot, 'source-user-data')
  const relativeFiles = []
  const listFiles = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) listFiles(filename)
      else if (entry.isFile()) relativeFiles.push(path.relative(fixtureRoot, filename))
    }
  }
  listFiles(fixtureRoot)
  assert.ok(relativeFiles.includes(path.join('source-user-data', 'Local State')), 'encrypted Local State missing from fixture userData')
  const settingsBytes = fs.readFileSync(path.join(sourceUserData, 'settings.json'))
  assert.equal(settingsBytes.includes(Buffer.from('"apiKey"')), false, 'source settings contain ciphertext only')
  const localStateSnapshot = JSON.parse(launcher.readOsCryptSnapshot(sourceUserData).toString('utf8'))
  assert.ok(localStateSnapshot.os_crypt.encrypted_key)
  assert.equal(Object.hasOwn(localStateSnapshot.os_crypt, 'app_bound_encrypted_key'), false)

  const reader = spawnSync(process.execPath, [
    path.join(__dirname, 'run-saved-profile.cjs'),
    '--credential-preflight',
    '--settings-dir', sourceUserData,
    '--profile-id', 'synthetic-stage-profile'
  ], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
    env: launcher.safeChildEnvironment()
  })
  assert.equal(reader.error, undefined)
  assert.equal(reader.status, 0, reader.stderr)
  assert.match(reader.stdout, /VERDICT SAVED-CREDENTIAL-STAGE-OK/)
})
