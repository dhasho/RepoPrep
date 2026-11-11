# M09 encrypted profile snapshot boundary

Status: implemented helper, not wired to an M09 launcher. This decision covers capture and staging only. It does not authorize a run, decrypt a credential, derive the effective model configuration, start a claim, dispatch a request, or establish an M09 quality verdict.

## Main-process API

`scripts/evaluation/m09-profile-snapshot.cjs` exports exactly:

```js
const handle = captureM09ProfileSnapshot({
  settingsDirectory, // explicit absolute Windows directory; no default discovery
  profileId         // optional; otherwise the captured defaultProfileId
})
const staged = stageM09ProfileSnapshot(handle, { runtimeParent })
releaseM09ProfileSnapshot(handle)
```

Capture and stage are synchronous and require Windows Electron main before `app.isReady()`. The native entry must invoke them before its first await and set Electron's four paths from `staged.userData`, `staged.sessionData`, `staged.cache`, and `staged.crashDumps` before app ready. The Node parent cannot use the production capture API. Release also requires native main, but may run after ready.

One module instance permits one capture attempt, including a failed attempt. A caller must retain the returned handle; retries cannot reread the source or choose another profile. The frozen handle has `version: 1`, `credentialState: 'encrypted-unverified'`, and a frozen `selectedProfile` containing only `profileId`, `model`, `savedBaseUrlSha256`, and present saved scalar protocol/reasoning/temperature/context/output fields. No default protocol, token cap, or effective configuration is invented. The base URL hash uses SHA-256 over UTF-8 `repoprep:m09:saved-base-url:v1\0` followed by the exact saved URL. It is not an E1 endpoint-normalization or authorization contract.

The private WeakMap retains the exact captured settings bytes, sanitized supported `os_crypt` bytes, original directory for overlap checks, and state. Copies, JSON round trips, objects inheriting from a handle, and handles from another module instance have no staging authority. There is no export for credential bytes, source paths, a private profile, an injected decryptor, or a test mode.

Each handle has one staging attempt. Stage returns a frozen object containing `version`, `credentialState: 'encrypted-unverified'`, the five newly created directory paths (`runtimeRoot` plus the four Electron paths), the same `selectedProfile` object, `fileContentsFsynced: true`, and `directoryFsync: 'unsupported-win32'`. Failure consumes staging authority. Release zeroes retained Buffers and removes registry authority. Parsing creates managed strings; this is not a guarantee of secure erasure of every V8 allocation.

## Source capture and validation

The supported source is one explicit `settingsDirectory` containing schema-v2 `settings.json` (1 byte through 2 MiB) and `Local State` (1 byte through 4 MiB). RepoPrep currently overrides `userData` for its legacy Windows directory and leaves `sessionData` at Electron's default of `userData`. The launcher must establish that the original source uses this co-located layout and refuse a separately configured source `sessionData`. Capture does not discover, inspect, or fall back to a second source directory. A co-located file is not evidence that it belongs to the selected credential. Both files must be ordinary local disk files with one hard link. Every ancestor, including the drive root, is checked and held. Device/UNC paths, alternate data streams, traversal, reserved DOS names, trailing-dot/space aliases, and normalization-dependent paths are refused.

A small Windows metadata process runs constant code in the system Windows PowerShell with `-NoProfile`, no visible window, ignored stdout/stderr, and no credential data in argv, environment, stdin, or its protocol. It uses native `CreateFileW` with `OPEN_REPARSE_POINT` and `BACKUP_SEMANTICS`; every held ancestor/file must have no `FILE_ATTRIBUTE_REPARSE_POINT`, have an expected final path and type, and have a nonzero physical identity. Held handles allow read sharing and deny write/delete sharing through the capture/stage operation. A current-user-only random named pipe also checks the native-main client PID. The bridge has bounded request/response counts and a native watchdog. It fails closed when unavailable; there is no weaker Node-only fallback.

The main process compares native volume/file identity with bigint `lstat`/`fstat`, requires one link, checks bounded size, reads each source exactly once through its opened descriptor, and rechecks identity, size, birth/write/change times, all ancestors, and native held records before accepting the snapshot. It locks both source files before either content read. The metadata process never reads source file contents. Filesystem observations do not establish that the application previously wrote both files in one atomic transaction; supported DPAPI and credential authentication remains a later native-vault responsibility.

UTF-8 decoding is fatal; BOM, invalid sequences, unpaired surrogates, malformed JSON, decoded duplicate keys at any depth (including content later dropped), dangerous object keys, excessive depth, and excessive node count are refused. The settings schema is closed, validates every profile and scan-limit field, rejects duplicate IDs and plaintext `apiKey` even on unselected profiles, and requires a selected profile. An explicit profile ID may be used when the saved default is unset; omission of both is refused without inventing a default. URLs must match the stored HTTP(S) schema, including no userinfo. Query/fragment normalization and authorization are deferred to E1; raw endpoints are never returned. Selected metadata omits profile name and raw endpoint.

