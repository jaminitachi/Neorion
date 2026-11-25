import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { RouteNode } from '../types/GraphTypes';
import type { PagesEdge } from '../../mcp/Index';
import { declarationsOf, urlTexts } from './ArchitectureFacts';
import { matchNextRoutes, normalizeNextUrl, routeSegments, segmentRank } from './NextRouteMatch';
import { property, textValue, type NextConfig } from './NextConfig';
import { bindingOf, functionNode, importBinding, returns, valueNode } from './StaticBindings';
import { visitKinds } from './CompilerWalk';
import type { WorkspaceBindings } from './WorkspaceBindings';

export type PagesDependency = {
  route?: string;
  owner?: Node;
  target?: Node;
  destination?: string;
  kind: PagesEdge['kind'];
  site: Node;
  detail?: string;
  possible?: boolean;
};

const dataPhases = new Map([
  ['getServerSideProps', 'request'],
  ['getStaticProps', 'build/revalidation'],
  ['getStaticPaths', 'build/enumeration'],
  ['getInitialProps', 'initial request/client transition']
]);

function propertyAssignment(node: Node, property: string) {
  const component = valueNode(node);
  if (Node.isClassDeclaration(component)) {
    const value = component.getStaticProperty(property);
    return component.getStaticMethod(property) ?? (Node.isPropertyDeclaration(value) ? value.getInitializer() : undefined);
  }
  for (const statement of node.getSourceFile().getStatements()) {
    const expression = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined;
    if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = expression.getLeft();
    if (Node.isPropertyAccessExpression(left) && left.getName() === property &&
      valueNode(left.getExpression()) === component) return expression.getRight();
  }
}

function exportedSite(file: SourceFile, name: string, declaration?: Node) {
  for (const entry of file.getExportDeclarations()) {
    for (const specifier of entry.getNamedExports()) {
      if (!entry.isTypeOnly() && !specifier.isTypeOnly() &&
        (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === name) return specifier;
    }
    if (!entry.getNamedExports().length && declaration &&
      entry.getModuleSpecifierSourceFile()?.getExportedDeclarations().get(name)?.some(node => node === declaration)) return entry;
  }
  return declaration?.getSourceFile() === file ? declaration : undefined;
}

function bodyCalls(node: Node | undefined) {
  return node ? [...(Node.isCallExpression(node) ? [node] : []), ...node.getDescendantsOfKind(SyntaxKind.CallExpression)] : [];
}

function rootedIn(node: Node | undefined, binding: Node): boolean {
  if (!node) return false;
  if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) return rootedIn(node.getExpression(), binding);
  return bindingOf(node) === binding;
}

// The callback must reach an invocation in a returned handler or a locally
// identified composition step. An opaque wrapper only supplies possible evidence.
function callbackArguments(call: import('ts-morph').CallExpression, workspace?: WorkspaceBindings) {
  const expression = call.getExpression();
  const origin = importBinding(expression);
  const factory = functionNode(expression) ?? functionNode(workspace?.resolve(expression));
  const ironSession = (origin?.module === 'iron-session/next' &&
    ['withIronSessionApiRoute', 'withIronSessionSsr'].includes(origin.name));
  const returned = returns(factory?.getBody());
  const returnedCalls = returned.flatMap(result => {
    const fn = functionNode(result);
    return bodyCalls(fn?.getBody() ?? result);
  });
  const calls = bodyCalls(factory?.getBody());
  const callbacks: { value: Node; possible: boolean }[] = [];
  const add = (value: Node, possible: boolean) => {
    if (functionNode(value) || Node.isCallExpression(valueNode(value))) callbacks.push({ value, possible });
  };
  for (const [i, passed] of call.getArguments().entries()) {
    const parameter = factory?.getParameters()[i];
    const invoked = !!parameter && returnedCalls.some(site => rootedIn(site.getExpression(), parameter));
    const composed = !!parameter && calls.some(site => site.getArguments().some(argument =>
      Node.isSpreadElement(argument) && rootedIn(argument.getExpression(), parameter))) &&
      returnedCalls.some(site => {
        const callee = valueNode(site.getExpression());
        return Node.isConditionalExpression(callee) && [callee.getWhenTrue(), callee.getWhenFalse()]
          .some(branch => rootedIn(branch, parameter));
      });
    const value = valueNode(passed);
    const opaque = !factory && !ironSession;
    if (Node.isArrayLiteralExpression(value)) {
      if (invoked || composed || opaque) for (const element of value.getElements()) add(element, opaque || !invoked);
    } else if (Node.isObjectLiteralExpression(value)) {
      for (const member of value.getProperties()) {
        if (!Node.isPropertyAssignment(member) && !Node.isMethodDeclaration(member)) continue;
        const matches = parameter && returnedCalls.some(site => {
          const access = site.getExpression();
          return Node.isPropertyAccessExpression(access) && access.getName() === member.getName() && rootedIn(access, parameter);
        });
        if (matches || opaque) add(Node.isPropertyAssignment(member) ? member.getInitializerOrThrow() : member, opaque);
      }
    } else if (invoked || composed || opaque || ironSession && i === 0) add(passed, opaque);
  }
  return { callbacks, opaque: !factory && !ironSession, external: origin?.module };
}

