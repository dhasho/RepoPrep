import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'

/** Experimental, main-process-only. These codes never include paths or upstream errors. */
export type WorkflowStoreFailure = 'unsupported-platform' | 'invalid-input' | 'unsafe-path' | 'owner-unavailable' | 'revoked' | 'attempt-inactive' | 'cancelled' | 'capacity-exhausted' | 'unavailable' | 'disk-failure'
export class WorkflowStoreError extends Error {
  readonly code: WorkflowStoreFailure
  constructor(code: WorkflowStoreFailure) { super(`workflow-store:${code}`); this.name = 'WorkflowStoreError'; this.code = code }
}
export function workflowFail(code: WorkflowStoreFailure): never { throw new WorkflowStoreError(code) }
export function workflowHash(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

export interface WorkflowRunBinding {
  readonly version: 1
  readonly logicalRunId: string
  readonly projectId: string
  readonly snapshotId: string
  /** Commits to the complete original RunSpec, including its original budget/time configuration. */
  readonly runSpecHash: string
  readonly configHash: string
  readonly schemaVersion: string
  readonly policyVersion: string
}
export interface WorkflowProducingEpoch { readonly owner: number; readonly attempt: number; readonly attemptId: string }
declare const ownerBrand: unique symbol
declare const attemptBrand: unique symbol
export interface WorkflowWriterOwner { readonly [ownerBrand]: true }
export interface WorkflowAttempt { readonly [attemptBrand]: true }
interface PhysicalIdentity { readonly dev: string; readonly ino: string }
/** Internal filesystem context. Never expose this through IPC or to a model. */
export interface WorkflowRoot {
  readonly input: string
  readonly storage: string
  readonly directory: string
  readonly identity: PhysicalIdentity
  readonly storageIdentity: PhysicalIdentity
  readonly directories: Map<string, PhysicalIdentity>
}
const owners = new WeakMap<object, OwnerState>()
const ownerLifecycles = new WeakMap<object, OwnerState>()
const attempts = new WeakMap<object, AttemptState>()
const closingOwners = new WeakMap<object, Promise<void>>()
interface OwnerState {
  token: WorkflowWriterOwner
  root: WorkflowRoot
  server: net.Server
  valid: boolean
  queue: Promise<unknown>
  pending: number
  slots: Map<string, AttemptState>
  fence?: () => void
  closing?: Promise<void>
}
interface AttemptState {
  token: WorkflowAttempt
  owner: OwnerState
  binding: WorkflowRunBinding
  epoch: WorkflowProducingEpoch
  current: boolean
  signal?: AbortSignal
  unlisten?: () => void
  fence?: () => void
}
export interface WorkflowWriterGuard {
  readonly root: WorkflowRoot
  check(): void
  /** Internal issuance, used only inside the store's owner queue, before returning a flushed marker. */
  issueAttempt(binding: WorkflowRunBinding, epoch: Readonly<{ owner: number; attempt: number }>, signal?: AbortSignal): WorkflowAttempt
}
export interface WorkflowAttemptInfo {
  readonly binding: WorkflowRunBinding
  readonly epoch: WorkflowProducingEpoch
}

function same(a: PhysicalIdentity, b: PhysicalIdentity): boolean { return a.dev === b.dev && a.ino === b.ino }
function physical(stat: fs.BigIntStats): PhysicalIdentity {
  if (stat.dev <= 0n || stat.ino <= 0n) workflowFail('unsafe-path')
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) })
}
function normalized(value: string): string { return path.resolve(value).toLowerCase().replace(/[\\/]+$/, '') }
function statDirectory(directory: string): PhysicalIdentity {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) workflowFail('unsafe-path')
  return physical(stat)
}
function childName(value: string): void {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,119}$/.test(value) || value === '.' || value === '..' || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) workflowFail('unsafe-path')
}
export function workflowFsError(error: unknown): never {
  if (error instanceof WorkflowStoreError) throw error
  workflowFail('disk-failure')
}

