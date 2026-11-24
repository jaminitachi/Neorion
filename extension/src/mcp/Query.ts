import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isTestFile as testFile, type FetchEntry, type QueryIndex, type Reference, type ServerAction, type SymbolEntry } from './Index';
import { legacyKind, legacyTargets, kinds, queryName, tools, type QueryKind } from './Tools';

type Route = QueryIndex['routes'][number];
type Edge = QueryIndex['renderEdges'][number];
type Row = { text: string; files: string[]; pathEnd?: number };
type Result = { rows: Row[]; title?: string; count?: string; targets?: string[]; notes?: Row[]; limit?: number; partial?: string; scope?: string };
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
    api_consumers: ['callers', 'includeTests'], search: [filterKey]
  }[tool];
  for (const key of Object.keys(input)) {
    if (![targetKey, 'limit', ...options, ...(!legacy ? ['kind'] : [])].includes(key)) {
      throw new Error(`Unexpected argument ${oneLine(key).slice(0, 80)}.`);
    }
  }
  const target = typeof input[targetKey] === 'string' ? (input[targetKey] as string).trim() : '';
  if ([...target].length < (tool === 'search' ? 2 : 1) || [...target].length > (tool === 'search' ? 200 : 300)) {
    throw new Error('Invalid query target.');
  }
  const { limit = tool === 'search' ? 20 : 40, callers = 1, direct = false,
    includeExternal = true, includeTests = tool === 'rename_impact' || (!legacy && tool === 'api_consumers'), [filterKey]: rawFilter } = input;
  const filter = tool === 'search' ? rawFilter ?? 'any' : 'any';
  const integerInRange = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  if (!integerInRange(limit, 1, tool === 'search' ? 50 : 100)) throw new Error('Invalid argument limit.');
  if (!integerInRange(callers, 0, 2)) throw new Error('Invalid argument callers.');
  if (tool === 'search' && ((rawFilter === null) || typeof filter !== 'string' ||
      !tools[0].inputSchema.properties.filter.enum.includes(filter))) throw new Error('Invalid search filter.');
  for (const key of ['direct', 'includeExternal', 'includeTests']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Invalid argument ${key}.`);
  }
  return { tool, target, limit, callers, direct, includeExternal, includeTests, filter: String(filter) };
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
  private references: Map<number, Reference[]>;
  private fetches: Map<number, FetchEntry[]>;
  private pageRoots = new Map<number, { route: Route; layout: boolean }[]>();

  constructor(root: string, private index: QueryIndex) {
    this.root = realpathSync(root);
    this.symbols = new Map(index.symbols.map(symbol => [symbol.id, symbol]));
    this.names = group(index.symbols, symbol => symbol.name);
    this.incoming = group(index.renderEdges, edge => edge[1]);
    for (const edges of this.incoming.values()) edges.sort((a, b) => {
      const left = this.symbols.get(a[0]);
      const right = this.symbols.get(b[0]);
      return compare(left?.file ?? '', right?.file ?? '') || compare(left?.name ?? '', right?.name ?? '') ||
        a[3] - b[3] || a[2] - b[2] || a[0] - b[0];
    });
    this.references = group(index.references, reference => reference[0]);
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
    else if (/[\\/]/.test(text)) throw new Error('Use a name or an app-relative path#Name.');
    return { file, name: text.slice(delimiter + 1) };
  }

  private matchSymbol(text: string, component: boolean) {
    const { file, name } = this.symbolTarget(text);
    return (this.names.get(name) ?? [])
      .filter(symbol => (file === undefined || symbol.file === file) && (!component || symbol.kind === 'component')).sort(bySymbol);
  }

  private matchRoute(text: string, kind: string) {
    if (text.startsWith('/')) {
      if (/^\/\/|^\/(?:[^/]+\/)*\.\.(?:\/|$)|\\/.test(text)) throw new Error('Invalid route URL pattern.');
      if (/\.[cm]?[jt]sx?$/.test(text) && !this.index.routes.some(route => route.url === text)) {
        throw new Error('Use an app-relative route file path.');
      }
    } else this.checkPath(text);
    return this.index.routes.filter(route => route.kind === kind &&
      (route.url === (text.replace(/\/$/, '') || '/') || route.file === path.posix.normalize(text))).sort(byRoute);
  }

  private suggestions(text: string, kind: string | undefined, expired: () => boolean, file?: string): Row[] {
    const needle = text.toLowerCase().slice(0, 100);
    const candidates: { name: string; label: string; file: string; aliases?: string[] }[] = kind === 'page' || kind === 'api'
      ? this.index.routes.filter(route => route.kind === kind).map(route =>
        ({ name: route.url, label: `${route.url} ${location(route.file, route.line ?? 1)}`, file: route.file }))
      : kind === 'action'
        ? (this.index.serverActions ?? []).filter(action => file === undefined || file === action.file).map(action => ({
          name: action.name, aliases: [...(action.aliases ?? []), actionShortName(action.name)],
          label: actionLocation(action), file: action.file
        }))
        : this.index.symbols.filter(symbol => !kind || symbol.kind === kind).map(symbol =>
        ({ name: symbol.name, label: declaration(symbol), file: symbol.file }));
    const matches: (typeof candidates[number] & { score: number })[] = [];
    const threshold = Math.max(2, Math.floor(needle.length / 3));
    for (const candidate of candidates) {
      if (expired()) break;
      const names = [candidate.name, ...(candidate.aliases ?? [])];
      let score = threshold + 1;
      for (const value of names) {
        const name = value.toLowerCase().slice(0, 100);
        if (Math.abs(name.length - needle.length) <= threshold) score = Math.min(score, distance(needle, name));
      }
      if (score <= threshold) matches.push({ ...candidate, score });
    }
    return matches.sort((a, b) => a.score - b.score || compare(a.label, b.label)).slice(0, 5)
      .map(candidate => {
        const text = `# did you mean: ${candidate.label}`;
        return { ...row(text, candidate.file), pathEnd: text.length };
      });
  }

  private search(text: string, kind: string, expired: () => boolean): Result {
    const needle = text.toLowerCase();
    const hits: { row: Row; score: number; references: number; file: string }[] = [];
    const match = (text: string) => {
      text = text.toLowerCase();
      return text === needle ? 0 : text.startsWith(needle) ? 1 : text.includes(needle) ? 2 : 3;
    };
    for (const symbol of this.index.symbols) {
      if (expired()) break;
      if (kind !== 'any' && kind !== symbol.kind) continue;
      const score = Math.min(match(symbol.name), match(symbol.file));
      if (score === 3) continue;
      const renders = new Set(this.incoming.get(symbol.id)?.map(edge => edge[0])).size;
      const references = this.references.get(symbol.id)?.length ?? 0;
      const label = `${symbol.kind} ${declaration(symbol)}`;
      hits.push({ score, references, file: symbol.file, row: {
        ...row(label + (symbol.aliasOf ? ` alias of ${symbol.aliasOf}` : '') +
          (renders ? `  rendered by ${renders} components` : '') + flagTest(symbol.file), symbol.file),
        pathEnd: label.length
      } });
    }
    for (const route of this.index.routes) {
      if (expired()) break;
      const routeKind = route.kind === 'page' ? 'route' : 'api';
      if (kind !== 'any' && kind !== routeKind) continue;
      const score = Math.min(match(route.url), match(route.file));
      if (score === 3) continue;
      const label = `${routeKind} ${location(route.file, route.line ?? 1)}`;
      hits.push({ score, references: this.fetches.get(route.id)?.length ?? 0, file: route.file,
        row: { ...row(`${label} ${route.url}`, route.file), pathEnd: label.length } });
    }
    hits.sort((a, b) => a.score - b.score || b.references - a.references ||
      compare(a.file, b.file) || compare(a.row.text, b.row.text));
    return {
      title: `${JSON.stringify(text)} kind=${kind}`, rows: hits.map(hit => hit.row),
      notes: hits.length || expired() ? [] : this.suggestions(text, kind === 'any' ? undefined : kind === 'route' ? 'page' : kind, expired)
    };
  }

  private renders(symbol: SymbolEntry, direct: boolean, expired: () => boolean): Result {
    const reached = new Map<number, { route: Route; layout: boolean; chain: string[]; conditional: boolean; depth: number }>();
    const pending = [{ id: symbol.id, chain: [] as string[], conditional: false, depth: 0 }];
    const visited = new Set<number>();
    for (let i = 0; i < pending.length && !expired(); i++) {
      const entry = pending[i];
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      for (const { route, layout } of this.pageRoots.get(entry.id) ?? []) {
        if (!entry.depth) continue;
        const previous = reached.get(route.id);
        if (!previous || (previous.layout && !layout)) reached.set(route.id, { ...entry, route, layout });
      }
      for (const [from, , , conditional] of this.incoming.get(entry.id) ?? []) {
        if (expired()) break;
        if (visited.has(from)) continue;
        const parent = this.symbols.get(from);
        pending.push({
          id: from, chain: parent ? [parent.name, ...entry.chain].slice(-2) : entry.chain,
          depth: entry.depth + 1, conditional: entry.conditional || !!conditional
        });
      }
    }
    const rows = [...reached.values()].sort((a, b) => byRoute(a.route, b.route)).map(entry => {
      const { route, chain, depth, layout, conditional } = entry;
      const fileLabel = location(route.file, route.line ?? 1);
      const url = shorten(route.url, 0, Math.max(16, 340 - bytes(fileLabel))) ?? '...';
      const label = `${url}  ${fileLabel}`;
      const via = depth <= 2 && ((layout && route.layouts?.some(id => this.symbols.get(id)?.name === chain[0])) ||
        chain[0] === this.symbols.get(route.component ?? 0)?.name) ? chain.slice(1) : chain;
      return { ...row(`${label}  depth ${depth}${via.length ? ' via ' + via.join(' > ') : ''}` +
        (layout ? ' [via layout]' : '') + (conditional ? ' [cond]' : '') + flagTest(route.file), route.file), pathEnd: label.length };
    });
    const count = `${rows.length} ${rows.length === 1 ? 'route' : 'routes'}`;
    if (direct) {
      const parents = new Map<number, { symbol: SymbolEntry; line: number; conditional: number }>();
      for (const [from, , line, conditional] of this.incoming.get(symbol.id) ?? []) {
        if (expired()) break;
        const parent = this.symbols.get(from);
        const prior = parents.get(from);
        if (parent && (!prior || line < prior.line)) parents.set(from, { symbol: parent, line, conditional });
      }
      for (const { symbol, line, conditional } of [...parents.values()].sort((a, b) => bySymbol(a.symbol, b.symbol))) {
        const label = `direct ${location(symbol.file, line)}#${symbol.name}`;
        rows.push({ ...row(label + flagTest(symbol.file) + (conditional ? ' [cond]' : ''), symbol.file), pathEnd: label.length });
      }
    }
    const directCount = rows.length - reached.size;
    const directLabel = directCount ? `, ${directCount} direct ${directCount === 1 ? 'entry' : 'entries'}` : '';
    return { rows, count: rows.length ? count + directLabel : undefined };
  }

  private wrappers(route: Route, includeExternal: boolean, expired: () => boolean): Result {
    const chains = this.index.branches?.[route.id] ?? [this.index.routeWrap[route.id]];
    const files = new Set<string>();
    const notes = [row('# not wrappers: rendered inside the page')];
    if (!includeExternal) notes.push(row('# external non-provider wrappers excluded'));
    const isProvider = (item: QueryIndex['wrapChains'][string][number]) =>
      item.provider ?? item.symbol.endsWith('Provider');
    const rows = chains.flatMap((id, branch) => {
      if (expired()) return [];
      const items = (this.index.wrapChains[id] ?? []).filter(item => includeExternal || isProvider(item) || !item.external);
      const groups = group(items, item => item.file);
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
      let order = 0;
      for (const [file, items] of groups) {
        if (expired()) break;
        const components = items.filter(item => !(item.providerTag ?? item.provider));
        const providers = items.filter(item => item.providerTag ?? item.provider);
        const label = `${++order} ${location(file, (components[0] ?? items[0]).line)}`;
        files.add(file);
        const symbols = [...new Set(components.map(name))];
        const providerNames = [...new Set(providers.map(name))];
        entries.push({ ...row(label + (symbols.length ? ` ${symbols.join(', ')}` : '') +
          (providerNames.length ? ` providers: ${providerNames.join(', ')}` : '') +
          (items.some(item => item.conditional) ? ' [cond]' : '') + flagTest(file), file), pathEnd: label.length });
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
      notes };
  }

  private rename(symbol: SymbolEntry, includeTests: boolean, expired: () => boolean): Result {
    const label = `decl ${location(symbol.file, symbol.line)}`;
    const rows = [{ ...row(label + flagTest(symbol.file), symbol.file), pathEnd: label.length }];
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
    const scoped = references.filter(ref => ref[1] !== symbol.file && (includeTests || !testFile(ref[1])));
    const passthrough = scoped.filter(exportStar);
    const uses = group(scoped.filter(ref => !exportStar(ref)), ref => ref[1]);
    for (const [file, refs] of [...uses].sort(([a], [b]) => Number(testFile(a)) - Number(testFile(b)) || compare(a, b))) {
      if (expired()) break;
      const lines = [...new Set(refs.map(ref => ref[2]))].sort((a, b) => a - b);
      const label = `use  ${file}:${lines.slice(0, 5).join(',')}`;
      const details = [...new Set(refs.flatMap(ref => ref[4] ?? (ref[3] === 're-export' ? 're-export' : [])))].sort();
      rows.push({ ...row(label + (lines.length > 5 ? ` +${lines.length - 5}` : '') +
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
    return { rows, count: `${rows.length} files`, notes };
  }

  private consumers(route: Route, levels: number, includeTests: boolean, expired: () => boolean): Result {
    const rows: Row[] = [];
    const senders = new Set<string>();
    const generatedSenders = new Set<string>();
    const calls = new Set<string>();
    let owners = new Set<number>();
    const fetches = (this.fetches.get(route.id) ?? []).filter(fetch => includeTests || !testFile(fetch.file))
      .sort((a, b) => Number(generatedFile(a.file)) - Number(generatedFile(b.file)) ||
        compare(a.file, b.file) || a.line - b.line || compare(a.method, b.method) || compare(a.via, b.via));
    for (const fetch of fetches) {
      if (expired()) break;
      senders.add(fetch.file);
      const generated = generatedFile(fetch.file);
      if (generated) generatedSenders.add(fetch.file);
      const label = `send   ${location(fetch.file, fetch.line)}`;
      const text = `${label} ${fetch.fn ? fetch.fn + ' ' : ''}${fetch.method} ${fetch.via}` +
        (fetch.partial ? ' [partial url]' : '') + flagTest(fetch.file) + (generated ? ' [generated]' : '');
      rows.push({ ...row(text, fetch.file), pathEnd: label.length });
      if (fetch.owner !== undefined) owners.add(fetch.owner);
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
        calls.add(file);
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
      (route.url.startsWith(other.url + '/') || other.url.startsWith(route.url + '/') ||
        other.url.slice(0, other.url.lastIndexOf('/')) === route.url.slice(0, route.url.lastIndexOf('/'))))
      .map(other => other.url))].sort().slice(0, 5);
    const senderCount = `${senders.size} sender${senders.size === 1 ? '' : 's'}` +
      (generatedSenders.size ? ` (${generatedSenders.size} generated)` : '');
    return {
      title: `${route.url} -> ${location(route.file, route.line ?? 1)}`, rows, targets: [route.file],
      count: rows.length ? `${senderCount}, ${calls.size} callers` : undefined,
      partial: this.index.coverage !== 2 ? 'regenerate legacy index' :
        fetches.some(fetch => fetch.dynamic) ? 'dynamic URL' :
        fetches.some(fetch => fetch.partial) ? 'uncertain URL matches' :
        moreCallers ? 'caller depth limit' : undefined,
      notes: similar.length ? [row(`# similar routes not matched: ${similar.join(', ')}`)] : []
    };
  }

  private actionConsumers(action: ServerAction, includeTests: boolean, expired: () => boolean): Result {
    const callers = group(action.callers.filter(([file]) => includeTests || !testFile(file)), ([file]) => file);
    const rows: Row[] = [];
    for (const [file, uses] of [...callers].sort(([a], [b]) => compare(a, b))) {
      if (expired()) break;
      const lines = [...new Set(uses.map(([, line]) => line))].sort((a, b) => a - b);
      const label = `call   ${location(file, lines[0])}`;
      rows.push({ ...row(label + (lines.length > 1 ? ',' + lines.slice(1, 5).join(',') : '') +
        (lines.length > 5 ? ` +${lines.length - 5}` : '') + flagTest(file), file), pathEnd: label.length });
    }
    return {
      title: actionLocation(action),
      rows, targets: [action.file], count: `${callers.size} caller ${callers.size === 1 ? 'file' : 'files'}`,
      scope: 'indexed server action callers'
    };
  }

  query(name: string, value: unknown) {
    const args = validate(name, value);
    const { tool, target } = args;
    const deadline = performance.now() + 1850;
    const expired = () => performance.now() >= deadline;
    let result: Result = { rows: [] };
    let ambiguous = false;
    if (tool === 'search') result = this.search(target, args.filter, expired);
    else if (tool === 'who_renders' || tool === 'rename_impact') {
      const matches = this.matchSymbol(target, tool === 'who_renders');
      if (matches.length > 1) {
        ambiguous = true;
        result = { rows: matches.map(symbol => row(`${declaration(symbol)} ${symbol.kind}${flagTest(symbol.file)}`, symbol.file)), limit: 10 };
      } else if (matches.length) {
        const [symbol] = matches;
        result = tool === 'who_renders' ? this.renders(symbol, !!args.direct, expired) : this.rename(symbol, !!args.includeTests, expired);
        result.title = `${symbol.file}#${symbol.name}`;
        result.targets = [symbol.file];
      } else result.notes = this.suggestions(target.split('#').pop()!, tool === 'who_renders' ? 'component' : undefined, expired);
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
        const candidates = (this.index.serverActions ?? []).filter(action => file === undefined || action.file === file);
        const exact = candidates.filter(action => action.name === name || action.aliases?.includes(name));
        const actions = (exact.length ? exact : candidates.filter(action => actionShortName(action.name) === name))
          .sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name));
        if (actions.length > 1) {
          ambiguous = true;
          result = { rows: actions.map(action => row(`${actionLocation(action)} server action`, action.file)), limit: 10 };
        } else if (actions.length) result = this.actionConsumers(actions[0], !!args.includeTests, expired);
        else {
          result.notes = this.suggestions(name, 'action', expired, file);
          if (!this.index.serverActions) result.partial = 'regenerate legacy index';
        }
      } else result.notes = this.suggestions(target, kind, expired);
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
      const suffix = entry.files.some(stale) ? ' [stale]' : '';
      const text = shorten(entry.text, entry.pathEnd ?? 0, 400 - bytes(suffix));
      shortened ||= text !== oneLine(entry.text);
      // A path longer than the hard line cap cannot be represented intact.
      return text === undefined ? [] : [{ text: text + suffix, files: entry.files }];
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
        tool === 'search' ? 'narrow text or kind' : 'use a qualified target or adjust filters or limit'})` : '';
      const reason = expired() ? 'timed out' : ambiguous ? 'ambiguous target' :
        staleCount || snapshotStale ? 'stale index' : omitted || noteCount < (result.notes?.length ?? 0) || shortened ? 'output truncated' :
        !this.index.coverage ? 'regenerate legacy index' : result.partial ??
        (tool !== 'search' && !result.targets ? 'target unresolved' : undefined);
      const scope = result.scope ?? {
        who_renders: 'indexed JSX paths', wrappers: 'indexed wrapper chains',
        rename_impact: 'checker-resolved edit files', api_consumers: 'indexed route literals' + (args.callers ? ' and callers' : ''),
        search: 'indexed name and path matches'
      }[tool];
      const coverage = reason ? `# partial: ${reason}` : `# complete: ${scope}`;
      const output = [header, ...(notesFirst ? extras : []).map(entry => entry.text),
        ...visible.map(entry => entry.text), ...(notesFirst ? [] : extras).map(entry => entry.text), ...(more ? [more] : []), coverage].join('\n');
      if (bytes(output) <= 6000) return output;
      if (noteCount) noteCount--;
      else shown--;
    }
  }
}
