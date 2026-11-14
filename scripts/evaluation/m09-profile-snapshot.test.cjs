'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')

const filename = path.join(__dirname, 'm09-profile-snapshot.cjs')
const helperSource = fs.readFileSync(filename, 'utf8')
const realRequire = createRequire(filename)
const validationRoot = path.resolve(__dirname, '../../.validation')
const isWindows = process.platform === 'win32'

// Compile an isolated module closure with a synthetic native-main facade. The
// production module has no injectable fs/process/crypto and no fixture exports.
function loadHelper(options = {}) {
  const localModule = { exports: {} }
  const dependencies = { 'node:fs': options.fs || fs, 'node:crypto': options.crypto || crypto, electron: { app: { isReady: () => Boolean(options.ready) } } }
  const mockedProcess = { platform: options.platform || process.platform, type: options.type || 'browser', versions: { ...process.versions, electron: 'synthetic-main-test' }, env: process.env, pid: process.pid }
  const wrapper = vm.runInThisContext(`(function(require,module,exports,process){\n${helperSource}\n})`, { filename })
  wrapper(name => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), localModule, localModule.exports, mockedProcess)
  return localModule.exports
}
function fixtureSettings(overrides = {}) {
  return {
    schemaVersion: 2, defaultProfileId: 'fixture-primary',
    profiles: [{ id: 'fixture-primary', name: 'Synthetic only', baseUrl: 'https://provider.invalid/v1', model: 'synthetic-model', protocol: 'openai', reasoningEffort: 'low', temperature: 0.4, contextWindowTokens: 32768, maxOutputTokens: 1024,
      credential: { version: 1, ciphertext: Buffer.concat([Buffer.from('v10'), Buffer.alloc(48, 0xa6)]).toString('base64') } }], ...overrides
  }
}
function fixtureState() {
  return { os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(32, 0xb7)]).toString('base64'), audit_enabled: false }, browser: { secretCanary: 'DROP-LOCAL-STATE-CANARY' } }
}
function safeRemove(root) {
  const resolved = path.resolve(root)
  const relative = path.relative(validationRoot, resolved)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  assert.ok(path.basename(resolved).startsWith('m09-snapshot-fixture-'))
  assertPlainAncestors(resolved)
  function remove(entry) {
    const stat = fs.lstatSync(entry)
    if (stat.isSymbolicLink()) { fs.unlinkSync(entry); return }
    if (stat.isDirectory()) { for (const name of fs.readdirSync(entry)) remove(path.join(entry, name)); fs.rmdirSync(entry) }
    else { assert.equal(stat.isFile(), true); fs.unlinkSync(entry) }
  }
  remove(resolved)
  assert.equal(fs.existsSync(resolved), false)
}
function assertPlainAncestors(directory) {
  let cursor = path.resolve(directory)
  while (true) {
    const stat = fs.lstatSync(cursor)
    assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true)
    assert.equal(fs.realpathSync.native(cursor).toLowerCase(), cursor.toLowerCase())
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}
function makeFixture(context, settings = fixtureSettings(), state = fixtureState()) {
  if (!fs.existsSync(validationRoot)) { assertPlainAncestors(path.dirname(validationRoot)); fs.mkdirSync(validationRoot) }
  assertPlainAncestors(validationRoot)
  const root = fs.mkdtempSync(path.join(validationRoot, 'm09-snapshot-fixture-'))
  const source = path.join(root, 'source'), runtime = path.join(root, 'runtime')
  fs.mkdirSync(source); fs.mkdirSync(runtime)
  const settingsBytes = Buffer.isBuffer(settings) ? settings : Buffer.from(JSON.stringify(settings))
  const stateBytes = Buffer.isBuffer(state) ? state : Buffer.from(JSON.stringify(state))
  fs.writeFileSync(path.join(source, 'settings.json'), settingsBytes)
  fs.writeFileSync(path.join(source, 'Local State'), stateBytes)
  fs.writeFileSync(path.join(source, 'settings.json.bak'), 'BACKUP-SENTINEL')
  context.after(() => safeRemove(root))
  return { root, source, runtime, settingsBytes, stateBytes }
}
function capture(helper, fixture, profileId) { return helper.captureM09ProfileSnapshot({ settingsDirectory: fixture.source, ...(profileId === undefined ? {} : { profileId }) }) }
function code(expected) { return error => { assert.equal(error.name, 'M09ProfileSnapshotError'); assert.equal(error.code, expected); assert.equal(error.message, expected); assert.equal(Object.hasOwn(error, 'cause'), false); return true } }
function fsSpy(overrides = {}) {
  const calls = [], descriptors = new Map()
  const watched = Object.create(fs)
  watched.openSync = (...args) => { const descriptor = fs.openSync(...args); descriptors.set(descriptor, args[0]); calls.push(['open', args[0], args[1]]); return descriptor }
  watched.readSync = (...args) => { calls.push(['read', descriptors.get(args[0])]); return fs.readSync(...args) }
  watched.closeSync = (...args) => { const value = fs.closeSync(...args); descriptors.delete(args[0]); return value }
  return { fs: Object.assign(watched, overrides), calls, descriptors }
}

