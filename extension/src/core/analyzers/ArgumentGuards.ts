import { Node, SyntaxKind, ts, type CallExpression } from 'ts-morph';
import type { BooleanArguments } from '../../mcp/Index';
import { wrappedExpression } from './ArchitectureFacts';
import type { FunctionNode } from './CallableFlow';
import type { CallableWrites } from './CallableWrites';
import { constValue } from './PropFlow';

function booleanValue(node: Node | undefined, declarations: (node: Node) => Node[], budget = 4): boolean | undefined {
  if (!node || !budget) return;
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) return Node.isTrueLiteral(node);
  const wrapped = wrappedExpression(node);
  if (wrapped) return booleanValue(wrapped, declarations, budget - 1);
  if (Node.isIdentifier(node)) {
    const [binding] = declarations(node);
    return binding && booleanValue(constValue(binding), declarations, budget - 1);
  }
}

export function booleanArguments(call: CallExpression, fn: FunctionNode | undefined, declarations: (node: Node) => Node[]) {
  if (!fn) return;
  const args = call.getArguments();
  const result: BooleanArguments = [];
  for (const [index, parameter] of fn.getParameters().entries()) {
    const arg = args[index];
    if (Node.isSpreadElement(arg)) break;
    const value = booleanValue(arg ?? parameter.getInitializer(), declarations);
    if (value !== undefined) result.push([index, value]);
  }
  return result.length ? result : undefined;
}

export function argumentGuards(site: Node, fn: FunctionNode | undefined, declarations: (node: Node) => Node[], writes: CallableWrites) {
  if (!fn || !fn.compilerNode.parameters.some(parameter => ts.isIdentifier(parameter.name))) return;
  const constraints = new Map<number, boolean>();
  const add = (condition: Node, required: boolean): void => {
    const wrapped = wrappedExpression(condition);
    if (wrapped) return add(wrapped, required);
    if (Node.isPrefixUnaryExpression(condition) && condition.getOperatorToken() === SyntaxKind.ExclamationToken) {
      return add(condition.getOperand(), !required);
    }
    if (Node.isBinaryExpression(condition)) {
      const op = condition.getOperatorToken().getKind();
      const left = condition.getLeft();
      const right = condition.getRight();
      if (op === SyntaxKind.AmpersandAmpersandToken && required || op === SyntaxKind.BarBarToken && !required) {
        add(left, required);
        add(right, required);
      } else if (op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsEqualsToken) {
        const leftValue = booleanValue(left, declarations);
        const rightValue = booleanValue(right, declarations);
        const expected = required === (op === SyntaxKind.EqualsEqualsEqualsToken);
        if (leftValue !== undefined) add(right, leftValue === expected);
        else if (rightValue !== undefined) add(left, rightValue === expected);
      }
      return;
    }
    if (!Node.isIdentifier(condition)) return;
    const [parameter] = declarations(condition);
    if (!Node.isParameterDeclaration(parameter) || parameter.getParent() !== fn || parameter.isRestParameter() ||
        writes.forBinding(parameter, [])) return;
    constraints.set(fn.getParameters().indexOf(parameter), required);
  };

  let ancestors: Node[] | undefined;
  for (let child = site.compilerNode, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (parent === fn.compilerNode) return constraints.size ? [...constraints].sort((a, b) => a[0] - b[0]) : undefined;
    if (ts.isFunctionLike(parent)) return;
    if (ts.isIfStatement(parent) && child !== parent.expression || ts.isConditionalExpression(parent) && child !== parent.condition) {
      const branch = (ancestors ??= site.getAncestors()).find(node => node.compilerNode === parent);
      if (Node.isIfStatement(branch)) add(branch.getExpression(), child === branch.getThenStatement().compilerNode);
      else if (Node.isConditionalExpression(branch)) add(branch.getCondition(), child === branch.getWhenTrue().compilerNode);
    }
    if (ts.isBinaryExpression(parent) && child === parent.right) {
      const op = parent.operatorToken.kind;
      if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) {
        const branch = (ancestors ??= site.getAncestors()).find(node => node.compilerNode === parent);
        if (Node.isBinaryExpression(branch)) add(branch.getLeft(), op === SyntaxKind.AmpersandAmpersandToken);
      }
    }
  }
}
