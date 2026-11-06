import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const EXPECTED = new Map([
  ['encode/httpx', { directory: 'httpx', language: 'Python', commit: 'b5addb64f0161ff6bfe94c124ef76f6a1fba5254', origin: 'https://github.com/encode/httpx' }],
  ['pallets/itsdangerous', { directory: 'itsdangerous', language: 'Python', commit: '672971d66a2ef9f85151e53283113f33d642dabd', origin: 'https://github.com/pallets/itsdangerous' }],
  ['caolan/async', { directory: 'async', language: 'JavaScript', commit: '3921e54bd0704157dbea238fdfcc0c3619abde1a', origin: 'https://github.com/caolan/async' }],
  ['colinhacks/zod', { directory: 'zod', language: 'TypeScript', commit: '8651451b82b454847ef9d6d8cc533496853a10d8', origin: 'https://github.com/colinhacks/zod' }],
])
const GRANULARITIES = new Set(['coarse', 'medium', 'fine'])
const HASH = /^[a-f0-9]{64}$/
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 40 * 1024 * 1024
const MAX_FILES = 200
const MAX_FACTS = 300

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeOrigin(value) {
  return value.trim().replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '').toLowerCase()
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) return false
  if (/[\u0000-\u001f\u007f:]/.test(value) || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false
  const parts = value.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function git(repoPath, ...args) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
}