test('production API refuses Node parent and exports no test/decrypt bypass', () => {
  const helper = realRequire(filename)
  assert.deepEqual(Object.keys(helper).sort(), ['captureM09ProfileSnapshot', 'releaseM09ProfileSnapshot', 'stageM09ProfileSnapshot'].sort())
  assert.throws(() => helper.captureM09ProfileSnapshot({ settingsDirectory: 'SECRET-CANARY' }), code('snapshot-native-main-required'))
  assert.throws(() => loadHelper({ ready: true }).captureM09ProfileSnapshot({}), code('snapshot-before-ready-required'))
})

test('native guard captures once and stages only captured bytes after both original files disappear', { skip: !isWindows }, context => {
  const f = makeFixture(context)
  const spy = fsSpy(), helper = loadHelper({ fs: spy.fs })
  const handle = capture(helper, f)
  assert.equal(Object.isFrozen(handle), true)
  assert.equal(Object.isFrozen(handle.selectedProfile), true)
  assert.equal(handle.credentialState, 'encrypted-unverified')
  assert.equal(handle.selectedProfile.profileId, 'fixture-primary')
  assert.equal(handle.selectedProfile.maxOutputTokens, 1024)
  assert.equal(Object.hasOwn(handle.selectedProfile, 'baseUrl'), false)
  assert.equal(Object.hasOwn(handle.selectedProfile, 'credential'), false)
  assert.equal(Object.hasOwn(handle, 'settingsBytes'), false)
  assert.throws(() => capture(helper, f), code('snapshot-capture-used'))
  fs.unlinkSync(path.join(f.source, 'settings.json')); fs.unlinkSync(path.join(f.source, 'Local State'))
  const staged = helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime })
  assert.equal(Object.isFrozen(staged), true)
  assert.equal(staged.selectedProfile, handle.selectedProfile)
  assert.deepEqual(fs.readFileSync(path.join(staged.userData, 'settings.json')), f.settingsBytes)
  assert.deepEqual(fs.readFileSync(path.join(staged.sessionData, 'Local State')), Buffer.from(JSON.stringify({ os_crypt: fixtureState().os_crypt })))
  assert.equal(fs.existsSync(path.join(staged.userData, 'Local State')), false)
  assert.equal(fs.existsSync(path.join(staged.sessionData, 'settings.json')), false)
  const runtimePaths = [staged.userData, staged.sessionData, staged.cache, staged.crashDumps]
  assert.equal(new Set(runtimePaths).size, 4)
  assert.ok(runtimePaths.every(directory => path.dirname(directory) === staged.runtimeRoot))
  assert.equal(fs.readFileSync(path.join(f.source, 'settings.json.bak'), 'utf8'), 'BACKUP-SENTINEL')
  for (const name of ['settings.json', 'Local State']) assert.equal(spy.calls.filter(call => call[0] === 'read' && call[1] === path.join(f.source, name)).length, 1)
  assert.equal(spy.descriptors.size, 0)
  assert.equal(staged.credentialState, 'encrypted-unverified')
  assert.equal(staged.fileContentsFsynced, true)
  assert.equal(staged.directoryFsync, 'unsupported-win32')
  assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-stage-used'))
  assert.equal(helper.releaseM09ProfileSnapshot(handle), true)
  assert.equal(helper.releaseM09ProfileSnapshot(handle), false)
  assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-handle-invalid'))
})

