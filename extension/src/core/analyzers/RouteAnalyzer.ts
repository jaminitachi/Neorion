import { CallExpression, Node, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import type { RouteNode } from '../types/GraphTypes';
import type { NextConfig } from './NextConfig';
import { functionNode, returns, valueNode } from './StaticBindings';
import type { WorkspaceBindings } from './WorkspaceBindings';
import { DomainExtractor } from '../utils/DomainExtractor';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

export function isClientFile(file: SourceFile): boolean {
  return hasDirective(file.getStatements(), 'use client');
}

export function hasDirective(statements: Node[], directive: string): boolean {
  for (const statement of statements) {
    if (!Node.isExpressionStatement(statement)) return false;
    const expression = statement.getExpression();
    if (!Node.isStringLiteral(expression)) return false;
    if (expression.getLiteralText() === directive) return true;
  }
  return false;
}

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
      const request = wrapper.getParameters()[0]?.getNameNode().getSymbol();
      if (!request) continue;
      const invocation = wrapper.getBody().getDescendantsOfKind(SyntaxKind.CallExpression).find(node =>
        node.getExpression().getSymbol() === parameter);
      const context = invocation?.getArguments()[0];
      if (!Node.isObjectLiteralExpression(context)) continue;
      const properties = context.getProperties();
      // A final shorthand property forwards the request even when the context has spreads.
      for (const element of binding.getElements()) {
        const key = (element.getPropertyNameNode() ?? element.getNameNode()).getText();
        const property = properties.slice().reverse().find(item =>
          Node.isSpreadAssignment(item) || ('getName' in item && item.getName() === key));
        if (Node.isShorthandPropertyAssignment(property) && property.getValueSymbol() === request) {
          return { callback, request: element.getNameNode() };
        }
      }
    }
  }
}

function methodTable(call: CallExpression, workspace?: WorkspaceBindings) {
  const callee = call.getExpression();
  const factory = functionNode(callee) ?? functionNode(workspace?.resolve(callee));
  const table = valueNode(call.getArguments()[0]);
  const returned = returns(factory?.getBody());
  const handler = returned.length === 1 ? functionNode(returned[0]) : undefined;
  if (!factory || !handler || !Node.isObjectLiteralExpression(table) || table.getProperties().some(Node.isSpreadAssignment)) return;
  const tableBinding = factory.getParameters()[0]?.getNameNode().getSymbol();
  const [req, res] = handler.getParameters().map(parameter => parameter.getNameNode().getSymbol());
  const body = handler.getBody();
  const lookup = body?.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).find(node => {
    let key = node.getArgumentExpression();
    while (Node.isAsExpression(key)) key = key.getExpression();
    return node.getExpression().getSymbol() === tableBinding && Node.isPropertyAccessExpression(key) &&
      key.getName() === 'method' && key.getExpression().getSymbol() === req;
  });
  const select = lookup?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getNameNode().getSymbol();
  if (!select || !res || !body?.getDescendantsOfKind(SyntaxKind.IfStatement).some(branch => {
    const condition = branch.getExpression();
    return Node.isPrefixUnaryExpression(condition) && condition.getOperatorToken() === SyntaxKind.ExclamationToken &&
      condition.getOperand().getSymbol() === select && branch.getThenStatement().getDescendantsOfKind(SyntaxKind.CallExpression)
        .some(call => {
          const member = call.getExpression();
          return Node.isPropertyAccessExpression(member) && member.getName() === 'status' &&
            member.getExpression().getSymbol() === res && call.getArguments()[0]?.getText() === '405' &&
            !!call.getFirstAncestorByKind(SyntaxKind.ReturnStatement);
        });
  })) return;
  const names = table.getProperties().flatMap(member => 'getName' in member ? [member.getName()] : []);
  return HTTP_METHODS.filter(method => names.includes(method));
}

