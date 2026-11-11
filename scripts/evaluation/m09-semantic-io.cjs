'use strict'

// Runtime I/O only. No authority is conferred by a path, JSON value or identity.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const MAX_CONTROL_BYTES = 2 * 1024 * 1024
const SAFE_CODES = new Set([
  'semantic-native-main-required', 'semantic-native-before-ready-required', 'semantic-native-context-required',
  'semantic-native-context-used', 'semantic-native-profile-mismatch', 'semantic-native-profile-unavailable',
  'semantic-native-bootstrap-failed', 'semantic-native-prepare-failed', 'semantic-native-execution-failed',
  'semantic-native-grant-invalid', 'semantic-native-handshake-invalid', 'semantic-native-handshake-timeout',
  'semantic-native-runtime-unsafe', 'semantic-native-control-invalid', 'semantic-native-source-mismatch',
  'semantic-native-child-failed', 'semantic-native-child-timeout', 'semantic-native-child-closed',
  'semantic-native-launch-failed', 'semantic-native-arguments-invalid', 'semantic-native-parent-proof-required',
  'semantic-native-parent-proof-mismatch', 'semantic-native-provenance-invalid', 'semantic-native-cleanup-preserved',
  'semantic-source-dirty', 'semantic-source-changed', 'semantic-source-unavailable', 'semantic-output-exists'
])
function fail(code) { throw Object.assign(new Error(code), { code }) }
function safeCode(error, fallback = 'semantic-native-launch-failed') { return SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : fallback }
function check(value, code = 'semantic-native-control-invalid') { if (!value) fail(code) }
function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype }
function exact(value, required, optional = []) {
  check(plain(value) && required.every(key => Object.hasOwn(value, key)))
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    check(typeof key === 'string' && (required.includes(key) || optional.includes(key)) && descriptor && 'value' in descriptor && descriptor.enumerable)
  }
  return value
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  check(value === null || ['string', 'number', 'boolean'].includes(typeof value))
  check(typeof value !== 'number' || Number.isFinite(value))
  return JSON.stringify(value)
}
function bytes(value) { return Buffer.from(canonical(value) + '\n', 'utf8') }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function hash(value) { return sha256(Buffer.from(canonical(value), 'utf8')) }
function frozen(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value) } return value }
function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right }
function within(parent, child) { const relative = path.relative(parent, child); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
function overlaps(left, right) { return samePath(left, right) || within(left, right) || within(right, left) }
function absolute(value) {
  check(typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value), 'semantic-native-runtime-unsafe')
  check(samePath(path.resolve(value), value), 'semantic-native-runtime-unsafe')
  if (process.platform === 'win32') check(/^[A-Za-z]:\\/u.test(value) && !value.slice(3).split('\\').some(part => !part || /[:*?<>|"/]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)), 'semantic-native-runtime-unsafe')
  return value
}
function identity(stat) { check(stat.dev > 0n && stat.ino > 0n, 'semantic-native-runtime-unsafe'); return { dev: String(stat.dev), ino: String(stat.ino) } }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino }
// lstat recognizes symlink/junctions; the native attribute check also rejects other
// Windows reparse tags. Paths travel over stdin and never enter a command string.
function nativePlain(paths) {
  if (process.platform !== 'win32') return
  const script = '$ErrorActionPreference="Stop";$p=ConvertFrom-Json ([Console]::In.ReadToEnd());foreach($v in $p){if(([IO.File]::GetAttributes($v) -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 1}};[Console]::Out.Write("ok")'
  const result = spawnSync(path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: JSON.stringify(paths), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096 })
  check(!result.error && result.status === 0 && result.stdout === 'ok', 'semantic-native-runtime-unsafe')
}
function directory(value) {
  const resolved = absolute(value)
  let cursor = path.parse(resolved).root
  const chain = [cursor]
  for (const component of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, component); chain.push(cursor) }
  const records = chain.map(filename => { const stat = fs.lstatSync(filename, { bigint: true }); check(stat.isDirectory() && !stat.isSymbolicLink(), 'semantic-native-runtime-unsafe'); return { filename, identity: identity(stat) } })
  nativePlain(chain)
  check(samePath(fs.realpathSync(resolved), resolved), 'semantic-native-runtime-unsafe')
  for (const record of records) { const stat = fs.lstatSync(record.filename, { bigint: true }); check(stat.isDirectory() && !stat.isSymbolicLink() && sameIdentity(identity(stat), record.identity), 'semantic-native-runtime-unsafe') }
  return records.at(-1).identity
}
function file(value, maximum = MAX_CONTROL_BYTES) {
  absolute(value); directory(path.dirname(value))
  const stat = fs.lstatSync(value, { bigint: true })
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= BigInt(maximum), 'semantic-native-runtime-unsafe')
  nativePlain([value])
  return { identity: identity(stat), size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}
