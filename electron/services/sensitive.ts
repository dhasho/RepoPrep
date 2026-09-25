/** Small, deterministic sensitive-data classifier/redactor.
 *
 * The rules are deliberately data-driven and each expression is bounded to a
 * line/token. This module has no filesystem or Electron dependencies so it
 * can be used by the scanner and tested in isolation.
 */
export type SensitiveCategory =
  | 'env-file'
  | 'credential-file'
  | 'cloud-credential'
  | 'secret-directory'
  | 'private-key-file'
  | 'private-key'
  | 'token'
  | 'jwt'
  | 'bearer-token'
  | 'connection-string'
  | 'secret-assignment'

export interface SensitivePathMatch { category: SensitiveCategory; reason: string }
export interface SensitiveMatchCount { category: SensitiveCategory; count: number }
export interface RedactionResult { content: string; totalMatches: number; matches: SensitiveMatchCount[] }

const PATH_RULES: Array<{ category: SensitiveCategory; reason: string; test: (path: string, base: string, parts: string[]) => boolean }> = [
  { category: 'env-file', reason: 'environment file', test: (_p, b) => /^\.env(?:\..*)?$/i.test(b) },
  { category: 'credential-file', reason: 'package or Git credential file', test: (_p, b) => /^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i.test(b) },
  { category: 'cloud-credential', reason: 'cloud/container credential file', test: (p, b) => /^(?:credentials|application_default_credentials\.json|service-account[^/]*\.json|kubeconfig|config|config\.json)$/i.test(b) && (b === 'kubeconfig' || /(?:^|\/)(?:\.aws|\.gcloud|\.kube|\.docker|gcp)(?:\/|$)/i.test(p) || /^service-account[^/]*\.json$/i.test(b)) },
  { category: 'private-key-file', reason: 'private key or keystore file', test: (_p, b) => /(?:^id_(?:rsa|dsa|ecdsa|ed25519)|\.(?:pem|key|p12|pfx|jks|keystore|kdbx))$/i.test(b) },
  { category: 'secret-directory', reason: 'secret-bearing directory', test: (p, _b, parts) => parts.some((part) => /^(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gcloud)$/i.test(part)) || /(?:^|\/)(?:\.config\/gcloud)(?:\/|$)/i.test(p) }
]

export function classifySensitivePath(relPath: string): SensitivePathMatch | null {
  const normalized = relPath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '')
  const parts = normalized.split('/').filter(Boolean)
  const base = parts.at(-1) ?? ''
  const rule = PATH_RULES.find((candidate) => candidate.test(normalized, base, parts))
  return rule ? { category: rule.category, reason: rule.reason } : null
}

type ContentRule = { category: SensitiveCategory; pattern: RegExp; replacement: string | ((...args: string[]) => string) }

const SECRET_KEY = '(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)'
// Hex escapes keep the generated RegExp independent of template-literal
// delimiters while still supporting single, double and backtick strings.
const QUOTE_CLASS = '[\\x22\\x27\\x60]'
const EXAMPLE_VALUE = /^(?:placeholder|example|changeme|change-me|your(?:[_-](?:api[_-]?key|secret|token|password))?|<[^>]+>|xxx+)$/i
const TYPE_VALUE = /^(?:string|number|boolean|bigint|symbol|object|unknown|any|never|null|undefined|void|true|false|Record(?:<.*>)?|Readonly(?:<.*>)?)$/i

function assignmentReplacement(prefixIndex: number, quoteIndex: number | null, valueIndex: number, category: SensitiveCategory) {
  return (...args: string[]) => {
    const value = args[valueIndex] ?? ''
    // A type-only property can look like YAML. Keep obvious declarations and
    // documented examples intact, while provider-specific rules run first.
    if (EXAMPLE_VALUE.test(value.trim()) || TYPE_VALUE.test(value.trim())) return args[0]
    const quote = quoteIndex === null ? '' : (args[quoteIndex] ?? '')
    return `${args[1] ?? ''}${args[prefixIndex]}${quote}[REDACTED:${category}]${quote}`
  }
}

// Ordered from most specific to least specific; no expression uses nested
// unbounded quantifiers, keeping redaction safe for large pasted files.
const CONTENT_RULES: ContentRule[] = [
  { category: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, replacement: '[REDACTED:private-key]' },
  { category: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replacement: '[REDACTED:jwt]' },
  { category: 'bearer-token', pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, replacement: '$1[REDACTED:bearer-token]' },
  { category: 'token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-(?:proj-|live-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|ya29\.[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, replacement: '[REDACTED:token]' },
  { category: 'connection-string', pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, replacement: '$1[REDACTED:connection-string]$2' },
  // JavaScript/TypeScript assignments are separate from YAML/JSON because a
  // typed declaration may contain a colon before the actual equals sign.
  { category: 'secret-assignment', pattern: /(^|[\r\n])([ \t]*(?:(?:export|const|let|var)\s+)?(?:[A-Za-z_$][\w$]*\.)*(?:[A-Za-z_$][\w$]*)?(?:(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)|\[["']?(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)["']?\])(?:\s*\?\s*)?(?:\s*:\s*[^=\r\n]*?)?\s*=\s*)(["'`])([^\r\n]*?)\3(?=[ \t]*(?:[;,#]|$))/gim, replacement: assignmentReplacement(2, 3, 4, 'secret-assignment') },
  { category: 'secret-assignment', pattern: /(^|[\r\n])([ \t]*(?:(?:export|const|let|var)\s+)?(?:[A-Za-z_$][\w$]*\.)*(?:[A-Za-z_$][\w$]*)?(?:(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)|\[["']?(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)["']?\])(?:\s*\?\s*)?(?:\s*:\s*[^=\r\n]*?)?\s*=\s*)(?!["'`])([^\s"'`,;#]+)(?=[ \t]*(?:[;,#]|$))/gim, replacement: assignmentReplacement(2, null, 3, 'secret-assignment') },
  // JSON/YAML key/value assignments, including quoted keys.
  { category: 'secret-assignment', pattern: /(^|[\r\n])([ \t]*["']?(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)["']?[ \t]*:[ \t]*)(["'`])([^\r\n]*?)\3(?=[ \t]*(?:,|#|$))/gim, replacement: assignmentReplacement(2, 3, 4, 'secret-assignment') },
  { category: 'secret-assignment', pattern: /(^|[\r\n])([ \t]*["']?(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)["']?[ \t]*:[ \t]*)(?!["'`])([^\s"'`,;#]+)(?=[ \t]*(?:,|#|$))/gim, replacement: assignmentReplacement(2, null, 3, 'secret-assignment') }
]

export function redactSensitiveContent(content: string): RedactionResult {
  const counts = new Map<SensitiveCategory, number>()
  let output = content
  for (const rule of CONTENT_RULES) {
    rule.pattern.lastIndex = 0
    output = output.replace(rule.pattern, (...args: any[]) => {
      const replacementArgs = args.slice(0, -2)
      const replacement = typeof rule.replacement === 'function' ? rule.replacement(...replacementArgs) : rule.replacement.replace(/\$(\d+)/g, (_match, n: string) => String(args[Number(n)] ?? ''))
      if (replacement === args[0]) return replacement
      counts.set(rule.category, (counts.get(rule.category) ?? 0) + 1)
      // String.replace substitution syntax is normally applied by the native
      // replace implementation; because we count through a callback, expand
      // capture references explicitly here.
      return replacement
    })
  }
  const matches = Array.from(counts, ([category, count]) => ({ category, count }))
  return { content: output, totalMatches: matches.reduce((sum, item) => sum + item.count, 0), matches }
}
