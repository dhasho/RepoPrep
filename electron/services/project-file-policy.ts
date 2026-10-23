/** Pure file classification shared by scanning and context selection. */
export const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', java: 'Java', go: 'Go', rs: 'Rust',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++',
  cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin', kts: 'Kotlin',
  scala: 'Scala', dart: 'Dart', lua: 'Lua', r: 'R', m: 'Objective-C', mm: 'Objective-C',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  css: 'CSS', scss: 'Sass', sass: 'Sass', less: 'Less',
  html: 'HTML', htm: 'HTML', xml: 'XML', json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  md: 'Markdown', mdx: 'Markdown', sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell',
  ps1: 'PowerShell', psm1: 'PowerShell', bat: 'Batch', cmd: 'Batch', gradle: 'Gradle', proto: 'Protobuf',
  graphql: 'GraphQL', prisma: 'Prisma'
}

/** Source, style, and markup files that may contribute to fine context. */
export const CODE_EXTS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'rb', 'php', 'swift', 'kt', 'kts',
  'scala', 'dart', 'lua', 'r', 'm', 'mm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml',
  'sql', 'proto', 'graphql', 'prisma', 'gradle'
])

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
