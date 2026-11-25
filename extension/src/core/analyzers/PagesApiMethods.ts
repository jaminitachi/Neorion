import { CallExpression, Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { RouteNode } from '../types/GraphTypes';
import { property, textValue } from './NextConfig';
import { executionSites, functionNode, valueNode } from './StaticBindings';
import type { WorkspaceBindings } from './WorkspaceBindings';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

// Resolve wrappers that pass the original request through a callback context.
function forwardedRequest(call: CallExpression) {
  const [callback] = call.getArguments();
  if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;
  const binding = callback.getParameters()[0]?.getNameNode();
  if (!Node.isObjectBindingPattern(binding)) return;
  const symbol = call.getExpression().getSymbol();
  const declarations = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (!Node.isFunctionDeclaration(declaration)) continue;
    const parameter = declaration.getParameters()[0]?.getNameNode().getSymbol();
    const body = declaration.getBody();
    if (!parameter || !Node.isBlock(body)) continue;
    for (const statement of body.getStatements()) {
      if (!Node.isReturnStatement(statement)) continue;
      const wrapper = statement.getExpression();
      if (!Node.isArrowFunction(wrapper) && !Node.isFunctionExpression(wrapper)) continue;
      const [request, response] = wrapper.getParameters().map(parameter => parameter.getNameNode());
      if (!request?.getSymbol() || !response?.getSymbol()) continue;
      for (const { node: invocation } of executionSites(wrapper.getBody()).calls) {
        if (invocation.getExpression().getSymbol() !== parameter) continue;
        const context = invocation.getArguments()[0];
        if (!Node.isObjectLiteralExpression(context)) continue;
        const properties = context.getProperties().slice().reverse();
        const forwarded = (input: Node) => binding.getElements().find(element => {
          const key = (element.getPropertyNameNode() ?? element.getNameNode()).getText();
          const property = properties.find(item => Node.isSpreadAssignment(item) || ('getName' in item && item.getName() === key));
          return Node.isShorthandPropertyAssignment(property) ? property.getValueSymbol() === input.getSymbol() :
            Node.isPropertyAssignment(property) && property.getInitializer()?.getSymbol() === input.getSymbol();
        })?.getNameNode();
        const callbackRequest = forwarded(request);
        const callbackResponse = forwarded(response);
        if (!callbackRequest || !callbackResponse) continue;
        const flow = exits(wrapper.getBody(), { response, forward: invocation, condition: () => undefined });
        if ((flow & Exit.Forwarded) && !(flow & ~(Exit.Forwarded | Exit.Rejected))) {
          return { callback, request: callbackRequest, response: callbackResponse };
        }
      }
    }
  }
}

const enum Exit {
  Next = 1,
  Rejected = 2,
  Other = 4,
  Thrown = 8,
  Break = 16,
  Forwarded = 32
}

type RejectionProof = {
  condition: (expression: Node) => boolean | undefined;
  switchValue?: (expression: Node) => boolean;
  method?: string;
  response?: Node;
  forward?: CallExpression;
  guard?: (expression: Node) => boolean;
  caught?: Node;
  throws?: boolean;
};

const errorStatus = (code: Node | undefined) =>
  Node.isNumericLiteral(code) && code.getLiteralValue() >= 400 && code.getLiteralValue() < 600;

function returnedErrorStatus(code: Node | undefined): boolean {
  if (!Node.isPropertyAccessExpression(code)) return false;
  const receiver = valueNode(code.getExpression());
  if (!Node.isCallExpression(receiver)) return false;
  const fn = functionNode(receiver.getExpression());
  let found = false;
  for (const { node } of executionSites(fn?.getBody()).returned) {
    const result = valueNode(node);
    if (!Node.isObjectLiteralExpression(result) || result.getProperties().some(Node.isSpreadAssignment)) return false;
    const member = property(result, code.getName());
    if (!member) continue;
    if (!errorStatus(valueNode(member))) return false;
    found = true;
  }
  return found;
}

