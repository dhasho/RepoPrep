import ts from 'typescript'

export interface ImportReference { specifier: string; importedNames: string[] }
export interface CodeSymbol {
  name: string
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'import' | 'export' | 'statement'
  start: number
  end: number
  signatureEnd?: number
  parentName?: string
  exported: boolean
}
export interface SourceAnalysis { parseable: boolean; imports: ImportReference[]; symbols: CodeSymbol[] }

const SCRIPT_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'])
const extension = (relPath: string): string => relPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
const named = (node: ts.Node): string | undefined => {
  const n = (node as ts.NamedDeclaration).name
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined
}
const isExported = (node: ts.Node): boolean => !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword))
const sigEnd = (node: ts.Node): number | undefined => {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const body = node.body
    return body ? body.getStart() : node.end
  }
  return undefined
}

export function analyzeSource(relPath: string, content: string): SourceAnalysis | null {
  const ext = extension(relPath)
  if (!SCRIPT_EXTENSIONS.has(ext)) return null
  const kind = ext === 'tsx' ? ts.ScriptKind.TSX : ext === 'jsx' ? ts.ScriptKind.JSX : ext === 'js' || ext === 'mjs' || ext === 'cjs' ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, kind)
  const imports: ImportReference[] = []
  const symbols: CodeSymbol[] = []
  const addImport = (spec: ts.Expression | undefined, names: string[]): void => {
    if (spec && ts.isStringLiteralLike(spec)) imports.push({ specifier: spec.text, importedNames: [...new Set(names)] })
  }
  const visit = (node: ts.Node, parentName?: string): void => {
    if (ts.isImportDeclaration(node)) {
      const names: string[] = []
      const clause = node.importClause
      if (clause?.name) names.push('default')
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push('*')
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) names.push(...clause.namedBindings.elements.map((e) => e.propertyName?.text ?? e.name.text))
      addImport(node.moduleSpecifier, names)
    } else if (ts.isExportDeclaration(node)) {
      addImport(node.moduleSpecifier, node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map((e) => e.propertyName?.text ?? e.name.text) : ['*'])
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0]
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteralLike(arg)) addImport(arg, ['*'])
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && arg && ts.isStringLiteralLike(arg)) addImport(arg, ['*'])
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = named(node) ?? '(anonymous class)'
      symbols.push({ name, kind: 'class', start: node.getStart(source), end: node.end, signatureEnd: node.members[0]?.getStart(source) ?? node.end, exported: isExported(node) })
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          symbols.push({ name: ts.isConstructorDeclaration(member) ? 'constructor' : named(member) ?? '(computed method)', kind: 'method', start: member.getStart(source), end: member.end, signatureEnd: sigEnd(member), parentName: name, exported: false })
        }
      }
    } else if (ts.isFunctionDeclaration(node)) {
      symbols.push({ name: named(node) ?? '(anonymous function)', kind: 'function', start: node.getStart(source), end: node.end, signatureEnd: sigEnd(node), exported: isExported(node) })
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push({ name: named(node) ?? '(interface)', kind: 'interface', start: node.getStart(source), end: node.end, signatureEnd: node.members[0]?.getStart(source) ?? node.end, exported: isExported(node) })
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({ name: named(node) ?? '(type)', kind: 'type', start: node.getStart(source), end: node.end, exported: isExported(node) })
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const init = decl.initializer
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          symbols.push({ name: decl.name.text, kind: 'function', start: node.getStart(source), end: node.end, signatureEnd: sigEnd(init), exported: isExported(node) })
        } else {
          symbols.push({ name: decl.name.text, kind: 'variable', start: node.getStart(source), end: node.end, exported: isExported(node) })
        }
      }
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.name) symbols.push({ name: clause.name.text, kind: 'import', start: node.getStart(source), end: node.end, exported: false })
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) symbols.push({ name: el.name.text, kind: 'import', start: el.getStart(source), end: el.end, exported: false })
    } else if (ts.isExportAssignment(node)) {
      symbols.push({ name: 'default', kind: 'export', start: node.getStart(source), end: node.end, exported: true })
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) symbols.push({ name: element.propertyName?.text ?? element.name.text, kind: 'export', start: element.getStart(source), end: element.end, exported: true })
    }
    ts.forEachChild(node, (child) => visit(child, parentName))
  }
  try { visit(source) } catch { return { parseable: false, imports: [], symbols: [] } }
  return { parseable: (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length === 0, imports, symbols }
}
