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

type PathPlatform = NodeJS.Platform

function normalizePath(value: string, platform: PathPlatform, legacySeparators = false): string {
  const withSeparators = platform === 'win32' || legacySeparators ? value.replaceAll('\\', '/') : value
  return withSeparators.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '')
}

/**
 * Classify a relative path, optionally including the canonical selected root.
 * Including root segments protects a secret-bearing project selected directly
 * or reached through an ordinary alias, while the one-argument behavior stays
 * compatible with callers that only have a relative path.
 */
export function classifySensitivePath(relPath: string, projectRoot?: string, platform: PathPlatform = process.platform): SensitivePathMatch | null {
  // Legacy one-argument calls historically accepted Windows-style separators
  // on every host. Scanner paths include their root and follow host path rules.
  const normalizedRelPath = normalizePath(relPath, platform, projectRoot === undefined)
  const normalizedRoot = projectRoot === undefined ? '' : normalizePath(projectRoot, platform)
  const normalized = [normalizedRoot, normalizedRelPath].filter(Boolean).join('/')
  const parts = normalized.split('/').filter(Boolean)
  const base = parts.at(-1) ?? ''
  const rule = PATH_RULES.find((candidate) => candidate.test(normalized, base, parts))
  return rule ? { category: rule.category, reason: rule.reason } : null
}

type ContentRule = { category: SensitiveCategory; pattern: RegExp; replacement: string | ((...args: string[]) => string) }

const SECRET_KEY = /^(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)$/i
const SECRET_SOURCE_SUFFIX = /(?:^|[_-])(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)$|(?:accessToken|authToken|refreshToken|clientSecret|password|passwd|secretKey|apiKey)$/i
const EXAMPLE_VALUE = /^(?:placeholder|example|changeme|change-me|your(?:[_-](?:api[_-]?key|secret|token|refresh[_-]?token|password))?|<[^>]+>|xxx+)$/i
const TYPE_VALUE = /^(?:string|number|boolean|bigint|symbol|object|unknown|any|never|null|undefined|void|true|false|Record(?:<.*>)?|Readonly(?:<.*>)?)$/i
const EXISTING_REDACTION = /^\[REDACTED:[a-z-]+\]$/i
const ASSIGNMENT_REDACTION = '[REDACTED:secret-assignment]'
const MAX_TYPE_CONTEXT = 256

interface QuotedToken {
  end: number
  contentStart: number
  contentEnd: number
  value: string
  closed: boolean
}

interface RedactionSpan {
  start: number
  end: number
  replacement?: string
}

function readQuotedToken(source: string, start: number, limit = source.length): QuotedToken {
  const quote = source[start]
  const triple = (quote === '"' || quote === "'") && source.slice(start, start + 3) === quote.repeat(3)
  const delimiter = triple ? quote.repeat(3) : quote
  let index = start + delimiter.length
  while (index < limit) {
    const character = source[index]
    if (character === '\\' && (quote !== "'" || !triple)) {
      index += index + 1 < limit ? 2 : 1
      continue
    }
    if (triple && character === quote) {
      let runEnd = index + 1
      while (runEnd < limit && source[runEnd] === quote) runEnd++
      if (runEnd - index >= 3) {
        const closeStart = runEnd - 3
        return { end: runEnd, contentStart: start + 3, contentEnd: closeStart, value: source.slice(start + 3, closeStart), closed: true }
      }
    }
    if (!triple && character === quote) {
      return {
        end: index + 1,
        contentStart: start + 1,
        contentEnd: index,
        value: source.slice(start + 1, index),
        closed: true
      }
    }
    if (!triple && (quote === '"' || quote === "'") && (character === '\n' || character === '\r')) {
      return {
        end: index,
        contentStart: start + 1,
        contentEnd: index,
        value: source.slice(start + 1, index),
        closed: false
      }
    }
    index++
  }
  return {
    end: limit,
    contentStart: start + delimiter.length,
    contentEnd: limit,
    value: source.slice(start + delimiter.length, limit),
    closed: false
  }
}

function skipLineComment(source: string, start: number, limit = source.length): number {
  let index = start
  while (index < limit && source[index] !== '\n' && source[index] !== '\r') index++
  return index
}