/** The supplied storage directory must already exist. Aliases of its physical root share one listener. */
export function resolveWorkflowRoot(storageDirectory: string, create: boolean): WorkflowRoot {
  if (process.platform !== 'win32') workflowFail('unsupported-platform')
  if (typeof storageDirectory !== 'string' || !/^[a-zA-Z]:[\\/]/.test(storageDirectory) || storageDirectory.slice(2).includes(':') || storageDirectory.includes('\0')) workflowFail('unsafe-path')
  try {
    const input = path.resolve(storageDirectory)
    const storage = fs.realpathSync.native(input)
    // UNC/cloud/mapped-filesystem equivalence is not established by the native NTFS probe.
    if (!/^[a-zA-Z]:[\\/]/.test(storage)) workflowFail('unsafe-path')
    const storageIdentity = statDirectory(storage)
    let directory = storage
    const directories = new Map<string, PhysicalIdentity>([[storage, storageIdentity]])
    for (const name of ['workflow-store', 'v1']) {
      directory = path.join(directory, name)
      if (create && !fs.existsSync(directory)) fs.mkdirSync(directory)
      const identity = statDirectory(directory)
      if (normalized(fs.realpathSync.native(directory)) !== normalized(directory)) workflowFail('unsafe-path')
      directories.set(directory, identity)
    }
    const root = { input, storage, directory, identity: directories.get(directory)!, storageIdentity, directories }
    validateWorkflowRoot(root)
    return root
  } catch (error) { return workflowFsError(error) }
}
export function validateWorkflowRoot(root: WorkflowRoot): void {
  try {
    const resolved = fs.realpathSync.native(root.input)
    if (normalized(resolved) !== normalized(root.storage) || !same(statDirectory(resolved), root.storageIdentity)) workflowFail('unsafe-path')
    for (const [directory, identity] of root.directories) {
      if (!same(statDirectory(directory), identity) || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) workflowFail('unsafe-path')
    }
    if (!same(statDirectory(root.directory), root.identity)) workflowFail('unsafe-path')
  } catch (error) { workflowFsError(error) }
}
export function workflowDirectory(root: WorkflowRoot, segments: readonly string[], create = false): string {
  validateWorkflowRoot(root)
  let directory = root.directory
  try {
    for (const name of segments) {
      childName(name)
      directory = path.join(directory, name)
      if (create && !fs.existsSync(directory)) fs.mkdirSync(directory)
      const identity = statDirectory(directory)
      const prior = root.directories.get(directory)
      if ((prior && !same(identity, prior)) || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) workflowFail('unsafe-path')
      root.directories.set(directory, identity)
    }
    return directory
  } catch (error) { return workflowFsError(error) }
}
export function workflowFilePath(root: WorkflowRoot, segments: readonly string[], createDirectories = false): string {
  const name = segments.at(-1)
  if (!name) workflowFail('unsafe-path')
  childName(name)
  return path.join(workflowDirectory(root, segments.slice(0, -1), createDirectories), name)
}
/** Fixed-size read with handle/path identity checks; refuses links, growth and unbounded allocation. */
export function readWorkflowFile(root: WorkflowRoot, segments: readonly string[], maxBytes: number): Buffer {
  let descriptor: number | undefined
  try {
    const filename = workflowFilePath(root, segments)
    const before = fs.lstatSync(filename, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maxBytes)) workflowFail('unavailable')
    descriptor = fs.openSync(filename, 'r')
    const handle = fs.fstatSync(descriptor, { bigint: true })
    if (!same(physical(handle), physical(before)) || handle.size !== before.size) workflowFail('unsafe-path')
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (!read) workflowFail('unavailable')
      offset += read
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) workflowFail('unavailable')
    const after = fs.lstatSync(filename, { bigint: true })
    if (!same(physical(after), physical(handle)) || after.size !== before.size || after.nlink !== 1n || after.isSymbolicLink()) workflowFail('unsafe-path')
    validateWorkflowRoot(root)
    return bytes
  } catch (error) { return workflowFsError(error) } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}
