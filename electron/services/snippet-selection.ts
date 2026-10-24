import type { RoleFocus } from '../../shared/types'
import type { CodeSymbol, SourceAnalysis } from './source-analysis'

export interface SourceRegion {
  start: number
  end: number
  text: string
  label: string
  complete: boolean
  priority: number
}

export interface SnippetSelection {
  regions: SourceRegion[]
  truncated: boolean
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

function headAtCodePointBoundary(text: string, length: number): string {
  let clipped = text.slice(0, length)
  const last = clipped.charCodeAt(clipped.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1)
  return clipped
}

function tailAtCodePointBoundary(text: string, length: number): string {
  let clipped = length ? text.slice(-length) : ''
  const first = clipped.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) clipped = clipped.slice(1)
  return clipped
}

function symbolPriority(symbol: CodeSymbol, analysis: SourceAnalysis, referenced: ReadonlySet<string>, role?: RoleFocus): number {
  let score = 0
  if (symbol.exported) score += 30
  if (referenced.has(symbol.name)) score += 45
  if (symbol.kind === 'import' || symbol.kind === 'export') score += 75
  if (symbol.kind === 'interface' || symbol.kind === 'type') score += role === 'frontend' ? 20 : 14
  if (symbol.kind === 'class') score += 16
  if (symbol.kind === 'function' || symbol.kind === 'method') score += 18
  if (symbol.kind === 'statement') score -= 6
  const tail = analysis.symbols.indexOf(symbol) / Math.max(1, analysis.symbols.length - 1)
  score += Math.round(tail * 12) // Preserve useful definitions late in oversized files.
  if (role === 'backend' && /controller|service|repository|handler|route|api/i.test(symbol.name)) score += 12
  if (role === 'frontend' && /component|view|page|hook|render/i.test(symbol.name)) score += 12
  if (role === 'algorithm' && /sort|search|parse|compute|solve|algorithm|transform/i.test(symbol.name)) score += 12
  return score
}

function regionForSymbol(content: string, symbol: CodeSymbol, priority: number): SourceRegion | undefined {
  const start = clamp(symbol.start, 0, content.length)
  const end = clamp(symbol.end, start, content.length)
  if (end <= start) return undefined
  return { start, end, text: content.slice(start, end), label: symbol.name || symbol.kind, complete: true, priority }
}

const PYTHON_IDENT_CHAR = /[A-Za-z0-9_]/
// Each string opening leaves one `"` marker in the code projection. A body
// statement reduced to optional non-interpolating prefixes plus that marker is
// a plain string literal expression (docstring) and carries no logic; an
// f-prefix is excluded because f-string interpolation can execute calls.
const PYTHON_STRING_ONLY_STATEMENT = /^[rRbBuU]{0,3}"$/
const PYTHON_OVERLOAD_DECORATOR = /^@\s*(?:[A-Za-z_]\w*\.)?overload\b/

interface PythonDeclaration {
  index: number
  startLine: number
  indent: number
  name: string
  kind: string
  colonSeen: boolean
  // Hierarchy and stub metadata only feed candidate priority; region
  // boundaries and labels stay exactly as the conservative parser finds them.
  overload: boolean
  defDepth: number
  ownerClasses: string // File-local class declaration identities, not display names.
  parentSlot: number
  callees: Set<string> | undefined
  inlineStubBody: boolean
}

