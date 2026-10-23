import path from 'node:path'
import type { Granularity } from '../../shared/types'
import type { ScannedFile } from './scanner'
import ts from 'typescript'
import { analyzeSource } from './source-analysis'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { CODE_EXTS } from './project-file-policy.ts'

export { CODE_EXTS }

const CONFIG_BASENAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'next.config.js',
  'nuxt.config.ts', 'vue.config.js', 'babel.config.js', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.prettierrc', '.prettierrc.json',
  'electron.vite.config.ts', 'electron.vite.config.js', 'electron-builder.yml', 'electron-builder.yaml', 'electron-builder.json',
  'tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'go.mod', 'cargo.toml', 'makefile',
  'cmakelists.txt', 'requirements.txt', 'pyproject.toml', 'setup.py', 'composer.json', 'gemfile', 'mix.exs',
  'docker-compose.yml', 'docker-compose.yaml', 'dockerfile'
])

export interface FileSelectionSignals {
  entryPaths: ReadonlySet<string>
  importedBy: ReadonlyMap<string, number>
  importEdges?: readonly { fromPath: string; targetPath: string; specifier: string; importedNames: string[] }[]
  referencedSymbols?: ReadonlyMap<string, readonly string[]>
}

const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '')
const baseName = (value: string): string => path.posix.basename(normalize(value)).toLowerCase()
const extension = (value: string): string => path.posix.extname(value).slice(1).toLowerCase()
const codeFile = (value: string): boolean => CODE_EXTS.has(extension(value))
const docFile = (value: string): boolean => /\.(md|json|ya?ml|toml|txt|rst)$/i.test(value)
const isReadme = (value: string): boolean => /^readme\./i.test(baseName(value))
const isManifest = (value: string): boolean => baseName(value) === 'package.json'
const isConfig = (value: string): boolean => CONFIG_BASENAMES.has(baseName(value))
const isRootProjectFact = (value: string): boolean => isRootPath(value) && (
  isReadme(value) || ['package.json', 'cargo.toml', 'go.mod', 'pyproject.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json'].includes(baseName(value))
)
const isTest = (value: string): boolean => /(^|\/)(__tests__|tests?|spec|fixtures?)(\/|$)|\.(test|spec)\.[^.]+$/i.test(normalize(value))
const isGenerated = (value: string): boolean => /(^|\/)(generated|dist|build|coverage|vendor)(\/|$)|\.(min|generated)\.[^.]+$/i.test(normalize(value))

export function isCoarseCandidate(relPath: string): boolean {
  return isReadme(relPath) || isConfig(relPath) || docFile(relPath)
}

function isRootPath(relPath: string): boolean {
  return !normalize(relPath).includes('/')
}

function moduleKey(relPath: string): string {
  const parts = normalize(relPath).split('/').slice(0, -1)
  if (!parts.length) return '(root)'
  const lower = parts.map((part) => part.toLowerCase())
  const roots = new Set(['src', 'lib', 'app', 'apps', 'packages', 'package', 'modules', 'services', 'components', 'tests', 'test'])
  const container = lower.findIndex((part) => ['packages', 'apps', 'modules'].includes(part))
  if (container >= 0) {
    const nestedContainer = lower.findIndex((part, index) => index > container + 1 && ['packages', 'apps', 'modules'].includes(part))
    const end = nestedContainer >= 0 ? Math.min(parts.length, nestedContainer + 2) : container + 2
    return parts.slice(container, end).join('/') || '(root)'
  }
  let start = 0
  while (start < parts.length - 1 && roots.has(lower[start])) start++
  return parts.slice(start, start + 1).join('/') || '(root)'
}

function role(file: ScannedFile, signals: FileSelectionSignals): number {
  const rel = normalize(file.relPath)
  if (isRootProjectFact(rel)) return 0
  if (signals.entryPaths.has(rel)) return 1
  const isNonBusiness = isTest(rel) || isGenerated(rel)
  const inbound = signals.importedBy.get(rel) ?? 0
  if (codeFile(rel) && inbound > 0 && !isNonBusiness) return 2
  if (isConfig(rel)) return 5
  if (!isNonBusiness && /^(main|index|app|server|cli)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java)$/i.test(baseName(rel))) return 3
  if (codeFile(rel) && !isNonBusiness) return 4
  if (docFile(rel)) return 6
  if (codeFile(rel)) return 7
  return 8
}

