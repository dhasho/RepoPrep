import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, open, rename, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson, validateManifest } from './gate-runner.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const normalized = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n')

async function checkedPath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('INVALID_FREEZE_PATH')
  const absolute = path.resolve(root, relative)
  const within = path.relative(root, absolute)
  if (!within || within.startsWith(`..${path.sep}`) || within === '..' || path.isAbsolute(within)) throw new Error('INVALID_FREEZE_PATH')
  let current = root
  for (const part of within.split(path.sep)) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('INVALID_FREEZE_PATH')
  }
  const info = await lstat(absolute)
  if (!info.isFile() || info.nlink !== 1) throw new Error('INVALID_FREEZE_PATH')
  return absolute
}

async function atomicWrite(target, text) {
  // Replacing the directory entry never writes through an existing hard link.
  const temporary = path.join(path.dirname(target), `.agentic-freeze-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, target)
  }
  finally { await rm(temporary, { force: true }) }
}

/** Re-freezing is an explicit versioned authoring step, never part of gate execution. */
export async function freezeManifest(sourceRoot, relative = 'scripts/agentic/manifest.v2.json') {
  const root = await realpath(sourceRoot)
  const manifestPath = await checkedPath(root, relative)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const definition of Object.values(manifest.modules)) for (const asset of definition.assets ?? []) {
    if (asset.status === 'available' && asset.path) asset.sha256 = hash(normalized(await readFile(await checkedPath(root, asset.path))))
  }
  if (validateManifest(manifest).length) throw new Error('INVALID_FREEZE_MANIFEST')
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const lock = {
    lockVersion: 1,
    baselineSourceCommit: manifest.baselineSourceCommit,
    manifestSha256: hash(manifestText),
    hashes: {
      configurationSha256: hash(canonicalJson(manifest.configuration)),
      dataSha256: hash(canonicalJson(Object.fromEntries(Object.entries(manifest.modules).map(([id, value]) => [id, value.assets ?? []])))),
      schemaSha256: hash(canonicalJson(manifest.schema ?? null))
    }
  }
  const lockPath = path.join(path.dirname(manifestPath), path.basename(manifestPath) === 'manifest.v2.json' ? 'manifest.v2.lock.json' : 'manifest.lock.json')
  try {
    const info = await lstat(lockPath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('INVALID_FREEZE_PATH')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await atomicWrite(manifestPath, manifestText)
  await atomicWrite(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  return { manifestPath, lockPath, manifestSha256: lock.manifestSha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await freezeManifest(process.cwd(), process.argv[2]))}\n`) }
  catch { process.stderr.write('MANIFEST_FREEZE_FAILED\n'); process.exitCode = 1 }
}
