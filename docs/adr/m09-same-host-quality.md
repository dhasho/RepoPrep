# M09 same-host quality and native observations

Status: E4 offline implementation, 2026-11-11. This is not a real M09 acceptance record. No provider, Electron, native judge or paid evaluation was run. The exact rejected Git/native operations remain unattempted.

## Canonical authority

`createM09QualityHost` in `scripts/agentic/m09-quality-host.mjs` is a same-process API for one long-lived ordinary Node host controlled by root. It imports canonical `scripts/evaluation/run-semantic-profile.cjs` once through Node's module cache and retains the actual launch result, `nativeParentProof`, `expectedFreezeBytes` and canonical E1 validator closure. The proof does not leave the closure. There is no archive/JSON launch-result import and no production callback injection for launch, validation, scoring or gate.

The source must already be clean and integrated before configuration. The host records E3b's actual Git commit/tree identity, verifies the scoped source map, and rejects later source changes. It calls `validateFrozenSemanticExecution` with `requireReal: true`, exact retained bytes and the live proof every time execution authority is consumed. `projectSemanticScoringInputs` accepts only the actual E1 wrapper. Authorization must match the launch reference, source, budgets and canonical E3b validated artifact. The host does not discover credentials or change saved settings.

E3b is intentionally absent in the isolated E4 worktree. A production configuration fails `M09_CANONICAL_E3B_UNAVAILABLE` before loading settings or launching. No synthetic driver is substituted. The scoped lock binds E3b file bytes read from the accepted sibling `p6-workflow-store`; `scoped-source-origins.json` records that provenance. Root must compare these exact bytes to the independently accepted E3b freeze at integration. The final merged checkout must satisfy all scoped source bindings. The source identity of the whole clean checkout is checked separately by E3b; `lock.m09.sourceSha256` is explicitly a canonical scoped-file-map hash, not the gate's full source-tree hash.

The 2026-11-11 LF checkout candidate pins only the 16 scoped source paths to `text eol=lf`. Source verification still hashes exact working-file bytes. The original E4 lock used one mixed CRLF/LF byte sequence for `run-semantic-profile-entry.cjs` (1692 bytes, `484509fb5abdea469d7c35a35559bf7e7fd7de047de55bc6bf36d6b480a343ab`); Git stores its LF form (1691 bytes, `5aa431d4354bb7fedc60324e427c093f7f9323e469d54e9744be05ca2f8bcba0`). This candidate corrects that one source-map entry and the aggregate hash to the committed LF bytes. Historical locks and native evidence retain their original meaning: their witness does not transfer to this candidate, which requires a new clean source freeze and separately authorized same-host execution and native judgments. No historical manifest, dataset, private key, threshold or runtime byte check changes.

## External trust boundary

`createRootSupervisedM09NativeBridge` is a trusted external observation bridge. Node does not implement Codex collaboration tools. The root supervisor must dispatch the exact pending request's `inputText`, without a prefix, suffix or wrapper, using requested `gpt-6.1-sol` and `fork_turns: none`. Root alone supplies the actual returned canonical `task_name` and later actual completed observation. The bridge retains request bytes, actual task name, raw final string, UTF8 bytes, model and fork setting. It checks exact bindings, three distinct task names, one completion per request and live request object identity. It never invents UUIDs, independent agent/context IDs, tool counts or service usage. Missing usage stays `{availability: 'unavailable'}`.

The bridge cannot independently prove that an observation really came from a native tool. A caller who fabricates root observations defeats this explicit trust assumption. A task-name string, token, callback, persisted JSON receipt or stored audit hash is not cryptographic evidence of native invocation. Receipt files can verify stored bindings only. Restarted/foreign/copied request objects and serialized sessions have no live authority. `fork_turns: none` plus root's observed dispatch is the supported fresh-context claim; there is no stronger filesystem or tool isolation attestation.

