import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compare, graphRow, type ChangeOrigin, type DependencyGraph, type QueryResult, type QueryRow } from './Graph';
import type { QueryIndex, SymbolEntry } from './Index';

export type ChangeScope = 'all' | 'staged' | 'unstaged';
const maxFiles = 200;
const maxSeeds = 100;
const maxBuffer = 8 * 1024 * 1024;
export const validBase = (value: unknown): value is string =>
  typeof value === 'string' && /^(?!-)[A-Za-z0-9._/@{}~^-]{1,100}$/.test(value);
type Hunk = { line: number; added: string[]; removed: string[] };
type DiffFile = { file: string; old?: string; status: string; hunks: Hunk[] };
type Edit = { file: string; symbol?: SymbolEntry; line: number; added: number; removed: number; comment: boolean };
const config = /^(?:(?:next\.config|tsconfig)(?:\.[^/]+)?\.(?:json|[cm]?[jt]s)|package\.json|\.env[^/]*)$/;
const executable = /\.[cm]?[jt]sx?$/;
const deletedExport = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class)\s+([\w$]+)/;

function parseDiff(diff: string): DiffFile[] {
  if (!diff) return [];
  const split = diff.indexOf('\0\0');
  if (split < 0) throw new Error('Git returned an incomplete diff.');
  const fields = diff.slice(0, split).split('\0');
  const files: DiffFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++].split(' ').pop()![0];
    const name = fields[i++];
    const rename = status === 'R' || status === 'C';
    const file = rename ? fields[i++] : name;
    files.push({ status, file, old: rename ? name : undefined, hunks: [] });
  }

  // The NUL-delimited raw records carry the exact names, including tabs or
  // newlines. The patch sections follow in the same order.
  let file = -1;
  let hunk: Hunk | undefined;
  for (const line of diff.slice(split + 2).split('\n')) {
    if (line.startsWith('diff --git ')) {
      file++;
      hunk = undefined;
    } else if (line.startsWith('@@ ')) {
      const range = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!range || !files[file]) continue;
      hunk = { line: Math.max(1, Number(range[1])), added: [], removed: [] };
      files[file].hunks.push(hunk);
    } else if (hunk && line.startsWith('+')) hunk.added.push(line.slice(1));
    else if (hunk && line.startsWith('-')) hunk.removed.push(line.slice(1));
  }
  if (file + 1 !== files.length) throw new Error('Git changed while reading the diff. Retry the query.');
  return files;
}

function commentLines(lines: string[], inBlock: boolean) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !inBlock && line.startsWith('//')) continue;
    if (!inBlock && !line.startsWith('/*')) return false;
    const close = line.indexOf('*/', inBlock ? 0 : 2);
    inBlock = close < 0;
    if (!inBlock && !/^\s*(?:\/\/.*)?$/.test(line.slice(close + 2))) return false;
  }
  return true;
}

function withinBlock(lines: string[], line: number) {
  for (let i = Math.min(line - 2, lines.length - 1); i >= 0; i--) {
    const text = lines[i].trimStart();
    if (text.includes('*/')) return false;
    if (text.startsWith('/*')) return true;
    if (text && !text.startsWith('*')) return false;
  }
  return false;
}