function responseRejects(node: Node | undefined, proof: RejectionProof): boolean {
  const terminal = valueNode(node);
  const method = Node.isCallExpression(terminal) && terminal.getExpression();
  const response = proof.response?.getSymbol();
  if (!response || !method || !Node.isPropertyAccessExpression(method) ||
    !['end', 'send', 'json'].includes(method.getName())) return false;
  const status = valueNode(method.getExpression());
  const callee = Node.isCallExpression(status) && status.getExpression();
  if (!Node.isCallExpression(status) || !callee || !Node.isPropertyAccessExpression(callee) ||
    callee.getName() !== 'status' || callee.getExpression().getSymbol() !== response) return false;
  const code = valueNode(status.getArguments()[0]);
  return errorStatus(code) || returnedErrorStatus(code) ||
    !!proof.caught && Node.isPropertyAccessExpression(code) && code.getName() === 'statusCode' &&
    code.getExpression().getSymbol() === proof.caught.getSymbol();
}

function conditionValue(node: Node, atom: RejectionProof['condition'], depth = 0): boolean | undefined {
  if (depth >= 20) return;
  if (Node.isParenthesizedExpression(node)) return conditionValue(node.getExpression(), atom, depth + 1);
  if (Node.isTrueLiteral(node)) return true;
  if (Node.isFalseLiteral(node)) return false;
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.ExclamationToken) {
    const value = conditionValue(node.getOperand(), atom, depth + 1);
    return value === undefined ? undefined : !value;
  }
  if (Node.isBinaryExpression(node)) {
    const op = node.getOperatorToken().getKind();
    if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) {
      const left = conditionValue(node.getLeft(), atom, depth + 1);
      const decisive = op === SyntaxKind.BarBarToken;
      if (left === decisive) return decisive;
      const right = conditionValue(node.getRight(), atom, depth + 1);
      return left === undefined && right !== decisive ? undefined : right;
    }
  }
  const known = atom(node);
  if (known !== undefined || !Node.isIdentifier(node)) return known;
  const resolved = valueNode(node);
  if (resolved && resolved !== node) return conditionValue(resolved, atom, depth + 1);
}