The v2 fixed request instruction says supplied public bytes only, no tools, filesystem, network, private keys, other chats or extra context. A/B receive identical bytes. The adjudicator receives actual raw A/B strings including trailing whitespace, parsed A/B judgments and all 20 pairs, even agreements. Judgment output retains the established `m09-semantic-judgment-v1` grammar; invocation selection explicitly uses `native-collaboration-v2` and input protocols explicitly use v2. Existing v1 defaults, receipts and historical fixtures remain valid.

## Same-process workflow

The following is API documentation, not authorization to run it in this task. After root obtains separate permission for the actual native/provider work and integrates the accepted sources into a clean checkout, it may supervise these operations in the same retained Node process:

```js
const { createM09QualityHost } = await import('./scripts/agentic/m09-quality-host.mjs')
const { createRootSupervisedM09NativeBridge } = await import('./scripts/agentic/m09-native-collaboration.mjs')
const external = createRootSupervisedM09NativeBridge()
const session = await createM09QualityHost({
  sourceRoot,
  launchOptions: { repoRoot: sourceRoot, settingsDirectory, profileId, reference, outputDirectory },
  nativeBridge: external.bridge,
  privateKeyBindings // rootDir + reviewKey/repairKey {path, byteLength, raw sha256}
})
await session.execute()
// Root reads external.pendingRequests() for A/B. For each actual native spawn:
external.observeSpawn(request, {
  task_name: actualSpawn.task_name,
  model: 'gpt-6.1-sol', fork_turns: 'none', inputBytes: request.inputBytes
})
// After root observes that same actual task completed, without trimming/repair:
external.observeCompletion(request, {
  task_name: actualCompletedTaskName,
  model: 'gpt-6.1-sol', fork_turns: 'none', inputBytes: request.inputBytes,
  status: 'completed', rawFinal: actualRawFinal,
  finalBytes: Buffer.from(actualRawFinal, 'utf8')
  // serviceUsage omitted unless truly available from the actual service
})
// Repeat actual completion observation for both A/B, then:
await session.adjudicate()
// Dispatch/observe the one pending adjudicator using the same exact procedure.
await session.freezeJudgments()
await session.score()
const gateReport = await session.gate()
```

`request` above is the exact live object returned by `external.pendingRequests()` for that role; it must survive each wait. Neither a recreated request nor an audit receipt can replace it. The root should keep session/bridge objects in its long-lived `mcp_node_repl` or equivalent ordinary Node process. A tool result or a document cannot recover them after restart. Errors, cancellation, replays and incorrect phase calls permanently absorb into failed; the diagnostics remain in `session.snapshot()`. Launch has no host-level paid retry. The current E3b launch API has no cancellation signal; cancellation during its already started operation prevents every later phase and preserves output, but does not claim to abort the child/provider at that instant.

## Private reads and gate

The host freezes execution, builds one randomized packet set, collects A/B and adjudication, and freezes all three exact native observations through E2 before any private scoring read. Only E2's branded judgment handle can call its private loader. Raw private descriptors are supplied separately from gate-normalized text hashes; the scoring loader verifies both at the delayed read. No private key contents were read to produce E4 or its lock. Historical `manifest.v2.json`, `manifest.v2.lock.json`, P0 and M08 evidence remain exact.

The new scoped M09 manifest contains only M09, retains manifest version 2 and historical global `reviewProtocol`, and adds scoped Sol/v2/all-pairs review configuration. Its explicit lock binds source files, configuration, schema, protocol and unchanged historical asset descriptors. The generic full-tree hash is neither calculated nor used before judging. The manifest/source reader uses bounded opened-handle reads with nofollow where supported, pre/post file identity and directory/link checks, and rejects hardlinks. It follows the repository's filesystem consistency assumptions; it does not claim a process hostile to itself can be contained on Windows.

