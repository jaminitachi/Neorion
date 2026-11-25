import { Node, SyntaxKind } from 'ts-morph';
import { importBinding } from './StaticBindings';

export type RenderEvidence = { conditions?: string[]; lists?: string[]; issue?: string };

function directExit(node: Node) {
  if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) return true;
  if (!Node.isExpressionStatement(node)) return false;
  const expression = node.getExpression();
  if (!Node.isCallExpression(expression)) return false;
  const origin = importBinding(expression.getExpression());
  return origin?.module === 'next/navigation' &&
    ['redirect', 'permanentRedirect', 'notFound', 'forbidden', 'unauthorized'].includes(origin.name);
}

function exits(node: Node): boolean {
  if (Node.isBlock(node)) return node.getStatements().some(exits);
  if (Node.isIfStatement(node)) {
    const otherwise = node.getElseStatement();
    return !!otherwise && exits(node.getThenStatement()) && exits(otherwise);
  }
  return directExit(node);
}

function hasNestedExit(node: Node): boolean {
  let found = false;
  node.forEachDescendant((child, traversal) => {
    if (Node.isFunctionLikeDeclaration(child)) traversal.skip();
    else if (directExit(child)) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

function listReceiver(node: Node): string {
  if (Node.isCallExpression(node)) return listReceiver(node.getExpression()) + '(...)';
  if (Node.isPropertyAccessExpression(node)) return listReceiver(node.getExpression()) + '.' + node.getName();
  if (Node.isIdentifier(node) || Node.isThisExpression(node)) return node.getText();
  if (Node.isParenthesizedExpression(node)) return '(' + listReceiver(node.getExpression()) + ')';
  return '…';
}

export function renderEvidence(site: Node): RenderEvidence | undefined {
  const conditions: string[] = [];
  const lists: string[] = [];
  let issue: string | undefined;
  const text = (node: Node) => {
    const value = node.getText().replace(/\s+/g, ' ');
    if (value.length <= 120) return value;
    issue ??= 'render guard expression shortened';
    return value.slice(0, 117) + '...';
  };
  const when = (node: Node, sense: 'truthy' | 'falsy' | 'nullish' = 'truthy') => {
    if (conditions.length >= 12) {
      issue ??= 'render guard limit';
      return;
    }
    if (sense === 'falsy' && Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.ExclamationToken) {
      conditions.unshift(text(node.getOperand()));
      return;
    }
    const value = text(node);
    conditions.unshift(sense === 'truthy' ? value : sense === 'falsy' ? `!(${value})` : `(${value}) is nullish`);
  };
  const preceding = (statement: Node) => {
    if (exits(statement)) {
      issue ??= 'render after an unconditional exit';
    } else if (Node.isIfStatement(statement)) {
      const yes = statement.getThenStatement();
      const no = statement.getElseStatement();
      if (exits(yes)) {
        if (no) preceding(no);
        when(statement.getExpression(), 'falsy');
      } else if (no && exits(no)) {
        when(statement.getExpression());
        if (hasNestedExit(yes)) issue ??= 'nested early exits in render guards untraced';
      } else if (hasNestedExit(statement)) {
        issue ??= 'nested early exits in render guards untraced';
      }
    } else if ((Node.isSwitchStatement(statement) || Node.isIterationStatement(statement) || Node.isTryStatement(statement) ||
        Node.isBlock(statement) || Node.isLabeledStatement(statement)) && hasNestedExit(statement)) {
      issue ??= 'preceding switch, exception or loop exits untraced';
    }
  };
  for (let child = site, parent = child.getParent(); parent; child = parent, parent = child.getParent()) {
    if (Node.isIfStatement(parent) && child !== parent.getExpression()) {
      when(parent.getExpression(), child === parent.getThenStatement() ? 'truthy' : 'falsy');
    } else if (Node.isConditionalExpression(parent) && child !== parent.getCondition()) {
      when(parent.getCondition(), child === parent.getWhenTrue() ? 'truthy' : 'falsy');
    } else if (Node.isBinaryExpression(parent) && child === parent.getRight()) {
      const operator = parent.getOperatorToken().getKind();
      if (operator === SyntaxKind.AmpersandAmpersandToken) when(parent.getLeft());
      if (operator === SyntaxKind.BarBarToken) when(parent.getLeft(), 'falsy');
      if (operator === SyntaxKind.QuestionQuestionToken) when(parent.getLeft(), 'nullish');
    } else if (Node.isBlock(parent)) {
      for (const statement of [...parent.getStatements()].reverse()) {
        if (statement.getPos() >= child.getPos()) continue;
        preceding(statement);
      }
    } else if (Node.isArrowFunction(parent) || Node.isFunctionExpression(parent)) {
      const call = parent.getParent();
      const callee = Node.isCallExpression(call) && call.getArguments()[0] === parent ? call.getExpression() : undefined;
      if (Node.isPropertyAccessExpression(callee) && ['map', 'flatMap'].includes(callee.getName())) {
        const receiver = listReceiver(callee.getExpression());
        lists.unshift((receiver.length > 64 ? receiver.slice(0, 63) + '…' : receiver) + '.' + callee.getName() + '(...)');
      } else if (Node.isCallExpression(call)) issue ??= 'render callback invocation untraced';
      else break;
    } else if (Node.isFunctionLikeDeclaration(parent)) break;
    else if (Node.isCaseClause(parent) || Node.isDefaultClause(parent) || Node.isTryStatement(parent) ||
             Node.isIterationStatement(parent)) issue ??= 'switch, exception or loop conditions untraced';
  }
  if (conditions.length || lists.length || issue) {
    return { conditions: conditions.length ? conditions : undefined, lists: lists.length ? lists : undefined, issue };
  }
}
