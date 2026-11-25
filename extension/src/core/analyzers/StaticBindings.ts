import { Node, SyntaxKind } from 'ts-morph';

export function bindingOf(node: Node | undefined) {
  return node?.getSymbol()?.getDeclarations()[0];
}

export function importBinding(node: Node | undefined, allowType = false) {
  if (!node) return;
  const root = Node.isPropertyAccessExpression(node) ? node.getExpression() : node;
  const declaration = bindingOf(root);
  const imported = declaration?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (!imported || !allowType && (imported.isTypeOnly() || Node.isImportSpecifier(declaration) && declaration.isTypeOnly())) return;
  return {
    declaration: imported,
    module: imported.getModuleSpecifierValue(),
    name: Node.isImportSpecifier(declaration) ? declaration.getName() :
      Node.isPropertyAccessExpression(node) ? node.getName() : 'default'
  };
}

export function valueNode(node: Node | undefined, seen = new Set<Node>()): Node | undefined {
  if (!node || seen.has(node) || seen.size >= 12) return;
  seen.add(node);
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    const symbol = node.getSymbol();
    const declaration = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()
      .find(candidate => !candidate.getSourceFile().isDeclarationFile());
    return declaration && (Node.isVariableDeclaration(declaration) || Node.isFunctionDeclaration(declaration) ||
      Node.isClassDeclaration(declaration) || Node.isExportAssignment(declaration) ||
      Node.isPropertyAssignment(declaration) || Node.isMethodDeclaration(declaration))
      ? valueNode(declaration, seen) : node;
  }
  if (Node.isVariableDeclaration(node)) {
    return node.getVariableStatement()?.getDeclarationKind() === 'const' ? valueNode(node.getInitializer(), seen) : node;
  }
  if (Node.isPropertyAssignment(node)) return valueNode(node.getInitializer(), seen);
  if (Node.isExportAssignment(node) || Node.isParenthesizedExpression(node) || Node.isAsExpression(node) ||
      Node.isNonNullExpression(node) || Node.isSatisfiesExpression(node) || Node.isTypeAssertion(node) ||
      Node.isAwaitExpression(node)) return valueNode(node.getExpression(), seen);
  return node;
}

export function functionNode(node: Node | undefined) {
  const value = valueNode(node);
  return Node.isFunctionDeclaration(value) || Node.isArrowFunction(value) || Node.isFunctionExpression(value) ||
    Node.isMethodDeclaration(value) ? value : undefined;
}

export function returns(body: Node | undefined): Node[] {
  if (!body) return [];
  if (!Node.isBlock(body)) return [body];
  const result: Node[] = [];
  body.forEachDescendant((node, walk) => {
    if (Node.isFunctionLikeDeclaration(node)) walk.skip();
    else if (Node.isReturnStatement(node)) {
      const expression = node.getExpression();
      if (expression) result.push(expression);
    }
  });
  return result;
}
