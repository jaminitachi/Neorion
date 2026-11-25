import { AI_SDK_TRANSPORT, AI_SDK_URL_OVERRIDE, GRAPH_INDEX_REVISION, GraphReferenceKind, isTestFile,
  type ExternalCall, type ModuleImport, type QueryIndex,
  type RuntimeExportState, type ServerAction, type SymbolEntry, type TrpcUse } from './Index';

type Route = QueryIndex['routes'][number];
type NodeId = number | string;
type Label = 'call' | 'action' | 'render' | 'fetch' | 'dyn' | 'use' | 'trpc';
type Edge = {
  from: NodeId; to: NodeId; label: Label; file: string; line: number;
  detail?: string; conditional?: boolean; partial?: boolean; url?: string; method?: string;
};
type PathEdge = Omit<Edge, 'label'> & { label: Label | 'wrap' };
type Visit = { depth: number; edge?: Edge; conditional?: boolean; via?: string[] };
export type QueryRow = { text: string; files: string[]; pathEnd?: number };
export type QueryResult = {
  rows: QueryRow[]; title?: string; count?: string; targets?: string[];
  notes?: QueryRow[]; limit?: number; partial?: string; scope?: string;
};
export type ChangeOrigin = { file: string; name: string; ids: NodeId[]; removed?: boolean; startsAt?: number;
  renamed?: boolean; externalOnly?: boolean; importFiles?: ReadonlySet<string> };
export type Terminal = { kind: string; name: string; file: string; line?: number; route?: Route; pages?: Route[];
  handler?: number; matchedRoutes?: Route[] };
type Reached = { terminal: Terminal; visit: Visit; node: NodeId; metadata: boolean };
const rank: Record<Label, number> = { call: 0, action: 1, render: 2, fetch: 3, dyn: 4, use: 5, trpc: 1 };
const outgoingRank: Record<Label, number> = { render: 0, call: 1, action: 1, fetch: 2, dyn: 3, use: 4, trpc: 1 };
const nodeBudget = 5000;
const hubSize = 30;
const fetchTypes = new Set(['fetch', 'SWR key', 'axios', AI_SDK_TRANSPORT]);
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
  return routes.filter(({ url }) => patterns.some(pattern => pattern!(url)));
}
const location = (file: string, line?: number) => file + (line === undefined ? '' : ':' + line);
const edgeOrder = (a: Edge, b: Edge) => rank[a.label] - rank[b.label] || compare(a.file, b.file) ||
  a.line - b.line || compare(String(a.from), String(b.from)) || compare(String(a.to), String(b.to));
const pathEdgeOrder = (a: PathEdge, b: PathEdge) =>
  (a.label === 'wrap' ? 6 : rank[a.label]) - (b.label === 'wrap' ? 6 : rank[b.label]) ||
  compare(a.file, b.file) || a.line - b.line || compare(String(a.from), String(b.from)) || compare(String(a.to), String(b.to));
const terminalKey = (terminal: Terminal) => JSON.stringify([terminal.kind, terminal.file, terminal.name]);
const terminalOrder = (a: Reached, b: Reached) => a.visit.depth - b.visit.depth ||
  compare(a.terminal.file, b.terminal.file) || (a.terminal.line ?? 0) - (b.terminal.line ?? 0) ||
  compare(a.terminal.name, b.terminal.name);