export interface WorkflowDiskUsage { readonly bytes: number; readonly runBytes: number; readonly entries: number }
/** Includes every pending, unknown and control file. No automatic deletion or eviction. */
export function workflowDiskUsage(root: WorkflowRoot, runKey: string | undefined, maxEntries: number): WorkflowDiskUsage {
  validateWorkflowRoot(root)
  let bytes = 0, runBytes = 0, entries = 0
  const walk = (segments: string[], depth: number): void => {
    if (depth > 8) workflowFail('capacity-exhausted')
    const directory = workflowDirectory(root, segments)
    for (const name of fs.readdirSync(directory)) {
      childName(name)
      if (++entries > maxEntries) workflowFail('capacity-exhausted')
      const next = [...segments, name]
      const stat = fs.lstatSync(path.join(directory, name), { bigint: true })
      if (stat.isSymbolicLink()) workflowFail('unsafe-path')
      if (stat.isDirectory()) { walk(next, depth + 1); continue }
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) workflowFail('unsafe-path')
      const size = Number(stat.size)
      bytes += size
      if (next[0] === 'runs' && next[1] === runKey) runBytes += size
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(runBytes)) workflowFail('capacity-exhausted')
    }
  }
  try { walk([], 0); validateWorkflowRoot(root); return Object.freeze({ bytes, runBytes, entries }) } catch (error) { return workflowFsError(error) }
}

function revokeAttempt(state: AttemptState): boolean {
  if (!state.current) return false
  state.current = false
  attempts.delete(state.token)
  state.unlisten?.()
  if (state.owner.slots.get(state.binding.projectId) === state) state.owner.slots.delete(state.binding.projectId)
  return true
}
function revokeOwner(state: OwnerState): void {
  state.valid = false
  owners.delete(state.token)
  for (const attempt of state.slots.values()) revokeAttempt(attempt)
}
function checkOwner(state: OwnerState): void {
  if (!state.valid || owners.get(state.token) !== state || !state.server.listening) workflowFail('revoked')
  try { validateWorkflowRoot(state.root); state.fence?.() }
  catch (error) { revokeOwner(state); throw error }
}
function checkAttempt(state: OwnerState, token: WorkflowAttempt): AttemptState {
  checkOwner(state)
  const attempt = attempts.get(token)
  if (!attempt || attempt.owner !== state || !attempt.current || state.slots.get(attempt.binding.projectId) !== attempt) workflowFail('attempt-inactive')
  if (attempt.signal?.aborted) { revokeAttempt(attempt); workflowFail('cancelled') }
  try { attempt.fence?.() } catch (error) { revokeAttempt(attempt); throw error }
  return attempt
}
function stateFor(token: WorkflowWriterOwner): OwnerState {
  const state = owners.get(token)
  if (!state) workflowFail('revoked')
  checkOwner(state)
  return state
}

/** Owner-only fence check; it neither waits for nor drains the writer queue. */
export function assertWorkflowWriterOwner(owner: WorkflowWriterOwner): void { stateFor(owner) }

