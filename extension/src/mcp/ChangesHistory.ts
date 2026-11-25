import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { workspaceCache } from '../core/WorkspaceCache';
import { compare, DependencyGraph, graphRow, hasGraph, type ChangeOrigin, type QueryRow } from './Graph';
import { GRAPH_INDEX_REVISION, INDEX_SCHEMA, isTestFile, VERSION, type QueryIndex } from './Index';

export const sourceFile = /\.[cm]?[jt]sx?$/;
export const routeAsset = /(?:\.css|(?:^|\/)(?:robots\.txt|sitemap\.xml|opengraph-image\.(?:png|jpe?g|gif)))$/;
export const historyBudgetMs = 20_000;
type Git = (args: string[], input?: Buffer, maxBuffer?: number) => Buffer;
export type ImportEdit = { before: ReadonlyMap<number, string>; after: ReadonlyMap<number, string> };
export type Removal = { file: string; names?: string[]; uncertainNames?: ReadonlySet<string>; currentFile?: string;
  compareExports?: boolean; stagedDrift?: boolean; renamed?: true };

function historicalIndex(root: string, git: Git, ref: string | undefined, prefix: string, deadline: number): QueryIndex {
  const stagedTree = ref ? undefined : git(['ls-files', '--stage', '--full-name', '-z', '--', ':/']);
  const treeId = stagedTree ? createHash('sha256').update(stagedTree).digest('hex') :
    git(['rev-parse', '--verify', ref! + '^{tree}']).toString('utf8').trim();
  let directory: string | undefined;
  let cached: string | undefined;
  try {
    const gitDir = git(['rev-parse', '--git-common-dir']).toString('utf8').replace(/\r?\n$/, '');
    const cache = workspaceCache(root, resolve(root, gitDir));
    const history = join(cache, 'history');
    for (const path of [cache, history]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (!lstatSync(path).isDirectory()) throw new Error('Invalid comparison cache directory');
    }
    directory = history;
    const key = createHash('sha256').update(JSON.stringify([VERSION, GRAPH_INDEX_REVISION, prefix, treeId])).digest('hex');
    cached = join(history, key + '.json');
    if (lstatSync(cached).isFile()) {
      const index = JSON.parse(readFileSync(cached, 'utf8')) as QueryIndex;
      if (index.schema === INDEX_SCHEMA && index.generator === VERSION && hasGraph(index)) return index;
    }
  } catch {
    // A missing, invalid or unwritable cache is recoverable from Git.
  }
  const snapshot = mkdtempSync(join(tmpdir(), 'neorion-base-'));
  try {
    const tree = stagedTree ?? git(['ls-tree', '-r', '--full-tree', '-z', treeId]);
    const paths = new Map<string, string[]>();
    for (const record of tree.toString('utf8').split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const file = record.slice(tab + 1);
      if (file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') ||
          /[\\:\x00-\x1f\ufffd]/.test(file)) continue;
      if (!sourceFile.test(file) && !file.endsWith('.json') && !routeAsset.test(file)) continue;
      const blob = /^100(?:644|755) (?:blob )?([a-f0-9]{40,64})(?: 0)?$/.exec(record.slice(0, tab))?.[1];
      if (!blob) continue;
      const aliases = paths.get(blob) ?? [];
      aliases.push(file);
      paths.set(blob, aliases);
    }
    if (!paths.size) throw new Error('Empty comparison tree');
    const objects = [...paths.keys()];
    const contents = git(['cat-file', '--batch'], Buffer.from(objects.join('\n') + '\n'), 32 * 1024 * 1024);
    const sourceRoot = join(snapshot, 'sources');
    let offset = 0;
    for (const oid of objects) {
      const end = contents.indexOf(10, offset);
      if (end < 0) throw new Error('Invalid Git blob header');
      const [object, type, size] = contents.toString('ascii', offset, end).split(' ');
      const length = Number(size);
      offset = end + 1;
      if (object !== oid || type !== 'blob' || !Number.isSafeInteger(length) || length < 0 ||
          contents[offset + length] !== 10) throw new Error('Invalid Git blob');
      const data = contents.subarray(offset, offset + length);
      for (const file of paths.get(oid)!) {
        const target = join(sourceRoot, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
      }
      offset += length + 1;
    }
    const result = join(snapshot, '.neorion-history.json');
    execFileSync(process.execPath, [join(__dirname, 'graph.cjs'), '--history-index', join(sourceRoot, prefix), result], {
      stdio: 'ignore', timeout: Math.max(1, Math.floor(deadline - performance.now() - 100))
    });
    const json = readFileSync(result, 'utf8');
    const index = JSON.parse(json) as QueryIndex;
    if (!hasGraph(index)) throw new Error('Could not index comparison tree');
    if (directory && cached) {
      try {
        const staging = mkdtempSync(join(directory, 'write-'));
        try {
          const file = join(staging, 'index.json');
          writeFileSync(file, json, { mode: 0o600 });
          renameSync(file, cached);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      } catch {
        // Cache publication is optional. The newly built index is usable.
      }
    }
    return index;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function updatedImport(base: DependencyGraph, current: DependencyGraph, importer: string, liveImporter: string,
  oldTarget: string, liveTarget: string, edit: ImportEdit, name?: string) {
  const before = base.importsFrom(importer, oldTarget);
  const after = current.importsFrom(liveImporter, liveTarget);
  if (!before.length || !after.length) return false;
  // Require real import declarations. Unresolved imports and dynamic loads
  // cannot be proved updated by the presence of a different resolved import.
  const complete = before.every(([, line]) => edit.before.has(line)) && after.every(([, line]) => edit.after.has(line));
  if (!complete) return false;
  const valid = after.every(([, , kind, bindings, members]) => kind === 'type' ||
    (bindings ?? []).every(([binding]) => binding === '*' || current.runtimeExport(liveTarget, binding) === 'value') &&
    (members ?? []).every(([, member]) => member != null && current.runtimeExport(liveTarget, member) === 'value'));
  if (!valid) return false;
  if (name !== undefined) {
    const importsName = ([, , kind, bindings, members]: (typeof after)[number]) => kind !== 'type' &&
      (bindings?.some(([binding]) => binding === name || binding === '*' && kind === 'export') ||
        members?.some(([, member]) => member === name || member == null));
    return before.some(importsName) && !after.some(importsName);
  }
  const oldSpecifiers = new Set(before.map(([, line]) => edit.before.get(line)));
  if ([...edit.after.values()].some(specifier => oldSpecifiers.has(specifier))) return false;
  // Compare multiplicities so one corrected statement cannot hide another.
  const bindings = (entries: typeof before) => entries.map(([, , kind, names]) => JSON.stringify([kind, names?.slice().sort()])).sort();
  const oldBindings = bindings(before);
  const newBindings = bindings(after);
  return oldBindings.length === newBindings.length && oldBindings.every((binding, i) => binding === newBindings[i]);
}

export function traceHistory(root: string, removals: Removal[], middleware: ReadonlyMap<string, string>,
  current: DependencyGraph, renamed: ReadonlyMap<string, string>, importEdit: (file: string) => ImportEdit | undefined,
  git: Git, ref: string | undefined, prefix: string, depth: number, deadline: number) {
  const historical = historicalIndex(root, git, ref, prefix, deadline);
  const base = new DependencyGraph(historical, new Map(historical.symbols.map(symbol => [symbol.id, symbol])));
  const origins: ChangeOrigin[] = [];
  const live: ChangeOrigin[] = [];
  const rows: QueryRow[] = [];
  const checks: { evidence: boolean; origins: ChangeOrigin[]; renamed?: boolean; row?: QueryRow }[] = [];
  let skipped = 0;
  let removed = 0;
  let examined = 0;
  let unknownExports = false;
  let unknownNamespaces = false;
  let updatedOnly = false;
  let hasUnverifiedOrigin = false;
  const unverifiedMoves = new Set<string>();
  const traceOrigin = (file: string, name: string, ids: ChangeOrigin['ids'], wholeFile: boolean, moved = false,
    uncertainExport = false) => {
    if (examined++ >= 100) {
      skipped++;
      return;
    }
    const externalOnly = !wholeFile && ids.some(id => base.file(id) !== file ||
      current.matchingNode(base, id, renamed.get(file) ?? file).length > 0);
    const origin: ChangeOrigin = { file, name, ids, renamed: moved, removed: !moved, externalOnly };
    const { uses, files, importFiles, direct, uncertain, terminal } = base.removalSites(origin, wholeFile);
    const updated = new Set<string>();
    if (!uncertainExport && (!wholeFile || moved)) for (const importer of files.keys()) {
      const currentImporter = renamed.get(importer) ?? importer;
      const edit = importEdit(currentImporter);
      if (edit && updatedImport(base, current, importer, currentImporter, file, renamed.get(file) ?? file, edit,
        wholeFile ? undefined : name)) updated.add(importer);
    }
    origin.importFiles = updated.size ? new Set([...(importFiles ?? files.keys())].filter(file => !updated.has(file))) : importFiles;
    const seedImporters = (target: ChangeOrigin[], ids: ChangeOrigin['ids'], checked: ChangeOrigin[]) => {
      if (!ids.length) return;
      const seed = { ...origin, ids: [...new Set(ids)], startsAt: 1, externalOnly: false };
      target.push(seed);
      checked.push(seed);
    };
    const used = new Map<string, ChangeOrigin['ids']>();
    for (const edge of uses) {
      const ids = used.get(edge.file) ?? [];
      ids.push(edge.from);
      used.set(edge.file, ids);
    }
    const allUpdated = updated.size > 0 && updated.size === files.size;
    updatedOnly ||= allUpdated;
    hasUnverifiedOrigin ||= !allUpdated || terminal || uncertainExport;
    if (!uncertainExport && (!allUpdated || terminal)) origins.push(origin);
    const checked = [origin];
    // An indexed import may have no reference edge for its binding. Use the
    // importing file as evidence on both sides, including deleted importers.
    for (const [importer, sites] of [...files].sort(([a], [b]) => compare(a, b))) {
      if (updated.has(importer)) continue;
      if (moved && base.importsFrom(importer, file).length && current.moduleSeeds(renamed.get(importer) ?? importer).length) {
        unverifiedMoves.add(importer);
      }
      const lines = [...new Set(sites.map(site => site.line))].sort((a, b) => a - b);
      const opaque = uncertain.has(importer);
      const relation = uncertainExport ? 'possible removal of' : moved ? 'renamed' : 'removed';
      const row = graphRow(`importer ${importer}:${lines.slice(0, 4).join(',')}` +
        `${lines.length > 4 ? ' +' + (lines.length - 4) : ''} <- ${relation} ${name} [base]` +
        (opaque || uncertainExport ? ' [uncertain]' : ''));
      rows.push(row);
      if (isTestFile(importer) || uncertainExport) continue;
      unknownNamespaces ||= opaque;
      if (!wholeFile && !direct.has(importer)) continue;
      const importerChecks: ChangeOrigin[] = wholeFile ? checked : [];
      const importerIds = used.get(importer);
      const currentFile = renamed.get(importer) ?? importer;
      seedImporters(origins, importerIds ?? base.fileSeeds(importer), importerChecks);
      seedImporters(live, importerIds?.flatMap(id => current.matchingNode(base, id, currentFile)) ??
        current.fileSeeds(currentFile), importerChecks);
      if (!wholeFile) checks.push({ evidence: true, origins: importerChecks, row: opaque ? undefined : row });
    }
    if (wholeFile) {
      const internal = used.get(file) ?? [];
      seedImporters(live, internal.flatMap(id => current.matchingNode(base, id, renamed.get(file))), checked);
    }
    if (!uncertainExport && !allUpdated && (wholeFile || !direct.size && !uncertain.size)) {
      checks.push({ evidence: files.size > 0 || terminal && !externalOnly, origins: checked, renamed: moved });
    }
  };
  for (const { file, names, uncertainNames, currentFile, compareExports, stagedDrift, renamed: moved } of removals) {
    const exports = base.exports(file);
    const runtime = base.runtimeExports(file);
    const explicit = new Set(names);
    const keys = moved ? [] : compareExports ? [...new Set([...explicit, ...Object.keys(runtime?.names ?? {})])] :
      names ?? Object.keys(exports).sort(compare);
    if (compareExports && (runtime?.unknownStar || !base.moduleSeeds(file).length)) {
      unknownExports = true;
      rows.push(graphRow(`export ${file} * [uncertain]`));
    }
    if (!names) {
      const layouts = Object.prototype.hasOwnProperty.call(historical.layoutStyles, file) ? historical.layoutStyles![file] : [];
      traceOrigin(file, file, [...base.fileSeeds(file), ...layouts.flatMap(layout => base.moduleSeeds(layout))], true, moved);
    }
    for (const key of keys) {
      const before = names ? base.runtimeExport(file, key) : 'value';
      const after = explicit.has(key) ? uncertainNames?.has(key) ? 'unknown' : 'type' :
        stagedDrift ? 'unknown' : current.runtimeExport(currentFile ?? file, key);
      if (names && (before === 'type' || after === 'value')) continue;
      const ids = Object.prototype.hasOwnProperty.call(exports, key) ? exports[key] : [];
      if (before !== 'value' || names && after === 'unknown') {
        unknownExports = true;
        rows.push(graphRow(`export ${file} ${key} [uncertain]`));
        traceOrigin(file, key, ids, false, false, true);
        continue;
      }
      removed++;
      rows.push(graphRow(`removed ${file} ${key}`));
      if (names || ids.some(id => base.file(id) !== file)) traceOrigin(file, key, ids, false);
    }
  }
  const trace = base.changeRoutes(origins, depth, () => performance.now() >= deadline);
  const previousMiddleware = new Map([...middleware].map(([file, old]) => [file, base.middleware(old)]));
  return { live, trace, rows, removed, checks, skipped, previousMiddleware, unknownExports, unknownNamespaces, unverifiedMoves: unverifiedMoves.size,
    cleanRefactor: updatedOnly && !hasUnverifiedOrigin && !unknownExports && !skipped };
}
