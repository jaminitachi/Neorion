import { Node, SourceFile } from 'ts-morph';
import * as path from 'path';
import type { RouteNode } from '../types/GraphTypes';
import { DomainExtractor } from '../utils/DomainExtractor';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

export function isClientFile(file: SourceFile): boolean {
  for (const statement of file.getStatements()) {
    if (!Node.isExpressionStatement(statement)) return false;
    const expression = statement.getExpression();
    if (!Node.isStringLiteral(expression)) return false;
    if (expression.getLiteralText() === 'use client') return true;
  }
  return false;
}

export class RouteAnalyzer {
  constructor(private readonly appDir: string, private readonly root: string) {}

  public analyzeFile(source: SourceFile): RouteNode | undefined {
    const filePath = source.getFilePath();
    const relative = path.relative(this.appDir, filePath);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) ||
        parts[0] === '..' || parts.some(part => part.startsWith('_'))) return;

    const filename = parts.pop()!;
    const match = /^(page|layout|loading|error|not-found|route)\.[jt]sx?$/.exec(filename);
    if (!match) return;
    const type = (match[1] === 'route' ? 'api' : match[1]) as RouteNode['type'];
    const file = path.relative(this.root, filePath).split(path.sep).join('/');
    const exports = type === 'api' ? source.getExportSymbols().map(symbol => symbol.getName()) : [];
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

    return {
      id: `route:${file}`,
      path: '/' + segments.join('/'),
      file,
      type,
      methods: type === 'api' ? HTTP_METHODS.filter(method => exports.includes(method)) : undefined,
      isClient: isClientFile(source),
      domain: DomainExtractor.extract('/' + file)
    };
  }
}