test('mutating source defaults/profile/key after capture never reselects or changes staged content', { skip: !isWindows }, context => {
  const original = fixtureSettings()
  original.profiles.push({ ...original.profiles[0], id: 'fixture-second', model: 'second-model', maxOutputTokens: 2048 })
  const f = makeFixture(context, original)
  const helper = loadHelper(), handle = capture(helper, f, 'fixture-second')
  const replacement = fixtureSettings(); replacement.profiles[0].model = 'replacement-model'
  fs.writeFileSync(path.join(f.source, 'settings.json'), JSON.stringify(replacement))
  fs.writeFileSync(path.join(f.source, 'Local State'), '{"unsafe":"replacement"}')
  const settingsAfterMutation = fs.readFileSync(path.join(f.source, 'settings.json'))
  const stateAfterMutation = fs.readFileSync(path.join(f.source, 'Local State'))
  const staged = helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime })
  assert.equal(staged.selectedProfile.profileId, 'fixture-second')
  assert.equal(staged.selectedProfile.model, 'second-model')
  assert.equal(staged.selectedProfile.maxOutputTokens, 2048)
  assert.deepEqual(fs.readFileSync(path.join(staged.userData, 'settings.json')), f.settingsBytes)
  assert.deepEqual(fs.readFileSync(path.join(staged.sessionData, 'Local State')), Buffer.from(JSON.stringify({ os_crypt: fixtureState().os_crypt })))
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'settings.json')), settingsAfterMutation)
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'Local State')), stateAfterMutation)
  helper.releaseM09ProfileSnapshot(handle)
})

test('source bytes and backup are never modified; handles cannot be copied or serialized', { skip: !isWindows }, context => {
  const f = makeFixture(context), helper = loadHelper(), handle = capture(helper, f)
  for (const fake of [{ ...handle }, JSON.parse(JSON.stringify(handle)), Object.create(handle)]) assert.throws(() => helper.stageM09ProfileSnapshot(fake, { runtimeParent: f.runtime }), code('snapshot-handle-invalid'))
  const other = loadHelper()
  assert.throws(() => other.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-handle-invalid'))
  helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime })
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'settings.json')), f.settingsBytes)
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'Local State')), f.stateBytes)
  assert.equal(fs.readFileSync(path.join(f.source, 'settings.json.bak'), 'utf8'), 'BACKUP-SENTINEL')
  const serialized = JSON.stringify(handle)
  for (const secret of ['ciphertext', fixtureSettings().profiles[0].credential.ciphertext, fixtureState().os_crypt.encrypted_key, 'DROP-LOCAL-STATE-CANARY', 'provider.invalid', 'Synthetic only']) assert.equal(serialized.includes(secret), false)
  helper.releaseM09ProfileSnapshot(handle)
})

test('capture failure consumes the one-read attempt and releases native source locks', { skip: !isWindows }, context => {
  const f = makeFixture(context, Buffer.from('{"schemaVersion":2,"schemaVersion":2}'))
  const spy = fsSpy(), helper = loadHelper({ fs: spy.fs })
  assert.throws(() => capture(helper, f), code('snapshot-settings-json-invalid'))
  fs.writeFileSync(path.join(f.source, 'settings.json'), JSON.stringify(fixtureSettings()))
  assert.throws(() => capture(helper, f), code('snapshot-capture-used'))
  assert.equal(spy.calls.filter(call => call[0] === 'read' && call[1] === path.join(f.source, 'settings.json')).length, 1)
  assert.equal(spy.descriptors.size, 0)
})

test('capture and stage require pre-ready main; release can clear buffers after ready', { skip: !isWindows }, context => {
  const f = makeFixture(context), facade = {}, helper = loadHelper(facade), handle = capture(helper, f)
  facade.ready = true
  assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-before-ready-required'))
  assert.equal(helper.releaseM09ProfileSnapshot(handle), true)
})