The gate registry loads `checks/m09.mjs`, which captures the opaque live session and revalidates E1 and E2. The five metrics are always emitted together for valid complete measurements: `errorRecall`, `falsePositiveRate`, `correctRepairs`, `introducedMaterialErrors`, `budgetCompliant`. Denominators remain 40 wrong, 40 correct, 20 repairs; thresholds remain >=.85 recall, <=.10 FPR, >=14 repairs, zero introduced material errors, with complete quality evidence. Budget compliance independently rechecks the original100 cases, actual usage/settled receipts, admissions/reservations, original per-case request/token/time limits and 240/1600000/1146880 aggregate limits after canonical E1 validation. E2 quality alone grants no budget authority.

Only `session.gate()` creates the one-use in-process permit required before `runGate` accesses its manifest, assets or source tree. That permit returns a private publisher bound to the same canonical session. After the checker's completion, the runner may still await its final source hash and report directory preparation. The publisher therefore revalidates the live execution and judgments again after these awaited steps. It prepares and flushes an explicitly unpublished `.pending` artifact synchronously, checks the still-live session immediately before a synchronous atomic rename, and performs no await or event-loop yield between this final fence and formal report publication. Cancellation or a rejected native observation during any earlier wait prevents a formal pass file. The runner may preserve a failed diagnostic report; an IO failure can preserve an explicitly unpublished recovery artifact. Reports legitimately published while live remain historical evidence if the session is cancelled later. Detached M09 CLI/report invocation remains incomplete with null hashes/report, before any such reads. M06 and M08 authorization paths are unchanged. A synthetic driver exercises the same phases and may expose explicit asynchronous test seams; it never joins the production session registry and can return no real gate pass. No arbitrary injected synthetic callback can grant formal M09 authority.

M09 final report publication also belongs to the private live session. The gate runner performs its ending source fingerprint and creates the report directory, then calls the one-use publisher obtained from canonical preflight. The publisher revalidates execution and all three judgments, checks liveness, writes and fsyncs an explicitly unpublished pending file, rechecks the directory and liveness, and synchronously renames to the final report path. No asynchronous gap exists between the final liveness fence and atomic publication. A cancellation or rejected native observation during any preceding await fails publication; the runner can persist only failed diagnostics. An I/O failure may preserve an unpublished recovery file. Cancellation after a legitimate publication does not rewrite that historical observation.

The exact publisher is shared with offline phase tests, whose outputs are restricted to synthetic mode, a synthetic filename and a non-pass status. These test seams never enter the production session registry. `node --test scripts/agentic/m09-quality-host.test.mjs scripts/agentic/m09-report-publication.test.mjs` includes deterministic cancellation after checker completion, cancellation or rejected observation during final awaited verification, existing-diagnostic preservation, and rejection of synthetic attempts to publish a real pass.

## Offline verification and remaining work

`node --test scripts/agentic/m09-quality-host.test.mjs scripts/agentic/m09-report-publication.test.mjs` covers raw trailing whitespace, A/B equality, actual A/B adjudicator binding, all20 pairs, native wrong/copy/replay/context/model/completion failures, missing usage, v1/v2 selection/mixing, no live session, synthetic gate rejection, original budget/threshold boundaries, bounded reader links, and delayed cancellation at scoring/gate phase seams. Publication regression tests exercise the exact private publisher through a synthetic phase seam: cancellation after a synthetic checker, cancellation/rejected observation during final awaited verification, no persisted formal pass, preservation of existing incomplete diagnostics, and explicit rejection of real mode/pass status by synthetic sessions. Synthetic keys live only in owned temporary fixtures. Existing semantic execution/contract/review suites must also pass. No TypeScript changes require typecheck.

Root must independently review and integrate this uncommitted freeze only when Git permission is resolved, compare the exact E3b hashes, then run the separately authorized real execution and three actual native judges in one host. No offline test or persisted report counts as that acceptance. Automatic approval previously rejected the specified Git/native actions; E4 does not retry or work around them. The complete PLAN remains incomplete pending those independent steps.