function skipBlockComment(source: string, start: number, limit = source.length): number {
  const close = source.indexOf('*/', start + 2)
  return close < 0 || close + 2 > limit ? limit : close + 2
}

function findCommentRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (let index = 0; index < source.length;) {
    if (source[index] === '"' || source[index] === "'" || source[index] === '`') {
      index = readQuotedToken(source, index).end
      continue
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      const end = skipLineComment(source, index + 2)
      ranges.push({ start: index + 2, end })
      index = end
      continue
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const end = skipBlockComment(source, index)
      const closed = end >= index + 4 && source.slice(end - 2, end) === '*/'
      ranges.push({ start: index + 2, end: closed ? end - 2 : end })
      index = end
      continue
    }
    index++
  }
  return ranges
}

function skipTrivia(source: string, start: number, limit = source.length): number {
  let index = start
  while (index < limit) {
    if (/\s/.test(source[index])) {
      index++
      continue
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index + 2, limit)
      continue
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index, limit)
      continue
    }
    break
  }
  return index
}

function statementPrefix(source: string, start: number): string {
  let statementStart = Math.max(0, start - MAX_TYPE_CONTEXT)
  for (let index = start - 1; index >= statementStart; index--) {
    if (source[index] === '\n' || source[index] === '\r' || source[index] === ';') {
      statementStart = index + 1
      break
    }
  }
  return source.slice(statementStart, start)
}

/** Precompute type-literal bodies so keys like `clientSecret: SecretType` stay declarations. */
function findTypeBodyRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const parenClosings = findParenClosings(source)
  const delimiters: Array<{ closer: string; parameterStart: number; parameterBrace: 'unchecked' | 'runtime' | 'type'; kind: 'paren' | 'class' | 'object' | 'block'; signature: boolean; memberStart: number }> = []
  let mode: 'interface' | 'type-equals' | 'type-body' | null = null
  let bodyStart = -1
  let bodyDepth = 0

  for (let index = 0; index < source.length;) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') {
      index = skipLineComment(source, index + 2)
      continue
    }
    if (character === '/' && next === '*') {
      index = skipBlockComment(source, index)
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      index = readQuotedToken(source, index).end
      continue
    }

    // Anonymous object types in function, method, and arrow parameters are
    // runtime-looking braces. Mark only the type literal following a
    // parameter annotation; ordinary call arguments remain scannable.
    const currentDelimiter = delimiters[delimiters.length - 1]
    if (character === '{' && mode === null && currentDelimiter?.closer === ')' && currentDelimiter.signature && currentDelimiter.parameterBrace === 'unchecked') {
      currentDelimiter.parameterBrace = isParameterObjectTypeStart(source, currentDelimiter.parameterStart, index) ? 'type' : 'runtime'
      if (currentDelimiter.parameterBrace === 'type') {
        let depth = 1
        let end = index + 1
        while (end < source.length && depth > 0) {
          const current = source[end]
          const following = source[end + 1]
          if (current === '/' && following === '/') { end = skipLineComment(source, end + 2); continue }
          if (current === '/' && following === '*') { end = skipBlockComment(source, end); continue }
          if (current === '"' || current === "'" || current === '`') { end = readQuotedToken(source, end).end; continue }
          if (current === '{') depth++
          else if (current === '}' && --depth === 0) { end++; break }
          end++
        }
        ranges.push({ start: index, end })
        index = end
        continue
      }
    }

    if (bodyDepth > 0) {
      if (character === '{') bodyDepth++
      else if (character === '}' && --bodyDepth === 0) {
        ranges.push({ start: bodyStart, end: index + 1 })
        bodyStart = -1
      }
      index++
      continue
    }

    if (mode === 'interface') {
      // Keep scanning through generic defaults such as `Options<T = string>`;
      // the interface body begins at the following opening brace.
      if (character === '{') {
        mode = null
        bodyStart = index
        bodyDepth = 1
      }
    } else if (mode === 'type-equals') {
      if (character === '=') mode = 'type-body'
      else if (character === ';') mode = null
    } else if (mode === 'type-body') {
      if (character === '{') {
        mode = null
        bodyStart = index
        bodyDepth = 1
      } else if (character === ';') mode = null
    } else if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end++
      const word = source.slice(index, end)
      if ((word === 'interface' || word === 'type') && /^\s*(?:(?:export|declare|abstract|default)\s+)*$/.test(statementPrefix(source, index))) {
        if (word === 'interface') mode = 'interface'
        else if (word === 'type') mode = 'type-equals'
      }
      index = end
      continue
    }

    if ((character === '\n' || character === '\r') && mode === 'type-body') {
      let previous = index - 1
      while (previous >= 0 && /\s/.test(source[previous])) previous--
      if (source[previous] !== '=' && source[previous] !== '|' && source[previous] !== '&') mode = null
    }

    if (bodyDepth === 0 && mode === null) {
      if (character === '(') delimiters.push({
        closer: ')', parameterStart: index + 1, parameterBrace: 'unchecked', kind: 'paren',
        signature: isConfirmedParameterList(source, index, parenClosings.get(index), delimiters), memberStart: -1
      })
      else if (character === '[') delimiters.push({ closer: ']', parameterStart: -1, parameterBrace: 'runtime', kind: 'block', signature: false, memberStart: -1 })
      else if (character === '{') {
        const kind = isClassBodyStart(source, index) ? 'class' : isObjectBodyStart(source, index) ? 'object' : 'block'
        delimiters.push({ closer: '}', parameterStart: -1, parameterBrace: 'runtime', kind, signature: false, memberStart: index + 1 })
      }
      else if (character === ')' || character === ']' || character === '}') {
        if (delimiters[delimiters.length - 1]?.closer === character) {
          delimiters.pop()
          const parent = delimiters[delimiters.length - 1]
          if (character === '}' && (parent?.kind === 'class' || parent?.kind === 'object')) parent.memberStart = index + 1
        }
      } else if (character === ',' && currentDelimiter?.closer === ')') {
        currentDelimiter.parameterStart = index + 1
        currentDelimiter.parameterBrace = 'unchecked'
      } else if ((character === ',' || character === ';') && (currentDelimiter?.kind === 'class' || currentDelimiter?.kind === 'object')) {
        currentDelimiter.memberStart = index + 1
      }
    }
    index++
  }

  if (bodyDepth > 0 && bodyStart >= 0) ranges.push({ start: bodyStart, end: source.length })
  return ranges
}

