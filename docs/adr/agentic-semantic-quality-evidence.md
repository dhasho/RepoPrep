# ADR: M09 standalone blinded semantic quality evidence

Date: 2026-11-11. Status: implemented offline as Module E2 in the isolated L worktree; uncommitted and unintegrated. This is a quality evidence module, not M09 acceptance, source authority, a paid model runner, or budget verification.

## Shared projection and dependency boundary

`scripts/agentic/semantic-review.mjs` imports only Node crypto. It does not import E1, S/R/V, L runtime, a dataset loader, filesystem, provider, settings, or credentials. The separate `semantic-review-score.mjs` is the only private file adapter. Nothing loads actual keys during module development or tests; test key documents are newly authored synthetic fixtures under bounded temporary directories.

The exact E1-to-E2 projection is `{schemaVersion:1,executionHash,publicDataHash,reviews,repairs}`. There are exactly80 reviews and20 repairs, with unitId and sampleId each unique across both sets. Review entries are `{unitId,sampleId,assessment}`, with assessment material-risk/no-material-risk/uncertain/incomplete. Repair entries are `{unitId,sampleId,status,before,after,sources}`, with status applied/incomplete/not-run. `before` and `after` are always `{question:content,glossary:{...}}`; content has question, answer, followUps and optional title, no IDs. Follow-ups use the actual optional nested followUps grammar, at most two levels. An incomplete/not-run repair must have byte-canonical equal before/after content.

Sources are exactly `{path,startLine,endLine,sha256,text}`. Paths are safe relative POSIX paths; ranges are positive, bounded and match the number of LF-delimited lines. The range hash is SHA-256 of UTF-8 text with LF line endings. E2 verifies the projected text/hash/range relationship; E1 remains responsible for proving those bytes came from the frozen actual public source files and retaining every actual prompt source. E2 creates no paid source authority.

Bounds include32 sources per repair,128KiB and2000 lines per source,256KiB per content unit,32MiB for a projection/public packet document,8 follow-ups per node,73 answer paths per side,64 material issue groups per packet,16 witnesses per group/decision and2000-character explanations. Plain enumerable data records and dense standard arrays are required. Unknown keys, sparse/custom arrays, symbols, nonenumerable fields, getters, malformed JSON, duplicate JSON keys, invalid UTF-8, excessive nesting and recognizable credential text are rejected. Parser/adapter errors do not echo offending data or paths.

## Blinding and binding

`freezeSemanticScoringProjection(projection)` returns a validated immutable owned copy. It does not attest execution or real provenance.

`buildSemanticReviewPackets(projection)` returns `{publicPackets,privateMap,sideMapHash}`. Only `publicPackets` may enter the judge input. Its exact shape is `{protocol:'m09-semantic-blind-pairs-v1',packets:[{packetId,sides:{U,V},sources:[{sourceId,path,startLine,endLine,sha256,text}]}]}`. Cryptographic random bytes produce128-bit packet/source IDs; cryptographic random integers shuffle packet/source order and choose the side assignment independently. No historical side, sample/unit ID, status, production finding, provider, strategy, reviewer or private label is projected. Literal sample/unit identifier leaks in content are rejected.

The separate privateMap binds executionHash, publicDataHash, canonical packet hash, the exact20 sample/unit/packet bijection, beforeSide, both content hashes and every opaque source ID/hash. sideMapHash binds the whole canonical map. `validateSemanticReviewPackets(projection,bundle)` recomputes all bindings against the frozen projection, including actual content and source multisets; recomputing a tampered map hash alone is insufficient.

## Independent roles and adjudication

`createSemanticJudgeInput(publicPackets)` returns canonical UTF-8 bytes with the full rubric and explicit output schema. A and B receive exactly the same blinded bytes in fresh independent contexts. Roles are recorded outside public packets. `createSemanticAdjudicatorInput(publicPackets,ABytes,BBytes)` includes public packets, blinded A/B assessments, all disputes, full output schema and required per-packet resolution schema. It excludes the private map and label documents.

Each output is `{protocol:'m09-semantic-judgment-v1',packets:[...]}`. Every packet must cover every actual answer path on both sides exactly once, including nested follow-up answers. Each path is clear/material/uncertain with exact local issue references. Material issues have unique local IDs, explicit U/V/both membership, actual answer paths, one or more actual bounded source witnesses and a concrete explanation. Member-to-path references must agree in both directions. Scope equivalence and both sides' usefulness have source witnesses and explanations. This is source-grounded judging, not production R/V self-grading or keyword grading.

All20 packets require fresh adjudication, because structural signatures and matching phrases do not prove semantic issue equivalence. `describeSemanticDisputes(...)` always records semantic-equivalence-unproven and records additional membership/path/scope/usefulness differences. Structural comparison ignores issue IDs, array order and explanation phrasing; it never substitutes for adjudication. The adjudicator supplies final grouping plus `{state:'resolved'|'unresolved',reviewerA:'accepted'|'revised',reviewerB:'accepted'|'revised',explanation}`. Accepted must preserve the corresponding structural decisions. An unresolved/uncertain final judgment remains explicit and prevents quality completeness. The quality result retains final grouping, witnesses and every dispute.

