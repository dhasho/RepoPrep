'use strict'

// Main-only encrypted snapshot transport. It never decrypts or authenticates a credential.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { TextDecoder } = require('node:util')

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024
const MAX_LOCAL_STATE_BYTES = 4 * 1024 * 1024
const MAX_ENCODED_CREDENTIAL_BYTES = 64 * 1024
const snapshots = new WeakMap()
const ownErrors = new WeakSet()
let captureUsed = false

function fail(code) {
  const error = new Error(code)
  error.name = 'M09ProfileSnapshotError'
  Object.defineProperty(error, 'code', { value: code, enumerable: true })
  ownErrors.add(error)
  throw error
}
function redact(error, fallback) {
  if (error && ownErrors.has(error)) throw error
  fail(fallback)
}
function assertNativeMain(beforeReady) {
  if (process.platform !== 'win32' || process.type !== 'browser' || typeof process.versions.electron !== 'string') fail('snapshot-native-main-required')
  let app
  try { app = require('electron').app } catch { fail('snapshot-native-main-required') }
  if (!app || typeof app.isReady !== 'function') fail('snapshot-native-main-required')
  let ready
  try { ready = app.isReady() } catch { fail('snapshot-native-main-required') }
  if (beforeReady && ready) fail('snapshot-before-ready-required')
}
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function exactKeys(value, permitted) { return plainObject(value) && Object.keys(value).every(key => permitted.includes(key)) }
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino }
function identity(stat) {
  if (stat.dev <= 0n || stat.ino <= 0n) fail('snapshot-path-unsafe')
  return { dev: stat.dev, ino: stat.ino }
}
function normalize(value) { return value.replace(/[\\/]+$/u, '').toLowerCase() }
function within(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
function absolutePlainPath(value) {
  // Reject normalization-dependent, device, UNC, ADS, DOS alias and trailing-dot paths.
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z]:\\/u.test(value) || /[\u0000-\u001f\u007f/]/u.test(value)) fail('snapshot-path-unsafe')
  const parts = value.slice(3).split('\\')
  if (parts.some(part => !part || part === '.' || part === '..' || /[:*?<>|"]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    if (!(value.length === 3 && parts.length === 1 && parts[0] === '')) fail('snapshot-path-unsafe')
  }
  const resolved = path.resolve(value)
  if (normalize(resolved) !== normalize(value)) fail('snapshot-path-unsafe')
  return resolved
}
function pathChain(directory) {
  const root = path.parse(directory).root
  const result = [root]
  let current = root
  for (const component of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    result.push(current)
  }
  return result
}

// Held native handles deny write/delete sharing, including changes to ancestor
// reparse points. OPEN_REPARSE_POINT inspects the object itself, for every tag.
// This bridge receives paths and returns numeric metadata, never file content.
const NATIVE_GUARD = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.IO; using System.IO.Pipes; using System.Text;
using System.Security.AccessControl; using System.Security.Principal;
using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class M09PathGuard {
 [StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [StructLayout(LayoutKind.Sequential)] struct SA { public int Length; public IntPtr Descriptor; public int Inherit; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle h,out uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string p,ref SA sa);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s,uint revision,out IntPtr sd,out uint size);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public sealed class Entry : IDisposable { public SafeFileHandle Handle; public Info Before; public string Path; public bool Directory; public void Dispose(){ if(Handle!=null)Handle.Dispose(); } }
 static void Check(bool condition){ if(!condition)throw new Exception("guard"); }
 static Info Inspect(Entry e) { Info i; Check(GetFileInformationByHandle(e.Handle,out i)); Check(GetFileType(e.Handle)==1); Check((i.Attributes&0x400)==0); Check(((i.Attributes&0x10)!=0)==e.Directory); Check(e.Directory||i.Links==1); Check(i.IndexHigh!=0||i.IndexLow!=0); var b=new StringBuilder(8192); uint n=GetFinalPathNameByHandleW(e.Handle,b,8192,0); Check(n>0&&n<8192); string actual=b.ToString(); if(actual.StartsWith(@"\\?\"))actual=actual.Substring(4); Check(String.Equals(actual.TrimEnd('\\'),e.Path.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)); return i; }
 public static Entry Lock(string p,bool directory) { var e=new Entry{Path=p,Directory=directory}; e.Handle=CreateFileW(p,0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero); try{Check(!e.Handle.IsInvalid);e.Before=Inspect(e);return e;}catch{e.Dispose();throw;} }
 public static void Verify(Entry e){ Info i=Inspect(e), b=e.Before; Check(i.Volume==b.Volume&&i.IndexHigh==b.IndexHigh&&i.IndexLow==b.IndexLow); if(!e.Directory)Check(i.SizeHigh==b.SizeHigh&&i.SizeLow==b.SizeLow&&i.WriteHigh==b.WriteHigh&&i.WriteLow==b.WriteLow&&i.CreationHigh==b.CreationHigh&&i.CreationLow==b.CreationLow); }
 public static string Metadata(Entry e){Info i=Inspect(e);ulong ino=((ulong)i.IndexHigh<<32)|i.IndexLow;ulong size=((ulong)i.SizeHigh<<32)|i.SizeLow;return "{\"ok\":true,\"dev\":\""+i.Volume+"\",\"ino\":\""+ino+"\",\"size\":\""+size+"\",\"links\":\""+i.Links+"\"}";}
 public static Entry MakeDirectory(string p){ IntPtr sd=IntPtr.Zero;uint n; string sid=WindowsIdentity.GetCurrent().User.Value; Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;OICI;FA;;;"+sid+")",1,out sd,out n)); try{var sa=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=sd,Inherit=0};Check(CreateDirectoryW(p,ref sa));}finally{if(sd!=IntPtr.Zero)LocalFree(sd);}return Lock(p,true); }
 public static void Client(NamedPipeServerStream pipe,uint expected){uint pid;Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid)&&pid==expected);}
 public static System.Threading.Timer Watchdog(){return new System.Threading.Timer(delegate(object unused){Environment.Exit(73);},null,25000,System.Threading.Timeout.Infinite);}
}
"@
$security=New-Object System.IO.Pipes.PipeSecurity
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$security.SetAccessRuleProtection($true,$false)
$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sid,[System.IO.Pipes.PipeAccessRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)))
$pipe=New-Object System.IO.Pipes.NamedPipeServerStream('__PIPE__',[System.IO.Pipes.PipeDirection]::InOut,1,[System.IO.Pipes.PipeTransmissionMode]::Byte,[System.IO.Pipes.PipeOptions]::None,4096,4096,$security)
$entries=New-Object 'System.Collections.Generic.List[M09PathGuard+Entry]'
$watchdog=[M09PathGuard]::Watchdog()
try {
 if(-not $pipe.WaitForConnectionAsync().Wait(15000)){throw 'guard'}
 [M09PathGuard]::Client($pipe,__PID__)
 $reader=New-Object System.IO.StreamReader($pipe,(New-Object System.Text.UTF8Encoding($false,$true)),$false,4096,$true)
 $writer=New-Object System.IO.StreamWriter($pipe,(New-Object System.Text.UTF8Encoding($false)),4096,$true)
 $writer.AutoFlush=$true
 while($true){
  $line=$reader.ReadLine(); if($null -eq $line -or $line.Length -gt 20000){throw 'guard'}
  $request=ConvertFrom-Json $line
  if($request.op -eq 'release'){foreach($entry in $entries){$entry.Dispose()};$entries.Clear();$writer.WriteLine('{"ok":true}');break}
  if($request.op -eq 'verify'){foreach($entry in $entries){[M09PathGuard]::Verify($entry)};$writer.WriteLine('{"ok":true}');continue}
  if($entries.Count -ge 256){throw 'guard'}
  if($request.op -eq 'lock'){$entry=[M09PathGuard]::Lock([string]$request.path,[bool]$request.directory)}
  elseif($request.op -eq 'mkdir'){$entry=[M09PathGuard]::MakeDirectory([string]$request.path)}
  else{throw 'guard'}
  $entries.Add($entry);$writer.WriteLine([M09PathGuard]::Metadata($entry))
 }
} catch {try{$writer.WriteLine('{"ok":false}')}catch{}} finally {foreach($entry in $entries){$entry.Dispose()};$pipe.Dispose();$watchdog.Dispose()}
`

function startGuard() {
  let child, descriptor
  try {
    const windows = absolutePlainPath(process.env.SystemRoot || '')
    const executable = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (normalize(windows) !== normalize(path.parse(windows).root + 'Windows')) fail('snapshot-guard-unavailable')
    const name = `repoprep-m09-snapshot-${process.pid}-${crypto.randomBytes(24).toString('hex')}`
    const script = NATIVE_GUARD.replace('__PIPE__', name).replace('__PID__', String(process.pid))
    child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: 'ignore', env: { SystemRoot: windows, WINDIR: windows, TEMP: process.env.TEMP || windows, TMP: process.env.TMP || windows }
    })
    child.on('error', () => {})
    child.unref()
    const deadline = Date.now() + 15_000
    const waiter = new Int32Array(new SharedArrayBuffer(4))
    while (descriptor === undefined) {
      try { descriptor = fs.openSync(`\\\\.\\pipe\\${name}`, 'r+') } catch (error) {
        if (!['ENOENT', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) fail('snapshot-guard-unavailable')
        Atomics.wait(waiter, 0, 0, 10)
      }
    }
    const request = message => {
      const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
      let written = 0
      while (written < bytes.length) {
        const count = fs.writeSync(descriptor, bytes, written, bytes.length - written)
        if (count < 1) fail('snapshot-guard-unavailable')
        written += count
      }
      const response = Buffer.alloc(1024)
      let length = 0
      while (length < response.length) {
        const read = fs.readSync(descriptor, response, length, 1, null)
        if (read !== 1) fail('snapshot-path-unsafe')
        if (response[length++] === 10) break
      }
      if (length === response.length) fail('snapshot-path-unsafe')
      const value = JSON.parse(response.subarray(0, length).toString('utf8'))
      if (value.ok !== true) fail('snapshot-path-unsafe')
      return value
    }
    let closed = false
    return {
      lock(filename, directory) { return request({ op: 'lock', path: filename, directory }) },
      mkdir(filename) { return request({ op: 'mkdir', path: filename }) },
      verify() { request({ op: 'verify' }) },
      close() {
        if (closed) return
        closed = true
        try { request({ op: 'release' }) } finally { fs.closeSync(descriptor); descriptor = undefined }
      }
    }
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    if (child) child.kill()
    redact(error, 'snapshot-guard-unavailable')
  }
}
function assertMetadata(stat, native, directory) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1n)) fail('snapshot-path-unsafe')
  const current = identity(stat)
  if (current.dev !== BigInt(native.dev) || current.ino !== BigInt(native.ino) || (!directory && (stat.size !== BigInt(native.size) || BigInt(native.links) !== 1n))) fail('snapshot-path-raced')
}
function lockDirectories(guard, directory) {
  const locked = []
  for (const filename of pathChain(directory)) {
    const native = guard.lock(filename, true)
    const stat = fs.lstatSync(filename, { bigint: true })
    assertMetadata(stat, native, true)
    if (normalize(fs.realpathSync.native(filename)) !== normalize(filename)) fail('snapshot-path-unsafe')
    locked.push({ filename, stat, native })
  }
  return locked
}
function verifyDirectories(entries) {
  for (const { filename, stat, native } of entries) {
    const now = fs.lstatSync(filename, { bigint: true })
    assertMetadata(now, native, true)
    if (!sameIdentity(identity(stat), identity(now)) || normalize(fs.realpathSync.native(filename)) !== normalize(filename)) fail('snapshot-path-raced')
  }
}
function lockSource(guard, filename, maxBytes) {
  const native = guard.lock(filename, false)
  const stat = fs.lstatSync(filename, { bigint: true })
  assertMetadata(stat, native, false)
  if (stat.size <= 0n || stat.size > BigInt(maxBytes)) fail('snapshot-file-size-invalid')
  return { filename, stat, native }
}
function readSource(entry) {
  let descriptor, bytes
  try {
    descriptor = fs.openSync(entry.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const before = fs.fstatSync(descriptor, { bigint: true })
    assertMetadata(before, entry.native, false)
    if (!sameIdentity(identity(before), identity(entry.stat))) fail('snapshot-path-raced')
    bytes = Buffer.alloc(Number(before.size) + 1)
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const current = fs.lstatSync(entry.filename, { bigint: true })
    for (const stat of [after, current]) {
      assertMetadata(stat, entry.native, false)
      if (stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || stat.birthtimeNs !== before.birthtimeNs) fail('snapshot-path-raced')
    }
    if (count !== Number(before.size)) fail('snapshot-path-raced')
    return bytes.subarray(0, count)
  } catch (error) {
    if (bytes) bytes.fill(0)
    redact(error, 'snapshot-read-failed')
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}

function strictJson(bytes, code) {
  let input
  try { input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { fail(code) }
  if (input.charCodeAt(0) === 0xfeff) fail(code)
  // JSON.parse accepts duplicate members. Compare decoded keys at every depth.
  let offset = 0, nodes = 0
  const whitespace = () => { while (/[\t\r\n ]/u.test(input[offset] || '\0')) offset++ }
  const string = () => {
    if (input[offset++] !== '"') fail(code)
    const start = offset - 1
    while (offset < input.length) {
      const char = input[offset++]
      if (char === '"') {
        let value
        try { value = JSON.parse(input.slice(start, offset)) } catch { fail(code) }
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail(code)
        return value
      }
      if (char === '\\') {
        const escape = input[offset++]
        if (escape === 'u') { if (!/^[0-9a-fA-F]{4}$/u.test(input.slice(offset, offset + 4))) fail(code); offset += 4 }
        else if (!'"\\/bfnrt'.includes(escape || '\0')) fail(code)
      } else if (char.charCodeAt(0) < 32) fail(code)
    }
    fail(code)
  }
  const value = depth => {
    if (++nodes > 100_000 || depth > 32) fail(code)
    whitespace()
    const char = input[offset]
    if (char === '"') { string(); return }
    if (char === '{' || char === '[') {
      const object = char === '{', end = object ? '}' : ']'
      offset++; whitespace()
      const keys = new Set()
      if (input[offset] === end) { offset++; return }
      while (offset < input.length) {
        if (object) {
          whitespace(); const key = string()
          if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(code)
          keys.add(key); whitespace(); if (input[offset++] !== ':') fail(code)
        }
        value(depth + 1); whitespace()
        if (input[offset] === end) { offset++; return }
        if (input[offset++] !== ',') fail(code)
      }
      fail(code)
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(input.slice(offset))
    if (!match) fail(code)
    offset += match[0].length
  }
  value(0); whitespace(); if (offset !== input.length) fail(code)
  try { return JSON.parse(input) } catch { fail(code) }
}
function canonicalBase64(value, max) {
  if (typeof value !== 'string' || !value || value.length > max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) { decoded.fill(0); return null }
  return decoded
}
function validateSettings(bytes, requestedId) {
  const settings = strictJson(bytes, 'snapshot-settings-json-invalid')
  if (!exactKeys(settings, ['profiles', 'defaultProfileId', 'scanLimits', 'schemaVersion']) || settings.schemaVersion !== 2 || !Array.isArray(settings.profiles) || settings.profiles.length < 1 || settings.profiles.length > 32) fail('snapshot-settings-schema-invalid')
  const ids = new Set()
  for (const profile of settings.profiles) {
    if (plainObject(profile) && Object.hasOwn(profile, 'apiKey')) fail('snapshot-plaintext-refused')
    if (!exactKeys(profile, ['id', 'name', 'baseUrl', 'credential', 'model', 'protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens']) || !text(profile.id, 128) || ids.has(profile.id) || !text(profile.name, 256) || !text(profile.baseUrl, 2048) || !text(profile.model, 256)) fail('snapshot-settings-schema-invalid')
    ids.add(profile.id)
    let url
    try { url = new URL(profile.baseUrl) } catch { fail('snapshot-settings-schema-invalid') }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('snapshot-settings-schema-invalid')
    if (profile.protocol !== undefined && !['openai', 'anthropic'].includes(profile.protocol)) fail('snapshot-settings-schema-invalid')
    if (profile.reasoningEffort !== undefined && (!['low', 'high'].includes(profile.reasoningEffort) || profile.protocol === 'anthropic')) fail('snapshot-settings-schema-invalid')
    if (profile.temperature !== undefined && (typeof profile.temperature !== 'number' || !Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2)) fail('snapshot-settings-schema-invalid')
    if (profile.contextWindowTokens !== undefined && (!Number.isInteger(profile.contextWindowTokens) || profile.contextWindowTokens < 4096 || profile.contextWindowTokens > 2097152)) fail('snapshot-settings-schema-invalid')
    if (profile.maxOutputTokens !== undefined && (!Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 256 || profile.maxOutputTokens > 393216 || (profile.contextWindowTokens !== undefined && profile.maxOutputTokens >= profile.contextWindowTokens))) fail('snapshot-settings-schema-invalid')
    // Unselected saved profiles may have no credential. Validate records that
    // are present, without inventing native cipher headers or authentication.
    if (profile.credential !== undefined) {
      if (!exactKeys(profile.credential, ['version', 'ciphertext']) || profile.credential.version !== 1) fail('snapshot-credential-format-invalid')
      const ciphertext = canonicalBase64(profile.credential.ciphertext, MAX_ENCODED_CREDENTIAL_BYTES)
      const valid = ciphertext && ciphertext.length > 0
      if (ciphertext) ciphertext.fill(0)
      if (!valid) fail('snapshot-credential-format-invalid')
    }
  }
  if (settings.defaultProfileId !== undefined && settings.defaultProfileId !== null && (!text(settings.defaultProfileId, 128) || !ids.has(settings.defaultProfileId))) fail('snapshot-settings-schema-invalid')
  if (settings.scanLimits !== undefined) {
    const bounds = { maxFiles: [1, 250000], maxTreeNodes: [1, 500000], maxContentFileBytes: [1024, 8388608] }
    if (!exactKeys(settings.scanLimits, Object.keys(bounds))) fail('snapshot-settings-schema-invalid')
    for (const [key, val] of Object.entries(settings.scanLimits)) if (!Number.isInteger(val) || val < bounds[key][0] || val > bounds[key][1]) fail('snapshot-settings-schema-invalid')
  }
  if (requestedId !== undefined && !text(requestedId, 128)) fail('snapshot-profile-invalid')
  if (requestedId === undefined && !text(settings.defaultProfileId, 128)) fail('snapshot-default-profile-missing')
  const selected = settings.profiles.find(profile => profile.id === (requestedId === undefined ? settings.defaultProfileId : requestedId))
  if (!selected) fail('snapshot-profile-missing')
  if (selected.credential === undefined) fail('snapshot-credential-missing')
  const metadata = {
    profileId: selected.id, model: selected.model,
    savedBaseUrlSha256: crypto.createHash('sha256').update('repoprep:m09:saved-base-url:v1\0').update(selected.baseUrl, 'utf8').digest('hex')
  }
  for (const key of ['protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens']) if (selected[key] !== undefined) metadata[key] = selected[key]
  return Object.freeze(metadata)
}
function sanitizeLocalState(bytes) {
  const state = strictJson(bytes, 'snapshot-local-state-json-invalid')
  if (!plainObject(state) || !plainObject(state.os_crypt)) fail('snapshot-local-state-invalid')
  const section = state.os_crypt
  if (Object.hasOwn(section, 'app_bound_encrypted_key')) fail('snapshot-app-bound-unsupported')
  if (Object.keys(section).some(key => !['encrypted_key', 'audit_enabled'].includes(key))) fail('snapshot-local-state-invalid')
  if (section.audit_enabled !== undefined && typeof section.audit_enabled !== 'boolean') fail('snapshot-local-state-invalid')
  const key = canonicalBase64(section.encrypted_key, MAX_ENCODED_CREDENTIAL_BYTES)
  const valid = key && key.length > 5 && key.subarray(0, 5).equals(Buffer.from('DPAPI'))
  if (key) key.fill(0)
  if (!valid) fail('snapshot-local-state-invalid')
  return Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: section.encrypted_key, ...(section.audit_enabled !== undefined ? { audit_enabled: section.audit_enabled } : {}) } }), 'utf8')
}

function captureM09ProfileSnapshot(options) {
  assertNativeMain(true)
  if (captureUsed) fail('snapshot-capture-used')
  captureUsed = true
  let guard, settingsBytes, localStateBytes, sanitized
  try {
    if (!exactKeys(options, ['settingsDirectory', 'profileId'])) fail('snapshot-options-invalid')
    const directory = absolutePlainPath(options.settingsDirectory)
    guard = startGuard()
    const directories = lockDirectories(guard, directory)
    const settings = lockSource(guard, path.join(directory, 'settings.json'), MAX_SETTINGS_BYTES)
    const localState = lockSource(guard, path.join(directory, 'Local State'), MAX_LOCAL_STATE_BYTES)
    if (sameIdentity(identity(settings.stat), identity(localState.stat))) fail('snapshot-path-unsafe')
    settingsBytes = readSource(settings)
    const selectedProfile = validateSettings(settingsBytes, options.profileId)
    localStateBytes = readSource(localState)
    sanitized = sanitizeLocalState(localStateBytes)
    verifyDirectories(directories); guard.verify(); guard.close(); guard = undefined
    const handle = Object.freeze({ version: 1, credentialState: 'encrypted-unverified', selectedProfile })
    snapshots.set(handle, { settingsBytes, localStateBytes: sanitized, sourceDirectory: directory, selectedProfile, state: 'captured' })
    settingsBytes = undefined; sanitized = undefined
    return handle
  } catch (error) { redact(error, 'snapshot-capture-failed') }
  finally {
    if (localStateBytes) localStateBytes.fill(0)
    if (settingsBytes) settingsBytes.fill(0)
    if (sanitized) sanitized.fill(0)
    if (guard) try { guard.close() } catch {}
  }
}
function writeExclusive(filename, bytes) {
  let descriptor
  try {
    descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size !== 0n) fail('snapshot-path-unsafe')
    let offset = 0
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (written < 1) fail('snapshot-stage-failed')
      offset += written
    }
    fs.fsyncSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const named = fs.lstatSync(filename, { bigint: true })
    if (!sameIdentity(identity(before), identity(after)) || !sameIdentity(identity(after), identity(named)) || named.isSymbolicLink() || !named.isFile() || after.nlink !== 1n || named.nlink !== 1n || after.size !== BigInt(bytes.length) || named.size !== after.size) fail('snapshot-path-raced')
    return { filename, stat: after }
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}
function stageM09ProfileSnapshot(handle, options) {
  assertNativeMain(true)
  const snapshot = handle && snapshots.get(handle)
  if (!snapshot) fail('snapshot-handle-invalid')
  if (snapshot.state !== 'captured') fail('snapshot-stage-used')
  snapshot.state = 'staging'
  let guard
  try {
    if (!exactKeys(options, ['runtimeParent'])) fail('snapshot-options-invalid')
    const parent = absolutePlainPath(options.runtimeParent)
    if (within(snapshot.sourceDirectory, parent) || within(parent, snapshot.sourceDirectory)) fail('snapshot-path-overlap')
    guard = startGuard()
    const directories = lockDirectories(guard, parent)
    const runtimeRoot = path.join(parent, `m09-profile-${crypto.randomBytes(24).toString('hex')}`)
    const paths = { runtimeRoot, userData: path.join(runtimeRoot, 'user-data'), sessionData: path.join(runtimeRoot, 'session-data'), cache: path.join(runtimeRoot, 'cache'), crashDumps: path.join(runtimeRoot, 'crash-dumps') }
    for (const filename of Object.values(paths)) {
      if (!within(parent, filename) || filename === parent) fail('snapshot-path-unsafe')
      const native = guard.mkdir(filename)
      const stat = fs.lstatSync(filename, { bigint: true })
      assertMetadata(stat, native, true)
      directories.push({ filename, stat, native })
    }
    const files = [
      [path.join(paths.sessionData, 'Local State'), snapshot.localStateBytes],
      [path.join(paths.userData, 'settings.json'), snapshot.settingsBytes]
    ].map(([filename, expected]) => ({ ...writeExclusive(filename, expected), expected }))
    for (const file of files) {
      const native = guard.lock(file.filename, false)
      const now = fs.lstatSync(file.filename, { bigint: true })
      assertMetadata(now, native, false)
      if (!sameIdentity(identity(file.stat), identity(now)) || now.mtimeNs !== file.stat.mtimeNs || now.ctimeNs !== file.stat.ctimeNs) fail('snapshot-path-raced')
      let readback
      try {
        readback = readSource({ filename: file.filename, stat: now, native })
        if (!readback.equals(file.expected)) fail('snapshot-staged-bytes-mismatch')
      } finally { if (readback) readback.fill(0) }
    }
    verifyDirectories(directories); guard.verify(); guard.close(); guard = undefined
    snapshot.state = 'staged'
    return Object.freeze({ version: 1, credentialState: 'encrypted-unverified', ...paths, selectedProfile: snapshot.selectedProfile, fileContentsFsynced: true, directoryFsync: 'unsupported-win32' })
  } catch (error) { snapshot.state = 'failed'; redact(error, 'snapshot-stage-failed') }
  finally { if (guard) try { guard.close() } catch {} }
}
function releaseM09ProfileSnapshot(handle) {
  assertNativeMain(false)
  const snapshot = handle && snapshots.get(handle)
  if (!snapshot) return false
  snapshot.settingsBytes.fill(0)
  snapshot.localStateBytes.fill(0)
  snapshots.delete(handle)
  return true
}

module.exports = { captureM09ProfileSnapshot, stageM09ProfileSnapshot, releaseM09ProfileSnapshot }