function findParenClosings(source: string): Map<number, number> {
  const closings = new Map<number, number>()
  const openings: number[] = []
  for (let index = 0; index < source.length;) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') { index = skipLineComment(source, index + 2); continue }
    if (character === '/' && next === '*') { index = skipBlockComment(source, index); continue }
    if (character === '"' || character === "'" || character === '`') { index = readQuotedToken(source, index).end; continue }
    if (character === '(') openings.push(index)
    else if (character === ')' && openings.length > 0) closings.set(openings.pop()!, index)
    index++
  }
  return closings
}

function isConfirmedParameterList(source: string, open: number, close: number | undefined, delimiters: readonly { kind: string; memberStart: number }[]): boolean {
  if (close === undefined) return false
  const prefix = statementPrefix(source, open).trim()
  if (/^(?:(?:export|declare|default|async|abstract|public|private|protected|static|override)\s+)*function\s*\*?(?:\s+[\w$]+)?$/.test(prefix)) return true
  if (/(?:^|=)\s*(?:async\s+)?function\s*\*?(?:\s+[\w$]+)?$/.test(prefix)) return true

  const afterClose = skipTrivia(source, close + 1)
  if (source.startsWith('=>', afterClose)) return true
  const enclosing = delimiters[delimiters.length - 1]
  if (enclosing?.kind !== 'class' && enclosing?.kind !== 'object') return false
  return isMethodHead(source, enclosing.memberStart, open) && hasMethodBodyAfter(source, close + 1)
}

function isMethodHead(source: string, memberStart: number, open: number): boolean {
  let cursor = skipTrivia(source, memberStart, open)
  const modifiers = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'static', 'async', 'get', 'set'])
  while (cursor < open) {
    if (source[cursor] === '*') {
      cursor = skipTrivia(source, cursor + 1, open)
      continue
    }
    if (!isIdentifierStart(source[cursor])) return false
    let end = cursor + 1
    while (end < open && /[A-Za-z0-9_$]/.test(source[end])) end++
    const token = source.slice(cursor, end)
    const afterToken = skipTrivia(source, end, open)
    if (modifiers.has(token) && afterToken < open) {
      cursor = afterToken
      continue
    }
    return isIdentifierPart(source[end]) === false && afterToken === open
  }
  return false
}

