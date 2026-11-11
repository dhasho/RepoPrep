'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const io = require('./m09-semantic-io.cjs')
const native = require('./m09-semantic-native.cjs')
const { safeEnv, secureTemporaryDirectory } = require('./run-retrieval-profile.cjs')
const CHECKOUT_ROOT = path.resolve(__dirname, '../..')
const MAX_EXECUTION_MS = 2 * 60 * 60 * 1000
const MAX_PIPE_BYTES = 64 * 1024
const parentProofs = new WeakMap()
const runtimes = new WeakMap()
const HASH = /^[a-f0-9]{64}$/u
function parseArgs(argv) {
  const values = new Map()
  const allowed = new Set(['--repo-root', '--settings-dir', '--profile-id', '--reference', '--output'])
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index], value = argv[++index]
    io.check(allowed.has(name) && !values.has(name) && value && !value.startsWith('--'), 'semantic-native-arguments-invalid')
    values.set(name, value)
  }
  const repoRoot = path.resolve(values.get('--repo-root') || CHECKOUT_ROOT)
  const settingsDirectory = path.resolve(values.get('--settings-dir') || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ProjectLens'))
  const reference = values.get('--reference')
  io.check(typeof reference === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(reference), 'semantic-native-arguments-invalid')
  const outputDirectory = path.resolve(values.get('--output') || path.join(repoRoot, '.validation', 'agentic', 'semantic-' + Date.now()))
  const profileId = values.get('--profile-id') || ''
  io.check(profileId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(profileId), 'semantic-native-arguments-invalid')
  return Object.freeze({ repoRoot, settingsDirectory, profileId, reference, outputDirectory })
}
function ensureDirectory(directory, root) {
  io.check(io.samePath(directory, root) || io.within(root, directory), 'semantic-native-runtime-unsafe')
  io.directory(root)
  let cursor = root
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try { io.directory(cursor) } catch (error) { if (error?.code !== 'ENOENT') throw error; io.mkdir(cursor) }
  }
}
function createSemanticRuntime() {
  const parent = fs.realpathSync(os.tmpdir())
  io.directory(parent)
  const root = fs.mkdtempSync(path.join(parent, 'repoprep-m09-semantic-'))
  secureTemporaryDirectory(root)
  const token = Object.freeze({ kind: 'm09-owned-semantic-runtime' })
  runtimes.set(token, { root, parent, identity: io.directory(root), active: false, known: new Map(), closed: true })
  return Object.freeze({ token, root })
}
function rememberRuntimeFile(token, filename) {
  const owner = runtimes.get(token)
  io.check(owner && io.within(owner.root, filename), 'semantic-native-runtime-unsafe')
  owner.known.set(filename, { identity: io.file(filename, 32 * 1024 * 1024).identity, sha256: io.sha256(io.read(filename, 32 * 1024 * 1024)) })
}
/** Guard every target, then remove individual owned entries only after close. */
function cleanupSemanticRuntime(token) {
  const owner = token && runtimes.get(token)
  io.check(owner && !owner.active && owner.closed, 'semantic-native-cleanup-preserved')
  io.check(io.samePath(path.dirname(owner.root), owner.parent) && /^repoprep-m09-semantic-[A-Za-z0-9]+$/u.test(path.basename(owner.root)) && io.sameIdentity(io.directory(owner.root), owner.identity), 'semantic-native-runtime-unsafe')
  const allowed = new Set(['entry.cjs', 'control.json', 'grant.json', 'outcome.json', 'bootstrap.json'])
  if (fs.existsSync(path.join(owner.root, 'bootstrap.json'))) {
    const record = io.json(path.join(owner.root, 'bootstrap.json'))
    io.exact(record, ['schemaVersion', 'parentNonce', 'runtimeRoot', 'runtimeIdentity', 'paths', 'files'])
    io.check(record.schemaVersion === 1 && HASH.test(record.parentNonce) && io.within(owner.root, record.runtimeRoot) && io.samePath(path.dirname(record.runtimeRoot), owner.root) && /^m09-profile-[a-f0-9]{48}$/u.test(path.basename(record.runtimeRoot)) && io.sameIdentity(io.directory(record.runtimeRoot), record.runtimeIdentity), 'semantic-native-runtime-unsafe')
    io.exact(record.paths, ['userData', 'sessionData', 'cache', 'crashDumps'])
    const expected = { userData: 'user-data', sessionData: 'session-data', cache: 'cache', crashDumps: 'crash-dumps' }
    for (const [key, leaf] of Object.entries(expected)) { const item = record.paths[key]; io.exact(item, ['path', 'identity']); io.check(io.samePath(item.path, path.join(record.runtimeRoot, leaf)) && io.sameIdentity(io.directory(item.path), item.identity), 'semantic-native-runtime-unsafe') }
    io.check(Array.isArray(record.files) && record.files.length === 2 && record.files.map(item => item.relative).join('|') === 'user-data/settings.json|session-data/Local State', 'semantic-native-cleanup-preserved')
    const expectedChildren = { userData: ['settings.json'], sessionData: ['Local State'], cache: [], crashDumps: [] }
    for (const [key, children] of Object.entries(expectedChildren)) io.check(io.canonical(fs.readdirSync(record.paths[key].path).sort()) === io.canonical(children), 'semantic-native-cleanup-preserved')
    for (const item of record.files) { io.exact(item, ['relative', 'identity']); io.check(io.sameIdentity(io.file(path.join(record.runtimeRoot, ...item.relative.split('/')), 4 * 1024 * 1024).identity, item.identity), 'semantic-native-cleanup-preserved') }
    io.check(fs.readdirSync(record.runtimeRoot).every(name => Object.values(expected).includes(name)), 'semantic-native-cleanup-preserved')
    allowed.add(path.basename(record.runtimeRoot))
  }
  io.check(fs.readdirSync(owner.root).every(name => allowed.has(name)), 'semantic-native-cleanup-preserved')
  for (const [filename, captured] of owner.known) io.check(io.sameIdentity(io.file(filename, 32 * 1024 * 1024).identity, captured.identity) && io.sha256(io.read(filename, 32 * 1024 * 1024)) === captured.sha256, 'semantic-native-runtime-unsafe')
  const entries = []; let freedBytes = 0
  function scan(directory) {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name)
      io.check(io.within(owner.root, filename) && entries.length < 50000, 'semantic-native-cleanup-preserved')
      const stat = fs.lstatSync(filename, { bigint: true })
      io.check(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1n), 'semantic-native-runtime-unsafe')
      const record = { filename, identity: io.identity(stat), directory: stat.isDirectory(), size: Number(stat.size) }
      entries.push(record)
      if (record.directory) scan(filename)
      else { freedBytes += record.size; io.check(freedBytes <= 2 * 1024 * 1024 * 1024, 'semantic-native-cleanup-preserved') }
    }
  }
  scan(owner.root)
  // io.file/directory check native reparse tags and captured identity immediately
  // before each individual removal; no recursive deletion follows untrusted links.
  for (const entry of [...entries].reverse()) {
    const current = entry.directory ? io.directory(entry.filename) : io.file(entry.filename, 2 * 1024 * 1024 * 1024).identity
    io.check(io.sameIdentity(current, entry.identity) && io.sameIdentity(io.directory(owner.root), owner.identity), 'semantic-native-runtime-unsafe')
    entry.directory ? fs.rmdirSync(entry.filename) : fs.unlinkSync(entry.filename)
  }
  io.check(io.sameIdentity(io.directory(owner.root), owner.identity), 'semantic-native-runtime-unsafe')
  fs.rmdirSync(owner.root)
  io.check(!fs.existsSync(owner.root), 'semantic-native-runtime-unsafe')
  runtimes.delete(token)
  return Object.freeze({ removed: true, freedBytes, entries: entries.length + 1 })
}
/** Observation state machine. It never issues a validation proof. */
function monitorSemanticChild(child, { manifest, validateConfiguration, onReady, timeoutMs = MAX_EXECUTION_MS }) {
  return new Promise((resolve, reject) => {
    let state = 'waiting-ready', ready = null, outcome = null, grant = null, failure = null, closed = false
    let pending = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0
    const stderrHash = crypto.createHash('sha256')
    const stop = code => {
      if (failure) return
      failure = Object.assign(new Error(code), { code })
      try { child.stdin?.destroy() } catch {}
      if (!closed && child.pid) try { child.kill() } catch {}
    }
    const parseLine = line => {
      let message
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) } catch { io.fail('semantic-native-handshake-invalid') }
      io.check(Buffer.concat([line, Buffer.from('\n')]).equals(io.bytes(message)), 'semantic-native-handshake-invalid')
      if (message.type === 'semantic-error') { io.exact(message, ['type', 'code']); io.fail(io.safeCode({ code: message.code }, 'semantic-native-child-failed')) }
      if (state === 'waiting-ready') {
        ready = io.frozen(structuredClone(native.validateReadyMessage(message, manifest, validateConfiguration)))
        grant = onReady(ready)
        io.check(grant && typeof grant.then !== 'function', 'semantic-native-handshake-invalid')
        state = 'grant-sent'
        child.stdin.end(io.bytes(grant))
      } else if (state === 'grant-sent') { outcome = io.frozen(structuredClone(native.validateOutcomeMessage(message, manifest, ready))); state = 'outcome' }
      else io.fail('semantic-native-handshake-invalid')
    }
    child.stdout.on('data', chunk => {
      if (failure) return
      try {
        const raw = Buffer.from(chunk); stdoutBytes += raw.length
        io.check(stdoutBytes <= MAX_PIPE_BYTES, 'semantic-native-handshake-invalid')
        pending = Buffer.concat([pending, raw])
        let newline
        while ((newline = pending.indexOf(10)) !== -1) { const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1); parseLine(line) }
      } catch (error) { stop(io.safeCode(error, 'semantic-native-handshake-invalid')) }
    })
    child.stderr.on('data', chunk => { const raw = Buffer.from(chunk); stderrBytes += raw.length; if (stderrBytes <= MAX_PIPE_BYTES) stderrHash.update(raw); else stop('semantic-native-child-failed') })
    child.stdin.on('error', () => stop('semantic-native-child-closed'))
    child.stdout.on('error', () => stop('semantic-native-child-failed'))
    child.stderr.on('error', () => stop('semantic-native-child-failed'))
    child.once('error', () => stop('semantic-native-child-failed'))
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(timeout); process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted)
      if (!failure && (code !== 0 || signal || state !== 'outcome' || pending.length !== 0)) failure = Object.assign(new Error('semantic-native-child-closed'), { code: 'semantic-native-child-closed' })
      const observed = { childClosed: true, closeCode: code, closeSignal: signal ?? null, stdoutBytes, stderrBytes, stderrSha256: stderrHash.digest('hex'), ready, grant, outcome }
      if (failure) { Object.defineProperty(failure, 'observed', { value: Object.freeze(observed) }); reject(failure) }
      else resolve(io.frozen(observed))
    })
    const interrupted = () => stop('semantic-native-child-failed')
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted)
    const timeout = setTimeout(() => stop('semantic-native-child-timeout'), timeoutMs)
  })
}
/** Only verification is exported. There is no caller-facing proof constructor. */
function verifySemanticParentProof(token, { outputDirectory, freezeBytes, provenance }) {
  const proof = token && parentProofs.get(token)
  io.check(proof, 'semantic-native-parent-proof-required')
  io.check(Buffer.isBuffer(freezeBytes) && proof.freezeBytes.equals(freezeBytes) && io.samePath(outputDirectory, proof.outputDirectory) && io.sameIdentity(io.directory(outputDirectory), proof.outputIdentity) && io.canonical(provenance) === proof.provenanceCanonical && io.sha256(io.bytes(provenance)) === proof.outcome.provenanceHash && io.sha256(freezeBytes) === proof.outcome.executionHash, 'semantic-native-parent-proof-mismatch')
  return true
}
async function launch(options) {
  io.exact(options, ['repoRoot', 'settingsDirectory', 'profileId', 'reference', 'outputDirectory'])
  options = Object.freeze({ ...options })
  io.check(process.platform === 'win32' && !process.versions.electron && !Object.hasOwn(process.env, 'ELECTRON_RUN_AS_NODE'), 'semantic-native-main-required')
  let runtime, owner, observed, successful = false, cleanup = { removed: false, freedBytes: 0 }
  try {
    const repoRoot = fs.realpathSync(io.absolute(options.repoRoot))
    io.check(io.samePath(repoRoot, fs.realpathSync(CHECKOUT_ROOT)), 'semantic-native-source-mismatch')
    io.directory(repoRoot)
    require('./run-saved-profile.cjs').registerSharedAliasHooks(repoRoot)
    const evaluation = await import(pathToFileURL(path.join(repoRoot, 'scripts/agentic/semantic-eval.mjs')).href)
    const contract = await import(pathToFileURL(path.join(repoRoot, 'scripts/agentic/semantic-eval-contract.mjs')).href)
    const source = await evaluation.inspectSemanticSource(repoRoot)
    const dataDirectory = path.join(repoRoot, 'scripts', 'agentic', 'datasets', 'v1')
    const bundle = await contract.loadSemanticPublicBundle(dataDirectory)
    const { plan, executionMap } = contract.createSemanticExecutionPlan(bundle)
    io.check(typeof options.reference === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(options.reference), 'semantic-native-arguments-invalid')
    io.directory(io.absolute(options.settingsDirectory))
    const outputDirectory = io.absolute(options.outputDirectory)
    const claimDirectory = path.join(repoRoot, '.validation', 'agentic', 'semantic-claims')
    io.check(io.within(path.join(repoRoot, '.validation', 'agentic'), outputDirectory) && !io.overlaps(outputDirectory, options.settingsDirectory) && !io.overlaps(claimDirectory, outputDirectory), 'semantic-native-runtime-unsafe')
    ensureDirectory(path.dirname(outputDirectory), repoRoot); ensureDirectory(claimDirectory, repoRoot)
    io.check(!fs.existsSync(outputDirectory), 'semantic-output-exists')
    runtime = createSemanticRuntime(); owner = runtimes.get(runtime.token)
    io.check(!io.overlaps(runtime.root, repoRoot) && !io.overlaps(runtime.root, options.settingsDirectory), 'semantic-native-runtime-unsafe')
    const entrySource = path.join(repoRoot, 'scripts', 'evaluation', 'run-semantic-profile-entry.cjs')
    const entrySourceSha256 = io.sha256(io.read(entrySource))
    const outfile = path.join(runtime.root, 'entry.cjs')
    await require('esbuild').build({ entryPoints: [entrySource], bundle: true, platform: 'node', format: 'cjs', target: 'node22', tsconfig: path.join(repoRoot, 'tsconfig.node.json'), external: ['electron'], outfile, logLevel: 'silent', define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(repoRoot, 'scripts/agentic/semantic-eval-contract.mjs')).href) } })
    rememberRuntimeFile(runtime.token, outfile)
    const bundleSha256 = io.sha256(io.read(outfile, 32 * 1024 * 1024))
    io.check(io.canonical(await evaluation.inspectSemanticSource(repoRoot)) === io.canonical(source), 'semantic-native-source-mismatch')
    const manifest = io.frozen({ schemaVersion: 1, purpose: native.PURPOSE, mode: 'real', parentPid: process.pid, parentNonce: crypto.randomBytes(32).toString('hex'), runtimeRoot: runtime.root, runtimeIdentity: owner.identity, entryIdentity: io.file(outfile, 32 * 1024 * 1024).identity, repoRoot, dataDirectory, settingsDirectory: options.settingsDirectory, profileId: options.profileId, outputDirectory, claimDirectory, reference: options.reference, source, publicDataHash: bundle.publicDataHash, assets: bundle.assets, plan, executionMap, budgets: contract.semanticBudgets(), entrySourceSha256, bundleSha256 })
    io.write(path.join(runtime.root, 'control.json'), io.bytes(manifest)); rememberRuntimeFile(runtime.token, path.join(runtime.root, 'control.json'))
    const child = spawn(require('electron'), [outfile, '--runtime-root', runtime.root], { cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: safeEnv() })
    owner.active = true; owner.closed = false
    try {
      observed = await monitorSemanticChild(child, { manifest, validateConfiguration: contract.validateSemanticConfiguration, onReady: ready => {
        const authorization = contract.createSemanticAuthorizationDraft({ mode: 'real', reference: manifest.reference, source, bundle, plan, executionMap, configuration: ready.configuration })
        const body = native.grantBody(manifest, ready, authorization)
        const message = io.frozen({ ...body, grantHash: io.hash(body) })
        native.validateGrantMessage(message, manifest, ready, authorization)
        io.write(path.join(runtime.root, 'grant.json'), io.bytes(message)); rememberRuntimeFile(runtime.token, path.join(runtime.root, 'grant.json'))
        return message
      } })
    } catch (error) { if (error?.observed?.childClosed) { owner.active = false; owner.closed = true } throw error }
    owner.active = false; owner.closed = true
    const diskOutcome = io.json(path.join(runtime.root, 'outcome.json'))
    io.check(io.canonical(diskOutcome) === io.canonical(observed.outcome), 'semantic-native-provenance-invalid')
    rememberRuntimeFile(runtime.token, path.join(runtime.root, 'outcome.json')); rememberRuntimeFile(runtime.token, path.join(runtime.root, 'bootstrap.json'))
    const freezeBytes = io.read(path.join(outputDirectory, 'execution-freeze.json'))
    const provenance = io.json(path.join(outputDirectory, 'native-provenance.json'))
    io.check(io.sha256(freezeBytes) === observed.outcome.executionHash && io.sha256(io.bytes(provenance)) === observed.outcome.provenanceHash && provenance.parentNonce === manifest.parentNonce && provenance.childNonce === observed.ready.childNonce && provenance.bundleSha256 === bundleSha256 && provenance.entrySourceSha256 === entrySourceSha256 && provenance.configurationHash === observed.ready.configuration.configurationHash && provenance.authorizationHash === io.hash(observed.grant.authorization) && provenance.grantHash === observed.grant.grantHash && provenance.grantFileSha256 === io.sha256(io.bytes(observed.grant)) && provenance.claimId === observed.outcome.claimId, 'semantic-native-provenance-invalid')
    const nativeParentProof = Object.freeze({ kind: 'm09-observed-native-child' })
    parentProofs.set(nativeParentProof, { outputDirectory, outputIdentity: io.directory(outputDirectory), freezeBytes: Buffer.from(freezeBytes), provenanceCanonical: io.canonical(provenance), outcome: observed.outcome })
    const validation = await contract.validateFrozenSemanticExecution(outputDirectory, { bundle, requireReal: true, expectedFreezeBytes: Buffer.from(freezeBytes), nativeParentProof })
    successful = true
    try { cleanup = cleanupSemanticRuntime(runtime.token) } catch { cleanup = { removed: false, freedBytes: 0, code: 'semantic-native-cleanup-preserved' } }
    return Object.freeze({ validation, nativeParentProof, expectedFreezeBytes: Buffer.from(freezeBytes), outputDirectory, cleanup: Object.freeze(cleanup), quality: 'not-evaluated', status: 'awaiting-independent-blind-judgments' })
  } catch (error) {
    const safe = Object.assign(new Error(io.safeCode(error)), { code: io.safeCode(error) })
    Object.defineProperty(safe, 'runtimePreserved', { value: Boolean(runtime) })
    throw safe
  } finally {
    // Failures and unexpected entries are recovery evidence. No active, partial,
    // claimed or failed runtime is removed, and no output/claim is a target.
    if (runtime && !successful && owner) owner.preserved = true
  }
}
if (require.main === module) {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) { process.stderr.write(io.bytes({ type: 'semantic-launch-error', code: io.safeCode(error, 'semantic-native-arguments-invalid') })); process.exitCode = 2 }
  if (options) launch(options).then(result => { process.exitCode = result.validation.executionComplete ? 0 : 1; process.stdout.write(io.bytes({ type: 'semantic-measurement', executionHash: result.validation.executionHash, executionComplete: result.validation.executionComplete, nativeProvenance: result.validation.nativeProvenance, quality: result.quality, status: result.status, cleanup: result.cleanup })) }).catch(error => { process.stderr.write(io.bytes({ type: 'semantic-launch-error', code: io.safeCode(error), runtimePreserved: error.runtimePreserved === true })); process.exitCode = 1 })
}
module.exports = { MAX_EXECUTION_MS, MAX_PIPE_BYTES, parseArgs, createSemanticRuntime, cleanupSemanticRuntime, monitorSemanticChild, verifySemanticParentProof, launch }