test('native held file and ancestor handles block real write/delete/rename races during the read', { skip: !isWindows }, context => {
  const f = makeFixture(context), spy = fsSpy()
  const originalRead = spy.fs.readSync
  let attempted = false
  spy.fs.readSync = (...args) => {
    if (spy.descriptors.get(args[0]) === path.join(f.source, 'settings.json') && !attempted) {
      attempted = true
      for (const operation of [
        () => fs.writeFileSync(path.join(f.source, 'settings.json'), 'RACE-CANARY'),
        () => fs.unlinkSync(path.join(f.source, 'Local State')),
        () => fs.renameSync(f.source, path.join(f.root, 'moved-source')),
        () => fs.renameSync(f.root, `${f.root}-moved`)
      ]) assert.throws(operation, error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
    }
    return originalRead(...args)
  }
  const helper = loadHelper({ fs: spy.fs }), handle = capture(helper, f)
  assert.equal(attempted, true)
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'settings.json')), f.settingsBytes)
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'Local State')), f.stateBytes)
  helper.releaseM09ProfileSnapshot(handle)
})

test('same-file open redirection is rejected by the fd/native identity comparison before a content read', { skip: !isWindows }, context => {
  const f = makeFixture(context), decoy = path.join(f.root, 'decoy.json')
  fs.writeFileSync(decoy, JSON.stringify(fixtureSettings()))
  const spy = fsSpy(), originalOpen = spy.fs.openSync
  spy.fs.openSync = (...args) => originalOpen(...(args[0] === path.join(f.source, 'settings.json') ? [decoy, ...args.slice(1)] : args))
  const helper = loadHelper({ fs: spy.fs })
  assert.throws(() => capture(helper, f), code('snapshot-path-raced'))
  assert.equal(spy.calls.filter(call => call[0] === 'read' && call[1] === decoy).length, 0)
  assert.equal(spy.descriptors.size, 0)
})

test('post-read metadata change is rejected and arbitrary filesystem errors are redacted', { skip: !isWindows }, async context => {
  for (const variant of ['inode', 'mtime', 'throw']) await context.test(variant, child => {
    const f = makeFixture(child), spy = fsSpy(), originalStat = fs.fstatSync
    let number = 0
    spy.fs.fstatSync = (descriptor, ...args) => {
      const value = originalStat(descriptor, ...args)
      if (spy.descriptors.get(descriptor) === path.join(f.source, 'settings.json') && ++number === 2) {
        if (variant === 'throw') throw Object.assign(new Error('PRIVATE-ERROR-CANARY'), { path: 'PRIVATE-PATH-CANARY' })
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, variant === 'inode' ? { ino: value.ino + 1n } : { mtimeNs: value.mtimeNs + 1n })
      }
      return value
    }
    const helper = loadHelper({ fs: spy.fs })
    let caught
    try { capture(helper, f) } catch (error) { caught = error }
    assert.ok(caught)
    assert.equal(caught.code, variant === 'throw' ? 'snapshot-read-failed' : 'snapshot-path-raced')
    for (const secret of ['PRIVATE-ERROR-CANARY', 'PRIVATE-PATH-CANARY', f.source]) assert.equal(`${caught.stack}\n${JSON.stringify(caught)}`.includes(secret), false)
    assert.equal(spy.descriptors.size, 0)
  })
})

test('rejects a junction in any source ancestor and in the runtime parent without following it', { skip: !isWindows }, async context => {
  for (const variant of ['source', 'ancestor', 'runtime']) await context.test(variant, child => {
    const f = makeFixture(child), helper = loadHelper()
    if (variant === 'runtime') {
      const handle = capture(helper, f), target = path.join(f.root, 'outside-runtime')
      fs.mkdirSync(target); fs.rmdirSync(f.runtime); fs.symlinkSync(target, f.runtime, 'junction')
      assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-path-unsafe'))
      assert.deepEqual(fs.readdirSync(target), [])
      helper.releaseM09ProfileSnapshot(handle)
    } else {
      const target = path.join(f.root, 'real-source')
      fs.renameSync(f.source, target)
      fs.symlinkSync(target, f.source, 'junction')
      const directory = variant === 'ancestor' ? path.join(f.source, 'nested') : f.source
      if (variant === 'ancestor') {
        fs.mkdirSync(path.join(target, 'nested'))
        fs.writeFileSync(path.join(target, 'nested', 'settings.json'), f.settingsBytes)
        fs.writeFileSync(path.join(target, 'nested', 'Local State'), f.stateBytes)
      }
      assert.throws(() => helper.captureM09ProfileSnapshot({ settingsDirectory: directory }), code('snapshot-path-unsafe'))
      assert.deepEqual(fs.readFileSync(path.join(target, 'settings.json')), f.settingsBytes)
    }
  })
})

