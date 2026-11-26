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
    if (Node.isFunctionLikeDeclaration(node) || Node.isFunctionExpression(node)) walk.skip();
    else if (Node.isReturnStatement(node)) {
      const expression = node.getExpression();
      if (expression) result.push(expression);
    }
  });
  return result;
}

// Walk the current invocation. Nested function bodies run only when their
// callers explicitly follow them.
export function executionSites(body: Node | undefined, followGuardedCalls = false) {
  const calls: { node: import('ts-morph').CallExpression; possible: boolean }[] = [];
  const returned: { node: Node; possible: boolean }[] = [];
  const truth = (node: Node) => {
    const value = valueNode(node);
    if (Node.isTrueLiteral(value)) return true;
    if (Node.isFalseLiteral(value) || Node.isNullLiteral(value)) return false;
    if (Node.isNumericLiteral(value) || Node.isStringLiteral(value)) return Boolean(value.getLiteralValue());
  };
  // A path may either continue or leave the current block.
  const next = 1;
  const exit = 2;
  const visit = (node: Node, possible: boolean): number => {
    if (Node.isFunctionLikeDeclaration(node) || Node.isClassDeclaration(node) || Node.isClassExpression(node)) return next;
    if (Node.isBlock(node)) {
      let flow = next;
      for (const statement of node.getStatements()) {
        if (!(flow & next)) break;
        flow = (flow & exit) | visit(statement, possible || !followGuardedCalls && !!(flow & exit));
      }
      return flow;
    }
    if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) {
      const expression = node.getExpression();
      if (expression) visit(expression, possible);
      if (expression && Node.isReturnStatement(node)) returned.push({ node: expression, possible });
      return exit;
    }
    if (Node.isIfStatement(node) || Node.isConditionalExpression(node)) {
      const condition = Node.isIfStatement(node) ? node.getExpression() : node.getCondition();
      const yes = Node.isIfStatement(node) ? node.getThenStatement() : node.getWhenTrue();
      const no = Node.isIfStatement(node) ? node.getElseStatement() : node.getWhenFalse();
      visit(condition, possible);
      const choice = truth(condition);
      const whenTrue = choice === false ? 0 : visit(yes, possible || choice === undefined);
      const whenFalse = choice === true ? 0 : no ? visit(no, possible || choice === undefined) : next;
      return whenTrue | whenFalse;
    }
    if (Node.isBinaryExpression(node)) {
      const left = node.getLeft();
      const right = node.getRight();
      const operator = node.getOperatorToken().getKind();
      if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.BarBarToken ||
        operator === SyntaxKind.QuestionQuestionToken) {
        visit(left, possible);
        const value = valueNode(left);
        const choice = operator === SyntaxKind.QuestionQuestionToken ?
          Node.isNullLiteral(value) ? true : undefined : truth(left);
        if (choice === undefined || choice === (operator !== SyntaxKind.BarBarToken)) visit(right, possible || choice === undefined);
        return next;
      }
    }
    if (followGuardedCalls && Node.isTryStatement(node)) {
      const body = visit(node.getTryBlock(), possible);
      const handler = node.getCatchClause();
      const caught = handler ? visit(handler.getBlock(), true) : 0;
      const last = node.getFinallyBlock();
      const flow = body | caught;
      if (!last) return flow;
      const final = visit(last, possible);
      return (final & exit) | (final & next ? flow : 0);
    }
    if (Node.isCallExpression(node)) calls.push({ node, possible });
    // Loops, switches and exception handlers require runtime state to resolve.
    const conditional = Node.isIterationStatement(node) || Node.isCaseClause(node) || Node.isDefaultClause(node) ||
      Node.isCatchClause(node) || Node.isTryStatement(node);
    node.forEachChild(child => { visit(child, possible || conditional); });
    return next;
  };
  if (body) {
    visit(body, false);
    if (!Node.isBlock(body)) returned.push({ node: body, possible: false });
  }
  return { calls, returned };
}
