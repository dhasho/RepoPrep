const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const launcher = require('./run-saved-profile.cjs')

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
  assert.equal(parsed.maxRequests, 16)
  assert.equal(parsed.profileId, '')
  assert.throws(() => launcher.parseArgs(['--output', 'x', '--max-requests', '17']), /invalid-request-limit/)
  assert.throws(() => launcher.parseArgs(['--output']), /missing-argument-value/)
  assert.throws(() => launcher.parseArgs(['--settings-dir', 'C:\\Users\\test\\ProjectLens', '--output', 'C:\\Users\\test\\ProjectLens\\reports']), /output-settings-overlap/)
})

test('--verify and --help do not require output or settings paths', () => {
  assert.equal(launcher.parseArgs(['--verify']).verify, true)
  assert.equal(launcher.parseArgs(['--help']).help, true)
})

test('child arguments contain metadata only and never accept credential values', () => {
  const parsed = launcher.parseArgs(['--output', 'reports/run', '--profile-id', 'saved-profile'])
  const args = launcher.buildChildArgs(parsed, 'C:\\tmp\\runtime', 'C:\\repo')
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
  fs.writeFileSync(path.join(settingsDir, 'settings.json.bak'), Buffer.from('backup sentinel'))
  assert.equal(launcher.stageEncryptedSettings(settingsDir, runtimeRoot, isolatedUserData, 'saved-profile'), 'saved-profile')
  assert.deepEqual(fs.readFileSync(path.join(isolatedUserData, 'settings.json')), source)
  assert.deepEqual(fs.readFileSync(path.join(settingsDir, 'settings.json')), source)
  assert.equal(fs.readFileSync(path.join(settingsDir, 'settings.json.bak'), 'utf8'), 'backup sentinel')
})