// Keep both outcomes of an unproved condition. Only a rejection on every
// reachable path can remove a method from the handler's supported set.
function exits(node: Node | undefined, proof: RejectionProof): Exit {
  const statements = (nodes: Node[]) => {
    let result = Exit.Next;
    for (const statement of nodes) {
      if (!(result & Exit.Next)) break;
      result = (result & ~Exit.Next) | exits(statement, proof);
    }
    return result;
  };
  const branch = (condition: Node, yes: () => Exit, no: () => Exit) => {
    const test = conditionValue(condition, proof.condition);
    return test === true ? yes() : test === false ? no() : yes() | no();
  };
  const returned = (expression: Node | undefined): Exit => {
    const value = valueNode(expression);
    if (value && value === proof.forward) return Exit.Forwarded;
    if (Node.isConditionalExpression(value)) return branch(value.getCondition(),
      () => returned(value.getWhenTrue()), () => returned(value.getWhenFalse()));
    return responseRejects(expression, proof) ? Exit.Rejected : Exit.Other;
  };
  if (Node.isBlock(node)) return statements(node.getStatements());
  if (Node.isReturnStatement(node)) return returned(node.getExpression());
  if (Node.isThrowStatement(node)) {
    const value = valueNode(node.getExpression());
    if (proof.throws && Node.isNewExpression(value)) {
      const first = value.getArguments()[0];
      const code = valueNode(property(valueNode(first), 'statusCode') ?? first);
      if (Node.isNumericLiteral(code) && code.getLiteralValue() === 405) return Exit.Thrown;
    }
    return Exit.Other;
  }
  if (Node.isIfStatement(node)) return branch(node.getExpression(), () => exits(node.getThenStatement(), proof),
    () => exits(node.getElseStatement(), proof));
  if (Node.isTryStatement(node) && !node.getFinallyBlock()) {
    const block = exits(node.getTryBlock(), proof);
    const clause = node.getCatchClause();
    // A known 405 thrown from a guard can cross the catch if the handler
    // sends that status or otherwise sends an error response.
    if (!clause) return block;
    const caught = clause.getVariableDeclaration()?.getNameNode();
    const handler = exits(clause.getBlock(), { ...proof, caught, guard: undefined });
    return (block & ~Exit.Thrown) | (block & Exit.Thrown ? handler : 0);
  }
  if (Node.isSwitchStatement(node)) {
    if (!proof.switchValue?.(node.getExpression())) return Exit.Other | Exit.Next;
    const clauses = node.getClauses();
    const index = clauses.findIndex(clause => Node.isCaseClause(clause) && textValue(clause.getExpression()) === proof.method &&
      textValue(clause.getExpression()) !== undefined);
    if (clauses.some(clause => Node.isCaseClause(clause) && textValue(clause.getExpression()) === undefined)) return Exit.Other | Exit.Next;
    const start = index === -1 ? clauses.findIndex(Node.isDefaultClause) : index;
    const result = start === -1 ? Exit.Next : statements(clauses.slice(start).flatMap(clause => clause.getStatements()));
    return result & Exit.Break ? result & ~Exit.Break | Exit.Next : result;
  }
  if (Node.isBreakStatement(node)) return Exit.Break;
  if (Node.isExpressionStatement(node)) {
    const expression = node.getExpression();
    if (proof.forward && valueNode(expression) === proof.forward) return Exit.Forwarded;
    if (responseRejects(expression, proof)) return Exit.Rejected;
    return proof.guard?.(expression) ? Exit.Thrown : Exit.Next;
  }
  if (!node || Node.isVariableStatement(node) || Node.isFunctionDeclaration(node) || Node.isEmptyStatement(node)) return Exit.Next;
  if (Node.isExpression(node)) return returned(node);
  return Exit.Other | Exit.Next;
}

function methodTest(node: Node, isMethod: (node: Node) => boolean, read: (node: Node) => void) {
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    const equal = [SyntaxKind.EqualsEqualsToken, SyntaxKind.EqualsEqualsEqualsToken].includes(operator);
    if (!equal && ![SyntaxKind.ExclamationEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) return;
    const [left, right] = [node.getLeft(), node.getRight()];
    const value = isMethod(left) ? right : isMethod(right) ? left : undefined;
    if (!value) return;
    read(value);
    const name = textValue(value);
    if (name !== undefined) return (method: string | undefined) => (method === name) === equal;
  }
  if (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    const [argument] = node.getArguments();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'includes' || !argument || !isMethod(argument)) return;
    const values = valueNode(callee.getExpression());
    if (!Node.isArrayLiteralExpression(values)) return;
    const elements = values.getElements();
    elements.forEach(read);
    const names = elements.map(textValue);
    if (names.every(name => name !== undefined)) return (method: string | undefined) => method !== undefined && names.includes(method);
  }
}

function requestMethod(request: Node | undefined) {
  const requestSymbol = Node.isIdentifier(request) ? request.getSymbol() : undefined;
  const methodBinding = Node.isObjectBindingPattern(request) ? request.getElements().find(element =>
    (element.getPropertyNameNode() ?? element.getNameNode()).getText() === 'method')?.getNameNode().getSymbol() : undefined;
  return (input: Node): boolean => {
    const node = valueNode(input) ?? input;
    if (methodBinding && Node.isIdentifier(node)) return node.getSymbol() === methodBinding;
    if (!requestSymbol || (!Node.isPropertyAccessExpression(node) && !Node.isElementAccessExpression(node))) return false;
    const key = Node.isPropertyAccessExpression(node) ? node.getName() : textValue(node.getArgumentExpression());
    return key === 'method' && node.getExpression().getSymbol() === requestSymbol;
  };
}

