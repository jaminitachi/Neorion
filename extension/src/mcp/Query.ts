import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isTestFile as testFile, type FetchEntry, type QueryIndex, type Reference, type SymbolEntry } from './Index';
import { tools } from './Tools';

type Route = QueryIndex['routes'][number];
type Edge = QueryIndex['renderEdges'][number];
type Row = { text: string; files: string[]; pathEnd?: number };
type Result = { rows: Row[]; title?: string; count?: string; targets?: string[]; notes?: Row[]; limit?: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const bytes = (text: string) => Buffer.byteLength(text);
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ');
const row = (text: string, ...files: string[]): Row => ({ text, files });
const location = (file: string, line: number) => `${file}:${line}`;
const declaration = (symbol: SymbolEntry) => `${location(symbol.file, symbol.line)}#${symbol.name}`;
const bySymbol = (a: SymbolEntry, b: SymbolEntry) => compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name);
const byRoute = (a: Route, b: Route) => compare(a.url, b.url) || compare(a.file, b.file);
const flagTest = (file: string) => testFile(file) ? ' [test]' : '';
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

function validate(name: string, value: unknown): Record<string, string | number | boolean> {
  const tool = tools.find(tool => tool.name === name);
  if (!tool) throw new Error('Unknown Neorion tool.');
  const { properties, required } = tool.inputSchema;
  const spec = properties as unknown as Record<string, {
    type: string; minLength?: number; maxLength?: number; enum?: string[]; minimum?: number; maximum?: number;
    default?: string | number | boolean;
  }>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an arguments object.');
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) throw new Error(`Unexpected argument ${oneLine(key).slice(0, 80)}.`);
  }
  const args: ReturnType<typeof validate> = {};
  for (const [key, rule] of Object.entries(spec)) {
    const original = (value as Record<string, unknown>)[key];
    const input: unknown = original === undefined ? rule.default : original;
    if (input === undefined && !required.includes(key)) continue;
    if (typeof input !== (rule.type === 'integer' ? 'number' : rule.type) ||
        (typeof input === 'string' && ([...input].length < (rule.minLength ?? 0) ||
          [...input].length > (rule.maxLength ?? Infinity) || (rule.enum && !rule.enum.includes(input)))) ||
        (typeof input === 'number' && (!Number.isInteger(input) || input < rule.minimum! || input > rule.maximum!))) {
      throw new Error(`Invalid argument ${key}.`);
    }
    args[key] = input as string | number | boolean;
  }
  return args;
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

  private matchSymbol(text: string, component: boolean) {
    const delimiter = text.lastIndexOf('#');
    const file = delimiter < 0 ? undefined : path.posix.normalize(text.slice(0, delimiter));
    if (file !== undefined) this.checkPath(text.slice(0, delimiter));
    else if (/[\\/]/.test(text)) throw new Error('Use a name or an app-relative path#Name.');
    return (this.names.get(text.slice(delimiter + 1)) ?? [])
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

  private suggestions(text: string, kind: string | undefined, expired: () => boolean): Row[] {
    const needle = text.toLowerCase().slice(0, 100);
    const candidates = kind === 'page' || kind === 'api'
      ? this.index.routes.filter(route => route.kind === kind).map(route =>
        ({ name: route.url, label: `${route.url} ${location(route.file, route.line ?? 1)}`, file: route.file }))
      : this.index.symbols.filter(symbol => !kind || symbol.kind === kind).map(symbol =>
        ({ name: symbol.name, label: declaration(symbol), file: symbol.file }));
    const matches: (typeof candidates[number] & { score: number })[] = [];
    const threshold = Math.max(2, Math.floor(needle.length / 3));
    for (const candidate of candidates) {
      if (expired()) break;
      const name = candidate.name.toLowerCase().slice(0, 100);
      if (Math.abs(name.length - needle.length) > threshold) continue;
      const score = distance(needle, name);
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
    const rows = chains.flatMap((id, branch) => {
      if (expired()) return [];
      const groups = group((this.index.wrapChains[id] ?? []).filter(item => includeExternal || !item.external), item => item.file);
      const entries: Row[] = [];
      if (chains.length > 1) entries.push(row(`branch ${String.fromCharCode(65 + branch)}`));
      let order = 0;
      for (const [file, items] of groups) {
        if (expired()) break;
        const label = `${++order} ${location(file, items[0].line)}`;
        files.add(file);
        const symbols = items.map(item => item.external ? `${item.external}#${item.symbol}` : item.symbol);
        entries.push({ ...row(`${label} ${[...new Set(symbols)].join(', ')}` +
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
    return { rows, title: route.url, count: `${files.size} files, 1 page`, targets: [route.file],
      notes: [row('# not wrappers: rendered inside the page')] };
  }

  private rename(symbol: SymbolEntry, includeTests: boolean, expired: () => boolean): Result {
    const label = `decl ${location(symbol.file, symbol.line)}`;
    const rows = [{ ...row(label + flagTest(symbol.file), symbol.file), pathEnd: label.length }];
    const references = this.references.get(symbol.id) ?? [];
    const uses = group(references.filter(ref => ref[1] !== symbol.file && (includeTests || !testFile(ref[1]))), ref => ref[1]);
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
    return { rows, count: `${rows.length} files`, notes };
  }

  private consumers(route: Route, levels: number, includeTests: boolean, expired: () => boolean): Result {
    const rows: Row[] = [];
    const senders = new Set<string>();
    const calls = new Set<string>();
    let owners = new Set<number>();
    const fetches = (this.fetches.get(route.id) ?? []).filter(fetch => includeTests || !testFile(fetch.file))
      .sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.method, b.method) || compare(a.via, b.via));
    const seenSends = new Set<string>();
    for (const fetch of fetches) {
      if (expired()) break;
      senders.add(fetch.file);
      const label = `send   ${location(fetch.file, fetch.line)}`;
      const text = `${label} ${fetch.fn ? fetch.fn + ' ' : ''}${fetch.method} ${fetch.via}` +
        (fetch.partial ? ' [partial url]' : '') + flagTest(fetch.file);
      if (!seenSends.has(text)) rows.push({ ...row(text, fetch.file), pathEnd: label.length });
      seenSends.add(text);
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
    const similar = [...new Set(this.index.routes.filter(other => other.kind === 'api' && other.url !== route.url &&
      (route.url.startsWith(other.url + '/') || other.url.startsWith(route.url + '/') ||
        other.url.slice(0, other.url.lastIndexOf('/')) === route.url.slice(0, route.url.lastIndexOf('/'))))
      .map(other => other.url))].sort().slice(0, 5);
    return {
      title: `${route.url} -> ${location(route.file, route.line ?? 1)}`, rows, targets: [route.file],
      count: rows.length ? `${senders.size} sender${senders.size === 1 ? '' : 's'}, ${calls.size} callers` : undefined,
      notes: similar.length ? [row(`# similar routes not matched: ${similar.join(', ')}`)] : []
    };
  }

  query(name: string, value: unknown) {
    const args = validate(name, value);
    const tool = name.slice('neorion_'.length);
    const target = String(args.component ?? args.symbol ?? args.route ?? args.text).trim();
    if (!target) throw new Error('Enter a nonempty query target.');
    const deadline = performance.now() + 1850;
    const expired = () => performance.now() >= deadline;
    let result: Result = { rows: [] };
    let ambiguous = false;
    if (tool === 'search') result = this.search(target, String(args.kind), expired);
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
      const routes = this.matchRoute(target, kind);
      if (routes.length > 1) {
        ambiguous = true;
        result = { rows: routes.map(route => row(`${location(route.file, route.line ?? 1)}#${route.url} ${route.kind}`, route.file)), limit: 10 };
      } else if (routes.length) result = tool === 'wrappers'
        ? this.wrappers(routes[0], !!args.includeExternal, expired)
        : this.consumers(routes[0], Number(args.callers), !!args.includeTests, expired);
      else result.notes = this.suggestions(target, kind, expired);
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
    const maxRows = result.limit ?? Number(args.limit);
    const notesFirst = tool === 'wrappers';
    const renderedRows: { text: string; files: string[] }[] = [];
    const renderRow = (entry: Row) => {
      const suffix = entry.files.some(stale) ? ' [stale]' : '';
      const text = shorten(entry.text, entry.pathEnd ?? 0, 400 - bytes(suffix));
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
      const output = [header, ...(notesFirst ? extras : []).map(entry => entry.text),
        ...visible.map(entry => entry.text), ...(notesFirst ? [] : extras).map(entry => entry.text), ...(more ? [more] : [])].join('\n');
      if (bytes(output) <= 6000) return output;
      if (noteCount) noteCount--;
      else shown--;
    }
  }
}