function roundRobin(files: readonly ScannedFile[], rank: (file: ScannedFile) => number, priority: (file: ScannedFile) => number = () => 0): ScannedFile[] {
  const tiers = new Map<number, Map<string, ScannedFile[]>>()
  for (const file of files) {
    const tier = rank(file)
    const modules = tiers.get(tier) ?? new Map<string, ScannedFile[]>()
    const key = moduleKey(file.relPath)
    const bucket = modules.get(key) ?? []
    bucket.push(file)
    modules.set(key, bucket)
    tiers.set(tier, modules)
  }
  const output: ScannedFile[] = []
  for (const [tier, modules] of [...tiers.entries()].sort(([a], [b]) => a - b)) {
    let activeKeys = [...modules.keys()].sort((a, b) => a.localeCompare(b))
    for (const bucket of modules.values()) {
      bucket.sort((a, b) => tier >= 2 && tier <= 4
        ? (priority(b) - priority(a)) || normalize(a.relPath).localeCompare(normalize(b.relPath))
        : normalize(a.relPath).localeCompare(normalize(b.relPath)))
    }
    const cursorByModule = new Map(activeKeys.map((key) => [key, 0]))
    while (activeKeys.length) {
      const nextActiveKeys: string[] = []
      for (const key of activeKeys) {
        const bucket = modules.get(key) ?? []
        const cursor = cursorByModule.get(key) ?? 0
        const file = bucket[cursor]
        if (file) {
          output.push(file)
          const nextCursor = cursor + 1
          cursorByModule.set(key, nextCursor)
          if (nextCursor < bucket.length) nextActiveKeys.push(key)
        }
      }
      activeKeys = nextActiveKeys
    }
  }
  return output
}

function rotateModules(
  files: readonly ScannedFile[],
  compare: (a: ScannedFile, b: ScannedFile) => number
): ScannedFile[] {
  const modules = new Map<string, ScannedFile[]>()
  for (const file of files) {
    const key = moduleKey(file.relPath)
    const bucket = modules.get(key) ?? []
    bucket.push(file)
    modules.set(key, bucket)
  }
  for (const bucket of modules.values()) bucket.sort(compare)
  let activeKeys = [...modules.keys()].sort((a, b) => {
    const firstA = modules.get(a)?.[0]
    const firstB = modules.get(b)?.[0]
    return (firstA && firstB ? compare(firstA, firstB) : 0) || a.localeCompare(b)
  })
  const output: ScannedFile[] = []
  const cursorByModule = new Map(activeKeys.map((key) => [key, 0]))
  while (activeKeys.length) {
    const nextActiveKeys: string[] = []
    for (const key of activeKeys) {
      const bucket = modules.get(key) ?? []
      const cursor = cursorByModule.get(key) ?? 0
      const file = bucket[cursor]
      if (file) {
        output.push(file)
        const nextCursor = cursor + 1
        cursorByModule.set(key, nextCursor)
        if (nextCursor < bucket.length) nextActiveKeys.push(key)
      }
    }
    activeKeys = nextActiveKeys
  }
  return output
}

export function orderFilesForContext(files: readonly ScannedFile[], granularity: Granularity, signals: FileSelectionSignals = { entryPaths: new Set(), importedBy: new Map() }): ScannedFile[] {
  const candidates = files.filter((file) => file.isContentCandidate && (granularity !== 'coarse' || isCoarseCandidate(file.relPath)))
  const compare = (a: ScannedFile, b: ScannedFile): number =>
    role(a, signals) - role(b, signals) ||
    (signals.importedBy.get(normalize(b.relPath)) ?? 0) - (signals.importedBy.get(normalize(a.relPath)) ?? 0) ||
    normalize(a.relPath).localeCompare(normalize(b.relPath))
  const facts = candidates.filter((file) => role(file, signals) === 0).sort(compare)
  const remaining = candidates.filter((file) => role(file, signals) !== 0)
  if (granularity === 'coarse') return [...facts, ...rotateModules(remaining, compare)]
  const business = remaining.filter((file) => role(file, signals) <= 4)
  const fallback = remaining.filter((file) => role(file, signals) > 4)
  return [...facts, ...rotateModules(business, compare), ...rotateModules(fallback, compare)]
}