function pagesMethods(source: SourceFile, workspace?: WorkspaceBindings): Pick<RouteNode, 'methods' | 'methodBasis' | 'observedMethods' | 'issue'> | undefined {
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
  let rejectsMethods = false;
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
    const request = forwarded?.request ?? handler.getParameters()[0]?.getNameNode();
    const requestSymbol = Node.isIdentifier(request) ? request.getSymbol() : undefined;
    const methodBinding = Node.isObjectBindingPattern(request) ? request.getElements().find(element =>
      (element.getPropertyNameNode() ?? element.getNameNode()).getText() === 'method')
      ?.getNameNode().getSymbol() : undefined;
    const isMethod = (node: Node) => {
      if (methodBinding && Node.isIdentifier(node)) return node.getSymbol() === methodBinding;
      if (!requestSymbol || (!Node.isPropertyAccessExpression(node) && !Node.isElementAccessExpression(node))) return false;
      const argument = Node.isElementAccessExpression(node) ? node.getArgumentExpression() : undefined;
      const key = Node.isPropertyAccessExpression(node) ? node.getName() :
        Node.isStringLiteral(argument) ? argument.getLiteralText() : undefined;
      return key === 'method' && node.getExpression().getSymbol() === requestSymbol;
    };
    const collect = (node: Node) => {
      if (Node.isStringLiteral(node)) methods.add(node.getLiteralText());
    };
    const visit = (node: Node, traversal?: { skip(): void }) => {
      if (Node.isFunctionLikeDeclaration(node)) {
        traversal?.skip();
        return;
      }
      if (Node.isSwitchStatement(node) && isMethod(node.getExpression())) {
        for (const clause of node.getClauses()) {
          if (Node.isCaseClause(clause)) collect(clause.getExpression());
        }
      }
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        const [argument] = node.getArguments();
        if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'status' &&
            Node.isNumericLiteral(argument) && argument.getLiteralValue() === 405) rejectsMethods = true;
        if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'includes' &&
            argument && isMethod(argument)) {
          const values = callee.getExpression();
          if (Node.isArrayLiteralExpression(values)) values.getElements().forEach(collect);
        }
      }
      if (Node.isBinaryExpression(node) && [
        SyntaxKind.EqualsEqualsToken, SyntaxKind.EqualsEqualsEqualsToken,
        SyntaxKind.ExclamationEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken
      ].includes(node.getOperatorToken().getKind())) {
        if (isMethod(node.getLeft())) collect(node.getRight());
        if (isMethod(node.getRight())) collect(node.getLeft());
      }
    };
    const body = handler.getBody();
    if (body) {
      visit(body);
      body.forEachDescendant(visit);
      // A directly called same-file guard must reject the other methods.
      const calls = Node.isBlock(body) ? body.getStatements().flatMap(statement =>
        Node.isTryStatement(statement) ? statement.getTryBlock().getStatements() : [statement]) : [];
      for (const statement of calls) {
        const call = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined;
        if (!Node.isCallExpression(call) || !requestSymbol || call.getArguments()[0]?.getSymbol() !== requestSymbol) continue;
        const guard = functionNode(call.getExpression());
        const guardBody = guard?.getBody();
        if (!guard || guard.getSourceFile() !== handler.getSourceFile() || !Node.isBlock(guardBody)) continue;
        const guardReq = guard.getParameters()[0]?.getNameNode().getSymbol();
        for (const branch of guardBody.getStatements().filter(Node.isIfStatement)) {
          const test = branch.getExpression();
          if (!Node.isBinaryExpression(test) || ![SyntaxKind.ExclamationEqualsEqualsToken, SyntaxKind.ExclamationEqualsToken].includes(test.getOperatorToken().getKind())) continue;
          const [left, right] = [test.getLeft(), test.getRight()];
          if (!Node.isPropertyAccessExpression(left) || left.getName() !== 'method' ||
            left.getExpression().getSymbol() !== guardReq || !Node.isStringLiteral(right)) continue;
          const rejected = branch.getThenStatement();
          const throws = Node.isThrowStatement(rejected) ? [rejected] :
            Node.isBlock(rejected) ? rejected.getStatements().filter(Node.isThrowStatement) : [];
          if (throws.some(node => node.getDescendantsOfKind(SyntaxKind.NumericLiteral).some(value => value.getLiteralValue() === 405))) {
            rejectsMethods = true;
            collect(right);
          }
        }
      }
    }
  }
  const supported = HTTP_METHODS.filter(method => methods.has(method));
  // Preflight and HEAD fast paths can coexist with an unrestricted downstream handler.
  if (!runtime && !possible) return;
  if (rejectsMethods && supported.length) return { methods: supported, methodBasis: 'enforced' };
  return { methods: ['ALL'], observedMethods: supported.length ? supported : undefined,
    issue: possible ? 'API handler factory or re-export unresolved' : undefined };
}

