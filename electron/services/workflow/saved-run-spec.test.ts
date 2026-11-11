// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { test } from 'node:test'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { createRunSpec, fingerprintRunSpec, type RunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- Node executes this test through the direct TypeScript runner.
import { SAVED_RUN_SPEC_HASH_DOMAIN, SAVED_RUN_SPEC_MAX_BYTES, SavedRunSpecError, decodeSavedRunSpec, encodeSavedRunSpec, fingerprintSavedRunSpec, hashSavedRunSpec, validateSavedRunSpec } from './saved-run-spec.ts'

type EditableSaved = Record<string, unknown> & { model: Record<string, unknown>; questionBudget: Record<string, unknown>; budget: { total: Record<string, unknown>; investigation: Record<string, unknown>; generationReserve: Record<string, unknown> } }
const input = () => ({
  version: 1, runId: 'original-run-01', projectId: 'original-project-01', snapshotId: 'original-snapshot-01', strategy: 'agentic', strategyVersion: 'agentic-v1', roleFocus: 'backend', granularity: 'fine',
  model: { profileId: 'original-profile-01', endpointFingerprint: 'a'.repeat(64), model: 'example-model', protocol: 'openai', reasoningEffort: 'high', temperature: 0.35, contextWindowTokens: 49152, maxOutputTokens: 4096 },
  promptVersion: 'workflow-prompt-v1', toolVersion: 'read-tools-v1', policyVersion: 'read-policy-v1'
})
const editable = (spec: RunSpec = createRunSpec(input())): EditableSaved => JSON.parse(JSON.stringify(spec)) as EditableSaved
function validError(error: unknown): boolean {
  assert.ok(error instanceof SavedRunSpecError)
  assert.ok(['SAVED_RUN_SPEC_INVALID', 'SAVED_RUN_SPEC_BYTES_INVALID', 'SAVED_RUN_SPEC_TOO_LARGE'].includes(error.code))
  assert.equal(error.message, error.code); assert.equal(error.message.includes('do-not-echo'), false); assert.equal(error.message.includes('https://'), false)
  return true
}
const invalid = (value: unknown): void => { assert.throws(() => validateSavedRunSpec(value), validError) }
const bytes = (value: string): Uint8Array => Buffer.from(value, 'utf8')
function reverseKeys(value: unknown): unknown {
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]))
  return value
}

for (const strategy of ['static', 'agentic']) for (const granularity of ['coarse', 'medium', 'fine']) test(`real constructor resolved ${strategy}/${granularity} roundtrips every field`, () => {
  const original = createRunSpec({ ...input(), strategy, strategyVersion: `${strategy}-v1`, granularity })
  const parsed = validateSavedRunSpec(original); const encoded = encodeSavedRunSpec(original); const decoded = decodeSavedRunSpec(encoded)
  assert.deepEqual(parsed, original); assert.deepEqual(decoded, original); assert.ok(encoded instanceof Uint8Array)
  assert.deepEqual(encodeSavedRunSpec(decoded), encoded); assert.equal(hashSavedRunSpec(decoded), hashSavedRunSpec(original))
  assert.equal(fingerprintSavedRunSpec(decoded), fingerprintRunSpec(original))
  assert.notEqual(parsed, original); assert.notEqual(parsed.model, original.model); assert.notEqual(parsed.budget.total, original.budget.total)
})