export function selectProbeFiles(files: readonly ScannedFile[], granularity: Granularity, maxFiles = 128, maxBytes = 2 * 1024 * 1024): ScannedFile[] {
  const manifests = files.filter((file) => file.isContentCandidate && isManifest(file.relPath))
  const configs = files.filter((file) => file.isContentCandidate && isTsConfig(file.relPath))
  const reserved = new Set([...manifests, ...configs])
  const configLimit = Math.min(16, Math.max(1, Math.floor(Math.max(0, maxFiles) / 8)))
  const configOrder = roundRobin(configs, () => 0).slice(0, configLimit)
  const ordered = [...roundRobin(manifests, () => 0), ...configOrder, ...orderFilesForContext(files.filter((file) => !reserved.has(file)), granularity)]
  const selected: ScannedFile[] = []
  let bytes = 0
  let configBytes = 0
  for (const file of ordered) {
    const size = Number.isFinite(file.size) && file.size >= 0 ? file.size : 0
    if (isTsConfig(file.relPath) && configBytes + size > Math.min(256 * 1024, Math.floor(Math.max(0, maxBytes) / 8))) continue
    if (selected.length >= Math.max(0, maxFiles) || bytes + size > Math.max(0, maxBytes)) continue
    selected.push(file)
    bytes += size
    if (isTsConfig(file.relPath)) configBytes += size
  }
  return selected
}

function isTsConfig(rel: string): boolean {
  return /^(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i.test(baseName(rel))
}

function safeManifestPath(value: string): string | undefined {
  if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.includes('\\')) return undefined
  const clean = value.replace(/^\.\//, '').split(/[?#]/, 1)[0]
  if (!clean) return undefined
  return normalize(clean)
}

interface PathMapping { pattern: string; targets: string[]; origin: string; baseUrl: string }
interface ParsedConfig { mappings: PathMapping[]; baseUrl: string }

function safeRelative(value: string): string | undefined {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return undefined
  const normalized = path.posix.normalize(value)
  return normalized === '..' || normalized.startsWith('../') ? undefined : normalized.replace(/^\.\//, '')
}

function resolveConfigPath(from: string, spec: string, known: ReadonlySet<string>): string | undefined {
  if (!(spec.startsWith('./') || spec.startsWith('../')) || spec.includes('\\') || /^[a-zA-Z]:/.test(spec)) return undefined
  const base = safeRelative(path.posix.join(path.posix.dirname(normalize(from)), spec))
  if (!base) return undefined
  const guesses = [base, `${base}.json`, path.posix.join(base, 'tsconfig.json')]
  return guesses.find((guess) => known.has(guess))
}

function mappingsForConfig(rel: string, contents: ReadonlyMap<string, string>, knownConfigs: ReadonlySet<string>, cache: Map<string, ParsedConfig>, visiting: Set<string>, depth = 0): ParsedConfig {
  if (cache.has(rel)) return cache.get(rel) as ParsedConfig
  if (depth >= 8 || visiting.has(rel)) return { mappings: [], baseUrl: path.posix.dirname(rel) }
  visiting.add(rel)
  const raw = contents.get(rel) ?? contents.get(normalize(rel))
  let json: unknown
  try {
    if (!raw) throw new Error('missing')
    const parsed = ts.parseConfigFileTextToJson(rel, raw)
    if (parsed.error) throw new Error('invalid')
    json = parsed.config
  } catch {
    visiting.delete(rel)
    const empty = { mappings: [], baseUrl: path.posix.dirname(rel) }
    cache.set(rel, empty)
    return empty
  }
  const object = json && typeof json === 'object' ? json as Record<string, unknown> : {}
  let inherited: ParsedConfig = { mappings: [], baseUrl: path.posix.dirname(rel) }
  if (typeof object.extends === 'string') {
    const parent = resolveConfigPath(rel, object.extends, knownConfigs)
    if (parent) inherited = mappingsForConfig(parent, contents, knownConfigs, cache, visiting, depth + 1)
  }
  const options = object.compilerOptions && typeof object.compilerOptions === 'object' ? object.compilerOptions as Record<string, unknown> : {}
  const baseUrl = typeof options.baseUrl === 'string'
    ? safeRelative(path.posix.join(path.posix.dirname(rel), options.baseUrl)) ?? path.posix.dirname(rel)
    : inherited.baseUrl
  const own: PathMapping[] = []
  if (options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>).slice(0, 128)) {
      if (typeof pattern !== 'string' || (pattern.match(/\*/g)?.length ?? 0) > 1 || !Array.isArray(targets)) continue
      const validTargets = targets.filter((v): v is string => typeof v === 'string' && !v.startsWith('/') && !/^[a-zA-Z]:/.test(v) && !v.includes('\\')).slice(0, 16)
      if (validTargets.length) own.push({ pattern, targets: validTargets, origin: rel, baseUrl })
    }
  }
  const result = { mappings: options.paths ? [...inherited.mappings.filter((m) => !own.some((n) => n.pattern === m.pattern)), ...own] : inherited.mappings, baseUrl }
  visiting.delete(rel)
  cache.set(rel, result)
  return result
}

