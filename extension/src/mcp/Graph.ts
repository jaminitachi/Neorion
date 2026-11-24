import { GRAPH_INDEX_REVISION, GraphReferenceKind, isTestFile, type ExternalCall, type QueryIndex, type ServerAction, type SymbolEntry } from './Index';

type Route = QueryIndex['routes'][number];
type NodeId = number | string;
type Label = 'call' | 'action' | 'render' | 'fetch' | 'dyn' | 'use';
type Edge = {
  from: NodeId; to: NodeId; label: Label; file: string; line: number;
  detail?: string; conditional?: boolean; partial?: boolean;
};
type PathEdge = Omit<Edge, 'label'> & { label: Label | 'wrap' };
type Visit = { depth: number; edge?: Edge; conditional?: boolean; via?: string[] };
export type QueryRow = { text: string; files: string[]; pathEnd?: number };
export type QueryResult = {
  rows: QueryRow[]; title?: string; count?: string; targets?: string[];
  notes?: QueryRow[]; limit?: number; partial?: string; scope?: string;
};
export type Terminal = { kind: string; name: string; file: string; line?: number; route?: Route; pages?: Route[]; handler?: number };
type Reached = { terminal: Terminal; visit: Visit; node: NodeId; metadata: boolean };
const rank: Record<Label, number> = { call: 0, action: 1, render: 2, fetch: 3, dyn: 4, use: 5 };
const outgoingRank: Record<Label, number> = { render: 0, call: 1, action: 1, fetch: 2, dyn: 3, use: 4 };
const nodeBudget = 5000;
const hubSize = 30;
const fetchTypes = new Set(['fetch', 'SWR key', 'axios']);
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const graphRow = (text: string, ...files: string[]): QueryRow => ({ text, files });
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
    !!(index.routeFiles && index.defaultSymbols && index.unresolvedCalls && index.graphReferences);
}

export class DependencyGraph {
  private symbols: Map<number, SymbolEntry>;
  private files = new Map<number, string>();
  private fileIds = new Map<string, number>();
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
  private fetches = new Map<string, QueryIndex['fetches']>();