for (const [name, model] of [
  ['omitted protocol/default reserve', { profileId: 'profile-01', endpointFingerprint: 'b'.repeat(64), model: 'default-model' }],
  ['explicit OpenAI', { profileId: 'profile-01', endpointFingerprint: 'b'.repeat(64), model: 'default-model', protocol: 'openai', reasoningEffort: 'low', temperature: 0.15 }],
  ['Anthropic default output', { profileId: 'profile-01', endpointFingerprint: 'b'.repeat(64), model: 'claude-example', protocol: 'anthropic', temperature: 1.7 }],
  ['Anthropic explicit limits', { profileId: 'profile-01', endpointFingerprint: 'b'.repeat(64), model: 'claude-example', protocol: 'anthropic', contextWindowTokens: 64000, maxOutputTokens: 8192 }],
  ['DeepSeek default output', { profileId: 'profile-01', endpointFingerprint: 'b'.repeat(64), model: 'deepseek-flash' }]
] as const) test(`preserves supported optional/default model semantics: ${name}`, () => {
  const original = createRunSpec({ ...input(), model }); const parsed = decodeSavedRunSpec(encodeSavedRunSpec(original))
  assert.deepEqual(parsed, original); assert.deepEqual(Object.keys(parsed.model).sort(), Object.keys(model).sort())
  if (!Object.hasOwn(model, 'protocol')) assert.equal(Object.hasOwn(parsed.model, 'protocol'), false)
  if (!Object.hasOwn(model, 'contextWindowTokens')) assert.equal(Object.hasOwn(parsed.model, 'contextWindowTokens'), false)
  assert.equal(parsed.model.contextWindowTokens, original.model.contextWindowTokens)
})

test('reconstructs a tight original budget instead of expanding to defaults', () => {
  const original = createRunSpec({ ...input(), granularity: 'coarse', model: { profileId: 'p', endpointFingerprint: 'a'.repeat(64), model: 'small', contextWindowTokens: 4096, maxOutputTokens: 2048 }, budget: { maxModelRequests: 2, inputTokens: 4096, outputTokens: 4096, readBytes: 512, wallClockMs: 1000 } })
  const parsed = decodeSavedRunSpec(encodeSavedRunSpec(original))
  assert.deepEqual(parsed, original); assert.equal(parsed.budget.total.inputTokens, 4096); assert.equal(parsed.generationInputTokens, 2048); assert.equal(parsed.budget.investigation.inputTokens, 2048); assert.equal(parsed.budget.generationReserve.wallClockMs, 1)
  assert.equal(parsed.model.contextWindowTokens, 4096); assert.equal(parsed.model.maxOutputTokens, 2048)
})

test('preserves one-call/no-read/no-investigation original ceilings', () => {
  const original = createRunSpec({ ...input(), budget: { maxModelRequests: 1, inputTokens: 1, outputTokens: 4096, readBytes: 0, wallClockMs: 1 } })
  assert.deepEqual(decodeSavedRunSpec(encodeSavedRunSpec(original)), original)
  assert.equal(original.budget.investigation.maxModelRequests, 0); assert.equal(original.budget.investigation.wallClockMs, 0)
})

test('canonical order is stable across recursively reordered fields and whitespace', () => {
  const original = createRunSpec(input()); const reordered = reverseKeys(original)
  assert.deepEqual(encodeSavedRunSpec(original), encodeSavedRunSpec(reordered)); assert.equal(hashSavedRunSpec(original), hashSavedRunSpec(reordered))
  assert.deepEqual(decodeSavedRunSpec(bytes(` \r\n${JSON.stringify(reordered, null, 2)} \t`)), original)
})

test('full domain-separated original hash retains identities while actual config fingerprint omits them', () => {
  const first = createRunSpec(input()); const changed = createRunSpec({ ...input(), runId: 'run-02', projectId: 'project-02', snapshotId: 'snapshot-02' })
  assert.equal(fingerprintSavedRunSpec(first), fingerprintSavedRunSpec(changed)); assert.equal(fingerprintSavedRunSpec(first), fingerprintRunSpec(first))
  assert.notEqual(hashSavedRunSpec(first), hashSavedRunSpec(changed)); assert.notEqual(hashSavedRunSpec(first), fingerprintSavedRunSpec(first))
  const expected = createHash('sha256').update(SAVED_RUN_SPEC_HASH_DOMAIN, 'utf8').update(encodeSavedRunSpec(first)).digest('hex')
  assert.equal(hashSavedRunSpec(first), expected); assert.match(expected, /^[0-9a-f]{64}$/)
  assert.notEqual(expected, createHash('sha256').update(encodeSavedRunSpec(first)).digest('hex'))
  for (const identity of ['runId', 'projectId', 'snapshotId']) { const copy = editable(first); copy[identity] = 'different-identity'; assert.notEqual(hashSavedRunSpec(copy), expected); assert.equal(fingerprintSavedRunSpec(copy), fingerprintSavedRunSpec(first)) }
})