test('rejects hardlinked source files, including settings/Local State sharing the same physical file', { skip: !isWindows }, async context => {
  for (const variant of ['settings', 'state', 'same-file']) await context.test(variant, child => {
    const f = makeFixture(child)
    if (variant === 'same-file') {
      fs.unlinkSync(path.join(f.source, 'Local State'))
      fs.linkSync(path.join(f.source, 'settings.json'), path.join(f.source, 'Local State'))
    } else {
      const source = path.join(f.source, variant === 'settings' ? 'settings.json' : 'Local State')
      fs.linkSync(source, path.join(f.root, 'hardlink'))
    }
    const spy = fsSpy(), helper = loadHelper({ fs: spy.fs })
    assert.throws(() => capture(helper, f), code('snapshot-path-unsafe'))
    assert.equal(spy.calls.filter(call => call[0] === 'read' && [path.join(f.source, 'settings.json'), path.join(f.source, 'Local State')].includes(call[1])).length, 0)
  })
})

test('bounded regular files are required before any content read', { skip: !isWindows }, async context => {
  for (const variant of ['empty', 'settings-large', 'state-large', 'directory', 'missing']) await context.test(variant, child => {
    const f = makeFixture(child)
    const target = path.join(f.source, variant === 'state-large' ? 'Local State' : 'settings.json')
    if (variant === 'empty') fs.writeFileSync(target, '')
    else if (variant.endsWith('large')) fs.writeFileSync(target, Buffer.alloc((variant === 'state-large' ? 4 : 2) * 1024 * 1024 + 1))
    else { fs.unlinkSync(target); if (variant === 'directory') fs.mkdirSync(target) }
    const spy = fsSpy(), helper = loadHelper({ fs: spy.fs })
    assert.throws(() => capture(helper, f), code(['empty', 'settings-large', 'state-large'].includes(variant) ? 'snapshot-file-size-invalid' : 'snapshot-path-unsafe'))
    assert.equal(spy.calls.filter(call => call[0] === 'read' && call[1] === target).length, 0)
  })
})

