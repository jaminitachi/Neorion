import { compileMiddlewareMatcher, middlewareMatcher } from '../core/analyzers/NextRouteMatch';
import { AI_SDK_TRANSPORT, AI_SDK_URL_OVERRIDE, transportIssue, GRAPH_INDEX_REVISION, GraphReferenceKind, isTestFile, renderIssue, renderSiteKey,
  type ExternalCall, type FlowGate, type ModuleImport, type PageRenderCondition, type QueryIndex,
  type RuntimeExportState, type ServerAction, type SymbolEntry, type TrpcUse } from './Index';

type Route = QueryIndex['routes'][number];
type NodeId = number | string;
type Label = 'call' | 'event' | 'action' | 'render' | 'fetch' | 'dyn' | 'use' | 'trpc' | 'data' | 'middleware' | 'navigate' | 'redirect' | 'rewrite' | 'wrap' | 'load' | 'submit';
type Edge = {
  from: NodeId; to: NodeId; label: Label; file: string; line: number;
  site?: string; gates?: FlowGate[];
  local?: boolean;
  matcher?: NonNullable<QueryIndex['pagesEdges']>[number]['matcher'];
  detail?: string; destination?: Route; sourceRoute?: number; conditional?: boolean; partial?: boolean; url?: string; method?: string; uncertainty?: string; transportIssue?: string; typeOnly?: true;
  possibleReconnect?: true;
};
type PathEdge = Edge;
type Visit = { depth: number; edge?: Edge; conditional?: boolean; possible?: boolean; via?: string[] };
export type QueryRow = { text: string; files: string[]; pathEnd?: number; annotation?: string; suffix?: string };
export type QueryResult = {
  rows: QueryRow[]; title?: string; count?: string; targets?: string[];
  unresolvedWorkspace?: Iterable<string>;
  notes?: QueryRow[]; limit?: number; suggestedFilter?: string; partial?: string; scope?: string;
  routerTraversal?: ReadonlySet<number>;
};
export type ChangeOrigin = { file: string; name: string; ids: NodeId[]; removed?: boolean; startsAt?: number;
  renamed?: boolean; externalOnly?: boolean; importFiles?: ReadonlySet<string> };
export type Terminal = { kind: string; name: string; file: string; line?: number; route?: Route; pages?: Route[];
  handler?: number; matchedRoutes?: Route[] };
type Reached = { terminal: Terminal; visit: Visit; node: NodeId; metadata: boolean };
const rank: Record<Label, number> = { call: 0, action: 1, event: 2, render: 2, fetch: 3, dyn: 4, use: 5, trpc: 1, data: 0, middleware: 1, navigate: 3, redirect: 3, rewrite: 3, wrap: 6, load: 3, submit: 3 };
const outgoingRank: Record<Label, number> = { render: 0, event: 1, call: 1, action: 1, fetch: 2, dyn: 3, use: 4, trpc: 1, data: 0, middleware: 1, navigate: 3, redirect: 3, rewrite: 3, wrap: 6, load: 3, submit: 3 };
const nodeBudget = 5000;
const hubSize = 30;
const fetchTypes = new Set(['fetch', 'SWR key', 'axios', 'Playwright request', 'tRPC request', AI_SDK_TRANSPORT]);
const renderKey = (edge: Edge) => edge.label === 'render' && typeof edge.from === 'number' && typeof edge.to === 'number'
  ? renderSiteKey(edge.from, edge.to, edge.line) : undefined;
const strongerTransportIssue = (a?: string, b?: string) =>
  a === AI_SDK_URL_OVERRIDE ? a : b ?? a;
const isNavigation = (label: Label) => label === 'navigate' || label === 'redirect' || label === 'rewrite';
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const graphRow = (text: string, ...files: string[]): QueryRow => ({ text, files });
export const quantity = (count: number, singular: string, plural = singular + 's') => `${count} ${count === 1 ? singular : plural}`;
export const moduleStops = (count: number) => `stopped at ${quantity(count, 'module-level use')} (importers not traced)`;
const depthLimit = (count: number, depth: number) => count ?
  `depth limit (${quantity(count, 'unexplored caller')} at d=${depth}${depth < 6 ? `; rerun --depth ${Math.min(6, depth + 2)}` : ''})` : undefined;
function middlewareRoutes(routes: Route[], matchers: string[] | undefined) {
  if (!matchers) return;
  if (!matchers.length) return routes;
  const patterns = matchers.map(matcher => {
    if (!matcher.startsWith('/')) return;
    const exclusion = /^\/\(\(\?!([^\n]{1,512})\)\.\*\)$/.exec(matcher)?.[1];
    // Accept the usual static-prefix and file-extension exclusions. Leave
    // arbitrary regex and conditional matchers to Next.js.
    const excludeTerm = String.raw`(?:[\w/-]+(?:\\?\.[\w/-]+)*|\.\*\\\.(?:\.\*|\(\?:[a-z]+(?:\|[a-z]+)*\)\$))`;
    if (exclusion && new RegExp(`^${excludeTerm}(?:\\|${excludeTerm})*$`).test(exclusion)) {
      const excluded = new RegExp(`^(?:${exclusion})`);
      return (url: string) => !excluded.test(url.slice(1));
    }
    const parts = matcher.split('/').filter(Boolean);
    if (parts.some((part, i) =>
      !/^[\w.-]+$|^:\w+$/.test(part) && !(i === parts.length - 1 && /^:\w+[+*?]$/.test(part)))) return;
    const modifier = /^:\w+([+*?])$/.exec(parts[parts.length - 1])?.[1];
    const fixed = modifier ? parts.slice(0, -1) : parts;
    return (url: string) => {
      const path = url.split('/').filter(Boolean);
      return path.length >= fixed.length + Number(modifier === '+') &&
        (!modifier ? path.length === fixed.length : modifier !== '?' || path.length <= fixed.length + 1) &&
        fixed.every((part, i) => part.startsWith(':') || part === path[i] || path[i].startsWith('['));
    };
  });
  if (patterns.some(pattern => !pattern)) return;
  const pageMatchers = matchers.map(compileMiddlewareMatcher);
  return routes.filter(({ url, pages }) => patterns.some((pattern, i) => {
    const membership = pages ? pageMatchers[i]?.(url) : undefined;
    return membership === undefined ? pattern!(url) : membership !== 'no';
  }));
}
const location = (file: string, line?: number) => file + (line === undefined ? '' : ':' + line);
const edgeOrder = (a: Edge, b: Edge) => rank[a.label] - rank[b.label] || compare(a.file, b.file) ||
  a.line - b.line || compare(String(a.from), String(b.from)) || compare(String(a.to), String(b.to));
const pathEdgeOrder = (a: PathEdge, b: PathEdge) =>
  (a.label === 'wrap' ? 6 : rank[a.label]) - (b.label === 'wrap' ? 6 : rank[b.label]) ||
  compare(a.file, b.file) || a.line - b.line || compare(String(a.from), String(b.from)) || compare(String(a.to), String(b.to));
const terminalKey = (terminal: Terminal) => JSON.stringify([terminal.kind, terminal.file, terminal.name, ...(terminal.route?.router ? [terminal.route.id] : [])]);
const terminalOrder = (a: Reached, b: Reached) => a.visit.depth - b.visit.depth ||
  compare(a.terminal.file, b.terminal.file) || (a.terminal.line ?? 0) - (b.terminal.line ?? 0) ||
  compare(a.terminal.name, b.terminal.name);
const certaintyFlags = (visit: Visit) => (visit.possible ? 2 : 0) | (visit.conditional ? 1 : 0);
const terminalCertainty = (visit: Visit) => certaintyFlags(visit) | (visit.edge?.partial ? 2 : 0);
// A shorter path can discover more callers within the depth limit, even if a
// longer path gives better evidence for a route. Keep both when neither dominates.
const coversVisit = (depths: number[] | undefined, flags: number, depth: number, current = false) =>
  depths?.some((earlier, priorFlags) => (priorFlags & flags) === priorFlags &&
    (earlier < depth || earlier === depth && (!current || priorFlags !== flags)));

function append<K, V>(map: Map<K, V[]>, id: K, value: V) {
  const entries = map.get(id);
  if (entries) entries.push(value);
  else map.set(id, [value]);
}

// A backward trace carries the required supplying render sites until it
// crosses the render edge that entered the receiver.
const entersReceiver = (edge: Edge) => edge.label === 'render' || edge.label === 'wrap' || edge.label === 'dyn';
function predecessorGates(edge: Edge, pending: FlowGate[]) {
  const remaining: FlowGate[] = [];
  for (const gate of pending) {
    if (edge.to !== gate.scope) remaining.push(gate);
    else if (!entersReceiver(edge) || (edge.site ? !gate.sites.includes(edge.site) : !gate.unscoped)) return;
  }
  for (const gate of edge.gates ?? []) if (!remaining.includes(gate)) remaining.push(gate);
  return remaining;
}

const isEvent = (detail?: string) => /^on[A-Z]/.test(detail ?? '');
// A callback supplied at a render site belongs to the supplier's impact path.
// Its invocation and the matched render edges only connect it back to that site.
const impactCost = (edge: Edge, gates: FlowGate[]) => edge.local || edge.gates?.some(gate => gate.callback) ||
  entersReceiver(edge) && gates.some(gate => gate.callback && gate.scope === edge.to) ? 0 : 1;
const stateKey = (id: NodeId, gates: FlowGate[]) => JSON.stringify([id, gates]);
const propUrlIssue = 'request URL from JSX prop untraced';
const propValueIssue = 'prop value untraced at a render site';
const gateIssue = (edge: Edge) => edge.gates?.some(gate => gate.partial) ? propValueIssue : undefined;
const uncertainEntry = (edge: Edge, gates: FlowGate[]) => entersReceiver(edge) && gates.some(gate =>
  gate.scope === edge.to && (edge.site ? gate.uncertainSites?.includes(edge.site) : gate.unscoped));
type RenderContexts = [number, string][];
const matchesContext = (gate: FlowGate, contexts: RenderContexts) => {
  const binding = contexts.find(([scope]) => scope === gate.scope);
  if (!binding) return;
  if (!binding[1]) return gate.unscoped ? undefined : false;
  if (!gate.sites.includes(binding[1])) return false;
  return gate.uncertainSites?.includes(binding[1]) ? undefined : true;
};
const permits = (gates: FlowGate[] | undefined, contexts: RenderContexts) =>
  !gates?.some(gate => matchesContext(gate, contexts) === false);
const forwardKey = (id: NodeId, contexts: RenderContexts) => contexts.length ? JSON.stringify([id, contexts]) : id;

export function hasGraph(index: QueryIndex) {
  return index.graphRevision === GRAPH_INDEX_REVISION && Array.isArray(index.externalCalls) &&
    Array.isArray(index.externalModules) && Array.isArray(index.graphNames) && Array.isArray(index.fileSymbols) &&
    Array.isArray(index.trpcFiles) && Array.isArray(index.serverActions) &&
    !!(index.routeFiles && index.defaultSymbols && index.exportSymbols && index.runtimeExports && index.moduleImports &&
      index.unresolvedCalls && index.graphReferences && index.layoutStyles);
}