test('every honest config change affects full hash, including valid custom policy names', () => {
  const first = createRunSpec(input()); const second = createRunSpec({ ...input(), policyVersion: 'site-specific-policy-v27', promptVersion: 'custom-prompt-v9', toolVersion: 'readonly-tools-v12' })
  assert.deepEqual(validateSavedRunSpec(second), second); assert.notEqual(hashSavedRunSpec(first), hashSavedRunSpec(second)); assert.notEqual(fingerprintSavedRunSpec(first), fingerprintSavedRunSpec(second))
})

test('omitted protocol and explicit OpenAI remain distinct original configurations', () => {
  const base = input(); const model: Record<string, unknown> = { ...base.model }; delete model.protocol
  const omitted = createRunSpec({ ...base, model }); const explicit = createRunSpec(base)
  assert.equal(Object.hasOwn(validateSavedRunSpec(omitted).model, 'protocol'), false); assert.equal(Object.hasOwn(validateSavedRunSpec(explicit).model, 'protocol'), true)
  assert.notEqual(hashSavedRunSpec(omitted), hashSavedRunSpec(explicit))
})

test('returns deeply immutable owned nested data and does not mutate input', () => {
  const saved = editable(); const before = JSON.stringify(saved); const parsed = validateSavedRunSpec(saved)
  assert.equal(JSON.stringify(saved), before)
  for (const value of [parsed, parsed.model, parsed.questionBudget, parsed.budget, parsed.budget.total, parsed.budget.investigation, parsed.budget.generationReserve]) assert.equal(Object.isFrozen(value), true)
  saved.model.model = 'changed'; saved.budget.total.inputTokens = 1
  assert.notEqual(parsed.model.model, saved.model.model); assert.notEqual(parsed.budget.total.inputTokens, saved.budget.total.inputTokens)
  assert.throws(() => { (parsed.model as { model: string }).model = 'other' }, TypeError)
})

test('supports constructor-valid null-prototype records but returns normal frozen records', () => {
  const saved = editable(); Object.setPrototypeOf(saved, null); Object.setPrototypeOf(saved.model, null)
  const parsed = validateSavedRunSpec(saved); assert.deepEqual(parsed, createRunSpec(input())); assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
})

test('signed-zero temperature remains exact through JSON bytes while fingerprint semantics stay unchanged', () => {
  const original = createRunSpec({ ...input(), model: { ...input().model, temperature: -0 } }); const parsed = decodeSavedRunSpec(encodeSavedRunSpec(original))
  assert.equal(Object.is(parsed.model.temperature, -0), true); assert.equal(Buffer.from(encodeSavedRunSpec(original)).toString().includes('"temperature":-0'), true)
  assert.deepEqual(parsed, original)
})

for (const group of ['total', 'investigation', 'generationReserve'] as const) for (const field of ['maxModelRequests', 'inputTokens', 'outputTokens', 'readBytes', 'wallClockMs', ...(group === 'investigation' ? ['maxToolCalls'] : [])]) test(`rejects altered derived ${group}.${field}`, () => {
  const saved = editable(); saved.budget[group][field] = Number(saved.budget[group][field]) + 1; invalid(saved)
})
for (const field of ['min', 'target', 'max']) test(`rejects altered derived questionBudget.${field}`, () => { const saved = editable(); saved.questionBudget[field] = Number(saved.questionBudget[field]) + 1; invalid(saved) })
for (const field of ['generationInputTokens', 'generationOutputTokens']) test(`rejects altered derived ${field}`, () => { const saved = editable(); saved[field] = Number(saved[field]) + 1; invalid(saved) })