function aliasTarget(spec: string, mappings: readonly PathMapping[], candidates: ReadonlySet<string>): string | undefined {
  for (const mapping of mappings) {
    const star = mapping.pattern.indexOf('*')
    let capture: string | undefined
    if (star < 0) { if (mapping.pattern !== spec) continue }
    else {
      const prefix = mapping.pattern.slice(0, star)
      const suffix = mapping.pattern.slice(star + 1)
      if (!spec.startsWith(prefix) || !spec.endsWith(suffix) || spec.length < prefix.length + suffix.length) continue
      capture = spec.slice(prefix.length, spec.length - suffix.length)
    }
    for (const target of mapping.targets) {
      const replaced = capture === undefined ? target : target.replace('*', capture)
      const rel = safeRelative(path.posix.join(mapping.baseUrl, replaced))
      if (!rel) continue
      const ext = path.posix.extname(rel)
      const guesses = ext ? [rel, ...(ext === '.js' || ext === '.jsx' ? [rel.slice(0, -ext.length) + '.ts', rel.slice(0, -ext.length) + '.tsx'] : [])] : [rel, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((e) => rel + e), ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((n) => path.posix.join(rel, n))]
      const found = guesses.find((g) => candidates.has(g))
      if (found) return found
    }
  }
  return undefined
}