function methodTable(call: CallExpression, workspace?: WorkspaceBindings) {
  const callee = call.getExpression();
  const factory = functionNode(callee) ?? functionNode(workspace?.resolve(callee));
  const table = valueNode(call.getArguments()[0]);
  const returned = executionSites(factory?.getBody()).returned;
  const handler = returned.length === 1 && !returned[0].possible ? functionNode(returned[0].node) : undefined;
  if (!factory || !handler || !Node.isObjectLiteralExpression(table) || table.getProperties().some(Node.isSpreadAssignment)) return;
  const tableBinding = factory.getParameters()[0]?.getNameNode().getSymbol();
  const [req, response] = handler.getParameters().map(parameter => parameter.getNameNode());
  const isMethod = requestMethod(req);
  const body = handler.getBody();
  if (!Node.isBlock(body) || !tableBinding) return;
  for (const statement of body.getStatements()) {
    if (!Node.isVariableStatement(statement)) continue;
    for (const entry of statement.getDeclarations()) {
      let lookup = valueNode(entry.getInitializer());
      if (Node.isPropertyAccessExpression(lookup) && lookup.getName() === 'default') {
        lookup = valueNode(lookup.getExpression());
      }
      if (!Node.isElementAccessExpression(lookup) || lookup.getExpression().getSymbol() !== tableBinding) continue;
      const key = lookup.getArgumentExpression();
      const selected = entry.getNameNode().getSymbol();
      if (!key || !isMethod(key) || !selected || entry.getVariableStatement()?.getDeclarationKind() !== 'const') continue;
      const invokesSelected = executionSites(body).calls.some(({ node }) =>
        node.getExpression().getSymbol() === selected && node.getArguments()[0]?.getSymbol() === req?.getSymbol());
      if (!invokesSelected) continue;
      const missing = exits(body, {
        response,
        condition: node => node.getSymbol() === selected ? false : undefined
      });
      if (missing === Exit.Rejected) {
        const names = table.getProperties().flatMap(member => 'getName' in member ? [member.getName()] : []);
        return HTTP_METHODS.filter(method => names.includes(method));
      }
    }
  }
}

