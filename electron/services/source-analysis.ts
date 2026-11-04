import ts from 'typescript'

export interface ImportReference {
  specifier: string
  importedNames: string[]
}
export interface CodeSymbol {
  name: string
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'import' | 'export' | 'statement'
  start: number
  end: number
  signatureEnd?: number
  parentName?: string
  parentStart?: number
  exported: boolean
}
export interface SourceCallReference {
  name: string
  callerStart: number
  receiver: 'identifier' | 'this' | 'constructor'
}
export interface SourceAnalysis {
  parseable: boolean
  imports: ImportReference[]
  symbols: CodeSymbol[]
  calls?: SourceCallReference[]
}

const SCRIPT_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'])

function addBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
  } else {
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingNames(element.name, names)
    }
  }
}

function functionBindings(node: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>()
  for (const parameter of node.parameters) addBindingNames(parameter.name, names)
  const visit = (child: ts.Node): void => {
    if (child !== node && (ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child) || ts.isArrowFunction(child))) {
      if (ts.isFunctionDeclaration(child) && child.name) names.add(child.name.text)
      return
    }
    if (ts.isVariableDeclaration(child)) addBindingNames(child.name, names)
    else if ((ts.isClassDeclaration(child) || ts.isFunctionDeclaration(child)) && child.name) names.add(child.name.text)
    else if (ts.isCatchClause(child) && child.variableDeclaration) addBindingNames(child.variableDeclaration.name, names)
    ts.forEachChild(child, visit)
  }
  if (node.body) visit(node.body)
  return names
}
const extension = (relPath: string): string => relPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
const named = (node: ts.Node): string | undefined => {
  const n = (node as ts.NamedDeclaration).name
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined
}
const isExported = (node: ts.Node): boolean => !!(
  ts.canHaveModifiers(node) &&
  ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)
)
const sigEnd = (node: ts.Node): number | undefined => {
  if (
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) || ts.isFunctionExpression(node)
  ) {
    const body = node.body
    return body ? body.getStart() : node.end
  }
  if (ts.isPropertyDeclaration(node) && node.initializer) return sigEnd(node.initializer)
  return undefined
}