test('strict UTF-8, decoded duplicate keys, schema, plaintext and ciphertext-format refusal', { skip: !isWindows }, async context => {
  const settings = fixtureSettings(), state = fixtureState()
  const encode = value => Buffer.from(JSON.stringify(value))
  const changedProfile = patch => ({ ...settings, profiles: [{ ...settings.profiles[0], ...patch }] })
  const cases = [
    ['duplicate-root-escaped', Buffer.from(JSON.stringify(settings).replace('"schemaVersion":2', '"schemaVersion":2,"\\u0073chemaVersion":2')), state, 'snapshot-settings-json-invalid'],
    ['duplicate-credential', Buffer.from(JSON.stringify(settings).replace('"version":1', '"version":1,"version":1')), state, 'snapshot-settings-json-invalid'],
    ['malformed-utf8', Buffer.concat([encode(settings), Buffer.from([0xc0, 0xaf])]), state, 'snapshot-settings-json-invalid'],
    ['utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encode(settings)]), state, 'snapshot-settings-json-invalid'],
    ['unpaired-surrogate', changedProfile({ name: '\ud800' }), state, 'snapshot-settings-json-invalid'],
    ['plaintext', changedProfile({ apiKey: 'PRIVATE-PLAINTEXT-CANARY' }), state, 'snapshot-plaintext-refused'],
    ['unselected-plaintext', { ...settings, profiles: [...settings.profiles, { ...settings.profiles[0], id: 'unused-profile', apiKey: 'UNSELECTED-PRIVATE-CANARY' }] }, state, 'snapshot-plaintext-refused'],
    ['unknown-root', { ...settings, privateField: 'PRIVATE-ROOT-CANARY' }, state, 'snapshot-settings-schema-invalid'],
    ['unknown-profile', changedProfile({ api_key: 'PRIVATE-PROFILE-CANARY' }), state, 'snapshot-settings-schema-invalid'],
    ['duplicate-profile-id', { ...settings, profiles: [settings.profiles[0], settings.profiles[0]] }, state, 'snapshot-settings-schema-invalid'],
    ['invalid-output-cap', changedProfile({ maxOutputTokens: 32768 }), state, 'snapshot-settings-schema-invalid'],
    ['endpoint-secret-userinfo', changedProfile({ baseUrl: 'https://PRIVATE-QUERY-CANARY@provider.invalid/' }), state, 'snapshot-settings-schema-invalid'],
    ['noncanonical-ciphertext', changedProfile({ credential: { version: 1, ciphertext: 'djEwAA=' } }), state, 'snapshot-credential-format-invalid'],
    ['unsupported-version', changedProfile({ credential: { ...settings.profiles[0].credential, version: 2 } }), state, 'snapshot-credential-format-invalid'],
    ['duplicate-dropped-local-state', settings, Buffer.from(JSON.stringify(state).replace('"secretCanary":"DROP-LOCAL-STATE-CANARY"', '"x":1,"\\u0078":2')), 'snapshot-local-state-json-invalid'],
    ['bad-local-state-utf8', settings, Buffer.from([0xff]), 'snapshot-local-state-json-invalid'],
    ['app-bound', settings, { os_crypt: { ...state.os_crypt, app_bound_encrypted_key: null } }, 'snapshot-app-bound-unsupported'],
    ['unknown-os-crypt', settings, { os_crypt: { ...state.os_crypt, plaintext: 'LOCAL-PRIVATE-CANARY' } }, 'snapshot-local-state-invalid'],
    ['non-dpapi-key', settings, { os_crypt: { encrypted_key: Buffer.from('unsupported-key-prefix').toString('base64') } }, 'snapshot-local-state-invalid'],
    ['invalid-audit', settings, { os_crypt: { ...state.os_crypt, audit_enabled: 'yes' } }, 'snapshot-local-state-invalid']
  ]
  for (const [name, inputSettings, inputState, expected] of cases) await context.test(name, child => {
    const f = makeFixture(child, inputSettings, inputState), helper = loadHelper()
    let caught
    try { capture(helper, f) } catch (error) { caught = error }
    assert.ok(caught)
    assert.equal(caught.code, expected)
    const result = `${caught.stack}\n${JSON.stringify(caught)}`
    for (const canary of ['PRIVATE-PLAINTEXT-CANARY', 'UNSELECTED-PRIVATE-CANARY', 'PRIVATE-ROOT-CANARY', 'PRIVATE-PROFILE-CANARY', 'PRIVATE-QUERY-CANARY', 'LOCAL-PRIVATE-CANARY', f.source, settings.profiles[0].credential.ciphertext, state.os_crypt.encrypted_key]) assert.equal(result.includes(canary), false)
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'settings.json')), f.settingsBytes)
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'Local State')), f.stateBytes)
  })
})

test('optional profile fields remain absent and no derived defaults or caps are invented', { skip: !isWindows }, context => {
  const settings = fixtureSettings()
  for (const field of ['protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens']) delete settings.profiles[0][field]
  const f = makeFixture(context, settings), helper = loadHelper(), handle = capture(helper, f)
  assert.deepEqual(Object.keys(handle.selectedProfile).sort(), ['profileId', 'model', 'savedBaseUrlSha256'].sort())
  helper.releaseM09ProfileSnapshot(handle)
})

