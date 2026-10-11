// 项目目录扫描：文件树、语言统计、关键文件识别
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'
import type { FileNode, KeyFileInfo, LanguageStat, ProjectOverview, SecurityProtectionSummary } from '../../shared/types'
import type { ScanLimits, ScanTruncation } from '../../shared/types'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { DEFAULT_SCAN_LIMITS, SCAN_LIMIT_BOUNDS } from '../../shared/types.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { identityFromBigIntStats, recordProjectSnapshot, resolveProjectIdentity, sameFileSystemIdentity, type FileSystemIdentity, type ProjectSnapshot, type SnapshotEntry } from './project-snapshot.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { classifySensitivePath } from './sensitive.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { projectDisplayName } from './project-display-name.ts'

/** 始终忽略的目录/文件（无论有没有 .gitignore） */
const ALWAYS_IGNORE = [
  'node_modules/',
  '.git/',
  '.hg/',
  '.svn/',
  '.zcode/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.svelte-kit/',
  'coverage/',
  '.cache/',
  '.parcel-cache/',
  '.turbo/',
  '.idea/',
  '.vscode/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'env/',
  '.env/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  'target/',
  '.gradle/',
  '.mvn/',
  'vendor/',
  'Pods/',
  '.dart_tool/',
  'bin/',
  'obj/',
  '.terraform/',
  'bower_components/',
  '.DS_Store',
  'Thumbs.db'
]

/** 不作为"源码内容"送入大模型的文件类型（树中仍保留） */
const CONTENT_SKIP_PATTERNS = [
  /\.min\.(js|css)$/,
  /(-lock\.js|\.lock)$/, // package-lock.json / yarn.lock / Cargo.lock 等
  /\.map$/,
  /\.(png|jpe?g|gif|webp|ico|bmp|avif|svg)$/i,
  /\.(zip|tar|gz|rar|7z|tgz)$/i,
  /\.(exe|dll|so|dylib|bin|dat|class|jar|war|pyd|pyc|node|wasm)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
  /\.(mp3|mp4|avi|mov|mkv|wav|flac)$/i,
  /\.(pdf|docx?|xlsx?|pptx?)$/i
]

const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','webp','ico','bmp','avif','zip','tar','gz','rar','7z','tgz',
  'exe','dll','so','dylib','bin','dat','class','jar','war','pyd','pyc','node','wasm',
  'woff','woff2','ttf','otf','eot','mp3','mp4','avi','mov','mkv','wav','flac','pdf',
  'doc','docx','xls','xlsx','ppt','pptx','db','sqlite','sqlite3','mdb','bak'
])

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', java: 'Java', go: 'Go', rs: 'Rust',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++',
  cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin', kts: 'Kotlin',
  scala: 'Scala', dart: 'Dart', lua: 'Lua', r: 'R', m: 'Objective-C', mm: 'Objective-C',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  css: 'CSS', scss: 'Sass', sass: 'Sass', less: 'Less',
  html: 'HTML', htm: 'HTML', xml: 'XML', json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  md: 'Markdown', mdx: 'Markdown', sql: 'SQL', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell',
  bat: 'Batch', gradle: 'Gradle', proto: 'Protobuf', graphql: 'GraphQL', prisma: 'Prisma'
}