export function collectFileSignals(files: readonly ScannedFile[], contents: ReadonlyMap<string, string>): FileSelectionSignals {
  const candidates = new Set(files.filter((file) => file.isContentCandidate).map((file) => normalize(file.relPath)))
  const entries = new Set<string>()
  const sources = new Map<string, Set<string>>()
  const edges = new Map<string, { fromPath: string; targetPath: string; specifier: string; importedNames: string[] }>()
  const addReference = (from: string, raw: string, rootRelative = false, importedNames: string[] = []): void => {
    const specifier = safeManifestPath(raw)
    if (!specifier) return
    const dir = rootRelative ? '.' : path.posix.dirname(normalize(from))
    const stem = path.posix.normalize(path.posix.join(dir, specifier))
    if (stem === '..' || stem.startsWith('../') || stem.startsWith('/')) return
    const ext = path.posix.extname(stem)
    const guesses = ext
      ? [stem,
        ...(ext === '.js' || ext === '.jsx' ? [stem.slice(0, -ext.length) + '.ts', stem.slice(0, -ext.length) + '.tsx'] : []),
        ...(ext === '.mjs' ? [stem.slice(0, -ext.length) + '.mts'] : []),
        ...(ext === '.cjs' ? [stem.slice(0, -ext.length) + '.cts'] : [])]
      : [stem, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs'].map((suffix) => stem + suffix), ...['index.ts', 'index.tsx', 'index.mts', 'index.cts', 'index.js', 'index.mjs', 'index.cjs', '__init__.py', 'mod.rs'].map((name) => path.posix.join(stem, name))]
    const target = guesses.find((guess) => candidates.has(guess))
    if (!target || target === normalize(from)) return
    const referrers = sources.get(target) ?? new Set<string>()
    referrers.add(normalize(from))
    sources.set(target, referrers)
    const key = `${normalize(from)}\0${target}\0${raw}`
    const prior = edges.get(key)
    edges.set(key, { fromPath: normalize(from), targetPath: target, specifier: raw, importedNames: [...new Set([...(prior?.importedNames ?? []), ...importedNames])] })
  }

  const visitStrings = (value: unknown, visit: (text: string) => void, depth = 0): void => {
    if (depth > 8) return
    if (typeof value === 'string') visit(value)
    else if (Array.isArray(value)) value.slice(0, 100).forEach((item) => visitStrings(item, visit, depth + 1))
    else if (value && typeof value === 'object') Object.values(value).slice(0, 100).forEach((item) => visitStrings(item, visit, depth + 1))
  }

  const configFiles = files.filter((file) => file.isContentCandidate && isTsConfig(file.relPath)).map((file) => normalize(file.relPath))
  const configCache = new Map<string, ParsedConfig>()
  const configSet = new Set(configFiles)
  for (const file of files) {
    const rel = normalize(file.relPath)
    const content = contents.get(file.relPath) ?? contents.get(rel)
    if (!content || isTest(rel) || isGenerated(rel)) continue
    if (isManifest(rel)) {
      try {
        const manifest: unknown = JSON.parse(content)
        if (manifest && typeof manifest === 'object') {
          const record = manifest as Record<string, unknown>
          for (const key of ['main', 'module', 'bin', 'exports']) {
            visitStrings(record[key], (value) => {
              const safe = safeManifestPath(value)
              if (!safe || safe.split('/').includes('..')) return
              const ext = path.posix.extname(safe)
              const guesses = [
                safe,
                ...(ext === '.js' ? [safe.slice(0, -ext.length) + '.ts', safe.slice(0, -ext.length) + '.tsx'] : []),
                ...(ext === '.mjs' ? [safe.slice(0, -ext.length) + '.mts'] : []),
                ...(ext === '.cjs' ? [safe.slice(0, -ext.length) + '.cts'] : []),
                ...['.js', '.ts', '.mts', '.cts', '.mjs', '.cjs', '/index.js', '/index.ts', '/index.mts', '/index.cts'].map((suffix) => safe + suffix)
              ]
              const target = guesses.map((guess) => path.posix.normalize(path.posix.join(path.posix.dirname(rel), guess))).find((guess) => candidates.has(guess))
              if (target) entries.add(target)
            })
          }
        }
      } catch { /* malformed or bounded manifest data contributes no entry signal */ }
    }
    const sourceAnalysis = analyzeSource(rel, content)
    if (sourceAnalysis) {
      const sourceDir = path.posix.dirname(rel)
      const applicable = configFiles.filter((config) => {
        const dir = path.posix.dirname(config)
        return dir === '.' || sourceDir === dir || sourceDir.startsWith(`${dir}/`)
      }).sort((a, b) => path.posix.dirname(b).length - path.posix.dirname(a).length)[0]
      const parsed = applicable ? mappingsForConfig(applicable, contents, configSet, configCache, new Set()) : undefined
      for (const ref of sourceAnalysis.imports) {
        if (ref.specifier.startsWith('.')) addReference(rel, ref.specifier, false, ref.importedNames)
        else if (!ref.specifier.startsWith('#') && parsed) {
          const target = aliasTarget(ref.specifier, parsed.mappings, candidates)
          if (target && target !== rel) {
            const refs = sources.get(target) ?? new Set<string>()
            refs.add(rel)
            sources.set(target, refs)
            const key = `${rel}\0${target}\0${ref.specifier}`
            const prev = edges.get(key)
            edges.set(key, { fromPath: rel, targetPath: target, specifier: ref.specifier, importedNames: [...new Set([...(prev?.importedNames ?? []), ...ref.importedNames])] })
          }
        }
      }
    } else {
      const pattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|^\s*import\s+)["']([^"']+)["']/gm
      for (const match of content.matchAll(pattern)) if (match[1].startsWith('.')) addReference(rel, match[1])
    }
    if (extension(rel) === 'py') {
      const pyPattern = /^\s*(?:from\s+([.\w]+)\s+import\s+([\w*]+)|import\s+([\w.]+))/gm
      for (const match of content.matchAll(pyPattern)) {
        const fromModule = match[1]
        const importedName = match[2]
        const absoluteModule = match[3]
        if (fromModule) {
          const dots = fromModule.match(/^\.+/)?.[0].length ?? 0
          const moduleTail = fromModule.replace(/^\.+/, '').replace(/\./g, '/')
          const target = moduleTail || (importedName === '*' ? '' : importedName)
          const relative = `${'../'.repeat(Math.max(0, dots - 1))}${target}`
          addReference(rel, `./${relative}`, dots === 0)
        } else if (absoluteModule) {
          const rootPath = absoluteModule.replace(/\./g, '/')
          addReference(rel, `./${rootPath}`, true)
        }
      }
    }
  }
  const importEdges = [...edges.values()]
  const referenced = new Map<string, Set<string>>()
  for (const edge of importEdges) {
    const names = referenced.get(edge.targetPath) ?? new Set<string>()
    edge.importedNames.forEach((name) => names.add(name))
    referenced.set(edge.targetPath, names)
  }
  return {
    entryPaths: entries,
    importedBy: new Map([...sources].map(([target, referrers]) => [target, referrers.size])),
    importEdges,
    referencedSymbols: new Map([...referenced].map(([target, names]) => [target, [...names].sort()]))
  }
}
