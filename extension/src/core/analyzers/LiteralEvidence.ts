import { Node, SyntaxKind } from 'ts-morph';
import { wrappedExpression } from './ArchitectureFacts';
import { valueNode } from './StaticBindings';

const sensitive = /secret|password|token|authorization|credential|private.?key|api.?key/i;

function literal(node: Node | undefined, depth: number, named = false): string | undefined {
  if (!node || depth > 2) return;
  const inner = wrappedExpression(node);
  if (inner) return literal(inner, depth, named);
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node) || Node.isNullLiteral(node) || Node.isNumericLiteral(node)) {
    return node.getText();
  }
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken &&
      Node.isNumericLiteral(node.getOperand())) return node.getText();
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    if (!named) return '[redacted string]';
    const value = node.getLiteralText();
    if (value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value)) return JSON.stringify(value);
    return;
  }
  if (Node.isIdentifier(node)) {
    const value = valueNode(node);
    // Only follow primitive const bindings. A referenced object can be mutated.
    if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value) || Node.isNumericLiteral(value) ||
        Node.isTrueLiteral(value) || Node.isFalseLiteral(value) || Node.isNullLiteral(value)) return literal(value, depth, named);
    return;
  }
  if (Node.isConditionalExpression(node)) {
    const condition = node.getCondition().getText().replace(/\s+/g, ' ');
    const yes = literal(node.getWhenTrue(), depth + 1, named);
    const no = literal(node.getWhenFalse(), depth + 1, named);
    if (yes && no && /^!?[$\w.]{1,48}$/.test(condition) && !sensitive.test(condition)) return `${condition} ? ${yes} : ${no}`;
    return;
  }
  if (Node.isArrayLiteralExpression(node)) {
    return summarize(node.getElements(), depth + 1, '[', ']');
  }
  if (!Node.isObjectLiteralExpression(node)) return;
  const fields: string[] = [];
  const parameters: string[] = [];
  let incomplete = false;
  const seen = new Set<string>();
  for (const field of [...node.getProperties()].reverse()) {
    if (Node.isSpreadAssignment(field) || Node.isComputedPropertyName(field.getNameNode())) {
      // Earlier fields can be overridden by an unknown key.
      incomplete = true;
      break;
    }
    const key = field.getName();
    if (seen.has(key)) continue;
    seen.add(key);
    if (Node.isShorthandPropertyAssignment(field) && !sensitive.test(key) && parameters.length < 2 &&
        field.getValueSymbol()?.getDeclarations().some(Node.isParameterDeclaration)) {
      parameters.unshift(key + ' (parameter)');
      continue;
    }
    const value = !sensitive.test(key) && Node.isPropertyAssignment(field) ? literal(field.getInitializer(), depth + 1, true) : undefined;
    if (!value || !/^[$\w-]{1,40}$/.test(key) || fields.length >= 4) {
      incomplete = true;
      continue;
    }
    fields.unshift(key + ': ' + value);
  }
  return fields.length ? '{' + [...fields, ...parameters].join(', ') + (incomplete ? ', …}' : '}') : undefined;
}

function summarize(nodes: Node[], depth: number, start: string, end: string) {
  const items = nodes.slice(0, 4).map(node => literal(node, depth));
  if (items.some(Boolean)) return start + items.map(item => item ?? '…').join(', ') + (nodes.length > items.length ? ', …' : '') + end;
}

export function literalArgs(call: import('ts-morph').CallExpression) {
  const result = summarize(call.getArguments(), 0, '', '');
  if (result && result.length <= 180) return result;
}

export function literalReturn(node: Node) {
  const value = literal(node, 0);
  if (value && value.length <= 160) return value;
}
