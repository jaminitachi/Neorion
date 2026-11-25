import { ts } from 'ts-morph';

export function inspectChangeSource(file: string, text: string, scanComments: boolean) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const stars = new Set<string>();
  const binding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name);
  };
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) names.add('default');
    else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (!clause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) stars.add(statement.moduleSpecifier.text);
      else if (clause && ts.isNamespaceExport(clause)) names.add(clause.name.text);
      else if (clause) for (const specifier of clause.elements) names.add(specifier.name.text);
    } else if (ts.canHaveModifiers(statement)) {
      const modifiers = ts.getModifiers(statement) ?? [];
      if (!modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default');
      else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) binding(declaration.name);
      else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
        names.add((statement.name as ts.Identifier).text);
      }
    }
  }

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
  return { names, stars, code };
}
