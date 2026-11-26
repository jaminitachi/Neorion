import { Node, SyntaxKind } from 'ts-morph';
import { wrappedExpression } from './ArchitectureFacts';
import { constValue } from './PropFlow';

export function unwrapFact(node: Node | undefined) {
  while (node) {
    const inner = wrappedExpression(node);
    if (!inner) break;
    node = inner;
  }
  return node;
}

// Preserve literal string values in a one-line representation.
export function expressionLabel(node: Node | undefined): string {
  if (!node) return '<missing>';
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return JSON.stringify(node.getLiteralText());
  return node.getText().replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
}

export function literalLabel(node: Node | undefined, depth = 4): string | undefined {
  node = unwrapFact(node);
  if (!node || !depth) return;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isNumericLiteral(node) ||
      Node.isTrueLiteral(node) || Node.isFalseLiteral(node) || Node.isNullLiteral(node)) return expressionLabel(node);
  if (Node.isPrefixUnaryExpression(node) && Node.isNumericLiteral(node.getOperand()) &&
      [SyntaxKind.PlusToken, SyntaxKind.MinusToken].includes(node.getOperatorToken())) return expressionLabel(node);
  if (Node.isArrayLiteralExpression(node)) {
    const elements = node.getElements().map(element => literalLabel(element, depth - 1));
    if (elements.every(element => element !== undefined)) return '[' + elements.join(', ') + ']';
  }
  if (Node.isObjectLiteralExpression(node)) {
    const properties = objectFields(node);
    if (!properties || properties.opaque) return;
    const fields = properties.fields.map(({ key, value }) => [key, literalLabel(value, depth - 1)]);
    if (fields.every(([, value]) => value !== undefined)) return '{ ' + fields.map(([key, value]) => key + ': ' + value).join(', ') + ' }';
  }
}

export function objectFields(node: Node | undefined) {
  node = unwrapFact(node);
  if (!Node.isObjectLiteralExpression(node)) return;
  const fields: { key: string; value: Node | undefined }[] = [];
  let opaque = false;
  for (const prop of node.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop)) {
      opaque = true;
      continue;
    }
    const name = prop.getNameNode();
    if (!Node.isIdentifier(name) && !Node.isStringLiteral(name) && !Node.isNumericLiteral(name)) {
      opaque = true;
      continue;
    }
    const key = Node.isIdentifier(name) ? name.getText() : name.getLiteralText();
    // JavaScript object literals keep the last explicit definition of a key.
    const prior = fields.findIndex(field => field.key === key);
    if (prior >= 0) fields.splice(prior, 1);
    fields.push({ key, value: Node.isShorthandPropertyAssignment(prop) ? name : prop.getInitializer() });
  }
  return { fields, opaque };
}

export function constInitializer(node: Node | undefined) {
  node = unwrapFact(node);
  if (!Node.isIdentifier(node)) return;
  const parent = node.getParent();
  const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : node.getSymbol();
  const declaration = symbol?.getDeclarations()[0];
  return declaration && unwrapFact(constValue(declaration));
}