Unselected profiles may omit credentials. The selected profile must have a credential, and every present credential must have the existing version-1 record shape and nonempty canonical bounded Base64. The helper imposes no cipher-header policy. `Local State` must contain canonical `DPAPI`-prefixed `os_crypt.encrypted_key`, optional boolean `audit_enabled`, and no app-bound or unknown `os_crypt` fields. Only those supported fields are serialized for staging; unrelated Chromium state is dropped. Full raw Local State bytes are zeroed after sanitization.

**Ciphertext schema does not prove authenticity.** The helper does not accept or return a usable private profile and does not claim synthetic ciphertext is decryptable. Tests use synthetic schema-valid bytes inside an isolated VM facade; production has no corresponding injection seam. The future launcher must decrypt exactly the selected staged profile once after native app ready using the existing native vault, passing `staged.selectedProfile.profileId` explicitly even if the captured default differs, and must reject native decryption failures. It must never replace the native vault with a fixture decryptor or treat successful staging as credential validation.

## Isolated staging

`runtimeParent` is an explicit existing plain local directory disjoint from the original source directory in both directions. Stage never opens, stats, reselects, parses, or rereads the original settings or Local State after capture. Deletion or replacement of either original therefore does not affect stage.

Under guarded ancestors, stage atomically creates a cryptographically random `m09-profile-<48 hex>` directory and four fixed child directories with a protected current-user inheritable Windows DACL. Existing directories are refused, including collisions. It exclusively creates `settings.json` in `staged.userData` and sanitized `Local State` in `staged.sessionData` with `O_EXCL`, writes only private captured Buffers through the new descriptors, calls `fsync` for each file, and checks file identity/link count/size before close and again under a native guard. It reads each newly staged file back under that guard and requires byte equality with the retained capture; this never reads or reselects the original source. No existing file is overwritten. Directory reparse points and path escapes are refused before writes; descriptor/name identity and native final checks fence replacement races.

Electron 42.11.10 reads the OSCrypt preference file from `sessionData/Local State` during browser-process initialization, after the main entry can set its paths synchronously. RepoPrep reads settings from `userData/settings.json`. The four staged Electron paths stay distinct; stage does not duplicate Local State into `userData` or write settings into `sessionData`.

Windows does not provide a general unprivileged directory-fsync primitive through this implementation. The return value exposes that limit explicitly; file fsync is mandatory, and a file-fsync failure produces no successful stage. This helper is not a power-loss durability protocol.

A failed stage can leave its newly created private partial directory inside `runtimeParent`. It returns only a finite error code and never performs recursive deletion against a possibly changed path. The eventual launcher owns `runtimeParent` and must perform bounded, identity-aware cleanup after its exact child process has closed. No auth/claim, cleanup launcher, or decryption glue is introduced here.

## Evidence and scope

The focused suite uses only synthetic temporary settings, DPAPI-shaped keys and unauthenticated canonical Base64 ciphertext. It has no Git fixtures, real settings discovery, provider calls, native safeStorage decrypts, or actual profile reads. A private test VM wrapper supplies a synthetic main facade; this does not exist in the production exports. Windows filesystem locking and the native metadata bridge run for real against those synthetic files.

Coverage includes source replacement/deletion after capture, exactly one content read per source, no source/backup mutation, selection stability and absence semantics, nontransferable handles, once/failure semantics, true Windows write/delete/ancestor-rename contention, junctions at the leaf and an ancestor, hard links and same-file paths, redirected descriptors, changed identities/timestamps, bounds/type refusal, strict parser/schema/plaintext refusal, exclusive collisions, fsync failure, and canary error/result redaction. The earlier VM assertion looked for Local State under `userData`, so it could pass while Electron would look elsewhere. The corrected assertions verify the returned path layout and fault handling in both locations.

On 2026-11-11, the offline Windows Electron R2 fixture passed (`NATIVE-E3A-OK`). The seed used the existing native settings store with co-located source paths and two synthetic profiles, saved A as the default, and made two native encrypt calls and zero decrypt calls. The separate consumer captured explicit B once and staged once before its first await, then applied all four distinct returned paths unchanged before ready. After ready, it called the existing store's `getPrivateProfile(B)` once, made one native decrypt call and zero encrypt calls, and verified the selected result matched B. The parent observed both direct child processes close and verified cleanup of its synthetic fixture.

The original R1 capture failure remains preserved. R2 verifies the native staging and selected-credential boundary for synthetic data. Capture of real saved profiles, E1 run authorization and claim, paid dispatch, M09 quality, and the M10 and M11 gates remain unverified.

Commands:

```powershell
node --check scripts/evaluation/m09-profile-snapshot.cjs
node --check scripts/evaluation/m09-profile-snapshot.test.cjs
node --test --test-reporter=spec scripts/evaluation/m09-profile-snapshot.test.cjs
```

This helper leaves the accepted W source and recovery archive unchanged. It does not complete M09, P6, M10, or M11.