test('lexical device, UNC, ADS, traversal and overlap paths are refused without source access', { skip: !isWindows }, async context => {
  const paths = ['relative', '\\\\server\\share\\fixture', '\\\\?\\C:\\fixture', 'C:\\fixture:stream', 'C:\\fixture\\..\\settings', 'C:\\fixture\\CON', 'C:\\fixture.\\settings', 'C:/fixture/settings', 'C:\\fixture\\settings\\']
  for (const input of paths) {
    const spy = fsSpy(), helper = loadHelper({ fs: spy.fs })
    assert.throws(() => helper.captureM09ProfileSnapshot({ settingsDirectory: input }), code('snapshot-path-unsafe'))
    assert.equal(spy.calls.length, 0)
  }
  for (const variant of ['source-child', 'source', 'ancestor']) await context.test(variant, child => {
    const f = makeFixture(child), helper = loadHelper(), handle = capture(helper, f)
    const runtimeParent = variant === 'source-child' ? path.join(f.source, 'runtime') : variant === 'source' ? f.source : f.root
    assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent }), code('snapshot-path-overlap'))
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'settings.json')), f.settingsBytes)
    helper.releaseM09ProfileSnapshot(handle)
  })
})

test('exclusive directory collision and file collision never overwrite existing content', { skip: !isWindows }, async context => {
  await context.test('directory collision', child => {
    const f = makeFixture(child), fixedCrypto = Object.create(crypto)
    fixedCrypto.randomBytes = size => Buffer.alloc(size, 0x58)
    const helper = loadHelper({ crypto: fixedCrypto }), handle = capture(helper, f)
    const expected = path.join(f.runtime, `m09-profile-${Buffer.alloc(24, 0x58).toString('hex')}`)
    fs.mkdirSync(expected); fs.writeFileSync(path.join(expected, 'sentinel'), 'KEEP-COLLISION-SENTINEL')
    assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-path-unsafe'))
    assert.deepEqual(fs.readdirSync(expected), ['sentinel'])
    assert.equal(fs.readFileSync(path.join(expected, 'sentinel'), 'utf8'), 'KEEP-COLLISION-SENTINEL')
    helper.releaseM09ProfileSnapshot(handle)
  })
  await context.test('file collision', child => {
    const f = makeFixture(child), spy = fsSpy(), open = spy.fs.openSync
    let target
    spy.fs.openSync = (...args) => {
      if (typeof args[0] === 'string' && args[0].endsWith(`${path.sep}session-data${path.sep}Local State`)) {
        target = args[0]
        assert.equal(Boolean(args[1] & fs.constants.O_EXCL), true)
        fs.writeFileSync(target, 'KEEP-FILE-SENTINEL', { flag: 'wx' })
      }
      return open(...args)
    }
    const helper = loadHelper({ fs: spy.fs }), handle = capture(helper, f)
    assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-stage-failed'))
    assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP-FILE-SENTINEL')
    assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-stage-used'))
    helper.releaseM09ProfileSnapshot(handle)
  })
})

test('file fsync failure is fail-closed, redacted and leaves original data unchanged', { skip: !isWindows }, context => {
  const f = makeFixture(context), spy = fsSpy()
  spy.fs.fsyncSync = () => { throw Object.assign(new Error('PRIVATE-FSYNC-CANARY'), { path: f.source }) }
  const helper = loadHelper({ fs: spy.fs }), handle = capture(helper, f)
  let caught
  try { helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }) } catch (error) { caught = error }
  assert.ok(caught)
  assert.equal(caught.code, 'snapshot-stage-failed')
  assert.equal(`${caught.stack}\n${JSON.stringify(caught)}`.includes('PRIVATE-FSYNC-CANARY'), false)
  assert.equal(`${caught.stack}\n${JSON.stringify(caught)}`.includes(f.source), false)
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'settings.json')), f.settingsBytes)
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'Local State')), f.stateBytes)
  assert.equal(spy.descriptors.size, 0)
  helper.releaseM09ProfileSnapshot(handle)
})

test('option accessor failures cannot disclose arbitrary thrown content', { skip: !isWindows }, () => {
  const helper = loadHelper()
  assert.throws(() => helper.captureM09ProfileSnapshot({ get settingsDirectory() { throw new Error('PRIVATE-OPTIONS-CANARY') } }), code('snapshot-capture-failed'))
})