export function pagesMethods(source: SourceFile, workspace?: WorkspaceBindings): Pick<RouteNode, 'methods' | 'methodBasis' | 'observedMethods' | 'issue'> | undefined {
  const exported = source.getExportedDeclarations().get('default');
  const assignment = source.getExportAssignments().find(node => !node.isExportEquals());
  const defaults = exported?.length ? exported : assignment ? [assignment] : [];
  if (!defaults.length) {
    const unresolved = source.getExportDeclarations().some(declaration => declaration.hasModuleSpecifier() &&
      !declaration.isTypeOnly() && declaration.getNamedExports().some(specifier =>
        !specifier.isTypeOnly() && (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === 'default') &&
      !declaration.getModuleSpecifierSourceFile());
    return unresolved ? { methods: ['ALL'], issue: 'API default re-export unresolved' } : undefined;
  }
  let possible = false;
  let runtime = false;
  const methods = new Set<string>();
  const enforced: (string[] | undefined)[] = [];
  let methodUncertain = false;
  for (const declaration of defaults) {
    let handler = valueNode(declaration);
    if (Node.isCallExpression(handler)) {
      const table = methodTable(handler, workspace);
      if (table?.length) return { methods: table, methodBasis: 'enforced' };
    }
    const forwarded = Node.isCallExpression(handler) ? forwardedRequest(handler) : undefined;
    if (forwarded) handler = forwarded.callback;
    if (!Node.isFunctionDeclaration(handler) && !Node.isArrowFunction(handler) &&
        !Node.isFunctionExpression(handler)) {
      possible ||= Node.isCallExpression(handler) || Node.isIdentifier(handler) &&
        !handler.getSymbol()?.getDeclarations().some(Node.isVariableDeclaration);
      continue;
    }
    runtime = true;
    const [req, res] = handler.getParameters().map(parameter => parameter.getNameNode());
    const request = forwarded?.request ?? req;
    const response = forwarded?.response ?? res;
    const isMethod = requestMethod(request);
    const observed = new Set<string>();
    let readsMethod = false;
    let writesMethod = false;
    const collect = (node: Node) => {
      const text = textValue(node);
      if (text !== undefined) observed.add(text);
    };
    const visit = (node: Node, traversal?: { skip(): void }) => {
      if (Node.isFunctionLikeDeclaration(node)) {
        traversal?.skip();
        return;
      }
      if (Node.isSwitchStatement(node) && isMethod(node.getExpression())) {
        for (const clause of node.getClauses()) if (Node.isCaseClause(clause)) collect(clause.getExpression());
      }
      if ((Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node) || Node.isIdentifier(node)) &&
        isMethod(node)) readsMethod = true;
      if (Node.isBinaryExpression(node)) {
        const operator = node.getOperatorToken().getKind();
        if (operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment && isMethod(node.getLeft())) {
          writesMethod = true;
        }
      }
      methodTest(node, isMethod, collect);
    };
    const body = handler.getBody();
    if (!body) continue;
    visit(body);
    body.forEachDescendant(visit);
    const localGuard = (expression: Node) => {
      const value = valueNode(expression);
      if (!Node.isCallExpression(value) || value.getArguments()[0]?.getSymbol() !== request?.getSymbol() ||
        !request?.getSymbol()) return;
      const guard = functionNode(value.getExpression());
      if (!guard || guard.getSourceFile() !== handler.getSourceFile() ||
        guard.isAsync() && !Node.isAwaitExpression(expression)) return;
      return guard;
    };
    // A same-file helper can enforce a guard by throwing through its caller.
    for (const { node } of executionSites(body).calls) {
      const guard = localGuard(node);
      const guardMethod = guard && requestMethod(guard.getParameters()[0]?.getNameNode());
      if (guardMethod) guard.getBody()?.forEachDescendant((child, walk) => {
        if (Node.isFunctionLikeDeclaration(child)) walk.skip();
        else methodTest(child, guardMethod, collect);
      });
    }
    for (const method of observed) methods.add(method);
    if (writesMethod || !readsMethod && !observed.size) {
      methodUncertain ||= writesMethod;
      enforced.push(undefined);
      continue;
    }
    const proof = (method?: string) =>
      exits(body, {
        method, response, switchValue: isMethod,
        condition: node => methodTest(node, isMethod, () => undefined)?.(method),
        guard: expression => {
          const guard = localGuard(expression);
          if (!guard) return false;
          const guardMethod = requestMethod(guard.getParameters()[0]?.getNameNode());
          return exits(guard.getBody(), {
            throws: true, method,
            condition: node => methodTest(node, guardMethod, () => undefined)?.(method)
          }) === Exit.Thrown;
        }
      });
    const other = proof();
    const rejected = (result: Exit) => !!result && !(result & ~(Exit.Rejected | Exit.Thrown));
    if (observed.size && rejected(other) && [...observed].every(method => HTTP_METHODS.includes(method) || rejected(proof(method)))) {
      enforced.push(HTTP_METHODS.filter(method => !rejected(proof(method))));
    } else {
      methodUncertain ||= !!(other & (Exit.Rejected | Exit.Thrown));
      enforced.push(undefined);
    }
  }
  const supported = HTTP_METHODS.filter(method => methods.has(method));
  // Preflight and HEAD fast paths can coexist with an unrestricted downstream handler.
  if (!runtime && !possible) return;
  if (!possible && enforced.length && enforced.every(value => value?.length)) {
    return { methods: HTTP_METHODS.filter(method => enforced.some(value => value?.includes(method))), methodBasis: 'enforced' };
  }
  return { methods: ['ALL'], observedMethods: supported.length ? supported : undefined,
    issue: possible ? 'API handler factory or re-export unresolved' :
      methodUncertain ? 'Pages API method enforcement unresolved' : undefined };
}
