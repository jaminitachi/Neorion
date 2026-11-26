import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import path from 'node:path';
import { bindingOf, valueNode } from '../../analyzers/StaticBindings';
import { fileRoutes } from './FileRoutes';
import { booleanValue, frameworkBinding, properties, stringList, stringValue } from './StaticConfig';
import { type Issue, type Registration, trimPath } from './RouteTypes';

export function defaultValue(source: SourceFile | undefined) {
  const assignment = source?.getExportAssignments()[0];
  if (assignment) return assignment.getExpression();
  const common = source?.getStatements().find(statement => Node.isExpressionStatement(statement) &&
    /^module\.exports\s*=/.test(statement.getText()));
  if (Node.isExpressionStatement(common)) {
    const expression = common.getExpression();
    if (Node.isBinaryExpression(expression)) return expression.getRight();
  }
  return source?.getExportedDeclarations().get('default')?.[0];
}

export function readRouteConfig(source: SourceFile, app: string, issue: Issue): Registration[] {
  const checked = new Set<Node>();
  const definition = (node: Node | undefined) => {
    const value = valueNode(node);
    const declaration = bindingOf(node);
    const name = Node.isVariableDeclaration(declaration) ? declaration.getNameNode() : undefined;
    if (Node.isIdentifier(name) && !checked.has(name) && (Node.isArrayLiteralExpression(value) || Node.isObjectLiteralExpression(value))) {
      checked.add(name);
      for (const ref of name.findReferencesAsNodes()) {
        const parent = ref.getParent();
        const assign = Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)
          ? parent.getParentIfKind(SyntaxKind.BinaryExpression) : undefined;
        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref &&
            ['push', 'pop', 'sort', 'reverse', 'splice', 'shift', 'unshift', 'fill', 'copyWithin'].includes(parent.getName()) ||
            assign && assign.getLeft() === parent && assign.getOperatorToken().getKind() === SyntaxKind.EqualsToken ||
            Node.isCallExpression(parent) && parent.getArguments().includes(ref) &&
              !['route', 'layout', 'prefix'].includes(frameworkBinding(parent.getExpression())?.name ?? '')) {
          issue(ref, 'route config is mutated at runtime');
        }
      }
    }
    return value;
  };
  const prefix = (part: string, routes: Registration[]): Registration[] => routes.map(route =>
    route.index || route.path !== undefined ? { ...route, path: [trimPath(part), trimPath(route.path ?? '')].filter(Boolean).join('/') } :
      { ...route, children: route.children && prefix(part, route.children) });
  const files = (call: import('ts-morph').CallExpression, auto: boolean): Registration[] => {
    const argument = call.getArguments()[0];
    const opts = argument ? properties(definition(argument)) : new Map<string, Node>();
    if (!opts) {
      issue(call, 'dynamic file route options');
      return [];
    }
    const accepted = auto ? ['routesDir', 'paramChar', 'colocationChar', 'ignoredRouteFiles'] : ['rootDirectory', 'ignoredRouteFiles'];
    if ([...opts.keys()].some(key => !accepted.includes(key))) {
      issue(call, 'unsupported file route options');
      return [];
    }
    const directory = stringValue(opts.get(auto ? 'routesDir' : 'rootDirectory')) ?? (opts.has(auto ? 'routesDir' : 'rootDirectory') ? undefined : 'routes');
    const ignored = opts.has('ignoredRouteFiles') ? stringList(opts.get('ignoredRouteFiles')) : [];
    const param = opts.has('paramChar') ? stringValue(opts.get('paramChar')) : '$';
    const colocation = opts.has('colocationChar') ? stringValue(opts.get('colocationChar')) : '+';
    if (directory === undefined || !ignored || param?.length !== 1 || !colocation) {
      issue(call, 'dynamic or unsupported file route options');
      return [];
    }
    return fileRoutes(app, { directory, ignored, auto: auto ? { param, colocation } : undefined }, call, issue);
  };
  const walk = (input: Node | undefined, stack = new Set<Node>(), single = false): Registration[] => {
    const node = definition(input);
    if (!node || stack.has(node) || stack.size >= 32) {
      issue(input ?? source, 'route config cannot be statically resolved');
      return [];
    }
    stack = new Set(stack).add(node);
    if (Node.isArrayLiteralExpression(node) && !single) return node.getElements().flatMap(entry =>
      Node.isSpreadElement(entry) ? walk(entry.getExpression(), stack) : walk(entry, stack, true));
    if (Node.isConditionalExpression(node)) {
      const choice = booleanValue(node.getCondition());
      if (choice !== undefined) return walk(choice ? node.getWhenTrue() : node.getWhenFalse(), stack, single);
      issue(node, 'conditional route registration');
      return [];
    }
    let id: Node | undefined;
    let module: Node | undefined;
    let routePath: Node | undefined;
    let index: boolean | undefined;
    let sensitive: Node | undefined;
    let children: Node | undefined;
    if (Node.isObjectLiteralExpression(node) && single) {
      const opts = properties(node);
      if (opts) {
        module = opts.get('file');
        id = opts.get('id');
        routePath = opts.get('path');
        index = booleanValue(opts.get('index'));
        sensitive = opts.get('caseSensitive');
        children = opts.get('children');
        if (opts.has('index') && index === undefined) module = undefined;
      }
    } else if (Node.isCallExpression(node)) {
      const binding = frameworkBinding(node.getExpression());
      if (!single && binding?.module === '@react-router/fs-routes' && binding.name === 'flatRoutes') return files(node, false);
      if (!single && binding?.module === 'react-router-auto-routes' && ['autoRoutes', 'default'].includes(binding.name)) return files(node, true);
      if (binding?.module === '@react-router/dev/routes') {
        const args = node.getArguments();
        if (binding.name === 'prefix' && !single) {
          const part = stringValue(args[0]);
          if (part !== undefined) return prefix(part, walk(args[1], stack));
        }
        const helper = binding.name;
        if (single && ['route', 'layout', 'index'].includes(helper)) {
          const [first, tail, next, last] = args;
          module = helper === 'route' ? tail : first;
          routePath = helper === 'route' ? first : undefined;
          const optionOrChildren = helper === 'route' ? next : tail;
          const optionValue = definition(optionOrChildren);
          const opts = properties(optionValue);
          const array = Node.isArrayLiteralExpression(optionValue) || Node.isConditionalExpression(optionValue) ||
            Node.isCallExpression(optionValue) && frameworkBinding(optionValue.getExpression())?.name === 'prefix';
          const absent = !optionValue || Node.isNullLiteral(optionValue) || Node.isIdentifier(optionValue) && optionValue.getText() === 'undefined';
          if (!opts && !absent && (!array || helper === 'index')) {
            issue(node, 'route options or children unresolved');
            return [];
          }
          children = helper === 'index' ? undefined : array ? optionOrChildren : helper === 'route' ? last : next;
          id = opts?.get('id');
          index = helper === 'index' || (helper === 'route' && booleanValue(opts?.get('index')));
          sensitive = helper === 'route' ? opts?.get('caseSensitive') : undefined;
          if (helper === 'route' && opts?.has('index') && index === undefined) module = undefined;
        }
      }
    }
    const file = stringValue(module);
    const pathname = stringValue(routePath);
    const routeId = stringValue(id);
    const caseSensitive = booleanValue(sensitive);
    const pathValue = valueNode(routePath);
    if (!file || !single || id && !routeId || routePath && pathname === undefined && !Node.isNullLiteral(pathValue) && !(Node.isIdentifier(pathValue) && pathValue.getText() === 'undefined') ||
        sensitive && caseSensitive === undefined || index && children) {
      issue(node, 'dynamic or unsupported route registration');
      return [];
    }
    return [{ id: routeId ?? path.posix.normalize(file).replace(/\.[^/.]+$/, ''), file, path: pathname, index,
      caseSensitive, site: node, children: children && walk(children, stack) }];
  };
  return walk(defaultValue(source));
}