export class RouteAnalyzer {
  constructor(private readonly appDir: string, private readonly pagesDir: string, private readonly root: string,
    private readonly config?: NextConfig, private readonly workspace?: WorkspaceBindings) {}

  public analyze(files: SourceFile[], staticMetadata: string[]): RouteNode[] {
    const routes = [
      ...files.flatMap(file => this.analyzeFile(file.getFilePath(), file) ?? []),
      ...staticMetadata.flatMap(file => this.analyzeFile(file) ?? [])
    ];
    const app = path.relative(this.root, this.appDir).split(path.sep).join('/') + '/';
    const pages = routes.filter(route => route.type === 'page' && route.file.startsWith(app));
    for (const layout of routes.filter(route => route.type === 'layout' || route.type === 'template')) {
      const directory = layout.file.slice(0, layout.file.lastIndexOf('/') + 1);
      layout.wraps = pages.filter(page => page.file.startsWith(directory)).map(page => page.id);
    }
    return routes;
  }

  private analyzeFile(filePath: string, source?: SourceFile): RouteNode | undefined {
    const file = path.relative(this.root, filePath).split(path.sep).join('/');
    const pagesRelative = path.relative(this.pagesDir, filePath);
    if (!path.isAbsolute(pagesRelative) && !pagesRelative.startsWith('..' + path.sep)) {
      const parts = pagesRelative.split(path.sep);
      const filename = parts.pop()!;
      const extensions = this.config?.extensions ?? ['tsx', 'ts', 'jsx', 'js'];
      const extension = [...extensions].sort((a, b) => b.length - a.length).find(ext => filename.endsWith('.' + ext));
      if (!extension) return;
      const name = filename.slice(0, -extension.length - 1);
      if (!parts.length && /^_(app|document|error)$/.test(name)) return;
      const type = parts[0] === 'api' ? 'api' : 'page';
      const api = type === 'api' && source ? pagesMethods(source, this.workspace) : undefined;
      if (type === 'api' && !api) return;
      if (name !== 'index') parts.push(name);
      return {
        id: `route:${file}`, file, type,
        pages: true, ...api,
        path: '/' + parts.join('/'), isClient: !!source && isClientFile(source),
        domain: DomainExtractor.extract('/' + file)
      };
    }

    const relative = path.relative(this.appDir, filePath);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) ||
        parts[0] === '..' || parts.some(part => part.startsWith('_'))) return;

    const filename = parts.pop()!;
    const match = /^(page|layout|loading|error|not-found|route|robots|sitemap|opengraph-image|template|default|global-error)\.[jt]sx?$/.exec(filename)
      ?? /^(opengraph-image)\.(?:png|jpg|jpeg|gif)$/.exec(filename)
      ?? /^(sitemap)\.xml$/.exec(filename)
      ?? (parts.length === 0 ? /^(robots)\.txt$/.exec(filename) : null);
    if (!match) return;
    const type = (match[1] === 'route' ? 'api' : match[1]) as RouteNode['type'];
    const exports = type === 'api' && source ? source.getExportSymbols().map(symbol => symbol.getName()) : [];
    const segments: string[] = [];
    for (const part of parts) {
      if (part.startsWith('@') || /^\([^()]+\)$/.test(part)) continue;
      const intercept = /^(\(\.\.\.\)|(?:\(\.\.\))+|\(\.\))(.+)$/.exec(part);
      if (intercept) {
        const marker = intercept[1];
        if (marker === '(...)') segments.length = 0;
        else if (marker.startsWith('(..)')) segments.splice(Math.max(0, segments.length - marker.length / 4));
        segments.push(intercept[2]);
      } else {
        segments.push(part.replace(/^%5[fF]/, '_'));
      }
    }

    if (type === 'robots') segments.push('robots.txt');
    if (type === 'sitemap') segments.push('sitemap.xml');
    if (type === 'opengraph-image') segments.push(filename.replace(/\.[jt]sx?$/, ''));
    const layoutScope = '/' + parts.join('/');
    const routePath = '/' + segments.join('/');
    return {
      scope: type === 'layout' && layoutScope !== routePath ? layoutScope : undefined,
      id: `route:${file}`,
      path: routePath,
      file,
      type,
      methods: type === 'api' ? HTTP_METHODS.filter(method => exports.includes(method)) : undefined,
      isClient: !!source && isClientFile(source),
      domain: DomainExtractor.extract('/' + file)
    };
  }
}
