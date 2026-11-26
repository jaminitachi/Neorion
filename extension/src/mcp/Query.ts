import { matchNextRoutes, normalizeNextUrl, routeSegments, segmentRank } from '../core/analyzers/NextRouteMatch';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AI_SDK_TRANSPORT, transportIssue, GRAPH_INDEX_REVISION, INDEX_SCHEMA, QUERY_INDEX_REVISION, TRANSPORT_QUERY_REVISION,
  isTestFile as testFile, renderIssue, renderSiteKey,
  type FetchEntry, type QueryIndex, type Reference, type ServerAction, type SymbolEntry } from './Index';
import { legacyKind, legacyTargets, kinds, queryName, tools, type QueryKind } from './Tools';
import { DependencyGraph, hasGraph, type QueryResult as Result, type QueryRow as Row } from './Graph';
import { unpackGraph } from './GraphStorage';
import { changes, validBase, type ChangeScope } from './Changes';
import { historyBudgetMs } from './ChangesHistory';

type Route = QueryIndex['routes'][number];
type Edge = QueryIndex['renderEdges'][number];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const actionShortName = (name: string) => name.slice(name.lastIndexOf('.') + 1);
const actionLocation = (action: ServerAction) => `${location(action.file, action.line)}#${action.name}`;
const bytes = (text: string) => Buffer.byteLength(text);
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ');
const row = (text: string, ...files: string[]): Row => ({ text, files });
const location = (file: string, line: number) => `${file}:${line}`;
const declaration = (symbol: SymbolEntry) => `${location(symbol.file, symbol.line)}#${symbol.name}`;
const bySymbol = (a: SymbolEntry, b: SymbolEntry) => compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name);
const byRoute = (a: Route, b: Route) => compare(a.url, b.url) || compare(a.file, b.file);
const flagTest = (file: string) => testFile(file) ? ' [test]' : '';
const generatedFile = (file: string) =>
  /(?:^|\/)(?:generated|__generated__)\/|\.generated\.[^/]+$|\.gen\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/.test(file);
const apiEvidence = new Map([
  ['SWR key', 'read'], ['SWR mutate', 'mutate'], ['SWR fallback key', 'fallback key'],
  ['fetch', 'request'], ['axios', 'request'], ['Playwright request', 'request'], ['tRPC request', 'request'],
  [AI_SDK_TRANSPORT, 'request']
]);
const shellArg = (value: string) => /^[\w./:-]+$/.test(value) ? value : process.platform === 'win32'
  ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'";
type CliReplay = { invocation: string[]; root: string };
const dynamicRenderReason = 'rendered through a dynamic reference';

function queryCommand(cli: CliReplay, kind: QueryKind, targets: string[], options: string[]) {
  const flags = [...options, '--root', cli.root].map(shellArg);
  const positionals = targets.map(shellArg);
  return [...cli.invocation.map(shellArg), 'query', ...(targets.some(target => target.startsWith('-'))
    ? [...flags, '--', kind, ...positionals] : [kind, ...positionals, ...flags])].join(' ');
}

function retryHint(cli: CliReplay | undefined, kind: 'search' | 'wrappers', target: string, options: {
  filter?: string; includeExternal?: boolean; limit?: number; targetKey?: string;
} = {}) {
  const { filter, includeExternal, limit, targetKey = 'target' } = options;
  if (!cli) {
    const params = { kind, target, ...(filter ? { filter } : {}) };
    return kind === 'search' ? `# try: call ${queryName} with ${JSON.stringify(params)}` :
      `# try: set ${targetKey}=${JSON.stringify(target)} on the same request and keep the other arguments`;
  }
  const flags = [...(filter ? ['--kind', filter] : []), ...(includeExternal === false ? ['--no-external'] : []),
    ...(limit !== undefined && limit !== 40 ? ['--limit', String(limit)] : [])];
  const command = queryCommand(cli, kind, [target], flags);
  if (bytes(command) <= 370 && oneLine(command) === command) return `# try: ${command}`;
  return kind === 'search' ? `# try: use the same CLI invocation and project root to search for ${shellArg(target)}` +
    (filter ? ` with --kind ${filter}` : '') : `# try: replace the target in the original command with ${shellArg(target)}`;
}

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export function validRelative(file: string) {
  return !!file && !/[\\\x00-\x1f]/.test(file) && !path.posix.isAbsolute(file) && !path.win32.isAbsolute(file) &&
    !file.split('/').includes('..');
}

function group<K, V>(values: V[], key: (value: V) => K): Map<K, V[]> {
  const result = new Map<K, V[]>();
  for (const value of values) {
    const id = key(value);
    const list = result.get(id);
    if (list) list.push(value);
    else result.set(id, [value]);
  }
  return result;
}

