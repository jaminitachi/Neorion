import { Node, SourceFile, SyntaxKind, type ParameterDeclaration } from 'ts-morph';
import { conditionalAt, declarationsOf, wrappedExpression } from './ArchitectureFacts';
import { isFunction, packageMember, returnedValues } from './CallableFlow';
import { constValue } from './PropFlow';

type RenderFunction = import('ts-morph').FunctionDeclaration | import('ts-morph').FunctionExpression |
  import('ts-morph').ArrowFunction;
type Target = RenderFunction | import('ts-morph').ClassDeclaration;
const allArrayElements = Symbol('all array elements');
type Member = string | null | typeof allArrayElements;
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

const elementMethods = new Set(['find', 'findLast', 'at']);
const arrayMethods = new Set(['filter', 'slice', 'toSorted', 'toReversed', 'sort', 'reverse', 'concat', 'flatMap']);

function identityCallback(node: Node | undefined) {
  while (node && wrappedExpression(node)) node = wrappedExpression(node);
  if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) return false;
  const [parameter] = node.getParameters();
  const values = returnedValues(node);
  return !!parameter && values.length === 1 && Node.isIdentifier(values[0]) && declarationsOf(values[0]).includes(parameter);
}

function collectionCall(node: Node, remaining = 12) {
  if (!remaining || !Node.isCallExpression(node)) return;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return;
  const method = callee.getName();
  const receiver = callee.getExpression();
  if ((method === 'values' || method === 'entries') && Node.isIdentifier(receiver) &&
      receiver.compilerNode.text === 'Object' && declarationsOf(receiver).some(declaration =>
        declaration.getSourceFile().compilerNode.hasNoDefaultLib)) {
    return { kind: 'object' as const, method, receiver: node.getArguments()[0] };
  }
  if ((arrayMethods.has(method) || elementMethods.has(method)) && isArrayExpression(receiver, remaining - 1) &&
      (method !== 'flatMap' || identityCallback(node.getArguments()[0]))) {
    return { kind: elementMethods.has(method) ? 'element' as const : 'array' as const, method, receiver };
  }
}

function isArrayExpression(node: Node, remaining = 12): boolean {
  const type = node.getType();
  if (type.isArray() || type.isTuple()) return true;
  const collection = collectionCall(node, remaining);
  return !!collection && collection.kind !== 'element';
}

function mappedArray(parameter: ParameterDeclaration): Node | undefined {
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
  if (isArrayExpression(receiver)) return receiver;
}

