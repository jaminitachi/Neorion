import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Node, Project, SourceFile, SyntaxKind } from 'ts-morph';
import type { NextUrlConfig } from './NextRouteMatch';
import { functionNode, returns, valueNode } from './StaticBindings';

export type NextConfig = {
  url: NextUrlConfig;
  extensions?: string[];
  rules: { kind: 'redirect' | 'rewrite'; source: string; destination: string; site: Node; conditional: boolean }[];
  issues: string[];
};

export function property(object: Node | undefined, name: string) {
  const member = Node.isObjectLiteralExpression(object) ? object.getProperty(name) : undefined;
  if (Node.isPropertyAssignment(member)) return member.getInitializer();
  if (Node.isShorthandPropertyAssignment(member)) return member.getNameNode();
  return member;
}

export function textValue(node: Node | undefined) {
  const value = valueNode(node);
  return Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value) ? value.getLiteralText() : undefined;
}

function strings(node: Node | undefined) {
  const array = valueNode(node);
  if (!Node.isArrayLiteralExpression(array)) return;
  const elements = array.getElements().map(textValue);
  if (elements.every((value): value is string => value !== undefined)) return elements;
}

export function readNextConfig(root: string, files: SourceFile[]): NextConfig {
  const result: NextConfig = { url: {}, rules: [], issues: [] };
  const file = ['js', 'mjs', 'ts', 'cjs'].map(ext => path.join(root, 'next.config.' + ext)).find(existsSync);
  if (!file) return result;
  const source = files.find(source => source.getFilePath() === file) ?? new Project({ compilerOptions: { allowJs: true } }).addSourceFileAtPath(file);
  const exported = source.getExportedDeclarations().get('default')?.[0] ??
    source.getStatements().flatMap(statement => {
      const expression = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined;
      return Node.isBinaryExpression(expression) && expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
        expression.getLeft().getText() === 'module.exports' ? [expression.getRight()] : [];
    })[0];
  let config = valueNode(exported);
  if (!Node.isObjectLiteralExpression(config)) {
    // Read the static base object behind a plugin chain. The final config can
    // still differ, so keep that fact separate from supported literal settings.
    result.issues.push('dynamic next.config');
    const fn = functionNode(config);
    const returned = returns(fn?.getBody());
    if (returned.length === 1) config = valueNode(returned[0]);
    for (let depth = 0; depth < 8 && Node.isCallExpression(config); depth++) {
      const callee = config.getExpression();
      const index = Node.isPropertyAccessExpression(callee) && callee.getName() === 'reduce' ? 1 : 0;
      config = valueNode(config.getArguments()[index]);
    }
    if (!Node.isObjectLiteralExpression(config)) return result;
  }
  if (config.getProperties().some(Node.isSpreadAssignment)) result.issues.push('next.config spreads unresolved');
  const extensions = property(config, 'pageExtensions');
  const basePath = property(config, 'basePath');
  const i18n = property(config, 'i18n');
  const trailingSlash = valueNode(property(config, 'trailingSlash'));
  result.extensions = strings(extensions);
  result.url.basePath = textValue(basePath);
  result.url.locales = strings(property(valueNode(i18n), 'locales'));
  if (trailingSlash?.getKind() === SyntaxKind.TrueKeyword || trailingSlash?.getKind() === SyntaxKind.FalseKeyword) {
    result.url.trailingSlash = trailingSlash.getKind() === SyntaxKind.TrueKeyword;
  }
  if (extensions && !result.extensions) result.issues.push('dynamic next.config pageExtensions');
  if (basePath && result.url.basePath === undefined) result.issues.push('dynamic next.config basePath');
  if (i18n && !result.url.locales) result.issues.push('dynamic next.config locales');
  if (trailingSlash && result.url.trailingSlash === undefined) result.issues.push('dynamic next.config trailingSlash');
  for (const kind of ['redirect', 'rewrite'] as const) {
    const member = valueNode(property(config, kind + 's'));
    if (!member) continue;
    const body = Node.isMethodDeclaration(member) || Node.isArrowFunction(member) || Node.isFunctionExpression(member)
      ? member.getBody() : undefined;
    const returned = returns(body);
    const value = returned.length === 1 ? valueNode(returned[0]) : undefined;
    const lists = Node.isObjectLiteralExpression(value) && kind === 'rewrite'
      ? ['beforeFiles', 'afterFiles', 'fallback'].flatMap(key => {
        const entry = property(value, key);
        return entry ? [valueNode(entry)] : [];
      }) : [value];
    for (const list of lists) {
      if (!Node.isArrayLiteralExpression(list) || list !== returned[0] && !Node.isObjectLiteralExpression(value)) {
        result.issues.push('dynamic next.config ' + kind + 's');
        continue;
      }
      for (const row of list.getElements()) {
        const source = textValue(property(row, 'source'));
        const destination = textValue(property(row, 'destination'));
        if (source && destination && !/(?:^|\/)\:[\w]+/.test(destination)) {
          result.rules.push({ kind, source, destination, site: row, conditional: !!(property(row, 'has') || property(row, 'missing')) });
        } else result.issues.push('dynamic next.config ' + kind + 's');
      }
    }
  }
  return result;
}
