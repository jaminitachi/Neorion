import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import { declarationsOf, urlTexts } from './ArchitectureFacts';
import type { RouteNode } from '../types/GraphTypes';
import { property, textValue } from './NextConfig';
import { matchNextRoutes } from './NextRouteMatch';
import { functionNode, returns, valueNode } from './StaticBindings';
import { visitKinds } from './CompilerWalk';

const TRPC_DISCOVERY_KINDS = new Set([SyntaxKind.CallExpression]);
const serverPackage = /^@trpc\/server(?:\/|$)/;
const proxyPackage = /^@trpc\/(?:client|react-query|next|tanstack-react-query)(?:\/|$)/;
const tanstackPackage = /^@trpc\/tanstack-react-query$/;
const proxyFactories = /^(?:createTRPCProxyClient|createTRPCClient)$/;
const reactFactories = /^(?:createTRPCReact|createTRPCNext)$/;
const hookOperations = /^(?:useQuery|useMutation|useSuspenseQuery|useInfiniteQuery|useSuspenseInfiniteQuery|useSubscription)$/;
const batchHooks = /^(?:useQueries|useSuspenseQueries)$/;
const cacheOperations = /^(?:invalidate|prefetch|prefetchInfinite|refetch|cancel|reset|setData|getData|setInfiniteData|getInfiniteData)$/;
const queryOperations = /^(?:fetch|fetchInfinite|ensureData)$/;
const optionsOperations = /^(?:queryOptions|infiniteQueryOptions|mutationOptions|subscriptionOptions)$/;
const keyOperations = /^(?:queryKey|infiniteQueryKey|mutationKey|pathKey|queryFilter|infiniteQueryFilter|pathFilter)$/;
const clientOperations = /^(?:query|mutate|subscribe)$/;
const httpLinks = /^(?:httpLink|httpBatchLink|httpBatchStreamLink|unstable_httpBatchStreamLink)$/;
const mutationCalls = /^(?:mutate|mutateAsync)$/;
const procedureOperations = /^(?:query|mutation|subscription)$/;

type Procedure = { property: Node; body: CallExpression; resolver: Node };
type Router = { entries: Map<string, Procedure | Router>; unresolved?: Node };
type Proxy = { kind: 'react' | 'client' | 'caller' | 'cache' | 'hydration' | 'context' | 'options'; router?: Router; client?: CallExpression; mutation?: true; prefix: (string | undefined)[] };
type ProcedurePath = Procedure & { name: string; clientsKnown: boolean; unresolved?: Node };
type HttpLink = { prefix: string; site: CallExpression; methodOverride?: string };
type HttpHandler = { route: RouteNode; endpoint: string };
type ProcedureUse = { transport?: { method: string; route: RouteNode; links: CallExpression[] }; transportIssue?: string; transportRoutes?: RouteNode[]; site: CallExpression; operation: string; cache: boolean; targets: ProcedurePath[]; unresolved?: ProcedurePath[] };

function unwrap(node: Node | undefined): Node | undefined {
  while (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) ||
    Node.isNonNullExpression(node) || Node.isAwaitExpression(node)) node = node.getExpression();
  return node;
}

function member(node: Node | undefined) {
  if (Node.isPropertyAccessExpression(node)) return { base: node.getExpression(), key: node.getName() };
  if (Node.isElementAccessExpression(node)) {
    const key = node.getArgumentExpression();
    return { base: node.getExpression(), key: Node.isStringLiteral(key) ? key.getLiteralText() : undefined };
  }
}

function initializer(node: Node | undefined, localValue: (node: Node) => Node | undefined) {
  if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node)) return node.getInitializer();
  if (Node.isExportAssignment(node)) return node.getExpression();
  if (Node.isShorthandPropertyAssignment(node)) return initializer(localValue(node), localValue);
}

function imported(node: Node, modulePattern: RegExp, names: RegExp) {
  const access = member(node);
  if (access && (!access.key || !names.test(access.key))) return false;
  const binding = (access?.base ?? node).getSymbol()?.getDeclarations()[0];
  if (Node.isImportSpecifier(binding) && !access && !binding.isTypeOnly()) {
    const entry = binding.getImportDeclaration();
    return !entry.isTypeOnly() && modulePattern.test(entry.getModuleSpecifierValue()) && names.test(binding.getName());
  }
  if (!Node.isNamespaceImport(binding) || !access) return false;
  const entry = binding.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration);
  return !entry.isTypeOnly() && modulePattern.test(entry.getModuleSpecifierValue());
}