export class DependencyGraph {
  private symbols: Map<number, SymbolEntry>;
  private files = new Map<number, string>();
  private fileIds = new Map<string, number>();
  private moduleImporters = new Map<number, [file: string, entry: ModuleImport][]>();
  private symbolsByFile = new Map<string, SymbolEntry[]>();
  private incoming = new Map<NodeId, Edge[]>();
  private outgoing = new Map<NodeId, Edge[]>();
  private actions = new Map<NodeId, ServerAction>();
  private actionTargets: { id: number; action: ServerAction }[] = [];
  private handlerRoutes = new Map<NodeId, Terminal[]>();
  private routesByFile = new Map<string, Terminal[]>();
  private routerTerminals?: Map<NodeId, Terminal>;
  private routerParents?: Map<number, number>;
  private api = new Map<string, Terminal>();
  private pageRoots = new Map<NodeId, Terminal[]>();
  private external = new Map<NodeId, ExternalCall[]>();
  private trpc: Set<string>;
  private unboundProcedures: Set<number>;
  private procedureSites = new Map<number, { file: string; use: TrpcUse }[]>();
  private trpcModuleUses = new Map<number, Set<string>>();
  private pagesByFileId = new Map<NodeId, Route>();
  private pageRenderSites?: Set<string>;
  private pagesMiddleware = new Map<number, { exact: Set<number>; possible: Set<number> }>();
  private fetches = new Map<string, QueryIndex['fetches']>();
  private uncertainTransports = new Map<number, string>();
  private unboundedTransport?: string;
  private unboundedProductionTransport?: string;
  private gateScopes = new Set<number>();
  private propRequests = new Map<number, NonNullable<QueryIndex['uncertainPropRequests']>>();

