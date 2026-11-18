import { CallExpression, Node, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import type { RouteNode } from '../types/GraphTypes';
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

function pagesMethods(source?: SourceFile): string[] {
  const methods = new Set<string>();
  let rejectsMethods = false;
  for (const declaration of source?.getExportedDeclarations().get('default') ?? []) {
    let handler: Node | undefined = declaration;
    if (Node.isVariableDeclaration(handler)) handler = handler.getInitializer();
    if (Node.isExportAssignment(handler)) handler = handler.getExpression();
    const forwarded = Node.isCallExpression(handler) ? forwardedRequest(handler) : undefined;
    if (forwarded) handler = forwarded.callback;
    if (!Node.isFunctionDeclaration(handler) && !Node.isArrowFunction(handler) &&
        !Node.isFunctionExpression(handler)) continue;
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
    }
  }
  const supported = HTTP_METHODS.filter(method => methods.has(method));
  // Preflight and HEAD fast paths can coexist with an unrestricted downstream handler.
  if (!rejectsMethods && supported.every(method => method === 'OPTIONS' || method === 'HEAD')) return ['ALL'];
  return supported.length ? supported : ['ALL'];
}

export class RouteAnalyzer {
  constructor(private readonly appDir: string, private readonly pagesDir: string, private readonly root: string) {}

  public analyze(files: SourceFile[], staticMetadata: string[]): RouteNode[] {
    const routes = [
      ...files.flatMap(file => this.analyzeFile(file.getFilePath(), file) ?? []),
      ...staticMetadata.flatMap(file => this.analyzeFile(file) ?? [])
    ];
    const app = path.relative(this.root, this.appDir).split(path.sep).join('/') + '/';
    const pages = routes.filter(route => route.type === 'page' && route.file.startsWith(app));
    for (const layout of routes.filter(route => route.type === 'layout')) {
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
      const match = /^(.*)\.[jt]sx?$/.exec(filename);
      if (!match || /^_(app|document|error)$/.test(match[1])) return;
      const type = parts[0] === 'api' ? 'api' : 'page';
      if (match[1] !== 'index') parts.push(match[1]);
      return {
        id: `route:${file}`, file, type,
        methods: type === 'api' ? pagesMethods(source) : undefined,
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
