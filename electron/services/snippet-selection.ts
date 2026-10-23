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

function pythonRegions(content: string, role?: RoleFocus, referenced: ReadonlySet<string> = new Set()): SourceRegion[] {
  // Deliberately conservative indentation parser. Track string delimiters so a
  // docstring's apparent `def`/`class` cannot become a fake declaration.
  const lines = content.split(/(?<=\n)/)
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length }
  let quote: string | undefined
  let triple = false
  const codeLine: boolean[] = []
  const declarations: Array<{ index: number; indent: number; name: string; kind: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const stripped = line.trimStart()
    const beginsInsideString = Boolean(quote)
    if (!quote) {
      const match = stripped.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\b/)
      if (match) declarations.push({ index: i, indent: line.length - stripped.length, name: match[2], kind: match[1] })
    }
    // Small lexer sufficient for Python single/triple quoted strings and escapes.
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (quote) {
        if (ch === '\\') { j++; continue }
        if (triple && line.slice(j, j + 3) === quote.repeat(3)) { quote = undefined; triple = false; j += 2 }
        else if (!triple && ch === quote) quote = undefined
      } else if (ch === '"' || ch === "'") {
        triple = line.slice(j, j + 3) === ch.repeat(3)
        quote = ch
        if (triple) j += 2
      } else if (ch === '#') break
    }
    codeLine.push(!beginsInsideString && (!quote || !triple))
  }
  return declarations.map((decl, position) => {
    let endIndex = lines.length
    for (let i = decl.index + 1; i < lines.length; i++) {
      const text = lines[i].trim()
      if (!text || text.startsWith('#') || !codeLine[i]) continue
      const indent = lines[i].length - lines[i].trimStart().length
      if (indent <= decl.indent) { endIndex = i; break }
    }
    const start = offsets[decl.index]
    const end = offsets[endIndex] ?? content.length
    const tail = position / Math.max(1, declarations.length - 1)
    const roleBonus = role === 'backend' && /service|handler|route|api/i.test(decl.name) ? 12 : 0
    return { start, end, text: content.slice(start, end), label: decl.name, complete: true, priority: 20 + Math.round(tail * 12) + roleBonus + (referenced.has(decl.name) ? 45 : 0) }
  })
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
  const referenced = options.referencedSymbols ?? new Set<string>()
  let candidates: SourceRegion[]
  if (options.extension?.toLowerCase() === '.py') {
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

  candidates.sort((a, b) => b.priority - a.priority || a.start - b.start)
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