A submission document is `{schemaVersion:1,submissions:[{role:'A'|'B'|'adjudicator',output:rawJsonText}]}`. There must be exactly one of each role. An invocation receipt is exactly `{role,model,agentId,taskId,contextId,contextMode,inputSha256,outputSha256,serviceUsage}`. Model is actual `gpt-6.1-sol`; contextMode is fresh-isolated; agent, task and context IDs must each be distinct across all three roles. Input/output hashes bind actual raw UTF-8 bytes. Usage is `{availability:'unavailable'}` when the agent service exposes none, or `{availability:'available',inputTokens,outputTokens}`. Historic Luna provenance cannot be relabeled. These fields alone cannot prove a real native call: the trusted host must obtain receipts from the actual invocation mechanism. No human-review claim is made.

## Delayed private scoring adapter

`createSemanticScoringOnlyAdapter({verifyExecutionFreeze,verifyJudgeInvocation,privateKeyBindings})` captures trusted host callbacks and immutable expected private asset metadata. The bindings contain only rootDir and exact reviewKey/repairKey `{path,byteLength,sha256}`, naming review-key.json and repair-key.json. The host must bind these to the later accepted dataset manifest; reports cannot select a verifier or override bindings.

1. `await adapter.freezeExecution(executionBytes)` copies raw freeze bytes, invokes the trusted E1 verifier and accepts only a fully validated projection whose executionHash matches those exact bytes. A report-supplied pass Boolean is not a verifier result. The returned handle is branded in a private WeakMap.
2. `adapter.buildPackets(executionHandle)` produces the separate public/private packet bundle.
3. `await adapter.freezeJudgments(executionHandle,bundle,judgmentBytes)` takes owned copies, derives all actual judge/adjudicator input bytes and asks the trusted native-record lookup for each role's full receipt. It validates all hashes, contexts, packet/path/witness coverage, disputes and final grouping before returning a second branded handle. Caller mutations cannot change either freeze.
4. `await adapter.scorePrivateFiles(judgmentHandle)` is the sole file-reading entry. A forged/copied/foreign handle fails before any filesystem read. Only now are the two label files read.

The private reader checks absolute root/path containment, every root component for links/reparse points, real path identity, regular-file status, single hardlink count, bounded expected size, no-follow open where supported, opened/path inode and modification identity before/after bounded reads, and exact raw byte hashes. It parses strict JSON only after those checks. Link/path/hash/size errors are generic. The public core never imports this adapter, preserving a separate dependency graph. No actual labels, holdouts, saved profile or provider is accessed here during development.

The future trusted E1/native callbacks and final checker are deliberately not implemented by E2. Supplying synthetic callbacks can exercise this adapter but proves only offline behavior; it cannot authorize real M09 or establish budget compliance.

## Scoring and completeness

`validateSemanticJudgments(projection,bundle,judgmentBytes,invocations)` validates the structural evidence and returns frozen final grouping/disputes/receipt metadata. `scoreSemanticQuality({projection,bundle,judgmentBytes,invocations,reviewKey,repairKey})` accepts explicit label documents for pure synthetic tests; production reads must use the delayed adapter.

Both private document containers are exactly `{schemaVersion:1,labels:[...]}`, confirmed from existing dataset-contract source/schema tests without reading actual keys. Review labels bijectively match all80 samples and contain exactly40 material-error and40 good labels, with the existing errors/facts grammar. Repair labels bijectively match all20 and contain expectedRepairFacts/errorExplanation. Repair facts are not sent to judges and are never phrase-matched or otherwise used as the verdict.

Review recall is detected-bad/40; false-positive rate is flagged-good/40. All80 stay in denominator. Uncertain/incomplete review assessments remain explicit and prevent full quality completeness. Final M09 applies the unchanged manifest limits; this module returns the metrics rather than asserting full acceptance.

A repair earns credit only if status is applied, content actually changed, at least one final before-side material issue is absent after, final after-side material issues are zero, scope is equivalent, after is useful and final adjudication is resolved without uncertainty. Clean-looking pairs with no established original issue get zero credit. Shared before/after groups are remaining errors, never introduced errors. All after-only material issue groups across all20 count as introduced, even in unsuccessful cases.

Known failed/incomplete/not-run/unchanged cases remain in the20 denominator and get zero credit. A fully accounted failed repair does not by itself make quality evidence incomplete: six such failures can coexist with the14/20 threshold. Outcomes retain status/changed/credit/issue counts, plus aggregate failed/incomplete/notRun counts. Missing mappings/outputs/paths or malformed evidence are rejected; unresolved judgments remain explicit. Repair thresholds are at least14 correct and zero introduced groups. The returned kind is semantic-quality-only. There is no pass field or budgetCompliant field. Final M09 must separately combine verified E1 request/usage/budget/real provenance, this frozen quality evidence and the unchanged manifest requiredCheckId/limits.

## Verification and limits

Focused tests use80 synthetic review cases,20 synthetic repair pairs, synthetic native receipts and newly authored synthetic private files. They cover randomization/private projection, recomputed map tampering, full path/witness coverage, copied identities, raw byte provenance, shared versus introduced issues, original-error removal, scope/usefulness, uncertainty,13/14 repair boundaries, six accounted failures, fixed80/20 denominators, duplicate JSON/invalid UTF-8, getter spies/dense arrays, freeze mutation and private link/path/hash/size checks. No network, key discovery, Git metadata operation or UI is used.

This ADR does not claim any real quality outcome, approved invocation, native provider run, M09 pass, budget compliance, P5 durable wiring, P6 factory or integration. The accepted L source and recovery archive remain frozen.
