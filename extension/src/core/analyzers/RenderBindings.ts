import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import { conditionalAt, declarationsOf, wrappedExpression } from './ArchitectureFacts';
import { isFunction, packageMember, returnedValues } from './CallableFlow';
import { constValue } from './PropFlow';

type RenderFunction = import('ts-morph').FunctionDeclaration | import('ts-morph').FunctionExpression |
  import('ts-morph').ArrowFunction;
type Target = RenderFunction | import('ts-morph').ClassDeclaration;
type Member = string | null;
export type RenderCertainty = { possible: boolean; conditional: boolean };
type Step = RenderCertainty & { members: Member[]; returns: boolean };

export function preferRenderBinding(candidate: RenderCertainty, existing: RenderCertainty): boolean {
  if (candidate.possible !== existing.possible) return !candidate.possible;
  return !candidate.conditional && existing.conditional;
}

function lookupKey(node: Node | undefined, remaining = 8): string | undefined {
  if (!node || !remaining) return;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return String(node.getLiteralValue());
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand();
    const operator = node.getOperatorToken();
    if (Node.isNumericLiteral(operand) && (operator === SyntaxKind.PlusToken || operator === SyntaxKind.MinusToken)) {
      return String(operator === SyntaxKind.MinusToken ? -operand.getLiteralValue() : operand.getLiteralValue());
    }
  }
  const wrapped = wrappedExpression(node);
  if (wrapped) return lookupKey(wrapped, remaining - 1);
  if (Node.isIdentifier(node)) {
    const declarations = declarationsOf(node);
    if (declarations.length === 1) return lookupKey(constValue(declarations[0]), remaining - 1);
  }
}

function mappedArray(parameter: import('ts-morph').ParameterDeclaration): Node | undefined {
  const fn = parameter.getParent();
  if ((!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) || fn.getParameters()[0] !== parameter) return;
  let callback: Node = fn;
  for (let parent = callback.getParent(); parent && wrappedExpression(parent) === callback; parent = callback.getParent()) {
    callback = parent;
  }
  const call = callback.getParent();
  if (!Node.isCallExpression(call) || call.getArguments()[0] !== callback) return;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') return;
  const receiver = callee.getExpression();
  const type = receiver.getType();
  if (type.isArray() || type.isTuple()) return receiver;
}