function read(value, maximum = MAX_CONTROL_BYTES) {
  const before = file(value, maximum)
  const descriptor = fs.openSync(value, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true })
    check(sameIdentity(before.identity, identity(stat)) && stat.nlink === 1n && stat.size === BigInt(before.size), 'semantic-native-runtime-unsafe')
    const result = Buffer.alloc(before.size)
    let offset = 0
    while (offset < result.length) { const count = fs.readSync(descriptor, result, offset, result.length - offset, null); check(count > 0, 'semantic-native-control-invalid'); offset += count }
    const after = file(value, maximum)
    const held = fs.fstatSync(descriptor, { bigint: true })
    check(sameIdentity(before.identity, after.identity) && held.nlink === 1n && sameIdentity(before.identity, identity(held)) && held.size === BigInt(before.size) && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'semantic-native-runtime-unsafe')
    return result
  } finally { fs.closeSync(descriptor) }
}
function json(value, maximum = MAX_CONTROL_BYTES) {
  const raw = read(value, maximum)
  let result
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { fail('semantic-native-control-invalid') }
  check(raw.equals(bytes(result)), 'semantic-native-control-invalid')
  return result
}
function write(value, raw, maximum = MAX_CONTROL_BYTES) {
  check(Buffer.isBuffer(raw) && raw.length <= maximum, 'semantic-native-control-invalid')
  directory(path.dirname(absolute(value)))
  const descriptor = fs.openSync(value, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
  try {
    const initial = fs.fstatSync(descriptor, { bigint: true }); check(initial.isFile() && initial.nlink === 1n && initial.size === 0n, 'semantic-native-runtime-unsafe')
    fs.writeFileSync(descriptor, raw); fs.fsyncSync(descriptor)
    const held = fs.fstatSync(descriptor, { bigint: true }); const named = fs.lstatSync(value, { bigint: true })
    check(held.nlink === 1n && named.nlink === 1n && sameIdentity(identity(initial), identity(held)) && sameIdentity(identity(held), identity(named)), 'semantic-native-runtime-unsafe')
  } finally { fs.closeSync(descriptor) }
  check(read(value, maximum).equals(raw), 'semantic-native-control-invalid')
}
function mkdir(value) { directory(path.dirname(absolute(value))); fs.mkdirSync(value, { mode: 0o700 }); return directory(value) }

// Read exactly one bounded JSON line AND EOF. A replay/extra/late line can never
// authorize a dispatch merely because the first line looked valid.
function oneMessage(stream, { maximum = MAX_CONTROL_BYTES, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let raw = Buffer.alloc(0), settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timeout); stream.off('data', data); stream.off('end', end); stream.off('error', errorEvent); stream.off('close', close); error ? reject(error) : resolve(value) }
    const rejected = code => Object.assign(new Error(code), { code })
    const data = chunk => { raw = Buffer.concat([raw, Buffer.from(chunk)]); if (raw.length > maximum) finish(rejected('semantic-native-handshake-invalid')) }
    const end = () => { try { check(raw.length > 1 && raw.at(-1) === 10 && raw.subarray(0, -1).indexOf(10) === -1, 'semantic-native-handshake-invalid'); const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); check(raw.equals(bytes(value)), 'semantic-native-handshake-invalid'); finish(null, value) } catch { finish(rejected('semantic-native-handshake-invalid')) } }
    const errorEvent = () => finish(rejected('semantic-native-handshake-invalid'))
    const close = () => { if (!stream.readableEnded) finish(rejected('semantic-native-child-closed')) }
    const timeout = setTimeout(() => finish(rejected('semantic-native-handshake-timeout')), timeoutMs)
    stream.on('data', data); stream.once('end', end); stream.once('error', errorEvent); stream.once('close', close)
  })
}
module.exports = { MAX_CONTROL_BYTES, fail, check, safeCode, exact, canonical, bytes, sha256, hash, frozen, samePath, within, overlaps, absolute, identity, sameIdentity, directory, file, read, json, write, mkdir, oneMessage }