function pythonRegions(content: string, role?: RoleFocus, referenced: ReadonlySet<string> = new Set()): SourceRegion[] {
  // Deliberately conservative indentation parser. Track string delimiters so a
  // docstring's apparent `def`/`class` cannot become a fake declaration, plus
  // bracket depth and explicit backslash joins so a wrapped signature or a
  // low-indent closing bracket stays part of one logical statement. Region-end
  // decisions only trust the state at the START of a line, never the state
  // after that line's closing bracket. Decorators attach the same way: a block
  // of consecutive same-indent `@` statements (with multi-line calls) above a
  // def/class becomes the region start, and the sibling-end scan stops at the
  // first `@` line so a declaration never swallows the next one's decorators.
  //
  // The same single pass also collects bounded ranking metadata: a scope stack
  // gives every declaration its enclosing defs/classes, and the lexical
  // projection (strings/comments blanked) records self/cls member uses and
  // local-name calls attributed to the enclosing declaration. Pseudo calls in
  // docstrings or comments can never reach those counters because the lexer is
  // already inside the string or past the comment when it sees them.
  const lines = content.split(/(?<=\n)/)
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length }
  let quote: string | undefined
  let triple = false
  let depth = 0
  let continuation = false
  const statementStarts: boolean[] = []
  const lineCode: string[] = []
  const declarations: PythonDeclaration[] = []
  const scopes: Array<{ indent: number; name: string; kind: string; decl: PythonDeclaration; slot: number }> = []
  const memberUses = new Map<string, number>()
  let pendingHeader: PythonDeclaration | undefined
  let pendingDecor: { startLine: number; indent: number; overload: boolean } | undefined
  let inlineCapture: { decl: PythonDeclaration; parts: string[] } | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const stripped = line.trimStart()
    const beginsStatement = !quote && depth === 0 && !continuation
    statementStarts.push(beginsStatement)
    continuation = false
    let countsUsage = true
    if (beginsStatement) {
      // A new logical statement retires a header that never reached its colon.
      if (pendingHeader && i > pendingHeader.index) pendingHeader = undefined
      if (!stripped || stripped.startsWith('#')) {
        // Blank and comment-only lines neither break nor extend a decorator block.
      } else {
        // Every real logical statement line retires deeper scopes, mirroring
        // exactly how the region-end scan bounds a declaration: an ordinary
        // dedented `if`/assignment after a class body must not keep borrowing
        // that class as its owner. Blank and comment lines retire nothing.
        const indent = line.length - stripped.length
        while (scopes.length && scopes[scopes.length - 1].indent >= indent) scopes.pop()
        if (stripped.startsWith('@')) {
          countsUsage = false
          const overload = PYTHON_OVERLOAD_DECORATOR.test(stripped)
          if (!pendingDecor || pendingDecor.indent !== indent) pendingDecor = { startLine: i, indent, overload }
          else if (overload) pendingDecor.overload = true
        } else {
          const attached = pendingDecor
          pendingDecor = undefined
          const match = stripped.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\b/)
          if (match) {
            countsUsage = false
            const startLine = attached && attached.indent === indent ? attached.startLine : i
            const overload = Boolean(attached && attached.indent === indent && attached.overload)
            let defDepth = 0
            let parentSlot = -1
            const classChain: string[] = []
            for (const scope of scopes) {
              if (scope.kind === 'def') {
                defDepth += 1
                parentSlot = scope.slot
              } else classChain.push(String(scope.slot))
            }
            const slot = declarations.length
            pendingHeader = { index: i, startLine, indent, name: match[2], kind: match[1], colonSeen: false, overload, defDepth, ownerClasses: classChain.join('.'), parentSlot, callees: undefined, inlineStubBody: false }
            declarations.push(pendingHeader)
            scopes.push({ indent, name: match[2], kind: match[1], decl: pendingHeader, slot })
          }
        }
      }
    }
    // Attribute body statements to the innermost enclosing def and the full
    // lexical class identity chain so member-use and local-call counters stay
    // owner-aware: even repeated class names inside factories never share counts,
    // and a same-name method of another class can never borrow these signals.
    let lineDecl: PythonDeclaration | undefined
    let lineOwnerClasses = ''
    if (countsUsage) {
      const lineIndent = line.length - stripped.length
      const chain: string[] = []
      for (let s = 0; s < scopes.length; s++) {
        const scope = scopes[s]
        if (scope.indent >= lineIndent) continue
        if (scope.kind === 'class') chain.push(String(scope.slot))
        // Keep overwriting so the innermost enclosing def wins.
        else lineDecl = scope.decl
      }
      lineOwnerClasses = chain.join('.')
    }
    // Small lexer sufficient for Python single/triple quoted strings, escapes,
    // bracket nesting, comments, and backslash line joins. Identifier tokens
    // are flushed at their boundary character so `self.member`/`cls.member`
    // reads and `name(`/`self.name(` calls land in the bounded counters, and a
    // code-only projection of each line feeds the signature-only body check.
    let ident = ''
    let pendingDot = false
    let receiver = ''
    const codeParts: string[] = []
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (quote) {
        if (ch === '\\') { j++; continue }
        if (triple && line.slice(j, j + 3) === quote.repeat(3)) { quote = undefined; triple = false; j += 2 }
        else if (!triple && ch === quote) quote = undefined
      } else if (PYTHON_IDENT_CHAR.test(ch)) {
        ident += ch
        codeParts.push(ch)
        if (inlineCapture) inlineCapture.parts.push(ch)
      } else {
        if (ident) {
          if (pendingDot) {
            if ((receiver === 'self' || receiver === 'cls') && lineOwnerClasses) {
              const key = `${lineOwnerClasses}.${ident}`
              memberUses.set(key, (memberUses.get(key) ?? 0) + 1)
              if (countsUsage && ch === '(' && lineDecl) (lineDecl.callees ??= new Set<string>()).add(ident)
            }
            pendingDot = false
          } else if (countsUsage && ch === '(' && lineDecl) {
            (lineDecl.callees ??= new Set<string>()).add(ident)
          }
          receiver = ident
          ident = ''
        }
        if (ch === '"' || ch === "'") {
          triple = line.slice(j, j + 3) === ch.repeat(3)
          quote = ch
          if (triple) j += 2
          // One marker per string opening keeps the code projection honest:
          // `x = "a"` still shows an assignment while a docstring statement
          // reduces to prefixes plus the marker alone.
          codeParts.push('"')
        } else if (ch === '#') break
        else {
          if (inlineCapture) inlineCapture.parts.push(ch)
          codeParts.push(ch)
          if (ch === '.') pendingDot = true
          else if (ch === '(' || ch === '[' || ch === '{') depth += 1
          else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
          else if (ch === ':' && depth === 0 && pendingHeader && (i === pendingHeader.index || !beginsStatement)) {
            pendingHeader.colonSeen = true
            inlineCapture = { decl: pendingHeader, parts: [] }
            pendingHeader = undefined
          } else if (ch === '\\' && (j + 1 >= line.length || line[j + 1] === '\n' || line[j + 1] === '\r')) continuation = true
        }
      }
    }
    // An attribute read can end the line without a trailing boundary character.
    if (ident && pendingDot && (receiver === 'self' || receiver === 'cls') && lineOwnerClasses) {
      const key = `${lineOwnerClasses}.${ident}`
      memberUses.set(key, (memberUses.get(key) ?? 0) + 1)
    }
    lineCode.push(codeParts.join(''))
    // The inline body capture ends with its logical statement; `...`/`pass`
    // right after the header colon marks a signature-only declaration.
    if (inlineCapture && !(continuation || depth > 0)) {
      inlineCapture.decl.inlineStubBody = /^(?:\.\.\.|pass)$/.test(inlineCapture.parts.join('').trim())
      inlineCapture = undefined
    }
  }
  const fileEndsOpen = Boolean(quote) || depth > 0 || continuation
  const declaredNames = new Set(declarations.map((decl) => decl.name))
  // Score first, then structurally demote closures below their ancestor
  // function: a candidate nested inside another def can never outrank it, so a
  // fitting parent wins the overlap contest (ties resolve to the earlier
  // start, which is always the parent). Declarations are in source order, so
  // each parent's own clamped priority is already final when its children are
  // clamped, and an unaffordable parent still lets the nested fallback through
  // because the selection loop skips regions that do not fit.
  const priorities = declarations.map((decl, position) => {
    let endIndex = lines.length
    let stubMarkers = 0
    let realStatements = 0
    for (let i = decl.index + 1; i < lines.length; i++) {
      const text = lines[i].trim()
      if (!text || text.startsWith('#') || !statementStarts[i]) continue
      const indent = lines[i].length - lines[i].trimStart().length
      if (indent <= decl.indent) { endIndex = i; break }
      const code = (lineCode[i] ?? '').trim()
      if (!code || PYTHON_STRING_ONLY_STATEMENT.test(code)) continue
      if (code === '...' || code === 'pass') stubMarkers += 1
      else realStatements += 1
    }
    const signatureOnly = decl.colonSeen && realStatements === 0 && (decl.inlineStubBody || stubMarkers > 0)
    const tail = position / Math.max(1, declarations.length - 1)
    const roleBonus = role === 'backend' && /service|handler|route|api/i.test(decl.name) ? 12 : 0
    // Generic ranking by declaration shape and file-local usage: an @overload
    // or `...`/`pass` signature never outranks the real implementation of the
    // same member, and widely used public members plus methods coordinating
    // several local steps outrank unreferenced helpers regardless of position.
    let priority = 20 + Math.round(tail * 12) + roleBonus + (referenced.has(decl.name) ? 45 : 0)
    if (decl.overload || signatureOnly) priority -= 18
    if (decl.kind === 'def') {
      if (decl.defDepth > 0) priority -= 10 * decl.defDepth
      const uses = decl.ownerClasses && !decl.name.startsWith('_') ? memberUses.get(`${decl.ownerClasses}.${decl.name}`) ?? 0 : 0
      priority += uses >= 3 ? 12 : uses === 2 ? 8 : uses === 1 ? 4 : 0
      let localCallees = 0
      for (const callee of decl.callees ?? []) if (declaredNames.has(callee)) localCallees += 1
      priority += localCallees >= 4 ? 16 : localCallees === 3 ? 12 : localCallees === 2 ? 8 : localCallees === 1 ? 4 : 0
    }
    return { endIndex, signatureOnly, priority }
  })
  for (let position = 0; position < declarations.length; position++) {
    const parentSlot = declarations[position].parentSlot
    if (parentSlot >= 0) priorities[position].priority = Math.min(priorities[position].priority, priorities[parentSlot].priority)
  }
  return declarations.map((decl, position) => {
    const { endIndex, priority } = priorities[position]
    const start = offsets[decl.startLine]
    const end = offsets[endIndex] ?? content.length
    // Without a confirmed depth-0 colon (or with the file ending mid-logical-line)
    // the header cannot be trusted as a complete body.
    const complete = decl.colonSeen && !(endIndex === lines.length && fileEndsOpen)
    return { start, end, text: content.slice(start, end), label: decl.name, complete, priority }
  })
}