for (const [name, change] of [
  ['effective model input changes', (saved: EditableSaved) => { saved.model.contextWindowTokens = 8192 }],
  ['effective model output changes', (saved: EditableSaved) => { saved.model.maxOutputTokens = 8192 }],
  ['strategy version', (saved: EditableSaved) => { saved.strategyVersion = 'agentic-v2' }],
  ['input ceilings', (saved: EditableSaved) => { saved.budget.total.inputTokens = 128001 }],
  ['output ceilings', (saved: EditableSaved) => { saved.budget.total.outputTokens = 65537 }],
  ['request ceilings', (saved: EditableSaved) => { saved.budget.total.maxModelRequests = 15 }],
  ['time ceilings', (saved: EditableSaved) => { saved.budget.total.wallClockMs = 600001 }],
  ['read ceilings', (saved: EditableSaved) => { saved.budget.total.readBytes = Number.MAX_SAFE_INTEGER }],
  ['incompatible version', (saved: EditableSaved) => { saved.version = 2 }],
  ['unknown schema alias', (saved: EditableSaved) => { saved.schemaVersion = 1 }],
  ['flat constructor budget replacing resolved budget', (saved: EditableSaved) => { saved.budget = { ...saved.budget.total } as unknown as EditableSaved['budget'] }]
] as const) test(`refuses saved inconsistency: ${name}`, () => { const saved = editable(); change(saved); invalid(saved) })

for (const [group, field] of [['root', 'projectId'], ['root', 'generationInputTokens'], ['root', 'questionBudget'], ['model', 'profileId'], ['model', 'endpointFingerprint'], ['model', 'model'], ['budget', 'investigation'], ['total', 'readBytes'], ['investigation', 'maxToolCalls'], ['generationReserve', 'wallClockMs']] as const) test(`requires complete resolved field ${group}.${field}`, () => {
  const saved = editable(); const object = group === 'root' ? saved : group === 'model' ? saved.model : group === 'budget' ? saved.budget : saved.budget[group]
  delete (object as Record<string, unknown>)[field]; invalid(saved)
})

for (const field of ['protocol', 'reasoningEffort', 'temperature', 'contextWindowTokens', 'maxOutputTokens']) for (const value of [null, undefined]) test(`rejects present ${field}=${String(value)} instead of inventing omission/default`, () => {
  const saved = editable(); saved.model[field] = value; invalid(saved)
})

for (const [field, value] of [['policyVersion', 'no-version'], ['policyVersion', 'policy-v0'], ['policyVersion', 'policy-v10000'], ['policyVersion', 'policy v1'], ['promptVersion', 1], ['toolVersion', null], ['strategy', 'dynamic'], ['roleFocus', 'manager'], ['granularity', 'ultra']] as const) test(`rejects unsupported constructor syntax ${field}:${String(value)}`, () => { const saved = editable(); saved[field] = value; invalid(saved) })

for (const [name, value] of [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['negativeInfinity', Number.NEGATIVE_INFINITY], ['fraction', 3.5], ['unsafeInteger', Number.MAX_SAFE_INTEGER + 1], ['negative', -1]] as const) test(`rejects invalid quota number ${name}`, () => {
  const saved = editable(); saved.budget.total.maxModelRequests = value; invalid(saved)
})