export async function acquireWorkflowWriter(storageDirectory: string): Promise<WorkflowWriterOwner> {
  const root = resolveWorkflowRoot(storageDirectory, true)
  const endpoint = `\\\\.\\pipe\\repoprep-workflow-store-v1-${workflowHash(`repoprep-workflow-store:v1:win32:${root.identity.dev}:${root.identity.ino}`)}`
  const token = Object.freeze({}) as WorkflowWriterOwner
  const server = net.createServer(socket => socket.destroy())
  const state: OwnerState = { token, root, server, valid: false, queue: Promise.resolve(), pending: 0, slots: new Map() }
  server.on('error', () => { revokeOwner(state); if (server.listening) server.close() })
  server.on('close', () => revokeOwner(state))
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => reject(new WorkflowStoreError('owner-unavailable'))
      server.once('error', failed)
      server.listen({ path: endpoint, exclusive: true }, () => { server.removeListener('error', failed); resolve() })
    })
    validateWorkflowRoot(root)
    if (!server.listening) workflowFail('owner-unavailable')
    state.valid = true
    owners.set(token, state)
    ownerLifecycles.set(token, state)
    return token
  } catch (error) {
    revokeOwner(state)
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    if (error instanceof WorkflowStoreError) throw error
    workflowFail('owner-unavailable')
  }
}
/** Installs a synchronous disk-epoch check. Only the store holding the private owner token installs it. */
export function fenceWorkflowWriter(owner: WorkflowWriterOwner, fence: () => void): void {
  const state = stateFor(owner)
  if (state.fence) workflowFail('invalid-input')
  state.fence = fence
  checkOwner(state)
}
export function queueWorkflowWriter<T>(owner: WorkflowWriterOwner, operation: (guard: WorkflowWriterGuard) => T | Promise<T>, attempt?: WorkflowAttempt): Promise<T> {
  let state: OwnerState
  try { state = stateFor(owner); if (attempt) checkAttempt(state, attempt); if (state.pending >= 128) workflowFail('capacity-exhausted') } catch (error) { return Promise.reject(error) }
  state.pending++
  const guard: WorkflowWriterGuard = Object.freeze({
    root: state.root,
    check() { checkOwner(state); if (attempt) checkAttempt(state, attempt) },
    issueAttempt(binding: WorkflowRunBinding, epoch: Readonly<{ owner: number; attempt: number }>, signal?: AbortSignal): WorkflowAttempt {
      checkOwner(state)
      if (state.slots.has(binding.projectId)) workflowFail('attempt-inactive')
      if (signal?.aborted) workflowFail('cancelled')
      if (![epoch.owner, epoch.attempt].every(value => Number.isSafeInteger(value) && value > 0)) workflowFail('invalid-input')
      const token = Object.freeze({}) as WorkflowAttempt
      const next: AttemptState = { token, owner: state, binding, epoch: Object.freeze({ ...epoch, attemptId: randomUUID() }), current: true, signal }
      attempts.set(token, next)
      state.slots.set(binding.projectId, next)
      if (signal) {
        const cancel = (): void => { revokeAttempt(next) }
        signal.addEventListener('abort', cancel, { once: true })
        next.unlisten = () => signal.removeEventListener('abort', cancel)
        if (signal.aborted) { revokeAttempt(next); workflowFail('cancelled') }
      }
      return token
    }
  })
  const pending = state.queue.then(async () => {
    guard.check()
    try { const result = await operation(guard); guard.check(); return result } catch (error) { return workflowFsError(error) }
  })
  state.queue = pending.then(() => undefined, () => undefined)
  return pending.finally(() => { state.pending-- })
}
/** Store-only: pin the exclusively issued attempt marker after it is fully flushed. */
export function fenceWorkflowAttempt(owner: WorkflowWriterOwner, attempt: WorkflowAttempt, fence: () => void): void {
  const state = stateFor(owner), current = checkAttempt(state, attempt)
  if (current.fence) workflowFail('invalid-input')
  current.fence = fence
  checkAttempt(state, attempt)
}
export function workflowAttemptInfo(owner: WorkflowWriterOwner, attempt: WorkflowAttempt): WorkflowAttemptInfo {
  const state = stateFor(owner)
  const current = checkAttempt(state, attempt)
  return Object.freeze({ binding: current.binding, epoch: current.epoch })
}
/** Cancellation/terminal revokes synchronously and never releases a newer attempt's project slot. */
export function finishWorkflowAttempt(owner: WorkflowWriterOwner, attempt: WorkflowAttempt): boolean {
  const state = owners.get(owner)
  const current = attempts.get(attempt)
  if (!state || !current || current.owner !== state) return false
  return revokeAttempt(current)
}
/** Capabilities are revoked before the first await; the OS listener is released after queued work drains. */
export function closeWorkflowWriter(owner: WorkflowWriterOwner): Promise<void> {
  const prior = closingOwners.get(owner)
  if (prior) return prior
  const state = ownerLifecycles.get(owner)
  if (!state) return Promise.resolve()
  if (state.closing) return state.closing
  revokeOwner(state)
  state.closing = state.queue.then(() => new Promise<void>(resolve => {
    if (!state.server.listening) { resolve(); return }
    state.server.close(() => resolve())
  }))
  closingOwners.set(owner, state.closing)
  return state.closing
}