export function sourceRegionCandidates(
  content: string,
  analysis: SourceAnalysis | null,
  options: { roleFocus?: RoleFocus; referencedSymbols?: ReadonlySet<string>; extension?: string } = {}
): SourceRegion[] {
  const referenced = options.referencedSymbols ?? new Set<string>()
  let candidates: SourceRegion[]
  if (options.extension?.replace(/^\./, '').toLowerCase() === 'py') {
    candidates = pythonRegions(content, options.roleFocus, referenced)
  } else if (analysis?.parseable) {
    candidates = analysis.symbols
      .filter((symbol) => symbol.kind !== 'import' || /^import\b/.test(content.slice(symbol.start, symbol.end).trim()))
      .map((symbol) => regionForSymbol(content, symbol, symbolPriority(symbol, analysis, referenced, options.roleFocus)))
      .filter((region): region is SourceRegion => Boolean(region))
  } else {
    // Deterministic declaration blocks. The fallback makes no AST claim and
    // uses the next declaration boundary rather than slicing arbitrary lines.
    const lines = content.split(/(?<=\n)/)
    const offsets: number[] = []
    let cursor = 0
    for (const line of lines) { offsets.push(cursor); cursor += line.length }
    const starts: number[] = []
    for (let index = 0; index < lines.length; index++) {
      if (/^\S(?:.*\b(?:function|class|interface|type|enum|const|let|var|export|import|struct|fn|func|def|module)\b|\s*$)/.test(lines[index]) && lines[index].trim()) starts.push(index)
    }
    candidates = starts.map((lineIndex, position) => {
      const nextLine = starts[position + 1] ?? lines.length
      const start = offsets[lineIndex]
      const end = offsets[nextLine] ?? content.length
      return { start, end, text: content.slice(start, end), label: `heuristic-declaration-${lineIndex + 1}`, complete: false, priority: 10 + position / Math.max(1, starts.length - 1) * 15 }
    })
  }
  return candidates.sort((a, b) => b.priority - a.priority || a.start - b.start)
}

