import { ts } from 'ts-morph';

export function middlewareMatcher(source: ts.SourceFile) {
  let config: ts.Expression | undefined;
  for (const statement of source.statements) {
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      let target = statement.expression.left;
      while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression;
      if (ts.isIdentifier(target) && (target.text === 'exports' || target.text === 'module')) return;
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (!clause || (ts.isNamespaceExport(clause) ? clause.name.text === 'config' :
        clause.elements.some(binding => !binding.isTypeOnly && binding.name.text === 'config'))) return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          const bindings = new Set<string>();
          collectBindings(declaration.name, bindings);
          if (bindings.has('config')) return;
        } else if (declaration.name.text === 'config') {
          if (config || !declaration.initializer) return;
          config = declaration.initializer;
        }
      }
    } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node) &&
        (statement.name as ts.Identifier).text === 'config' && !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) && ts.canHaveModifiers(statement)) {
      const modifiers = ts.getModifiers(statement);
      if (modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
          !modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return;
    }
  }
  if (!config) return { values: [], label: undefined };
  if (!ts.isObjectLiteralExpression(config)) return;
  let matcher: ts.Expression | undefined;
  for (const member of config.properties) {
    if (ts.isSpreadAssignment(member) || ts.isComputedPropertyName(member.name)) return;
    if ((ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === 'matcher') {
      if (!ts.isPropertyAssignment(member) || matcher) return;
      matcher = member.initializer;
    }
  }
  const entries: readonly ts.Expression[] = matcher && ts.isArrayLiteralExpression(matcher) ? matcher.elements :
    matcher ? [matcher] : [];
  if (!entries.every(ts.isStringLiteral)) return;
  return { values: entries.map(entry => entry.text), label: entries.map(entry => entry.getText(source)).join(', ') || undefined };
}

function collectBindings(name: ts.BindingName, exports: Set<string>) {
  if (ts.isIdentifier(name)) exports.add(name.text);
  else for (const element of name.elements) if (ts.isBindingElement(element)) collectBindings(element.name, exports);
}

export function inspectChangeSource(file: string, text: string, scanComments: boolean, middleware = false) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const aliases = new Set<string>();
  const stars = new Set<string>();
  const moduleSpecifiers = new Map<number, string>();
  const lineAt = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  const statements = source.statements.map(statement => {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      moduleSpecifiers.set(lineAt(statement.getStart(source)), statement.moduleSpecifier.text);
    }
    const exports = new Set<string>();
    let star: string | undefined;
    if (ts.isExportAssignment(statement)) exports.add('default');
    else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (!clause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) star = statement.moduleSpecifier.text;
      else if (clause && ts.isNamespaceExport(clause)) exports.add(clause.name.text);
      else if (clause) for (const specifier of clause.elements) if (!specifier.isTypeOnly) exports.add(specifier.name.text);
      for (const name of exports) aliases.add(name);
    } else if (ts.canHaveModifiers(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
      const modifiers = ts.getModifiers(statement) ?? [];
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
          !modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
        if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) exports.add('default');
        else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) collectBindings(declaration.name, exports);
        } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
          exports.add((statement.name as ts.Identifier).text);
        }
      }
    }
    for (const name of exports) names.add(name);
    if (star !== undefined) stars.add(star);
    return { start: lineAt(statement.getStart(source)), end: lineAt(statement.end - 1), exports, star };
  });

  const code = new Set<number>();
  if (scanComments) {
    // The parser keeps template literal and JSX text tokens intact, including
    // lines that look like comments or whitespace.
    const visit = (node: ts.Node) => {
      if (node.kind === ts.SyntaxKind.JSDoc) return;
      const children = node.getChildren(source);
      if (children.length) children.forEach(visit);
      else if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.kind !== ts.SyntaxKind.SyntaxList && node.end > node.getStart(source)) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const end = source.getLineAndCharacterOfPosition(node.end - 1).line;
        for (let line = start; line <= end; line++) code.add(line + 1);
      }
    };
    visit(source);
  }
  return { names, aliases, stars, code, statements, moduleSpecifiers, matcher: middleware ? middlewareMatcher(source)?.values : undefined };
}