export class TrpcFacts {
  readonly active: boolean;
  private routers = new Map<CallExpression, Router>();
  private files: Set<SourceFile>;
  private nested = new Set<Router>();
  private proxies = new Map<Node, Proxy | null>();
  private rootPaths = new Map<Router, Map<string, ProcedurePath>>();
  private links = new Map<CallExpression, HttpLink[] | null>();
  private handlers = new Map<Router, HttpHandler[]>();
  private allPaths = new Map<Router, Map<string, ProcedurePath[]>>();

  constructor(files: SourceFile[], sources: Set<SourceFile>, apiRoutes: Map<SourceFile, RouteNode>,
    private resolveDeclarations = declarationsOf) {
    const clientFiles = new Set(files.filter(file => file.getImportDeclarations().some(entry =>
      !entry.isTypeOnly() && proxyPackage.test(entry.getModuleSpecifierValue()))));
    this.active = sources.size > 0 || clientFiles.size > 0;
    this.files = new Set(this.active ? files : []);
    if (!this.active) return;

    const factories = new Map<CallExpression, Proxy['kind']>();
    const clientRoots = new Set<Router>();
    for (const file of files) {
      const content = file.getFullText();
      const imports = file.getImportDeclarations();
      const server = sources.size > 0 && (/\b(?:createTRPCRouter|router|mergeRouters)\b/.test(content) || imports.some(entry =>
        sources.has(entry.getModuleSpecifierSourceFile()!)));
      const client = clientFiles.has(file);
      if (!server && !client) continue;
      visitKinds(file, TRPC_DISCOVERY_KINDS, node => {
        if (!Node.isCallExpression(node)) return;
        if (server && this.isRouterCall(node)) this.router(node);
        if (!client) return;
        const expression = node.getExpression();
        const kind = imported(expression, proxyPackage, reactFactories) ? 'react' :
          imported(expression, proxyPackage, proxyFactories) ? 'client' :
          imported(expression, tanstackPackage, /^createTRPCContext$/) ? 'context' :
          imported(expression, tanstackPackage, /^createTRPCOptionsProxy$/) ? 'options' : undefined;
        if (kind) factories.set(node, kind);
      });
    }
    const clients = [...factories].map(([factory, kind]) => {
      const type = factory.getTypeArguments()[0];
      return { factory, kind, type, router: this.typeRouter(type) };
    });
    const roots = [...this.routers.values()].filter(router => !this.nested.has(router));
    for (const { factory, kind, type, router: typedRouter } of clients) {
      const router = type ? typedRouter : roots.length === 1 ? roots[0] : undefined;
      this.proxies.set(factory, { kind, router, client: factory, prefix: [] });
      if (router) clientRoots.add(router);
    }
    for (const root of new Set([...roots, ...clientRoots])) {
      const paths = new Map<string, ProcedurePath>();
      this.rootPaths.set(root, paths);
      const walk = (router: Router, prefix: string[], ancestors: Map<Router, number>, unresolved?: Node) => {
        if (ancestors.has(router)) return;
        const branch = new Map(ancestors).set(router, prefix.length);
        const issue = unresolved ?? router.unresolved;
        for (const [key, entry] of router.entries) {
          const segments = [...prefix, key];
          if ('entries' in entry) {
            walk(entry, segments, branch, issue);
            continue;
          }
          const name = segments.join('.');
          const procedure = { ...entry, name, clientsKnown: clientRoots.has(root), unresolved: issue };
          paths.set(name, procedure);
          for (const [parent, offset] of branch) {
            const relative = this.allPaths.get(parent) ?? new Map<string, ProcedurePath[]>();
            this.allPaths.set(parent, relative);
            const key = segments.slice(offset).join('.');
            const matches = relative.get(key) ?? [];
            matches.push(procedure);
            relative.set(key, matches);
          }
        }
      };
      walk(root, [], new Map());
    }
    for (const [factory, kind] of factories) {
      if (kind === 'client') this.addLinks(factory, factory.getArguments()[0]);
    }
    for (const file of files.filter(file => file.getFullText().includes('createClient'))) visitKinds(file, TRPC_DISCOVERY_KINDS, node => {
      if (!Node.isCallExpression(node)) return;
      const callee = member(node.getExpression());
      if (callee?.key !== 'createClient') return;
      const proxy = this.proxy(callee.base);
      if (proxy?.kind === 'react' && proxy.client && !proxy.prefix.length) this.addLinks(proxy.client, node.getArguments()[0]);
    });
    for (const [file, route] of apiRoutes) {
      if (!file.getFullText().includes('@trpc/server/adapters/')) continue;
      const exports = file.getExportedDeclarations();
      const methods = new Map((route.methods ?? []).flatMap(method =>
        (exports.get(method) ?? []).flatMap(node => {
          const fn = functionNode(node);
          return fn ? [[method, fn] as const] : [];
        })));
      visitKinds(file, TRPC_DISCOVERY_KINDS, node => {
        if (!Node.isCallExpression(node) ||
            !imported(node.getExpression(), /^@trpc\/server\/adapters\/fetch$/, /^fetchRequestHandler$/)) return;
        const owner = node.getFirstAncestor(Node.isFunctionLikeDeclaration);
        const handled = [...methods].filter(([, fn]) => fn === owner).map(([method]) => method);
        if (!handled.length) return;
        const options = valueNode(node.getArguments()[0]);
        const endpoint = textValue(property(options, 'endpoint'));
        const router = this.router(property(options, 'router'));
        if (!router || !endpoint) return;
        const handlers = this.handlers.get(router) ?? [];
        handlers.push({ route: { ...route, methods: handled }, endpoint: endpoint.replace(/\/$/, '') });
        this.handlers.set(router, handlers);
      });
    }
  }