/** 关键文件（用于识别项目类型与入口） */
const KEY_FILE_RULES: { match: (base: string, relDir: string) => boolean; reason: string }[] = [
  { match: (b) => /^readme\.(md|txt|rst)$/i.test(b), reason: '项目说明文档' },
  { match: (b, d) => d === '' && b === 'package.json', reason: 'Node.js 项目清单' },
  { match: (b, d) => d === '' && b === 'pom.xml', reason: 'Maven 配置' },
  { match: (b, d) => d === '' && /^build\.gradle(\.kts)?$/.test(b), reason: 'Gradle 配置' },
  { match: (b, d) => d === '' && b === 'go.mod', reason: 'Go 模块定义' },
  { match: (b, d) => d === '' && b === 'Cargo.toml', reason: 'Rust 项目清单' },
  { match: (b, d) => d === '' && /^(requirements\.txt|pyproject\.toml|setup\.py|Pipfile)$/.test(b), reason: 'Python 依赖定义' },
  { match: (b, d) => d === '' && /^(composer\.json|Gemfile|mix\.exs)$/.test(b), reason: '依赖定义' },
  { match: (b, d) => d === '' && /^(Dockerfile|docker-compose\.ya?ml)$/.test(b), reason: '容器化配置' },
  { match: (b, d) => d === '' && /^(Makefile|CMakeLists\.txt)$/.test(b), reason: '构建脚本' },
  { match: (b, d) => d === '' && /\.(csproj|sln)$/i.test(b), reason: '.NET 工程文件' },
  { match: (b, d) => d.split('/').length <= 1 && /^(main|index|app|server|cli)\.(ts|tsx|js|jsx|py|go|rs|java)$/i.test(b), reason: '可能的入口文件' }
]

/** 单文件送入模型的上限（同时用于题量配额的模块体量估计，故导出） */
export const MAX_CONTENT_FILE_BYTES = 256 * 1024

export function scanLimitsKey(limits: ScanLimits): string {
  return `${limits.maxFiles}/${limits.maxTreeNodes}/${limits.maxContentFileBytes}`
}

export function resolveScanLimits(partial?: Partial<ScanLimits>): ScanLimits {
  const clamp = (value: unknown, bound: { min: number; max: number }, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(bound.max, Math.max(bound.min, Math.floor(value)))
  }
  return {
    maxFiles: clamp(partial?.maxFiles, SCAN_LIMIT_BOUNDS.maxFiles, DEFAULT_SCAN_LIMITS.maxFiles),
    maxTreeNodes: clamp(partial?.maxTreeNodes, SCAN_LIMIT_BOUNDS.maxTreeNodes, DEFAULT_SCAN_LIMITS.maxTreeNodes),
    maxContentFileBytes: clamp(partial?.maxContentFileBytes, SCAN_LIMIT_BOUNDS.maxContentFileBytes, DEFAULT_SCAN_LIMITS.maxContentFileBytes)
  }
}

export interface ScannedFile {
  relPath: string
  absPath: string
  size: number
  ext: string
  isContentCandidate: boolean // 是否可作为源码内容送入大模型
  /**
   * 文本文件的字节数（stat 结果，仅对非二进制文件设置）。
   * 供题量配额按模块"体量"分配权重使用：不需要真实读文件，
   * UTF-8 源码下字节数与字符数同阶，作为相对权重的代理足够。
   */
  textBytes?: number
  sensitive?: { category: string; reason: string }
}

export interface ScanResult extends ProjectOverview {
  files: ScannedFile[] // 扁平文件列表（供上下文构建使用）
}

/**
 * 转义路径里的 glob/模式元字符：目录名形如 a[1]、!foo、#foo 时，
 * 不转义会把目录名当成字符类 / 否定 / 注释解析，导致规则错位
 * （既可能漏掉本应忽略的子树，也可能误伤兄弟目录）。
 */