export function selectSourceRegions(
  content: string,
  analysis: SourceAnalysis | null,
  maxChars: number,
  options: { roleFocus?: RoleFocus; referencedSymbols?: ReadonlySet<string>; extension?: string } = {}
): SnippetSelection {
  const budget = Math.max(0, Math.floor(maxChars))
  if (content.length <= budget) return { regions: [{ start: 0, end: content.length, text: content, label: 'whole-file', complete: true, priority: 100 }], truncated: false }
  if (budget === 0) return { regions: [], truncated: content.length > 0 }
  const candidates = sourceRegionCandidates(content, analysis, options)
  const selected: SourceRegion[] = []
  let used = 0
  for (const region of candidates) {
    const cost = region.text.length + (selected.length ? 20 : 0)
    if (used + cost > budget) continue
    // Avoid spending all the budget in one neighborhood when alternatives exist.
    if (selected.some((item) => item.start < region.end && item.end > region.start)) continue
    selected.push(region)
    used += cost
  }
  selected.sort((a, b) => a.start - b.start)
  if (!selected.length && content.length) {
    const shortSignature = analysis?.symbols.find((symbol) => symbol.signatureEnd && symbol.signatureEnd - symbol.start <= maxChars)
    if (shortSignature?.signatureEnd) {
      const region = regionForSymbol(content.slice(0, shortSignature.signatureEnd), { ...shortSignature, end: shortSignature.signatureEnd }, 0)
      if (region) return { regions: [{ ...region, complete: false, label: `${region.label} (signature)` }], truncated: true }
    }
    // Keep one honest partial fragment with explicit omitted text marker.
    const fullMarker = '…（中间内容省略）…'
    const marker = fullMarker.length <= budget ? fullMarker : budget >= 1 ? '…' : ''
    const allowance = Math.max(0, budget - marker.length)
    const head = Math.ceil(allowance / 2)
    const tail = Math.floor(allowance / 2)
    const text = headAtCodePointBoundary(content, head) + marker + tailAtCodePointBoundary(content, tail)
    return { regions: [{ start: 0, end: content.length, text, label: 'partial-unit', complete: false, priority: 0 }], truncated: true }
  }
  return { regions: selected, truncated: true }
}
