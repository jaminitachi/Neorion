import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compare, graphRow, moduleStops, quantity, type ChangeOrigin, type DependencyGraph, type QueryResult, type QueryRow } from './Graph';
import { routeAsset, sourceFile } from '../core/HistoryInputs';
import { traceHistory, type ImportEdit, type Removal } from './ChangesHistory';
import { isMiddlewareFile, type QueryIndex, type SymbolEntry } from './Index';

export type ChangeScope = 'all' | 'staged' | 'unstaged';
const maxFiles = 200;
const maxSeeds = 100;
const maxBuffer = 8 * 1024 * 1024;
export const validBase = (value: unknown): value is string =>
  typeof value === 'string' && /^(?!-)[A-Za-z0-9._/@{}~^-]{1,100}$/.test(value);
type Hunk = { line: number; oldLine: number; added: string[]; removed: string[] };
type DiffFile = { file: string; old?: string; status: string; hunks: Hunk[] };
type Edit = { file: string; symbol?: SymbolEntry; line: number; added: number; removed: number; comment: boolean };
const config = /^(?:(?:next\.config|tsconfig)(?:\.[^/]+)?\.(?:json|[cm]?[jt]s)|package\.json|\.env[^/]*)$/;
const identifier = /[$a-zA-Z_][\w$]*/.source;
const argument = /(?:[$a-zA-Z_][\w$]*|\d+(?:\.\d+)?|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|\/(?:\\[a-zA-Z]|[a-zA-Z\d+^$. -])+\/[dgimsuvy]*)/.source;
const call = '\\([ \\t]*(?:' + argument + '(?:[ \\t]*,[ \\t]*' + argument + ')*)?[ \\t]*\\)';
const simpleReturn = new RegExp('^[ \\t]+return[ \\t]+' + identifier + '(?:' + call + ')?(?:\\.' + identifier + '(?:' + call + ')?)*;[ \\t]*\\r?$');

