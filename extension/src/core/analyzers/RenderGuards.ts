import { Node, SyntaxKind, type ParameterDeclaration } from 'ts-morph';
import { wrappedExpression } from './ArchitectureFacts';
import { constValue, jsxValue, type PropFlow, type RenderSite } from './PropFlow';
import { functionNode, executionSites } from './StaticBindings';

const unknown = Symbol('unknown');
const jsx = Symbol('JSX');
const falsy = Symbol('falsy value');
type Env = ReadonlyMap<Node, Value[]>;
type ObjectValue = { object: import('ts-morph').ObjectLiteralExpression; env: Env };
type ArrayValue = { items: Value[][] };
type PropsValue = { owner: Node; omitted?: Set<string> };
type RestValue = { rest: Value[]; omitted: Set<string> };
type Value = string | number | boolean | null | undefined | typeof unknown | typeof jsx | typeof falsy |
  ObjectValue | ArrayValue | PropsValue | RestValue;
const unresolved = [unknown] as Value[];
const emptyEnv: Env = new Map();
const returnedSites = new WeakMap<Node, ReturnType<typeof executionSites>['returned']>();

function returnsAt(body: Node | undefined) {
  if (!body) return [];
  let returned = returnedSites.get(body);
  if (!returned) {
    // Prop supplier chains vary, but the callable's return sites do not.
    returned = executionSites(body).returned;
    returnedSites.set(body, returned);
  }
  return returned;
}

function finite(values: Value[]): Value[] {
  return values.length <= 64 ? [...new Set(values)] : unresolved;
}

function truth(value: Value) {
  return value === unknown ? undefined : value !== falsy && Boolean(value);
}

function equality(left: Value, right: Value): Value {
  if (left === unknown || right === unknown || typeof left === 'object' && left !== null ||
      typeof right === 'object' && right !== null || typeof left === 'symbol' || typeof right === 'symbol') return unknown;
  return left === right;
}

function nameOf(node: Node) {
  return Node.isIdentifier(node) ? node.compilerNode.text :
    Node.isStringLiteral(node) || Node.isNumericLiteral(node) ? node.getLiteralText() : undefined;
}

export type RenderGuard = { expression: Node; positive: boolean };
export type RenderSelection = { selector: Node; members: string[] };