export function analyzeSource(relPath: string, content: string): SourceAnalysis | null {
  const ext = extension(relPath)
  if (!SCRIPT_EXTENSIONS.has(ext)) return null
  const kind = ext === 'tsx' ? ts.ScriptKind.TSX : ext === 'jsx' ? ts.ScriptKind.JSX : ext === 'js' || ext === 'mjs' || ext === 'cjs' ? ts.ScriptKind.JS : ts.ScriptKind.TS
  let source: ts.SourceFile
  try {
    source = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, kind)
  } catch {
    return { parseable: false, imports: [], symbols: [] }
  }
  const imports: ImportReference[] = []
  const symbols: CodeSymbol[] = []
  const calls: SourceCallReference[] = []
  const ownerBindings = new Map<number, Set<string>>()
  const addImport = (spec: ts.Expression | undefined, names: string[]): void => {
    if (spec && ts.isStringLiteralLike(spec)) imports.push({ specifier: spec.text, importedNames: [...new Set(names)] })
  }
  const visit = (node: ts.Node, isTopLevel = false, owner?: CodeSymbol): void => {
    // `this` in a nested ordinary function has its own runtime receiver; do not
    // attribute its calls to the enclosing class method without type analysis.
    if (!isTopLevel && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) {
      ts.forEachChild(node, (child) => visit(child, false))
      return
    }
    if (ts.isImportDeclaration(node)) {
      const names: string[] = []
      const clause = node.importClause
      if (clause?.name) names.push('default')
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push('*')
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) names.push(...clause.namedBindings.elements.map((e) => e.propertyName?.text ?? e.name.text))
      addImport(node.moduleSpecifier, names)
    } else if (ts.isExportDeclaration(node)) {
      const importedNames = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text)
        : ['*']
      addImport(node.moduleSpecifier, importedNames)
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0]
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteralLike(arg)) addImport(arg, ['*'])
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && arg && ts.isStringLiteralLike(arg)) addImport(arg, ['*'])
      if (calls.length < 1024) {
        if (ts.isIdentifier(node.expression) && node.expression.text !== 'require') {
          if (owner && !ownerBindings.get(owner.start)?.has(node.expression.text)) calls.push({ name: node.expression.text, callerStart: owner.start, receiver: 'identifier' })
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          const receiver = node.expression.expression.kind === ts.SyntaxKind.ThisKeyword ? 'this' : undefined
          if (owner && receiver) calls.push({ name: node.expression.name.text, callerStart: owner.start, receiver })
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && calls.length < 1024) {
      if (owner && !ownerBindings.get(owner.start)?.has(node.expression.text)) {
        calls.push({ name: node.expression.text, callerStart: owner.start, receiver: 'constructor' })
      }
    }

    if (isTopLevel && (ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      const name = named(node) ?? '(anonymous class)'
      const classSymbol: CodeSymbol = { name, kind: 'class', start: node.getStart(source), end: node.end, signatureEnd: node.members[0]?.getStart(source) ?? node.end, exported: isExported(node) }
      symbols.push(classSymbol)
      for (const member of node.members) {
        let memberSymbol: CodeSymbol | undefined
        if (
          ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) ||
          (ts.isPropertyDeclaration(member) && !!member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)))
        ) {
          const memberName = ts.isConstructorDeclaration(member) ? 'constructor' : named(member) ?? '(computed method)'
          const signatureEnd = sigEnd(member)
          memberSymbol = { name: memberName, kind: 'method', start: member.getStart(source), end: member.end, signatureEnd, parentName: name, parentStart: classSymbol.start, exported: false }
          if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
            ownerBindings.set(memberSymbol.start, functionBindings(member))
          }
          symbols.push(memberSymbol)
        }
        visit(member, false, memberSymbol ?? classSymbol)
      }
      return
    } else if (isTopLevel && ts.isFunctionDeclaration(node)) {
      const functionSymbol: CodeSymbol = {
        name: named(node) ?? '(anonymous function)',
        kind: 'function',
        start: node.getStart(source),
        end: node.end,
        signatureEnd: sigEnd(node),
        exported: isExported(node)
      }
      symbols.push(functionSymbol)
      ownerBindings.set(functionSymbol.start, functionBindings(node))
      ts.forEachChild(node, (child) => visit(child, false, functionSymbol))
      return
    } else if (isTopLevel && ts.isInterfaceDeclaration(node)) {
      symbols.push({
        name: named(node) ?? '(interface)',
        kind: 'interface',
        start: node.getStart(source),
        end: node.end,
        signatureEnd: node.members[0]?.getStart(source) ?? node.end,
        exported: isExported(node)
      })
    } else if (isTopLevel && ts.isTypeAliasDeclaration(node)) {
      symbols.push({ name: named(node) ?? '(type)', kind: 'type', start: node.getStart(source), end: node.end, exported: isExported(node) })
    } else if (isTopLevel && ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const init = decl.initializer
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          symbols.push({ name: decl.name.text, kind: 'function', start: node.getStart(source), end: node.end, signatureEnd: sigEnd(init), exported: isExported(node) })
        } else {
          symbols.push({ name: decl.name.text, kind: 'variable', start: node.getStart(source), end: node.end, exported: isExported(node) })
        }
      }
    } else if (isTopLevel && ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.name) symbols.push({ name: clause.name.text, kind: 'import', start: node.getStart(source), end: node.end, exported: false })
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          symbols.push({ name: el.propertyName?.text ?? el.name.text, kind: 'import', start: node.getStart(source), end: node.end, exported: false })
        }
      }
    } else if (isTopLevel && ts.isExportAssignment(node)) {
      symbols.push({ name: 'default', kind: 'export', start: node.getStart(source), end: node.end, exported: true })
    } else if (isTopLevel && ts.isExportDeclaration(node)) {
      const exportedNames = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text)
        : node.exportClause && ts.isNamespaceExport(node.exportClause)
          ? [node.exportClause.name.text]
          : ['*']
      for (const name of exportedNames) {
        symbols.push({ name, kind: 'export', start: node.getStart(source), end: node.end, exported: true })
      }
    }
    if (ts.isSourceFile(node)) {
      node.statements.forEach((statement) => visit(statement, true))
      return
    }
    ts.forEachChild(node, (child) => visit(child, false, owner))
  }
  try { visit(source) } catch { return { parseable: false, imports: [], symbols: [] } }
  return { parseable: (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length === 0, imports, symbols, calls }
}
