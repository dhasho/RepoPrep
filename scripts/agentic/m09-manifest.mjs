import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { SEMANTIC_NATIVE_COLLABORATION_V2, parseSemanticJsonBytes, semanticCanonicalJson, semanticSha256 } from './semantic-review.mjs'

export const M09_LIMITS = Object.freeze({ erroneousSamples: 40, correctSamples: 40, repairSamples: 20, errorRecallMin: 0.85, falsePositiveRateMax: 0.1, correctRepairsMin: 14, introducedMaterialErrorsMax: 0 })
export const M09_METRICS = Object.freeze(['errorRecall', 'falsePositiveRate', 'correctRepairs', 'introducedMaterialErrors', 'budgetCompliant'])
export const M09_SCOPED_PROTOCOL = Object.freeze({ version: 2, kind: 'native-collaboration', invocationProtocol: SEMANTIC_NATIVE_COLLABORATION_V2, judgeInputProtocol: 'm09-semantic-judge-input-v2', adjudicatorInputProtocol: 'm09-semantic-adjudicator-input-v2', model: 'gpt-6.1-sol', roles: Object.freeze(['A', 'B', 'adjudicator']), forkTurns: 'none', freshContexts: 3, adjudicateAllPairs: 20, inputPolicy: 'supplied-public-bytes-only-no-tools', externalBoundary: 'trusted-root-native-observations', serviceUsageUnavailableRemainsUnavailable: true })
export const M09_MANIFEST_PATH = 'scripts/agentic/manifest.m09.v2.json'
export const M09_LOCK_PATH = 'scripts/agentic/manifest.m09.v2.lock.json'
const fail = code => { throw new Error(code) }
const hash = value => semanticSha256(Buffer.from(semanticCanonicalJson(value), 'utf8'))
const normalized = bytes => semanticSha256(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8'))
const equal = (a, b) => semanticCanonicalJson(a) === semanticCanonicalJson(b)
const linked = stat => stat.isSymbolicLink() || ((stat.attributes ?? 0) & 0x400) !== 0

/** No source-tree traversal and no private asset access. */
export async function readM09BoundFile(root, relative, maxBytes = 32 * 1024 * 1024) {
  if (!path.isAbsolute(root) || typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) fail('M09_BOUND_PATH_INVALID')
  const absoluteRoot = path.resolve(root)
  const filename = path.resolve(absoluteRoot, relative)
  if (path.relative(absoluteRoot, filename).startsWith('..') || path.isAbsolute(path.relative(absoluteRoot, filename))) fail('M09_BOUND_PATH_INVALID')
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink
  const directory = async () => {
    if ((await realpath(absoluteRoot)).toLowerCase() !== absoluteRoot.toLowerCase()) fail('M09_BOUND_PATH_INVALID')
    const identities = []
    let cursor = path.parse(absoluteRoot).root
    for (const component of absoluteRoot.slice(cursor.length).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, component); const stat = await lstat(cursor); if (linked(stat) || !stat.isDirectory()) fail('M09_BOUND_PATH_INVALID'); identities.push([cursor, stat]) }
    for (const component of relative.split('/').slice(0, -1)) { cursor = path.join(cursor, component); const stat = await lstat(cursor); if (linked(stat) || !stat.isDirectory()) fail('M09_BOUND_PATH_INVALID'); identities.push([cursor, stat]) }
    return identities
  }
  let handle
  try {
    const directories = await directory()
    const before = await lstat(filename)
    if (linked(before) || !before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) fail('M09_BOUND_PATH_INVALID')
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!same(before, opened) || !opened.isFile() || opened.nlink !== 1) fail('M09_BOUND_PATH_INVALID')
    const buffer = Buffer.alloc(opened.size + 1)
    let offset = 0
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead }
    if (offset !== opened.size) fail('M09_BOUND_PATH_INVALID')
    const after = await handle.stat(); const pathAfter = await lstat(filename)
    if (linked(pathAfter) || !same(opened, after) || !same(opened, pathAfter) || (await realpath(filename)).toLowerCase() !== filename.toLowerCase()) fail('M09_BOUND_PATH_INVALID')
    const finalDirectories = await directory()
    if (directories.length !== finalDirectories.length || directories.some(([name, stat], index) => name !== finalDirectories[index][0] || stat.dev !== finalDirectories[index][1].dev || stat.ino !== finalDirectories[index][1].ino)) fail('M09_BOUND_PATH_INVALID')
    return buffer.subarray(0, offset)
  } catch { fail('M09_BOUND_FILE_UNAVAILABLE') }
  finally { await handle?.close() }
}

