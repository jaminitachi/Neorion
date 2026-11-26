import { Node, SyntaxKind, ts } from 'ts-morph';
import { visitKinds } from './CompilerWalk';
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

function constDeclaration(node: Node | undefined) {
  if (!Node.isIdentifier(node)) return;
  const parent = node.getParent();
  const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : node.getSymbol();
  return symbol?.getDeclarations()[0];
}

export function constInitializer(node: Node | undefined) {
  const declaration = constDeclaration(unwrapFact(node));
  return declaration && unwrapFact(constValue(declaration));
}

const identifierKind = new Set([SyntaxKind.Identifier]);
const objectChanges = new WeakMap<Node, { assigned: boolean; firstEscape: number }>();

// A const binding preserves identity, but assignments and calls can change its keys.
export function factValue(node: Node | undefined, useAt?: number): { value?: Node; opaque?: true } {
  const reference = unwrapFact(node);
  const declaration = constDeclaration(reference);
  const value = declaration && unwrapFact(constValue(declaration));
  if (!reference || !Node.isVariableDeclaration(declaration) || !Node.isObjectLiteralExpression(value)) {
    return { value: value ?? reference };
  }
  let changes = objectChanges.get(declaration);
  if (!changes) {
    const scope = declaration.getFirstAncestor(Node.isBlock) ?? declaration.getSourceFile();
    const name = declaration.getName();
    changes = { assigned: false, firstEscape: Infinity };
    const result = changes;
    visitKinds(scope, identifierKind, use => {
      if (result.assigned || constDeclaration(use) !== declaration) return;
      const { assigned, escapedAt } = objectUse(use);
      result.assigned ||= assigned;
      result.firstEscape = Math.min(result.firstEscape, escapedAt);
    }, { filterRaw: use => !result.assigned && ts.isIdentifier(use) && use.text === name });
    objectChanges.set(declaration, changes);
  }
  return changes.assigned || changes.firstEscape <= (useAt ?? reference.getStart()) ? { opaque: true } : { value };
}

function objectUse(use: Node) {
  let value = use;
  let member = false;
  for (let parent = value.getParent(); parent; parent = value.getParent()) {
    if (wrappedExpression(parent) === value) {
      value = parent;
    } else if ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
        parent.getExpression() === value) {
      member = true;
      value = parent;
    } else if (Node.isBinaryExpression(parent) && parent.getLeft() === value &&
        parent.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment &&
        parent.getOperatorToken().getKind() <= SyntaxKind.LastAssignment ||
        Node.isDeleteExpression(parent) ||
        (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) &&
          [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(parent.getOperatorToken())) {
      return { assigned: true, escapedAt: Infinity };
    } else if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
      if (member && parent.getExpression() !== value) break;
      const callee = parent.getExpression();
      const assign = Node.isPropertyAccessExpression(callee) && callee.getName() === 'assign' &&
        callee.getExpression().getText() === 'Object';
      return { assigned: assign, escapedAt: parent.getEnd() };
    } else if (!member && (Node.isShorthandPropertyAssignment(parent) ||
        Node.isPropertyAssignment(parent) && parent.getInitializer() === value ||
        Node.isArrayLiteralExpression(parent) || Node.isObjectLiteralExpression(parent) ||
        Node.isConditionalExpression(parent) && parent.getCondition() !== value ||
        Node.isBinaryExpression(parent) && [SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken,
          SyntaxKind.QuestionQuestionToken].includes(parent.getOperatorToken().getKind()))) {
      value = parent;
    } else break;
  }
  return { assigned: false, escapedAt: Infinity };
}