  constructor(private index: QueryIndex, symbols: Map<number, SymbolEntry>) {
    this.symbols = symbols;
    this.trpc = new Set(index.trpcFiles);
    this.unboundProcedures = new Set(index.trpcUnbound);
    for (const request of index.uncertainPropRequests ?? []) {
      append(this.propRequests, request.owner, request);
      for (const gate of request.gates ?? []) this.gateScopes.add(gate.scope);
    }
    for (const dependencies of Object.values(index.workspaceDependencies ?? {})) for (const entry of dependencies) {
      for (const gate of entry.gates ?? []) this.gateScopes.add(gate.scope);
    }
    for (const issues of Object.values(index.flowIssues ?? {})) for (const issue of issues) {
      for (const gate of issue.gates) this.gateScopes.add(gate.scope);
    }
    for (const [file, uses] of Object.entries(index.trpcModuleUses ?? {})) {
      this.trpcModuleUses.set(Number(file), new Set(uses.map(([target, line]) => `${target}:${line}`)));
    }
    const filePaths = Object.keys(index.files);
    filePaths.forEach((file, offset) => {
      const id = index.fileSymbols![offset];
      this.files.set(id, file);
      this.fileIds.set(file, id);
    });
    for (const symbol of symbols.values()) append(this.symbolsByFile, symbol.file, symbol);
    for (const [file, owner, unbounded, , override] of index.uncertainChatTransports ?? []) {
      const issue = transportIssue(override !== false);
      for (const id of [owner, ...index.trpcAliases?.[owner] ?? []]) {
        this.uncertainTransports.set(id, strongerTransportIssue(this.uncertainTransports.get(id), issue)!);
      }
      if (unbounded === false) continue;
      this.unboundedTransport = strongerTransportIssue(this.unboundedTransport, issue);
      if (!isTestFile(file)) this.unboundedProductionTransport = strongerTransportIssue(this.unboundedProductionTransport, issue);
    }

    if (index.pagesRenderConditions) {
      this.pageRenderSites = new Set(Object.values(index.pagesRenderConditions).flatMap(Object.keys));
    }
    const pages = index.routes.filter(route => route.kind === 'page');
    if (index.router) {
      this.routerTerminals = new Map();
      const ids = new Map(index.routes.map(route => [route.router?.id, route.id]));
      this.routerParents = new Map(index.routes.flatMap(route => {
        const parent = route.router?.parentId && ids.get(route.router.parentId);
        return typeof parent === 'number' ? [[route.id, parent] as const] : [];
      }));
    }
    for (const route of index.routes) {
      if (route.router) {
        const terminal = { kind: route.kind, name: route.url, file: route.file, line: route.line, route };
        this.routerTerminals!.set(this.routerId(route), terminal);
        append(this.routesByFile, route.file, terminal);
        continue;
      }
      if (route.pages && route.fileSymbol !== undefined) this.pagesByFileId.set(route.fileSymbol, route);
      if (route.kind === 'page') {
        const terminal = { kind: 'page', name: route.url, file: route.file, line: route.line, route };
        append(this.routesByFile, route.file, terminal);
        if (route.component) append(this.pageRoots, route.component, terminal);
      } else {
        for (const method of route.methods?.length ? route.methods : ['?']) {
          const name = method === '?' ? route.url : method + ' ' + route.url;
          const terminal = { kind: 'api', name, file: route.file, route, handler: route.handlers?.[method] };
          this.api.set(this.apiId(route, method), terminal);
          append(this.routesByFile, route.file, terminal);
          const handler = route.handlers?.[method];
          if (handler !== undefined) append(this.handlerRoutes, handler, terminal);
        }
      }
    }
    for (const [file, [kind, url, matcher, component, matchers]] of Object.entries(index.routeFiles!)) {
      const directory = file.slice(0, file.lastIndexOf('/') + 1);
      const wrapped = kind === 'app-shell' ? pages.filter(page => /^(?:src\/)?pages\//.test(page.file)) :
        kind === 'layout' || kind === 'template' ? pages.filter(page =>
          page.file.startsWith(directory) || page.layouts?.some(id => this.file(id) === file)) : undefined;
      const terminal = { kind, name: matcher ?? url, file, pages: wrapped,
        matchedRoutes: kind === 'middleware' ? middlewareRoutes(index.routes, matchers) : undefined };
      append(this.routesByFile, file, terminal);
      if (component !== undefined && this.file(component) !== file) append(this.pageRoots, component, terminal);
    }

    for (const action of index.serverActions!) {
      const candidates = this.symbolsByFile.get(action.file) ?? [];
      const symbol = this.symbols.get(action.symbol ?? 0) ?? candidates.find(symbol => symbol.name === action.name) ??
        candidates.find(symbol => symbol.line === action.line && action.aliases?.includes(symbol.name));
      if (!symbol) continue;
      this.actionTargets.push({ id: symbol.id, action });
      if (!this.actions.has(symbol.id) || symbol.file === action.file) this.actions.set(symbol.id, action);
    }
    const edges = new Set<string>();
    const addEdge = (edge: Edge) => {
      const key = JSON.stringify([edge.from, edge.to, edge.label, edge.file, edge.line, edge.detail ?? '', edge.method, edge.site, edge.gates, edge.typeOnly, ...(index.router ? [edge.sourceRoute, edge.destination?.id] : [])]);
      if (edges.has(key)) return;
      edges.add(key);
      for (const gate of edge.gates ?? []) this.gateScopes.add(gate.scope);
      if (!isNavigation(edge.label)) append(this.incoming, edge.to, edge);
      append(this.outgoing, edge.from, edge);
    };
    const add = (edge: Edge) => {
      addEdge(edge);
      if (typeof edge.from !== 'number') return;
      for (const alias of index.trpcAliases?.[edge.from] ?? []) addEdge({ ...edge, from: alias });
    };
    const calls = new Set<string>();
    const lexicalOwner = (id: NodeId) => {
      while (typeof id === 'number' && index.callableOwners?.[id] !== undefined) id = index.callableOwners[id];
      return id;
    };
    const callSite = (to: NodeId, from: NodeId, line: number) => JSON.stringify([to, from, line]);
    const keyOf = (from: NodeId, to: NodeId, line: number) => `${from}:${to}:${line}`;
    const invocation = (from: NodeId, to: number, file: string, line: number, detail?: string, gates?: FlowGate[], possible?: true) => {
      const key = keyOf(from, to, line);
      add({ from, to, label: this.actions.has(to) ? 'action' : isEvent(detail) ? 'event' : 'call', file, line,
        local: index.callableOwners?.[to] !== undefined && lexicalOwner(to) === lexicalOwner(from),
        partial: possible || !!index.callIssues?.[key],
        uncertainty: index.callIssues?.[key] ?? (possible ? this.coverageIssue(from) : undefined),
        detail: detail || index.refEvidence?.[key], gates: gates ?? index.callGates?.[key] });
      calls.add(callSite(to, from, line));
    };
    for (const [target, referenceFile, line, kind, detail, owner, graphOwner, possible] of index.references) {
      const file = typeof referenceFile === 'number' ? filePaths[referenceFile] : referenceFile ?? this.file(target);
      if (kind === 'call') {
        const from = graphOwner ?? owner ?? this.fileNode(file);
        invocation(from, target, file, line, detail ?? undefined, undefined, possible);
      } else if (kind === 'use' || kind === 'type-use') {
        add({ from: owner ?? this.fileNode(file), to: target, label: 'use', file, line, typeOnly: kind === 'type-use' || undefined });
      }
    }
    for (const [fileKey, refs] of Object.entries(index.graphReferences!)) {
      const fileId = Number(fileKey);
      const file = this.file(fileId);
      for (const [to, line, kind, owner, detail] of refs) {
        const label = kind === GraphReferenceKind.MemberCall ? 'call' : kind === GraphReferenceKind.DynamicImport ? 'dyn' :
          kind === GraphReferenceKind.Render ? 'render' : 'use';
        add({ from: owner ?? fileId, to, label, file, line,
          detail: label === 'call' && detail !== undefined ? index.graphNames![detail] : undefined,
          conditional: label === 'render' && !!detail, typeOnly: kind === GraphReferenceKind.TypeUse || undefined });
      }
    }
    for (const [from, to, file, line, detail, gates] of index.flowCalls ?? []) invocation(from, to, file, line, detail, gates ?? []);
    for (const { id, action } of this.actionTargets) {
      for (const [file, line, owner] of action.callers) {
        const from = owner ?? this.fileNode(file);
        if (!calls.has(callSite(id, from, line))) invocation(from, id, file, line);
      }
    }
    for (const [from, to, line, conditional, , possible, detail, site, file] of index.renderEdges) {
      const source = file ?? this.file(from);
      add({ from, to, label: 'render', file: source, line, conditional: !!conditional, partial: possible || undefined, detail: detail ?? undefined, site: site ?? undefined,
        uncertainty: possible ? detail ? `${renderIssue(detail)} (${location(source, line)})` :
          this.coverageIssue(from) : undefined });
    }
    const routes = new Map(index.routes.map(route => [route.id, route]));
    for (const fact of index.pagesEdges ?? []) {
      const route = fact.route === undefined ? undefined : routes.get(fact.route);
      const to = fact.to ?? route?.fileSymbol;
      if (to === undefined) continue;
      add({ from: fact.from, to, label: fact.kind, file: fact.file, line: fact.line, detail: fact.detail,
        destination: route, partial: fact.possible, conditional: fact.possible, matcher: fact.matcher,
        uncertainty: fact.possible ? this.coverageIssue(fact.from) : undefined });
      if (fact.kind === 'middleware') {
        const matches = this.pagesMiddleware.get(to) ?? { exact: new Set<number>(), possible: new Set<number>() };
        (fact.possible ? matches.possible : matches.exact).add(fact.from);
        this.pagesMiddleware.set(to, matches);
      }
    }
    for (const fact of index.router?.edges ?? []) {
      const source = fact.source === undefined ? undefined : routes.get(fact.source);
      const destination = fact.destination === undefined ? undefined : routes.get(fact.destination);
      const to = fact.to ?? (destination && this.routerId(destination));
      if (to === undefined) continue;
      const edge = { to, label: fact.kind, file: fact.file, line: fact.line, detail: fact.detail,
        sourceRoute: fact.source, destination, method: fact.method, url: destination?.url,
        conditional: fact.conditional, partial: fact.possible };
      if (source) add({ ...edge, from: this.routerId(source), sourceRoute: undefined });
      if (fact.from !== undefined) add({ ...edge, from: fact.from });
    }
    for (const fetch of index.fetches) {
      const route = routes.get(fetch.route);
      if (!route || route.kind !== 'api') continue;
      append(this.fetches, route.file, fetch);
      if (!fetchTypes.has(fetch.via) || fetch.method === '?' ||
          (route.methods?.length && !route.methods.includes(fetch.method) && !route.methods.includes('ALL') &&
            !(!route.pages && fetch.method === 'HEAD' && route.methods.includes('GET')))) continue;
      const method = route.methods?.includes('ALL') ? 'ALL' : route.methods?.length ? fetch.method === 'HEAD' && !route.methods.includes('HEAD') ? 'GET' : fetch.method : '?';
      const to = this.apiId(route, method);
      const from = fetch.graphOwner ?? fetch.owner ?? this.fileNode(fetch.file);
      const uncertainty = (fetch.propUrlUnknown ? propUrlIssue : undefined) ??
        (fetch.lifecyclePossible ? this.coverageIssue(from) ?? 'possible lifecycle callback' : undefined) ??
        this.index.pagesApiIssues?.[route.id]?.[0];
      add({ from, to, label: 'fetch', file: fetch.file,
        line: fetch.line, detail: fetch.binding ? `${fetch.via} via prop ${fetch.binding.name} at ${location(fetch.binding.file, fetch.binding.line)}` : fetch.via,
        gates: fetch.gates, url: route.url, method: fetch.method, partial: fetch.partial || fetch.dynamic || !!uncertainty, uncertainty,
        possibleReconnect: fetch.possibleReconnect,
        transportIssue: fetch.via === AI_SDK_TRANSPORT && (fetch.partial || fetch.dynamic) ?
          transportIssue(fetch.transportOverride) : undefined });
    }
    for (const [fileKey, uses] of Object.entries(index.trpcUses ?? {})) {
      const fileId = Number(fileKey);
      const file = this.file(fileId);
      for (const use of uses) {
        const [to, line, operation, owner] = use;
        append(this.procedureSites, to, { file, use });
        if (!operation.startsWith('cache:')) add({ from: owner ?? fileId, to, label: 'trpc', file, line, detail: operation });
      }
    }
    for (const call of index.externalCalls!) {
      append(this.external, call[0], call);
      for (const alias of index.trpcAliases?.[call[0]] ?? []) append(this.external, alias, call);
    }
    for (const entries of this.incoming.values()) entries.sort(edgeOrder);
    for (const entries of this.outgoing.values()) entries.sort(edgeOrder);
  }

  private fileNode(file: string): NodeId {
    return this.fileIds.get(file) ?? 'file:' + file;
  }

  defaultSymbol(file: string) {
    const id = this.fileIds.get(file);
    return id === undefined ? undefined : this.symbols.get(this.index.defaultSymbols![id]);
  }

  private routeContext(route: Route | undefined) {
    if (!route?.router) return;
    const context = new Set<number>();
    let current: number | undefined = route.id;
    while (current !== undefined && !context.has(current)) {
      context.add(current);
      current = this.routerParents?.get(current);
    }
    return context;
  }

  private routerId(route: Route): NodeId {
    return `route:${route.id}`;
  }

  private apiId(route: Route, method: string) {
    return `api:${route.id}:${method}`;
  }

  file(id: NodeId): string {
    if (typeof id === 'string') return this.api.get(id)?.file ?? this.routerTerminals?.get(id)?.file ?? id.slice(5);
    return this.symbols.get(id)?.file ?? this.files.get(id) ?? '';
  }

  name(id: NodeId): string {
    if (typeof id === 'string') return this.api.get(id)?.name ?? this.routerTerminals?.get(id)?.name ?? 'module';
    return this.symbols.get(id)?.name ?? 'module';
  }

  action(id: NodeId) {
    return this.actions.get(id);
  }

  actionMatches(name: string, file?: string) {
    const candidates = this.actionTargets.filter(({ action }) => file === undefined || file === action.file);
    const exact = candidates.filter(({ action }) => action.name === name || action.aliases?.includes(name));
    const matches = exact.length ? exact : candidates.filter(({ action }) => action.name.split('.').pop() === name);
    return [...new Set(matches.map(({ id }) => id))].map(id => this.symbols.get(id)!);
  }

  moduleSeeds(file: string): NodeId[] {
    return this.fileIds.has(file) || this.routesByFile.has(file) ? [this.fileNode(file)] : [];
  }

  fileSeeds(file: string): NodeId[] {
    return [...this.moduleSeeds(file), ...(this.symbolsByFile.get(file) ?? []).filter(symbol => !symbol.typeOnly).map(symbol => symbol.id)];
  }

  middleware(file: string) {
    return this.routesByFile.get(file)?.find(terminal => terminal.kind === 'middleware');
  }

  exports(file: string) {
    return this.index.exportSymbols![this.fileIds.get(file) ?? 0] ?? {};
  }

  runtimeExports(file: string) {
    return this.index.runtimeExports![this.fileIds.get(file) ?? 0];
  }

  runtimeExport(file: string, name: string): RuntimeExportState | 'absent' {
    const exports = this.runtimeExports(file);
    if (Object.prototype.hasOwnProperty.call(exports?.names ?? {}, name)) return exports!.names[name];
    return !this.fileIds.has(file) || exports?.unknownStar && name !== 'default' ? 'unknown' : 'absent';
  }

  matchingNode(previous: DependencyGraph, id: NodeId, file = previous.file(id)): NodeId[] {
    const symbol = typeof id === 'number' ? previous.symbols.get(id) : undefined;
    if (!symbol) return this.moduleSeeds(file);
    return (this.symbolsByFile.get(file) ?? []).filter(candidate =>
      candidate.name === symbol.name && candidate.kind === symbol.kind).map(candidate => candidate.id);
  }

  importsFrom(importer: string, target: string) {
    const sourceId = this.fileIds.get(importer);
    const targetId = this.fileIds.get(target);
    return sourceId === undefined || targetId === undefined ? [] :
      (this.index.moduleImports![sourceId] ?? []).filter(entry => entry[0] === targetId);
  }

  removalSites(origin: ChangeOrigin, wholeFile: boolean) {
    if (!this.moduleImporters.size) {
      for (const [from, entries] of Object.entries(this.index.moduleImports!)) {
        const file = this.file(Number(from));
        for (const entry of entries) append(this.moduleImporters, entry[0], [file, entry]);
      }
    }
    const ids = new Set(origin.ids);
    let uses = origin.ids.flatMap(id => this.predecessors(id)).filter(edge =>
      !ids.has(edge.from) && (!origin.externalOnly || edge.file !== origin.file));
    type Site = { file: string; line: number };
    const sites = new Map<string, Site>();
    const add = (file: string, line: number) => {
      if (file !== origin.file) sites.set(JSON.stringify([file, line]), { file, line });
    };
    const fileId = this.fileIds.get(origin.file) ?? 0;
    const direct = new Set<string>();
    const uncertain = new Set<string>();
    let importFiles: Set<string> | undefined;
    if (wholeFile) {
      for (const [file, [, line]] of this.moduleImporters.get(fileId) ?? []) {
        add(file, line);
      }
    } else {
      importFiles = new Set();
      const pending: [number, string][] = [[fileId, origin.name]];
      const seen = new Set<string>();
      const memberUses: Edge[] = [];
      for (const [module, name] of pending) {
        const key = JSON.stringify([module, name]);
        if (seen.has(key)) continue;
        seen.add(key);
        for (const [file, [target, line, kind, bindings, namespaceUses]] of this.moduleImporters.get(module) ?? []) {
          for (const [imported, exported] of bindings ?? []) {
            if (imported === '*' && kind === 'import') {
              for (const [useLine, member, owner] of namespaceUses ?? []) {
                if (member != null && member !== name) continue;
                add(file, line);
                add(file, useLine);
                if (member == null) uncertain.add(file);
                else {
                  importFiles.add(file);
                  direct.add(file);
                  memberUses.push({ from: owner ?? this.fileNode(file), to: target, label: 'use', file, line: useLine });
                }
              }
              continue;
            }
            if (imported !== name && (imported !== '*' || exported === '*' && name === 'default')) continue;
            add(file, line);
            if (kind === 'import') {
              importFiles.add(file);
              direct.add(file);
            } else if (imported === '*' && exported !== '*') {
              // The namespace can escape through another export. A member
              // reference to it is not represented by this binding edge.
              uncertain.add(file);
            } else if (exported) pending.push([this.fileIds.get(file) ?? 0, exported === '*' ? name : exported]);
          }
        }
      }
      uses = [...uses.filter(edge => edge.file === origin.file || importFiles!.has(edge.file)), ...memberUses];
    }
    for (const { file, line } of uses) add(file, line);
    const files = new Map<string, Site[]>();
    for (const site of sites.values()) append(files, site.file, site);
    return { uses, files, importFiles, direct, uncertain,
      terminal: origin.ids.some(id => this.terminals(id).some(terminal => terminal.kind !== 'action')) };
  }

  private recordModuleStops(id: NodeId, reached: (id: NodeId) => boolean, stops: Set<string>, ignoreTypes = false) {
    if (this.files.get(Number(id)) === undefined && !(typeof id === 'string' && id.startsWith('file:'))) return;
    for (const edge of this.outgoing.get(id) ?? []) {
      if ((!ignoreTypes || !edge.typeOnly) &&
          (edge.label === 'use' || edge.label === 'call' || edge.label === 'action' || edge.label === 'trpc') &&
          reached(edge.to)) stops.add(location(edge.file, edge.line));
    }
  }

  private terminals(id: NodeId): Terminal[] {
    const api = typeof id === 'string' ? this.api.get(id) ?? this.routerTerminals?.get(id) : undefined;
    if (api) return [api];
    const action = this.action(id);
    const file = this.file(id);
    const terminals = new Map<string, Terminal>();
    const handlers = this.handlerRoutes.get(id);
    for (const terminal of [...this.routesByFile.get(file) ?? [], ...this.pageRoots.get(id) ?? [], ...handlers ?? []]) {
      if (terminal.route?.router && id !== terminal.route.fileSymbol) continue;
      if (terminal.kind === 'page' && terminal.route?.pages && id !== terminal.route.fileSymbol &&
        id !== terminal.route.component && this.index.pagesEdges?.some(edge => edge.kind === 'data' && edge.to === id)) continue;
      if (terminal.kind === 'api' && handlers && !handlers.includes(terminal)) continue;
      terminals.set(terminalKey(terminal), terminal);
    }
    if (action) {
      const terminal = { kind: 'action', file: action.file, name: action.name, line: action.line };
      terminals.set(terminalKey(terminal), terminal);
    }
    return [...terminals.values()];
  }

  private predecessors(id: NodeId): Edge[] {
    const direct = this.incoming.get(id) ?? [];
    const routes = this.handlerRoutes.get(id) ?? (this.name(id) === 'module' ? this.routesByFile.get(this.file(id)) : undefined);
    if (!routes) return direct;
    const attached = routes.flatMap(terminal => {
      if (terminal.kind !== 'api' || !terminal.route) return [];
      const { methods } = terminal.route;
      const method = methods?.find(method => terminal.name.startsWith(method + ' '));
      return (this.incoming.get(this.apiId(terminal.route, method ?? '?')) ?? []).map(edge => ({ ...edge, to: id }));
    });
    return attached.length ? [...direct, ...attached].sort(edgeOrder) : direct;
  }

  private unresolvedTrpc(id: NodeId, includeTests: boolean) {
    if (typeof id !== 'number') return;
    const issue = this.index.trpcIssues?.[id]?.find(([file]) => includeTests || !isTestFile(this.file(file)));
    if (issue) return `tRPC procedure target unresolved (${location(this.file(issue[0]), issue[1])})`;
  }

  private trpcIssue(id: NodeId, includeTests: boolean) {
    const unresolved = this.unresolvedTrpc(id, includeTests);
    if (unresolved) return unresolved;
    if (typeof id === 'number' && this.unboundProcedures.has(id)) {
      return `tRPC client proxy not traced (${location(this.file(id), this.symbols.get(id)?.line)})`;
    }
  }

  procedureConsumers(symbol: SymbolEntry, includeTests: boolean): QueryResult {
    const sites = (this.procedureSites.get(symbol.id) ?? []).filter(site => includeTests || !isTestFile(site.file))
      .sort((a, b) => Number(a.use[2].startsWith('cache:')) - Number(b.use[2].startsWith('cache:')) ||
        compare(a.file, b.file) || a.use[1] - b.use[1] || compare(a.use[2], b.use[2]));
    let callers = 0;
    const rows = sites.map(({ file, use: [, line, operation, owner] }) => {
      const cache = operation.startsWith('cache:');
      if (!cache) callers++;
      const label = cache ? 'cache-only' : 'call';
      return graphRow(`${label} ${location(file, line)} ${owner === undefined ? 'module' : this.name(owner)} (${operation.replace(/^cache:/, '')})` +
        (isTestFile(file) ? ' [test]' : ''), file);
    });
    const caches = sites.length - callers;
    return {
      title: `${location(symbol.file, symbol.line)}#${symbol.name}`, rows, targets: [symbol.file],
      count: `${callers} caller ${callers === 1 ? 'site' : 'sites'}` + (caches ? `, ${caches} cache-only` : ''),
      partial: this.trpcIssue(symbol.id, includeTests), scope: 'indexed tRPC callers and cache sites'
    };
  }

  procedureRoutes(symbol: SymbolEntry, direct: boolean, expired: () => boolean): QueryResult {
    const trace = this.traceImpact([symbol.id], 6, false, expired);
    const routes = new Map<string, Reached>();
    for (const entry of trace.terminals) {
      const { terminal } = entry;
      if (terminal.kind === 'page') routes.set(terminal.file, entry);
      for (const page of terminal.pages ?? []) {
        if (!routes.has(page.file)) routes.set(page.file, {
          ...entry, terminal: { kind: 'page', name: page.url, file: page.file, line: page.line, route: page }
        });
      }
    }
    const rows = this.terminalRows([...routes.values()].filter(({ visit }) => visit.edge), 100);
    const count = rows.length;
    if (direct) rows.push(...this.procedureConsumers(symbol, false).rows.filter(row => row.text.startsWith('call ')));
    return {
      rows, count: `${count} ${count === 1 ? 'route' : 'routes'}`, partial: trace.partial,
      scope: 'indexed tRPC call and render paths'
    };
  }

  private trpcBoundary(id: NodeId, terminals: Terminal[], reached: (id: NodeId) => boolean) {
    if (typeof id !== 'number') return;
    const file = this.file(id);
    if (!this.trpc.has(file) || terminals.some(terminal => terminal.kind !== 'action')) return;
    const symbol = this.symbols.get(id);
    if (symbol?.typeOnly || symbol?.kind === 'procedure') return;
    const sites = this.trpcModuleUses.get(id);
    const site = sites && this.outgoing.get(id)?.find(edge => sites.has(`${edge.to}:${edge.line}`) && reached(edge.to));
    if (symbol || site) return `tRPC client proxy not traced (${location(file, symbol?.line ?? site?.line)})`;
  }

  traceImpact(seeds: NodeId[], depth: number, includeTests: boolean, expired: () => boolean, initialGates: FlowGate[] = []) {
    const trace = this.walkImpact(seeds, depth, includeTests, expired, undefined, initialGates);
    if (!trace.renderSites.size) return trace;
    trace.terminals = trace.terminals.flatMap(entry => {
      const route = entry.terminal.route;
      const conditions = route && this.index.pagesRenderConditions?.[route.id];
      if (!conditions || expired() || !Object.keys(conditions).some(site => trace.renderSites.has(site))) return [entry];
      const scoped = this.walkImpact(seeds, depth, includeTests, expired, route, initialGates);
      const match = scoped.terminals.find(result => terminalKey(result.terminal) === terminalKey(entry.terminal));
      if (match?.visit.possible) trace.partial ??= scoped.partial;
      return match ? [match] : [];
    }).sort(terminalOrder);
    return trace;
  }

  private walkImpact(seeds: NodeId[], depth: number, includeTests: boolean, expired: () => boolean, route?: Route, initialGates: FlowGate[] = []) {
    const conditions = route && this.index.pagesRenderConditions?.[route.id];
    const renderSites = new Set<string>();
    const visited = new Map<NodeId, Visit[]>();
    type State = { id: NodeId; gates: FlowGate[]; visit: Visit };
    const levels: State[][] = [];
    const states = new Map<string, number[]>();
    const reachedEdges = new Set<Edge>();
    const tests = new Set<string>();
    const boundary = new Set<string>();
    const hubs: QueryRow[] = [];
    const hidden = new Set<NodeId>();
    const terminals = new Map<string, Reached>();
    let nodeLimited = false;
    let trpc: string | undefined;
    let pagesIssue: string | undefined;
    let sdkIssue: string | undefined;
    const uncertain = new Set<string>();
    const literals = new Set<string>();
    const stops = new Set<string>();
    let flowIssue: string | undefined;
    const visit = (id: NodeId, value: Visit, gates: FlowGate[]) => {
      const key = stateKey(id, gates);
      const prior = states.get(key);
      const flags = certaintyFlags(value);
      if (coversVisit(prior, flags, value.depth)) return false;
      if (!prior && states.size >= nodeBudget) {
        nodeLimited = true;
        return false;
      }
      const depths = prior ?? [];
      depths[flags] = value.depth;
      states.set(key, depths);
      (levels[value.depth] ??= []).push({ id, gates, visit: value });
      return true;
    };
    for (const seed of seeds) visit(seed, { depth: 0 }, initialGates);
    for (let level = 0; level < levels.length && !expired(); level++) {
      for (const { id, gates, visit: current } of levels[level]) {
        if (expired()) break;
        if (coversVisit(states.get(stateKey(id, gates)), certaintyFlags(current), level, true)) continue;
        const visits = visited.get(id);
        if (!visits || terminalCertainty(current) < terminalCertainty(visits[visits.length - 1])) {
          append(visited, id, current);
        }
        // Outgoing JSX lookups do not describe this incoming path. Router edges carry their own uncertainty.
        if (!this.index.router && current.edge?.label !== 'middleware') pagesIssue ??= this.coverageIssue(id, false, false);
        if (gates.some(gate => gate.partial)) flowIssue ??= propValueIssue;
        const endpoints = this.terminals(id).filter(terminal =>
          !gates.length || terminal.kind === 'action' || terminal.route?.component === id && gates.every(gate => gate.scope === id && gate.unscoped));
        for (const terminal of endpoints) {
          if (gates.length && terminal.route?.component === id) flowIssue ??= propValueIssue;
          const key = terminalKey(terminal);
          const earlier = terminals.get(key);
          const metadata = terminal.kind === 'page' && this.name(id) === 'generateMetadata';
          if (!earlier || (terminal.route || terminal.pages) && terminalCertainty(current) < terminalCertainty(earlier.visit)) {
            terminals.set(key, { terminal, visit: current, node: id, metadata: metadata || !!earlier?.metadata });
          } else if (metadata && earlier.visit.depth === level) {
            earlier.metadata = true;
          }
          if (terminal.kind === 'api') {
            sdkIssue = strongerTransportIssue(sdkIssue, includeTests ? this.unboundedTransport : this.unboundedProductionTransport);
            for (const fetch of this.fetches.get(terminal.file) ?? []) {
              if (!includeTests && isTestFile(fetch.file)) continue;
              if (fetch.dynamic || fetch.partial) uncertain.add(fetch.file);
              if (fetch.via === AI_SDK_TRANSPORT && fetch.partial) {
                sdkIssue = strongerTransportIssue(sdkIssue, transportIssue(fetch.transportOverride));
              }
              if (fetch.via === 'route literal') literals.add(fetch.file);
            }
          }
        }
        const edges = this.predecessors(id);
        const additions = new Map<string, { gates: FlowGate[]; visits: (Visit & { edge: Edge })[]; depths: number[] }>();
        let hasCaller = false;
        for (let edge of edges) {
          if (edge.from === id) continue;
          const site = this.pageRenderSites && renderKey(edge);
          if (site && this.pageRenderSites?.has(site)) renderSites.add(site);
          const applicable = this.pageRenderEdge(edge, conditions, route);
          if (!applicable) continue;
          edge = applicable;
          if (!includeTests && isTestFile(edge.file)) {
            if (!visited.has(edge.from)) tests.add(edge.file);
            continue;
          }
          const awaiting = predecessorGates(edge, gates);
          if (!awaiting) continue;
          const key = stateKey(edge.from, awaiting);
          hasCaller = true;
          const cost = impactCost(edge, gates);
          if (level >= depth && cost && edge.label !== 'render' && edge.label !== 'event') {
            boundary.add(key);
            continue;
          }
          flowIssue ??= gateIssue(edge) ?? (uncertainEntry(edge, gates) ? propValueIssue : undefined);
          if (edge.partial && edge.label !== 'fetch') pagesIssue ??= edge.uncertainty ?? (this.index.router ? 'possible router dependency' : 'possible Pages dependency');
          if (edge.label === 'fetch' && edge.uncertainty) flowIssue ??= edge.uncertainty;
          reachedEdges.add(edge);
          const next = { depth: level + cost, edge, conditional: current.conditional || edge.conditional,
            possible: current.possible || (edge.label === 'render' || edge.label === 'event') && edge.partial };
          const flags = certaintyFlags(next);
          if (coversVisit(states.get(key), flags, next.depth)) continue;
          const pending = additions.get(key) ?? { gates: awaiting, visits: [], depths: [] };
          if (coversVisit(pending.depths, flags, next.depth)) continue;
          pending.visits[flags] = next;
          pending.depths[flags] = next.depth;
          additions.set(key, pending);
        }
        trpc ??= this.trpcIssue(id, includeTests);
        if (!hasCaller) {
          const boundary = this.trpcBoundary(id, endpoints, to => visited.has(to));
          trpc ??= boundary;
          if (!boundary && !endpoints.length && current.edge) this.recordModuleStops(id, to => visited.has(to), stops);
        }
        if (additions.size > hubSize && level < depth) {
          const edges = [...additions.values()].flatMap(({ visits }) => visits.map(({ edge }) => edge));
          const files = [...new Set(edges.map(edge => edge.file))].sort(compare);
          const label = edges[0].label;
          hubs.push(graphRow(`d${level + 1} ${label}  ${additions.size} callers in ${quantity(files.length, 'file')} (top: ${files.slice(0, 3).join(', ')})`, ...files.slice(0, 3)));
        }
        const via = additions.size ? [this.name(id), ...current.via ?? []].slice(0, 2) : undefined;
        for (const { gates: awaiting, visits } of additions.values()) {
          if (expired()) break;
          for (const next of visits) {
            if (!next) continue;
            if (visit(next.edge.from, { ...next, via }, awaiting) && additions.size > hubSize && level < depth) {
              hidden.add(next.edge.from);
            }
          }
        }
      }
    }
    const unexplored = [...boundary].filter(key => !states.has(key)).length;
    const limit = nodeLimited ? 'node budget' : depthLimit(unexplored, depth);
    const partial = [limit, trpc, pagesIssue, flowIssue, stops.size ? 'module-level importers not traced' : undefined,
      sdkIssue].filter(Boolean).join('; ') ||
      (uncertain.size ? 'dynamic URL fetch' : undefined);
    return { visited, terminals: [...terminals.values()].sort(terminalOrder), tests, hidden, hubs, partial, trpc, literals, stops, reachedEdges, renderSites };
  }

  consumerEvidence(owner: number, includeTests: boolean, expired: () => boolean, gates: FlowGate[] = [], supplier?: number) {
    const trace = this.traceImpact([owner], 6, includeTests, expired, gates);
    const rows: QueryRow[] = [];
    for (const edge of trace.reachedEdges) {
      if (isEvent(edge.detail)) {
        rows.push(graphRow(`event  ${location(edge.file, edge.line)} ${edge.detail} -> ${this.name(edge.to)}`, edge.file));
      }
    }
    if (supplier !== undefined) for (const edge of trace.reachedEdges) {
      if (edge.to !== supplier || !edge.site || edge.label !== 'render') continue;
      const label = this.index.renderLabels?.[edge.site];
      rows.push(graphRow(`render ${location(edge.file, edge.line)} ${this.name(supplier)}${label ? ' in ' + label : ''}`, edge.file));
    }
    if (rows.length || supplier !== undefined) {
      rows.push(...this.terminalRows(trace.terminals.filter(({ terminal }) => terminal.kind === 'page' || terminal.pages), 40));
    }
    return { rows, partial: trace.partial };
  }

  terminalRows(reached: Reached[], limit: number): QueryRow[] {
    const rows: QueryRow[] = [];
    const directPages = reached.filter(entry => entry.terminal.kind === 'page');
    const groupPages = directPages.length > 15 && limit <= 40;
    const groups = new Map<string, Route[]>();
    const listed = new Set(directPages.map(entry => entry.terminal.route?.id));
    for (const { terminal, visit, metadata, node } of reached) {
      const { kind, name, file, line, pages } = terminal;
      const suffix = `  d${visit.depth}` + (visit.depth > 1 && visit.via?.length ? ` via ${visit.via.slice(0, visit.depth - 1).join(' > ')}` : '') +
        (metadata ? ' (+generateMetadata)' : '') + (visit.conditional ? ' [cond]' : '') +
        (visit.edge?.label === 'dyn' ? ' [dyn]' : '') +
        (visit.possible || visit.edge?.partial ? visit.edge?.label === 'fetch' && !visit.edge.uncertainty ? ' [partial url]' : ' [possible]' : '') +
        (isTestFile(file) ? ' [test]' : '');
      if (groupPages && kind === 'page' && terminal.route) {
        const layouts = terminal.route.layouts ?? [];
        const layout = layouts.length ? this.file(layouts[layouts.length - 1]) : file.slice(0, file.lastIndexOf('/')) || '.';
        append(groups, layout, terminal.route);
      } else if (pages) {
        rows.push(graphRow(`${kind} ${file}  wraps ${quantity(pages.length, kind === 'app-shell' ? 'pages route' : 'route')}${this.pageList(pages)}${suffix}`, file));
        if (limit > 40 && pages.length > 5) for (const page of pages) {
          if (listed.has(page.id)) continue;
          listed.add(page.id);
          rows.push(graphRow(`page ${page.url}  ${location(page.file, page.line)}  d${visit.depth} via ${file}`, page.file, file));
        }
      } else if (kind === 'middleware') {
        const clean = typeof node === 'number' ? this.pagesMiddleware.get(node) : undefined;
        const matches = clean ? `${clean.exact.size} exact, ${[...clean.possible].filter(id => !clean.exact.has(id)).length} possible Pages routes` :
          this.index.pagesEdges ? 'Pages matcher membership unresolved' : 'all matched routes';
        rows.push(graphRow(`middleware ${file}  ${matches}${name === '/' ? '' : ` (matcher: ${name})`}${suffix}`, file));
      } else {
        const label = kind === 'sitemap' || kind === 'robots' || kind === 'opengraph-image' ? `meta ${kind}` :
          kind === 'page' || kind === 'api' || kind === 'action' ? kind : `special ${kind}`;
        rows.push(graphRow(`${label} ${name}  ${location(file, kind === 'api' ? undefined : line)}${suffix}`, file));
      }
    }
    for (const [layout, routes] of groups) {
      rows.push(graphRow(`group ${layout} : ${quantity(routes.length, 'route')}${this.pageList(routes)}`, layout));
    }
    return rows;
  }

  private pageList(pages: Route[]) {
    const count = pages.length <= 5 ? pages.length : 3;
    if (!count) return '';
    const urls = [...pages].sort((a, b) => compare(a.url, b.url)).slice(0, count).map(page => page.url);
    return ` (${urls.join(', ')}${pages.length > count ? ', +' + (pages.length - count) : ''})`;
  }

  impact(seeds: NodeId[], depth: number, includeTests: boolean, limit: number, expired: () => boolean): QueryResult {
    const trace = this.traceImpact(seeds, depth, includeTests, expired);
    const targets = new Set(seeds);
    const actions = trace.terminals.filter(entry => entry.terminal.kind === 'action' && !targets.has(entry.node));
    const rows = this.terminalRows(trace.terminals.filter(entry => entry.terminal.kind !== 'action'), limit);
    if (actions.length > 5) {
      const files = new Set(actions.map(({ terminal }) => terminal.file));
      const top = actions.slice(0, 3).map(({ terminal }) => terminal);
      rows.push(graphRow(`actions: ${actions.length} in ${files.size} ${files.size === 1 ? 'file' : 'files'} (top: ${
        top.map(({ name, file, line }) => `${name} ${location(file, line)}`).join(', ')})`, ...top.map(({ file }) => file)));
    } else rows.push(...this.terminalRows(actions, limit));
    const notes: QueryRow[] = [];
    const targetAction = seeds.length === 1 ? this.action(seeds[0]) : undefined;
    if (targetAction) notes.push(graphRow(`# target: server action ${targetAction.name}`, targetAction.file));
    const pageIds = new Set<number>();
    const apiFiles = new Set<string>();
    let layouts = 0;
    let other = 0;
    for (const { terminal } of trace.terminals) {
      if (terminal.kind === 'api') apiFiles.add(terminal.route?.router?.id ?? terminal.file);
      else if (terminal.kind === 'action') continue;
      else if (terminal.pages) {
        layouts++;
        for (const page of terminal.pages) pageIds.add(page.id);
      } else if (terminal.route) pageIds.add(terminal.route.id);
      else if (terminal.kind === 'middleware') {
        for (const route of terminal.matchedRoutes ?? []) {
          if (route.pages && this.index.pagesEdges) continue;
          if (route.kind === 'page') pageIds.add(route.id);
          else apiFiles.add(route.file);
        }
      } else other++;
    }
    const routeCount = pageIds.size + apiFiles.size;
    const unknownMiddleware = trace.terminals.some(({ terminal }) => terminal.kind === 'middleware' && !terminal.matchedRoutes);
    const groups = new Map<string, { id: NodeId; visit: Visit; edge: Edge }[]>();
    const files = new Set<string>();
    const localCallers = [...trace.visited.values()].map(([visit]) => visit).filter(visit => visit.edge?.local && visit.depth <= depth);
    const summarizeLocals = trace.visited.size > hubSize && localCallers.length >= 3;
    let symbols = 0;
    let used = trace.terminals.reduce((max, { visit }) => Math.max(max, visit.depth), 0);
    for (const [id, visits] of trace.visited) {
      const [first] = visits;
      if (first.edge && first.depth <= depth) {
        if (typeof id === 'number' && this.symbols.has(id)) symbols++;
        files.add(this.file(id));
      }
      for (const visit of visits) {
        const edge = visit.edge;
        if (!edge) continue;
        used = Math.max(used, visit.depth);
        if (visit.depth > depth && visits.length === 1 || trace.hidden.has(id) || summarizeLocals && edge.local) continue;
        append(groups, JSON.stringify([visit.depth, edge.label, edge.file, certaintyFlags(visit)]), { id, visit, edge });
      }
    }
    rows.push(...trace.hubs);
    const symbolRows = [...groups.values()].sort(([a], [b]) => a.visit.depth - b.visit.depth ||
      compare(a.edge.file, b.edge.file) || a.edge.line - b.edge.line || compare(this.name(a.id), this.name(b.id)));
    for (const items of symbolRows) {
      const [{ visit, edge }] = items;
      const lines = [...new Set(items.map(item => item.edge.line))].sort((a, b) => a - b);
      const names = [...new Set(items.map(item => this.name(item.id)))].sort(compare);
      const via = [...new Set(items.map(item => this.name(item.edge.to)))].sort(compare);
      const label = names.length === 1 && names[0] === 'module' && edge.label !== 'dyn' ? 'module' : edge.label;
      const flags = (items.some(item => item.visit.conditional) ? ' [cond]' : '') +
        (items.some(item => this.action(item.id)) ? ' [action]' : '') +
        (items.some(item => item.visit.possible) ? ' [possible]' : items.some(item => item.edge.partial) ? ' [partial url]' : '') +
        (isTestFile(edge.file) ? ' [test]' : '');
      const chain = seeds.length === 1 && items.every(item => item.edge.to === seeds[0]) ? '' : ` < ${via.join(', ')}`;
      rows.push(graphRow(`d${visit.depth} ${label} ${edge.file}:${lines.slice(0, 5).join(',')}` +
        `${lines.length > 5 ? '+' + (lines.length - 5) : ''} ${names.join(', ')}${chain}${flags}`, edge.file));
    }
    if (actions.length > 1 && actions.length <= 5 && [...trace.reachedEdges].some(edge => edge.gates?.length)) {
      for (const { terminal, node } of actions) {
        const actionTrace = this.traceImpact([node], depth, includeTests, expired);
        const pages = [...new Set(actionTrace.terminals.flatMap(({ terminal }) =>
          terminal.kind === 'page' ? [terminal.name] : terminal.pages?.map(page => page.url) ?? []))].sort(compare);
        if (pages.length) notes.push(graphRow(`# ${terminal.name} pages: ${pages.join(', ')}`, terminal.file));
      }
    }
    if (trace.tests.size) notes.push(graphRow(`# tests: ${trace.tests.size} ${trace.tests.size === 1 ? 'file reaches' : 'files reach'} target (includeTests to list)`));
    if (summarizeLocals) {
      const localFiles = new Set(localCallers.map(visit => visit.edge!.file));
      notes.push(graphRow(`# local callers: ${localCallers.length} in ${quantity(localFiles.size, 'file')}`, ...localFiles));
    }
    if (trace.literals.size) notes.push(graphRow(`# also referenced as literal: ${quantity(trace.literals.size, 'file')}`));
    if (trace.stops.size) notes.push(graphRow('# ' + moduleStops(trace.stops.size)));
    const middlewareReasons = new Set<string>();
    for (const { terminal, node } of trace.terminals) {
      if (terminal.kind !== 'middleware' || typeof node !== 'number') continue;
      const coverage = this.pagesMiddleware.get(node);
      if (!coverage) continue;
      const edges = this.predecessors(node).filter(edge => edge.label === 'middleware' && edge.partial && !coverage.exact.has(Number(edge.from)));
      if (!edges.length) continue;
      const overlaps = new Map<string, Set<NodeId>>();
      for (const { matcher, from } of edges) {
        if (!matcher?.overlap) continue;
        const routes = overlaps.get(matcher.source) ?? new Set<NodeId>();
        routes.add(from);
        overlaps.set(matcher.source, routes);
      }
      const mostFrequent = [...overlaps].sort(([, a], [, b]) => b.size - a.size)[0]?.[0];
      const reasons = [
        mostFrequent ? `middleware matcher ${JSON.stringify(mostFrequent)} may overlap dynamic route templates` : undefined,
        edges.some(edge => edge.matcher?.conditional) ? 'some matchers or handlers depend on runtime conditions' : undefined,
        edges.some(edge => !edge.matcher) ? 'some matcher coverage is unresolved' : undefined,
        edges.some(edge => {
          const route = this.pagesByFileId.get(edge.from);
          return route && this.index.pagesIssues?.[route.id]?.includes('dynamic next.config');
        }) ?
          'dynamic next.config can change URL matching' : undefined
      ];
      for (const reason of reasons) if (reason) middlewareReasons.add(reason);
    }
    if (unknownMiddleware) notes.push(graphRow('# middleware: matcher coverage not enumerated'));
    notes.push(graphRow(`# risk: ${quantity(routeCount, 'route')} (${quantity(pageIds.size, 'page')}, ${quantity(apiFiles.size, 'API')}` +
      `${other ? `, ${quantity(other, 'meta or special file')}` : ''}), ${quantity(actions.length, 'server action')}, ` +
      `${quantity(layouts, 'layout')}; ${quantity(symbols, 'symbol')} in ${quantity(files.size, 'file')}; max depth ${used}; ${quantity(trace.tests.size, 'test')}`));
    const scopedLookup = !routeCount && seeds.flatMap(id => {
      const issue = typeof id === 'number' && this.index.scopedRenderValueIssues?.[id];
      return issue && (includeTests || !isTestFile(issue.valueFile) && !isTestFile(issue.file)) ? [issue.reason] : [];
    })[0];
    const unresolvedLookup = scopedLookup || !routeCount && seeds.some(id => {
      const file = typeof id === 'number' && this.index.renderValueUses?.[id];
      return file && (includeTests || !isTestFile(file));
    }) &&
      Object.entries(this.index.renderLookupIssues ?? {}).find(([id]) => includeTests || !isTestFile(this.file(Number(id))))?.[1];
    return { rows, notes, count: `${quantity(routeCount, 'route')}, ${quantity(actions.length, 'action')}, ${quantity(symbols, 'symbol')}, depth ${used}` +
      (used > depth ? ` (limit ${depth} + renders/events)` : '') +
      (trace.hubs.length ? ', hub collapsed' : ''),
      partial: [...middlewareReasons, trace.partial ?? unresolvedLookup, unknownMiddleware ? 'middleware matcher coverage not enumerated' : undefined]
        .filter(Boolean).join('; ') || undefined,
      scope: 'indexed call, event, render, action, use, dyn, fetch edges' +
        ([...trace.visited.values()].some(visits => visits.some(visit => visit.edge?.label === 'trpc')) ? ', including tRPC' : '') };
  }

  changeRoutes(origins: ChangeOrigin[], maxDepth: number, expired: () => boolean, ignoreTypeStops = false) {
    type Impact = { origin: ChangeOrigin; depth: number; fetch?: string; possible?: boolean };
    type State = { id: NodeId; origin: number; depth: number; fetch?: string; possible?: boolean; gates: FlowGate[]; initial?: boolean };
    const routes = new Map<string, { terminal: Terminal; origins: Impact[] }>();
    const wrappers = new Map<string, { name: string; file: string; pages: Route[] }>();
    const reached = new Map<string, Map<number, number>>();
    const levels: State[][] = [];
    const skipped: Set<string>[] = [];
    const cached = new Map<NodeId, Edge[]>();
    let nodeLimited = false;
    let uncertain = false;
    let sdkIssue: string | undefined;
    let trpc: string | undefined;
    let flowIssue: string | undefined;
    const stops = new Set<string>();
    const traced = new Set<ChangeOrigin>();
    let queued = 0;
    const visit = (state: State) => {
      const key = stateKey(state.id, state.gates);
      const seen = reached.get(key);
      if ((seen?.get(state.origin) ?? Infinity) <= state.depth) return;
      if ((!seen && reached.size >= nodeBudget) || queued >= nodeBudget * 4) {
        nodeLimited = true;
        return;
      }
      if (seen) seen.set(state.origin, state.depth);
      else reached.set(key, new Map([[state.origin, state.depth]]));
      (levels[state.depth] ??= []).push(state);
      queued++;
    };
    const remember = (terminal: Terminal, impact: Impact) => {
      if (terminal.kind === 'action') return;
      if (terminal.kind === 'page' || terminal.kind === 'api' || terminal.matchedRoutes?.length) traced.add(impact.origin);
      const key = terminalKey(terminal);
      const result = routes.get(key);
      if (result) {
        const previous = result.origins.findIndex(item => item.origin === impact.origin);
        if (previous < 0) result.origins.push(impact);
        else if (result.origins[previous].depth > impact.depth) result.origins[previous] = impact;
      } else routes.set(key, { terminal, origins: [impact] });
    };
    const pageTerminal = (page: Route) => ({ kind: 'page', name: page.url, file: page.file, line: page.line, route: page });
    const wrap = (name: string, file: string, pages: Route[]) => {
      wrappers.set(name, { name, file, pages });
    };
    origins.forEach((origin, i) => {
      const startsAt = origin.startsAt ?? 0;
      for (const id of origin.ids) visit({ id, origin: i, depth: startsAt, gates: [], initial: startsAt === 0 });
      if (startsAt) return;
      for (const terminal of this.routesByFile.get(origin.file) ?? []) {
        if (terminal.pages) wrap(origin.file, origin.file, terminal.pages);
      }
    });
    const providerOrigins = new Map<string, ChangeOrigin>();
    for (const origin of origins) for (const id of origin.ids) {
      if (origin.startsAt || this.routesByFile.get(origin.file)?.some(terminal => terminal.pages) ||
          typeof id !== 'number' || this.symbols.get(id)?.kind !== 'component') continue;
      const file = this.file(id);
      const key = `${file}#${this.name(id)}`;
      providerOrigins.set(key, origin);
    }
    if (providerOrigins.size) {
      const routesByProvider = new Map<string, Route[]>();
      for (const route of this.index.routes) {
        if (expired()) break;
        if (route.kind !== 'page') continue;
        const chains = this.index.branches?.[route.id] ?? [this.index.routeWrap[route.id]];
        const hits = new Set<string>();
        for (const chain of chains) for (const wrapper of this.index.wrapChains[chain] ?? []) {
          const key = `${wrapper.definitionFile ?? wrapper.file}#${wrapper.symbol}`;
          if (providerOrigins.has(key)) hits.add(key);
        }
        for (const key of hits) append(routesByProvider, key, route);
      }
      for (const [name, pages] of routesByProvider) {
        const origin = providerOrigins.get(name)!;
        wrap(name, origin.file, pages);
        for (const page of pages) remember(pageTerminal(page), { origin, depth: 0 });
      }
    }
    for (let level = 0, i = 0; level < levels.length && !expired();) {
      const state = levels[level]?.[i++];
      if (!state) {
        level++;
        i = 0;
        continue;
      }
      const { id, origin, depth, fetch, gates, possible, initial } = state;
      if (reached.get(stateKey(id, gates))?.get(origin) !== depth) continue;
      trpc ??= this.coverageIssue(id);
      const source = origins[origin];
      const impact = { origin: source, depth, fetch, possible };
      if (gates.some(gate => gate.partial)) flowIssue ??= propValueIssue;
      const terminals = this.terminals(id).filter(terminal =>
        !gates.length || terminal.kind === 'action' || terminal.route?.component === id && gates.every(gate => gate.scope === id && gate.unscoped));
      for (const terminal of initial && source.externalOnly ? [] : terminals) {
        if (gates.length && terminal.route?.component === id) flowIssue ??= propValueIssue;
        if (terminal.pages) for (const page of terminal.pages) remember(pageTerminal(page), impact);
        else remember(terminal, impact);
        if (terminal.kind === 'api') {
          const fetches = (this.fetches.get(terminal.file) ?? []).filter(entry => !isTestFile(entry.file));
          uncertain ||= fetches.some(entry => entry.dynamic || entry.partial);
          sdkIssue = strongerTransportIssue(sdkIssue, this.unboundedProductionTransport);
          for (const fetch of fetches) {
            if (fetch.via === AI_SDK_TRANSPORT && fetch.partial) sdkIssue = strongerTransportIssue(sdkIssue, transportIssue(fetch.transportOverride));
          }
        }
      }
      let edges = cached.get(id);
      if (!edges) {
        edges = this.predecessors(id).filter(edge => edge.from !== id && !isTestFile(edge.file));
        cached.set(id, edges);
      }
      for (const edge of edges) {
        if (initial && (edge.file === source.file ? source.externalOnly : source.importFiles && !source.importFiles.has(edge.file))) continue;
        const awaiting = predecessorGates(edge, gates);
        if (!awaiting) continue;
        const key = stateKey(edge.from, awaiting);
        const cost = impactCost(edge, gates);
        if ((reached.get(key)?.get(origin) ?? Infinity) <= depth + cost) continue;
        if (depth >= maxDepth && cost && edge.label !== 'render' && edge.label !== 'event') {
          (skipped[origin] ??= new Set()).add(key);
          continue;
        }
        const via = edge.label === 'fetch' ? `${edge.url ?? this.name(id)} (${edge.detail})` : fetch;
        flowIssue ??= gateIssue(edge) ?? (uncertainEntry(edge, gates) ? propValueIssue : undefined);
        if (edge.label === 'fetch' && edge.uncertainty) flowIssue ??= edge.uncertainty;
        if (edge.partial && edge.label !== 'fetch') trpc ??= edge.uncertainty ?? (this.index.router ? 'possible router dependency' : 'possible Pages dependency');
        visit({ id: edge.from, origin, depth: depth + cost, fetch: via, possible: possible || edge.partial, gates: awaiting });
      }
      trpc ??= this.trpcIssue(id, false);
      if (!edges.length) {
        const boundary = this.trpcBoundary(id, terminals, to => !!reached.get(stateKey(to, gates))?.has(origin));
        trpc ??= boundary;
        if (!boundary && !terminals.length && !initial) this.recordModuleStops(id, to => !!reached.get(stateKey(to, gates))?.has(origin), stops, ignoreTypeStops);
      }
    }
    const unexplored = new Set<string>();
    skipped.forEach((ids, origin) => {
      for (const id of ids) if (!reached.get(id)?.has(origin)) unexplored.add(id);
    });
    const ordered = [...routes.values()];
    for (const result of ordered) result.origins.sort((a, b) => a.depth - b.depth ||
      compare(a.origin.file, b.origin.file) || compare(a.origin.name, b.origin.name));
    ordered.sort((a, b) => a.origins[0].depth - b.origins[0].depth ||
      compare(a.terminal.file, b.terminal.file) || compare(a.terminal.name, b.terminal.name));
    const limit = nodeLimited ? 'node budget' : depthLimit(unexplored.size, maxDepth);
    const partial = [limit, trpc, flowIssue, sdkIssue].filter(Boolean).join('; ') ||
      (uncertain ? 'dynamic URL fetch' : undefined);
    return { routes: ordered, wrappers: [...wrappers.values()].sort((a, b) => compare(a.name, b.name)), partial, stops, traced };
  }

  routeStarts(route: Route): NodeId[] {
    if (route.router) return [this.routerId(route)];
    return [...new Set([
      route.component ?? this.defaultSymbol(route.file)?.id ?? this.fileNode(route.file),
      route.fileSymbol ?? this.fileNode(route.file)
    ])];
  }

  apiTargets(route: Route): NodeId[] {
    if (route.router) return [this.routerId(route)];
    return [...(route.methods?.length ? route.methods : ['?']).map(method => this.apiId(route, method)),
      ...Object.values(route.handlers ?? {}), ...(route.pages && route.fileSymbol !== undefined ? [route.fileSymbol] : [])];
  }

  private coverageIssue(id: NodeId, includeRoute = false, includeOpaqueLookup = true) {
    const route = this.pagesByFileId.get(id);
    return (typeof id === 'number' ? this.index.renderLookupIssues?.[id] ??
      (includeOpaqueLookup ? this.index.opaqueRenderLookupIssues?.[id] : undefined) ?? this.index.pagesOwnerIssues?.[id]?.[0] : undefined) ??
      (route ? this.index.pagesWrapperIssues?.[route.id]?.[0] ??
        (includeRoute ? this.index.pagesIssues?.[route.id]?.[0] ?? this.index.pagesApiIssues?.[route.id]?.[0] : undefined) : undefined);
  }

  private pageRenderEdge(edge: Edge, conditions: Record<string, PageRenderCondition> | undefined, route?: Route) {
    const site = conditions && renderKey(edge);
    const decision = site ? conditions?.[site] : undefined;
    if (decision === 'excluded') return;
    if (decision === 'conditional') return { ...edge, conditional: true };
    return decision === 'possible' ? { ...edge, partial: true,
      uncertainty: route && this.index.pagesWrapperIssues?.[route.id]?.[0] } : edge;
  }

  private enter(edge: Edge, contexts: RenderContexts): RenderContexts {
    return typeof edge.to === 'number' && this.gateScopes.has(edge.to)
      ? [...contexts.filter(([scope]) => scope !== edge.to), [edge.to, edge.site ?? '']] : contexts;
  }

  private addWorkspaceDependencies(modules: Set<string> | undefined, id: NodeId, contexts: RenderContexts) {
    if (!modules || typeof id !== 'number') return;
    for (const entry of this.index.workspaceDependencies?.[id] ?? []) {
      if (permits(entry.gates, contexts)) modules.add(entry.module);
    }
  }

  path(starts: NodeId[], goals: NodeId[], expired: () => boolean, route?: Route, pathname?: string): QueryResult {
    const unresolvedWorkspace = this.index.workspaceDependencies && new Set<string>();
    type Step = { id: NodeId; depth: number; weak: number; contexts: RenderContexts; previous?: Step; edge?: PathEdge; alternatives: Set<NodeId> };
    const depthBudget = 12;
    const routeContext = this.routeContext(route);
    const targets = new Set(goals);
    const apiGoals = goals.flatMap(id => this.api.get(String(id)) ?? this.handlerRoutes.get(id) ?? []);
    const initial = starts.map(id => ({ id, depth: 0, weak: 0, contexts: [] as Step['contexts'], alternatives: new Set<NodeId>() }));
    let layer: Step[] = initial;
    const seen = new Set(starts);
    const routerTraversal = this.index.router && new Set<number>();
    let flowIssue: string | undefined;
    let goal: Step | undefined;
    let partial: string | undefined;
    let trpc: string | undefined;
    const conditions = route && this.index.pagesRenderConditions?.[route.id];
    let sdkIssue: string | undefined;
    const wraps: PathEdge[] = [];
    if (route && !route.router) for (const [file, terminals] of this.routesByFile) {
      if (!terminals.some(terminal => terminal.pages?.includes(route))) continue;
      const fileId = this.fileNode(file);
      const component = this.index.routeFiles![file]?.[3] ?? this.defaultSymbol(file)?.id;
      if (component !== undefined) wraps.push({ from: starts[0], to: component, label: 'wrap', file, line: this.symbols.get(component)?.line ?? 1 });
      if (this.outgoing.has(fileId) || typeof fileId === 'number' && this.uncertainTransports.has(fileId)) {
        wraps.push({ from: starts[0], to: fileId, label: 'wrap', file, line: 1 });
      }
    }
    const stepOrder = (a: Step, b: Step) => a.weak - b.weak ||
      (a.edge && b.edge ? pathEdgeOrder(a.edge, b.edge) : 0) || compare(this.file(a.id), this.file(b.id)) ||
      compare(this.name(a.id), this.name(b.id));
    const alternatives = (chosen: Step, alternate: Step) => {
      const alternateId = chosen.id === alternate.id ? alternate.previous?.id : alternate.id;
      if (alternateId !== undefined && alternateId !== chosen.previous?.id) chosen.alternatives.add(alternateId);
    };

    while (layer.length && !expired()) {
      layer.sort(stepOrder);
      const reached = layer.filter(step => targets.has(step.id));
      if (reached.length) {
        goal = reached[0];
        for (const other of reached.slice(1)) alternatives(goal, other);
        break;
      }
      const next = new Map<NodeId, Step>();
      for (const current of layer) {
        if (expired()) break;
        if (typeof current.id === 'number') routerTraversal?.add(current.id);
        this.addWorkspaceDependencies(unresolvedWorkspace, current.id, current.contexts);
        trpc ??= this.coverageIssue(current.id) ?? this.unresolvedTrpc(current.id, false);
        if (apiGoals.length && typeof current.id === 'number' && this.propRequests.get(current.id)?.some(request =>
          (!isTestFile(request.file) || isTestFile(this.file(starts[0]))) &&
          permits(request.gates, current.contexts) &&
          apiGoals.some(({ route, name }) => !request.method || !route || route.pages && route.methodBasis !== 'enforced' ||
            name === route.url || name.startsWith(request.method + ' ') || name.startsWith('ALL ') ||
            request.method === 'HEAD' && name.startsWith('GET ')))) flowIssue ??= propUrlIssue;
        if (typeof current.id === 'number') sdkIssue = strongerTransportIssue(sdkIssue, this.uncertainTransports.get(current.id));
        const outgoing: PathEdge[] = [...this.outgoing.get(current.id) ?? []];
        if (current.depth === 0 && current.id === starts[0]) outgoing.push(...wraps);
        for (let edge of outgoing) {
          if (expired()) break;
          if (routeContext && edge.sourceRoute !== undefined && !routeContext.has(edge.sourceRoute)) continue;
          const applicable = this.pageRenderEdge(edge, conditions, route);
          if (!applicable) continue;
          edge = applicable;
          if (pathname && current.depth === 0 && edge.matcher) {
            const member = middlewareMatcher(edge.matcher.source, pathname, true);
            if (member === 'no') continue;
            const partial = member !== 'yes' || !!edge.matcher.conditional;
            edge = { ...edge, partial, conditional: partial };
          }
          if (isTestFile(edge.file) && !isTestFile(this.file(starts[0])) && !isTestFile(this.file(goals[0]))) continue;
          const matched = edge.gates?.map(gate => matchesContext(gate, current.contexts));
          if (matched?.includes(false)) continue;
          const traversalEdge = matched && (matched.includes(undefined) || edge.gates?.some(gate => gate.partial))
            ? { ...edge, gates: edge.gates?.map(gate => ({ ...gate, partial: true })) } : edge;
          const contexts = this.enter(edge, current.contexts);
          const handler = edge.label === 'fetch' ? this.api.get(String(edge.to))?.handler :
            edge.destination?.router ? this.routerId(edge.destination) : edge.destination?.component;
          for (const id of handler === undefined || handler === edge.to ? [edge.to] : [edge.to, handler]) {
            const key = forwardKey(id, contexts);
            if (seen.has(key)) continue;
            if (current.depth === depthBudget) {
              partial ??= 'hop budget (12)';
              continue;
            }
            const candidate: Step = {
              id, depth: current.depth + 1, weak: current.weak + Number(!!edge.partial || !!gateIssue(traversalEdge) ||
                edge.label === 'use' || edge.label === 'dyn'),
              contexts, previous: current, edge: traversalEdge, alternatives: new Set()
            };
            const earlier = next.get(key);
            if (!earlier && seen.size + next.size >= nodeBudget) {
              partial = 'node budget';
              continue;
            }
            if (!earlier) next.set(key, candidate);
            else if (stepOrder(candidate, earlier) < 0) {
              candidate.alternatives = earlier.alternatives;
              candidate.alternatives.delete(candidate.previous!.id);
              alternatives(candidate, earlier);
              next.set(key, candidate);
            } else alternatives(earlier, candidate);
          }
        }
      }
      layer = [...next.values()];
      for (const key of next.keys()) seen.add(key);
    }

    const scope = 'over indexed render, event, call, action, fetch, dyn, use and wrap edges' +
      (this.index.pagesEdges ? ', including Pages lifecycle, middleware and navigation' : this.index.router ? ', including route-module entries and router references' : '');
    const appCoverage = route && this.index.pagesWrapperIssues?.[route.id]?.find(issue => issue.startsWith('custom App unresolved ('));
    const coverage = (reason?: string) =>
      [...new Set([reason, appCoverage, sdkIssue].filter(Boolean))].join('; ') || undefined;
    if (!goal) {
      const trace = this.traceImpact(goals, 6, false, expired);
      const pages = new Set(trace.terminals.flatMap(({ terminal }) => terminal.kind === 'page' ? [terminal.name] :
        terminal.pages?.map(page => page.url) ?? []));
      const notes = [graphRow(`# from reaches ${seen.size} nodes` +
        (pages.size ? `; to is reached from routes: ${[...pages].slice(0, 5).join(', ')}${pages.size > 5 ? ', +' + (pages.size - 5) : ''}` : ''))];
      return { rows: [], notes, unresolvedWorkspace, count: 'no directed path', routerTraversal,
        partial: coverage(partial ?? (route && this.index.pagesIssues?.[route.id]?.[0]) ?? trpc) ?? flowIssue ?? trace.trpc,
        scope: 'no directed path ' + scope };
    }

    const rows: QueryRow[] = [];
    let chosenIssue: string | undefined;
    const otherSteps = new Set<NodeId>(goal.alternatives);
    let pathIssue: string | undefined;
    for (let step = goal; step.edge && step.previous; step = step.previous) {
      for (const alternate of step.previous.alternatives) otherSteps.add(alternate);
      const edge = step.edge;
      pathIssue ??= edge.uncertainty ?? gateIssue(edge);
      if (edge.partial && !edge.transportIssue) pathIssue ??= edge.label === 'fetch' ? 'uncertain URL match' : 'possible dependency';
      if (edge.label === 'use') pathIssue ??= 'symbol use does not trace invocation';
      chosenIssue ??= this.coverageIssue(step.id) ?? (typeof step.previous.id === 'number' ?
        this.index.pagesOwnerIssues?.[step.previous.id]?.[0] : undefined);
      const file = this.file(step.id);
      const symbol = typeof step.id === 'number' ? this.symbols.get(step.id) : undefined;
      sdkIssue = strongerTransportIssue(sdkIssue, edge.transportIssue);
      if (edge.partial && this.index.pagesEdges && !edge.transportIssue) partial ??= edge.uncertainty ??
        (edge.label === 'fetch' ? 'uncertain URL match' : `possible ${edge.label} edge`);
      const name = edge.destination ? (edge.method ? edge.method + ' ' : '') + edge.destination.url : edge.label === 'fetch' ? `${edge.method} ${edge.url}` + (symbol ? ' (' + symbol.name + ')' : '') :
        this.name(step.id) + (edge.detail?.startsWith('.') ? edge.detail : '');
      rows.unshift(graphRow(`${step.depth} ${edge.label} ${location(edge.file, edge.line)} ${name}` +
        ((step === goal || edge.label === 'trpc') && file !== edge.file ? ' -> ' + location(file, symbol?.line) : '') +
        (edge.detail && (edge.label === 'event' || edge.label === 'render' || edge.label === 'call' && !edge.detail.startsWith('.') ||
          edge.label === 'fetch' && edge.detail.includes(' via prop ') || edge.label === 'trpc' || edge.label === 'data' ||
          edge.label === 'middleware' || edge.label === 'wrap' && !!this.index.router || edge.label === 'load' || edge.label === 'submit' || isNavigation(edge.label))
          ? ` (${edge.detail})` : '') +
        (edge.conditional ? ' [cond]' : '') + (edge.partial ? edge.label === 'fetch' && !edge.uncertainty ? ' [partial url]' : ' [possible]' : '') +
        (edge.possibleReconnect ? ' [possible reconnect]' : ''), edge.file, file));
    }
    let origin = goal;
    while (origin.previous) origin = origin.previous;
    const symbol = typeof origin.id === 'number' ? this.symbols.get(origin.id) : undefined;
    if (route) rows.unshift(graphRow(`0 route ${route.url}  ${location(route.file, route.line)} ${this.name(starts[0])}`, route.file));
    else rows.unshift(graphRow(`0 ${symbol?.kind ?? 'module'} ${location(this.file(origin.id), symbol?.line)} ${this.name(origin.id)}`, this.file(origin.id)));
    const notes = otherSteps.size ? [graphRow(`# alternatives: ${quantity(otherSteps.size, 'other shortest step')} (via ` +
      `${[...otherSteps].slice(0, 2).map(id => `${this.file(id)}#${this.name(id)}`).join(', ')})`)] : [];
    return { rows, notes, count: quantity(goal.depth, 'hop'), routerTraversal,
      partial: coverage(partial ?? chosenIssue ?? pathIssue ?? (!this.index.pagesEdges ? trpc : undefined)),
      scope: 'shortest directed path ' + scope + (rows.some(row => /^\d+ trpc /.test(row.text)) ? ', including tRPC' : '') };
  }

  neighbors(id: number, expired: () => boolean): QueryRow {
    const callers = new Set(this.predecessors(id).filter(edge => edge.from !== id && !isTestFile(edge.file)).map(edge => edge.file));
    const callees = new Set((this.outgoing.get(id) ?? []).filter(edge => edge.label !== 'use' && edge.to !== id).map(edge => edge.to));
    const trace = this.traceImpact([id], 3, false, expired);
    const routes = new Set(trace.terminals.flatMap(({ terminal }) => terminal.pages?.map(route => route.file) ??
      (terminal.kind === 'action' || terminal.kind === 'middleware' ? [] : [terminal.file])));
    return graphRow(`# neighbors: ${callers.size} caller ${callers.size === 1 ? 'file' : 'files'}, ${callees.size} callees, reaches ${routes.size} routes` +
      (this.action(id) ? '; server action' : '') + (trace.trpc ? `; ${trace.trpc}` : '') +
      (trace.stops.size ? `; ${moduleStops(trace.stops.size)}` : '') + '. Next: impact | callees');
  }

  callees(seed: NodeId | NodeId[], depth: number, uses: boolean, expired: () => boolean, route?: Route): QueryResult {
    const routeContext = this.routeContext(route);
    const conditions = route && this.index.pagesRenderConditions?.[route.id];
    const seeds = Array.isArray(seed) ? seed : [seed];
    const seen = new Set<NodeId>(seeds);
    const pending = seeds.map(id => ({ id, depth: 0, contexts: [] as RenderContexts }));
    const routerTraversal = this.index.router && new Set<number>();
    const rows: QueryRow[] = [];
    const packages = new Set<string>();
    const notes: QueryRow[] = [];
    const unresolvedWorkspace = this.index.workspaceDependencies && new Set<string>();
    const project = new Set<string>();
    const renders = new Set<NodeId>();
    const fetches = new Set<string>();
    const navigation = new Set<NodeId>();
    let unresolved = 0;
    let sdkIssue: string | undefined;
    let collapsed = false;
    let budget = false;
    let trpc: string | undefined;
    let flowIssue: string | undefined;
    for (let i = 0; i < pending.length && !expired(); i++) {
      const current = pending[i];
      if (current.depth >= depth) break;
      if (typeof current.id === 'number') {
        routerTraversal?.add(current.id);
        flowIssue ??= this.index.flowIssues?.[current.id]?.find(issue => permits(issue.gates, current.contexts))?.reason;
        if (this.propRequests.get(current.id)?.some(request => permits(request.gates, current.contexts))) flowIssue ??= propUrlIssue;
      }
      trpc ??= this.coverageIssue(current.id, true) ?? this.unresolvedTrpc(current.id, true);
      if (typeof current.id === 'number') sdkIssue = strongerTransportIssue(sdkIssue, this.uncertainTransports.get(current.id));
      const d = current.depth + 1;
      const file = this.file(current.id);
      this.addWorkspaceDependencies(unresolvedWorkspace, current.id, current.contexts);
      const parent = d > 1 ? ` < ${this.name(current.id)}` : '';
      const edges = (this.outgoing.get(current.id) ?? []).flatMap(edge => {
        if (!uses && edge.label === 'use' || routeContext && edge.sourceRoute !== undefined &&
            (!routeContext.has(edge.sourceRoute) || edge.sourceRoute === route?.id)) return [];
        if (!permits(edge.gates, current.contexts)) return [];
        const applicable = this.pageRenderEdge(edge, conditions, route);
        return applicable ? [applicable] : [];
      }).sort((a, b) => outgoingRank[a.label] - outgoingRank[b.label] || a.line - b.line || edgeOrder(a, b));
      const groups = new Map<string, Edge[]>();
      for (const edge of edges) append(groups, JSON.stringify([edge.label, edge.to, edge.detail, edge.method, edge.file, ...(this.index.router ? [edge.destination?.id] : [])]), edge);
      const neighbours = new Set(edges.map(edge => edge.to));
      const hub = neighbours.size > hubSize;
      if (hub) {
        const files = [...new Set([...neighbours].map(id => this.file(id)))].sort(compare);
        rows.push(graphRow(`d${d} ${neighbours.size} callees in ${files.length} files (top: ${files.slice(0, 3).join(', ')})${parent}`, ...files.slice(0, 3)));
        collapsed = true;
      }
      for (const sites of groups.values()) {
        if (expired()) break;
        const [edge] = sites;
        sdkIssue = strongerTransportIssue(sdkIssue, edge.transportIssue);
        flowIssue ??= sites.find(site => site.uncertainty)?.uncertainty ?? gateIssue(edge) ??
          (sites.some(site => site.gates?.some(gate => matchesContext(gate, current.contexts) === undefined)) ? propValueIssue : undefined);
        if (sites.some(site => site.partial && !site.transportIssue)) flowIssue ??= edge.label === 'fetch' ? 'uncertain URL match' : 'possible dependency';
        if (edge.label === 'render') renders.add(edge.to);
        else if (edge.label === 'fetch' || edge.label === 'load' || edge.label === 'submit') fetches.add(JSON.stringify([edge.to, edge.method]));
        else if (isNavigation(edge.label)) navigation.add(edge.to);
        else if (edge.label === 'data' || edge.label === 'middleware' || edge.label === 'call' || edge.label === 'event' || edge.label === 'action' || edge.label === 'trpc') project.add(JSON.stringify([edge.to, edge.detail]));
        const target = this.file(edge.to);
        const name = this.name(edge.to);
        const label = edge.destination ? (edge.method ? edge.method + ' ' : '') + edge.destination.url : edge.label === 'fetch' ? `${edge.method} ${edge.url}` : edge.detail?.startsWith('.') ? name + edge.detail : name;
        if (!hub) {
          const lines = [...new Set(sites.map(site => site.line))];
          const site = (d === 1 && edge.file === file ? '' : edge.file) + ':' + lines.slice(0, 3).join(',') +
            (lines.length > 3 ? ` +${lines.length - 3}` : '');
          const flags = (edge.label === 'action' ? ' [action]' : '') + (sites.some(site => site.conditional) ? ' [cond]' : '') +
            (sites.some(site => site.partial) ? edge.label === 'fetch' && !edge.uncertainty ? ' [partial url]' : ' [possible]' : '') + (edge.from === edge.to ? ' [self]' : '') +
            (sites.some(site => site.possibleReconnect) ? ' [possible reconnect]' : '') +
            (!isTestFile(file) && isTestFile(target) ? ' [test]' : '');
          rows.push(graphRow(`d${d} ${edge.label} ${site}  ${label}  ${target}` +
            (edge.detail?.startsWith('.') ? `#${name}` : edge.label === 'trpc' ? `:${this.symbols.get(Number(edge.to))?.line} (${edge.detail})` :
              edge.detail ? ` (${edge.detail})` : '') + flags + parent, file, target));
        }
        if (edge.partial && this.index.pagesEdges && (!edge.transportIssue || edge.uncertainty)) trpc ??= edge.uncertainty ??
          (edge.label === 'fetch' ? 'uncertain URL match' : `possible ${edge.label} edge`);
        if (isNavigation(edge.label)) continue;
        for (const site of sites) {
          const contexts = this.enter(site, current.contexts);
          const key = forwardKey(site.to, contexts);
          if (seen.has(key)) continue;
          if (seen.size >= nodeBudget) {
            budget = true;
            break;
          }
          seen.add(key);
          pending.push({ id: site.to, depth: d, contexts });
        }
      }
      const modules = new Map<string, ExternalCall[]>();
      for (const call of this.external.get(current.id) ?? []) append(modules, this.index.externalModules![call[2]], call);
      for (const [module, calls] of [...modules].sort(([a], [b]) => compare(a, b))) {
        packages.add(module);
        const names = this.index.graphNames!;
        const sites = calls.sort((a, b) => a[1] - b[1] || compare(names[a[3]], names[b[3]])).slice(0, 3)
          .map(([, line, , name, count]) => `${names[name]}:${line}${count ? ` ×${count}` : ''}`);
        rows.push(graphRow(`d${d} ext ${module}  ${sites.join(', ')}${calls.length > 3 ? ` +${calls.length - 3}` : ''}${parent}`, file));
      }
      if (typeof current.id === 'number') {
        unresolved += this.index.unresolvedCalls![current.id] ?? 0;
        for (const [file, line, expression] of this.index.pagesObservedCalls?.[current.id] ?? []) {
          rows.push(graphRow(`d${d} observed ${location(file, line)} ${expression} [target unresolved]${parent}`, file));
        }
      }
    }
    const callers = new Set(seeds.flatMap(id => this.predecessors(id))
      .filter(edge => !seeds.includes(edge.from) && !isTestFile(edge.file)).map(edge => edge.file));
    const sources = [...new Set(seeds.map(id => this.file(id)))];
    if (rows.length && sources.length) notes.push(graphRow(`# source: ${sources.join(', ')} (unqualified first-hop sites)`, ...sources));
    notes.push(graphRow(`# callers: ${callers.size} (impact for routes)`));
    const partial = [budget ? 'node budget' : trpc, flowIssue,
      unresolved ? `${quantity(unresolved, 'unresolved call')} on local variables or parameters` : undefined,
      sdkIssue].filter(Boolean).join('; ');
    return { rows, notes, unresolvedWorkspace, routerTraversal, count: `${project.size} project calls, ${renders.size} renders, ${fetches.size} fetches, ${packages.size} packages` +
      (navigation.size ? `, ${navigation.size} navigation targets` : '') + (collapsed ? ', hub collapsed' : ''), partial: partial || undefined,
    scope: `indexed calls, renders, fetches, package calls${uses ? ', uses' : ''} (depth ${depth})` };
  }
}
