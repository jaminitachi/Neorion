import { Node, SyntaxKind } from 'ts-morph';
import { importBinding } from './StaticBindings';

export type RenderEvidence = { conditions?: string[]; lists?: string[]; issue?: string };

function exits(node: Node): boolean {
  if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) return true;
  if (Node.isBlock(node)) return node.getStatements().some(exits);
  if (Node.isIfStatement(node)) {
    const otherwise = node.getElseStatement();
    return !!otherwise && exits(node.getThenStatement()) && exits(otherwise);
  }
  if (!Node.isExpressionStatement(node)) return false;
  const expression = node.getExpression();
  if (!Node.isCallExpression(expression)) return false;
  const origin = importBinding(expression.getExpression());
  return origin?.module === 'next/navigation' &&
    ['redirect', 'permanentRedirect', 'notFound', 'forbidden', 'unauthorized'].includes(origin.name);
}

export function renderEvidence(site: Node, boundary?: Node): RenderEvidence | undefined {
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
  for (let child = site, parent = child.getParent(); parent && child !== boundary; child = parent, parent = child.getParent()) {
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
        if (!Node.isIfStatement(statement)) {
          if (exits(statement)) issue ??= 'render after an unconditional exit';
          continue;
        }
        const yes = exits(statement.getThenStatement());
        const otherwise = statement.getElseStatement();
        const no = !!otherwise && exits(otherwise);
        if (yes && no) issue ??= 'render after an unconditional exit';
        else if (yes || no) when(statement.getExpression(), yes ? 'falsy' : 'truthy');
        else if (statement.getDescendantsOfKind(SyntaxKind.ReturnStatement).some(ret =>
          ret.getFirstAncestor(Node.isFunctionLikeDeclaration) === parent.getFirstAncestor(Node.isFunctionLikeDeclaration))) {
          issue ??= 'nested early returns in render guards untraced';
        }
      }
    } else if (Node.isArrowFunction(parent) || Node.isFunctionExpression(parent)) {
      const call = parent.getParent();
      const callee = Node.isCallExpression(call) && call.getArguments()[0] === parent ? call.getExpression() : undefined;
      if (Node.isPropertyAccessExpression(callee) && ['map', 'flatMap'].includes(callee.getName())) {
        lists.unshift(text(callee.getExpression()) + '.' + callee.getName() + '(...)');
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