export function changes(root: string, index: QueryIndex, graph: DependencyGraph, scope: ChangeScope, base: string | undefined,
  deadline: number, checkPath: (file: string) => string): QueryResult {
  const expired = () => performance.now() >= deadline;
  const git = (args: string[], input?: string) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', input, timeout: Math.max(1, Math.min(3000, Math.floor(deadline - performance.now()))),
    maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const known = (ref: string) => {
    try {
      const result = git(['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}']).trim();
      return /^[a-f0-9]{40,64}$/.test(result) ? result : undefined;
    } catch (error) {
      if ((error as { status?: number }).status === 1) return;
      throw error;
    }
  };
  const title = base ? `merge-base ${base}` : scope === 'all' ? 'HEAD (staged+unstaged)' : scope;
  const empty = (partial: string): QueryResult => ({ title, rows: [], targets: [], count: '0 files, 0 symbols, 0 routes', partial });
  let prefix: string;
  try {
    if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return empty('not a git repository');
    prefix = git(['rev-parse', '--show-prefix']).replace(/\r?\n$/, '');
  } catch (error) {
    const failure = error as { code?: string; stderr?: string };
    if (failure.code === 'ENOENT') return empty('git unavailable');
    if (expired() || failure.code === 'ETIMEDOUT') return empty('timed out');
    if (/not a git repository/i.test(failure.stderr ?? '')) return empty('not a git repository');
    return empty('could not read git repository');
  }

  let files: DiffFile[];
  const localChanges = new Set<string>();
  try {
    let refs: string[] = [];
    if (base) {
      const commit = known(base);
      if (!commit) return empty(`invalid base ref ${base}`);
      try {
        const ancestor = git(['merge-base', commit, 'HEAD']).trim();
        if (!/^[a-f0-9]{40,64}$/.test(ancestor)) return empty('no merge base with HEAD');
        refs = [ancestor];
      } catch (error) {
        if ((error as { status?: number }).status === 1) return empty('no merge base with HEAD');
        throw error;
      }
    } else if (scope === 'staged') refs = ['--cached'];
    else if (scope === 'all') refs = [known('HEAD') ?? git(['hash-object', '-t', 'tree', '--stdin'], '').trim()];
    const diff = git(['diff', '--raw', '-z', '-p', '-U0', '--inter-hunk-context=0', '-M', '--no-relative', '--no-ext-diff', '--no-textconv',
      '--no-color', '--submodule=short', ...refs, '--']);
    files = parseDiff(diff);
    if (scope === 'staged' && files.length) {
      for (const file of git(['diff', '--name-only', '-z', '--no-relative', '--no-ext-diff', '--no-renames', '--']).split('\0')) {
        if (file) localChanges.add(file);
      }
    }
    if (!base && (scope !== 'staged' || files.some(entry => entry.status === 'D' || entry.status === 'R'))) {
      for (const file of git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/']).split('\0')) {
        if (!file) continue;
        if (scope === 'staged') localChanges.add(file);
        else files.push({ file, status: '?', hunks: [] });
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (expired() || code === 'ETIMEDOUT') return empty('timed out');
    if (code === 'ENOBUFS') return empty('diff too large (8 MB git output limit)');
    return empty(error instanceof Error && error.message.startsWith('Git ') ? error.message : 'git diff failed');
  }

  const outside = files.filter(({ file, old }) => !file.startsWith(prefix) && !old?.startsWith(prefix)).length;
  files = files.flatMap<DiffFile>(entry => {
    const file = entry.file.startsWith(prefix) ? entry.file.slice(prefix.length) : undefined;
    const old = entry.old?.startsWith(prefix) ? entry.old.slice(prefix.length) : undefined;
    if (!file) return old && entry.status === 'R' ? [{ file: old, status: 'D', hunks: [] }] : [];
    return [{ ...entry, file, old, status: entry.status === 'R' && !old ? 'A' : entry.status }];
  }).sort((a, b) => compare(a.file, b.file));
  const totalFiles = files.length;
  const worktreeDiffers = ({ file, old }: DiffFile) => localChanges.has(prefix + file) ||
    (old !== undefined && localChanges.has(prefix + old));
  const stagedDrift = files.some(worktreeDiffers);
  const byFile = new Map<string, SymbolEntry[]>();
  const relevant = new Set(files.slice(0, maxFiles).map(entry => entry.file));
  for (const symbol of index.symbols) {
    if (!relevant.has(symbol.file)) continue;
    const items = byFile.get(symbol.file);
    if (items) items.push(symbol);
    else byFile.set(symbol.file, [symbol]);
  }
  for (const symbols of byFile.values()) symbols.sort((a, b) =>
    (a.end ?? a.line) - a.line - ((b.end ?? b.line) - b.line) || b.line - a.line || compare(a.name, b.name));
  const modified = new Map<string, Edit>();
  const seeds = new Map<string, ChangeOrigin>();
  const changes: QueryRow[] = [];
  const notes: QueryRow[] = [];
  const touched = new Set<string>();
  let configFiles = 0;
  let actionCount = 0;
  let limited = false;
  let untrackedBytes = 0;
  const stats = (edit: Edit) => `+${edit.added} -${edit.removed}`;
  const useSeed = (file: string, name: string, ids: ChangeOrigin['ids'], symbol?: number) => {
    if (!ids.length) return;
    const key = JSON.stringify([file, symbol ?? null, name]);
    if (seeds.has(key)) return;
    if (seeds.size >= maxSeeds) {
      limited = true;
      return;
    }
    seeds.set(key, { file, name, ids });
  };
  const registered = (file: string) => Object.prototype.hasOwnProperty.call(index.files, file);
  const layout = (file: string) => Object.prototype.hasOwnProperty.call(index.routeFiles!, file) &&
    ['layout', 'template', 'app-shell'].includes(index.routeFiles![file][0]);

  for (const entry of files.slice(0, maxFiles)) {
    if (expired()) break;
    const { file, status, old } = entry;
    const indexes = byFile.get(file) ?? [];
    const worktree = worktreeDiffers(entry) ? ' [worktree differs]' : '';
    touched.add(file);
    if (status === 'D') {
      const isConfig = config.test(file);
      if (isConfig) configFiles++;
      changes.push(graphRow(`deleted ${file}${isConfig ? ' [config: all routes]' : ''}${worktree}`, file));
      continue;
    }
    if (old && old !== file) changes.push(graphRow(`renamed ${old} -> ${file}${worktree}`, file));

    if (status === '?' && (executable.test(file) || file.endsWith('.css'))) {
      try {
        const absolute = checkPath(file);
        const stat = lstatSync(absolute);
        if (stat.isFile()) {
          untrackedBytes += stat.size;
          if (untrackedBytes > maxBuffer) limited = true;
          else {
            const contents = readFileSync(absolute, 'utf8');
            if (!contents.includes('\0')) {
              const added = contents.replace(/\r?\n$/, '').split(/\r?\n/);
              entry.hunks.push({ line: 1, added, removed: [] });
            }
          }
        }
      } catch {
        // An untracked file may disappear or be a symlink outside the root.
      }
    }

    let sourceLines: string[] | undefined;
    const commentOnly = (hunk: Hunk) => {
      if (commentLines(hunk.added, false) && commentLines(hunk.removed, false)) return true;
      if (![...hunk.added, ...hunk.removed].some(line => /^\s*\*(?:\s|\/|$)/.test(line))) return false;
      if (!sourceLines) {
        sourceLines = [];
        try {
          const absolute = checkPath(file);
          const stat = lstatSync(absolute);
          if (stat.isFile() && stat.size <= maxBuffer) sourceLines = readFileSync(absolute, 'utf8').split('\n');
        } catch {
          // A missing source file cannot confirm a block comment.
        }
      }
      return withinBlock(sourceLines, hunk.line) && commentLines(hunk.added, true) && commentLines(hunk.removed, true);
    };
    const substantive: Hunk[] = [];
    const commentHunks: Hunk[] = [];
    for (const hunk of entry.hunks) (commentOnly(hunk) ? commentHunks : substantive).push(hunk);
    const record = (line: number, comment: boolean, added: number, removed: number) => {
      const symbol = indexes.find(symbol => symbol.line <= line && line <= (symbol.end ?? symbol.line));
      const key = JSON.stringify([file, symbol?.id, comment]);
      const edit = modified.get(key) ?? { file, symbol, line, added: 0, removed: 0, comment };
      edit.added += added;
      edit.removed += removed;
      edit.line = Math.min(edit.line, line);
      modified.set(key, edit);
    };
    for (const hunk of commentHunks) {
      record(hunk.line, true, hunk.added.length, hunk.removed.length);
    }
    if (!substantive.length && commentHunks.length && !old) continue;
    if (config.test(file)) {
      configFiles++;
      changes.push(graphRow(`file ${file} [config: all routes]${worktree}`, file));
      continue;
    }
    if (/(?:^|\/)prisma\/schema\.prisma$/.test(file)) {
      changes.push(graphRow(`file ${file} [schema]${worktree}`, file));
      continue;
    }
    const styles = Object.prototype.hasOwnProperty.call(index.layoutStyles!, file) ? index.layoutStyles![file] : [];
    if (styles.length) {
      changes.push(graphRow(`file ${file} [layout stylesheet]${worktree}`, file));
      for (const style of styles) useSeed(style, file, graph.moduleSeeds(style));
      continue;
    }
    if (!registered(file) && !graph.moduleSeeds(file).length) {
      changes.push(graphRow(`file ${file} [not indexed]${worktree}`, file));
      continue;
    }
    if (!substantive.length && (old || !entry.hunks.length)) {
      useSeed(file, file, old ? graph.fileSeeds(file) : graph.moduleSeeds(file));
      if (!old) changes.push(graphRow(`file ${file}${worktree}`, file));
    }
    for (const hunk of substantive) {
      if (expired()) break;
      const removed = new Set(hunk.removed.flatMap(line => deletedExport.exec(line)?.[1] ?? [])
        .filter(name => !indexes.some(symbol => symbol.name === name)));
      for (const name of removed) changes.push(graphRow(`removed ${file} ${name}${worktree}`, file));
      for (let i = 0; i < hunk.added.length; i++) record(hunk.line + i, false, 1, 0);
      if (!removed.size || hunk.added.length) {
        for (let i = 0; i < hunk.removed.length; i++) record(hunk.line + Math.max(0, Math.min(i, hunk.added.length - 1)), false, 0, 1);
      }
    }
  }

  const changedSymbols = new Set<number>();
  for (const edit of [...modified.values()].sort((a, b) => compare(a.file, b.file) || a.line - b.line ||
    Number(a.comment) - Number(b.comment))) {
    const { file, symbol, line } = edit;
    const worktree = localChanges.has(prefix + file) ? ' [worktree differs]' : '';
    if (edit.comment) {
      changes.push(graphRow(`comment ${file}:${line} ${symbol?.name ?? ''} [comment only]${worktree}`, file));
      continue;
    }
    if (symbol) {
      changedSymbols.add(symbol.id);
      const action = graph.action(symbol.id);
      if (action) actionCount++;
      const flags = (action ? ' [action]' : '') + (layout(file) ? ' [layout]' : '') +
        (index.routeFiles![file]?.[0] === 'middleware' ? ' [middleware]' : '');
      changes.push(graphRow(`changed ${file}:${symbol.line}${symbol.end && symbol.end !== symbol.line ? '-' + symbol.end : ''} ${symbol.name}${flags} ${stats(edit)}${worktree}`, file));
      useSeed(file, symbol.name, [symbol.id], symbol.id);
    } else {
      changes.push(graphRow(`file ${file}:${line} ${stats(edit)}${worktree}`, file));
      useSeed(file, file, graph.moduleSeeds(file));
    }
  }

  const trace = graph.changeRoutes([...seeds.values()], expired);
  const rows: QueryRow[] = [];
  for (const wrapper of trace.wrappers) {
    const urls = [...new Set(wrapper.pages.map(page => page.url))].sort(compare);
    rows.push(graphRow(`wraps ${wrapper.name} : ${wrapper.pages.length} routes` +
      (urls.length ? ` (${urls.slice(0, 3).join(', ')}${urls.length > 3 ? ', +' + (urls.length - 3) : ''})` : ''), wrapper.file));
  }
  const pageFiles = new Set<string>();
  const apiFiles = new Set<string>();
  const otherFiles = new Set<string>();
  const possibleFiles = new Set<string>();
  for (const { terminal, origins } of trace.routes) {
    const { kind, name, file } = terminal;
    if (kind === 'middleware') {
      rows.push(graphRow(`middleware ${file}  all matched routes${name === '/' ? '' : ` (matcher: ${name})`}`, file));
      continue;
    }
    if (kind === 'api') apiFiles.add(file);
    else if (kind === 'page') pageFiles.add(file);
    else otherFiles.add(file);
    if (origins.every(origin => origin.possible)) possibleFiles.add(file);
    const labels = origins.slice(0, 3).map(({ origin, depth, fetch, possible }) =>
      `${origin.name} d${depth}${fetch ? ` via fetch ${fetch}` : ''}${possible ? ' [possible]' : ''}`);
    const chain = ` <- ${labels.join(', ')}${origins.length > 3 ? ', +' + (origins.length - 3) : ''}`;
    rows.push(graphRow(`route ${kind} ${name}  ${file}${chain}`, file));
  }
  if (configFiles) for (const route of index.routes) (route.kind === 'page' ? pageFiles : apiFiles).add(route.file);
  const routes = pageFiles.size + apiFiles.size + otherFiles.size;
  const wrapperRoutes = new Set(trace.wrappers.flatMap(wrapper => wrapper.pages.map(page => page.file))).size;
  if (outside) notes.push(graphRow(`# outside project: ${outside} files`));
  if (changes.length > 500) limited = true;
  notes.push(graphRow(`# risk: ${changedSymbols.size} changed symbols (${actionCount} actions); ${routes} routes reached (${pageFiles.size} page, ${apiFiles.size} api${otherFiles.size ? `, ${otherFiles.size} special` : ''}); ` +
    `${possibleFiles.size ? `${possibleFiles.size} possible; ` : ''}${wrapperRoutes} routes under touched wrappers; ${configFiles} config files`));
  const diffScope = base ? `merge-base(${base}, HEAD)` : scope === 'all' ? 'HEAD' : scope === 'staged' ? '--cached' : '(worktree)';
  const tracePartial = totalFiles > maxFiles || limited ? `diff too large (up to ${maxFiles} files and ${maxSeeds} impact origins)` : trace.partial;
  const partial = [stagedDrift ? 'worktree differs from staged' : undefined, tracePartial].filter(Boolean).join('; ') || undefined;
  return {
    title, rows: [...rows, ...changes.slice(0, 500)], notes, targets: [...touched],
    count: `${totalFiles} files, ${changedSymbols.size} symbols, ${routes} routes, ${trace.wrappers.length} wrappers`,
    partial,
    scope: `git diff ${diffScope}, indexed edges, impact depth 3`
  };
}
