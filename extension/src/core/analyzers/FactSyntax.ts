import { Node, SyntaxKind, ts, type CallExpression } from 'ts-morph';
import { visitKinds } from './CompilerWalk';
import { wrappedExpression } from './ArchitectureFacts';
import { constValue } from './PropFlow';
import { bindingOf, functionNode, importBinding, returns, valueNode } from './StaticBindings';

export function unwrapFact(node: Node | undefined) {
  while (node) {
    const inner = wrappedExpression(node);
    if (!inner) break;
    node = inner;
  }
  return node;
}

export function syntaxLabel(node: Node): string {
  let text = node.getText();
  if (text.includes('//') && /[\r\n\u2028\u2029]/.test(text)) {
    const source = node.getSourceFile().compilerNode;
    const start = node.getStart();
    const ends = new Map<number, number>();
    const visit = (current: ts.Node) => {
      const children = current.getChildren(source);
      if (children.length) {
        for (const child of children) visit(child);
      } else if (!ts.isJsxText(current)) {
        const tokenStart = current.getStart(source);
        const comments = [...ts.getLeadingCommentRanges(source.text, current.pos) ?? [],
          ...ts.getTrailingCommentRanges(source.text, current.pos) ?? []];
        for (const comment of comments) {
          if (comment.kind === SyntaxKind.SingleLineCommentTrivia && comment.pos >= start && comment.end <= tokenStart) {
            ends.set(comment.pos, comment.end);
          }
        }
      }
    };
    visit(node.compilerNode);
    for (const [from, to] of [...ends].sort(([a], [b]) => b - a)) {
      text = text.slice(0, from - start) + text.slice(to - start);
    }
  }
  return text.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ');
}

// Preserve literal string values in a one-line representation.
export function expressionLabel(node: Node | undefined): string {
  if (!node) return '<missing>';
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return JSON.stringify(node.getLiteralText());
  return syntaxLabel(node);
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
const bindingChanges = new WeakMap<Node, { assigned: boolean; firstEscape: number }>();
const mutatingMethods = new Set(['add', 'clear', 'copyWithin', 'delete', 'fill', 'pop', 'push', 'reverse',
  'set', 'shift', 'sort', 'splice', 'unshift']);
const mutatingBuiltIns = new Set(['Object.assign', 'Object.defineProperties', 'Object.defineProperty',
  'Object.setPrototypeOf', 'Reflect.defineProperty', 'Reflect.deleteProperty', 'Reflect.set', 'Reflect.setPrototypeOf']);

// A const binding preserves identity, but assignments and calls can change its keys.
export function factValue(node: Node | undefined, useAt?: number): { value?: Node; opaque?: true } {
  const reference = unwrapFact(node);
  const declaration = constDeclaration(reference);
  const value = declaration && unwrapFact(constValue(declaration));
  if (!reference || !Node.isVariableDeclaration(declaration) || !value ||
      Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value) ||
      Node.isNumericLiteral(value) || Node.isBigIntLiteral(value) || Node.isTemplateExpression(value) ||
      Node.isTrueLiteral(value) || Node.isFalseLiteral(value) || Node.isNullLiteral(value)) {
    return { value: value ?? reference };
  }
  let changes = bindingChanges.get(declaration);
  if (!changes) {
    const scope = declaration.getFirstAncestor(Node.isBlock) ?? declaration.getSourceFile();
    const name = declaration.getName();
    changes = { assigned: false, firstEscape: Infinity };
    const result = changes;
    visitKinds(scope, identifierKind, use => {
      if (result.assigned || constDeclaration(use) !== declaration) return;
      const { assigned, escapedAt } = bindingUse(use);
      result.assigned ||= assigned;
      result.firstEscape = Math.min(result.firstEscape, escapedAt);
    }, { filterRaw: use => !result.assigned && ts.isIdentifier(use) && use.text === name });
    bindingChanges.set(declaration, changes);
  }
  return changes.assigned || changes.firstEscape <= (useAt ?? reference.getStart()) ? { opaque: true } : { value };
}

