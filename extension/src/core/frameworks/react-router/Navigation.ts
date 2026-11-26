import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { bindingOf, valueNode } from '../../analyzers/StaticBindings';
import { urlTexts } from '../../analyzers/ArchitectureFacts';
import { matchRouterRoutes, routerAncestry } from '../RouterMatch';
import { redirectPackages, routerPackages } from './Composition';
import { type RouterRoute } from './RouteTypes';
import { frameworkBinding, properties, stringValue } from './StaticConfig';

export type Reference = {
  kind: 'navigate' | 'redirect' | 'load' | 'submit';
  site: Node;
  via: string;
  url?: string;
  method?: string;
  relative?: string;
  routeId?: string;
  possible?: boolean;
  destinationUncertain?: boolean;
  indexUncertain?: boolean;
  document?: boolean;
};

function hook(node: Node | undefined) {
  const value = valueNode(node);
  if (!Node.isCallExpression(value)) return;
  const binding = frameworkBinding(value.getExpression());
  return binding && routerPackages.has(binding.module) ? binding.name : undefined;
}

function fetcherMember(node: Node, seen = new Set<Node>()): string | undefined {
  if (seen.has(node) || seen.size >= 8) return;
  seen.add(node);
  if (Node.isPropertyAccessExpression(node) && hook(node.getExpression()) === 'useFetcher') return node.getName();
  const decl = bindingOf(node);
  if (Node.isVariableDeclaration(decl) && decl.getVariableStatement()?.getDeclarationKind() === 'const') {
    const value = decl.getInitializer();
    return value && fetcherMember(value, seen);
  }
  if (!Node.isBindingElement(decl)) return;
  const binding = decl.getParent().getParent();
  if (Node.isVariableDeclaration(binding) && hook(binding.getInitializer()) === 'useFetcher') {
    return (decl.getPropertyNameNode() ?? decl.getNameNode()).getText();
  }
}

function destination(node: Node | undefined, absent: string | undefined) {
  if (!node) return { url: absent };
  const asString = stringValue(node);
  if (asString !== undefined) return { url: asString };
  const object = properties(node);
  if (object) {
    const pathname = object.has('pathname') ? stringValue(object.get('pathname')) : '';
    const search = object.has('search') ? stringValue(object.get('search')) : '';
    const hash = object.has('hash') ? stringValue(object.get('hash')) : '';
    if (pathname !== undefined && search !== undefined && hash !== undefined) {
      return { url: pathname + (search && !search.startsWith('?') ? '?' + search : search) + (hash && !hash.startsWith('#') ? '#' + hash : hash) };
    }
  }
  const alternatives = urlTexts(node)?.filter(value => !value.dynamic && !value.partial);
  if (alternatives?.length && alternatives.every(value => value.text === alternatives[0].text)) {
    const url = alternatives[0].text;
    const [location] = url.split('#', 1);
    const [pathname] = location.split('?', 1);
    // No prefix proves whether this is local, relative or external.
    if (/^[\x00\x01]/.test(pathname)) return { possible: true, destinationUncertain: true };
    const uncertain = /[\x00\x01]/.test(pathname) || undefined;
    return { url, possible: uncertain, destinationUncertain: uncertain,
      indexUncertain: /[\x00\x01]/.test(location.slice(pathname.length)) || undefined };
  }
  return { url: undefined, possible: true, destinationUncertain: true };
}

type JsxAttributes = Map<string, Node | undefined>;

function readAttributes(site: import('ts-morph').JsxOpeningElement | import('ts-morph').JsxSelfClosingElement) {
  const attributes: JsxAttributes = new Map();
  let spread = false;
  const confirmed = new Set<string>();
  const set = (key: string, value: Node | undefined) => {
    attributes.set(key, value);
    confirmed.add(key);
  };
  for (const attr of site.getAttributes()) {
    if (Node.isJsxSpreadAttribute(attr)) {
      const values = properties(attr.getExpression());
      if (values) for (const [key, node] of values) set(key, node);
      else {
        spread = true;
        confirmed.clear();
      }
      continue;
    }
    const initializer = attr.getInitializer();
    set(attr.getNameNode().getText(), Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer);
  }
  return { attributes, unknown: (key: string) => spread && !confirmed.has(key) };
}

const navigators = new Set(['Link', 'NavLink', 'Navigate']);