  private addLinks(factory: CallExpression, options: Node | undefined) {
    const previous = this.links.get(factory);
    if (previous === null) return;
    // All observed configurations must resolve for a unique dispatch.
    this.links.set(factory, null);
    const links = valueNode(property(valueNode(options), 'links'));
    if (!Node.isArrayLiteralExpression(links)) return;
    const clientPackage = /^@trpc\/client$/;
    const terminalLinks = (nodes: Node[], depth: number): CallExpression[] | undefined => {
      if (depth > 6 || nodes.length > 16) return;
      for (const node of nodes) {
        const link = valueNode(node);
        if (!Node.isCallExpression(link)) return;
        const expression = link.getExpression();
        if (imported(expression, clientPackage, /^loggerLink$/)) continue;
        if (imported(expression, clientPackage, httpLinks)) return [link];
        if (!imported(expression, clientPackage, /^splitLink$/)) return;
        const branches = valueNode(link.getArguments()[0]);
        const branch = (key: string) => {
          const value = valueNode(property(branches, key));
          return terminalLinks(Node.isArrayLiteralExpression(value) ? value.getElements() : value ? [value] : [], depth + 1);
        };
        const yes = branch('true');
        const no = branch('false');
        if (yes && no) return [...yes, ...no];
        return;
      }
    };
    const terminals = terminalLinks(links.getElements(), 0);
    if (!terminals) return;
    const entries: HttpLink[] = [];
    for (const link of terminals) {
      const settings = valueNode(link.getArguments()[0]);
      const url = property(settings, 'url');
      const override = property(settings, 'methodOverride');
      const methodOverride = textValue(override);
      if (!url || property(settings, 'fetch') || override && methodOverride !== 'POST') return;
      const pathOf = (text: string) => text.replace(/^(?:https?:\/\/[^/?#]+|[\0\x01]+)(?=\/)/, '').replace(/\/$/, '');
      const seen = new Set<Node>();
      let remaining = 24;
      const resolve = (value: Node): ReturnType<typeof urlTexts> => urlTexts(value, undefined, true, true, part => {
        if (!Node.isCallExpression(part) || part.getArguments().length || seen.size >= 4 || remaining-- <= 0) return;
        const fn = functionNode(part.getExpression());
        if (!fn || !this.files.has(fn.getSourceFile()) || seen.has(fn) || fn.getParameters().length) return;
        const returned = returns(fn.getBody());
        if (returned.length > 4) return;
        seen.add(fn);
        const values = returned.flatMap(expression => resolve(expression) ?? [{ text: '\0' }]);
        seen.delete(fn);
        return values.length ? values : undefined;
      });
      const urls = resolve(url);
      const paths = new Set(urls?.map(value => pathOf(value.text)));
      if (paths.size !== 1) return;
      const [prefix] = paths;
      if (!/^\/(?!\/)[\w/.-]+$/.test(prefix)) return;
      entries.push({ prefix, site: link, methodOverride });
    }
    this.links.set(factory, [...previous ?? [], ...entries]);
  }

  private httpDispatch(site: CallExpression, proxy: Proxy, name: string, operation: string): Pick<ProcedureUse, 'transport' | 'transportIssue' | 'transportRoutes'> {
    const method = mutationCalls.test(operation) ? 'POST' :
      /^(?:query|useQuery|useSuspenseQuery|useInfiniteQuery|useSuspenseInfiniteQuery)$/.test(operation) ? 'GET' : undefined;
    if (operation.startsWith('use') && Node.isFalseLiteral(valueNode(property(valueNode(site.getArguments()[1]), 'enabled')))) return {};
    if (!method || !proxy.client || !proxy.router || proxy.kind !== 'react' && proxy.kind !== 'client') return {};
    const links = this.links.get(proxy.client) ?? [];
    const handlers = this.handlers.get(proxy.router) ?? [];
    const candidates = links.flatMap(link => {
      const methodToSend = link.methodOverride === 'POST' ? 'POST' : method;
      const matching = handlers.filter(handler => handler.endpoint === link.prefix && handler.route.methods?.includes(methodToSend));
      const [match] = matchNextRoutes(link.prefix + '/' + name, matching, handler => handler.route.path);
      return match ? [{ method: methodToSend, route: match.route, link: link.site }] : [];
    });
    const first = candidates[0];
    if (first && links.length === candidates.length && candidates.every(candidate =>
      candidate.method === first.method && candidate.route.id === first.route.id)) {
      return { transport: { ...first, links: [...new Set(candidates.map(candidate => candidate.link))] } };
    }
    return this.links.has(proxy.client) || handlers.length ? {
      transportIssue: 'tRPC HTTP handler or client dispatch unresolved',
      transportRoutes: handlers.map(handler => handler.route)
    } : {};
  }

  procedures() {
    return [...this.rootPaths.values()].flatMap(paths => [...paths.values()]);
  }

  private localValue = (node: Node) => {
    // Shorthand properties have a separate symbol for the value binding.
    if (Node.isShorthandPropertyAssignment(node)) {
      const symbol = node.getValueSymbol();
      return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()[0];
    }
    return this.resolveDeclarations(node)[0];
  };

  private isInit(node: Node | undefined, seen = new Set<Node>()): boolean {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (imported(node, serverPackage, /^initTRPC$/)) return true;
    if (Node.isCallExpression(node)) {
      const called = member(node.getExpression());
      return !!called?.key && /^(?:create|context|meta)$/.test(called.key) && this.isInit(called.base, seen);
    }
    if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
      return this.isInit(initializer(this.localValue(node), this.localValue), seen);
    }
    return false;
  }

  private routerFactory(node: Node, seen = new Set<Node>()): string | undefined {
    if (seen.has(node)) return;
    seen.add(node);
    const access = member(node);
    if (access?.key && /^(?:router|mergeRouters)$/.test(access.key) && this.isInit(access.base)) return access.key;
    const value = initializer(this.localValue(node), this.localValue);
    if (value) return this.routerFactory(value, seen);
  }

  private isRouterCall(call: CallExpression) {
    const [arg] = call.getArguments();
    if (!arg) return false;
    return this.routerFactory(call.getExpression());
  }

  private router(node: Node | undefined, seen = new Set<Node>()): Router | undefined {
    node = unwrap(node);
    if (!node || !this.files.has(node.getSourceFile()) || seen.has(node)) return;
    seen.add(node);
    if (Node.isCallExpression(node)) {
      const known = this.routers.get(node);
      if (known) return known;
      const factory = this.isRouterCall(node);
      if (!factory) return;
      const result: Router = { entries: new Map() };
      this.routers.set(node, result);
      const args = node.getArguments();
      if (factory === 'mergeRouters') {
        for (const arg of args) {
          const child = this.router(arg, seen);
          if (!child) result.unresolved ??= arg;
          else {
            for (const [name, entry] of child.entries) result.entries.set(name, entry);
            result.unresolved ??= child.unresolved;
          }
        }
      } else this.readObject(args[0], result, seen, node);
      return result;
    }
    if (Node.isIdentifier(node) || member(node) || Node.isShorthandPropertyAssignment(node)) {
      return this.router(initializer(this.localValue(node), this.localValue), seen);
    }
  }

  private readObject(node: Node | undefined, result: Router, seen: Set<Node>, site: Node) {
    node = unwrap(node);
    if (!node || !this.files.has(node.getSourceFile()) || seen.has(node)) {
      result.unresolved ??= site;
      return;
    }
    const branch = new Set(seen).add(node);
    if (!Node.isObjectLiteralExpression(node)) {
      this.readObject(initializer(this.localValue(node), this.localValue), result, branch, site);
      return;
    }
    for (const property of node.getProperties()) {
      if (Node.isSpreadAssignment(property)) {
        this.readObject(property.getExpression(), result, branch, property);
        continue;
      }
      if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) {
        result.unresolved ??= property;
        continue;
      }
      const key = property.getNameNode();
      if (!Node.isIdentifier(key) && !Node.isStringLiteral(key) && !Node.isNumericLiteral(key)) {
        result.unresolved ??= property;
        continue;
      }
      const name = Node.isIdentifier(key) ? key.getText() : String(key.getLiteralValue());
      const value = unwrap(Node.isPropertyAssignment(property) ? property.getInitializer() : initializer(this.localValue(property), this.localValue));
      const procedure = this.procedure(value);
      if (procedure) result.entries.set(name, { ...procedure, property });
      else {
        const child = this.router(value, new Set(branch));
        if (child) {
          this.nested.add(child);
          result.entries.set(name, child);
        } else {
          const recordNode = Node.isIdentifier(value) || member(value)
            ? unwrap(initializer(this.localValue(value!), this.localValue)) : value;
          if (Node.isObjectLiteralExpression(recordNode)) {
            const record: Router = { entries: new Map() };
            this.readObject(recordNode, record, branch, property);
            result.entries.set(name, record);
          } else result.unresolved ??= property;
        }
      }
    }
  }

  private procedure(node: Node | undefined, seen = new Set<Node>()): Omit<Procedure, 'property'> | undefined {
    node = unwrap(node);
    if (!node || !this.files.has(node.getSourceFile()) || seen.has(node)) return;
    seen.add(node);
    if (!Node.isCallExpression(node)) {
      if (Node.isIdentifier(node) || member(node)) return this.procedure(initializer(this.localValue(node), this.localValue), seen);
      return;
    }
    const operation = member(node.getExpression());
    const resolver = unwrap(node.getArguments()[0]);
    if (!operation?.key || !procedureOperations.test(operation.key) || !resolver) return;
    // The surrounding tRPC router establishes what this builder represents.
    return { body: node, resolver };
  }

  private typeRouter(node: Node | undefined, seen = new Set<Node>()): Router | undefined {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (Node.isTypeQuery(node)) return this.router(node.getExprName());
    if (Node.isTypeReference(node)) {
      const binding = this.localValue(node.getTypeName());
      if (Node.isTypeAliasDeclaration(binding)) return this.typeRouter(binding.getTypeNode(), seen);
    }
  }

  private callerFactory(node: Node, seen = new Set<Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (imported(node, serverPackage, /^createCallerFactory$/)) return true;
    const access = member(node);
    if (access?.key === 'createCallerFactory' && this.isInit(access.base)) return true;
    const value = initializer(this.localValue(node), this.localValue);
    return !!value && this.callerFactory(value, seen);
  }

  private callerRouter(node: Node, seen = new Set<Node>()): Router | undefined {
    if (seen.has(node)) return;
    seen.add(node);
    const access = member(node);
    if (access?.key === 'createCaller') return this.router(access.base);
    if (Node.isCallExpression(node) && this.callerFactory(node.getExpression())) return this.router(node.getArguments()[0]);
    if (Node.isIdentifier(node) || access) {
      const value = unwrap(initializer(this.localValue(node), this.localValue));
      if (value) return this.callerRouter(value, seen);
    }
  }

  private proxy(node: Node | undefined, seen = new Set<Node>()): Proxy | undefined {
    node = unwrap(node);
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (this.proxies.has(node)) return this.proxies.get(node) ?? undefined;
    const result = this.resolveProxy(node, seen);
    this.proxies.set(node, result ?? null);
    return result;
  }

  private resolveProxy(node: Node, seen: Set<Node>): Proxy | undefined {
    if (Node.isCallExpression(node)) {
      const expression = node.getExpression();
      const router = this.callerRouter(expression);
      if (router) return { kind: 'caller', router, prefix: [] };
      const hook = this.proxy(expression, seen);
      if (hook?.kind === 'react' && hook.prefix.at(-1) === 'useMutation') {
        return { ...hook, prefix: hook.prefix.slice(0, -1), mutation: true };
      }
      if (hook?.prefix.length === 1) {
        const [operation] = hook.prefix;
        if (hook.kind === 'react' && (operation === 'useUtils' || operation === 'useContext')) {
          return { kind: 'cache', router: hook.router, prefix: [] };
        }
        if (hook.kind === 'context' && (operation === 'useTRPC' || operation === 'useTRPCClient')) {
          return { kind: operation === 'useTRPC' ? 'options' : 'client', router: hook.router, prefix: [] };
        }
      }
      return;
    }
    if (!Node.isIdentifier(node) && !member(node)) return;
    const declaration = this.localValue(node);
    const value = initializer(declaration, this.localValue);
    if (value) return this.proxy(value, seen);
    if (Node.isBindingElement(declaration) && Node.isObjectBindingPattern(declaration.getParent())) {
      const key = declaration.getPropertyNameNode() ?? declaration.getNameNode();
      const name = Node.isIdentifier(key) ? key.getText() : Node.isStringLiteral(key) ? key.getLiteralText() : undefined;
      const init = unwrap(initializer(declaration.getParent().getParent(), this.localValue));
      const base = this.proxy(init, seen);
      if (base && !declaration.getDotDotDotToken()) return { ...base, prefix: [...base.prefix, name] };
      // createHydrationHelpers exposes the server-side proxy as its `trpc` property.
      if (name === 'trpc' && Node.isCallExpression(init) &&
          imported(init.getExpression(), /^@trpc\/react-query\/rsc$/, /^createHydrationHelpers$/)) {
        const caller = this.proxy(init.getArguments()[0], seen);
        const router = caller?.router ?? this.typeRouter(init.getTypeArguments()[0]);
        return { kind: 'hydration', router, prefix: [] };
      }
    }
    const access = member(node);
    if (access) {
      const base = this.proxy(access.base, seen);
      if (base) return { ...base, prefix: [...base.prefix, access.key] };
    }
  }

  uses(call: CallExpression): ProcedureUse[] | undefined {
    const expression = unwrap(call.getExpression());
    if (!member(expression) && !Node.isIdentifier(expression)) return;
    if (Node.isIdentifier(expression)) {
      const binding = this.localValue(expression);
      if (!Node.isBindingElement(binding) && !Node.isVariableDeclaration(binding)) return;
    }
    const proxy = this.proxy(expression);
    if (!proxy || !proxy.prefix.length) return;
    const path = [...proxy.prefix];
    if (proxy.kind === 'caller') return [this.pathUse(call, proxy, path, 'createCaller', false)];
    if (proxy.kind === 'hydration') {
      const prefetch = path.at(-1) === 'prefetch' && !(proxy.router && this.rootPaths.get(proxy.router)?.has(path.join('.')));
      return [this.pathUse(call, proxy, prefetch ? path.slice(0, -1) : path,
        prefetch ? 'prefetch' : path.at(-1) ?? 'call', prefetch)];
    }
    const operation = path.pop();
    if (operation === undefined) return [this.unresolvedUse(call, proxy, path, 'call', false)];
    if (proxy.kind === 'context') return;
    if (proxy.mutation) {
      if (mutationCalls.test(operation)) return [this.pathUse(call, proxy, path, operation, false)];
      return;
    }
    if (proxy.kind === 'react' && !path.length && batchHooks.test(operation)) {
      return this.batchUses(call, proxy, operation);
    }
    const cache = proxy.kind === 'cache' && cacheOperations.test(operation) ||
      proxy.kind === 'options' && keyOperations.test(operation);
    if (!cache) {
      if (proxy.kind === 'cache' && !queryOperations.test(operation) ||
          proxy.kind === 'react' && !hookOperations.test(operation) ||
          proxy.kind === 'client' && !clientOperations.test(operation)) return;
      if (proxy.kind === 'options' && !optionsOperations.test(operation)) {
        return [this.unresolvedUse(call, proxy, path, operation, false)];
      }
    }
    return [this.pathUse(call, proxy, path, operation, cache)];
  }

  private batchUses(call: CallExpression, proxy: Proxy, operation: string): ProcedureUse[] {
    const callback = unwrap(call.getArguments()[0]);
    const fn = Node.isArrowFunction(callback) || Node.isFunctionExpression(callback) ? callback : undefined;
    const parameter = fn?.getParameters()[0];
    const body = fn?.getBody();
    const statements = Node.isBlock(body) ? body.getStatements() : [];
    const returned = statements.length === 1 && Node.isReturnStatement(statements[0]) ? statements[0].getExpression() : body;
    const array = unwrap(returned);
    if (!parameter || !Node.isArrayLiteralExpression(array)) return [this.unresolvedUse(call, proxy, [], operation, false)];

    const uses: ProcedureUse[] = [];
    const elements = array.getElements();
    for (const element of elements) {
      const query = unwrap(element);
      if (!Node.isCallExpression(query)) continue;
      let base = unwrap(query.getExpression());
      const path: Proxy['prefix'] = [];
      for (let access = member(base); access; access = member(base)) {
        path.unshift(access.key);
        base = unwrap(access.base);
      }
      if (path.length && base && this.localValue(base) === parameter) {
        uses.push(this.pathUse(query, proxy, path, operation, false));
      }
    }
    if (uses.length !== elements.length) uses.push(this.unresolvedUse(call, proxy, [], operation, false));
    return uses;
  }

  private pathUse(site: CallExpression, proxy: Proxy, path: Proxy['prefix'], operation: string, cache: boolean): ProcedureUse {
    const registry = proxy.router && (proxy.kind === 'caller' ? this.allPaths.get(proxy.router) : this.rootPaths.get(proxy.router));
    const key = path.join('.');
    if (registry && path.every(segment => segment !== undefined)) {
      const exact = registry.get(key);
      if (exact) return { site, operation, cache, targets: Array.isArray(exact) ? exact : [exact],
        ...!cache && this.httpDispatch(site, proxy, key, operation) };
      if (cache && (proxy.kind === 'cache' || operation === 'pathFilter' || operation === 'pathKey')) {
        const targets = this.under(registry, key);
        if (targets.length) return { site, operation, cache, targets };
      }
    }
    return this.unresolvedUse(site, proxy, path, operation, cache);
  }

  private unresolvedUse(site: CallExpression, proxy: Proxy, path: Proxy['prefix'], operation: string, cache: boolean): ProcedureUse {
    const registry = proxy.router && (proxy.kind === 'caller' ? this.allPaths.get(proxy.router) : this.rootPaths.get(proxy.router));
    const dynamic = path.indexOf(undefined);
    const scope = path.slice(0, dynamic < 0 ? path.length : dynamic);
    let unresolved = this.under(registry, scope.join('.'));
    while (!unresolved.length && registry && scope.length) {
      scope.pop();
      unresolved = this.under(registry, scope.join('.'));
    }
    return { site, operation, cache, targets: [], unresolved };
  }

  private under(registry: Map<string, ProcedurePath | ProcedurePath[]> | undefined, prefix: string) {
    const matches = (key: string) => !prefix || key === prefix || key.startsWith(prefix + '.');
    return registry ? [...registry.entries()].filter(([key]) => matches(key)).flatMap(([, paths]) => paths) :
      this.procedures().filter(candidate => matches(candidate.name));
  }
}