function escapeGitignoreSegment(segment: string): string {
  return segment.replace(/([\\*?[\]!#])/g, '\\$1')
}

/** Git 会去掉 .gitignore 开头的 UTF-8 BOM；ignore 包不会，需自行剥离 */
function stripBom(content: string): string {
  return content.replace(/^\uFEFF/, '')
}

async function readVerifiedIgnoreFile(
  filePath: string,
  rootPath: string,
  rootIdentity: FileSystemIdentity | undefined,
  ancestorEntries: SnapshotEntry[],
  expectedIdentity: FileSystemIdentity
): Promise<string> {
  const checkPaths = async (): Promise<void> => {
    if (await fs.realpath(rootPath) !== rootPath) throw new Error('changed')
    const rootStats = await fs.lstat(rootPath, { bigint: true })
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !sameFileSystemIdentity(rootIdentity, identityFromBigIntStats(rootStats)!)) throw new Error('changed')
    for (const entry of ancestorEntries) {
      const absPath = entry.path ? path.join(rootPath, ...entry.path.split('/')) : rootPath
      const stats = await fs.lstat(absPath, { bigint: true })
      if (!stats.isDirectory() || stats.isSymbolicLink() || !sameFileSystemIdentity(entry.identity, identityFromBigIntStats(stats)!)) throw new Error('changed')
    }
    const stats = await fs.lstat(filePath, { bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink() || !sameFileSystemIdentity(expectedIdentity, identityFromBigIntStats(stats)!)) throw new Error('changed')
  }

  await checkPaths()
  const flags = fsSync.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsSync.constants.O_NOFOLLOW ?? 0))
  const handle = await fs.open(filePath, flags)
  try {
    const opened = await handle.stat({ bigint: true })
    const openedIdentity = identityFromBigIntStats(opened)
    if (!opened.isFile() || !sameFileSystemIdentity(expectedIdentity, openedIdentity)) throw new Error('changed')
    if (opened.size > 1024n * 1024n) throw new Error('too large')
    const buffer = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset)
      if (result.bytesRead <= 0) throw new Error('short read')
      offset += result.bytesRead
    }
    const afterRead = await handle.stat({ bigint: true })
    if (!sameFileSystemIdentity(expectedIdentity, identityFromBigIntStats(afterRead))) throw new Error('changed')
    await checkPaths()
    return buffer.toString('utf-8')
  } finally {
    await handle.close()
  }
}

/**
 * 把子目录 .gitignore 的规则改写成相对扫描根目录的形式（issue #16），
 * 以便叠加进全局规则集。改写规则与 Git 语义对应：
 * - 内嵌 '/' 的模式在 Git 里锚定到该 .gitignore 所在目录 → 前缀化后仍锚定到原目录；
 * - 纯 basename 模式在所在目录的任意层级匹配 → prefix/**\/pattern（** 可匹配零层，
 *   覆盖 prefix 下的直接子项）；
 * - 否定 '!'、目录限定行尾 '/'、注释与空行语义保持不变。
 * 注意：Git 中"父目录被排除时无法重新包含其中的文件"由遍历顺序天然保证——
 * 被排除的目录根本不会进入，其内层 .gitignore 不会被加载。
 */
export function prefixGitignoreRules(content: string, relDir: string): string[] {
  const prefix = escapeGitignoreSegment(relDir)
  const rules: string[] = []
  for (const rawLine of stripBom(content).split(/\r?\n/)) {
    // Git 会修剪未转义的行尾空白（行尾是反斜杠转义的空格则保留）
    const line = rawLine.replace(/(?<!\\)[ \t]+$/, '')
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const pattern = negated ? line.slice(1) : line
    if (!pattern || pattern === '/') continue
    const hasEmbeddedSlash = pattern.slice(0, -1).includes('/')
    const prefixed = hasEmbeddedSlash
      ? `${prefix}/${pattern.startsWith('/') ? pattern.slice(1) : pattern}`
      : `${prefix}/**/${pattern}`
    rules.push(negated ? `!${prefixed}` : prefixed)
  }
  return rules
}