async function hasSymlinkBetween(root, relativePath) {
  let current = root
  const components = relativePath ? relativePath.split('/') : []
  for (const component of components) {
    current = path.join(current, component)
    try {
      if ((await lstat(current)).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

/** Validate frozen public source provenance and every cited source range. */
export async function validateHoldoutSources(labels, reposRoot) {
  const issues = []
  const issue = (message) => issues.push(message)
  let repositories = 0
  let facts = 0
  let totalBytes = 0

  if (!labels || labels.schemaVersion !== 1 || labels.split !== 'holdout') issue('labels must use schemaVersion 1 and split holdout')
  if (!labels || labels.provenance?.kind !== 'agent-annotated' || labels.provenance?.model !== 'gpt-6-luna' || labels.provenance?.implementationContextProvided !== false) issue('annotation provenance is invalid')
  if (!Array.isArray(labels?.repositories) || labels.repositories.length !== EXPECTED.size) issue('expected exactly four repositories')
  if (!reposRoot || typeof reposRoot !== 'string') {
    issue('reposRoot must be a path')
    return { valid: false, issues, repositories, facts }
  }

  let resolvedRoot
  try {
    const absoluteRoot = path.resolve(reposRoot)
    const filesystemRoot = path.parse(absoluteRoot).root
    const relativeRoot = path.relative(filesystemRoot, absoluteRoot).split(path.sep).join('/')
    if (await hasSymlinkBetween(filesystemRoot, relativeRoot)) {
      issue('repositories root path must not traverse a symlink')
      return { valid: false, issues, repositories, facts }
    }
    resolvedRoot = await realpath(absoluteRoot)
  } catch {
    issue('repositories root is unavailable')
    return { valid: false, issues, repositories, facts }
  }

  const seenRepos = new Set()
  const seenFactIds = new Set()
  for (const repo of Array.isArray(labels?.repositories) ? labels.repositories.slice(0, EXPECTED.size) : []) {
    const expected = EXPECTED.get(repo?.id)
    if (!expected) {
      issue('repository identity is not in the frozen allowlist')
      continue
    }
    if (seenRepos.has(repo.id)) issue('repository identity is duplicated')
    seenRepos.add(repo.id)
    repositories += 1
    if (repo.directory !== expected.directory || repo.language !== expected.language || repo.commit !== expected.commit) {
      issue(`repository metadata mismatch: ${repo.id}`)
      continue
    }
    const repoPath = path.join(resolvedRoot, expected.directory)
    let resolvedRepo
    try {
      const repoStat = await lstat(repoPath)
      if (repoStat.isSymbolicLink()) {
        issue(`repository path is a symlink: ${repo.id}`)
        continue
      }
      if (!repoStat.isDirectory()) {
        issue(`repository path is not a directory: ${repo.id}`)
        continue
      }
      resolvedRepo = await realpath(repoPath)
    } catch {
      issue(`repository checkout is unavailable or invalid: ${repo.id}`)
      continue
    }
    const relativeRepo = path.relative(resolvedRoot, resolvedRepo)
    if (!relativeRepo || relativeRepo === '..' || relativeRepo.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRepo)) {
      issue(`repository escapes source root: ${repo.id}`)
      continue
    }

    let checkoutValid = true
    try {
      if (git(resolvedRepo, 'rev-parse', 'HEAD') !== expected.commit) {
        issue(`checkout commit mismatch: ${repo.id}`)
        checkoutValid = false
      }
      if (git(resolvedRepo, 'status', '--porcelain=v1', '--untracked-files=all') !== '') {
        issue(`checkout is not clean: ${repo.id}`)
        checkoutValid = false
      }
      if (normalizeOrigin(git(resolvedRepo, 'remote', 'get-url', 'origin')) !== expected.origin) {
        issue(`origin identity mismatch: ${repo.id}`)
        checkoutValid = false
      }
    } catch {
      issue(`repository checkout metadata is unavailable: ${repo.id}`)
      checkoutValid = false
    }
    if (!checkoutValid) continue

    const files = Array.isArray(repo.files) ? repo.files : []
    if (files.length === 0 || files.length > MAX_FILES) issue(`source file count is invalid: ${repo.id}`)
    const fileRecords = new Map()
    for (const file of files.slice(0, MAX_FILES)) {
      if (!safeRelativePath(file?.path)) {
        issue(`unsafe source file path: ${repo.id}`)
        continue
      }
      if (!HASH.test(file.sha256 ?? '')) {
        issue(`source file hash format is invalid: ${repo.id}`)
        continue
      }
      if (fileRecords.has(file.path)) issue(`source file path is duplicated: ${repo.id}`)
      fileRecords.set(file.path, file)
      const fullPath = path.join(repoPath, ...file.path.split('/'))
      try {
        if (await hasSymlinkBetween(repoPath, file.path)) {
          issue(`source file path traverses a symlink: ${repo.id}`)
          continue
        }
        const stat = await lstat(fullPath)
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          issue(`source file is not a bounded regular file: ${repo.id}`)
          continue
        }
        totalBytes += stat.size
        if (totalBytes > MAX_TOTAL_BYTES) {
          issue('source byte limit exceeded')
          break
        }
        const bytes = await readFile(fullPath)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        fileRecords.set(file.path, { ...file, text, lines: text.split('\n') })
        if (sha256(Buffer.from(text, 'utf8')) !== file.sha256) issue(`source file hash mismatch: ${repo.id}`)
      } catch {
        issue(`source file is unavailable or not UTF-8: ${repo.id}`)
      }
    }

    const repoFacts = Array.isArray(repo.facts) ? repo.facts : []
    if (repoFacts.length < 12 || repoFacts.length > MAX_FACTS) issue(`fact count is outside bounds: ${repo.id}`)
    const coverage = new Map([...GRANULARITIES].map((granularity) => [granularity, 0]))
    for (const fact of repoFacts.slice(0, MAX_FACTS)) {
      facts += 1
      if (typeof fact?.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,100}$/.test(fact.id) || seenFactIds.has(fact.id)) issue(`fact id is invalid or duplicated: ${repo.id}`)
      else seenFactIds.add(fact.id)
      if (typeof fact?.claim !== 'string' || fact.claim.trim().length < 25 || fact.claim.length > 1200) issue(`fact claim is invalid: ${repo.id}`)
      if (!Array.isArray(fact?.pitfalls) || fact.pitfalls.length === 0 || fact.pitfalls.some((item) => typeof item !== 'string' || item.trim().length < 8 || item.length > 400)) issue(`fact pitfalls are invalid: ${repo.id}`)
      if (!Array.isArray(fact?.granularities) || fact.granularities.length === 0 || fact.granularities.some((item) => !GRANULARITIES.has(item))) issue(`fact granularities are invalid: ${repo.id}`)
      else for (const item of new Set(fact.granularities)) coverage.set(item, (coverage.get(item) ?? 0) + 1)
      if (!Array.isArray(fact?.evidence) || fact.evidence.length === 0 || fact.evidence.length > 10) issue(`fact evidence is invalid: ${repo.id}`)
      for (const evidence of Array.isArray(fact?.evidence) ? fact.evidence : []) {
        const source = fileRecords.get(evidence?.path)
        if (!source?.lines || !Number.isInteger(evidence.startLine) || !Number.isInteger(evidence.endLine) || evidence.startLine < 1 || evidence.endLine < evidence.startLine || evidence.endLine > source.lines.length || evidence.endLine - evidence.startLine > 100 || !HASH.test(evidence.sha256 ?? '')) {
          issue(`evidence range is invalid: ${repo.id}`)
          continue
        }
        const excerpt = source.lines.slice(evidence.startLine - 1, evidence.endLine).join('\n')
        if (sha256(Buffer.from(excerpt, 'utf8')) !== evidence.sha256) issue(`evidence hash mismatch: ${repo.id}`)
      }
    }
    for (const required of GRANULARITIES) if ((coverage.get(required) ?? 0) < 2) issue(`granularity coverage below two facts: ${repo.id}`)
  }
  for (const id of EXPECTED.keys()) if (!seenRepos.has(id)) issue(`required repository missing: ${id}`)
  return { valid: issues.length === 0, issues, repositories, facts }
}
