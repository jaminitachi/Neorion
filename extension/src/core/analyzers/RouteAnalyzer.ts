import { Node, SourceFile } from 'ts-morph';
import * as path from 'path';
import type { RouteNode } from '../types/GraphTypes';
import type { NextConfig } from './NextConfig';
import { HTTP_METHODS, pagesMethods } from './PagesApiMethods';
import type { WorkspaceBindings } from './WorkspaceBindings';
import { DomainExtractor } from '../utils/DomainExtractor';

export { HTTP_METHODS } from './PagesApiMethods';

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

export class RouteAnalyzer {
  constructor(private readonly appDir: string, private readonly pagesDir: string, private readonly root: string,
    private readonly config?: NextConfig, private readonly workspace?: WorkspaceBindings, private readonly appConfig?: NextConfig) {}

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
    const pageExtension = (this.appConfig?.extensions ?? ['js', 'jsx', 'ts', 'tsx'])
      .some(ext => filename === 'page.' + ext);
    const match = (pageExtension ? [filename, 'page'] : null)
      ?? /^(layout|loading|error|not-found|route|robots|sitemap|opengraph-image|template|default|global-error)\.[jt]sx?$/.exec(filename)
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