function bindingUse(use: Node) {
  let value = use;
  for (let parent = value.getParent(); parent; parent = value.getParent()) {
    if (wrappedExpression(parent) === value) {
      value = parent;
    } else if ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
        parent.getExpression() === value) {
      value = parent;
    } else if (Node.isBinaryExpression(parent) && parent.getLeft() === value &&
        parent.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment &&
        parent.getOperatorToken().getKind() <= SyntaxKind.LastAssignment ||
        Node.isDeleteExpression(parent) ||
        (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) &&
          [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(parent.getOperatorToken())) {
      return { assigned: true, escapedAt: Infinity };
    } else if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
      const callee = parent.getExpression();
      if (callee !== value && Node.isCallExpression(parent) && isReadOnlyPrismaCall(parent)) break;
      const key = Node.isElementAccessExpression(callee) ? callee.getArgumentExpression() : undefined;
      const method = Node.isPropertyAccessExpression(callee) ? callee.getName() :
        Node.isStringLiteral(key) ? key.getLiteralText() : undefined;
      const mutation = callee === value && !!method && mutatingMethods.has(method) ||
        parent.getArguments()[0] === value && mutatingBuiltIns.has(callee.getText());
      return { assigned: mutation, escapedAt: parent.getEnd() };
    } else if (Node.isVariableDeclaration(parent) && parent.getInitializer() === value ||
        Node.isReturnStatement(parent) || Node.isArrowFunction(parent) && parent.getBody() === value ||
        Node.isBinaryExpression(parent) && parent.getRight() === value &&
          parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      // A new reference can be mutated through its alias.
      return { assigned: false, escapedAt: parent.getEnd() };
    } else if (Node.isShorthandPropertyAssignment(parent) ||
        Node.isPropertyAssignment(parent) && parent.getInitializer() === value ||
        Node.isArrayLiteralExpression(parent) || Node.isObjectLiteralExpression(parent) ||
        Node.isSpreadAssignment(parent) || Node.isSpreadElement(parent) ||
        Node.isConditionalExpression(parent) && parent.getCondition() !== value ||
        Node.isBinaryExpression(parent) && [SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken,
          SyntaxKind.QuestionQuestionToken].includes(parent.getOperatorToken().getKind())) {
      value = parent;
    } else break;
  }
  return { assigned: false, escapedAt: Infinity };
}

const readOnlyPrismaMethods = new Set(['aggregate', 'count', 'findFirst', 'findFirstOrThrow', 'findMany',
  'findUnique', 'findUniqueOrThrow', 'groupBy']);
const readOnlyPrismaCalls = new WeakMap<CallExpression, boolean>();

export function prismaModule(module: string | undefined) {
  return module === '@prisma/client' || /(?:^|\/)generated\/prisma(?:\/client)?$/.test(module ?? '');
}

function prismaConstructor(node: Node | undefined) {
  if (!Node.isNewExpression(node)) return false;
  const origin = importBinding(node.getExpression());
  return origin?.name === 'PrismaClient' && prismaModule(origin.module);
}

function prismaFactory(node: Node | undefined) {
  const fn = functionNode(node);
  const values = returns(fn?.getBody());
  return values.length > 0 && values.every(prismaConstructor);
}

function isPrismaClient(node: Node) {
  const value = valueNode(node);
  if (prismaConstructor(value)) return true;
  if (Node.isCallExpression(value)) return prismaFactory(value.getExpression());
  if (!Node.isBinaryExpression(value) || value.getOperatorToken().getKind() !== SyntaxKind.QuestionQuestionToken) return false;
  // A cached singleton can be typed as the return value of the same Prisma factory.
  const cached = value.getLeft();
  const fallback = unwrapFact(value.getRight());
  if (!Node.isPropertyAccessExpression(cached) || !Node.isCallExpression(fallback)) return false;
  const callee = fallback.getExpression();
  const receiver = bindingOf(cached.getExpression());
  const annotation = Node.isVariableDeclaration(receiver) ? receiver.getTypeNode() : undefined;
  const types = Node.isIntersectionTypeNode(annotation) ? annotation.getTypeNodes() : [annotation];
  const declared = types.filter(Node.isTypeLiteral).flatMap(type => type.getProperties())
    .find(property => property.getName() === cached.getName());
  const type = (cached.getSymbol()?.getDeclarations().find(Node.isPropertySignature) ?? declared)?.getTypeNode();
  const factoryType = Node.isTypeReference(type) && type.getTypeName().getText() === 'ReturnType'
    ? type.getTypeArguments()[0] : undefined;
  return Node.isTypeQuery(factoryType) && functionNode(factoryType.getExprName()) === functionNode(callee) &&
    prismaFactory(callee);
}

function isReadOnlyPrismaCall(call: CallExpression) {
  const callee = unwrapFact(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee) || !readOnlyPrismaMethods.has(callee.getName())) return false;
  const model = callee.getExpression();
  if (!Node.isPropertyAccessExpression(model)) return false;
  let readOnly = readOnlyPrismaCalls.get(call);
  if (readOnly === undefined) {
    readOnly = isPrismaClient(model.getExpression());
    readOnlyPrismaCalls.set(call, readOnly);
  }
  return readOnly;
}