/** Follow the value behind a JSX binding through lookups, local factories and React memoization. */
export function renderBindings(declarations: Node[], files: Set<SourceFile>): (RenderCertainty & { target: Target })[] {
  const seen = new Map<Node, Step[]>();
  const targets = new Map<Target, RenderCertainty>();
  const resolve = (node: Node | undefined, step: Step, remaining: number): void => {
    if (!node || remaining <= 0 || !files.has(node.getSourceFile())) return;
    const { members, returns, possible, conditional } = step;
    const steps = seen.get(node) ?? [];
    if (steps.some(previous => previous.returns === returns && previous.possible === possible &&
        previous.conditional === conditional && previous.members.length === members.length &&
        previous.members.every((member, i) => member === members[i]))) return;
    steps.push(step);
    seen.set(node, steps);
    const next = (value: Node | undefined, change?: Partial<Step>) =>
      resolve(value, change ? { ...step, ...change } : step, remaining - 1);
    if (isFunction(node) && returns) {
      const values = returnedValues(node);
      for (const value of values) {
        next(value, { returns: false, conditional: conditional || values.length > 1 || !!conditionalAt(value, node) });
      }
      return;
    }
    if (!returns && !members.length && (isFunction(node) && !Node.isMethodDeclaration(node) || Node.isClassDeclaration(node))) {
      const existing = targets.get(node);
      if (!existing || preferRenderBinding(step, existing)) targets.set(node, { possible, conditional });
      return;
    }
    if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
      return next(Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression());
    }
    if (Node.isParameterDeclaration(node)) {
      return next(mappedArray(node), { members: [null, ...members] });
    }
    if (Node.isBindingElement(node)) {
      const pattern = node.getParent();
      const owner = pattern.getParent();
      const key = node.getPropertyNameNode() ?? node.getNameNode();
      if (Node.isObjectBindingPattern(pattern) && !node.getDotDotDotToken() &&
          (Node.isIdentifier(key) || Node.isStringLiteral(key))) {
        return next(owner, { members: [Node.isIdentifier(key) ? key.compilerNode.text : key.getLiteralText(), ...members] });
      }
    }
    if (Node.isArrayLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      if (key !== null && !/^(?:0|[1-9]\d*)$/.test(key)) return;
      let index = key === null ? Infinity : Number(key);
      let spread = false;
      for (const element of node.getElements()) {
        if (Node.isSpreadElement(element)) {
          // Later offsets depend on the length of each preceding spread.
          const offset = key === null || spread ? null : String(index);
          next(element.getExpression(), { members: [offset, ...rest], possible: true });
          spread = true;
        } else {
          const unknownIndex = key === null || spread;
          if (unknownIndex || index === 0) next(element, { members: rest, possible: possible || unknownIndex });
          if (index-- === 0) return;
        }
      }
      return;
    }
    if (Node.isObjectLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      const properties = node.getProperties();
      const covered = new Set<string>();
      let uncertain = possible || key === null;
      for (let i = properties.length - 1; i >= 0; i--) {
        const property = properties[i];
        if (Node.isSpreadAssignment(property)) {
          next(property.getExpression(), { possible: true });
          uncertain = true;
          continue;
        }
        const name = property.getNameNode();
        const member = Node.isIdentifier(name) ? name.compilerNode.text :
          lookupKey(Node.isComputedPropertyName(name) ? name.getExpression() : name);
        if (member !== undefined && (covered.has(member) || key !== null && member !== key)) continue;
        next(property, { members: rest, possible: uncertain || member === undefined });
        if (member === undefined) uncertain = true;
        else if (key !== null) return;
        else covered.add(member);
      }
      return;
    }
    if (Node.isPropertyAssignment(node)) return next(node.getInitializer());
    if (Node.isShorthandPropertyAssignment(node)) {
      node.getValueSymbol()?.getDeclarations().forEach(target => next(target));
      return;
    }
    if (Node.isCallExpression(node) && !returns) {
      const expression = node.getExpression();
      const hook = packageMember(expression, 'react');
      if (hook === 'useCallback' || hook === 'useMemo') {
        return next(node.getArguments()[0], { returns: hook === 'useMemo' });
      }
      next(expression, { returns: true });
      return;
    }
    if (Node.isConditionalExpression(node)) {
      next(node.getWhenTrue(), { conditional: true });
      next(node.getWhenFalse(), { conditional: true });
      return;
    }
    if (Node.isBinaryExpression(node) && (node.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken ||
        node.getOperatorToken().getKind() === SyntaxKind.BarBarToken)) {
      next(node.getLeft(), { conditional: true });
      next(node.getRight(), { conditional: true });
      return;
    }
    if (Node.isElementAccessExpression(node)) {
      const key = lookupKey(node.getArgumentExpression());
      return next(node.getExpression(), { members: [key ?? null, ...members] });
    }
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
      const declarations = declarationsOf(node);
      if (Node.isPropertyAccessExpression(node) && (!declarations.length ||
          declarations.some(target => Node.isPropertyAssignment(target) || Node.isShorthandPropertyAssignment(target)))) {
        // Resolve literal properties against the object so access through a
        // dynamic outer lookup retains that lookup's uncertainty.
        return next(node.getExpression(), { members: [node.getName(), ...members] });
      }
      declarations.forEach(target => next(target));
      return;
    }
    next(wrappedExpression(node));
  };
  const initial = { members: [], returns: false, possible: false, conditional: false };
  declarations.forEach(node => resolve(node, initial, 40));
  return [...targets].map(([target, certainty]) => ({ target, ...certainty }));
}