function append<K, V>(map: Map<K, V[]>, id: K, value: V) {
  const entries = map.get(id);
  if (entries) entries.push(value);
  else map.set(id, [value]);
}

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
  private api = new Map<string, Terminal>();
  private pageRoots = new Map<NodeId, Terminal[]>();
  private external = new Map<NodeId, ExternalCall[]>();
  private trpc: Set<string>;
  private unboundProcedures: Set<number>;
  private procedureSites = new Map<number, { file: string; use: TrpcUse }[]>();
  private trpcModuleUses = new Map<number, Set<string>>();
  private fetches = new Map<string, QueryIndex['fetches']>();
  private uncertainTransports = new Set<number>();
  private unboundedTransport = false;
  private unboundedProductionTransport = false;

  constructor(private index: QueryIndex, symbols: Map<number, SymbolEntry>) {
    this.symbols = symbols;
    this.trpc = new Set(index.trpcFiles);
    this.unboundProcedures = new Set(index.trpcUnbound);
    for (const [file, uses] of Object.entries(index.trpcModuleUses ?? {})) {
      this.trpcModuleUses.set(Number(file), new Set(uses.map(([target, line]) => `${target}:${line}`)));
    }
    Object.keys(index.files).forEach((file, offset) => {
      const id = index.fileSymbols![offset];
      this.files.set(id, file);
      this.fileIds.set(file, id);
    });
    for (const symbol of symbols.values()) append(this.symbolsByFile, symbol.file, symbol);
    for (const [file, owner, unbounded] of index.uncertainChatTransports ?? []) {
      this.uncertainTransports.add(owner);
      this.unboundedTransport ||= unbounded !== false;
      this.unboundedProductionTransport ||= unbounded !== false && !isTestFile(file);
      for (const alias of index.trpcAliases?.[owner] ?? []) this.uncertainTransports.add(alias);
    }

    const pages = index.routes.filter(route => route.kind === 'page');
    for (const route of index.routes) {
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
      const key = JSON.stringify([edge.from, edge.to, edge.label, edge.file, edge.line, edge.detail ?? '', edge.method]);
      if (edges.has(key)) return;
      edges.add(key);
      append(this.incoming, edge.to, edge);
      append(this.outgoing, edge.from, edge);
    };
    const add = (edge: Edge) => {
      addEdge(edge);
      if (typeof edge.from !== 'number') return;
      for (const alias of index.trpcAliases?.[edge.from] ?? []) addEdge({ ...edge, from: alias });
    };
    const calls = new Set<string>();
    const callSite = (to: NodeId, from: NodeId, line: number) => JSON.stringify([to, from, line]);
    for (const [target, referenceFile, line, kind, detail, owner, graphOwner] of index.references) {
      const file = referenceFile ?? this.file(target);
      if (kind === 'call') {
        const from = graphOwner ?? owner ?? this.fileNode(file);
        add({ from, to: target, label: this.actions.has(target) ? 'action' : 'call', file, line, detail: detail ?? undefined });
        calls.add(callSite(target, from, line));
      } else if (kind === 'use') add({ from: owner ?? this.fileNode(file), to: target, label: 'use', file, line });
    }
    for (const [fileKey, refs] of Object.entries(index.graphReferences!)) {
      const fileId = Number(fileKey);
      const file = this.file(fileId);
      for (const [to, line, kind, owner, detail] of refs) {
        const label = kind === GraphReferenceKind.MemberCall ? 'call' : kind === GraphReferenceKind.DynamicImport ? 'dyn' :
          kind === GraphReferenceKind.Render ? 'render' : 'use';
        add({ from: owner ?? fileId, to, label, file, line,
          detail: label === 'call' && detail !== undefined ? index.graphNames![detail] : undefined,
          conditional: label === 'render' && !!detail });
      }
    }
    for (const { id, action } of this.actionTargets) {
      for (const [file, line, owner] of action.callers) {
        const from = owner ?? this.fileNode(file);
        if (!calls.has(callSite(id, from, line))) add({ from, to: id, label: 'action', file, line });
      }
    }
    for (const [from, to, line, conditional] of index.renderEdges) {
      add({ from, to, label: 'render', file: this.file(from), line, conditional: !!conditional });
    }
    const routes = new Map(index.routes.map(route => [route.id, route]));
    for (const fetch of index.fetches) {
      const route = routes.get(fetch.route);
      if (!route || route.kind !== 'api') continue;
      append(this.fetches, route.file, fetch);
      if (!fetchTypes.has(fetch.via) || fetch.method === '?' ||
          (route.methods?.length && !route.methods.includes(fetch.method) && !route.methods.includes('ALL'))) continue;
      const method = route.methods?.includes('ALL') ? 'ALL' : route.methods?.length ? fetch.method : '?';
      const to = this.apiId(route, method);
      add({ from: fetch.graphOwner ?? fetch.owner ?? this.fileNode(fetch.file), to, label: 'fetch', file: fetch.file,
        line: fetch.line, detail: fetch.via, url: route.url, method: fetch.method, partial: fetch.partial || fetch.dynamic });
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

  private apiId(route: Route, method: string) {
    return `api:${route.id}:${method}`;
  }

  file(id: NodeId): string {
    if (typeof id === 'string') return this.api.get(id)?.file ?? id.slice(5);
    return this.symbols.get(id)?.file ?? this.files.get(id) ?? '';
  }

  name(id: NodeId): string {
    if (typeof id === 'string') return this.api.get(id)?.name ?? 'module';
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

  private recordModuleStops(id: NodeId, reached: (id: NodeId) => boolean, stops: Set<string>) {
    if (this.files.get(Number(id)) === undefined && !(typeof id === 'string' && id.startsWith('file:'))) return;
    for (const edge of this.outgoing.get(id) ?? []) {
      if ((edge.label === 'use' || edge.label === 'call' || edge.label === 'action' || edge.label === 'trpc') &&
          reached(edge.to)) stops.add(location(edge.file, edge.line));
    }
  }

  private terminals(id: NodeId): Terminal[] {
    const api = typeof id === 'string' ? this.api.get(id) : undefined;
    if (api) return [api];
    const action = this.action(id);
    const file = this.file(id);
    const terminals = new Map<string, Terminal>();
    const handlers = this.handlerRoutes.get(id);
    for (const terminal of [...this.routesByFile.get(file) ?? [], ...this.pageRoots.get(id) ?? [], ...handlers ?? []]) {
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
    const rows = this.terminalRows([...routes.values()].filter(({ visit }) => visit.depth > 0), 100);
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

  traceImpact(seeds: NodeId[], depth: number, includeTests: boolean, expired: () => boolean) {
    const visited = new Map<NodeId, Visit>();
    const levels: NodeId[][] = [];
    const tests = new Set<string>();
    const boundary = new Set<NodeId>();
    const hubs: QueryRow[] = [];
    const hidden = new Set<NodeId>();
    const terminals = new Map<string, Reached>();
    let nodeLimited = false;
    let trpc: string | undefined;
    let transportOverride = false;
    const uncertain = new Set<string>();
    const literals = new Set<string>();
    const stops = new Set<string>();
    const visit = (id: NodeId, value: Visit) => {
      if (visited.has(id)) return false;
      if (visited.size >= nodeBudget) {
        nodeLimited = true;
        return false;
      }
      visited.set(id, value);
      (levels[value.depth] ??= []).push(id);
      return true;
    };
    for (const seed of seeds) visit(seed, { depth: 0 });
    for (let level = 0; level < levels.length && !expired(); level++) {
      for (const id of levels[level]) {
        if (expired()) break;
        const current = visited.get(id)!;
        const endpoints = this.terminals(id);
        for (const terminal of endpoints) {
          const key = terminalKey(terminal);
          const earlier = terminals.get(key);
          const metadata = terminal.kind === 'page' && this.name(id) === 'generateMetadata';
          if (!earlier || metadata && earlier.visit.depth === level) {
            terminals.set(key, { terminal, visit: earlier?.visit ?? current, node: earlier?.node ?? id, metadata });
          }
          if (terminal.kind === 'api') {
            transportOverride ||= this.unboundedProductionTransport || includeTests && this.unboundedTransport;
            for (const fetch of this.fetches.get(terminal.file) ?? []) {
              if (!includeTests && isTestFile(fetch.file)) continue;
              if (fetch.dynamic || fetch.partial) uncertain.add(fetch.file);
              transportOverride ||= fetch.via === AI_SDK_TRANSPORT && !!fetch.partial;
              if (fetch.via === 'route literal') literals.add(fetch.file);
            }
          }
        }
        const edges = this.predecessors(id);
        const additions = new Map<NodeId, Edge>();
        let hasCaller = false;
        for (const edge of edges) {
          if (edge.from === id) continue;
          if (!includeTests && isTestFile(edge.file)) {
            if (!visited.has(edge.from)) tests.add(edge.file);
            continue;
          }
          hasCaller = true;
          if (visited.has(edge.from)) continue;
          if (level >= depth && edge.label !== 'render') {
            boundary.add(edge.from);
            continue;
          }
          if (!additions.has(edge.from)) additions.set(edge.from, edge);
        }
        trpc ??= this.trpcIssue(id, includeTests);
        if (!hasCaller) {
          const boundary = this.trpcBoundary(id, endpoints, to => visited.has(to));
          trpc ??= boundary;
          if (!boundary && !endpoints.length && current.edge) this.recordModuleStops(id, to => visited.has(to), stops);
        }
        if (additions.size > hubSize && level < depth) {
          const files = [...new Set([...additions.values()].map(edge => edge.file))].sort(compare);
          const label = additions.values().next().value!.label;
          hubs.push(graphRow(`d${level + 1} ${label}  ${additions.size} callers in ${quantity(files.length, 'file')} (top: ${files.slice(0, 3).join(', ')})`, ...files.slice(0, 3)));
        }
        for (const [from, edge] of additions) {
          if (expired()) break;
          const via = [this.name(id), ...current.via ?? []].slice(0, 2);
          if (visit(from, { depth: level + 1, edge, via, conditional: current.conditional || edge.conditional })) {
            if (additions.size > hubSize && level < depth) hidden.add(from);
          } else if (nodeLimited) break;
        }
      }
    }
    const unexplored = [...boundary].filter(id => !visited.has(id)).length;
    const limit = nodeLimited ? 'node budget' : depthLimit(unexplored, depth);
    const partial = [limit, trpc, stops.size ? 'module-level importers not traced' : undefined,
      transportOverride ? AI_SDK_URL_OVERRIDE : undefined].filter(Boolean).join('; ') ||
      (uncertain.size ? 'dynamic URL fetch' : undefined);
    return { visited, terminals: [...terminals.values()].sort(terminalOrder), tests, hidden, hubs, partial, trpc, literals, stops };
  }

  terminalRows(reached: Reached[], limit: number): QueryRow[] {
    const rows: QueryRow[] = [];
    const directPages = reached.filter(entry => entry.terminal.kind === 'page');
    const groupPages = directPages.length > 15 && limit <= 40;
    const groups = new Map<string, Route[]>();
    const listed = new Set(directPages.map(entry => entry.terminal.route?.id));
    for (const { terminal, visit, metadata } of reached) {
      const { kind, name, file, line, pages } = terminal;
      const suffix = `  d${visit.depth}` + (visit.depth > 1 && visit.via?.length ? ` via ${visit.via.slice(0, visit.depth - 1).join(' > ')}` : '') +
        (metadata ? ' (+generateMetadata)' : '') + (visit.conditional ? ' [cond]' : '') +
        (visit.edge?.label === 'dyn' ? ' [dyn]' : '') + (visit.edge?.partial ? ' [partial url]' : '') +
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
        rows.push(graphRow(`middleware ${file}  all matched routes${name === '/' ? '' : ` (matcher: ${name})`}${suffix}`, file));
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
      if (terminal.kind === 'api') apiFiles.add(terminal.file);
      else if (terminal.kind === 'action') continue;
      else if (terminal.pages) {
        layouts++;
        for (const page of terminal.pages) pageIds.add(page.id);
      } else if (terminal.route) pageIds.add(terminal.route.id);
      else if (terminal.kind === 'middleware') {
        for (const route of terminal.matchedRoutes ?? []) {
          if (route.kind === 'page') pageIds.add(route.id);
          else apiFiles.add(route.file);
        }
      } else other++;
    }
    const routeCount = pageIds.size + apiFiles.size;
    const unknownMiddleware = trace.terminals.some(({ terminal }) => terminal.kind === 'middleware' && !terminal.matchedRoutes);
    const groups = new Map<string, { id: NodeId; visit: Visit; edge: Edge }[]>();
    const files = new Set<string>();
    let symbols = 0;
    let used = 0;
    for (const [id, visit] of trace.visited) {
      if (!visit.edge) continue;
      used = Math.max(used, visit.depth);
      if (visit.depth > depth) continue;
      if (typeof id === 'number' && this.symbols.has(id)) symbols++;
      files.add(this.file(id));
      if (!trace.hidden.has(id)) append(groups, JSON.stringify([visit.depth, visit.edge.label, visit.edge.file]), { id, visit, edge: visit.edge });
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
        (items.some(item => item.edge.partial) ? ' [partial url]' : '') + (isTestFile(edge.file) ? ' [test]' : '');
      const chain = visit.depth === 1 && seeds.length === 1 ? '' : ` < ${via.join(', ')}`;
      rows.push(graphRow(`d${visit.depth} ${label} ${edge.file}:${lines.slice(0, 5).join(',')}` +
        `${lines.length > 5 ? '+' + (lines.length - 5) : ''} ${names.join(', ')}${chain}${flags}`, edge.file));
    }
    if (trace.tests.size) notes.push(graphRow(`# tests: ${trace.tests.size} ${trace.tests.size === 1 ? 'file reaches' : 'files reach'} target (includeTests to list)`));
    if (trace.literals.size) notes.push(graphRow(`# also referenced as literal: ${quantity(trace.literals.size, 'file')}`));
    if (trace.stops.size) notes.push(graphRow('# ' + moduleStops(trace.stops.size)));
    if (unknownMiddleware) notes.push(graphRow('# middleware: matcher coverage not enumerated'));
    notes.push(graphRow(`# risk: ${quantity(routeCount, 'route')} (${quantity(pageIds.size, 'page')}, ${quantity(apiFiles.size, 'API')}` +
      `${other ? `, ${quantity(other, 'meta or special file')}` : ''}), ${quantity(actions.length, 'server action')}, ` +
      `${quantity(layouts, 'layout')}; ${quantity(symbols, 'symbol')} in ${quantity(files.size, 'file')}; max depth ${used}; ${quantity(trace.tests.size, 'test')}`));
    return { rows, notes, count: `${quantity(routeCount, 'route')}, ${quantity(actions.length, 'action')}, ${quantity(symbols, 'symbol')}, depth ${used}` +
      (used > depth ? ` (limit ${depth} + renders)` : '') +
      (trace.hubs.length ? ', hub collapsed' : ''), partial: [trace.partial, unknownMiddleware ? 'middleware matcher coverage not enumerated' : undefined].filter(Boolean).join('; ') || undefined,
      scope: 'indexed call, render, action, use, dyn, fetch edges' +
        ([...trace.visited.values()].some(visit => visit.edge?.label === 'trpc') ? ', including tRPC' : '') };
  }

  changeRoutes(origins: ChangeOrigin[], maxDepth: number, expired: () => boolean) {
    type Impact = { origin: ChangeOrigin; depth: number; fetch?: string };
    type State = { id: NodeId; origin: number; depth: number; fetch?: string };
    const routes = new Map<string, { terminal: Terminal; origins: Impact[] }>();
    const wrappers = new Map<string, { name: string; file: string; pages: Route[] }>();
    const reached = new Map<NodeId, Set<number>>();
    const pending: State[] = [];
    const skipped: Set<NodeId>[] = [];
    const cached = new Map<NodeId, Edge[]>();
    let nodeLimited = false;
    let uncertain = false;
    let transportOverride = false;
    let trpc: string | undefined;
    const stops = new Set<string>();
    const traced = new Set<ChangeOrigin>();
    const visit = (state: State) => {
      const seen = reached.get(state.id);
      if (seen?.has(state.origin)) return;
      if ((!seen && reached.size >= nodeBudget) || pending.length >= nodeBudget * 4) {
        nodeLimited = true;
        return;
      }
      if (seen) seen.add(state.origin);
      else reached.set(state.id, new Set([state.origin]));
      pending.push(state);
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
      for (const id of origin.ids) visit({ id, origin: i, depth: startsAt });
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
    for (let i = 0; i < pending.length && !expired(); i++) {
      const { id, origin, depth, fetch } = pending[i];
      const source = origins[origin];
      const impact = { origin: source, depth, fetch };
      const terminals = this.terminals(id);
      for (const terminal of depth === 0 && source.externalOnly ? [] : terminals) {
        if (terminal.pages) for (const page of terminal.pages) remember(pageTerminal(page), impact);
        else remember(terminal, impact);
        if (terminal.kind === 'api') {
          const fetches = (this.fetches.get(terminal.file) ?? []).filter(entry => !isTestFile(entry.file));
          uncertain ||= fetches.some(entry => entry.dynamic || entry.partial);
          transportOverride ||= this.unboundedProductionTransport ||
            fetches.some(entry => entry.via === AI_SDK_TRANSPORT && entry.partial);
        }
      }
      let edges = cached.get(id);
      if (!edges) {
        edges = this.predecessors(id).filter(edge => edge.from !== id && !isTestFile(edge.file));
        cached.set(id, edges);
      }
      for (const edge of edges) {
        if (depth === 0 && (edge.file === source.file ? source.externalOnly : source.importFiles && !source.importFiles.has(edge.file))) continue;
        if (reached.get(edge.from)?.has(origin)) continue;
        if (depth >= maxDepth && edge.label !== 'render') {
          (skipped[origin] ??= new Set()).add(edge.from);
          continue;
        }
        const via = edge.label === 'fetch' ? `${edge.url ?? this.name(id)} (${edge.detail})` : fetch;
        visit({ id: edge.from, origin, depth: depth + 1, fetch: via });
      }
      trpc ??= this.trpcIssue(id, false);
      if (!edges.length) {
        const boundary = this.trpcBoundary(id, terminals, to => !!reached.get(to)?.has(origin));
        trpc ??= boundary;
        if (!boundary && !terminals.length && depth) this.recordModuleStops(id, to => !!reached.get(to)?.has(origin), stops);
      }
    }
    const unexplored = new Set<NodeId>();
    skipped.forEach((ids, origin) => {
      for (const id of ids) if (!reached.get(id)?.has(origin)) unexplored.add(id);
    });
    const ordered = [...routes.values()];
    for (const result of ordered) result.origins.sort((a, b) => a.depth - b.depth ||
      compare(a.origin.file, b.origin.file) || compare(a.origin.name, b.origin.name));
    ordered.sort((a, b) => a.origins[0].depth - b.origins[0].depth ||
      compare(a.terminal.file, b.terminal.file) || compare(a.terminal.name, b.terminal.name));
    const limit = nodeLimited ? 'node budget' : depthLimit(unexplored.size, maxDepth);
    const partial = [limit, trpc, transportOverride ? AI_SDK_URL_OVERRIDE : undefined].filter(Boolean).join('; ') ||
      (uncertain ? 'dynamic URL fetch' : undefined);
    return { routes: ordered, wrappers: [...wrappers.values()].sort((a, b) => compare(a.name, b.name)), partial, stops, traced };
  }

  routeStarts(route: Route): NodeId[] {
    return [...new Set([
      route.component ?? this.defaultSymbol(route.file)?.id ?? this.fileNode(route.file),
      route.fileSymbol ?? this.fileNode(route.file)
    ])];
  }

  apiTargets(route: Route): NodeId[] {
    return [...(route.methods?.length ? route.methods : ['?']).map(method => this.apiId(route, method)),
      ...Object.values(route.handlers ?? {})];
  }

  path(starts: NodeId[], goals: NodeId[], expired: () => boolean, route?: Route): QueryResult {
    type Step = { id: NodeId; depth: number; weak: number; previous?: Step; edge?: PathEdge; alternatives: Set<NodeId> };
    const depthBudget = 12;
    const targets = new Set(goals);
    const initial = starts.map(id => ({ id, depth: 0, weak: 0, alternatives: new Set<NodeId>() }));
    let layer: Step[] = initial;
    const seen = new Set(starts);
    let goal: Step | undefined;
    let partial: string | undefined;
    let trpc: string | undefined;
    let uncertain = false;
    const wraps: PathEdge[] = [];
    if (route) for (const [file, terminals] of this.routesByFile) {
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
        trpc ??= this.unresolvedTrpc(current.id, false);
        uncertain ||= typeof current.id === 'number' && this.uncertainTransports.has(current.id);
        const outgoing: PathEdge[] = [...this.outgoing.get(current.id) ?? []];
        if (current.depth === 0 && current.id === starts[0]) outgoing.push(...wraps);
        for (const edge of outgoing) {
          if (expired()) break;
          if (isTestFile(edge.file) && !isTestFile(this.file(starts[0])) && !isTestFile(this.file(goals[0]))) continue;
          const handler = edge.label === 'fetch' ? this.api.get(String(edge.to))?.handler : undefined;
          for (const id of handler === undefined ? [edge.to] : [edge.to, handler]) {
            if (seen.has(id)) continue;
            if (current.depth === depthBudget) {
              partial ??= 'hop budget (12)';
              continue;
            }
            const candidate: Step = {
              id, depth: current.depth + 1, weak: current.weak + Number(edge.label === 'use' || edge.label === 'dyn'),
              previous: current, edge, alternatives: new Set()
            };
            const earlier = next.get(id);
            if (!earlier && seen.size + next.size >= nodeBudget) {
              partial = 'node budget';
              continue;
            }
            if (!earlier) next.set(id, candidate);
            else if (stepOrder(candidate, earlier) < 0) {
              candidate.alternatives = earlier.alternatives;
              candidate.alternatives.delete(candidate.previous!.id);
              alternatives(candidate, earlier);
              next.set(id, candidate);
            } else alternatives(earlier, candidate);
          }
        }
      }
      layer = [...next.values()];
      for (const step of layer) seen.add(step.id);
    }

    const coverage = [partial ?? trpc, uncertain ? AI_SDK_URL_OVERRIDE : undefined].filter(Boolean).join('; ') || undefined;
    const scope = 'over indexed render, call, action, fetch, dyn, use and wrap edges';
    if (!goal) {
      const trace = this.traceImpact(goals, 6, false, expired);
      const pages = new Set(trace.terminals.flatMap(({ terminal }) => terminal.kind === 'page' ? [terminal.name] :
        terminal.pages?.map(page => page.url) ?? []));
      const notes = [graphRow(`# from reaches ${seen.size} nodes` +
        (pages.size ? `; to is reached from routes: ${[...pages].slice(0, 5).join(', ')}${pages.size > 5 ? ', +' + (pages.size - 5) : ''}` : ''))];
      return { rows: [], notes, count: 'no directed path', partial: coverage ?? trace.trpc,
        scope: 'no directed path ' + scope };
    }

    const rows: QueryRow[] = [];
    const otherSteps = new Set<NodeId>(goal.alternatives);
    for (let step = goal; step.edge && step.previous; step = step.previous) {
      for (const alternate of step.previous.alternatives) otherSteps.add(alternate);
      const edge = step.edge;
      const file = this.file(step.id);
      const symbol = typeof step.id === 'number' ? this.symbols.get(step.id) : undefined;
      const name = edge.label === 'fetch' ? `${edge.method} ${edge.url}` + (symbol ? ' (' + symbol.name + ')' : '') :
        this.name(step.id) + (edge.detail?.startsWith('.') ? edge.detail : '');
      rows.unshift(graphRow(`${step.depth} ${edge.label} ${location(edge.file, edge.line)} ${name}` +
        ((step === goal || edge.label === 'trpc') && file !== edge.file ? ' -> ' + location(file, symbol?.line) : '') +
        (edge.label === 'trpc' ? ` (${edge.detail})` : '') +
        (edge.conditional ? ' [cond]' : '') + (edge.partial ? ' [partial url]' : ''), edge.file, file));
    }
    let origin = goal;
    while (origin.previous) origin = origin.previous;
    const symbol = typeof origin.id === 'number' ? this.symbols.get(origin.id) : undefined;
    if (route) rows.unshift(graphRow(`0 route ${route.url}  ${location(route.file, route.line)} ${this.name(starts[0])}`, route.file));
    else rows.unshift(graphRow(`0 ${symbol?.kind ?? 'module'} ${location(this.file(origin.id), symbol?.line)} ${this.name(origin.id)}`, this.file(origin.id)));
    const notes = otherSteps.size ? [graphRow(`# alternatives: ${quantity(otherSteps.size, 'other shortest step')} (via ` +
      `${[...otherSteps].slice(0, 2).map(id => `${this.file(id)}#${this.name(id)}`).join(', ')})`)] : [];
    return { rows, notes, count: `${goal.depth} ${goal.depth === 1 ? 'hop' : 'hops'}`, partial: coverage,
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

  callees(seed: number, depth: number, uses: boolean, expired: () => boolean): QueryResult {
    const seen = new Set<NodeId>([seed]);
    const pending = [{ id: seed as NodeId, depth: 0 }];
    const rows: QueryRow[] = [];
    const packages = new Set<string>();
    const notes: QueryRow[] = [];
    const project = new Set<string>();
    const renders = new Set<NodeId>();
    const fetches = new Set<string>();
    let unresolved = 0;
    let uncertain = false;
    let collapsed = false;
    let budget = false;
    let trpc: string | undefined;
    for (let i = 0; i < pending.length && !expired(); i++) {
      const current = pending[i];
      if (current.depth >= depth) break;
      trpc ??= this.unresolvedTrpc(current.id, true);
      uncertain ||= typeof current.id === 'number' && this.uncertainTransports.has(current.id);
      const d = current.depth + 1;
      const file = this.file(current.id);
      const parent = d > 1 ? ` < ${this.name(current.id)}` : '';
      const edges = (this.outgoing.get(current.id) ?? []).filter(edge => uses || edge.label !== 'use').sort((a, b) =>
        outgoingRank[a.label] - outgoingRank[b.label] || a.line - b.line || edgeOrder(a, b));
      const groups = new Map<string, Edge[]>();
      for (const edge of edges) append(groups, JSON.stringify([edge.label, edge.to, edge.detail, edge.method, edge.file]), edge);
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
        if (edge.label === 'render') renders.add(edge.to);
        else if (edge.label === 'fetch') fetches.add(JSON.stringify([edge.to, edge.method]));
        else if (edge.label === 'call' || edge.label === 'action' || edge.label === 'trpc') project.add(JSON.stringify([edge.to, edge.detail]));
        const target = this.file(edge.to);
        const name = this.name(edge.to);
        const label = edge.label === 'fetch' ? `${edge.method} ${edge.url}` : edge.detail?.startsWith('.') ? name + edge.detail : name;
        if (!hub) {
          const lines = [...new Set(sites.map(site => site.line))];
          const site = (d === 1 && edge.file === file ? '' : edge.file) + ':' + lines.slice(0, 3).join(',') +
            (lines.length > 3 ? ` +${lines.length - 3}` : '');
          const flags = (edge.label === 'action' ? ' [action]' : '') + (sites.some(site => site.conditional) ? ' [cond]' : '') +
            (sites.some(site => site.partial) ? ' [partial url]' : '') + (edge.from === edge.to ? ' [self]' : '') +
            (!isTestFile(file) && isTestFile(target) ? ' [test]' : '');
          rows.push(graphRow(`d${d} ${edge.label} ${site}  ${label}  ${target}` +
            (edge.detail?.startsWith('.') ? `#${name}` : edge.label === 'trpc' ? `:${this.symbols.get(Number(edge.to))?.line} (${edge.detail})` :
              edge.label === 'fetch' ? ` (${edge.detail})` : '') + flags + parent, file, target));
        }
        if (seen.has(edge.to)) continue;
        if (seen.size >= nodeBudget) {
          budget = true;
          continue;
        }
        seen.add(edge.to);
        pending.push({ id: edge.to, depth: d });
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
      if (typeof current.id === 'number') unresolved += this.index.unresolvedCalls![current.id] ?? 0;
    }
    const callers = new Set(this.predecessors(seed).filter(edge => edge.from !== seed && !isTestFile(edge.file)).map(edge => edge.file));
    if (rows.length) notes.push(graphRow(`# source: ${this.file(seed)} (unqualified first-hop sites)`, this.file(seed)));
    notes.push(graphRow(`# callers: ${callers.size} (impact for routes)`));
    const partial = [budget ? 'node budget' : trpc,
      unresolved ? `${quantity(unresolved, 'unresolved call')} on local variables or parameters` : undefined,
      uncertain ? AI_SDK_URL_OVERRIDE : undefined].filter(Boolean).join('; ');
    return { rows, notes, count: `${project.size} project calls, ${renders.size} renders, ${fetches.size} fetches, ${packages.size} packages` +
      (collapsed ? ', hub collapsed' : ''), partial: partial || undefined,
    scope: `indexed calls, renders, fetches, package calls${uses ? ', uses' : ''} (depth ${depth})` };
  }
}
