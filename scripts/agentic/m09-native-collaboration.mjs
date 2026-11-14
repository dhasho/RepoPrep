import { SEMANTIC_NATIVE_COLLABORATION_V2, semanticCanonicalJson, semanticSha256 } from './semantic-review.mjs'

const bridges = new WeakMap()
const usedTaskNames = new Set()
const MODEL = 'gpt-6.1-sol'
const ROLES = ['A', 'B', 'adjudicator']
const invalid = () => { throw new Error('M09_NATIVE_OBSERVATION_INVALID') }
function exact(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const names = Reflect.ownKeys(value)
  if (!required.every(name => names.includes(name)) || names.some(name => typeof name !== 'string' || ![...required, ...optional].includes(name) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value'))) invalid()
}
function bytes(value) { if (!(value instanceof Uint8Array)) invalid(); return Buffer.from(value) }
function usage(value = { availability: 'unavailable' }) {
  if (value?.availability === 'unavailable') { exact(value, ['availability']); return Object.freeze({ availability: 'unavailable' }) }
  exact(value, ['availability', 'inputTokens', 'outputTokens'])
  if (value.availability !== 'available' || !['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 10_000_000)) invalid()
  return Object.freeze({ ...value })
}
function taskName(name) { if (typeof name !== 'string' || name.length > 512 || !/^\/root(?:\/[A-Za-z0-9_.-]+)+$/u.test(name)) invalid(); return name }

/**
 * TRUSTED EXTERNAL BOUNDARY, not a native-tool implementation or attestation.
 * The root supervisor alone must call observeSpawn/observeCompletion from its
 * actual native tool results. Fabricated observations defeat this assumption.
 * Receipts/audit JSON never substitute for these live, identity-bound requests.
 */
export function createRootSupervisedM09NativeBridge() {
  const bridge = Object.freeze({ protocol: SEMANTIC_NATIVE_COLLABORATION_V2, boundary: 'trusted-root-native-observations' })
  const requests = new Map(); const handles = new WeakMap()
  let claimed = false; let failed = false; let onFailure = () => {}
  const fail = () => { failed = true; onFailure(); invalid() }
  const guarded = operation => { try { if (failed) invalid(); return operation() } catch { return fail() } }
  const requestState = handle => { const state = handles.get(handle); if (!state || requests.get(state.role) !== state) invalid(); return state }
  const publicRequest = state => {
    const handle = Object.freeze({ role: state.role, model: MODEL, forkTurns: 'none', get inputBytes() { return Buffer.from(state.input) }, get inputText() { return state.input.toString('utf8') } })
    handles.set(handle, state); state.handle = handle; return handle
  }
  const transport = Object.freeze({
    dispatch(role, inputBytes) { return guarded(() => {
      if (!claimed || !ROLES.includes(role) || requests.has(role)) invalid()
      const input = bytes(inputBytes)
      if (!input.length || input.length > 32 * 1024 * 1024) invalid()
      if (role === 'B' && (!requests.has('A') || !requests.get('A').input.equals(input))) invalid()
      if (role === 'adjudicator' && !['A', 'B'].every(name => requests.get(name)?.completed)) invalid()
      const state = { role, input, nativeTaskName: null, completed: false, rawFinal: null, output: null, serviceUsage: null }
      requests.set(role, state)
      return publicRequest(state)
    }) },
    output(role) { return guarded(() => { const state = requests.get(role); if (!state?.completed) invalid(); return Buffer.from(state.output) }) },
    verifyInvocation({ role, inputBytes, outputBytes }) { return guarded(() => {
      const state = requests.get(role)
      if (!state?.completed || !state.nativeTaskName || !state.input.equals(bytes(inputBytes)) || !state.output.equals(bytes(outputBytes))) invalid()
      return Object.freeze({ schemaVersion: 2, protocol: SEMANTIC_NATIVE_COLLABORATION_V2, role, model: MODEL, nativeTaskName: state.nativeTaskName, forkTurns: 'none', inputSha256: semanticSha256(state.input), outputSha256: semanticSha256(state.output), serviceUsage: state.serviceUsage })
    }) },
    assertComplete() { return guarded(() => { if (!ROLES.every(role => requests.get(role)?.completed) || new Set([...requests.values()].map(state => state.nativeTaskName)).size !== 3) invalid(); return true }) },
    stop() { failed = true },
    audit() { return Object.freeze([...requests.values()].map(state => Object.freeze({ role: state.role, model: MODEL, forkTurns: 'none', nativeTaskName: state.nativeTaskName, completed: state.completed, inputSha256: semanticSha256(state.input), outputSha256: state.output && semanticSha256(state.output), serviceUsage: state.serviceUsage ?? Object.freeze({ availability: 'unavailable' }) }))) }
  })
  bridges.set(bridge, { claim(failure) { if (claimed || failed) fail(); claimed = true; onFailure = failure; return transport } })
  return Object.freeze({
    bridge,
    pendingRequests() { return guarded(() => Object.freeze([...requests.values()].filter(state => !state.completed).map(state => state.handle))) },
    observeSpawn(handle, observation) { return guarded(() => {
      exact(observation, ['task_name', 'model', 'fork_turns', 'inputBytes'])
      const state = requestState(handle); const name = taskName(observation.task_name)
      if (state.nativeTaskName || state.completed || observation.model !== MODEL || observation.fork_turns !== 'none' || !state.input.equals(bytes(observation.inputBytes)) || usedTaskNames.has(name)) invalid()
      state.nativeTaskName = name; usedTaskNames.add(name)
      return Object.freeze({ role: state.role, nativeTaskName: name })
    }) },
    observeCompletion(handle, observation) { return guarded(() => {
      exact(observation, ['task_name', 'model', 'fork_turns', 'inputBytes', 'status', 'rawFinal'], ['finalBytes', 'serviceUsage'])
      const state = requestState(handle)
      if (!state.nativeTaskName || state.completed || taskName(observation.task_name) !== state.nativeTaskName || observation.model !== MODEL || observation.fork_turns !== 'none' || observation.status !== 'completed' || !state.input.equals(bytes(observation.inputBytes)) || typeof observation.rawFinal !== 'string') invalid()
      const output = Buffer.from(observation.rawFinal, 'utf8')
      if (!output.length || output.length > 4 * 1024 * 1024 || new TextDecoder('utf-8', { fatal: true }).decode(output) !== observation.rawFinal || (observation.finalBytes !== undefined && !output.equals(bytes(observation.finalBytes)))) invalid()
      state.serviceUsage = usage(observation.serviceUsage); state.rawFinal = observation.rawFinal; state.output = output; state.completed = true
      return transport.verifyInvocation({ role: state.role, inputBytes: state.input, outputBytes: state.output })
    }) },
    cancel() { failed = true; onFailure() },
    auditRecords() { return JSON.parse(semanticCanonicalJson(transport.audit())) }
  })
}

/** Internal connection used by the same-host orchestrator; cannot import receipts. */
export function claimM09NativeBridge(bridge, onFailure) {
  const owner = bridge && bridges.get(bridge)
  if (!owner || typeof onFailure !== 'function') invalid()
  return owner.claim(onFailure)
}