  constructor(private index: QueryIndex, symbols: Map<number, SymbolEntry>) {
    this.symbols = symbols;
    this.trpc = new Set(index.trpcFiles);
    Object.keys(index.files).forEach((file, offset) => {
      const id = index.fileSymbols![offset];
      this.files.set(id, file);
      this.fileIds.set(file, id);
    });
    for (const symbol of symbols.values()) append(this.symbolsByFile, symbol.file, symbol);

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
    for (const [file, [kind, url, matcher, component]] of Object.entries(index.routeFiles!)) {
      const directory = file.slice(0, file.lastIndexOf('/') + 1);
      const wrapped = kind === 'app-shell' ? pages.filter(page => /^(?:src\/)?pages\//.test(page.file)) :
        kind === 'layout' || kind === 'template' ? pages.filter(page =>
          page.file.startsWith(directory) || page.layouts?.some(id => this.file(id) === file)) : undefined;
      const terminal = { kind, name: matcher ?? url, file, pages: wrapped };
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
    const add = (edge: Edge) => {
      const key = JSON.stringify([edge.from, edge.to, edge.label, edge.file, edge.line, edge.detail ?? '']);
      if (edges.has(key)) return;
      edges.add(key);
      append(this.incoming, edge.to, edge);
      append(this.outgoing, edge.from, edge);
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
        line: fetch.line, detail: fetch.via, partial: fetch.partial || fetch.dynamic });
    }
    for (const call of index.externalCalls!) append(this.external, call[0], call);
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

  fileSeeds(file: string): NodeId[] {
    if (!this.index.files[file] && !this.routesByFile.has(file)) return [];
    return [this.fileNode(file), ...(this.symbolsByFile.get(file) ?? []).filter(symbol => !symbol.typeOnly).map(symbol => symbol.id)];
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

  traceImpact(seeds: NodeId[], depth: number, includeTests: boolean, expired: () => boolean) {
    const visited = new Map<NodeId, Visit>();
    const levels: NodeId[][] = [];
    const tests = new Set<string>();
    const boundary = new Set<NodeId>();
    const hubs: QueryRow[] = [];
    const hidden = new Set<NodeId>();
    const terminals = new Map<string, Reached>();
    let nodeLimited = false;
    let trpc: SymbolEntry | undefined;
    const uncertain = new Set<string>();
    const literals = new Set<string>();
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
        for (const terminal of this.terminals(id)) {
          const key = terminalKey(terminal);
          const earlier = terminals.get(key);
          const metadata = terminal.kind === 'page' && this.name(id) === 'generateMetadata';
          if (!earlier || metadata && earlier.visit.depth === level) {
            terminals.set(key, { terminal, visit: earlier?.visit ?? current, node: earlier?.node ?? id, metadata });
          }
          if (terminal.kind === 'api') for (const fetch of this.fetches.get(terminal.file) ?? []) {
            if (fetch.dynamic || fetch.partial) uncertain.add(fetch.file);
            if (fetch.via === 'route literal') literals.add(fetch.file);
          }
        }
        const edges = this.predecessors(id);
        const additions = new Map<NodeId, Edge>();
        for (const edge of edges) {
          if (edge.from === id || visited.has(edge.from)) continue;
          if (!includeTests && isTestFile(edge.file)) {
            tests.add(edge.file);
            continue;
          }
          if (level >= depth && edge.label !== 'render') {
            if (level === depth) boundary.add(edge.from);
            continue;
          }
          if (!additions.has(edge.from)) additions.set(edge.from, edge);
        }
        if (!additions.size && typeof id === 'number' && this.trpc.has(this.file(id))) trpc ??= this.symbols.get(id);
        if (additions.size > hubSize && level < depth) {
          const files = [...new Set([...additions.values()].map(edge => edge.file))].sort(compare);
          const label = additions.values().next().value!.label;
          hubs.push(graphRow(`d${level + 1} ${label}  ${additions.size} callers in ${files.length} files (top: ${files.slice(0, 3).join(', ')})`, ...files.slice(0, 3)));
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
    const partial = nodeLimited ? 'node budget' :
      unexplored ? `depth limit (${unexplored} unexplored callers at d=${depth}${depth < 6 ? `; rerun --depth ${Math.min(6, depth + 2)}` : ''})` :
      trpc ? `tRPC client proxy not traced (procedure ${location(trpc.file, trpc.line)})` :
      uncertain.size ? 'dynamic URL fetch' : undefined;
    return { visited, terminals: [...terminals.values()].sort(terminalOrder), tests, hidden, hubs, partial, literals };
  }

  terminalRows(reached: Reached[], limit: number): QueryRow[] {
    const rows: QueryRow[] = [];
    const directPages = reached.filter(entry => entry.terminal.kind === 'page');
    const groupPages = directPages.length > 15 && limit <= 40;
    const groups = new Map<string, Route[]>();
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
        rows.push(graphRow(`${kind} ${file}  wraps ${pages.length} ${kind === 'app-shell' ? 'pages ' : ''}routes${this.pageList(pages, limit)}${suffix}`, file));
      } else if (kind === 'middleware') {
        rows.push(graphRow(`middleware ${file}  all matched routes${name === '/' ? '' : ` (matcher: ${name})`}${suffix}`, file));
      } else {
        const label = kind === 'sitemap' || kind === 'robots' || kind === 'opengraph-image' ? `meta ${kind}` :
          kind === 'page' || kind === 'api' || kind === 'action' ? kind : `special ${kind}`;
        rows.push(graphRow(`${label} ${name}  ${location(file, kind === 'api' ? undefined : line)}${suffix}`, file));
      }
    }
    for (const [layout, routes] of groups) {
      rows.push(graphRow(`group ${layout} : ${routes.length} routes${this.pageList(routes, limit)}`, layout));
    }
    return rows;
  }

  private pageList(pages: Route[], limit: number) {
    const count = limit > 40 ? pages.length : pages.length <= 5 ? pages.length : 3;
    if (!count) return '';
    const urls = [...pages].sort((a, b) => compare(a.url, b.url)).slice(0, count).map(page => page.url);
    return ` (${urls.join(', ')}${pages.length > count ? ', +' + (pages.length - count) : ''})`;
  }

  impact(seeds: NodeId[], depth: number, includeTests: boolean, limit: number, expired: () => boolean): QueryResult {
    const trace = this.traceImpact(seeds, depth, includeTests, expired);
    const rows = this.terminalRows([
      ...trace.terminals.filter(entry => entry.terminal.kind !== 'action'),
      ...trace.terminals.filter(entry => entry.terminal.kind === 'action')
    ], limit);
    const notes: QueryRow[] = [];
    const pageIds = new Set<number>();
    const apiFiles = new Set<string>();
    let actions = 0;
    let layouts = 0;
    let other = 0;
    for (const { terminal } of trace.terminals) {
      if (terminal.kind === 'api') apiFiles.add(terminal.file);
      else if (terminal.kind === 'action') actions++;
      else if (terminal.pages) {
        layouts++;
        for (const page of terminal.pages) pageIds.add(page.id);
      } else if (terminal.route) pageIds.add(terminal.route.id);
      else if (terminal.kind !== 'middleware') other++;
    }
    const routeCount = pageIds.size + apiFiles.size + other;
    const groups = new Map<string, { id: NodeId; visit: Visit; edge: Edge }[]>();
    const files = new Set<string>();
    let symbols = 0;
    let used = 0;
    for (const [id, visit] of trace.visited) {
      if (!visit.edge || visit.depth > depth) continue;
      used = Math.max(used, visit.depth);
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
      const label = names.length === 1 && names[0] === 'module' ? 'module' : edge.label;
      const flags = (items.some(item => item.visit.conditional) ? ' [cond]' : '') +
        (items.some(item => this.action(item.id)) ? ' [action]' : '') +
        (items.some(item => item.edge.partial) ? ' [partial url]' : '') + (isTestFile(edge.file) ? ' [test]' : '');
      const chain = visit.depth === 1 && seeds.length === 1 ? '' : ` < ${via.join(', ')}`;
      rows.push(graphRow(`d${visit.depth} ${label} ${edge.file}:${lines.slice(0, 5).join(',')}` +
        `${lines.length > 5 ? '+' + (lines.length - 5) : ''} ${names.join(', ')}${chain}${flags}`, edge.file));
    }
    if (trace.tests.size) notes.push(graphRow(`# tests: ${trace.tests.size} ${trace.tests.size === 1 ? 'file reaches' : 'files reach'} target (includeTests to list)`));
    if (trace.literals.size) notes.push(graphRow(`# also referenced as literal: ${trace.literals.size} files`));
    notes.push(graphRow(`# risk: ${routeCount} routes (${pageIds.size} page, ${apiFiles.size} api${other ? `, ${other} meta or special` : ''}), ` +
      `${actions} server action${actions === 1 ? '' : 's'}, ${layouts} layouts; ${symbols} symbols in ${files.size} files; max depth ${used}; ${trace.tests.size} tests`));
    return { rows, notes, count: `${routeCount} routes, ${actions} ${actions === 1 ? 'action' : 'actions'}, ${symbols} symbols, depth ${used}` +
      (trace.hubs.length ? ', hub collapsed' : ''), partial: trace.partial, scope: 'indexed call, render, action, use, dyn, fetch edges' };
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
    type Step = { id: NodeId; depth: number; weak: number; previous?: Step; edge?: PathEdge; alternatives: number; alternate?: Step };
    const depthBudget = 12;
    const targets = new Set(goals);
    const initial = starts.map(id => ({ id, depth: 0, weak: 0, alternatives: 0 }));
    let layer: Step[] = initial;
    const seen = new Set(starts);
    let goal: Step | undefined;
    let partial: string | undefined;
    const wraps: PathEdge[] = [];
    if (route) for (const [file, terminals] of this.routesByFile) {
      if (!terminals.some(terminal => terminal.pages?.includes(route))) continue;
      const id = this.index.routeFiles![file]?.[3] ?? this.defaultSymbol(file)?.id ?? this.fileNode(file);
      const line = typeof id === 'number' ? this.symbols.get(id)?.line ?? 1 : 1;
      wraps.push({ from: starts[0], to: id, label: 'wrap', file, line });
    }
    const stepOrder = (a: Step, b: Step) => a.weak - b.weak ||
      (a.edge && b.edge ? pathEdgeOrder(a.edge, b.edge) : 0) || compare(this.file(a.id), this.file(b.id)) ||
      compare(this.name(a.id), this.name(b.id));
    const alternatives = (chosen: Step, alternate: Step) => {
      if (alternate.previous?.id !== chosen.previous?.id || (alternate.id !== chosen.id && alternate.edge !== chosen.edge)) {
        chosen.alternatives += 1;
        chosen.alternate ??= alternate.previous ?? alternate;
      }
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
              previous: current, edge, alternatives: 0
            };
            const earlier = next.get(id);
            if (!earlier && seen.size + next.size >= nodeBudget) {
              partial = 'node budget';
              continue;
            }
            if (!earlier) next.set(id, candidate);
            else if (stepOrder(candidate, earlier) < 0) {
              candidate.alternatives = earlier.alternatives;
              candidate.alternate = earlier.alternate;
              alternatives(candidate, earlier);
              next.set(id, candidate);
            } else alternatives(earlier, candidate);
          }
        }
      }
      layer = [...next.values()];
      for (const step of layer) seen.add(step.id);
    }

    const scope = 'over indexed render, call, action, fetch, dyn, use and wrap edges';
    if (!goal) {
      const trace = this.traceImpact(goals, 6, false, expired);
      const pages = new Set(trace.terminals.flatMap(({ terminal }) => terminal.kind === 'page' ? [terminal.name] :
        terminal.pages?.map(page => page.url) ?? []));
      const notes = [graphRow(`# from reaches ${seen.size} nodes` +
        (pages.size ? `; to is reached from routes: ${[...pages].slice(0, 5).join(', ')}${pages.size > 5 ? ', +' + (pages.size - 5) : ''}` : ''))];
      const boundary = trace.partial?.startsWith('tRPC client proxy') ? trace.partial : undefined;
      return { rows: [], notes, count: 'no directed path', partial: partial ?? boundary,
        scope: 'no directed path ' + scope };
    }

    const rows: QueryRow[] = [];
    for (let step = goal; step.edge && step.previous; step = step.previous) {
      const edge = step.edge;
      const file = this.file(step.id);
      const symbol = typeof step.id === 'number' ? this.symbols.get(step.id) : undefined;
      const name = edge.label === 'fetch' ? this.name(edge.to) + (symbol ? ' (' + symbol.name + ')' : '') :
        this.name(step.id) + (edge.detail?.startsWith('.') ? edge.detail : '');
      rows.unshift(graphRow(`${step.depth} ${edge.label} ${location(edge.file, edge.line)} ${name}` +
        (step === goal && file !== edge.file ? ' -> ' + location(file, symbol?.line) : '') +
        (edge.conditional ? ' [cond]' : '') + (edge.partial ? ' [partial url]' : ''), edge.file, file));
    }
    let origin = goal;
    while (origin.previous) origin = origin.previous;
    const symbol = typeof origin.id === 'number' ? this.symbols.get(origin.id) : undefined;
    if (route) rows.unshift(graphRow(`0 route ${route.url}  ${location(route.file, route.line)} ${this.name(starts[0])}`, route.file));
    else rows.unshift(graphRow(`0 ${symbol?.kind ?? 'module'} ${location(this.file(origin.id), symbol?.line)} ${this.name(origin.id)}`, this.file(origin.id)));
    const notes = goal.alternatives && goal.alternate ? [graphRow(`# alternatives: ${goal.alternatives} other shortest ` +
      `predecessor${goal.alternatives === 1 ? '' : 's'} (via ${this.name(goal.alternate.id)})`)] : [];
    return { rows, notes, count: `${goal.depth} ${goal.depth === 1 ? 'hop' : 'hops'}`, partial,
      scope: 'shortest directed path ' + scope };
  }

  neighbors(id: number, expired: () => boolean): QueryRow {
    const callers = new Set(this.predecessors(id).filter(edge => edge.from !== id && !isTestFile(edge.file)).map(edge => edge.file));
    const callees = new Set((this.outgoing.get(id) ?? []).filter(edge => edge.label !== 'use' && edge.to !== id).map(edge => edge.to));
    const trace = this.traceImpact([id], 3, false, expired);
    const routes = new Set(trace.terminals.flatMap(({ terminal }) => terminal.pages?.map(route => route.file) ??
      (terminal.kind === 'action' || terminal.kind === 'middleware' ? [] : [terminal.file])));
    return graphRow(`# neighbors: ${callers.size} caller ${callers.size === 1 ? 'file' : 'files'}, ${callees.size} callees, reaches ${routes.size} routes` +
      (this.action(id) ? '; server action' : '') + '. Next: impact | callees');
  }

  callees(seed: number, depth: number, uses: boolean, expired: () => boolean): QueryResult {
    const seen = new Set<NodeId>([seed]);
    const pending = [{ id: seed as NodeId, depth: 0 }];
    const rows: QueryRow[] = [];
    const packages = new Set<string>();
    const notes: QueryRow[] = [];
    let project = 0;
    let renders = 0;
    let fetches = 0;
    let unresolved = 0;
    let collapsed = false;
    let budget = false;
    for (let i = 0; i < pending.length && !expired(); i++) {
      const current = pending[i];
      if (current.depth >= depth) break;
      const d = current.depth + 1;
      const file = this.file(current.id);
      const parent = d > 1 ? ` < ${this.name(current.id)}` : '';
      const edges = (this.outgoing.get(current.id) ?? []).filter(edge => uses || edge.label !== 'use').sort((a, b) =>
        outgoingRank[a.label] - outgoingRank[b.label] || a.line - b.line || edgeOrder(a, b));
      const neighbours = new Set(edges.map(edge => edge.to));
      const hub = neighbours.size > hubSize;
      if (hub) {
        const files = [...new Set([...neighbours].map(id => this.file(id)))].sort(compare);
        rows.push(graphRow(`d${d} ${neighbours.size} callees in ${files.length} files (top: ${files.slice(0, 3).join(', ')})${parent}`, ...files.slice(0, 3)));
        collapsed = true;
      }
      for (const edge of edges) {
        if (expired()) break;
        if (edge.label === 'render') renders++;
        else if (edge.label === 'fetch') fetches++;
        else if (edge.label === 'call' || edge.label === 'action') project++;
        const target = this.file(edge.to);
        const name = this.name(edge.to);
        const label = edge.detail?.startsWith('.') ? name + edge.detail : name;
        const site = (d === 1 && edge.file === file ? '' : edge.file) + ':' + edge.line;
        const flags = (edge.label === 'action' ? ' [action]' : '') + (edge.conditional ? ' [cond]' : '') +
          (edge.partial ? ' [partial url]' : '') + (edge.from === edge.to ? ' [self]' : '') +
          (!isTestFile(file) && isTestFile(target) ? ' [test]' : '');
        if (!hub) rows.push(graphRow(`d${d} ${edge.label} ${site}  ${label}  ${target}` +
          (edge.detail?.startsWith('.') ? `#${name}` : edge.label === 'fetch' ? ` (${edge.detail})` : '') + flags + parent, file, target));
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
    if (unresolved) notes.push(graphRow(`# unresolved: ${unresolved} calls on locals/params`));
    const callers = new Set(this.predecessors(seed).filter(edge => edge.from !== seed && !isTestFile(edge.file)).map(edge => edge.file));
    notes.push(graphRow(`# callers: ${callers.size} (impact for routes)`));
    return { rows, notes, count: `${project} project calls, ${renders} renders, ${fetches} fetches, ${packages.size} packages` +
      (collapsed ? ', hub collapsed' : ''), partial: budget ? 'node budget' : undefined,
    scope: `indexed calls, renders, fetches, package calls${uses ? ', uses' : ''} (depth ${depth})` };
  }
}