/** Follow the value behind a JSX binding through lookups, local factories and React memoization. */
export function renderBindings(declarations: Node[], files: Set<SourceFile>): (RenderCertainty & { target: Target })[] {
  const seen = new Map<Node, { step: Step; resolved: boolean }[]>();
  const targets = new Map<Target, RenderCertainty>();
  const resolve = (node: Node | undefined, step: Step, remaining: number): boolean => {
    if (!node || remaining <= 0 || !files.has(node.getSourceFile())) return false;
    const { members, returns, possible, conditional } = step;
    const steps = seen.get(node) ?? [];
    const prior = steps.find(({ step: previous }) => previous.returns === returns && previous.possible === possible &&
        previous.conditional === conditional && previous.members.length === members.length &&
        previous.members.every((member, i) => member === members[i]));
    if (prior) return prior.resolved;
    const current = { step, resolved: false };
    steps.push(current);
    seen.set(node, steps);
    const traced = trace(node, step, (value, change) => {
      const resolved = resolve(value, change ? { ...step, ...change } : step, remaining - 1);
      current.resolved ||= resolved;
      return resolved;
    });
    return (current.resolved ||= traced === true);
  };
  const trace = (node: Node, step: Step, next: (value: Node | undefined, change?: Partial<Step>) => boolean): boolean | void => {
    const { members, returns, possible, conditional } = step;
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
      return true;
    }
    if (Node.isVariableDeclaration(node) || Node.isExportAssignment(node)) {
      return next(Node.isVariableDeclaration(node) ? node.getInitializer() : node.getExpression());
    }
    if (Node.isParameterDeclaration(node)) {
      return next(mappedArray(node), { members: [allArrayElements, ...members] });
    }
    if (Node.isBindingElement(node)) {
      const pattern = node.getParent();
      const owner = pattern.getParent();
      const key = node.getPropertyNameNode() ?? node.getNameNode();
      if (Node.isObjectBindingPattern(pattern) && !node.getDotDotDotToken() &&
          (Node.isIdentifier(key) || Node.isStringLiteral(key))) {
        return next(owner, { members: [Node.isIdentifier(key) ? key.compilerNode.text : key.getLiteralText(), ...members] });
      }
      if (Node.isArrayBindingPattern(pattern)) {
        const index = pattern.getElements().indexOf(node);
        if (node.getDotDotDotToken()) return next(owner, { members: [null, ...members.slice(1)], possible: true });
        // Destructuring an ordinary array can pick up a value from a runtime element.
        const tuple = !Node.isVariableDeclaration(owner) || owner.getInitializer()?.getType().isTuple();
        return next(owner, { members: [tuple ? String(index) : null, ...members] });
      }
    }
    if (Node.isArrayLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      if (typeof key === 'string' && !/^(?:0|[1-9]\d*)$/.test(key)) return true;
      let index = typeof key === 'string' ? Number(key) : Infinity;
      let spread = false;
      for (const element of node.getElements()) {
        if (Node.isSpreadElement(element)) {
          // Later offsets depend on the length of each preceding spread.
          const offset = typeof key === 'string' ? spread ? null : String(index) : key;
          next(element.getExpression(), { members: [offset, ...rest], possible: possible || key !== allArrayElements });
          spread = true;
        } else {
          const unknownIndex = key === null || spread;
          if (key === allArrayElements || unknownIndex || index === 0) {
            next(element, { members: rest, possible: possible || key !== allArrayElements && unknownIndex });
          }
          if (index-- === 0) return Node.isOmittedExpression(element);
        }
      }
      return typeof key === 'string' && !spread;
    }
    if (Node.isObjectLiteralExpression(node) && members.length) {
      const [key, ...rest] = members;
      if (key === allArrayElements) return;
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
      const collection = collectionCall(node);
      if (collection?.kind === 'element') {
        return next(collection.receiver, { members: [null, ...members], possible: true });
      }
      if (collection && members.length) {
        const [, ...rest] = members;
        if (collection.kind === 'object') {
          if (collection.method === 'values') return next(collection.receiver, { members: [null, ...rest], possible: true });
          const [entry, ...value] = rest;
          // Object.entries yields [key, value]; only the value can be a component.
          if (entry === undefined || entry === '0') return true;
          if (entry === '1' || entry === null || entry === allArrayElements) {
            return next(collection.receiver, { members: [null, ...value], possible: true });
          }
          return;
        }
        next(collection.receiver, { members: [null, ...rest], possible: true });
        if (collection.method === 'concat') for (const argument of node.getArguments()) {
          const value = Node.isSpreadElement(argument) ? argument.getExpression() : argument;
          const lookup = Node.isSpreadElement(argument) || isArrayExpression(value) ? [null, ...rest] : rest;
          next(value, { members: lookup, possible: true });
        }
        return;
      }
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
    if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getKind();
      if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) {
        next(node.getLeft(), { conditional: true });
      }
      if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken ||
          operator === SyntaxKind.AmpersandAmpersandToken) {
        return next(node.getRight(), { conditional: true });
      }
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
        const guarded = conditional || node.hasQuestionDotToken();
        if (next(node.getExpression(), { members: [node.getName(), ...members], conditional: guarded })) return;
        declarations.forEach(target => next(target, { possible: true, conditional: guarded }));
        return;
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
