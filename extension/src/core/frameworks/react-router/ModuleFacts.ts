import { isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import { conditionalAt, httpRequest } from '../../analyzers/ArchitectureFacts';
import { bindingOf, functionNode, valueNode } from '../../analyzers/StaticBindings';
import { startLine } from '../../analyzers/SourceLines';
import { type QueryIndex, type RouterEdge, type RouterIssue, type Wrapper } from '../../../mcp/Index';
import { routerAncestry } from '../RouterMatch';
import { outletChains, redirectPackages } from './Composition';
import { resolveReference, routerReferences, type Reference } from './Navigation';
import type { RouterProject, RouterRoute } from './RouteTypes';
import { stringValue } from './StaticConfig';

type Route = QueryIndex['routes'][number];
type Context = {
  index: QueryIndex;
  project: RouterProject;
  files: SourceFile[];
  relative: (file: SourceFile) => string;
  exports: ReadonlyMap<SourceFile, ReadonlyMap<string, Node[]>>;
  symbol: (node: Node) => number | undefined;
  owner: (node: Node) => number | undefined;
  fileSymbol: (file: string) => number | undefined;
};

const entries = new Map([
  ['default', 'render'], ['Layout', 'layout'], ['loader', 'loader'], ['action', 'action'],
  ['clientLoader', 'client-loader'], ['clientAction', 'client-action'], ['meta', 'meta'], ['links', 'links'],
  ['headers', 'headers'], ['ErrorBoundary', 'error-boundary'], ['HydrateFallback', 'hydrate-fallback']
]);

type Entry = NonNullable<NonNullable<Route['router']>['entries']>[number];

function runtimeModules(file: SourceFile) {
  const imports = file.getImportDeclarations().filter(statement => !statement.isTypeOnly() &&
    (!statement.getNamedImports().length || statement.getNamedImports().some(entry => !entry.isTypeOnly()) ||
      statement.getDefaultImport() || statement.getNamespaceImport()));
  const exports = file.getExportDeclarations().filter(statement => statement.hasModuleSpecifier() && !statement.isTypeOnly() &&
    (!statement.getNamedExports().length || statement.getNamedExports().some(entry => !entry.isTypeOnly())));
  return [...imports, ...exports];
}

const knownModules = new Set([...redirectPackages, '@react-router/dev/routes', '@react-router/dev/vite',
  '@react-router/fs-routes', '@remix-run/dev', '@remix-run/dev/vite', 'react-router-auto-routes']);

function enforcedActionMethod(definition: Node) {
  const fn = functionNode(definition);
  const body = fn?.getBody();
  if (!Node.isBlock(body)) return;
  const guard = body.getStatements()[0];
  if (!Node.isIfStatement(guard)) return;
  const test = guard.getExpression();
  if (!Node.isBinaryExpression(test) || test.getOperatorToken().getKind() !== SyntaxKind.ExclamationEqualsEqualsToken) return;
  const [left, right] = [test.getLeft(), test.getRight()];
  const method = stringValue(left) ?? stringValue(right);
  const property = stringValue(left) === undefined ? left : right;
  if (!method || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      !Node.isPropertyAccessExpression(property) || property.getName() !== 'method') return;
  const request = property.getExpression();
  const parameter = fn!.getParameters()[0];
  const requestBinding = bindingOf(request);
  const bound = Node.isBindingElement(requestBinding) &&
    (requestBinding.getPropertyNameNode() ?? requestBinding.getNameNode()).getText() === 'request' &&
    requestBinding.getParent().getParent() === parameter ||
    Node.isPropertyAccessExpression(request) && request.getName() === 'request' && bindingOf(request.getExpression()) === parameter;
  if (!bound) return;
  const block = guard.getThenStatement();
  const rejection = Node.isBlock(block) && block.getStatements().length === 1 ? block.getStatements()[0] : block;
  if (!Node.isThrowStatement(rejection) && !Node.isReturnStatement(rejection)) return;
  const response = rejection.getExpression();
  if (!Node.isNewExpression(response) || response.getExpression().getText() !== 'Response' ||
      bindingOf(response.getExpression())?.getSourceFile().isDeclarationFile() === false) return;
  const options = response.getArguments()[1];
  const status = Node.isObjectLiteralExpression(options) ? options.getProperty('status') : undefined;
  if (Node.isPropertyAssignment(status) && status.getInitializer()?.getText() === '405') return method;
}

export function indexRouterFacts({ index, project, files, relative, exports, symbol, owner, fileSymbol }: Context) {
  const { routes, framework, basename, registryIssues } = project;
  const issues: RouterIssue[] = [];
  const edges: RouterEdge[] = [];
  index.router = { framework, basename, registryIssues, registryFiles: project.registryFiles, issues, edges };
  const fileSet = new Set(files);
  const compiler = files[0]?.getProject().getCompilerOptions();
  const byId = new Map(routes.map(route => [route.id, route]));
  const indexed = new Map(index.routes.flatMap(route => route.router ? [[route.router.id, route] as const] : []));
  const loc = (node: Node) => ({ file: relative(node.getSourceFile()), line: startLine(node) });
  const issueKeys = new Set<string>();
  const addIssue = (site: Node, message: string, kind: RouterIssue['kind'], route?: number) => {
    const { file, line } = loc(site);
    const reason = `${message} (${file}:${line})`;
    const key = JSON.stringify([reason, kind, route]);
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ reason, file, kind, route });
  };
  const definitions = new Map<RouterRoute, Map<string, { node: Node; entry: Entry }>>();
  for (const route of routes) {
    const indexedRoute = indexed.get(route.id)!;
    const discovered = new Map<string, { node: Node; entry: Entry }>();
    definitions.set(route, discovered);
    const source = route.source;
    if (!source) continue;
    const exported = exports.get(source);
    const runtime = index.runtimeExports?.[indexedRoute.fileSymbol ?? 0];
    for (const [name, role] of entries) {
      if (runtime?.names[name] === 'type' || name === 'Layout' && route.id !== 'root') continue;
      const nodes = exported?.get(name) ?? [];
      if (!nodes.length && !runtime?.names[name]) continue;
      const declaration = nodes.find(node => fileSet.has(node.getSourceFile()) && symbol(node) !== undefined);
      const resolved = valueNode(declaration);
      const definition = resolved && fileSet.has(resolved.getSourceFile()) ? resolved : declaration;
      const id = declaration && (symbol(definition!) ?? symbol(declaration));
      if (!definition || id === undefined) {
        addIssue(source, `unresolved route export ${name}`, 'module', indexedRoute.id);
        continue;
      }
      if (!functionNode(definition) && !Node.isClassDeclaration(definition) && !Node.isClassExpression(definition)) {
        addIssue(declaration!, `opaque route export ${name}`, 'module', indexedRoute.id);
      }
      const entry: Entry = { role, symbol: id, ...loc(definition),
        method: role === 'loader' ? 'GET' : role === 'action' ? enforcedActionMethod(definition) ?? '?' : undefined };
      discovered.set(role, { node: definition, entry });
      (indexedRoute.router!.entries ??= []).push(entry);
      if (entry.method && route.type === 'api') (indexedRoute.handlers ??= {})[entry.method] = id;
      if (role === 'render') {
        indexedRoute.component ??= index.symbols[id - 1].kind === 'component' ? id : undefined;
        if (entry.file === route.file) indexedRoute.line = entry.line;
      } else if (route.type === 'api' && indexedRoute.line === 1 && entry.file === route.file) indexedRoute.line = entry.line;
    }
    const enforced = discovered.get('action')?.entry.method;
    if (route.type === 'api' && enforced && enforced !== '?') {
      indexedRoute.methods = indexedRoute.methods?.map(method => method === '?' ? enforced : method);
      indexedRoute.methodBasis = route.methodBasis = 'enforced';
      route.methods = indexedRoute.methods;
    }
    if (!discovered.has('render') && route.type !== 'api') addIssue(source, 'default route component unresolved', 'module', indexedRoute.id);
    if (runtime?.unknownStar) addIssue(source, 'unresolved route export star', 'module', indexedRoute.id);
  }

  const slots = new Map<Node, ReturnType<typeof outletChains>>();
  const getSlots = (node: Node, slot: 'children' | 'outlet') => {
    if (!slots.has(node)) slots.set(node, outletChains(node, slot, fileSet, loc));
    return slots.get(node)!;
  };
  const wrapper = (entry: Entry, evidence: string): Wrapper => ({
    file: entry.file, line: entry.line, symbol: index.symbols[entry.symbol - 1].name, conditional: false, evidence
  });
  const navigable = new Map<number, Set<RouterRoute>>();
  const outgoing = new Map<number, number[]>();
  const addOutgoing = (from: number, to: number) => {
    const values = outgoing.get(from) ?? [];
    values.push(to);
    outgoing.set(from, values);
  };
  for (const [from, to] of index.renderEdges) addOutgoing(from, to);
  for (const [target, , , kind, , caller, graphOwner] of index.references) {
    const from = graphOwner ?? caller;
    if (kind === 'call' && from !== undefined) addOutgoing(from, target);
  }
  for (const [from, to] of index.flowCalls ?? []) addOutgoing(from, to);

  for (const route of routes) {
    const current = indexed.get(route.id)!;
    const routeEntries = definitions.get(route)!;
    const hierarchy = routerAncestry(route, byId);
    const layers: { entry: Entry; node: Node; slot: 'children' | 'outlet'; label: string }[] = [];
    const shell = definitions.get(hierarchy[0])?.get('layout');
    if (shell) layers.push({ ...shell, slot: 'children', label: 'root Layout' });
    for (const ancestor of hierarchy.slice(0, -1)) {
      const render = definitions.get(ancestor)?.get('render');
      if (render) layers.push({ ...render, slot: 'outlet', label: 'Outlet' });
      else if (route.type !== 'api') {
        current.router!.renderable = false;
        addIssue(ancestor.site, `ancestor component unresolved (${ancestor.id})`, 'wrapper', current.id);
      }
    }

    let chains: Wrapper[][] = [[]];
    const layouts = new Map<number, { conditional: boolean; possible: boolean }>();
    if (route.type !== 'api') for (const layer of layers) {
      const branches = getSlots(layer.node, layer.slot);
      if (!branches.length) {
        current.router!.renderable = false;
        addIssue(layer.node, `${layer.slot} slot unresolved`, 'wrapper', current.id);
        break;
      }
      if (branches.some(branch => branch.possible)) addIssue(layer.node, `${layer.slot} forwarding unresolved`, 'wrapper', current.id);
      if (branches.some(branch => branch.conditional)) addIssue(layer.node, `conditional ${layer.slot} slot`, 'wrapper', current.id);
      for (const branch of branches) {
        for (const id of [layer.entry.symbol, ...branch.definitions.flatMap(node => symbol(node) ?? [])]) {
          const prior = layouts.get(id);
          if (!prior || prior.possible && !branch.possible || prior.conditional && !branch.conditional) {
            layouts.set(id, { conditional: branch.conditional, possible: branch.possible });
          }
        }
      }
      const next = branches.map(branch => {
        const site = loc(branch.node);
        const top = wrapper(layer.entry, `${layer.label} at ${site.file}:${site.line}`);
        return [top, ...branch.wrappers].map(item => ({ ...item, conditional: item.conditional || branch.conditional,
          possible: item.possible || branch.possible || undefined }));
      });
      const product = chains.flatMap(chain => next.map(branch => [...chain, ...branch]));
      if (product.length > 32) addIssue(layer.node, 'wrapper branch budget', 'wrapper', current.id);
      chains = product.slice(0, 32);
    }
    if (route.type !== 'api') {
      const keys = [...new Set(chains.map(chain => {
        const json = JSON.stringify(chain);
        const key = createHash('sha1').update(json).digest('hex').slice(0, 12);
        index.wrapChains[key] = chain;
        return key;
      }))];
      index.routeWrap[current.id] = keys[0];
      if (keys.length > 1) index.branches![current.id] = keys;
      if (current.router!.renderable !== false) {
        current.router!.conditionalRender = chains.every(chain => chain.some(item => item.conditional)) || undefined;
        current.router!.possibleRender = chains.every(chain => chain.some(item => item.possible)) || undefined;
        current.layouts = [...layouts.keys()];
        current.router!.conditionalLayouts = [...layouts].flatMap(([id, flags]) => flags.conditional ? [id] : []);
        current.router!.possibleLayouts = [...layouts].flatMap(([id, flags]) => flags.possible ? [id] : []);
        for (const [to, flags] of layouts) {
          const { file, line } = index.symbols[to - 1];
          edges.push({ source: current.id, to, kind: 'wrap', file, line, detail: 'Outlet composition', ...flags });
        }
      }
    }
    const boundaries = hierarchy.slice().reverse().flatMap(ancestor => [...definitions.get(ancestor)?.values() ?? []]
      .filter(({ entry }) => entry.role === 'error-boundary' || entry.role === 'hydrate-fallback').map(({ entry }) => entry));
    if (boundaries.length) current.router!.boundaries = boundaries;
    if (route.type !== 'api') for (const entry of boundaries) {
      if ([...routeEntries.values()].some(item => item.entry.symbol === entry.symbol)) continue;
      edges.push({ source: current.id, to: entry.symbol, kind: 'data', file: entry.file, line: entry.line,
        detail: entry.role, conditional: true });
    }
    for (const { entry } of routeEntries.values()) {
      if (entry.role === 'render' && current.router!.renderable === false) continue;
      edges.push({ source: current.id, to: entry.symbol, kind: entry.role === 'render' ? 'render' :
        entry.role === 'layout' ? 'wrap' : 'data', file: entry.file,
        line: entry.line, detail: entry.role, method: entry.method,
        conditional: ['error-boundary', 'hydrate-fallback'].includes(entry.role) ||
          entry.role === 'render' && current.router!.conditionalRender || undefined,
        possible: entry.role === 'render' && current.router!.possibleRender || undefined });
    }
    const seeds = [...routeEntries.values()].flatMap(({ entry }) =>
      current.router!.renderable === false && entry.role === 'render' ? [] : [entry.symbol]);
    // Ancestor-owned JSX runs in its own registration's route context.
    const pending = [...seeds];
    const seen = new Set<number>();
    for (let i = 0; i < pending.length; i++) {
      const symbol = pending[i];
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      const owners = navigable.get(symbol) ?? new Set<RouterRoute>();
      owners.add(route);
      navigable.set(symbol, owners);
      pending.push(...outgoing.get(symbol) ?? []);
    }
  }

  const byModule = new Map<string, RouterRoute[]>();
  for (const route of routes) {
    const owners = byModule.get(route.file) ?? [];
    owners.push(route);
    byModule.set(route.file, owners);
  }
  const edgesSeen = new Set<string>();
  const reference = (ref: Reference) => {
    const { site, kind, via, method } = ref;
    const position = loc(site);
    const from = owner(site) ?? fileSymbol(position.file);
    if (from === undefined) return;
    const origins = [...navigable.get(from) ?? []];
    const fromModule = byModule.get(position.file) ?? [];
    const context = origins.length ? origins : fromModule.length && from === fileSymbol(position.file) ? fromModule : [undefined];
    for (const origin of context) {
      const source = origin && indexed.get(origin.id);
      const resolution = resolveReference(ref, origin, routes, byId, basename);
      if (resolution.unresolved || ref.possible) addIssue(site, `${via} destination or method unresolved`, 'navigation', source?.id);
      if (resolution.unresolved) continue;
      const matches = resolution.targets ?? [];
      if (matches.length > 1) addIssue(site, `${via} destination is ambiguous`, 'navigation', source?.id);
      for (const target of matches) {
        const destination = indexed.get(target.id)!;
        const load = kind === 'load' || kind === 'submit';
        const reader = via === 'useRouteLoaderData';
        const role = kind === 'load' ? 'loader' : 'action';
        const handlers = definitions.get(target);
        const client = handlers?.get('client-' + role)?.entry;
        const server = handlers?.get(role)?.entry;
        const handler = !ref.document && via !== 'fetch' ? client ?? server : server;
        const rejected = kind === 'submit' && handler?.method && handler.method !== '?' && handler.method !== method;
        const applicable = load && handler && !rejected ? [handler] : [];
        if (load && !applicable.length) continue;
        const conditional = !!conditionalAt(site);
        const possible = !!ref.possible || matches.length > 1 || context.length > 1 && ref.url !== undefined && !ref.url.startsWith('/') &&
          kind === 'redirect';
        for (const entry of load ? applicable : [undefined]) {
          const edge: RouterEdge = { from, source: source?.id, destination: destination.id, to: entry?.symbol, kind: reader ? 'data' : kind,
            ...position, method: reader ? undefined : method, detail: entry ? `${via} → ${entry.role}` : via, conditional: conditional || undefined, possible: possible || undefined };
          const key = JSON.stringify(edge);
          if (edgesSeen.has(key)) continue;
          edgesSeen.add(key);
          edges.push(edge);
        }
      }
    }
  };

  for (const file of files) {
    for (const statement of runtimeModules(file)) {
      const specifier = statement.getModuleSpecifierValue();
      if (!specifier || knownModules.has(specifier) || isBuiltin(specifier)) continue;
      const resolved = statement.getModuleSpecifierSourceFile();
      if (!resolved || !resolved.isInNodeModules() && (!fileSet.has(resolved) && !resolved.isDeclarationFile())) {
        addIssue(statement, `unresolved import ${specifier}`, 'import');
      } else if (resolved && fileSet.has(resolved)) {
        const exported = exports.get(resolved);
        const names = Node.isImportDeclaration(statement) ?
          [...statement.getNamedImports().filter(entry => !entry.isTypeOnly()).map(entry => entry.getName()),
            ...statement.getDefaultImport() ? ['default'] : []] :
          statement.getNamedExports().filter(entry => !entry.isTypeOnly()).map(entry => entry.getName());
        for (const name of names) {
          if (!exported?.has(name)) addIssue(statement, `unresolved import ${name} from ${specifier}`, 'import');
        }
      }
    }
    if (file.getImportDeclarations().length || /\b(?:fetch|import|require)\b/.test(file.getFullText())) {
      for (const ref of routerReferences(file)) reference(ref);
      for (const site of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const called = site.getExpression();
        if (called.getKind() === SyntaxKind.ImportKeyword || Node.isIdentifier(called) && called.getText() === 'require' &&
            !called.getSymbol()?.getDeclarations().some(node => fileSet.has(node.getSourceFile()))) {
          const specifier = stringValue(site.getArguments()[0]);
          const resolved = specifier && compiler && ts.resolveModuleName(specifier, file.getFilePath(), compiler, ts.sys).resolvedModule;
          if (!specifier || !knownModules.has(specifier) && !isBuiltin(specifier) && !resolved) {
            addIssue(site, specifier ? `unresolved dynamic import ${specifier}` : 'dynamic import target unresolved', 'import');
          }
        }
        const request = httpRequest(site, false);
        if (!request) continue;
        const url = stringValue(request.url);
        if (!url?.startsWith('/') || url.startsWith('//')) continue;
        reference({ kind: request.method === 'GET' || request.method === 'HEAD' ? 'load' : 'submit',
          site, via: request.via, url, method: request.method === '?' ? undefined : request.method });
      }
    }
  }
}