export async function loadM09ScopedManifest(sourceRoot, { verifySourceBindings = true } = {}) {
  const manifestBytes = await readM09BoundFile(sourceRoot, M09_MANIFEST_PATH)
  const manifest = parseSemanticJsonBytes(manifestBytes)
  const lock = parseSemanticJsonBytes(await readM09BoundFile(sourceRoot, M09_LOCK_PATH))
  const historical = parseSemanticJsonBytes(await readM09BoundFile(sourceRoot, 'scripts/agentic/manifest.v2.json'))
  if (manifest.manifestVersion !== 2 || manifest.schema?.manifestFile !== path.basename(M09_MANIFEST_PATH) || manifest.schema?.reviewProtocol !== historical.schema.reviewProtocol || manifest.baselineSourceCommit !== historical.baselineSourceCommit || !equal(manifest.configuration?.reviewProtocol, historical.configuration.reviewProtocol) || !equal(manifest.configuration?.semanticReviewProtocol, M09_SCOPED_PROTOCOL) || !equal(Object.keys(manifest.modules ?? {}), ['M09']) || !equal(manifest.modules.M09.limits, M09_LIMITS) || !equal(manifest.modules.M09.requiredMetricIds, M09_METRICS) || !equal(manifest.modules.M09.requiredCheckIds, ['m09:frozen-review-and-repair-set']) || !equal(manifest.realOnlyModules, ['M09'])) fail('M09_SCOPED_MANIFEST_INVALID')
  const historicAssets = historical.modules.M09.assets
  if (!equal(manifest.modules.M09.assets, historicAssets)) fail('M09_ASSET_BINDING_INVALID')
  const expectedHashes = { configurationSha256: hash(manifest.configuration), dataSha256: hash({ M09: manifest.modules.M09.assets }), schemaSha256: hash(manifest.schema) }
  if (lock.lockVersion !== 1 || lock.baselineSourceCommit !== manifest.baselineSourceCommit || lock.manifestSha256 !== normalized(manifestBytes) || !equal(lock.hashes, expectedHashes) || lock.m09?.protocolSha256 !== hash(M09_SCOPED_PROTOCOL) || lock.m09?.assetDescriptorsSha256 !== hash(historicAssets) || lock.m09?.sourceHashMeaning !== 'sha256-canonical-scoped-source-file-map-v1' || !lock.m09?.sourceFiles || lock.m09.sourceSha256 !== hash(lock.m09.sourceFiles)) fail('M09_SCOPED_LOCK_INVALID')
  const sources = Object.entries(lock.m09.sourceFiles)
  const required = ['scripts/evaluation/run-semantic-profile.cjs', 'scripts/evaluation/run-semantic-profile-entry.cjs', 'scripts/evaluation/m09-semantic-native.cjs', 'scripts/evaluation/m09-semantic-io.cjs', 'scripts/agentic/semantic-eval.mjs', 'scripts/agentic/semantic-eval-contract.mjs', 'scripts/agentic/semantic-execution-validation.mjs', 'scripts/agentic/semantic-review.mjs', 'scripts/agentic/semantic-review-score.mjs', 'scripts/agentic/m09-native-collaboration.mjs', 'scripts/agentic/m09-quality-host.mjs', 'scripts/agentic/m09-manifest.mjs', 'scripts/agentic/checks/m09.mjs', 'scripts/agentic/checks/index.mjs', 'scripts/agentic/gate-runner.mjs', 'scripts/agentic/verify.mjs']
  if (!equal(sources.map(([name]) => name).sort(), [...required].sort()) || sources.some(([, value]) => !/^[0-9a-f]{64}$/u.test(value))) fail('M09_SCOPED_LOCK_INVALID')
  if (verifySourceBindings) for (const [name, digest] of sources) if (semanticSha256(await readM09BoundFile(sourceRoot, name)) !== digest) fail('M09_SCOPED_SOURCE_CHANGED')
  return Object.freeze({ manifest, lock, manifestPath: path.join(sourceRoot, M09_MANIFEST_PATH), manifestLockPath: path.join(sourceRoot, M09_LOCK_PATH), normalizedPrivateKeyHashes: Object.freeze({ reviewKey: historicAssets.find(asset => asset.id === 'm09-review-key').sha256, repairKey: historicAssets.find(asset => asset.id === 'm09-repair-key').sha256 }) })
}
