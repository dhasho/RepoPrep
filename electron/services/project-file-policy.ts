/** Pure file classification shared by scanning and context selection. */
type FileKind = 'source' | 'style' | 'markup' | 'data' | 'document'
interface FileTypeGroup {
  language: string
  kind: FileKind
  extensions: readonly string[]
}

const FILE_TYPE_GROUPS: readonly FileTypeGroup[] = [
  { language: 'TypeScript', kind: 'source', extensions: ['ts', 'tsx', 'mts', 'cts'] },
  { language: 'JavaScript', kind: 'source', extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  { language: 'Python', kind: 'source', extensions: ['py'] },
  { language: 'Java', kind: 'source', extensions: ['java'] },
  { language: 'Go', kind: 'source', extensions: ['go'] },
  { language: 'Rust', kind: 'source', extensions: ['rs'] },
  { language: 'C', kind: 'source', extensions: ['c', 'h'] },
  { language: 'C++', kind: 'source', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh'] },
  { language: 'C#', kind: 'source', extensions: ['cs'] },
  { language: 'Ruby', kind: 'source', extensions: ['rb'] },
  { language: 'PHP', kind: 'source', extensions: ['php'] },
  { language: 'Swift', kind: 'source', extensions: ['swift'] },
  { language: 'Kotlin', kind: 'source', extensions: ['kt', 'kts'] },
  { language: 'Scala', kind: 'source', extensions: ['scala'] },
  { language: 'Dart', kind: 'source', extensions: ['dart'] },
  { language: 'Lua', kind: 'source', extensions: ['lua'] },
  { language: 'R', kind: 'source', extensions: ['r'] },
  { language: 'Objective-C', kind: 'source', extensions: ['m'] },
  { language: 'Objective-C++', kind: 'source', extensions: ['mm'] },
  { language: 'Shell', kind: 'source', extensions: ['sh', 'bash', 'zsh', 'fish'] },
  { language: 'PowerShell', kind: 'source', extensions: ['ps1', 'psm1'] },
  { language: 'Batch', kind: 'source', extensions: ['bat', 'cmd'] },
  { language: 'SQL', kind: 'source', extensions: ['sql'] },
  { language: 'Gradle', kind: 'source', extensions: ['gradle'] },
  { language: 'Protobuf', kind: 'source', extensions: ['proto'] },
  { language: 'GraphQL', kind: 'source', extensions: ['graphql'] },
  { language: 'Prisma', kind: 'source', extensions: ['prisma'] },
  { language: 'CSS', kind: 'style', extensions: ['css'] },
  { language: 'Sass', kind: 'style', extensions: ['scss', 'sass'] },
  { language: 'Less', kind: 'style', extensions: ['less'] },
  { language: 'Vue', kind: 'markup', extensions: ['vue'] },
  { language: 'Svelte', kind: 'markup', extensions: ['svelte'] },
  { language: 'Astro', kind: 'markup', extensions: ['astro'] },
  { language: 'HTML', kind: 'markup', extensions: ['html', 'htm'] },
  { language: 'XML', kind: 'markup', extensions: ['xml'] },
  { language: 'JSON', kind: 'data', extensions: ['json', 'jsonc'] },
  { language: 'YAML', kind: 'data', extensions: ['yaml', 'yml'] },
  { language: 'TOML', kind: 'data', extensions: ['toml'] },
  { language: 'Markdown', kind: 'document', extensions: ['md', 'mdx'] }
]

const languageByExt: Record<string, string> = {}
const codeExts = new Set<string>()
for (const group of FILE_TYPE_GROUPS) {
  for (const ext of group.extensions) {
    languageByExt[ext] = group.language
    if (group.kind === 'source' || group.kind === 'style' || group.kind === 'markup') codeExts.add(ext)
  }
}

export const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = languageByExt
export const CODE_EXTS: ReadonlySet<string> = codeExts

const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-lock.yml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'composer.lock',
  'gemfile.lock', 'go.sum', 'packages.lock.json', 'gradle.lockfile'
])

/** Lockfiles remain visible to the tree and snapshot, but their bodies are never approved. */
export function isLockfilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  return LOCKFILE_NAMES.has(basename) || basename.endsWith('.lock') || basename.endsWith('-lock.js')
}

export function isContentPolicyExcluded(relPath: string): boolean {
  return isLockfilePath(relPath) || /\.min\.(js|css)$/i.test(relPath) || /\.map$/i.test(relPath) ||
    /\.(png|jpe?g|gif|webp|ico|bmp|avif|svg|zip|tar|gz|rar|7z|tgz|exe|dll|so|dylib|bin|dat|class|jar|war|pyd|pyc|node|wasm|woff2?|ttf|otf|eot|mp3|mp4|avi|mov|mkv|wav|flac|pdf|docx?|xlsx?|pptx?)$/i.test(relPath)
}