export function routerReferences(file: SourceFile): Reference[] {
  const references: Reference[] = [];
  file.forEachDescendant(site => {
    if (Node.isJsxOpeningElement(site) || Node.isJsxSelfClosingElement(site)) {
      const tag = site.getTagNameNode();
      const binding = frameworkBinding(tag);
      const name = binding && routerPackages.has(binding.module) ? binding.name :
        fetcherMember(tag) === 'Form' ? 'fetcher.Form' : undefined;
      if (!name || !navigators.has(name) && !['Form', 'fetcher.Form'].includes(name)) return;
      const { attributes, unknown } = readAttributes(site);
      const isForm = !navigators.has(name);
      const target = isForm ? 'action' : 'to';
      const relative = stringValue(attributes.get('relative'));
      const method = isForm ? stringValue(attributes.get('method'))?.toUpperCase() ??
        (attributes.has('method') ? undefined : 'GET') : undefined;
      const resolved = destination(attributes.get(target), isForm && !attributes.has('action') ? '.' : undefined);
      const destinationUncertain = resolved.destinationUncertain || unknown(target) ||
        !resolved.url?.startsWith('/') && (unknown('relative') || attributes.has('relative') && relative === undefined);
      references.push({ site, via: name, relative, method,
        document: attributes.has('reloadDocument') && !Node.isFalseLiteral(valueNode(attributes.get('reloadDocument'))),
        kind: isForm ? method === 'GET' ? 'load' : 'submit' : 'navigate',
        ...resolved, destinationUncertain,
        possible: destinationUncertain || isForm && unknown('method') || undefined });
      return;
    }
    if (!Node.isCallExpression(site)) return;
    const expression = site.getExpression();
    const binding = frameworkBinding(expression);
    const [arg, options] = site.getArguments();
    if (binding && redirectPackages.has(binding.module) && ['redirect', 'redirectDocument', 'replace'].includes(binding.name)) {
      references.push({ kind: 'redirect', site, via: binding.name, ...destination(arg, undefined) });
      return;
    }
    if (binding && routerPackages.has(binding.module) && binding.name === 'useRouteLoaderData') {
      references.push({ kind: 'load', site, via: binding.name, routeId: stringValue(arg), method: 'GET' });
      return;
    }
    const member = fetcherMember(expression);
    if (member === 'load') {
      references.push({ kind: 'load', site, via: 'fetcher.load', method: 'GET', ...destination(arg, undefined) });
      return;
    }
    const origin = hook(expression);
    if (!['useNavigate', 'useSubmit'].includes(origin ?? '') && member !== 'submit') return;
    const opts = properties(options);
    const relative = stringValue(opts?.get('relative'));
    const possible = !!options && !opts || !!opts?.has('relative') && relative === undefined;
    if (origin === 'useNavigate') {
      if (Node.isNumericLiteral(valueNode(arg))) return;
      references.push({ kind: 'navigate', site, via: origin, relative, ...destination(arg, undefined), possible });
      return;
    }
    const method = stringValue(opts?.get('method'))?.toUpperCase() ?? (opts?.has('method') || options && !opts ? undefined : 'GET');
    const resolved = destination(opts?.get('action'), '.');
    const implicitAction = !opts?.has('action') && Node.isIdentifier(arg);
    references.push({ kind: method === 'GET' ? 'load' : 'submit', site, via: origin ?? 'fetcher.submit', relative, method,
      ...resolved, destinationUncertain: resolved.destinationUncertain || possible || implicitAction,
      possible: resolved.possible || possible || implicitAction ||
        !opts?.has('method') && !!arg && !Node.isNullLiteral(valueNode(arg)) && !Node.isObjectLiteralExpression(valueNode(arg)) });
  });
  return references;
}

export function resolveReference(ref: Reference, origin: RouterRoute | undefined, routes: RouterRoute[],
  byId: Map<string, RouterRoute>, basename: string): {
    targets?: RouterRoute[]; unresolved?: boolean; pathname?: string; basename?: string;
  } {
  if (ref.via === 'useRouteLoaderData') {
    if (ref.routeId === undefined || !origin) return { unresolved: true };
    const ancestor = routerAncestry(origin, byId).find(entry => entry.id === ref.routeId);
    return { targets: ancestor ? [ancestor] : [] };
  }
  const { url } = ref;
  if (url === undefined || ref.relative !== undefined && !['path', 'route'].includes(ref.relative)) return { unresolved: true };
  const unresolved = ref.kind === 'submit' && !ref.method;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return { targets: [] };
  const mode = ref.kind === 'submit' || ref.kind === 'load' ? ref.kind : 'url';
  const match = (absolute: string, base: string) => {
    const pathname = absolute.split(/[?#]/, 1)[0];
    const targets = mode !== 'url' && ref.indexUncertain
      ? [...new Set([...matchRouterRoutes(pathname, routes, base, mode),
        ...matchRouterRoutes(pathname + '?index', routes, base, mode)])]
      : matchRouterRoutes(absolute, routes, base, mode);
    return { targets, pathname, basename: base, unresolved };
  };
  if (url.startsWith('/')) {
    const absolute = ref.kind === 'redirect' ? url : basename.replace(/\/$/, '') + url;
    return match(absolute, basename);
  }
  if (!origin) return { unresolved: true };
  if ((url === '.' || url === '') && mode !== 'url' &&
      (origin.router.pattern || origin.router.index || origin.id === 'root') &&
      ref.via !== 'fetch') return { targets: [origin], unresolved };
  const [pathname] = url.split(/[?#]/, 1);
  const query = url.slice(pathname.length);
  if (!pathname && mode === 'url') return { targets: [origin] };
  const segments = pathname.split('/').filter(part => part && part !== '.');
  const bases = routerAncestry(origin, byId).filter(entry => entry.router.pattern && entry.path !== '/');
  if (ref.relative !== 'path') while (segments[0] === '..') {
    bases.pop();
    segments.shift();
  }
  const base = (bases.at(-1)?.path ?? '/').split('/').filter(Boolean);
  if (ref.relative === 'path' && base.includes('*')) return { unresolved: true };
  for (const part of segments) {
    if (part === '..') base.pop();
    else base.push(part);
  }
  if (base.some(part => part.startsWith(':') || part === '*' || part.endsWith('?'))) return { unresolved: true };
  return match('/' + base.join('/') + query, '/');
}