type MatcherPart = { text?: string; optional?: boolean; repeat?: boolean };

function membership(pattern: MatcherPart[], route: MatcherPart[]) {
  // Literal segments and one other segment partition the input alphabet.
  const alphabet = [...new Set([...pattern, ...route].flatMap(part => part.text === undefined ? [] : [part.text])), '\0'];
  const closure = (parts: MatcherPart[], states: number[]) => {
    const next = new Set(states);
    for (const index of next) if (parts[index]?.optional) next.add(index + 1);
    return [...next].sort((a, b) => a - b);
  };
  const advance = (parts: MatcherPart[], states: number[], token: string) => closure(parts,
    states.flatMap(index => {
      const part = parts[index];
      return !part || part.text !== undefined && part.text !== token ? [] :
        part.repeat ? [index, index + 1] : [index + 1];
    }));
  const pending = [[closure(pattern, [0]), closure(route, [0])]];
  const seen = new Set<string>();
  let overlap = false;
  let excluded = false;
  for (let i = 0; i < pending.length; i++) {
    if (i >= 512 || overlap && excluded) return 'possible';
    const [left, right] = pending[i];
    const key = JSON.stringify([left, right]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (right.includes(route.length)) {
      if (left.includes(pattern.length)) overlap = true;
      else excluded = true;
    }
    for (const token of alphabet) {
      const variants = advance(route, right, token);
      if (variants.length) pending.push([advance(pattern, left, token), variants]);
    }
  }
  return overlap ? 'yes' : 'no';
}

function middlewareMatcher(pattern: string, route: RouteNode): 'yes' | 'possible' | 'no' | undefined {
  if (!pattern.startsWith('/')) return;
  const parts = routeSegments(pattern.replace(/\/$/, '') || '/');
  const variants = routeSegments(route.path);
  const negative = /^\/\(\(\?!(.+)\)\.\*\)$/.exec(pattern);
  if (negative && negative[1].split('|').every(part => /^[\w./-]+$/.test(part))) {
    const excluded = negative[1].split('|');
    const dynamic = variants.findIndex(part => segmentRank(part) !== '3');
    const prefix = variants.slice(0, dynamic < 0 ? variants.length : dynamic).join('/');
    if (dynamic < 0) return excluded.some(value => new RegExp('^(?:' + value + ')').test(prefix)) ? 'no' : 'yes';
    if (excluded.some(value => prefix.startsWith(value) && !value.includes('.'))) return 'no';
    return excluded.some(value => value.startsWith(prefix ? prefix + '/' : '')) ? 'possible' : 'yes';
  }
  if (parts.some(part => !/^(?:[\w.~-]+|:\w+[?*+]?)$/.test(part))) return;
  return membership(parts.map(part => part.startsWith(':') ?
    { optional: /[?*]$/.test(part), repeat: /[+*]$/.test(part) } : { text: part }),
  variants.map(part => {
    const rank = segmentRank(part);
    return rank === '3' ? { text: part } : { optional: rank === '0', repeat: rank !== '2' };
  }));
}

function destinationNode(node: Node | undefined) {
  return property(valueNode(node), 'pathname') ?? node;
}

function nextRouter(node: Node, seen = new Set<Node>()): boolean {
  if (seen.has(node) || seen.size >= 8) return false;
  seen.add(node);
  const origin = importBinding(node);
  if (origin?.module === 'next/router' && ['default', 'Router'].includes(origin.name)) return true;
  const value = valueNode(node);
  if (Node.isCallExpression(value)) {
    const hook = value.getExpression();
    const source = importBinding(hook) ?? importBinding(valueNode(hook));
    return source?.module === 'next/router' && source.name === 'useRouter';
  }
  return !!value && value !== node && nextRouter(value, seen);
}

export function collectPagesFacts(files: SourceFile[], routes: RouteNode[], config: NextConfig,
  relative: (file: SourceFile) => string, workspace?: WorkspaceBindings, applications = new Map<string, Node | undefined>()) {
  const byFile = new Map(files.map(file => [relative(file), file]));
  const fileSet = new Set(files);
  const pages = routes.filter(route => route.pages);
  const dependencies: PagesDependency[] = [];
  const issues = new Map<string, Set<string>>();
  const ownerIssues = new Map<Node, Set<string>>();
  const owners = new Map<Node, { declaration?: Node; site: Node; name: string }>();
  const ignored = new Set<Node>();
  const lifecycleNames = new Map<Node, string>();
  const apiIssues = new Map<string, Set<string>>();
  const report = <T>(map: Map<T, Set<string>>, key: T, reason: string) => {
    const reasons = map.get(key) ?? new Set<string>();
    reasons.add(reason);
    map.set(key, reasons);
  };
  const where = (node: Node) => relative(node.getSourceFile());
  const addUrl = (kind: PagesDependency['kind'], url: Node, site: Node, owner?: Node, displayed?: string) => {
    const values = urlTexts(destinationNode(url)!) ?? [];
    for (const value of values) {
      const wildcard = /[\0\x01]/.test(value.text);
      const urls = wildcard ? value.text.replace(/[\0\x01]/g, '\0') : value.text;
      const matches = matchNextRoutes(urls, routes, route => route.path, config.url,
        (part, segment) => segmentRank(part) !== '3' || (!segment.includes('\0') && part === segment));
      for (const match of matches) {
        if (!match.pages && !pages.some(route => route.file === where(site))) continue;
        dependencies.push({ owner, destination: match.id, kind, site,
          possible: wildcard || value.partial, detail: [value.text.replace(/[\0\x01]/g, '${…}'), displayed && 'as ' + displayed].filter(Boolean).join(' ') });
      }
    }
    return dependencies.some(edge => edge.site === site && edge.kind === kind);
  };

  const traceData = (route: RouteNode, name: string, phase: string, declaration: Node | undefined, site: Node) => {
    const value = valueNode(declaration);
    const owner = declaration && fileSet.has(declaration.getSourceFile()) ? declaration : site;
    const local = value && fileSet.has(value.getSourceFile());
    if (!local) {
      report(issues, route.id, `${name} implementation unresolved`);
      return;
    }
    lifecycleNames.set(owner, name);
    dependencies.push({ route: route.id, target: owner, kind: 'data', site, detail: `${name} · ${phase}` });
    const seen = new Set<Node>();
    const trace = (node: Node | undefined, possible = false) => {
      const selected = valueNode(node);
      if (!selected || seen.has(selected) || seen.size >= 40) return;
      seen.add(selected);
      const fn = functionNode(selected);
      if (fn && fileSet.has(fn.getSourceFile())) {
        const binding = Node.isIdentifier(node) ? declarationsOf(node)[0] : undefined;
        if (binding && binding !== owner && fileSet.has(binding.getSourceFile())) {
          dependencies.push({ owner, target: binding, kind: 'data', site: node!, possible, detail: 'lifecycle callback' });
          return;
        }
        owners.set(fn, { declaration: owner, site, name });
        for (const result of returns(fn.getBody())) {
          const redirect = property(valueNode(result), 'redirect');
          const destination = property(valueNode(redirect), 'destination');
          if (destination && !addUrl('redirect', destination, redirect!, owner)) {
            report(ownerIssues, owner, 'lifecycle redirect destination unresolved');
          }
        }
      } else if (Node.isCallExpression(selected)) {
        owners.set(selected, { declaration: owner, site, name });
        const result = callbackArguments(selected, workspace);
        if (result.opaque || result.callbacks.some(callback => callback.possible) ||
          workspace?.has(result.external ?? '')) {
          const reason = workspace?.has(result.external ?? '') ? `workspace lifecycle wrapper ${result.external} outside indexed root` :
            `${name} callback invocation partially resolved (${selected.getExpression().getText()})`;
          report(ownerIssues, owner, reason);
          report(issues, route.id, reason);
        }
        for (const callback of result.callbacks) trace(callback.value, possible || callback.possible);
        if (!result.opaque) {
          for (const argument of selected.getArguments()) {
            const candidates = Node.isArrayLiteralExpression(argument) ? argument.getElements() :
              Node.isObjectLiteralExpression(argument) ? argument.getProperties().map(member =>
                Node.isPropertyAssignment(member) ? member.getInitializer() : member) : [argument];
            for (const candidate of candidates) {
              const fn = functionNode(candidate);
              if (fn && candidate === fn && !owners.has(fn)) ignored.add(fn);
            }
          }
        }
      } else {
        report(ownerIssues, owner, `${name} callable body unresolved`);
        report(issues, route.id, `${name} callable body unresolved`);
      }
    };
    trace(value);
  };

  const pageRoot = pages[0]?.file.startsWith('src/pages/') ? 'src/pages/' : 'pages/';
  const extensions = config.extensions ?? ['tsx', 'ts', 'jsx', 'js'];
  const shell = (name: string) => extensions.map(ext => byFile.get(pageRoot + name + '.' + ext)).find(Boolean);
  const app = shell('_app');
  const appBody = app && applications.get(relative(app));
  const appComponent = appBody?.getParent() ?? app?.getExportedDeclarations().get('default')?.[0];
  const document = shell('_document');
  const docComponent = document?.getExportedDeclarations().get('default')?.[0];
  const appInitial = appComponent && propertyAssignment(appComponent, 'getInitialProps');
  const docInitial = docComponent && propertyAssignment(docComponent, 'getInitialProps');

  for (const route of pages) {
    const file = byFile.get(route.file);
    if (!file) continue;
    if (route.issue) report(apiIssues, route.id, route.issue);
    if (route.type !== 'page') continue;
    const exports = file.getExportedDeclarations();
    for (const [name, phase] of dataPhases) {
      if (name === 'getInitialProps') continue;
      const target = exports.get(name)?.[0];
      const site = exportedSite(file, name, target);
      if (site) traceData(route, name, phase, target, site);
    }
    const component = exports.get('default')?.[0];
    const initial = component && propertyAssignment(component, 'getInitialProps');
    for (const [value, context] of [
      [initial, 'page initial request/client transition'], [appInitial, 'App initial request/client transition'],
      [docInitial, 'Document server render']
    ] as const) if (value) traceData(route, 'getInitialProps', context, value, value);
  }

  const middlewareFiles = [...byFile].filter(([file]) => /^(?:src\/)?(?:middleware|proxy)\.[jt]sx?$/.test(file));
  const middleware = middlewareFiles.find(([file]) => !file.startsWith('src/')) ?? middlewareFiles[0];
  if (middleware) {
    const [file, source] = middleware;
    const expected = /(?:^|\/)proxy\./.test(file) ? 'proxy' : 'middleware';
    const exports = source.getExportedDeclarations();
    const entry = exports.get(expected)?.[0] ?? exports.get('default')?.[0];
    const exported = valueNode(entry);
    const inspectedHandlers = new Set<Node>();
    const findHandlers = (node: Node | undefined, possible: boolean, depth = 0): { target: Node; fn: NonNullable<ReturnType<typeof functionNode>>; possible: boolean }[] => {
      if (!node || depth > 8 || inspectedHandlers.has(node)) return [];
      inspectedHandlers.add(node);
      const fn = functionNode(node);
      if (fn && fileSet.has(fn.getSourceFile())) {
        const target = Node.isIdentifier(node) ? declarationsOf(node)[0] : node;
        return target ? [{ target, fn, possible }] : [];
      }
      const selected = valueNode(node);
      if (!Node.isCallExpression(selected)) return [];
      const forwarding = callbackArguments(selected, workspace);
      const middleware = property(valueNode(selected.getArguments()[0]), 'middleware');
      const candidates = forwarding.callbacks.length ? forwarding.callbacks : middleware ?
        [{ value: middleware, possible: true }] : [];
      return candidates.flatMap(candidate => findHandlers(candidate.value, possible || candidate.possible, depth + 1));
    };
    const candidates = findHandlers(entry, false);
    if (entry && (candidates.length || Node.isCallExpression(exported))) {
      const handlers = candidates.length ? candidates : [{ target: entry, fn: undefined, possible: true }];
      if (!candidates.length) lifecycleNames.set(entry, expected);

      const config = exports.get('config')?.[0];
      const object = valueNode(config);
      const match = valueNode(property(object, 'matcher'));
      const values = Node.isArrayLiteralExpression(match) ? match.getElements() : match ? [match] : [];
      if (!values.length && config && !Node.isObjectLiteralExpression(object)) {
        for (const handler of handlers) report(ownerIssues, handler.target, 'dynamic middleware config');
        for (const route of pages) report(issues, route.id, 'dynamic middleware config');
      }
      for (const route of pages) {
        if (!values.length && !match && (!config || Node.isObjectLiteralExpression(object))) {
          for (const handler of handlers) dependencies.push({ route: route.id, target: handler.target, kind: 'middleware',
            site: entry, detail: 'default matcher', possible: handler.possible });
          continue;
        }
        const matched = values.flatMap(value => {
          const pattern = textValue(value) ?? textValue(property(value, 'source'));
          const member = pattern && middlewareMatcher(pattern, route);
          if (!member) {
            report(issues, route.id, 'unsupported middleware matcher');
            for (const handler of handlers) report(ownerIssues, handler.target, 'unsupported middleware matcher');
            return [];
          }
          if (member === 'no') return [];
          return [{ value, pattern, possible: member === 'possible' || !!(property(value, 'has') || property(value, 'missing')) }];
        });
        for (const entry of matched) for (const handler of handlers) dependencies.push({
          route: route.id, target: handler.target, kind: 'middleware', site: entry.value,
          detail: entry.pattern, possible: entry.possible || handler.possible
        });
      }
      for (const handler of handlers) for (const call of bodyCalls(handler.fn?.getBody())) {
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) continue;
        const origin = importBinding(callee.getExpression());
        const kind = callee.getName();
        if (origin?.module !== 'next/server' || origin.name !== 'NextResponse' || (kind !== 'rewrite' && kind !== 'redirect')) continue;
        const first = call.getArguments()[0];
        const url = Node.isNewExpression(first) && first.getExpression().getText() === 'URL' ? first.getArguments()[0] : first;
        if (!url || !addUrl(kind, url, call, handler.target)) report(ownerIssues, handler.target, `middleware ${kind} destination unresolved`);
      }
    } else for (const route of pages) report(issues, route.id, `${expected} export unresolved`);
  }

  for (const rule of config.rules) {
    const matched = matchNextRoutes(rule.destination, routes, route => route.path, config.url)?.filter(route => route.pages);
    if (!matched.length) continue;
    for (const route of pages) {
      const membership = middlewareMatcher(rule.source, route);
      if (membership !== 'yes' && membership !== 'possible') continue;
      for (const destination of matched) dependencies.push({ route: route.id, destination: destination.id, kind: rule.kind,
        site: rule.site, possible: membership === 'possible' || rule.conditional, detail: rule.source + ' → ' + rule.destination });
    }
  }
  for (const route of pages) for (const reason of config.issues) report(issues, route.id, reason);

  const navKinds = new Set([SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.CallExpression]);
  for (const file of files) {
    const hasRouting = file.getImportDeclarations().some(declaration =>
      ['next/router', 'next/link'].includes(declaration.getModuleSpecifierValue()));
    if (!hasRouting) continue;
    visitKinds(file, navKinds, node => {
      if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
        const tag = node.getTagNameNode();
        const origin = importBinding(tag) ?? importBinding(valueNode(tag));
        if (origin?.module !== 'next/link' || origin.name !== 'default') return;
        const attr = node.getAttribute('href');
        const init = Node.isJsxAttribute(attr) ? attr.getInitializer() : undefined;
        const url = Node.isJsxExpression(init) ? init.getExpression() : init;
        if (!url) return;
        const as = node.getAttribute('as');
        const display = Node.isJsxAttribute(as) ? as.getInitializer() : undefined;
        const match = addUrl('navigate', url, node, undefined, textValue(Node.isJsxExpression(display) ? display.getExpression() : display));
        if (!match && !textValue(url)) report(ownerIssues, node, 'dynamic client navigation destination');
      } else if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
        if (!Node.isPropertyAccessExpression(callee) || !['push', 'replace'].includes(method!) || !nextRouter(callee.getExpression())) return;
        const [url, displayed] = node.getArguments();
        if (url && !addUrl('navigate', url, node, undefined, textValue(displayed)) && !textValue(url)) {
          report(ownerIssues, node, 'dynamic client navigation destination');
        }
      }
    });
  }

  for (const route of pages.filter(route => route.type === 'api')) {
    const source = byFile.get(route.file);
    const imports = [...source?.getImportDeclarations() ?? [], ...source?.getExportDeclarations() ?? []];
    const external = imports.map(node => node.getModuleSpecifierValue()).filter((module): module is string =>
      !!module && !!workspace?.has(module));
    if (/\/api\/trpc(?:\/|$)/.test(route.path) && external.length) {
      report(apiIssues, route.id, `tRPC transport outside indexed root (${[...new Set(external)].join(', ')})`);
    }
  }

  return { dependencies, issues, owners, ownerIssues, lifecycleNames, apiIssues, ignored };
}