function validate(name: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an arguments object.');
  const input = value as Record<string, unknown>;
  const legacy = legacyKind(name);
  const tool = (legacy ?? input.kind) as QueryKind;
  if ((!legacy && name !== queryName) || !kinds.includes(tool)) throw new Error('Invalid query kind.');
  const targetKey = legacy ? legacyTargets[legacy] : 'target';
  const filterKey = legacy ? 'kind' : 'filter';
  const options = {
    who_renders: ['direct'], wrappers: ['includeExternal'], rename_impact: ['includeTests'],
    api_consumers: ['callers', 'includeTests'], search: [filterKey],
    impact: ['depth', 'includeTests'], callees: ['depth', 'uses'], path: ['to'], changes: ['scope', 'base', 'depth']
  }[tool];
  for (const key of Object.keys(input)) {
    if (![...(tool === 'changes' ? [] : [targetKey]), 'limit', ...options, ...(!legacy ? ['kind'] : [])].includes(key)) {
      throw new Error(`Unexpected argument ${oneLine(key).slice(0, 80)}.`);
    }
  }
  const target = typeof input[targetKey] === 'string' ? (input[targetKey] as string).trim() : '';
  const routeList = tool === 'search' && target === '/' && ['route', 'api'].some(filter => filter === input[filterKey]);
  if (tool !== 'changes' && ([...target].length < (tool === 'search' && !routeList ? 2 : 1) ||
      [...target].length > (tool === 'search' ? 200 : 300))) {
    throw new Error('Invalid query target.');
  }
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  if (tool === 'path' && (!to || [...to].length > 300)) throw new Error('Invalid argument to.');
  const { scope = 'all', base } = input;
  if (scope !== 'all' && scope !== 'staged' && scope !== 'unstaged') throw new Error('Invalid argument scope.');
  if (base !== undefined && !validBase(base)) throw new Error('Invalid argument base.');
  if (base !== undefined && scope !== 'all') throw new Error('Choose either base or staged/unstaged scope.');
  const { limit = tool === 'search' ? 20 : 40, callers = 1, direct = false, depth = tool === 'callees' ? 1 : 3, uses = false,
    includeExternal = true, includeTests = tool === 'rename_impact' || (!legacy && tool === 'api_consumers'), [filterKey]: rawFilter } = input;
  const filter = tool === 'search' ? rawFilter ?? 'any' : 'any';
  const integerInRange = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  if (!integerInRange(limit, 1, tool === 'search' ? 50 : 100)) throw new Error('Invalid argument limit.');
  if (!integerInRange(callers, 0, 2)) throw new Error('Invalid argument callers.');
  if (!integerInRange(depth, 1, tool === 'callees' ? 3 : 6)) throw new Error('Invalid argument depth.');
  if (tool === 'search' && ((rawFilter === null) || typeof filter !== 'string' ||
      !tools[0].inputSchema.properties.filter.enum.includes(filter))) throw new Error('Invalid search filter.');
  for (const key of ['direct', 'includeExternal', 'includeTests', 'uses']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Invalid argument ${key}.`);
  }
  return { tool, target, to, limit, callers, direct, includeExternal, includeTests, filter: String(filter), depth,
    uses: !!uses, scope: scope as ChangeScope, base };
}

function limitHint(args: ReturnType<typeof validate>, count: number, cli?: CliReplay, mcpFilterKey = 'filter', suggestedFilter?: string) {
  const { tool, target, to, depth, uses, scope, base, filter, includeTests, includeExternal } = args;
  const limit = Math.min(count, tool === 'search' ? 50 : 100);
  let narrow = '';
  if (tool === 'search') {
    narrow = 'narrow the text';
    if (filter === 'any' && suggestedFilter) narrow += cli ?
      ` or use --kind ${suggestedFilter}` : ` or set ${mcpFilterKey}=${JSON.stringify(suggestedFilter)}`;
  } else if (tool === 'changes') {
    narrow = 'narrow the diff';
  } else if (tool === 'callees' && depth > 1) {
    narrow = cli ? 'use --depth 1 to narrow' : 'set depth=1 to narrow';
  }
  if (!cli) {
    return args.limit < limit ? `set limit=${limit} on the same request and keep the other arguments${narrow ? `, or ${narrow}` : ''}` :
      narrow || 'only the rows within the output cap can be shown';
  }
  if (args.limit >= limit) return narrow || 'only the rows within the output cap can be shown';
  const options = [
    ...(tool === 'search' && filter !== 'any' ? ['--kind', filter] : []),
    ...(tool === 'impact' || tool === 'callees' || tool === 'changes' ? ['--depth', String(depth)] : []),
    ...((tool === 'impact' || tool === 'api_consumers' || tool === 'rename_impact') && includeTests ? ['--include-tests'] : []),
    ...(tool === 'callees' && uses ? ['--uses'] : []),
    ...(tool === 'wrappers' && !includeExternal ? ['--no-external'] : []),
    ...(tool === 'changes' && scope !== 'all' ? [`--${scope}`] : []),
    ...(base === undefined ? [] : ['--base', String(base)]),
    '--limit', String(limit)
  ];
  const command = queryCommand(cli, tool, [target, to].filter(Boolean), options);
  const hint = `try ${command}${narrow ? `, or ${narrow}` : ''}`;
  return bytes(hint) <= 380 && oneLine(hint) === hint ? hint : `set --limit ${limit} in the original command`;
}

function takeBytes(text: string, cap: number, tail = false) {
  const characters = [...text];
  if (tail) characters.reverse();
  let length = 0;
  const kept = [];
  for (const character of characters) {
    length += bytes(character);
    if (length > cap) break;
    kept.push(character);
  }
  return (tail ? kept.reverse() : kept).join('');
}

function shorten(text: string, preserve = 0, cap = 400) {
  text = oneLine(text);
  if (bytes(text) <= cap) return text;
  const prefix = text.slice(0, preserve);
  const budget = cap - 3 - bytes(prefix);
  if (budget < 8) return undefined;
  const left = Math.floor(budget / 2);
  return prefix + takeBytes(text.slice(preserve), left) + '...' + takeBytes(text.slice(preserve), budget - left, true);
}

function distance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) current.push(Math.min(
      previous[j + 1] + 1, current[j] + 1, previous[j] + Number(a[i] !== b[j])
    ));
    previous = current;
  }
  return previous[b.length];
}

export class QueryEngine {
  private root: string;
  private symbols: Map<number, SymbolEntry>;
  private names: Map<string, SymbolEntry[]>;
  private incoming: Map<number, Edge[]>;
  private dynamicRenderComponents: Set<number>;
  private references: Map<number, Reference[]>;
  private fetches: Map<number, FetchEntry[]>;
  private pageRoots = new Map<number, { route: Route; layout: boolean }[]>();
  private dependencyGraph?: DependencyGraph | null;

  constructor(root: string, private index: QueryIndex) {
    this.root = realpathSync(root);
    this.symbols = new Map(index.symbols.map(symbol => [symbol.id, symbol]));
    this.names = group(index.symbols, symbol => symbol.name);
    this.incoming = group(index.renderEdges, edge => edge[1]);
    this.dynamicRenderComponents = new Set(index.dynamicRenderComponents);
    for (const edges of this.incoming.values()) edges.sort((a, b) => {
      const left = this.symbols.get(a[0]);
      const right = this.symbols.get(b[0]);
      return compare(left?.file ?? '', right?.file ?? '') || compare(left?.name ?? '', right?.name ?? '') ||
        Number(!!a[5]) - Number(!!b[5]) || a[3] - b[3] || a[2] - b[2] || a[0] - b[0];
    });
    const paths = Object.keys(index.files);
    const references = index.references.map((reference): Reference => {
      const [id, file, ...site] = reference;
      if (typeof file === 'string') return reference as Reference;
      return [id, typeof file === 'number' ? paths[file] : this.symbols.get(id)?.file ?? '', ...site];
    });
    this.references = group(references, reference => reference[0]);
    this.fetches = group(index.fetches, fetch => fetch.route);
    for (const route of index.routes) {
      if (route.kind !== 'page') continue;
      const add = (id: number | undefined, layout: boolean) => {
        if (id === undefined) return;
        const entries = this.pageRoots.get(id) ?? [];
        entries.push({ route, layout });
        this.pageRoots.set(id, entries);
      };
      add(route.component, false);
      add(route.fileSymbol, false);
      for (const layout of route.layouts ?? []) add(layout, true);
    }
  }

  private checkPath(file: string) {
    if (!validRelative(file)) throw new Error('Use an app-relative path within the Neorion root.');
    const absolute = path.join(this.root, file);
    // Also reject links in an existing ancestor when the requested leaf is absent.
    for (let candidate = absolute; candidate !== this.root; candidate = path.dirname(candidate)) {
      try {
        if (!inside(this.root, realpathSync(candidate))) throw new Error('Path is outside the Neorion root.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
        if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
          throw new Error('Cannot resolve a symbolic link within the Neorion root.');
        }
      }
    }
    return absolute;
  }

  private symbolTarget(text: string) {
    const delimiter = text.lastIndexOf('#');
    const file = delimiter < 0 ? undefined : path.posix.normalize(text.slice(0, delimiter));
    if (file !== undefined) this.checkPath(text.slice(0, delimiter));
    else if (/[\\/]/.test(text) && !this.names.get(text)?.some(symbol => symbol.synthetic)) {
      throw new Error('Use a name or an app-relative path#Name.');
    }
    return { file, name: text.slice(delimiter + 1) };
  }

  private matchSymbol(text: string) {
    const { file, name } = this.symbolTarget(text);
    return (this.names.get(name) ?? [])
      .filter(symbol => file === undefined || symbol.file === file).sort(bySymbol);
  }

  private matchRoute(text: string, kind?: string, concrete = !!this.index.pagesUrlConfig) {
    const routes = this.index.routes.filter(route => !kind || route.kind === kind);
    if (/^route:(?:src\/)?(?:app|pages)\//.test(text)) text = text.slice(6);
    if (!text.startsWith('/')) {
      this.checkPath(text);
      return routes.filter(route => route.file === path.posix.normalize(text)).sort(byRoute);
    }
    if (/^\/\/|^\/(?:[^/]+\/)*\.\.(?:\/|$)|\\/.test(text)) throw new Error('Invalid route URL pattern.');
    const exact = routes.filter(route => route.url === (text.replace(/\/$/, '') || '/'));
    if (exact.length) return exact.sort(byRoute);
    if (/\.[cm]?[jt]sx?$/.test(text) && !concrete) throw new Error('Use an app-relative route file path.');
    return concrete ? matchNextRoutes(text, routes, route => route.url, this.index.pagesUrlConfig).sort(byRoute) : [];
  }

  private suggestions(text: string, kind: string | undefined, expired: () => boolean, file?: string, includeSynthetic = true): Row[] {
    const needle = text.toLowerCase().slice(0, 100);
    const candidates: { name: string; label: string; file: string; line?: number; aliases?: string[] }[] = kind === 'page' || kind === 'api'
      ? this.index.routes.filter(route => route.kind === kind).map(route =>
        ({ name: route.url, label: `${route.url} ${location(route.file, route.line ?? 1)}`, file: route.file }))
      : kind === 'action'
        ? (this.index.serverActions ?? []).filter(action => file === undefined || file === action.file).map(action => ({
          name: action.name, aliases: [...(action.aliases ?? []), actionShortName(action.name)],
          label: `${action.file}#${action.name}`, file: action.file, line: action.line
        }))
        : this.index.symbols.filter(symbol => (includeSynthetic || !symbol.synthetic) && (file === undefined || symbol.file === file) &&
          (!kind || (kind === 'renderer' ? ['component', 'procedure'].includes(symbol.kind) : symbol.kind === kind))).map(symbol =>
        ({ name: symbol.name, label: `${symbol.file}#${symbol.name}`, file: symbol.file, line: symbol.line }));
    const matches: (typeof candidates[number] & { score: number })[] = [];
    const threshold = Math.max(2, Math.floor(needle.length / 3));
    for (const candidate of candidates) {
      if (expired()) break;
      const names = [candidate.name, ...(candidate.aliases ?? [])];
      let score = threshold + 1;
      for (const value of names) {
        const name = value.toLowerCase().slice(0, 100);
        if (kind && needle.length >= 2 && (name.startsWith(needle) ||
          ((kind === 'page' || kind === 'api') && name.endsWith(needle) && needle.startsWith('/')))) {
          score = Math.min(score, name === needle ? -2 : -1);
        }
        if (Math.abs(name.length - needle.length) <= threshold) score = Math.min(score, distance(needle, name));
      }
      if (score <= threshold) matches.push({ ...candidate, score });
    }
    return matches.sort((a, b) => a.score - b.score || compare(a.label, b.label)).slice(0, 5)
      .map(candidate => {
        const text = `# did you mean: ${candidate.label}`;
        return { ...row(text + (candidate.line === undefined ? '' : ` (declared at line ${candidate.line})`), candidate.file), pathEnd: text.length };
      });
  }

  private search(text: string, kind: string, expired: () => boolean): Result {
    const needle = text.toLowerCase();
    const hits: { row: Row; score: number; references: number; file: string; kind: string; symbol?: SymbolEntry }[] = [];
    const match = (text: string) => {
      text = text.toLowerCase();
      return text === needle ? 0 : text.startsWith(needle) ? 1 : text.includes(needle) ? 2 : 3;
    };
    for (const symbol of this.index.symbols) {
      if (expired()) break;
      if (kind === 'any' && symbol.synthetic) continue;
      if (kind !== 'any' && kind !== symbol.kind) continue;
      const score = Math.min(match(symbol.name), match(symbol.file));
      if (score === 3) continue;
      const renders = new Set(this.incoming.get(symbol.id)?.map(edge => edge[0])).size;
      const references = this.references.get(symbol.id)?.length ?? 0;
      const label = `${symbol.kind} ${declaration(symbol)}`;
      hits.push({ score, references, file: symbol.file, kind: symbol.kind, symbol, row: {
        ...row(label + (symbol.aliasOf ? ` alias of ${symbol.aliasOf}` : '') +
          (renders ? `  rendered by ${renders} components` : '') + flagTest(symbol.file), symbol.file),
        pathEnd: label.length
      } });
    }
    const resolvedRoutes = this.index.pagesUrlConfig && text.startsWith('/') && (kind === 'any' || kind === 'route' || kind === 'api')
      ? new Set(this.matchRoute(text, kind === 'route' ? 'page' : kind === 'api' ? 'api' : undefined).map(route => route.id)) : undefined;
    for (const route of this.index.routes) {
      if (expired()) break;
      const routeKind = route.kind === 'page' ? 'route' : 'api';
      if (kind !== 'any' && kind !== routeKind) continue;
      const score = resolvedRoutes?.has(route.id) ? 0 : Math.min(match(route.url), match(route.file));
      if (score === 3) continue;
      const label = `${routeKind} ${location(route.file, route.line ?? 1)}`;
      hits.push({ score, references: this.fetches.get(route.id)?.length ?? 0, file: route.file, kind: routeKind,
        row: { ...row(`${label} ${route.url}`, route.file), pathEnd: label.length } });
    }
    hits.sort((a, b) => a.score - b.score || b.references - a.references ||
      compare(a.file, b.file) || compare(a.row.text, b.row.text));
    const kinds = [...group(hits, hit => hit.kind)].sort(([, a], [, b]) => b.length - a.length);
    const suggestedFilter = kinds[0]?.[0];
    const single = hits.length === 1 ? hits[0].symbol : undefined;
    const neighbors = !expired() && single?.name.toLowerCase() === needle ? this.graph()?.neighbors(single.id, expired) : undefined;
    return {
      title: `${JSON.stringify(text)} kind=${kind}`, rows: hits.map(hit => hit.row), suggestedFilter,
      notes: neighbors ? [neighbors] : hits.length || expired() ? [] :
        this.suggestions(text, kind === 'any' ? undefined : kind === 'route' ? 'page' : kind, expired, undefined, kind !== 'any')
    };
  }

  private renders(symbol: SymbolEntry, direct: boolean, expired: () => boolean): Result {
    const reached = new Map<number, { route: Route; layout: boolean; chain: string[]; conditional: boolean;
      possible: boolean; depth: number; slots: string[]; issue?: string }>();
    let directIssue: string | undefined;
    let dynamicReference = false;
    const trace = (only?: Route) => {
      const conditions = only && this.index.pagesRenderConditions?.[only.id];
      const pending = [{ id: symbol.id, chain: [] as string[], wrapper: false, conditional: false, possible: false,
        depth: 0, slots: [] as string[], issue: undefined as string | undefined }];
      const visited = new Set<number>();
      for (let i = 0; i < pending.length && !expired(); i++) {
        const entry = pending[i];
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
        dynamicReference ||= this.dynamicRenderComponents.has(entry.id);
        for (const { route, layout } of this.pageRoots.get(entry.id) ?? []) {
          if (!entry.depth || only && route !== only) continue;
          const previous = reached.get(route.id);
          if (!previous || (previous.layout && !layout)) reached.set(route.id, { ...entry, route, layout: layout || entry.wrapper });
        }
        for (const [from, to, line, conditional, wrapper, possible, detail, , file] of this.incoming.get(entry.id) ?? []) {
          if (expired()) break;
          if (visited.has(from)) continue;
          const decision = conditions?.[renderSiteKey(from, to, line)];
          if (decision === 'excluded') continue;
          const parent = this.symbols.get(from);
          pending.push({
            id: from, chain: parent ? [parent.name, ...entry.chain].slice(-8) : entry.chain,
            depth: entry.depth + 1, wrapper: entry.wrapper || !!wrapper,
            conditional: entry.conditional || !!conditional || decision === 'conditional',
            possible: entry.possible || !!possible || decision === 'possible',
            slots: detail ? [detail, ...entry.slots] : entry.slots,
            issue: entry.issue ?? (possible && detail ? `${renderIssue(detail)} (${location(file ?? parent?.file ?? symbol.file, line)})` : undefined)
          });
        }
      }
    };
    trace();
    for (const { route } of [...reached.values()]) {
      if (!this.index.pagesRenderConditions?.[route.id] || expired()) continue;
      reached.delete(route.id);
      trace(route);
    }
    const rows: Row[] = [...reached.values()].sort((a, b) => byRoute(a.route, b.route)).map(entry => {
      const { route, depth, layout, conditional, possible, slots } = entry;
      const chain = slots.length ? entry.chain : entry.chain.slice(-2);
      const fileLabel = location(route.file, route.line ?? 1);
      const url = shorten(route.url, 0, Math.max(16, 340 - bytes(fileLabel))) ?? '...';
      const label = `${url}  ${fileLabel}`;
      const via = (depth <= 2 || slots.length > 0) && ((layout && route.layouts?.some(id => this.symbols.get(id)?.name === chain[0])) ||
        chain[0] === this.symbols.get(route.component ?? 0)?.name) ? chain.slice(1) : chain;
      return {
        ...row(`${label}  depth ${depth}`, route.file),
        pathEnd: label.length,
        annotation: (via.length ? ' via ' + via.join(' > ') : '') + (slots.length ? ` [${slots.join('; ')}]` : ''),
        suffix: (layout ? ' [via layout]' : '') + (conditional ? ' [cond]' : '') +
          (possible ? ' [possible]' : '') + flagTest(route.file)
      };
    });
    const count = `${rows.length} ${rows.length === 1 ? 'route' : 'routes'}`;
    if (direct) {
      const parents = new Map<number, { name: string; file: string; line: number; conditional: number; possible?: true }>();
      for (const [from, , line, conditional, , possible, detail, , site] of this.incoming.get(symbol.id) ?? []) {
        if (expired()) break;
        const parent = this.symbols.get(from);
        const prior = parents.get(from);
        const route = this.pageRoots.get(from)?.[0]?.route;
        const file = site ?? parent?.file ?? route?.file;
        if (possible && detail && file) directIssue ??= `${renderIssue(detail)} (${location(file, line)})`;
        if (file && (!prior || line < prior.line)) parents.set(from, { name: parent?.name ?? symbol.name, file, line, conditional, possible });
      }
      for (const { name, file, line, conditional, possible } of [...parents.values()].sort((a, b) =>
        compare(a.file, b.file) || a.line - b.line)) {
        const label = `direct ${location(file, line)}#${name}`;
        rows.push({ ...row(label + flagTest(file) + (conditional ? ' [cond]' : '') + (possible ? ' [possible]' : ''), file), pathEnd: label.length });
      }
    }
    const directCount = rows.length - reached.size;
    const directLabel = directCount ? `, ${directCount} direct ${directCount === 1 ? 'entry' : 'entries'}` : '';
    const unresolvedAppSlot = Object.values(this.index.pagesWrapperIssues ?? {}).flat().find(issue =>
      issue.startsWith('custom App ') || issue.startsWith('page slot unresolved in ') || issue.startsWith('unresolved page property ') &&
      !issue.endsWith(' in wrapper predicate'));
    const unresolvedLookup = !reached.size && this.index.renderValueUses?.[symbol.id] ?
      Object.values(this.index.renderLookupIssues ?? {})[0] : undefined;
    return { rows, count: rows.length ? count + directLabel : undefined,
      partial: directIssue ?? [...reached.values()].find(entry => entry.issue)?.issue ??
        (dynamicReference ? unresolvedLookup ?? dynamicRenderReason : undefined) ??
        (this.index.queryRevision !== undefined && this.index.queryRevision < QUERY_INDEX_REVISION ? 'regenerate legacy index' : undefined) ??
        [...reached.values()].flatMap(({ route }) => this.index.pagesWrapperIssues?.[route.id] ?? [])[0] ??
        unresolvedAppSlot ??
        (!reached.size ? Object.values(this.index.pagesWrapperIssues ?? {})[0]?.[0] : undefined) ??
        unresolvedLookup ??
        (this.index.schema === INDEX_SCHEMA && this.index.graphRevision !== GRAPH_INDEX_REVISION ? 'regenerate index for component lookup coverage' : undefined) };
  }

  private wrappers(route: Route, includeExternal: boolean, expired: () => boolean): Result {
    const chains = this.index.branches?.[route.id] ?? [this.index.routeWrap[route.id]];
    const files = new Set<string>();
    const notes: Row[] = [];
    if (!includeExternal) notes.push(row('# external non-provider wrappers excluded'));
    const isProvider = (item: QueryIndex['wrapChains'][string][number]) =>
      item.provider ?? item.symbol.endsWith('Provider');
    const rows = chains.flatMap((id, branch) => {
      if (expired()) return [];
      const sites = new Map(this.index.pagesWrapSites?.[route.id]?.[id]);
      const items = (this.index.wrapChains[id] ?? []).map((item, index) =>
        sites.has(index) ? { ...item, evidence: sites.get(index) } : item)
        .filter(item => includeExternal || isProvider(item) || !item.external);
      const document = items.find(item => item.phase === 'document');
      const client = items.filter(item => item.phase !== 'document');
      const groups = new Map<string, typeof items>();
      for (const item of client) {
        const previous = [...groups.values()].at(-1);
        if (previous?.[0].file === item.file || !route.pages && groups.has(item.file)) {
          (route.pages ? previous : groups.get(item.file))!.push(item);
        } else groups.set(route.pages ? String(groups.size) : item.file, [item]);
      }
      const name = (item: typeof items[number]) => item.external ? `${item.symbol} (external: ${item.external})` : item.symbol;
      const providers = items.filter(isProvider);
      const branchLabel = `branch ${String.fromCharCode(65 + branch)}`;
      if (providers.length) {
        const scope = chains.length > 1 ? `, ${branchLabel}` : '';
        const seen = new Set<string>();
        const names: string[] = [];
        for (const item of providers) {
          const identity = `${item.external ?? item.definitionFile ?? item.file}#${item.symbol}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          names.push(name(item));
        }
        notes.push(row(`# providers (outermost first${scope}): ${names.join(', ')}`,
          ...new Set(providers.map(item => item.file))));
      }
      const entries: Row[] = [];
      if (chains.length > 1) entries.push(row(branchLabel));
      if (document && branch === 0) {
        const label = `document ${location(document.file, document.line)}`;
        entries.push({ ...row(`${label} ${document.symbol} [server${document.evidence ? '; ' + document.evidence : ''}]`, document.file), pathEnd: label.length });
        files.add(document.file);
      }
      let order = 0;
      for (const items of groups.values()) {
        const file = items[0].file;
        if (expired()) break;
        const components = items.filter(item => !(item.providerTag ?? item.provider));
        const providers = items.filter(item => item.providerTag ?? item.provider);
        const label = `${++order} ${location(file, (components[0] ?? items[0]).line)}`;
        files.add(file);
        const symbols = [...new Set(components.map(item => name(item) +
          (route.pages && item.evidence ? ` [${item.evidence}]` : '')))];
        const providerNames = [...new Set(providers.map(item => name(item) +
          (route.pages && item.evidence ? ` [${item.evidence}]` : '')))];
        entries.push({ ...row(label + (symbols.length ? ` ${symbols.join(', ')}` : '') +
          (providerNames.length ? ` providers: ${providerNames.join(', ')}` : '') +
          (items.some(item => item.conditional) ? ' [cond]' : '') +
          (items.some(item => item.possible) ? ' [possible]' : '') + flagTest(file), file), pathEnd: label.length });
      }
      return entries;
    });
    const page = this.symbols.get(route.component ?? 0);
    const label = `page ${location(route.file, route.line ?? 1)}`;
    const reexport = page && page.file !== route.file;
    const locations = label + (reexport ? ` -> ${location(page.file, page.line)}` : '');
    rows.push({ ...row(locations + (reexport ? ' (re-export)' : ''),
      ...[route.file, ...(reexport ? [page.file] : [])]), pathEnd: locations.length });
    return { rows, title: route.url, count: `${files.size} ${files.size === 1 ? 'file' : 'files'}, 1 page`, targets: [route.file],
      notes, partial: this.index.pagesWrapperIssues?.[route.id]?.join('; ') };
  }

  private rename(symbol: SymbolEntry, includeTests: boolean, expired: () => boolean): Result {
    const label = `decl ${location(symbol.file, symbol.line)}`;
    const rows = [{ ...row(label + flagTest(symbol.file), symbol.file), pathEnd: label.length }];
    const files = new Set([symbol.file]);
    const references = this.references.get(symbol.id) ?? [];
    const sourceLines = new Map<string, string[]>();
    const exportStar = (ref: Reference) => {
      if (ref[3] === 'export-star') return true;
      if (this.index.coverage || ref[3] !== 're-export') return false;
      if (!sourceLines.has(ref[1])) {
        try {
          sourceLines.set(ref[1], readFileSync(this.checkPath(ref[1]), 'utf8').split(/\r?\n/));
        } catch {
          sourceLines.set(ref[1], []);
        }
      }
      return /^\s*export\s+(?:type\s+)?\*\s+from\b/.test(sourceLines.get(ref[1])!.slice(ref[2] - 1, ref[2] + 3).join('\n'));
    };
    const scoped = references.filter(ref => includeTests || !testFile(ref[1]));
    const passthrough = scoped.filter(exportStar);
    const uses = group(scoped.filter(ref => !exportStar(ref)), ref => ref[1]);
    const localUses = (includeTests || !testFile(symbol.file)) ? symbol.localUses ?? [] : [];
    if (localUses.length && !uses.has(symbol.file)) uses.set(symbol.file, []);
    for (const [file, refs] of [...uses].sort(([a], [b]) => Number(testFile(a)) - Number(testFile(b)) || compare(a, b))) {
      if (expired()) break;
      files.add(file);
      const lines = new Set(refs.map(ref => ref[2]));
      if (file === symbol.file) for (const line of localUses) lines.add(line);
      const sortedLines = [...lines].sort((a, b) => a - b);
      const label = `use  ${file}:${sortedLines.slice(0, 5).join(',')}`;
      const details = [...new Set(refs.flatMap(ref => ref[4] ?? (ref[3] === 're-export' ? 're-export' : [])))].sort();
      rows.push({ ...row(label + (lines.size > 5 ? ` +${lines.size - 5}` : '') +
        flagTest(file) + (details.length ? '  ' + details.join(', ') : ''), file), pathEnd: label.length });
    }
    const traps = (this.names.get(symbol.name) ?? []).filter(other => other.id !== symbol.id)
      .map(other => ({ file: other.file, line: other.line, text: `${symbol.name} (different symbol)` }))
      .concat((Object.prototype.hasOwnProperty.call(this.index.mentions ?? {}, symbol.name) ? this.index.mentions![symbol.name] : [])
        .map(([file, line]) => ({ file, line, text: `${symbol.name} (comment)` })))
      .filter(entry => includeTests || !testFile(entry.file))
      .sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.text, b.text)).slice(0, 10);
    const notes: Row[] = [];
    if (traps.length) {
      let current = row('# not affected:');
      for (const { file, line, text } of traps) {
        const part = `${location(file, line)} ${text}${flagTest(file)}`;
        if (bytes(current.text + part) > 390 && current.files.length) {
          notes.push(current);
          current = row('# not affected:');
        }
        current.text += (current.files.length ? ', ' : ' ') + part;
        current.files.push(file);
        current.pathEnd = current.text.length;
      }
      notes.push(current);
    }
    for (const [, file, line] of passthrough.sort((a, b) => compare(a[1], b[1]) || a[2] - b[2])) {
      if (!uses.has(file)) notes.push(row(`# pass-through ${location(file, line)} (no edit)`, file));
    }
    return { rows, count: `${files.size} ${files.size === 1 ? 'file' : 'files'}`, notes };
  }

  private consumers(route: Route, levels: number, includeTests: boolean, expired: () => boolean): Result {
    const rows: Row[] = [];
    const evidence = new Map<string, number>();
    const propEvidence = new Map<string, Row>();
    let propIssue: string | undefined;
    const files = new Set<string>();
    const generatedFiles = new Set<string>();
    let owners = new Set<number>();
    const unboundedTransports = this.index.uncertainChatTransports?.filter(([file, , unbounded]) =>
      unbounded !== false && (includeTests || !testFile(file))) ?? [];
    let transportOverride = unboundedTransports.some(([, , , , override]) => override !== false);
    let uncertainTransport = !!unboundedTransports.length;
    const fetches = (this.fetches.get(route.id) ?? []).filter(fetch => includeTests || !testFile(fetch.file))
      .sort((a, b) => Number(generatedFile(a.file)) - Number(generatedFile(b.file)) ||
        compare(a.file, b.file) || a.line - b.line || compare(a.method, b.method) || compare(a.via, b.via));
    for (const fetch of fetches) {
      if (expired()) break;
      files.add(fetch.file);
      const generated = generatedFile(fetch.file);
      if (generated) generatedFiles.add(fetch.file);
      const via = fetch.via === 'SWR key' && fetch.method === '?' ? 'SWR mutate' : fetch.via;
      const legacyTransport = via === AI_SDK_TRANSPORT && (this.index.queryRevision ?? 0) < TRANSPORT_QUERY_REVISION;
      const method = legacyTransport ? '?' : fetch.method;
      const override = via === AI_SDK_TRANSPORT && (fetch.transportOverride || legacyTransport);
      transportOverride ||= override;
      uncertainTransport ||= via === AI_SDK_TRANSPORT && !!fetch.partial;
      const kind = (!(override && method === '?') ? apiEvidence.get(via) : undefined) ?? 'other mention';
      evidence.set(kind, (evidence.get(kind) ?? 0) + 1);
      const mention = route.pages && (kind === 'other mention' || kind === 'fallback key');
      const label = `${mention ? 'mention ' : 'send   '}${location(fetch.file, fetch.line)}`;
      const binding = fetch.binding;
      const text = `${label} ${fetch.fn ? fetch.fn + ' ' : ''}${method} ${via}` +
        (binding ? ` via prop ${binding.name} at ${location(binding.file, binding.line)}` : '') +
        (override ? ' [possible URL override]' : kind === 'other mention' && !mention ? ' [mention]' : '') +
        (fetch.partial || override ? ' [partial url]' : '') + flagTest(fetch.file) + (generated ? ' [generated]' : '') +
        (fetch.possibleReconnect ? ' [possible reconnect]' : '') +
        (fetch.evidence ? ` (${fetch.evidence})` : '');
      rows.push({ ...row(text, fetch.file, ...binding ? [binding.file] : []), pathEnd: label.length });
      if (binding && fetch.owner !== undefined) {
        const result = this.graph()?.consumerEvidence(fetch.graphOwner ?? fetch.owner, includeTests, expired, fetch.gates, binding.supplier);
        propIssue ??= result?.partial;
        for (const entry of result?.rows ?? []) propEvidence.set(entry.text, entry);
      } else if (fetch.owner !== undefined) owners.add(fetch.owner);
    }
    const traversed = new Set<number>();
    const seen = new Set<string>();
    for (let level = 1; level <= levels && owners.size && !expired(); level++) {
      const next = new Set<number>();
      const entries: { file: string; line: number; name: string }[] = [];
      for (const owner of owners) {
        traversed.add(owner);
        for (const [, file, line, kind, , caller] of this.references.get(owner) ?? []) {
          if (expired()) break;
          if (kind !== 'call' || (!includeTests && testFile(file)) || caller === owner) continue;
          entries.push({ file, line, name: this.symbols.get(owner)?.name ?? 'unknown' });
          if (caller !== undefined) next.add(caller);
        }
      }
      for (const { file, line, name } of entries.sort((a, b) =>
        compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name))) {
        const key = `${file}:${line} ${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        files.add(file);
        const label = `call${level}  ${location(file, line)}`;
        rows.push({ ...row(`${label} ${name}${flagTest(file)}`, file), pathEnd: label.length });
      }
      owners = new Set([...next].filter(id => !traversed.has(id)));
    }
    const moreCallers = levels > 0 && [...owners].some(owner => this.references.get(owner)?.some(
      ([, file, line, kind, , caller]) => kind === 'call' && caller !== owner && (includeTests || !testFile(file)) &&
        !seen.has(`${file}:${line} ${this.symbols.get(owner)?.name ?? 'unknown'}`)
    ));
    const similar = [...new Set(this.index.routes.filter(other => other.kind === 'api' && other.url !== route.url &&
      (route.url.startsWith(other.url + '/') || other.url.startsWith(route.url + '/')))
      .map(other => other.url))].sort().slice(0, 5);
    evidence.set('caller', seen.size);
    const breakdown = ['read', 'mutate', 'fallback key', 'request', 'other mention', 'caller'].flatMap(kind => {
      const total = evidence.get(kind);
      return total ? [`${total} ${kind}${total === 1 ? '' : 's'}`] : [];
    }).join(', ');
    const count = `${rows.length} ${rows.length === 1 ? 'site' : 'sites'} in ${files.size} ${files.size === 1 ? 'file' : 'files'}` +
      (breakdown ? `: ${breakdown}` : '') +
      (generatedFiles.size ? ` (${generatedFiles.size} generated ${generatedFiles.size === 1 ? 'file' : 'files'})` : '');
    rows.push(...propEvidence.values());
    return {
      title: `${route.url} -> ${location(route.file, route.line ?? 1)}`, rows, targets: [route.file],
      count: rows.length ? count : undefined,
      partial: this.index.coverage !== 2 ? 'regenerate legacy index' :
        ([this.index.pagesApiIssues?.[route.id]?.join('; '), transportOverride || uncertainTransport ? transportIssue(transportOverride) : undefined]
          .filter(Boolean).join('; ') || undefined) ??
        (fetches.some(fetch => fetch.propUrlUnknown) ? 'request URL from JSX prop untraced' :
          fetches.some(fetch => fetch.dynamic) ? 'dynamic URL' :
          fetches.some(fetch => fetch.partial) ? 'uncertain URL matches' :
          propIssue ?? (moreCallers ? 'caller depth limit' : undefined)),
      notes: [
        ...[...new Map(unboundedTransports.map(([file, , , line]) => {
          const site = line === undefined ? file : location(file, line);
          return [site, row(`# unbounded AI SDK transport: ${site}`, file)];
        })).values()].slice(0, 5),
        ...(route.pages && route.methodBasis === 'enforced' && route.methods?.length
          ? [row(`# methods enforced: ${route.methods.join(', ')}`, route.file)] : []),
        ...(route.observedMethods?.length ? [row(`# methods observed: ${route.observedMethods.join(', ')} (accepted methods unknown)`, route.file)] : []),
        ...(similar.length ? [row(`# similar routes not matched: ${similar.join(', ')}`)] : [])
      ]
    };
  }

  private actionConsumers(action: ServerAction, includeTests: boolean, expired: () => boolean): Result {
    const callers = group(action.callers.filter(([file]) => includeTests || !testFile(file)), ([file]) => file);
    const rows: Row[] = [];
    const graph = this.index.flowCalls?.length || this.index.hasFlowCalls ? this.graph() : undefined;
    let partial: string | undefined;
    const detailed = new Map<number, ReturnType<DependencyGraph['consumerEvidence']>>();
    for (const [file, uses] of [...callers].sort(([a], [b]) => compare(a, b))) {
      if (expired()) break;
      const enriched = uses.flatMap(([, line, owner]) => {
        if (owner === undefined || !graph || testFile(file)) return [];
        let evidence = detailed.get(owner);
        if (!evidence) {
          const gates = action.symbol === undefined ? undefined : this.index.callGates?.[`${owner}:${action.symbol}:${line}`];
          evidence = graph.consumerEvidence(owner, includeTests, expired, gates);
          detailed.set(owner, evidence);
        }
        if (!evidence.rows.length) return [];
        partial ??= evidence.partial;
        return [{ line, owner, evidence }];
      });
      if (enriched.length) {
        const distinct = new Map<string, Row>();
        for (const { line, owner, evidence } of enriched) {
          const label = `call   ${location(file, line)}`;
          distinct.set(label, { ...row(`${label} ${graph!.name(owner)}`, file), pathEnd: label.length });
          for (const entry of evidence.rows) distinct.set(entry.text, entry);
        }
        rows.push(...distinct.values());
      }
      const plain = uses.filter(([, line, owner]) => !enriched.some(entry => entry.line === line && entry.owner === owner));
      if (!plain.length) continue;
      const lines = [...new Set(plain.map(([, line]) => line))].sort((a, b) => a - b);
      const label = `call   ${location(file, lines[0])}`;
      rows.push({ ...row(label + (lines.length > 1 ? ',' + lines.slice(1, 5).join(',') : '') +
        (lines.length > 5 ? ` +${lines.length - 5}` : '') + flagTest(file), file), pathEnd: label.length });
    }
    return {
      title: actionLocation(action),
      rows, targets: [action.file], count: `${callers.size} caller ${callers.size === 1 ? 'file' : 'files'}`,
      partial, scope: 'indexed server action callers'
    };
  }

  private graph() {
    if (this.dependencyGraph !== undefined) return this.dependencyGraph;
    let index: QueryIndex;
    try {
      index = unpackGraph(this.index);
    } catch {
      this.dependencyGraph = null;
      return null;
    }
    if (hasGraph(index)) {
      const symbols = index === this.index ? this.symbols : new Map(index.symbols.map(symbol => [symbol.id, symbol]));
      this.index = index;
      this.dependencyGraph = new DependencyGraph(index, symbols);
    } else this.dependencyGraph = null;
    return this.dependencyGraph;
  }

  private matchGraphSymbol(target: string, graph: DependencyGraph) {
    const matches = this.matchSymbol(target);
    if (matches.length) return matches;
    const { name, file } = this.symbolTarget(target);
    if (name === 'default' && file) {
      const symbol = graph.defaultSymbol(file);
      if (symbol) return [symbol];
    }
    return graph.actionMatches(name, file).sort(bySymbol);
  }

  private graphQuery(args: ReturnType<typeof validate>, expired: () => boolean, deadline: number): { result: Result; ambiguous?: boolean } {
    const { tool, target, depth, includeTests, limit, uses } = args;
    const graph = this.graph();
    if (!graph) return { result: { rows: [], partial: 'regenerate legacy index' } };
    if (tool === 'path') return this.pathQuery(target, args.to, graph, expired);
    if (tool === 'changes') return {
      result: changes(this.root, this.index, graph, args.scope, args.base, depth, deadline, file => this.checkPath(file))
    };
    if (target.startsWith('/') && this.index.pagesUrlConfig) {
      const routes = this.matchRoute(target);
      if (routes.length > 1) return { ambiguous: true, result: { rows: routes.map(route =>
        row(`${location(route.file, route.line ?? 1)}#${route.url} ${route.kind}`, route.file)) } };
      const [route] = routes;
      if (route) {
        const seeds = route.kind === 'api' ? graph.apiTargets(route) : graph.routeStarts(route);
        const result = tool === 'impact' ? graph.impact(seeds, depth, !!includeTests, limit, expired) :
          graph.callees(seeds, depth, uses, expired, route);
        return { result: { ...result, title: route.url, targets: [route.file] } };
      }
      return { result: { rows: [], notes: this.suggestions(target, tool === 'callees' ? 'page' : undefined, expired) } };
    }
    if (tool === 'impact' && !this.names.has(target) && !target.includes('#') && (target.includes('/') || /\.[cm]?[jt]sx?$/.test(target))) {
      this.checkPath(target);
      const file = path.posix.normalize(target);
      const seeds = graph.fileSeeds(file);
      if (seeds.length) return { result: { ...graph.impact(seeds, depth, !!includeTests, limit, expired), targets: [file] } };
      return { result: { rows: [], notes: this.suggestions(path.posix.basename(file).split('.')[0], undefined, expired) } };
    }
    const matches = this.matchGraphSymbol(target, graph);
    if (matches.length > 1) return { ambiguous: true, result: { limit: 10,
      rows: matches.map(symbol => row(`${declaration(symbol)} ${symbol.kind}${flagTest(symbol.file)}`, symbol.file)) } };
    const [symbol] = matches;
    if (!symbol) return { result: { rows: [], notes: this.suggestions(target.split('#').pop()!, undefined, expired) } };
    const result = tool === 'impact' ? graph.impact([symbol.id], depth, !!includeTests, limit, expired) : graph.callees(symbol.id, depth, uses, expired);
    const title = symbol.kind === 'procedure' ? declaration(symbol) : `${symbol.file}#${symbol.name}`;
    return { result: { ...result, title, targets: [symbol.file] } };
  }

  private pathQuery(from: string, to: string, graph: DependencyGraph, expired: () => boolean) {
    const routeTarget = (text: string) => text.startsWith('/') || text.startsWith('route:') || (!this.names.has(text) && !text.includes('#') && /\.[cm]?[jt]sx?$/.test(text));
    const resolve = (target: string, kind?: 'page' | 'api') => {
      if (routeTarget(target)) {
        const exact = this.matchRoute(target, kind, true);
        const routes = exact.length || target.startsWith('/') ? exact : [];
        const [route] = routes;
        return { route, ids: route ? route.kind === 'page' ? graph.routeStarts(route) : graph.apiTargets(route) : [],
          label: route?.url ?? target, file: route?.file,
          candidates: routes.map(route => row(`${location(route.file, route.line ?? 1)}#${route.url} ${route.kind}`, route.file)),
          notes: () => this.suggestions(target, kind, expired) };
      }
      const matches = this.matchGraphSymbol(target, graph);
      const [symbol] = matches;
      return { route: undefined, ids: symbol ? [symbol.id] : [], label: symbol ? `${symbol.file}#${symbol.name}` : target, file: symbol?.file,
        candidates: matches.map(symbol => row(`${declaration(symbol)} ${symbol.kind}${flagTest(symbol.file)}`, symbol.file)),
        notes: () => this.suggestions(target.split('#').pop()!, undefined, expired) };
    };
    const source = resolve(from, this.index.pagesUrlConfig ? undefined : 'page');
    const destination = resolve(to, this.index.pagesUrlConfig ? undefined : 'api');
    const title = `${source.label} -> ${destination.label}`;
    for (const endpoint of [source, destination]) {
      if (endpoint.candidates.length > 1) return { ambiguous: true, result: { title, rows: endpoint.candidates, limit: 10 } };
      if (!endpoint.file) return { result: { title, rows: [], notes: endpoint.notes() } };
    }
    const pathname = source.route?.pages && normalizeNextUrl(from, this.index.pagesUrlConfig) || undefined;
    const concrete = pathname && routeSegments(pathname).every(part => segmentRank(part) === '3') ? pathname : undefined;
    const result = graph.path(source.ids, destination.ids, expired, source.route, concrete);
    return { result: { ...result, title, targets: [source.file!, destination.file!] } };
  }

  query(name: string, value: unknown, cli?: CliReplay) {
    const args = validate(name, value);
    const { tool, target } = args;
    const graphKind = tool === 'impact' || tool === 'callees' || tool === 'path' || tool === 'changes';
    const configured = graphKind ? Number(process.env.NEORION_QUERY_DEADLINE_MS) : NaN;
    const cliPath = cli && tool === 'path';
    const budget = tool === 'changes' ? historyBudgetMs : cliPath ? 5000 : 1850;
    const timeoutMs = configured > 0 ? Math.min(budget, configured) : budget;
    const deadline = performance.now() + timeoutMs;
    const expired = () => performance.now() >= deadline;
    let result: Result = { rows: [] };
    let ambiguous = false;
    if (graphKind) {
      const answer = this.graphQuery(args, expired, deadline);
      result = answer.result;
      ambiguous = !!answer.ambiguous;
    } else if (tool === 'search') result = this.search(target, args.filter, expired);
    else if (tool === 'who_renders' || tool === 'rename_impact') {
      const matches = this.matchSymbol(target).filter(symbol =>
        tool === 'who_renders' ? symbol.kind === 'component' || symbol.kind === 'procedure' : symbol.kind !== 'procedure');
      if (matches.length > 1) {
        ambiguous = true;
        result = { rows: matches.map(symbol => row(`${declaration(symbol)} ${symbol.kind}${flagTest(symbol.file)}`, symbol.file)), limit: 10 };
      } else if (matches.length) {
        const [symbol] = matches;
        result = symbol.kind === 'procedure'
          ? this.graph()?.procedureRoutes(symbol, !!args.direct, expired) ?? { rows: [], partial: 'regenerate legacy index' }
          : tool === 'who_renders' ? this.renders(symbol, !!args.direct, expired) : this.rename(symbol, !!args.includeTests, expired);
        result.title = `${symbol.file}#${symbol.name}`;
        result.targets = [symbol.file];
      } else {
        const { file, name } = this.symbolTarget(target);
        result.notes = this.suggestions(name, tool === 'who_renders' ? 'renderer' : undefined, expired, file);
        if (tool === 'who_renders' && [...name].length >= 2 && [...name].length <= 200 && oneLine(name) === name) {
          result.notes.push(row(retryHint(cli, 'search', name, { filter: name.includes('.') ? 'procedure' : 'component' })));
        }
      }
    } else {
      const kind = tool === 'wrappers' ? 'page' : 'api';
      const actionPath = tool === 'api_consumers' && target.includes('#') && !target.startsWith('/');
      const routes = actionPath ? [] : this.matchRoute(target, kind);
      if (routes.length > 1) {
        ambiguous = true;
        result = { rows: routes.map(route => row(`${location(route.file, route.line ?? 1)}#${route.url} ${route.kind}`, route.file)), limit: 10 };
      } else if (routes.length) result = tool === 'wrappers'
        ? this.wrappers(routes[0], !!args.includeExternal, expired)
        : this.consumers(routes[0], args.callers, !!args.includeTests, expired);
      else if (tool === 'api_consumers' && (actionPath || !/[\\/]/.test(target))) {
        const { file, name } = this.symbolTarget(target);
        const procedures = this.matchSymbol(target).filter(symbol => symbol.kind === 'procedure');
        const candidates = (this.index.serverActions ?? []).filter(action => file === undefined || action.file === file);
        const exact = candidates.filter(action => action.name === name || action.aliases?.includes(name));
        const actions = (exact.length ? exact : candidates.filter(action => actionShortName(action.name) === name))
          .sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name));
        if (actions.length + procedures.length > 1) {
          ambiguous = true;
          result = { rows: [...actions.map(action => row(`${actionLocation(action)} server action`, action.file)),
            ...procedures.map(procedure => row(`${declaration(procedure)} tRPC procedure`, procedure.file))], limit: 10 };
        } else if (procedures.length) result = this.graph()?.procedureConsumers(procedures[0], !!args.includeTests) ??
          { rows: [], partial: 'regenerate legacy index' };
        else if (actions.length) result = this.actionConsumers(actions[0], !!args.includeTests, expired);
        else {
          result.notes = this.suggestions(name, 'action', expired, file);
          if ([...name].length >= 2 && [...name].length <= 200 && oneLine(name) === name) {
            result.notes.push(row(retryHint(cli, 'search', name)));
          }
          if (!this.index.serverActions) result.partial = 'regenerate legacy index';
        }
      } else if (tool === 'wrappers' && this.index.pagesUrlConfig && /(?:^|\/)_((?:app)|(?:document))\.[^/]+$/.test(target)) {
        result.notes = [row('# custom shell applies to Pages routes; query a page URL or file')];
      } else {
        result.notes = this.suggestions(target, kind, expired);
        if (tool === 'wrappers' && this.index.routes.some(route => route.kind === 'page')) {
          const suggestedFiles = new Set(result.notes.flatMap(note => note.files));
          const suffixRoute = this.index.routes.find(route => suggestedFiles.has(route.file) && route.url.endsWith(target));
          const patterns = target.startsWith('/') && !suffixRoute ? this.matchRoute(target, 'page', true) : [];
          for (const route of patterns.slice(0, 5)) {
            if (!suggestedFiles.has(route.file)) {
              result.notes.push(row(`# matching pattern: ${route.url} ${location(route.file, route.line ?? 1)}`, route.file));
            }
          }
          const retry = suffixRoute ?? patterns[0];
          if (retry) {
            const retryTarget = this.matchRoute(retry.url, 'page').length > 1 ? retry.file : retry.url;
            result.notes.push(row(retryHint(cli, 'wrappers', retryTarget, {
              includeExternal: !!args.includeExternal, limit: args.limit, targetKey: legacyKind(name) ? legacyTargets.wrappers : 'target'
            })));
          }
          result.notes.push(row(retryHint(cli, 'search', '/', { filter: 'route' })));
        }
      }
    }
    const timestamp = this.index.generatedAt.slice(0, 16) + 'Z';
    const status = new Map<string, boolean>();
    const stale = (file: string) => {
      if (!status.has(file) && Object.prototype.hasOwnProperty.call(this.index.files, file)) {
        const indexed = this.index.files[file];
        try {
          const absolute = this.checkPath(file);
          const current = statSync(absolute);
          status.set(file, !current.isFile() || current.size !== indexed.size ||
            (current.mtimeMs !== indexed.mtimeMs &&
              createHash('sha1').update(readFileSync(absolute)).digest('hex') !== indexed.sha1));
        } catch {
          status.set(file, true);
        }
      }
      return !!status.get(file);
    };
    const maxRows = result.limit ?? args.limit;
    const notesFirst = tool === 'wrappers';
    const renderedRows: { text: string; files: string[] }[] = [];
    let shortened = false;
    const renderRow = (entry: Row) => {
      const suffix = (entry.suffix ?? '') + (entry.files.some(stale) ? ' [stale]' : '');
      const cap = 400 - bytes(suffix);
      const text = shorten(entry.text, entry.pathEnd ?? 0, cap);
      shortened ||= text !== oneLine(entry.text);
      const annotation = text && entry.annotation ? shorten(entry.annotation, 0, cap - bytes(text)) ?? '' : '';
      // A path longer than the hard line cap cannot be represented intact.
      return text === undefined ? [] : [{ text: text + annotation + suffix, files: entry.files }];
    };
    let resultBytes = 0;
    for (const entry of result.rows) {
      if (renderedRows.length >= maxRows || (expired() && renderedRows.length)) break;
      for (const rendered of renderRow(entry)) {
        resultBytes += bytes(rendered.text) + 1;
        renderedRows.push(rendered);
      }
      if (resultBytes >= 6000) break;
    }
    const notes = (result.notes ?? []).flatMap(renderRow);
    let snapshotStale = false;
    if (this.index.coverage && !ambiguous && !result.partial && !shortened &&
        renderedRows.length === result.rows.length && (tool === 'search' || result.targets)) {
      for (const file of Object.keys(this.index.files)) {
        if (expired()) break;
        if (stale(file)) {
          snapshotStale = true;
          break;
        }
      }
    }
    let shown = renderedRows.length;
    let noteCount = notes.length;
    const truncation = 'output truncated';
    const truncationWithReason = result.partial ? `${truncation}; ${result.partial}` : truncation;
    const compactReason = result.partial === dynamicRenderReason ? `${truncation}; dynamic ref` : truncation;
    for (;;) {
      const visible = renderedRows.slice(0, shown);
      const extras = notes.slice(0, noteCount);
      const staleCount = new Set([...result.targets ?? [], ...[...visible, ...extras].flatMap(entry => entry.files)]
        .filter(stale)).size;
      const freshness = staleCount ? `stale ${staleCount} files; regenerate the index` : 'fresh';
      const omitted = result.rows.length - shown;
      const count = result.count ?? `${result.rows.length} results`;
      const header = shorten(`# ${expired() ? 'timeout ' : ''}${ambiguous ? 'ambiguous ' : ''}${tool} ${result.title ?? target}` +
        ` : ${count}${omitted ? `, showing ${shown}` : ''} (index ${timestamp}, ${freshness})`)!;
      const more = omitted ? `# more: ${omitted} (${ambiguous ? 'use path#Name or a route file path' :
        limitHint(args, result.rows.length, cli, legacyKind(name) === 'search' ? 'kind' : 'filter', result.suggestedFilter)})` : '';
      const truncated = omitted || noteCount < (result.notes?.length ?? 0) || shortened;
      const reason = expired() ? cliPath ? `timed out (${timeoutMs} ms budget)` : 'timed out' : ambiguous ? 'ambiguous target' :
        staleCount || snapshotStale ? 'stale index' : truncated ? truncationWithReason :
        !this.index.coverage ? 'regenerate legacy index' : result.partial ??
        (tool !== 'search' && !result.targets ? 'target unresolved' : undefined);
      const scope = result.scope ?? {
        who_renders: 'indexed JSX paths', wrappers: 'indexed wrapper chains',
        rename_impact: 'checker-resolved edit files', api_consumers: 'indexed route literals' + (args.callers ? ' and callers' : ''),
        search: 'indexed name and path matches', impact: 'indexed dependency edges', callees: 'indexed outgoing edges',
        path: 'indexed directed edges', changes: 'git diff and indexed impacts'
      }[tool];
      const coverage = reason ? `# partial: ${reason}` : `# complete: ${scope}`;
      const body = [header, ...(notesFirst ? extras : []).map(entry => entry.text),
        ...visible.map(entry => entry.text), ...(notesFirst ? [] : extras).map(entry => entry.text), ...(more ? [more] : [])].join('\n');
      const output = `${body}\n${coverage}`;
      if (bytes(output) <= 6000) return output;
      if (tool === 'who_renders' && result.partial && reason === truncationWithReason) {
        const compact = `${body}\n# partial: ${compactReason}`;
        if (bytes(compact) <= 6000) return compact;
      }
      if (noteCount) noteCount--;
      else shown--;
    }
  }
}