export async function scanProject(root: string, limits?: Partial<ScanLimits>): Promise<ScanResult> {
  const projectIdentity = await resolveProjectIdentity(root)
  const scanRoot = projectIdentity.realPath
  const rootStat = await fs.lstat(scanRoot, { bigint: true })
  if (!rootStat.isDirectory()) throw new Error('所选路径不是目录')
  const rootIdentity = identityFromBigIntStats(rootStat)
  const snapshotEntries: SnapshotEntry[] = [{ path: '', type: 'dir', size: Number(rootStat.size), mtimeMs: Number(rootStat.mtimeMs), ctimeMs: Number(rootStat.ctimeMs), identity: rootIdentity }]
  let snapshotValid = Boolean(rootIdentity)
  let contentReadable = Boolean(rootIdentity)
  const sensitivePolicyRoot = projectIdentity.realPath
  // Treat the canonical selected root as a directory context, not as a filename.
  const rootSensitive = classifySensitivePath('__project_root__', sensitivePolicyRoot)

  // 两套规则集（issue #16）：内置 ALWAYS_IGNORE 优先级最高，任何 .gitignore 的
  // 否定规则都不能把它们重新纳入；.gitignore 规则（根目录 + 遍历时叠加的嵌套
  // 目录规则）在另一套实例里，后加载的内层规则优先于外层，与 Git 的层级语义一致。
  const alwaysIg = ignore().add(ALWAYS_IGNORE)
  const gitIg = ignore()

  /** 目录与文件使用唯一规范路径，保留行尾斜杠的目录限定语义。 */
  const isIgnored = (rel: string, isDir: boolean): boolean => {
    const candidate = isDir ? `${rel}/` : rel
    return alwaysIg.ignores(candidate) || gitIg.ignores(candidate)
  }

  // 解析根目录 .gitignore
  const gitignorePath = path.join(scanRoot, '.gitignore')
  let rootGitignoreIdentity: FileSystemIdentity | undefined
  try {
    const ignoreStat = await fs.lstat(gitignorePath, { bigint: true })
    rootGitignoreIdentity = identityFromBigIntStats(ignoreStat)
    if (!ignoreStat.isFile() || !rootGitignoreIdentity) { snapshotValid = false; contentReadable = false }
    snapshotEntries.push({ path: '.gitignore', type: 'file', size: Number(ignoreStat.size), mtimeMs: Number(ignoreStat.mtimeMs), ctimeMs: Number(ignoreStat.ctimeMs), identity: rootGitignoreIdentity })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') snapshotEntries.push({ path: '.gitignore', type: 'missing' })
    else { snapshotValid = false; contentReadable = false }
  }
  if (rootGitignoreIdentity) {
    try {
      gitIg.add(stripBom(await readVerifiedIgnoreFile(gitignorePath, scanRoot, rootIdentity, [], rootGitignoreIdentity)))
    } catch {
      snapshotValid = false
      contentReadable = false
      /* 解析失败则忽略；快照不可缓存，因为实际忽略策略不确定 */
    }
  }

  const files: ScannedFile[] = []
  const langCount = new Map<string, number>()
  const keyFiles: KeyFileInfo[] = []
  let totalBytes = 0
  let treeNodes = 0
  const eff = resolveScanLimits(limits)
  let byFileCount = false
  let byTreeNodes = false
  let oversizedFiles = 0
  let estimatedSkipped = 0
  const security: SecurityProtectionSummary = { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} }

  async function walk(absDir: string, relDir: string, depth: number): Promise<FileNode[]> {
    let dirStat: import('node:fs').BigIntStats
    try {
      dirStat = await fs.lstat(absDir, { bigint: true })
      if (!dirStat.isDirectory()) { snapshotValid = false; contentReadable = false; return [] }
    } catch (error) {
      snapshotValid = false
      const code = (error as NodeJS.ErrnoException).code
      if (relDir === '' || (code !== 'EACCES' && code !== 'EPERM')) contentReadable = false
      return []
    }
    const dirIdentity = identityFromBigIntStats(dirStat)
    if (!dirIdentity) { snapshotValid = false; contentReadable = false }
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch (error) {
      snapshotValid = false
      const code = (error as NodeJS.ErrnoException).code
      if (relDir === '' || (code !== 'EACCES' && code !== 'EPERM')) contentReadable = false
      return [] // 无权限等错误直接跳过
    }
    const names = entries.map((entry) => entry.name).sort()
    if (relDir === '') {
      snapshotEntries[0].names = names
      if (names.includes('.gitignore') && !rootGitignoreIdentity) {
        snapshotValid = false
        contentReadable = false
      }
    } else {
      snapshotEntries.push({ path: relDir, type: 'dir', size: Number(dirStat.size), mtimeMs: Number(dirStat.mtimeMs), ctimeMs: Number(dirStat.ctimeMs), names, identity: dirIdentity })
    }

    // Git 语义：进入目录时叠加该目录的 .gitignore（作用于本目录及整个子树，
    // 后加载的内层规则优先于外层）。被排除的目录根本不会进入，其内层规则
    // 自然不生效——与 Git"父目录被排除时无法重新包含其中文件"的行为一致。
    const nestedGitignorePath = path.join(absDir, '.gitignore')
    if (relDir !== '' && names.includes('.gitignore')) {
      try {
        const nestedStat = await fs.lstat(nestedGitignorePath, { bigint: true })
        const nestedIdentity = identityFromBigIntStats(nestedStat)
        if (!nestedStat.isFile() || !nestedIdentity) throw new Error('invalid ignore file')
        snapshotEntries.push({ path: `${relDir}/.gitignore`, type: 'file', size: Number(nestedStat.size), mtimeMs: Number(nestedStat.mtimeMs), ctimeMs: Number(nestedStat.ctimeMs), identity: nestedIdentity })
        const directoryChain = snapshotEntries.filter((entry) => entry.type === 'dir' && (entry.path === '' || relDir.startsWith(`${entry.path}/`) || entry.path === relDir))
        gitIg.add(prefixGitignoreRules(await readVerifiedIgnoreFile(nestedGitignorePath, scanRoot, rootIdentity, directoryChain, nestedIdentity), relDir))
        // 它的内容影响扫描结果，即使后续规则忽略了此文件也必须记录身份，
        // 否则内容变化不会使扫描缓存失效。
      } catch {
        snapshotValid = false
        contentReadable = false
        /* names 已观察到 .gitignore；任何身份或读取失败都使内容策略不可信。 */
      }
    }

    const nodes: FileNode[] = []
    // 目录优先、其余按名称排序，保证树稳定
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (isIgnored(rel, entry.isDirectory())) continue
      if (files.length >= eff.maxFiles || treeNodes >= eff.maxTreeNodes) {
        if (files.length >= eff.maxFiles) byFileCount = true
        if (treeNodes >= eff.maxTreeNodes) byTreeNodes = true
        estimatedSkipped++
        continue
      }

      if (entry.isDirectory()) {
        treeNodes++
        const children = await walk(path.join(absDir, entry.name), rel, depth + 1)
        const excluded = Boolean(classifySensitivePath(rel, sensitivePolicyRoot))
        nodes.push({ name: entry.name, path: rel, type: 'dir', children, ...(excluded ? { modelExcluded: true } : {}) })
      } else if (entry.isFile()) {
        let fileStat: import('node:fs').BigIntStats
        try {
          fileStat = await fs.lstat(path.join(absDir, entry.name), { bigint: true })
        } catch (error) {
          snapshotValid = false
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EACCES' && code !== 'EPERM') contentReadable = false
          continue
        }
        if (!fileStat.isFile()) { snapshotValid = false; contentReadable = false; continue }
        const identity = identityFromBigIntStats(fileStat)
        if (!identity) { snapshotValid = false; contentReadable = false }
        const size = Number(fileStat.size)
        let snapshotFile = snapshotEntries.find((entry) => entry.path === rel && entry.type === 'file')
        if (snapshotFile) {
          if (!identity || !sameFileSystemIdentity(snapshotFile.identity, identity)) { snapshotValid = false; contentReadable = false }
        } else {
          snapshotFile = { path: rel, type: 'file', size, mtimeMs: Number(fileStat.mtimeMs), ctimeMs: Number(fileStat.ctimeMs), identity }
          snapshotEntries.push(snapshotFile)
        }
        treeNodes++
        const sensitive = classifySensitivePath(rel, sensitivePolicyRoot)
        nodes.push({ name: entry.name, path: rel, type: 'file', size, ...(sensitive ? { modelExcluded: true } : {}) })

        const ext = path.extname(entry.name).slice(1).toLowerCase()
        const isBinary = BINARY_EXT.has(ext)
        if (sensitive) {
          security.excludedFiles++
          security.categories[sensitive.category] = (security.categories[sensitive.category] ?? 0) + 1
        }
        if (!isBinary) {
          const overSize = size > eff.maxContentFileBytes
          if (overSize && !sensitive && !CONTENT_SKIP_PATTERNS.some((re) => re.test(rel))) oversizedFiles++
          const sf: ScannedFile = {
            relPath: rel,
            absPath: path.join(absDir, entry.name),
            size,
            ext,
            textBytes: size,
            isContentCandidate: !sensitive && !overSize && !CONTENT_SKIP_PATTERNS.some((re) => re.test(rel)),
            ...(sensitive ? { sensitive } : {})
          }
          files.push(sf)
          snapshotFile.contentApproved = sf.isContentCandidate
          totalBytes += size
          const lang = EXT_LANG[ext]
          if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1)
          const matched = KEY_FILE_RULES.find((r) => r.match(entry.name, relDir))
          if (matched && keyFiles.length < 30) keyFiles.push({ path: rel, reason: matched.reason })
        }
      }
    }
    return nodes
  }

  const projectName = projectDisplayName(root)
  const tree: FileNode = {
    name: projectName, path: '', type: 'dir', children: await walk(scanRoot, '', 0),
    ...(rootSensitive ? { modelExcluded: true } : {})
  }

  const codeTotal = Array.from(langCount.values()).reduce((a, b) => a + b, 0)
  const languages: LanguageStat[] = Array.from(langCount.entries())
    .map(([lang, n]) => ({ lang, files: n, percent: codeTotal ? Math.round((n / codeTotal) * 1000) / 10 : 0 }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 10)

  const result: ScanResult = {
    root,
    name: projectName,
    totalFiles: files.length,
    totalBytes,
    languages,
    tree,
    keyFiles,
    security,
    files
  }
  if (byFileCount || byTreeNodes || oversizedFiles > 0) {
    const truncation: ScanTruncation = { byFileCount, byTreeNodes, oversizedFiles, estimatedSkipped, limits: eff }
    result.truncation = truncation
  }
  try {
    const snapshot: ProjectSnapshot = { identity: projectIdentity, entries: snapshotEntries, valid: snapshotValid, contentReadable, maxContentFileBytes: eff.maxContentFileBytes }
    recordProjectSnapshot(result, snapshot)
  } catch {
    recordProjectSnapshot(result, { identity: { realPath: root, key: root }, entries: snapshotEntries, valid: false, contentReadable: false })
  }
  return result
}

/** 将文件树渲染为缩进文本（供大模型阅读） */
export function treeToText(node: FileNode, maxLines = 4000, projectRoot?: string): string {
  if (node.modelExcluded || (projectRoot !== undefined && classifySensitivePath('__project_root__', projectRoot))) {
    return '（项目根目录已按安全策略排除）'
  }
  const lines: string[] = [`${node.name}/`]
  function render(nodes: FileNode[], prefix: string): void {
    if (lines.length >= maxLines) return
    for (const n of nodes) {
      if (lines.length >= maxLines) {
        lines.push(`${prefix}…（已截断）`)
        return
      }
      if (n.modelExcluded || classifySensitivePath(n.path, projectRoot ?? '')) continue
      if (n.type === 'dir') {
        lines.push(`${prefix}${n.name}/`)
        render(n.children ?? [], `${prefix}  `)
      } else {
        const kb = n.size ? ` (${Math.max(1, Math.round(n.size / 1024))}KB)` : ''
        lines.push(`${prefix}${n.name}${kb}`)
      }
    }
  }
  render(node.children ?? [], '  ')
  return lines.join('\n')
}
