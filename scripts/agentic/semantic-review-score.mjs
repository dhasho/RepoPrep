import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  SEMANTIC_REVIEW_LIMITS,
  SEMANTIC_NATIVE_COLLABORATION_V2,
  buildSemanticReviewPackets,
  freezeSemanticScoringProjection,
  parseSemanticJsonBytes,
  parseSemanticSubmissions,
  scoreSemanticQuality,
  semanticInvocationInputs,
  semanticSha256,
  validateSemanticJudgments,
  validateSemanticReviewPackets
} from './semantic-review.mjs'

const unavailable = () => { throw new Error('SEMANTIC_PRIVATE_KEYS_UNAVAILABLE') }
const isLink = (stats) => stats.isSymbolicLink() || ((stats.attributes ?? 0) & 0x400) !== 0
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
function binding(value, filename) {
  if (!value || Object.keys(value).sort().join(',') !== 'byteLength,path,sha256' || value.path !== filename || !/^[0-9a-f]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > SEMANTIC_REVIEW_LIMITS.maxPrivateKeyBytes) unavailable()
  return Object.freeze({ path: filename, byteLength: value.byteLength, sha256: value.sha256 })
}
async function safeDirectory(rootDir) {
  const absolute = path.resolve(rootDir)
  if (!path.isAbsolute(rootDir) || rootDir.split(/[\\/]/u).some((part) => part === '..')) unavailable()
  let cursor = path.parse(absolute).root
  for (const part of ['', ...absolute.slice(cursor.length).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part)
    const stats = await lstat(cursor)
    if (!stats.isDirectory() || isLink(stats)) unavailable()
  }
  if (!samePath(await realpath(absolute), absolute)) unavailable()
  return absolute
}
async function loadBoundPrivateKey(rootDir, descriptor, normalizedSha256) {
  let handle
  try {
    const root = await safeDirectory(rootDir)
    const filename = path.join(root, descriptor.path)
    if (path.dirname(filename) !== root) unavailable()
    const before = await lstat(filename)
    if (isLink(before) || !before.isFile() || before.nlink !== 1 || before.size !== descriptor.byteLength) unavailable()
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1) unavailable()
    // Bounded reads also reject a file that grows after the initial size check.
    const buffer = Buffer.alloc(descriptor.byteLength + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== descriptor.byteLength) unavailable()
    const after = await handle.stat(); const pathAfter = await lstat(filename)
    if (isLink(pathAfter) || pathAfter.nlink !== 1 || !sameFile(opened, after) || !sameFile(opened, pathAfter) || await safeDirectory(rootDir) !== root) unavailable()
    const bytes = buffer.subarray(0, offset)
    if (semanticSha256(bytes) !== descriptor.sha256 || (normalizedSha256 && semanticSha256(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8')) !== normalizedSha256)) unavailable()
    return parseSemanticJsonBytes(bytes, SEMANTIC_REVIEW_LIMITS.maxPrivateKeyBytes)
  } catch {
    unavailable()
  } finally {
    await handle?.close()
  }
}

/**
 * The host supplies actual E1 verification and actual native invocation lookup.
 * Neither callback is loaded from an evaluation report. A Boolean/pass flag is
 * not an accepted result: callbacks return the verified projection/receipt.
 * No file is read by this factory, freezeExecution, buildPackets or freezeJudgments.
 */
export function createSemanticScoringOnlyAdapter({ verifyExecutionFreeze, verifyJudgeInvocation, privateKeyBindings, invocationProtocol, normalizedPrivateKeyHashes }) {
  if (invocationProtocol !== undefined && invocationProtocol !== SEMANTIC_NATIVE_COLLABORATION_V2) throw new Error('SEMANTIC_INVOCATION_PROTOCOL_INVALID')
  if (normalizedPrivateKeyHashes !== undefined && (!normalizedPrivateKeyHashes || Object.keys(normalizedPrivateKeyHashes).sort().join(',') !== 'repairKey,reviewKey' || Object.values(normalizedPrivateKeyHashes).some(value => !/^[0-9a-f]{64}$/u.test(value)))) unavailable()
  const normalizedHashes = normalizedPrivateKeyHashes && Object.freeze({ ...normalizedPrivateKeyHashes })
  const invocationOptions = Object.freeze({ invocationProtocol })
  if (typeof verifyExecutionFreeze !== 'function' || typeof verifyJudgeInvocation !== 'function') throw new Error('SEMANTIC_TRUSTED_VERIFIERS_REQUIRED')
  if (!privateKeyBindings || Object.keys(privateKeyBindings).sort().join(',') !== 'repairKey,reviewKey,rootDir' || typeof privateKeyBindings.rootDir !== 'string' || !path.isAbsolute(privateKeyBindings.rootDir)) unavailable()
  const bindings = Object.freeze({ rootDir: privateKeyBindings.rootDir, reviewKey: binding(privateKeyBindings.reviewKey, 'review-key.json'), repairKey: binding(privateKeyBindings.repairKey, 'repair-key.json') })
  const executions = new WeakMap(); const judgments = new WeakMap()
  const getExecution = (handle) => { const state = executions.get(handle); if (!state) throw new Error('SEMANTIC_EXECUTION_NOT_FROZEN'); return state }
  return Object.freeze({
    async freezeExecution(executionBytes) {
      if (!(executionBytes instanceof Uint8Array) || executionBytes.byteLength === 0 || executionBytes.byteLength > SEMANTIC_REVIEW_LIMITS.maxDocumentBytes) throw new Error('SEMANTIC_EXECUTION_NOT_VERIFIED')
      const bytes = Buffer.from(executionBytes)
      let projection
      try {
        // Give the host a separate copy; later caller or verifier mutations cannot alter this freeze.
        projection = freezeSemanticScoringProjection(await verifyExecutionFreeze(Buffer.from(bytes)))
        if (projection.executionHash !== semanticSha256(bytes)) throw new Error('MISMATCH')
      } catch { throw new Error('SEMANTIC_EXECUTION_NOT_VERIFIED') }
      const handle = Object.freeze({ executionHash: projection.executionHash, publicDataHash: projection.publicDataHash })
      executions.set(handle, Object.freeze({ projection }))
      return handle
    },
    buildPackets(executionHandle) { return buildSemanticReviewPackets(getExecution(executionHandle).projection) },
    async freezeJudgments(executionHandle, packetBundle, judgmentBytes) {
      const state = getExecution(executionHandle)
      if (!(judgmentBytes instanceof Uint8Array)) throw new Error('SEMANTIC_JUDGMENTS_NOT_FROZEN')
      const bytes = Buffer.from(judgmentBytes)
      try {
        validateSemanticReviewPackets(state.projection, packetBundle)
        // An owned, immutable copy is used across every awaited native-record lookup.
        const bundle = JSON.parse(JSON.stringify(packetBundle))
        const document = parseSemanticSubmissions(bytes)
        const inputs = semanticInvocationInputs(bundle.publicPackets, document.submissions, invocationOptions)
        const invocations = []
        for (const role of ['A', 'B', 'adjudicator']) {
          const output = document.submissions.find((item) => item.role === role).output
          invocations.push(await verifyJudgeInvocation(Object.freeze({ role, inputBytes: Buffer.from(inputs[role]), outputBytes: Buffer.from(output, 'utf8') })))
        }
        const evidence = validateSemanticJudgments(state.projection, bundle, bytes, invocations, invocationOptions)
        const handle = Object.freeze({ executionHash: state.projection.executionHash, judgmentsHash: evidence.judgmentsHash })
        judgments.set(handle, Object.freeze({ projection: state.projection, bundle, bytes, invocations: evidence.invocations }))
        return handle
      } catch { throw new Error('SEMANTIC_JUDGMENTS_NOT_FROZEN') }
    },
    async scorePrivateFiles(judgmentHandle) {
      const state = judgments.get(judgmentHandle)
      if (!state) throw new Error('SEMANTIC_JUDGMENTS_NOT_FROZEN')
      // These are the only two disk reads in the adapter. Both immutable freezes
      // and all three independent invocation receipts have already been verified.
      const reviewKey = await loadBoundPrivateKey(bindings.rootDir, bindings.reviewKey, normalizedHashes?.reviewKey)
      const repairKey = await loadBoundPrivateKey(bindings.rootDir, bindings.repairKey, normalizedHashes?.repairKey)
      return scoreSemanticQuality({ projection: state.projection, bundle: state.bundle, judgmentBytes: state.bytes, invocations: state.invocations, reviewKey, repairKey, invocationProtocol })
    }
  })
}