for (const [name, mutate] of [
  ['root credentials', (saved: EditableSaved) => { saved.apiKey = 'do-not-echo' }],
  ['model endpoint', (saved: EditableSaved) => { saved.model.endpoint = 'https://do-not-echo.invalid/v1' }],
  ['model secret', (saved: EditableSaved) => { saved.model.apiKey = 'do-not-echo' }],
  ['budget arbitrary extension', (saved: EditableSaved) => { saved.budget.total.maxToolCalls = 8 }],
  ['reserve arbitrary extension', (saved: EditableSaved) => { saved.budget.generationReserve.maxToolCalls = 8 }],
  ['model unknown action', (saved: EditableSaved) => { saved.model.action = 'do-not-echo' }],
  ['root symbol', (saved: EditableSaved) => { Object.defineProperty(saved, Symbol('private'), { value: 'do-not-echo', enumerable: true }) }],
  ['foreign prototype', (saved: EditableSaved) => { Object.setPrototypeOf(saved.model, { secret: 'do-not-echo' }) }],
  ['nonenumerable required field', (saved: EditableSaved) => { Object.defineProperty(saved.model, 'profileId', { value: saved.model.profileId, enumerable: false }) }],
  ['nonenumerable private alias', (saved: EditableSaved) => { Object.defineProperty(saved, 'privateKey', { value: 'do-not-echo', enumerable: false }) }],
  ['sparse array', (saved: EditableSaved) => { saved.model = Array(8) as unknown as Record<string, unknown> }],
  ['array with private property', (saved: EditableSaved) => { const array: unknown[] & { apiKey?: string } = []; array.apiKey = 'do-not-echo'; saved.model = array as unknown as Record<string, unknown> }],
  ['date class', (saved: EditableSaved) => { saved.model = new Date() as unknown as Record<string, unknown> }],
  ['cycle', (saved: EditableSaved) => { saved.self = saved }],
  ['function', (saved: EditableSaved) => { saved.model.extra = () => 'do-not-echo' }],
  ['bigint', (saved: EditableSaved) => { saved.model.extra = 2n }]
] as const) test(`rejects unsafe plain-data shape ${name}`, () => { const saved = editable(); mutate(saved); invalid(saved) })

test('does not invoke getters at any nesting level or through proxies', () => {
  let invoked = 0
  for (const location of ['root', 'model', 'total', 'questionBudget']) {
    const saved = editable(); const object = location === 'root' ? saved : location === 'model' ? saved.model : location === 'total' ? saved.budget.total : saved.questionBudget
    Object.defineProperty(object, 'doNotEcho', { enumerable: true, get() { invoked += 1; return 'do-not-echo' } }); invalid(saved)
  }
  const proxied = new Proxy(editable(), { getPrototypeOf() { invoked += 1; throw new Error('do-not-echo') }, ownKeys() { invoked += 1; throw new Error('do-not-echo') } })
  invalid(proxied); assert.equal(invoked, 0)
})

test('bounded plain data rejects excessive depth and string bytes', () => {
  const saved = editable(); let nested: Record<string, unknown> = saved
  for (let index = 0; index < 20; index += 1) { const next = {}; nested.deep = next; nested = next }
  invalid(saved)
  const oversized = editable(); oversized.model.model = '界'.repeat(SAVED_RUN_SPEC_MAX_BYTES + 1)
  assert.throws(() => validateSavedRunSpec(oversized), (error: unknown) => { validError(error); assert.equal((error as SavedRunSpecError).code, 'SAVED_RUN_SPEC_TOO_LARGE'); return true })
})

test('all hash and byte encoding entry points validate instead of hashing malformed saved claims', () => {
  const saved = editable(); saved.generationOutputTokens = 1
  for (const operation of [validateSavedRunSpec, encodeSavedRunSpec, hashSavedRunSpec, fingerprintSavedRunSpec]) assert.throws(() => operation(saved), validError)
})

for (const [name, source] of [
  ['root duplicate', '{"runId":"first","runId":"second"}'],
  ['escaped duplicate', '{"runId":"first","\\u0072unId":"second"}'],
  ['nested duplicate', '{"model":{"model":"first","model":"second"}}'],
  ['budget duplicate', '{"budget":{"total":{"inputTokens":1,"inputTokens":2}}}'],
  ['trailing data', '{} {}'],
  ['trailing comma', '{"runId":"x",}'],
  ['invalid JSON escape', '{"runId":"\\x20"}'],
  ['unclosed string', '{"runId":"x}'],
  ['unsupported BOM', '\ufeff{}'],
  ['unsupported whitespace', '\u00a0{}'],
  ['depth', `${'{"x":'.repeat(20)}0${'}'.repeat(20)}`]
] as const) test(`strict bytes reject ${name} before constructor validation`, () => {
  assert.throws(() => decodeSavedRunSpec(bytes(source)), (error: unknown) => { validError(error); assert.equal((error as SavedRunSpecError).code, 'SAVED_RUN_SPEC_BYTES_INVALID'); return true })
})