/** Prove that a JSX branch is blocked for a particular chain of prop suppliers. */
export function evaluateRenderGuards(flow: PropFlow, guards: RenderGuard[], selection: RenderSelection | undefined,
  suppliers: ReadonlyMap<Node, RenderSite>) {
  const needed = new Set<Node>();
  const assumed = new Map<Node, Value>();
  const bound = new Set<Node>();
  let budget = 360;
  let supplied = false;
  let strict = false;
  const read = (owner: Node, key: string): Value[] => {
    const site = suppliers.get(owner);
    if (!site) {
      needed.add(owner);
      return unresolved;
    }
    supplied = true;
    if (Node.isCallExpression(site)) {
      const argument = site.getArguments()[1];
      return !argument || Node.isNullLiteral(argument) ? [undefined] : property(evaluate(argument), key);
    }
    const attrs = site.getAttributes();
    for (let i = attrs.length - 1; i >= 0; i--) {
      const attr = attrs[i];
      if (Node.isJsxSpreadAttribute(attr)) {
        const values = property(evaluate(attr.getExpression()), key);
        if (!values.every(value => value === undefined)) return values.includes(undefined) ? unresolved : values;
      } else if (attr.getNameNode().getText() === key) {
        const value = jsxValue(attr);
        return value ? evaluate(value) : [true];
      }
    }
    return [undefined];
  };
  const property = (values: Value[], key: string): Value[] => finite(values.flatMap((value): Value[] => {
    if (value === unknown) return unresolved;
    if (typeof value !== 'object' || value === null) return [undefined];
    if ('owner' in value) return value.omitted?.has(key) ? [undefined] : read(value.owner, key);
    if ('rest' in value) return value.omitted.has(key) ? [undefined] : property(value.rest, key);
    if ('items' in value) return key === 'length' ? unresolved : value.items[Number(key)] ?? [undefined];
    for (const member of [...value.object.getProperties()].reverse()) {
      if (Node.isSpreadAssignment(member)) {
        const spread = property(evaluate(member.getExpression(), value.env), key);
        if (!spread.every(entry => entry === undefined)) return spread.includes(undefined) ? unresolved : spread;
      } else {
        const name = nameOf(member.getNameNode());
        if (name === undefined) return unresolved;
        if (name !== key) continue;
        if (Node.isPropertyAssignment(member)) return evaluate(member.getInitializer(), value.env);
        if (Node.isShorthandPropertyAssignment(member)) return evaluate(member.getNameNode(), value.env);
        return unresolved;
      }
    }
    return [undefined];
  }));
  const elementValues = (values: Value[]) => finite(values.flatMap((value): Value[] =>
    typeof value === 'object' && value !== null && 'items' in value ? value.items.flat() :
      value === undefined || value === null ? [] : unresolved));
  const callbackReceiver = (parameter: ParameterDeclaration) => {
    const fn = parameter.getParent();
    const call = fn.getParent();
    if (!Node.isCallExpression(call) || call.getArguments()[0] !== fn ||
        !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) || fn.getParameters()[0] !== parameter) return;
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee) && ['map', 'flatMap', 'filter', 'find'].includes(callee.getName())) return callee.getExpression();
  };
  const evaluate = (input: Node | undefined, env = emptyEnv): Value[] => {
    if (!input || --budget < 0 || bound.has(input)) return unresolved;
    bound.add(input);
    const result = resolve(input, env);
    bound.delete(input);
    return result;
  };
  const resolve = (node: Node, env: Env): Value[] => {
    const wrapped = wrappedExpression(node);
    if (wrapped) return evaluate(wrapped, env);
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return [node.getLiteralText()];
    if (Node.isNumericLiteral(node)) return [node.getLiteralValue()];
    if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) return [Node.isTrueLiteral(node)];
    if (Node.isNullLiteral(node)) return [null];
    if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node)) return [jsx];
    if (Node.isObjectLiteralExpression(node)) return [{ object: node, env }];
    if (Node.isArrayLiteralExpression(node) && !node.getElements().some(Node.isSpreadElement)) {
      // Defer object property evaluation until a selector actually reads it.
      return [{ items: node.getElements().map(element => evaluate(element, env)) }];
    }
    if (Node.isIdentifier(node) && assumed.size) {
      const declaration = flow.declarations(node)[0];
      if (declaration && !env.has(declaration) && assumed.has(declaration)) return [assumed.get(declaration)];
    }
    const prop = flow.read(node);
    if (prop) return finite(read(prop.component, prop.name).flatMap(value =>
      value === undefined && prop.fallback ? evaluate(prop.fallback, env) : [value]));
    if (Node.isIdentifier(node)) {
      const parent = node.getParent();
      const declaration = Node.isShorthandPropertyAssignment(parent)
        ? parent.getValueSymbol()?.getDeclarations()[0] : flow.declarations(node)[0];
      if (!declaration) return unresolved;
      const binding = env.get(declaration);
      if (binding) return binding;
      if (Node.isParameterDeclaration(declaration)) {
        const owner = flow.propsOwner(declaration);
        if (owner) return [{ owner }];
        const receiver = callbackReceiver(declaration);
        return receiver ? elementValues(evaluate(receiver, env)) : unresolved;
      }
      if (Node.isBindingElement(declaration) && Node.isObjectBindingPattern(declaration.getParent())) {
        const pattern = declaration.getParent() as import('ts-morph').ObjectBindingPattern;
        const owner = pattern.getParent();
        const props = flow.propsOwner(owner);
        const collection = Node.isParameterDeclaration(owner) ? env.get(owner) ??
          (callbackReceiver(owner) ? elementValues(evaluate(callbackReceiver(owner), env)) : unresolved) : evaluate(constValue(owner), env);
        const values = props ? [{ owner: props }] : collection;
        if (declaration.getDotDotDotToken()) {
          const omitted = pattern.getElements().filter(element => element !== declaration)
            .map(element => nameOf(element.getPropertyNameNode() ?? element.getNameNode()));
          return omitted.includes(undefined) ? unresolved : [{ rest: values, omitted: new Set(omitted as string[]) }];
        }
        const key = nameOf(declaration.getPropertyNameNode() ?? declaration.getNameNode());
        return key === undefined ? unresolved : finite(property(values, key).flatMap(value =>
          value === undefined && declaration.getInitializer() ? evaluate(declaration.getInitializer(), env) : [value]));
      }
      return evaluate(constValue(declaration), env);
    }
    if (Node.isPropertyAccessExpression(node)) return property(evaluate(node.getExpression(), env), node.getName());
    if (Node.isElementAccessExpression(node)) {
      const receiver = evaluate(node.getExpression(), env);
      return finite(evaluate(node.getArgumentExpression(), env).flatMap(key => {
        if (typeof key === 'string' || typeof key === 'number') return property(receiver, String(key));
        return receiver.flatMap(value => {
          if (typeof value !== 'object' || value === null || !('object' in value)) return unresolved;
          const keys = value.object.getProperties().map(member =>
            Node.isSpreadAssignment(member) ? undefined : nameOf(member.getNameNode()));
          return keys.includes(undefined) ? unresolved : [undefined, ...keys.flatMap(key => property([value], key!))];
        });
      }));
    }
    if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.ExclamationToken) {
      return finite(evaluate(node.getOperand(), env).map(value => value === unknown ? unknown : !truth(value)));
    }
    if (Node.isConditionalExpression(node)) {
      const choices = evaluate(node.getCondition(), env).map(truth);
      return finite([...(choices.every(value => value === false) ? [] : evaluate(node.getWhenTrue(), env)),
        ...(choices.every(value => value === true) ? [] : evaluate(node.getWhenFalse(), env))]);
    }
    if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getKind();
      const and = operator === SyntaxKind.AmpersandAmpersandToken;
      const or = operator === SyntaxKind.BarBarToken;
      const nullish = operator === SyntaxKind.QuestionQuestionToken;
      const equal = operator === SyntaxKind.EqualsEqualsEqualsToken;
      const unequal = operator === SyntaxKind.ExclamationEqualsEqualsToken;
      if (!and && !or && !nullish && !equal && !unequal) return unresolved;
      const left = evaluate(node.getLeft(), env);
      if (and || or || nullish) {
        // Keep the truth of a short-circuited operand even when its value is open.
        return finite(left.flatMap(value => value === unknown
          ? [and ? falsy : or ? jsx : unknown, ...evaluate(node.getRight(), env)]
          : (nullish ? value == null : truth(value) === and) ? evaluate(node.getRight(), env) : [value]));
      }
      const right = evaluate(node.getRight(), env);
      return finite(left.flatMap(a => right.map(b => {
        const result = equality(a, b);
        return result === unknown ? unknown : result === equal;
      })));
    }
    if (!Node.isCallExpression(node)) return unresolved;
    const callee = node.getExpression();
    if (Node.isPropertyAccessExpression(callee) && ['filter', 'find'].includes(callee.getName())) {
      const callback = functionNode(node.getArguments()[0]);
      const param = callback?.getParameters()[0];
      if (!param || !callback || callback.getSourceFile().isDeclarationFile()) return unresolved;
      const results = returnsAt(callback.getBody());
      if (results.length !== 1 || results[0].possible) return unresolved;
      const find = callee.getName() === 'find';
      return finite(evaluate(callee.getExpression(), env).flatMap((value): Value[] => {
        if (typeof value !== 'object' || value === null || !('items' in value)) return unresolved;
        const found: Value[][] = [];
        for (const item of value.items) {
          const matches = item.filter(entry => {
            const local = new Map(env).set(param, [entry]);
            return evaluate(results[0].node, local).some(result => truth(result) !== false);
          });
          if (matches.length) found.push(matches);
        }
        return find ? [undefined, ...found.flat()] : [{ items: found }];
      }));
    }
    const fn = functionNode(callee);
    if (!fn || fn.getSourceFile().isDeclarationFile()) return unresolved;
    const returns = returnsAt(fn.getBody());
    if (returns.length !== 1 || returns[0].possible || fn.getParameters().length || fn.isAsync()) return unresolved;
    return evaluate(returns[0].node, env);
  };

  const assume = (input: Node, positive: boolean) => {
    const expression = wrappedExpression(input) ?? input;
    if (expression !== input) return assume(expression, positive);
    if (!Node.isBinaryExpression(expression)) return;
    const operator = expression.getOperatorToken().getKind();
    if (positive && operator === SyntaxKind.AmpersandAmpersandToken || !positive && operator === SyntaxKind.BarBarToken) {
      assume(expression.getLeft(), positive);
      assume(expression.getRight(), positive);
    }
    if (!(positive && operator === SyntaxKind.EqualsEqualsEqualsToken ||
        !positive && operator === SyntaxKind.ExclamationEqualsEqualsToken)) return;
    for (const [variable, literal] of [[expression.getLeft(), expression.getRight()], [expression.getRight(), expression.getLeft()]]) {
      if (!Node.isIdentifier(variable) || !(Node.isStringLiteral(literal) || Node.isNumericLiteral(literal))) continue;
      const declaration = flow.declarations(variable)[0];
      if (declaration && (Node.isBindingElement(declaration) || Node.isParameterDeclaration(declaration) || constValue(declaration))) {
        assumed.set(declaration, literal.getLiteralValue());
      }
    }
  };

  // A branch must itself be possible before imposing its equality on earlier
  // guards (for example find(x => x.type === mode) under mode === "email").
  let supported = false;
  const impossible = ({ expression, positive }: RenderGuard) => {
    budget = 360;
    supplied = false;
    const values = evaluate(expression).map(truth);
    if (supplied && !values.includes(undefined) && values.includes(positive)) supported = true;
    return values.length > 0 && values.every(value => value === !positive);
  };
  let blocked = guards.some(impossible);
  if (!blocked) {
    for (const guard of guards) assume(guard.expression, guard.positive);
    if (assumed.size) strict = blocked = guards.some(impossible);
  }
  if (!blocked && selection) {
    budget = 360;
    const keys = evaluate(selection.selector);
    strict = blocked = !!keys.length && keys.every(key => (typeof key === 'string' || typeof key === 'number') &&
      !selection.members.includes(String(key)));
  }
  return { blocked, strict, needed, supported };
}