function simpleBodyEdit({ added, removed, line }: Hunk, symbols: SymbolEntry[]) {
  // Both lines must be self-contained return expressions. Leave syntax that
  // could affect exports, comments or multiline tokens to the parser.
  return added.length === 1 && removed.length === 1 &&
    symbols.some(symbol => symbol.kind === 'function' && symbol.line < line && line < (symbol.end ?? line)) &&
    [added[0], removed[0]].every(text => text.length < 1024 &&
      !/[\x60{}<>\u2028\u2029]|\/[/*]|\*\//.test(text) && simpleReturn.test(text));
}

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
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!range || !files[file]) continue;
      hunk = { line: Number(range[2]), oldLine: Math.max(1, Number(range[1])), added: [], removed: [] };
      files[file].hunks.push(hunk);
    } else if (hunk && line.startsWith('+')) hunk.added.push(line.slice(1));
    else if (hunk && line.startsWith('-')) hunk.removed.push(line.slice(1));
  }
  if (file + 1 !== files.length) throw new Error('Git changed while reading the diff. Retry the query.');
  return files;
}

export function changes(root: string, index: QueryIndex, graph: DependencyGraph, scope: ChangeScope, base: string | undefined,
  depth: number, deadline: number, checkPath: (file: string) => string): QueryResult {
  const expired = () => performance.now() >= deadline;
  const gitBytes = (args: string[], input?: Buffer, buffer = maxBuffer) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, input, timeout: Math.max(1, Math.min(3000, Math.floor(deadline - performance.now()))),
    maxBuffer: buffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const git = (args: string[], input?: string) => gitBytes(args, input === undefined ? undefined : Buffer.from(input)).toString('utf8');
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
  let comparison: string | undefined;
  const localChanges = new Set<string>();
  try {
    let refs: string[] = [];
    if (base) {
      const shallow = () => git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
      const shallowHelp = 'shallow repository history; run git fetch --unshallow or use a reachable ref';
      const commit = known(base);
      if (!commit) {
        if (shallow()) {
          const ancestor = /^([^~^]+)(?:[~^]\d*)+$/.exec(base)?.[1];
          const hint = ancestor && known(ancestor) || /^[a-f0-9]{7,64}$/i.test(base) ? shallowHelp : 'use a reachable ref';
          return empty(`invalid base ref ${base}; ${hint}`);
        }
        const count = known('HEAD') ? git(['rev-list', '--max-count=2', 'HEAD', '--']).trim().split('\n').length : 0;
        const hint = count === 0 ? 'repository has no commits' :
          count === 1 ? 'only one commit is available; use a reachable ref or fetch more history' : 'use a reachable ref';
        return empty(`invalid base ref ${base}; ${hint}`);
      }
      try {
        const ancestor = git(['merge-base', commit, 'HEAD']).trim();
        if (!/^[a-f0-9]{40,64}$/.test(ancestor)) return empty(shallow() ? `no merge base with HEAD; ${shallowHelp}` : 'no merge base with HEAD');
        comparison = ancestor;
        refs = [comparison];
      } catch (error) {
        if ((error as { status?: number }).status === 1) return empty(shallow() ? `no merge base with HEAD; ${shallowHelp}` : 'no merge base with HEAD');
        throw error;
      }
    } else if (scope !== 'unstaged') {
      comparison = known('HEAD') ?? git(['hash-object', '-t', 'tree', '--stdin'], '').trim();
      refs = scope === 'staged' ? ['--cached', comparison] : [comparison];
    }
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
    if (!base && scope !== 'staged') {
      const seen = new Set(files.map(entry => entry.file));
      const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--full-name', '-z', '--',
        `:(top,glob)${prefix.replace(/([*?\[\]\\])/g, '\\$1')}.env*`]);
      for (const file of ignored.split('\0')) if (file && !seen.has(file) && config.test(file.slice(prefix.length))) {
        files.push({ file, status: '?', hunks: [] });
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (expired() || code === 'ETIMEDOUT') return empty('timed out');
    if (code === 'ENOBUFS') return empty('diff too large (8 MB git output limit)');
    return empty(error instanceof Error && error.message.startsWith('Git ') ? error.message : 'git diff failed');
  }

  const repositoryPath = (file: string) => posix.normalize(prefix + file);
  const workspace = index.workspaceSources;
  const packagePrefixes = (workspace && /^\.\.(?:\/\.\.){0,7}$/.test(workspace.offset) ? workspace.packages : [])
    .filter(directory => !/^(?:apps|example-apps)\//.test(directory))
    .map(directory => repositoryPath(workspace!.offset + '/' + directory + '/'));
  const appPath = (file: string) => file.startsWith(prefix) ? file.slice(prefix.length) :
    packagePrefixes.some(directory => file.startsWith(directory)) ? posix.relative(prefix || '.', file) : undefined;
  const workspaceConfig = (file: string) => file.startsWith('../') ? config.test(posix.basename(file)) : config.test(file);
  const rootPackage = !!prefix && files.some(entry => entry.file === 'package.json' || entry.old === 'package.json');
  const outside = files.filter(({ file, old }) => appPath(file) === undefined && (!old || appPath(old) === undefined) &&
    file !== 'package.json' && old !== 'package.json').length;
  files = files.flatMap<DiffFile>(entry => {
    const file = appPath(entry.file);
    const old = entry.old && appPath(entry.old);
    if (!file) return old && entry.status === 'R' ? [{ file: old, status: 'D', hunks: [] }] : [];
    return [{ ...entry, file, old, status: entry.status === 'R' && !old ? 'A' : entry.status }];
  }).sort((a, b) => compare(a.file, b.file));
  const totalFiles = files.length + Number(rootPackage);
  const mayChangeRouteFiles = rootPackage || files.some(({ file, old, status }) => workspaceConfig(file) ||
    status !== 'M' && [file, old].some(path => path && /^(?:src\/)?(?:app|pages)\//.test(path)));
  const worktreeDiffers = ({ file, old }: DiffFile) => localChanges.has(repositoryPath(file)) ||
    (old !== undefined && localChanges.has(repositoryPath(old)));
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
  let configFiles = Number(rootPackage);
  let actionCount = 0;
  let limited = false;
  let untrackedBytes = 0;
  const removals: Removal[] = [];
  const importEdits = new Map<string, ImportEdit>();
  const middlewareFiles = new Map<string, string>();
  let missingSource = 0;
  let unmappedDeletions = 0;
  let unresolvedRenames = 0;
  if (rootPackage) changes.push(graphRow('file package.json [repository config: all routes]'));
  const readSource = (file: string) => {
    try {
      const absolute = checkPath(file);
      const stat = lstatSync(absolute);
      if (stat.isFile() && stat.size <= maxBuffer) return readFileSync(absolute, 'utf8');
    } catch {
      // A worktree file can disappear during the query.
    }
  };
  const show = (ref: string | undefined, file: string) => {
    try {
      return git(['show', '--no-ext-diff', '--no-textconv', `${ref ?? ''}:${prefix}${file}`]);
    } catch {
      return undefined;
    }
  };
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
      const isConfig = workspaceConfig(file);
      if (isConfig) configFiles++;
      changes.push(graphRow(`deleted ${file}${isConfig ? ' [config: all routes]' : ''}${worktree}`, file));
      if (!isConfig && (sourceFile.test(file) || routeAsset.test(file))) {
        if (show(comparison, file) === undefined) missingSource++;
        else removals.push({ file });
      } else if (!isConfig) missingSource++;
      continue;
    }
    if (old && old !== file) {
      changes.push(graphRow(`renamed ${old} -> ${file}${worktree}`, file));
      if (status === 'R' && (sourceFile.test(old) || routeAsset.test(old))) removals.push({ file: old, renamed: true });
    }

    if (status === '?' && (sourceFile.test(file) || file.endsWith('.css'))) {
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
              entry.hunks.push({ line: 1, oldLine: 1, added, removed: [] });
            }
          }
        }
      } catch {
        // An untracked file may disappear or be a symlink outside the root.
      }
    }

    const commentCandidate = (hunk: Hunk) => {
      const lines = [...hunk.added, ...hunk.removed];
      return lines.some(line => line.trim()) && lines.every(line => /^\s*(?:$|\/\/|\/\*|\*)/.test(line));
    };
    const scanComments = entry.hunks.some(commentCandidate);
    let previous: ReturnType<typeof import('../cli/graph').inspectChangeSource> | undefined;
    const removedNames = new Set<string>();
    const uncertainNames = new Set<string>();
    const removedStars = new Set<string>();
    let newCode: Set<number> | undefined;
    const middleware = isMiddlewareFile(file);
    const existing = status !== 'A' && status !== '?';
    const needsSource = scanComments || existing && (middleware || !entry.hunks.every(hunk => simpleBodyEdit(hunk, indexes)));
    let matcherChanged = true;
    if (sourceFile.test(file) && needsSource) {
      const { inspectChangeSource } = require('./graph.cjs') as typeof import('../cli/graph');
      const before = existing ? show(comparison, old ?? file) : '';
      const after = worktree ? show(undefined, file) : readSource(file);
      if (before !== undefined && after !== undefined && !before.includes('\0') && !after.includes('\0')) {
        previous = inspectChangeSource(old ?? file, before, scanComments, middleware);
        const next = inspectChangeSource(file, after, scanComments, middleware);
        newCode = next.code;
        if (!stagedDrift && entry.hunks.length) importEdits.set(file, {
          before: previous.moduleSpecifiers, after: next.moduleSpecifiers
        });
        for (const name of previous.names) {
          if (!next.names.has(name) && (!next.stars.size || name === 'default')) {
            removedNames.add(name);
            continue;
          }
          if (worktree) {
            if (next.aliases.has(name) || !next.names.has(name)) uncertainNames.add(name);
            continue;
          }
          const state = graph.runtimeExport(file, name);
          if (state === 'type' || state === 'absent' && !next.names.has(name)) removedNames.add(name);
          else if (state !== 'value') uncertainNames.add(name);
        }
        for (const star of previous.stars) if (!next.stars.has(star)) removedStars.add(star);
        const beforeMatcher = previous.matcher;
        const afterMatcher = next.matcher;
        if (beforeMatcher && afterMatcher) {
          matcherChanged = !beforeMatcher.every(value => afterMatcher.includes(value)) ||
            !afterMatcher.every(value => beforeMatcher.includes(value));
        }
      } else if (existing && entry.hunks.length) missingSource++;
    }
    const commentOnly = (hunk: Hunk) => commentCandidate(hunk) && !!previous && !!newCode &&
      hunk.added.every((_, i) => !newCode.has(hunk.line + i)) && hunk.removed.every((_, i) => !previous!.code.has(hunk.oldLine + i));
    const substantive: Hunk[] = [];
    const commentHunks: Hunk[] = [];
    for (const hunk of entry.hunks) (commentOnly(hunk) ? commentHunks : substantive).push(hunk);
    const record = (line: number, comment: boolean, added: number, removed: number,
      symbol = indexes.find(symbol => symbol.line <= line && line <= (symbol.end ?? symbol.line)) ?? null) => {
      const key = JSON.stringify([file, symbol?.id, comment]);
      const edit = modified.get(key) ?? { file, symbol: symbol ?? undefined, line, added: 0, removed: 0, comment };
      edit.added += added;
      edit.removed += removed;
      edit.line = Math.min(edit.line, line);
      modified.set(key, edit);
    };
    for (const hunk of commentHunks) {
      record(Math.max(1, hunk.line), true, hunk.added.length, hunk.removed.length);
    }
    if (!substantive.length && commentHunks.length && !old) continue;
    if (removedNames.size || uncertainNames.size || removedStars.size) removals.push({
      file: old ?? file, names: [...removedNames, ...uncertainNames], uncertainNames,
      compareExports: removedStars.size > 0, currentFile: file, stagedDrift: !!worktree
    });
    if (middleware) {
      useSeed(file, file, graph.moduleSeeds(file));
      if (existing && isMiddlewareFile(old ?? file) &&
          (matcherChanged || mayChangeRouteFiles || worktree || !graph.middleware(file))) middlewareFiles.set(file, old ?? file);
    }
    if (workspaceConfig(file)) {
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
      if (sourceFile.test(file)) {
        unmappedDeletions += substantive.filter(hunk => !hunk.added.length && hunk.removed.some(line => line.trim())).length;
      }
      continue;
    }
    if (!substantive.length && (old || !entry.hunks.length)) {
      useSeed(file, file, old ? graph.fileSeeds(file) : graph.moduleSeeds(file));
      if (!old) changes.push(graphRow(`file ${file}${worktree}`, file));
    }
    let statementIndex = 0;
    let removalEdit: Edit | undefined;
    const beforeEdits = modified.size;
    const statementsAt = (line: number) => {
      const statements = previous?.statements;
      if (!statements) return [];
      while (statementIndex < statements.length && statements[statementIndex].end < line) statementIndex++;
      let end = statementIndex;
      while (end < statements.length && statements[end].start <= line) end++;
      return statements.slice(statementIndex, end);
    };
    const removedStatement = ({ exports, star }: NonNullable<typeof previous>['statements'][number]) =>
      star !== undefined ? removedStars.has(star) : exports.size > 0 && [...exports].every(name => removedNames.has(name));
    for (const hunk of substantive) {
      if (expired()) break;
      if (hunk.removed.length === 1 && hunk.added.length === 1 &&
          hunk.removed[0].replace(/^(\s*)export(?:\s+default)?\s+/, '$1') === hunk.added[0]) {
        const owners = statementsAt(hunk.oldLine);
        if (owners.length && owners.every(removedStatement)) {
          removalEdit ??= { file, line: hunk.line, added: 0, removed: 0, comment: false };
          removalEdit.added++;
          removalEdit.removed++;
          continue;
        }
      }
      for (let i = 0; i < hunk.added.length; i++) record(hunk.line + i, false, 1, 0);
      if (hunk.added.length || !sourceFile.test(file)) {
        for (let i = 0; i < hunk.removed.length; i++) {
          record(Math.max(1, hunk.line + Math.max(0, Math.min(i, hunk.added.length - 1))), false, 0, 1);
        }
        continue;
      }
      // In a zero-context deletion Git's new line is the line before the
      // gap. Match surviving lines of the old statement around that gap.
      const last = hunk.oldLine + hunk.removed.length - 1;
      let unmapped = false;
      for (const [offset, text] of hunk.removed.entries()) {
        const owners = statementsAt(hunk.oldLine + offset);
        if (owners.length && owners.every(statement => removedStatement(statement) &&
          (statement.start >= hunk.oldLine && statement.end <= last || /^\s*export(?:\s+default)?\s*$/.test(text)))) {
          removalEdit ??= { file, line: Math.max(1, hunk.line), added: 0, removed: 0, comment: false };
          removalEdit.removed++;
          continue;
        }
        const anchors = owners.length === 1 ? [
          ...(owners[0].start < hunk.oldLine ? [hunk.line] : []),
          ...(owners[0].end > last ? [hunk.line + 1] : [])
        ] : [];
        const symbol = anchors.length ? indexes.find(symbol =>
          anchors.every(line => symbol.line <= line && line <= (symbol.end ?? symbol.line))) : undefined;
        if (!symbol && text.trim()) unmapped = true;
        record(Math.max(1, anchors[0] ?? hunk.line), false, 0, 1, symbol ?? null);
      }
      if (unmapped) unmappedDeletions++;
    }
    if (removalEdit && !old && modified.size === beforeEdits) {
      changes.push(graphRow(`file ${file}:${removalEdit.line} ${stats(removalEdit)}${worktree}`, file));
    }
  }

  const changedSymbols = new Set<number>();
  for (const edit of [...modified.values()].sort((a, b) => compare(a.file, b.file) || a.line - b.line ||
    Number(a.comment) - Number(b.comment))) {
    const { file, symbol, line } = edit;
    const worktree = localChanges.has(repositoryPath(file)) ? ' [worktree differs]' : '';
    if (edit.comment) {
      changes.push(graphRow(`comment ${file}:${line}${symbol ? ' ' + symbol.name : ''} [comment only]${worktree}`, file));
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
      useSeed(file, file, graph.fileSeeds(file));
    }
  }

  let history: ReturnType<typeof traceHistory> | undefined;
  if ((removals.length || middlewareFiles.size) && !expired()) {
    const renamed = new Map(files.flatMap(({ old, file, status }) => old && status === 'R' ? [[old, file]] : []));
    const editedSources = new Map(files.slice(0, maxFiles).filter(entry => sourceFile.test(entry.file) &&
      entry.hunks.length && !['D', 'A', '?'].includes(entry.status)).map(entry => [entry.file, entry]));
    const importEdit = (file: string) => {
      const existing = importEdits.get(file);
      if (existing || stagedDrift) return existing;
      const entry = editedSources.get(file);
      if (!entry || expired()) return;
      const before = show(comparison, entry.old ?? file);
      const after = readSource(file);
      if (before === undefined || after === undefined || before.includes('\0') || after.includes('\0')) return;
      const { inspectChangeSource } = require('./graph.cjs') as typeof import('../cli/graph');
      const edit = {
        before: inspectChangeSource(entry.old ?? file, before, false).moduleSpecifiers,
        after: inspectChangeSource(file, after, false).moduleSpecifiers
      };
      importEdits.set(file, edit);
      return edit;
    };
    try {
      const incremental = !prefix && !outside && !stagedDrift && !middlewareFiles.size && files.length === removals.length &&
        files.length <= maxSeeds && files.every(({ status, file }) => status === 'M' && !config.test(file)) &&
        removals.every(removal => removal.names?.length && !removal.compareExports && !removal.uncertainNames?.size);
      history = traceHistory(root, removals.slice(0, maxSeeds), middlewareFiles, graph, renamed, importEdit, gitBytes,
        comparison, prefix, depth, deadline, incremental ? index : undefined);
      changes.push(...history.rows);
    } catch {
      for (const { file, names, compareExports, renamed } of removals) {
        if (renamed) unresolvedRenames++;
        else missingSource++;
        for (const name of names ?? []) changes.push(graphRow(`export ${file} ${name} [uncertain]`));
        if (compareExports) changes.push(graphRow(`export ${file} * [uncertain]`));
      }
    }
    if (removals.length > maxSeeds) limited = true;
  }
  const trace = graph.changeRoutes([...seeds.values(), ...history?.live ?? []], depth, expired, history?.cleanRefactor);
  const baseTrace = history?.trace;
  const wrappers = new Map([...baseTrace?.wrappers ?? [], ...trace.wrappers].map(wrapper => [wrapper.name, wrapper]));
  const rows: QueryRow[] = [];
  for (const wrapper of wrappers.values()) {
    const urls = [...new Set(wrapper.pages.map(page => page.url))].sort(compare);
    rows.push(graphRow(`wraps ${wrapper.name} : ${quantity(wrapper.pages.length, 'route')}` +
      (urls.length ? ` (${urls.slice(0, 3).join(', ')}${urls.length > 3 ? ', +' + (urls.length - 3) : ''})` : ''), wrapper.file));
  }
  const pageFiles = new Set<string>();
  const apiFiles = new Set<string>();
  const otherFiles = new Set<string>();
  const possibleFiles = new Set<string>();
  let unknownMiddleware = [...middlewareFiles].some(([file]) => !history?.previousMiddleware.get(file) || !graph.middleware(file));
  const currentRoutes = new Set(trace.routes.map(({ terminal }) => JSON.stringify([terminal.kind, terminal.file, terminal.name])));
  const impacts = new Map(trace.routes.map(result => [JSON.stringify([result.terminal.kind, result.terminal.file, result.terminal.name]),
    { terminal: result.terminal, origins: [...result.origins] }]));
  const liveMiddleware = new Set(trace.routes.filter(({ terminal }) => terminal.kind === 'middleware').map(({ terminal }) => terminal.file));
  for (const result of baseTrace?.routes ?? []) {
    const { terminal, origins } = result;
    if (terminal.kind === 'middleware' && middlewareFiles.has(terminal.file) && liveMiddleware.has(terminal.file)) continue;
    const key = JSON.stringify([terminal.kind, terminal.file, terminal.name]);
    const live = impacts.get(key);
    if (!live) impacts.set(key, { terminal, origins: [...origins] });
    else for (const impact of origins) {
      if (!live.origins.some(({ origin }) => origin.removed === impact.origin.removed && origin.renamed === impact.origin.renamed &&
        origin.file === impact.origin.file && origin.name === impact.origin.name)) {
        live.origins.push(impact);
      }
    }
  }
  for (const [key, { terminal, origins }] of impacts) {
    const { kind, name, file } = terminal;
    if (kind === 'middleware') {
      unknownMiddleware ||= !terminal.matchedRoutes;
      const previous = history?.previousMiddleware.get(file);
      if (previous && !previous.matchedRoutes) unknownMiddleware = true;
      for (const route of [...terminal.matchedRoutes ?? [], ...previous?.matchedRoutes ?? []]) {
        (route.kind === 'page' ? pageFiles : apiFiles).add(route.file);
      }
      const routeKey = (route: QueryIndex['routes'][number]) => JSON.stringify([route.kind, route.file, route.url]);
      let coverage = '';
      if (previous?.matchedRoutes && terminal.matchedRoutes) {
        const before = new Set(previous.matchedRoutes.map(routeKey));
        const after = new Set(terminal.matchedRoutes.map(routeKey));
        const lost = [...before].filter(route => !after.has(route)).length;
        const gained = [...after].filter(route => !before.has(route)).length;
        if (lost || gained || previous.name !== name) {
          coverage = ` (previous matcher: ${previous.name === '/' ? 'all routes' : previous.name}, ` +
            `${quantity(lost, 'route')} no longer matched, ${quantity(gained, 'route')} newly matched)`;
        }
      }
      rows.push(graphRow(`middleware ${file}  all matched routes${name === '/' ? '' : ` (matcher: ${name})`}${coverage}`, file));
      continue;
    }
    if (kind === 'api') apiFiles.add(file);
    else if (kind === 'page') pageFiles.add(file);
    else otherFiles.add(file);
    if (origins.every(origin => origin.possible)) possibleFiles.add(file);
    const labels = [...new Set(origins.map(({ origin, depth, fetch, possible }) =>
      `${origin.name}${origin.removed ? ' [removed]' : origin.renamed ? ' [renamed]' : ''} d${depth}` +
      (fetch ? ` via fetch ${fetch}` : '') + (possible ? ' [possible]' : '')))];
    const chain = ` <- ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ', +' + (labels.length - 3) : ''}`;
    const isCurrent = currentRoutes.has(key);
    rows.push(graphRow(`route ${kind} ${name}  ${file}${isCurrent ? '' : ' [base]'}${chain}`, ...isCurrent ? [file] : []));
  }
  if (configFiles) for (const route of index.routes) (route.kind === 'page' ? pageFiles : apiFiles).add(route.file);
  const routes = pageFiles.size + apiFiles.size;
  const wrapperRoutes = new Set([...wrappers.values()].flatMap(wrapper => wrapper.pages.map(page => page.file))).size;
  if (outside) notes.push(graphRow(`# outside project: ${quantity(outside, 'file')}`));
  if (changes.length > 500) limited = true;
  const stops = new Set([...trace.stops, ...baseTrace?.stops ?? []]).size;
  if (stops) notes.push(graphRow('# ' + moduleStops(stops)));
  if (history?.removed) notes.push(graphRow(`# removed: ${quantity(history.removed, 'export')} from base`));
  const tracedSymbols = [...seeds.values()].filter(seed => seed.ids.length === 1 && changedSymbols.has(Number(seed.ids[0]))).length;
  notes.push(graphRow(`# risk: ${quantity(changedSymbols.size, 'changed symbol')} (${quantity(actionCount, 'action')}` +
    `${tracedSymbols < changedSymbols.size ? `, ${tracedSymbols} traced` : ''}); ${quantity(routes, 'route')} reached ` +
    `(${quantity(pageFiles.size, 'page')}, ${quantity(apiFiles.size, 'API')}); ` +
    (possibleFiles.size ? `${possibleFiles.size} possible; ` : '') +
    `${quantity(wrapperRoutes, 'route')} under touched wrappers; ${quantity(configFiles, 'config file')}` +
    (otherFiles.size ? `; ${quantity(otherFiles.size, 'special file')}` : '')));
  const diffScope = base ? `merge-base(${base}, HEAD)` : scope === 'all' ? 'HEAD' : scope === 'staged' ? '--cached' : '(worktree)';
  const sizePartial = totalFiles > maxFiles || limited ? `diff too large (up to ${maxFiles} files and ${maxSeeds} impact origins)` : undefined;
  let untraced = missingSource + (history?.skipped ?? 0);
  let noRemovalRoutes = false;
  for (const { origins, evidence, renamed, row } of history?.checks ?? []) {
    if (origins.some(origin => trace.traced.has(origin) || baseTrace?.traced.has(origin))) continue;
    if (row) row.text += ' [uncertain]';
    if (renamed) unresolvedRenames++;
    else if (evidence) noRemovalRoutes = true;
    else untraced++;
  }
  const partial = [...new Set([stagedDrift ? 'worktree differs from staged' : undefined,
    untraced ? `could not trace ${quantity(untraced, 'removal')} from base` : undefined, sizePartial,
    unresolvedRenames ? `could not trace old-path coverage for ${quantity(unresolvedRenames, 'rename')}` : undefined,
    unmappedDeletions ? `could not map old lines for ${quantity(unmappedDeletions, 'deletion hunk')}` : undefined,
    noRemovalRoutes ? 'no page or API routes traced for removals' : undefined,
    history?.unknownExports ? 'runtime export availability not resolved' : undefined,
    history?.unknownNamespaces ? 'namespace import members not resolved' : undefined,
    history?.unverifiedMoves ? `old-path imports not verified in ${quantity(history.unverifiedMoves, 'file')}` : undefined,
    trace.partial, baseTrace?.partial, stops ? 'module-level importers not traced' : undefined,
    unknownMiddleware ? 'middleware matcher coverage not enumerated' : undefined].filter(Boolean))].join('; ') || undefined;
  return {
    title, rows: [...rows, ...changes.slice(0, 500)], notes, targets: [...touched],
    count: `${quantity(totalFiles, 'file')}, ${quantity(changedSymbols.size, 'symbol')}, ${quantity(routes, 'route')}, ${quantity(wrappers.size, 'wrapper')}`,
    partial,
    scope: `git diff ${diffScope}, indexed edges, impact depth ${depth} plus render closure`
  };
}