for (const [name, data] of [['invalid start', [0xff]], ['overlong', [0xc0, 0xaf]], ['truncated', [0xe4, 0xb8]], ['surrogate code point', [0xed, 0xa0, 0x80]]] as const) test(`rejects malformed UTF8 ${name}`, () => {
  assert.throws(() => decodeSavedRunSpec(Uint8Array.from(data)), (error: unknown) => { validError(error); assert.equal((error as SavedRunSpecError).code, 'SAVED_RUN_SPEC_BYTES_INVALID'); return true })
})

test('rejects plain string/array/custom-prototype byte inputs without evaluating getter aliases', () => {
  for (const value of ['{}', [123, 125], null, 1]) assert.throws(() => decodeSavedRunSpec(value as unknown as Uint8Array), validError)
  let invoked = 0
  const data = encodeSavedRunSpec(createRunSpec(input())); Object.defineProperty(data, 'byteLength', { get() { invoked += 1; return 2 } })
  assert.throws(() => decodeSavedRunSpec(data), validError); assert.equal(invoked, 0)
  const proxy = new Proxy(encodeSavedRunSpec(createRunSpec(input())), { get() { invoked += 1; return 1 } })
  assert.throws(() => decodeSavedRunSpec(proxy), validError); assert.equal(invoked, 0)
  const custom = Uint8Array.from([123, 125]); Object.setPrototypeOf(custom, Object.create(Uint8Array.prototype))
  assert.throws(() => decodeSavedRunSpec(custom), validError)
})

test('byte cap rejects oversized/empty input and preserves offset views', () => {
  for (const data of [Buffer.alloc(0), Buffer.alloc(SAVED_RUN_SPEC_MAX_BYTES + 1, 0x20)]) assert.throws(() => decodeSavedRunSpec(data), validError)
  const original = createRunSpec(input()); const encoded = encodeSavedRunSpec(original); const backing = new Uint8Array(encoded.length + 4); backing.set(encoded, 2)
  assert.deepEqual(decodeSavedRunSpec(new Uint8Array(backing.buffer, 2, encoded.length)), original)
})

test('full constructor string limits and Unicode JSON remain below conservative codec bound', () => {
  const original = createRunSpec({ ...input(), runId: 'r'.repeat(128), projectId: 'p'.repeat(128), snapshotId: 's'.repeat(128), promptVersion: `${'p'.repeat(64)}-v9999`, toolVersion: `${'t'.repeat(64)}-v9999`, policyVersion: `${'x'.repeat(64)}-v9999`, model: { ...input().model, profileId: 'm'.repeat(128), model: '模'.repeat(256) } })
  const encoded = encodeSavedRunSpec(original); assert.ok(encoded.byteLength < SAVED_RUN_SPEC_MAX_BYTES); assert.deepEqual(decodeSavedRunSpec(encoded), original)
})

test('generic decode errors never expose endpoint/credential or parser input', () => {
  for (const source of ['{"apiKey":"do-not-echo",', '{"model":{"endpoint":"https://do-not-echo.invalid"}}']) assert.throws(() => decodeSavedRunSpec(bytes(source)), validError)
})

for (const [field, value] of [['protocol', 'other-protocol'], ['reasoningEffort', 'off'], ['temperature', 3], ['temperature', Number.NaN], ['contextWindowTokens', 4095], ['contextWindowTokens', 2_097_153], ['maxOutputTokens', 65537]] as const) test(`reuses real model policy validation for ${field}:${String(value)}`, () => {
  const saved = editable(); saved.model[field] = value; invalid(saved)
})

test('does not accept a constructor input as a complete resolved saved object', () => { invalid(input()) })

test('refuses incompatible Anthropic reasoning semantics instead of dropping the optional field', () => {
  const saved = editable(); saved.model.protocol = 'anthropic'; invalid(saved)
})
