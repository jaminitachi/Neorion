import { ts } from 'ts-morph';

export function inspectChangeSource(file: string, text: string, scanComments: boolean) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const stars = new Set<string>();
  const binding = (name: ts.BindingName, exports: Set<string>) => {
    if (ts.isIdentifier(name)) exports.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name, exports);
  };
  const lineAt = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  const statements = source.statements.map(statement => {
    const exports = new Set<string>();
    let star: string | undefined;
    if (ts.isExportAssignment(statement)) exports.add('default');
    else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (!clause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) star = statement.moduleSpecifier.text;
      else if (clause && ts.isNamespaceExport(clause)) exports.add(clause.name.text);
      else if (clause) for (const specifier of clause.elements) exports.add(specifier.name.text);
    } else if (ts.canHaveModifiers(statement)) {
      const modifiers = ts.getModifiers(statement) ?? [];
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) exports.add('default');
        else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) binding(declaration.name, exports);
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
  return { names, stars, code, statements };
}