function hasMethodBodyAfter(source: string, start: number): boolean {
  const cursor = skipTrivia(source, start)
  if (source[cursor] === '{') return true
  if (source[cursor] !== ':') return false
  const limit = Math.min(source.length, cursor + 512)
  for (let index = cursor + 1; index < limit;) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') { index = skipLineComment(source, index + 2, limit); continue }
    if (character === '/' && next === '*') { index = skipBlockComment(source, index, limit); continue }
    if (character === '"' || character === "'" || character === '`') { index = readQuotedToken(source, index, limit).end; continue }
    if (character === '{') return true
    if (character === ',' || character === ';' || character === '=' || character === '}' || source.startsWith('=>', index)) return false
    index++
  }
  return false
}

function isClassBodyStart(source: string, brace: number): boolean {
  return /^(?:(?:export|declare|abstract|default)\s+)*class\s+[\w$]+(?:\s+extends\s+[^{]+)?$/.test(statementPrefix(source, brace).trim())
}

function isObjectBodyStart(source: string, brace: number): boolean {
  const prefix = source.slice(Math.max(0, brace - MAX_TYPE_CONTEXT), brace).trimEnd()
  return /(?:=|:|return|\(|\[|,)$/.test(prefix)
}

function isParameterObjectTypeStart(source: string, segmentStart: number, brace: number): boolean {
  // Parse only the current direct-level parameter head. Trivia is accepted
  // between its name and colon; requiring the cursor to reach the candidate
  // brace excludes runtime objects in defaults and nested expressions.
  let cursor = skipTrivia(source, segmentStart, brace)
  if (source.startsWith('...', cursor)) cursor = skipTrivia(source, cursor + 3, brace)
  if (!isIdentifierStart(source[cursor])) return false
  cursor++
  while (cursor < brace && /[A-Za-z0-9_$]/.test(source[cursor])) cursor++
  cursor = skipTrivia(source, cursor, brace)
  if (source[cursor] === '?') cursor = skipTrivia(source, cursor + 1, brace)
  if (source[cursor] !== ':') return false
  return skipTrivia(source, cursor + 1, brace) === brace
}

function isInTypeBody(ranges: readonly { start: number; end: number }[], index: number): boolean {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (ranges[middle].start <= index) low = middle + 1
    else high = middle
  }
  const range = ranges[low - 1]
  return range !== undefined && index < range.end
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/.test(character)
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$-]/.test(character)
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (index < source.length && /\s/.test(source[index])) index++
  return index
}

function isSimpleAssignment(source: string, index: number): boolean {
  return source[index] === '=' && source[index - 1] !== '=' && source[index - 1] !== '<' && source[index - 1] !== '>' && source[index + 1] !== '=' && source[index + 1] !== '>'
}

function isTypedVariablePrefix(source: string, keyStart: number): boolean {
  const prefix = statementPrefix(source, keyStart)
  return /(?:^|[\s;{}])(?:(?:export|declare|default)\s+)*(?:const|let|var)\s+$/.test(prefix)
}

function isParameterTypePrefix(source: string, keyStart: number): boolean {
  const prefix = source.slice(Math.max(0, keyStart - MAX_TYPE_CONTEXT), keyStart)
  // A parameter list has an unmatched opening parenthesis with no intervening
  // object/array literal. Object properties in call({ ... }) therefore do not
  // look like parameter annotations.
  return /(?:\bfunction\s+[\w$]*\s*\([^{}]*|\b[A-Za-z_$][\w$]*\s*\([^{}]*)$/s.test(prefix)
}

function isClassFieldTypePrefix(source: string, keyStart: number): boolean {
  const prefix = source.slice(Math.max(0, keyStart - MAX_TYPE_CONTEXT), keyStart)
  // Class fields begin at a member boundary and may carry TS modifiers.
  // Requiring a class declaration in the same bounded context avoids treating
  // ordinary object-literal properties as fields.
  return /\bclass\s+[\w$]*[^{}]*\{(?:\s*|[^{}]*(?:[;\r\n{}])\s*)(?:(?:public|private|protected|readonly|declare|override|static|abstract)\s+)*$/s.test(prefix)
}

function isBareTypeAnnotation(source: string, start: number, limit: number): boolean {
  // Type classification is local to the annotation. Never copy/scan the rest
  // of a potentially large pasted source for each sensitive key.
  const localLimit = Math.min(limit, start + MAX_TYPE_CONTEXT)
  const match = /^[A-Za-z_$][\w$]*(?:\s*<[^;{}\r\n]*>)?/.exec(source.slice(start, localLimit))
  if (!match) return false
  const after = skipTrivia(source, start + match[0].length, localLimit)
  return source[after] === ',' || source[after] === ';' || source[after] === ')' || source[after] === '}' || (after >= localLimit && localLimit === limit)
}

/** Finds a top-level initializer in a TS variable annotation, stopping at structural delimiters. */
function findTypedInitializer(source: string, start: number, limit = source.length): number | null {
  let parentheses = 0
  let brackets = 0
  let braces = 0
  let angles = 0

  for (let index = start; index < limit;) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') return null
    if (character === '/' && next === '*') {
      index = skipBlockComment(source, index)
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      index = readQuotedToken(source, index).end
      continue
    }
    if (parentheses === 0 && brackets === 0 && braces === 0 && angles === 0) {
      if (character === ',' || character === ';' || character === '\n' || character === '\r' || character === '}') return null
      if (isSimpleAssignment(source, index)) return index
    }
    if (character === '(') parentheses++
    else if (character === ')' && parentheses > 0) parentheses--
    else if (character === '[') brackets++
    else if (character === ']' && brackets > 0) brackets--
    else if (character === '{') braces++
    else if (character === '}' && braces > 0) braces--
    else if (character === '<') angles++
    else if (character === '>' && angles > 0) angles--
    index++
  }
  return null
}

interface ParsedValue {
  start: number
  end: number
  next: number
  value: string
  replacement?: string
}

function hasExpressionContinuation(source: string, index: number, limit: number): boolean {
  const next = skipTrivia(source, index, limit)
  const character = source[next]
  if (character === '+' || character === '-' || character === '*' || character === '/' || character === '%' || character === '?' || character === '.' || character === '!' || character === '|' || character === '&') return true
  return source.startsWith('as ', next) || source.startsWith('satisfies ', next)
}

/** Reads one complete initializer expression, keeping object/property delimiters outside it. */
function parseExpressionValue(source: string, start: number, limit: number): ParsedValue | null {
  const expectedClosers: string[] = []
  let index = start
  while (index < limit) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') {
      const possibleUrlPrefix = source.slice(start, index).trim()
      const isUnquotedUrl = expectedClosers.length === 0 && /^[A-Za-z][A-Za-z0-9+.-]*:$/.test(possibleUrlPrefix)
      if (!isUnquotedUrl) {
        if (expectedClosers.length === 0) break
        index = skipLineComment(source, index + 2)
        continue
      }
    }
    if (character === '/' && next === '*') {
      index = skipBlockComment(source, index, limit)
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      index = readQuotedToken(source, index, limit).end
      continue
    }

    const topLevel = expectedClosers.length === 0
    const lineBreakContinuesExpression = (character === '\n' || character === '\r') && hasExpressionContinuation(source, index, limit)
    if (topLevel && (character === ',' || character === ';' || ((character === '\n' || character === '\r') && !lineBreakContinuesExpression) || character === '#' || character === '}' || character === ']' || character === ')')) {
      break
    }
    if (character === '(') expectedClosers.push(')')
    else if (character === '[') expectedClosers.push(']')
    else if (character === '{') expectedClosers.push('}')
    else if (character === ')' || character === ']' || character === '}') {
      if (expectedClosers.length === 0) break
      if (expectedClosers[expectedClosers.length - 1] !== character) {
        // A malformed/mismatched group is conservatively treated as part of
        // the sensitive value through the bounded scan limit.
        index = limit
        break
      }
      expectedClosers.pop()
    }
    index++
  }
  if (expectedClosers.length > 0) index = limit
  let end = index
  while (end > start && /\s/.test(source[end - 1])) end--
  if (end <= start) return null
  return { start, end, next: index, value: source.slice(start, end) }
}

function parseAssignmentValue(source: string, valueStart: number, colonValue: boolean, limit = source.length): ParsedValue | null {
  const start = skipTrivia(source, valueStart, limit)
  if (start >= limit || /[,;\]}#\r\n)]/.test(source[start])) return null

  if (colonValue && (source[start] === '|' || source[start] === '>')) {
    const block = parseYamlBlockScalar(source, start, limit)
    if (block) return block
  }

  const quote = source[start]
  if (quote === '"' || quote === "'" || quote === '`') {
    const token = readQuotedToken(source, start, limit)
    if (token.closed && hasExpressionContinuation(source, token.end, limit)) {
      return parseExpressionValue(source, start, limit)
    }
    return {
      start: token.contentStart,
      end: token.contentEnd,
      next: token.end,
      value: token.value
    }
  }

  if (source[start] === '(' || !colonValue) return parseExpressionValue(source, start, limit)

  // Already-redacted values are stable across repeated scanner/context passes.
  if (source.startsWith('[REDACTED:', start)) {
    const close = source.indexOf(']', start + 10)
    if (close >= 0 && close < limit) {
      const placeholder = source.slice(start, close + 1)
      if (EXISTING_REDACTION.test(placeholder)) {
        return { start, end: close + 1, next: close + 1, value: placeholder }
      }
    }
  }

  return parseExpressionValue(source, start, limit)
}

/** Reads a YAML block scalar only when its header is on a mapping line. */
function parseYamlBlockScalar(source: string, start: number, limit: number): ParsedValue | null {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const prefix = source.slice(lineStart, start)
  const mapping = /^[ \t]*(?:-[ \t]+)?(?:["'`][^\r\n]*?["'`]|[A-Za-z_$][\w$-]*)[ \t]*:[ \t]*$/.exec(prefix)
  if (!mapping) return null
  const lineEndLF = source.indexOf('\n', start)
  const lineEnd = lineEndLF < 0 || lineEndLF >= limit ? limit : lineEndLF
  const header = source.slice(start, lineEnd).replace(/\r$/, '')
  const match = /^([|>])([+-]?[1-9]?|[1-9]?[+-]?)(?:[ \t]+#.*)?[ \t]*$/.exec(header)
  const parentIndent = (/^[ \t]*/.exec(prefix)?.[0].length ?? 0) + (prefix.trimStart().startsWith('-') ? 2 : 0)
  const bodyStart = lineEndLF < 0 || lineEndLF >= limit ? limit : lineEndLF + 1
  if (bodyStart >= limit) return null
  let cursor = bodyStart
  const explicit = match ? /[1-9]/.exec(match[2]) : null
  const requiredIndent = explicit ? parentIndent + Number(explicit[0]) : null
  let inferredIndent: number | null = requiredIndent
  let hasContent = false
  while (cursor < limit) {
    let end = source.indexOf('\n', cursor)
    if (end < 0 || end >= limit) end = limit
    const contentEnd = end > cursor && source[end - 1] === '\r' ? end - 1 : end
    const line = source.slice(cursor, contentEnd)
    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0
    const blank = /^[ \t]*$/.test(line)
    if (!blank) {
      if (indent <= parentIndent) {
        const sibling = /^(?:[A-Za-z_$][\w$-]*|["'][^\r\n]+?["'])[ \t]*:/.test(line.slice(indent))
        if (sibling && match) {
          if (!hasContent) {
            return { start: bodyStart, end: bodyStart, next: bodyStart, value: ASSIGNMENT_REDACTION }
          }
          break
        }
        cursor = limit
        hasContent = true
        inferredIndent ??= parentIndent + 1
        break
      }
      if (requiredIndent !== null && indent < requiredIndent) {
        // Explicit indentation indicators define the minimum body indent.
        // A clearly aligned mapping is a sibling; ambiguous under-indented
        // content is malformed and must be consumed to the safe limit.
        const sibling = /^(?:[A-Za-z_$][\w$-]*|["'][^\r\n]+?["'])[ \t]*:/.test(line.slice(indent))
        if (sibling && match) {
          if (!hasContent) return { start: bodyStart, end: bodyStart, next: bodyStart, value: ASSIGNMENT_REDACTION }
          break
        }
        cursor = limit
        hasContent = true
        inferredIndent = indent
        break
      }
      if (inferredIndent === null) inferredIndent = indent
      hasContent = true
    }
    cursor = end < limit ? end + 1 : limit
  }
  if (!hasContent) return { start: bodyStart, end: bodyStart, next: bodyStart, value: ASSIGNMENT_REDACTION }
  const bodyEnd = cursor
  const replacementIndent = ' '.repeat((inferredIndent ?? parentIndent + 1))
  const trailingNewline = bodyEnd > bodyStart && source[bodyEnd - 1] === '\n' ? '\n' : ''
  return {
    start: bodyStart,
    end: bodyEnd,
    next: bodyEnd,
    value: source.slice(bodyStart, bodyEnd).trim(),
    replacement: `${replacementIndent}[REDACTED:secret-assignment]${trailingNewline}`
  }
}

function assignmentValueAt(source: string, keyStart: number, keyEnd: number, typeRanges: readonly { start: number; end: number }[], limit = source.length): ParsedValue | null {
  let cursor = skipTrivia(source, keyEnd, limit)
  if (source[cursor] === ']') cursor = skipTrivia(source, cursor + 1, limit)
  if (source[cursor] === '?') cursor = skipTrivia(source, cursor + 1, limit)

  if (isSimpleAssignment(source, cursor)) {
    return parseAssignmentValue(source, cursor + 1, false, limit)
  }
  if (source[cursor] !== ':') return null
  const valueStart = cursor + 1
  if (isInTypeBody(typeRanges, keyStart)) return null
  // A typed initializer is still an assignment even when its class or
  // declaration header is beyond the bounded context window.
  const initializer = findTypedInitializer(source, valueStart, limit)
  if (initializer !== null) return parseAssignmentValue(source, initializer + 1, false, limit)
  if ((isParameterTypePrefix(source, keyStart) || isClassFieldTypePrefix(source, keyStart)) && isBareTypeAnnotation(source, skipTrivia(source, valueStart, limit), limit)) return null
  if (isTypedVariablePrefix(source, keyStart) || isParameterTypePrefix(source, keyStart)) return null
  // Source declarations may have a prefixed secret key and a type before '='.
  // Only the remaining colon property path requires an exact key.
  const rawKey = source.slice(keyStart, keyEnd)
  const normalizedKey = rawKey[0] === '"' || rawKey[0] === "'" || rawKey[0] === '`' ? readQuotedToken(source, keyStart, keyEnd).value : rawKey
  if (!SECRET_KEY.test(normalizedKey)) return null
  return parseAssignmentValue(source, valueStart, true, limit)
}

function redactSecretAssignments(source: string, scanComments = true): { content: string; count: number; spans: RedactionSpan[] } {
  const typeRanges = findTypeBodyRanges(source)
  const spans: RedactionSpan[] = []
  for (let index = 0; index < source.length;) {
    const character = source[index]
    const next = source[index + 1]
    // Scan comment bodies as independent source fragments below. Skipping
    // them here keeps comment text from becoming live syntax.
    if (character === '/' && next === '/') {
      index = skipLineComment(source, index + 2)
      continue
    }
    if (character === '/' && next === '*') {
      index = skipBlockComment(source, index)
      continue
    }
    let keyStart = index
    let keyEnd = index
    let key: string | null = null
    let bracketed = false
    if (character === '"' || character === "'" || character === '`') {
      const token = readQuotedToken(source, index)
      if (token.closed && SECRET_KEY.test(token.value)) {
        key = token.value
        keyEnd = token.end
        bracketed = source[skipWhitespace(source, keyEnd)] === ']'
      } else {
        index = token.end
        continue
      }
    } else if (isIdentifierStart(character)) {
      keyEnd = index + 1
      while (isIdentifierPart(source[keyEnd])) keyEnd++
      const candidate = source.slice(keyStart, keyEnd)
      if (SECRET_KEY.test(candidate) || SECRET_SOURCE_SUFFIX.test(candidate)) key = candidate
      else {
        index = keyEnd
        continue
      }
    }

    if (key !== null) {
      const value = assignmentValueAt(source, keyStart, keyEnd, typeRanges)
      if (value) {
        const normalizedValue = value.value.trim()
        if (!EXAMPLE_VALUE.test(normalizedValue) && !TYPE_VALUE.test(normalizedValue) && !EXISTING_REDACTION.test(normalizedValue)) {
          spans.push({ start: value.start, end: value.end, replacement: value.replacement })
        }
        index = value.next
        continue
      }
      if (bracketed) {
        index = source.indexOf(']', keyEnd) + 1
        if (index === 0) index = keyEnd
      } else {
        index = keyEnd
      }
      continue
    }

    index++
  }

  // Credential examples are often pasted into comments. Redact only matches
  // contained by a comment, using local offsets so comment punctuation stays
  // untouched and comments before real values remain trivia.
  for (const range of scanComments ? findCommentRanges(source) : []) {
    const fragment = source.slice(range.start, range.end)
    const commented = redactSecretAssignments(fragment, false)
    spans.push(...commented.spans.map((span) => ({ ...span, start: span.start + range.start, end: span.end + range.start })))
  }

  spans.sort((left, right) => left.start - right.start)
  const uniqueSpans = spans.filter((span, index) => index === 0 || span.start >= spans[index - 1].end)
  if (uniqueSpans.length === 0) return { content: source, count: 0, spans: [] }
  const chunks: string[] = []
  let cursor = 0
  for (const span of uniqueSpans) {
    chunks.push(source.slice(cursor, span.start), span.replacement ?? ASSIGNMENT_REDACTION)
    cursor = span.end
  }
  chunks.push(source.slice(cursor))
  return { content: chunks.join(''), count: uniqueSpans.length, spans: uniqueSpans }
}

// Ordered from most specific to least specific; no expression uses nested
// unbounded quantifiers, keeping redaction safe for large pasted files.
const CONTENT_RULES: ContentRule[] = [
  { category: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, replacement: '[REDACTED:private-key]' },
  { category: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replacement: '[REDACTED:jwt]' },
  { category: 'bearer-token', pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, replacement: '$1[REDACTED:bearer-token]' },
  { category: 'token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-(?:proj-|live-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|ya29\.[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, replacement: '[REDACTED:token]' }
]

/**
 * Finds URI passwords in one forward pass. A regex with a greedy scheme
 * prefix retries from every word boundary on long non-URL values; tracking a
 * candidate scheme run keeps that case linear without limiting URI length.
 */
function redactConnectionCredentials(source: string): { content: string; count: number } {
  const spans: RedactionSpan[] = []
  let schemeStart = -1
  let schemeHasValidStart = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (/[A-Za-z0-9+.-]/.test(character)) {
      if (schemeStart < 0 && /[A-Za-z]/.test(character) && (index === 0 || !/[A-Za-z0-9_]/.test(source[index - 1]))) {
        schemeStart = index
        schemeHasValidStart = true
      }
      continue
    }
    if (character === ':' && schemeStart >= 0 && schemeHasValidStart && source[index + 1] === '/' && source[index + 2] === '/') {
      let cursor = index + 3
      while (cursor < source.length && !/[\s/@:]/.test(source[cursor])) cursor++
      if (source[cursor] === ':') {
        const passwordStart = ++cursor
        while (cursor < source.length && !/[\s/@]/.test(source[cursor])) cursor++
        if (cursor > passwordStart && source[cursor] === '@' && source.slice(passwordStart, cursor) !== '[REDACTED:connection-string]') {
          spans.push({ start: passwordStart, end: cursor })
        }
      }
      schemeStart = -1
      schemeHasValidStart = false
      continue
    }
    schemeStart = -1
    schemeHasValidStart = false
  }

  if (spans.length === 0) return { content: source, count: 0 }
  const chunks: string[] = []
  let cursor = 0
  for (const span of spans) {
    chunks.push(source.slice(cursor, span.start), '[REDACTED:connection-string]')
    cursor = span.end
  }
  chunks.push(source.slice(cursor))
  return { content: chunks.join(''), count: spans.length }
}

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
  const connections = redactConnectionCredentials(output)
  output = connections.content
  if (connections.count > 0) counts.set('connection-string', connections.count)
  const assignments = redactSecretAssignments(output)
  output = assignments.content
  if (assignments.count > 0) counts.set('secret-assignment', (counts.get('secret-assignment') ?? 0) + assignments.count)
  const matches = Array.from(counts, ([category, count]) => ({ category, count }))
  return { content: output, totalMatches: matches.reduce((sum, item) => sum + item.count, 0), matches }
}
