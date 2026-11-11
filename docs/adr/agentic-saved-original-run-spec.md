# ADR: P6 A0 complete original RunSpec codec

Date: 2026-11-11. Status: implemented offline in the isolated L worktree, uncommitted and unintegrated. This codec provides bounded data validation and identity-sensitive integrity, not recovery, project authorization or M10/M11 acceptance.

## Decision and API

New `electron/services/workflow/saved-run-spec.ts` imports the actual local `createRunSpec` and `fingerprintRunSpec` plus Node crypto/util. It has no W/store, settings, saved profile, provider, filesystem, IPC, renderer or shared-source edits.

The codec operates on the COMPLETE resolved RunSpec version1 directly, without an extra persistence envelope. Exported functions are:

- `validateSavedRunSpec(value:unknown):RunSpec`: validates exact saved data, reconstructs it under actual current constructor policy and returns a deeply immutable owned resolved spec.
- `encodeSavedRunSpec(value:unknown):Uint8Array`: validates first, then emits stable recursively sorted UTF-8 JSON bytes.
- `decodeSavedRunSpec(bytes:Uint8Array):RunSpec`: copies bounded native bytes, validates strict UTF-8/JSON, then performs the complete saved-data validation.
- `hashSavedRunSpec(value:unknown):string`: SHA-256 of `repoprep:saved-original-run-spec:v1\0` followed by the canonical complete JSON bytes. All original runId/projectId/snapshotId fields are included.
- `fingerprintSavedRunSpec(value:unknown):string`: validates the saved original, then calls the existing actual identity-omitting configuration fingerprint. This is a separate named operation, never an alias for the full original hash.

`SAVED_RUN_SPEC_MAX_BYTES` is16KiB and `SAVED_RUN_SPEC_MAX_DEPTH` is8. Current constructor-valid specs at maximum identity/model/version string lengths fit below4KiB; the fixed cap leaves conservative formatting headroom without unbounded data. Errors are `SavedRunSpecError` with one of three finite generic code/messages: SAVED_RUN_SPEC_INVALID, SAVED_RUN_SPEC_BYTES_INVALID, SAVED_RUN_SPEC_TOO_LARGE. No raw input, endpoint, credential, parser text or underlying exception is included.

## Complete data boundary

All16 resolved root fields are required exactly: version, three original identities, strategy/strategyVersion, roleFocus, granularity, questionBudget, model, promptVersion, toolVersion, policyVersion, budget, generationInputTokens and generationOutputTokens. Model requires profileId/endpointFingerprint/model and preserves omission or presence of the constructor's five optional fields. Present undefined or null is rejected; the codec does not invent defaults or explicit nulls. Configured context/output limits are preserved.

questionBudget has exactly min/target/max. budget contains exactly total/investigation/generationReserve. Total and generationReserve have the five actual flat request/input/output/read/time fields; investigation additionally requires the actual maxToolCalls field. No arbitrary maxToolCalls field is accepted on other groups. There are no arrays in resolved RunSpec: ordinary, sparse or extended arrays are rejected.

Before reading constructor fields, validation makes an owned bounded copy of own enumerable data descriptors. Standard or null object prototypes are accepted consistently with the actual constructor; foreign prototypes, proxies, accessors, symbols, nonenumerable aliases, functions, undefined, bigint, nonfinite numbers, cycles, excessive nodes/depth/strings and unknown fields are rejected. Getter/proxy traps are not invoked. Returning a newly reconstructed constructor result ensures no caller-owned nested references survive; root, model, question budget, budget groups and all group records are frozen by actual createRunSpec.

Budget and other integer constraints come from real constructor policy and complete equality. Temperature keeps the constructor's finite fractional0..2 semantics; it is not incorrectly restricted to integer values. Signed-zero temperature is preserved through canonical valid JSON `-0`, avoiding a silent numeric change during bytes roundtrip. The existing configuration fingerprint keeps its own existing normalization semantics.

## Reconstruction and equality

The saved resolved object is never passed directly to createRunSpec. The codec explicitly constructs an input with only approved original identity/strategy/model/version fields and extracts ONLY maxModelRequests/inputTokens/outputTokens/readBytes/wallClockMs from saved budget.total as the flat requested budget.

Actual createRunSpec re-derives all three budget groups, original ceilings, questionBudget, strategyVersion, generationInputTokens and generationOutputTokens. Complete canonical equality with every saved field is mandatory. Altering a derived stage amount, generation reserve, model-effective admission/output or total without consistent derivation is rejected. Honest tighter totals reconstruct with the original limits rather than default ceilings. A syntactically valid original policy/config version string roundtrips according to actual constructor syntax. The codec does not invent a policy-name allowlist; future recovery must separately check authorized supported runtime policy/config versions.

A self-consistent newly constructed spec can also decode: the codec does not claim that data was the previously authorized original. The full hash preserves which exact original identity/config bytes were committed; a future authenticated store must bind that hash under genuine project/attempt authority.

## Strict bytes and hashing

The byte decoder accepts ordinary native Uint8Array or Buffer, including valid offset views. It rejects strings, plain numeric arrays, foreign byte-array prototypes, proxies and extra/accessor properties before copying. A native byte-length getter enforces the cap without evaluating a caller's byteLength alias. Bounded copies avoid later caller mutation.

Fatal UTF-8 decoding rejects invalid start/continuation/overlong/truncated/surrogate encodings. A bounded scanner checks duplicate object keys including escaped aliases, syntax, JSON-only whitespace, trailing data and nesting before object validation. A BOM is preserved for rejection rather than silently stripped. JSON.parse exceptions are replaced by generic codec codes. Optional field omission and every original resolved field survive roundtrip; recursively reordered input keys yield identical canonical output/hash.

The full original hash and existing config fingerprint have different meanings. Changing any original run/project/snapshot ID changes the former while leaving the latter equal when config is unchanged. Neither is a project/source/owner capability or permission to replay a paid operation.

## Offline verification and remaining work

Focused tests use actual local createRunSpec for static/agentic and coarse/medium/fine, default/explicit OpenAI and Anthropic models, model-specific default output reserves, fractional and signed-zero temperature, custom valid policy names, tightened original budgets, immutable ownership and stable identity-sensitive hash roundtrips. Negative cases exercise every budget group/field, question allocations, generation admission/output, effective model limits, missing/extra/private fields, unsupported schema/constructor syntax, null/undefined optional fields, nonfinite/fractional quotas, getter/proxy spies, foreign/symbol/nonenumerable/sparse data, cycles/depth/size, malformed UTF-8, duplicate JSON keys, invalid byte views and redacted errors.

No synthetic Git repository, provider, actual saved profile/key/holdout, source integration or W dependency is used. Existing accepted L and E2 source/archives remain frozen. Later recovery still requires genuine verified W owner/attempt/project/source capabilities, complete critical journal validation, the original ledger/deadline and conservative refusal to automatically repeat uncertain paid operations. This codec alone supplies none of those capabilities and does not establish M10/M11.
