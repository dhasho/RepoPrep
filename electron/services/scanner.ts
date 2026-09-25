// 项目目录扫描：文件树、语言统计、关键文件识别
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'
import type { FileNode, KeyFileInfo, LanguageStat, ProjectOverview, SecurityProtectionSummary } from '../../shared/types'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { classifySensitivePath } from './sensitive.ts'

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

const MAX_WALK_FILES = 8000
const MAX_TREE_NODES = 4000
const MAX_CONTENT_FILE_BYTES = 256 * 1024

export interface ScannedFile {
  relPath: string
  absPath: string
  size: number
  ext: string
  isContentCandidate: boolean // 是否可作为源码内容送入大模型
  sensitive?: { category: string; reason: string }
}

export interface ScanResult extends ProjectOverview {
  files: ScannedFile[] // 扁平文件列表（供上下文构建使用）
}

export async function scanProject(root: string): Promise<ScanResult> {
  const rootStat = await fs.stat(root)
  if (!rootStat.isDirectory()) throw new Error('所选路径不是目录')

  // 解析根目录 .gitignore
  const ig = ignore().add(ALWAYS_IGNORE)
  const gitignorePath = path.join(root, '.gitignore')
  if (fsSync.existsSync(gitignorePath)) {
    try {
      ig.add(await fs.readFile(gitignorePath, 'utf-8'))
    } catch {
      /* 解析失败则忽略 */
    }
  }

  const files: ScannedFile[] = []
  const langCount = new Map<string, number>()
  const keyFiles: KeyFileInfo[] = []
  let totalBytes = 0
  let treeNodes = 0
  const security: SecurityProtectionSummary = { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} }

  async function walk(absDir: string, relDir: string, depth: number): Promise<FileNode[]> {
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return [] // 无权限等错误直接跳过
    }
    const nodes: FileNode[] = []
    // 目录优先、其余按名称排序，保证树稳定
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (ig.ignores(rel)) continue
      if (files.length >= MAX_WALK_FILES || treeNodes >= MAX_TREE_NODES) break

      if (entry.isDirectory()) {
        // ignore 包对 'dir/' 规则需用带斜杠的路径形式测试目录本身
        if (ig.ignores(rel) || ig.ignores(`${rel}/`)) continue
        treeNodes++
        const children = await walk(path.join(absDir, entry.name), rel, depth + 1)
        nodes.push({ name: entry.name, path: rel, type: 'dir', children })
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = (await fs.stat(path.join(absDir, entry.name))).size
        } catch {
          continue
        }
        treeNodes++
        nodes.push({ name: entry.name, path: rel, type: 'file', size })

        const ext = path.extname(entry.name).slice(1).toLowerCase()
        const isBinary = BINARY_EXT.has(ext)
        const sensitive = classifySensitivePath(rel)
        if (sensitive) {
          security.excludedFiles++
          security.categories[sensitive.category] = (security.categories[sensitive.category] ?? 0) + 1
        }
        if (!isBinary) {
          const sf: ScannedFile = {
            relPath: rel,
            absPath: path.join(absDir, entry.name),
            size,
            ext,
            isContentCandidate: !sensitive && size <= MAX_CONTENT_FILE_BYTES && !CONTENT_SKIP_PATTERNS.some((re) => re.test(rel)),
            ...(sensitive ? { sensitive } : {})
          }
          files.push(sf)
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

  const tree: FileNode = { name: path.basename(root), path: '', type: 'dir', children: await walk(root, '', 0) }

  const codeTotal = Array.from(langCount.values()).reduce((a, b) => a + b, 0)
  const languages: LanguageStat[] = Array.from(langCount.entries())
    .map(([lang, n]) => ({ lang, files: n, percent: codeTotal ? Math.round((n / codeTotal) * 1000) / 10 : 0 }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 10)

  return {
    root,
    name: path.basename(root),
    totalFiles: files.length,
    totalBytes,
    languages,
    tree,
    keyFiles,
    security,
    files
  }
}

/** 将文件树渲染为缩进文本（供大模型阅读） */
export function treeToText(node: FileNode, maxLines = 4000): string {
  const lines: string[] = [`${node.name}/`]
  function render(nodes: FileNode[], prefix: string): void {
    if (lines.length >= maxLines) return
    for (const n of nodes) {
      if (lines.length >= maxLines) {
        lines.push(`${prefix}…（已截断）`)
        return
      }
      if (classifySensitivePath(n.path)) continue
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