test('unselected profiles may omit a credential; selecting that profile fails without any usable profile', { skip: !isWindows }, async context => {
  const settings = fixtureSettings()
  const uncredentialed = { ...settings.profiles[0], id: 'no-key-profile' }
  delete uncredentialed.credential
  settings.profiles.push(uncredentialed)
  await context.test('unselected optional credential', child => {
    const f = makeFixture(child, settings), helper = loadHelper(), handle = capture(helper, f)
    assert.equal(handle.selectedProfile.profileId, 'fixture-primary')
    const staged = helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime })
    assert.deepEqual(fs.readFileSync(path.join(staged.userData, 'settings.json')), f.settingsBytes)
    helper.releaseM09ProfileSnapshot(handle)
  })
  await context.test('selected missing credential', child => {
    const f = makeFixture(child, settings), helper = loadHelper()
    assert.throws(() => capture(helper, f, 'no-key-profile'), code('snapshot-credential-missing'))
  })
})

test('canonical ciphertext has no guessed native header policy and remains explicitly unverified', { skip: !isWindows }, context => {
  const settings = fixtureSettings()
  settings.profiles[0].credential.ciphertext = Buffer.from('SYNTHETIC-UNAUTHENTICATED-CIPHERTEXT').toString('base64')
  settings.profiles[0].baseUrl = 'https://provider.invalid/v1?token=QUERY-PRIVATE-CANARY#fragment'
  const f = makeFixture(context, settings), helper = loadHelper(), handle = capture(helper, f)
  assert.equal(handle.credentialState, 'encrypted-unverified')
  const staged = helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime })
  assert.equal(staged.credentialState, 'encrypted-unverified')
  assert.deepEqual(fs.readFileSync(path.join(staged.userData, 'settings.json')), f.settingsBytes)
  for (const secret of ['SYNTHETIC-UNAUTHENTICATED-CIPHERTEXT', settings.profiles[0].credential.ciphertext, 'QUERY-PRIVATE-CANARY', settings.profiles[0].baseUrl]) assert.equal(`${JSON.stringify(handle)}\n${JSON.stringify(staged)}`.includes(secret), false)
  assert.equal(Object.hasOwn(staged, 'profile'), false)
  assert.equal(Object.hasOwn(staged, 'apiKey'), false)
  helper.releaseM09ProfileSnapshot(handle)
})

test('guarded staged readback rejects same-size mutations made before final metadata was captured', { skip: !isWindows }, async context => {
  for (const [directory, name] of [['user-data', 'settings.json'], ['session-data', 'Local State']]) {
    await context.test(name, child => {
      const f = makeFixture(child), spy = fsSpy(), originalFsync = fs.fsyncSync
      let mutated = false
      spy.fs.fsyncSync = descriptor => {
        originalFsync(descriptor)
        const target = spy.descriptors.get(descriptor)
        if (typeof target === 'string' && target.endsWith(`${path.sep}${directory}${path.sep}${name}`)) {
          fs.writeFileSync(target, Buffer.alloc(fs.fstatSync(descriptor).size, 0x78))
          mutated = true
        }
      }
      const helper = loadHelper({ fs: spy.fs }), handle = capture(helper, f)
      assert.throws(() => helper.stageM09ProfileSnapshot(handle, { runtimeParent: f.runtime }), code('snapshot-staged-bytes-mismatch'))
      assert.equal(mutated, true)
      assert.deepEqual(fs.readFileSync(path.join(f.source, name)), name === 'settings.json' ? f.settingsBytes : f.stateBytes)
      assert.equal(spy.descriptors.size, 0)
      helper.releaseM09ProfileSnapshot(handle)
    })
  }
})


test('explicit selection supports an unset saved default without inventing a default selection', { skip: !isWindows }, async context => {
  for (const variant of ['missing', 'null']) await context.test(variant, child => {
    const settings = fixtureSettings()
    if (variant === 'missing') delete settings.defaultProfileId
    else settings.defaultProfileId = null
    const f = makeFixture(child, settings), helper = loadHelper(), handle = capture(helper, f, 'fixture-primary')
    assert.equal(handle.selectedProfile.profileId, 'fixture-primary')
    helper.releaseM09ProfileSnapshot(handle)
    assert.throws(() => capture(loadHelper(), f), code('snapshot-default-profile-missing'))
  })
})
