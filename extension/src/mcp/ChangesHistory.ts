import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { workspaceCache } from '../core/WorkspaceCache';
import { compare, DependencyGraph, graphRow, hasGraph, type ChangeOrigin } from './Graph';
import { GRAPH_INDEX_REVISION, INDEX_SCHEMA, isTestFile, VERSION, type QueryIndex } from './Index';

export const sourceFile = /\.[cm]?[jt]sx?$/;
export const routeAsset = /(?:\.css|(?:^|\/)(?:robots\.txt|sitemap\.xml|opengraph-image\.(?:png|jpe?g|gif)))$/;
export const historyBudgetMs = 20_000;
type Git = (args: string[], input?: Buffer, maxBuffer?: number) => Buffer;
export type Removal = { file: string; names?: string[]; currentFile?: string; compareExports?: boolean; renamed?: true };

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

export function traceHistory(root: string, removals: Removal[], middleware: ReadonlyMap<string, string>,
  current: DependencyGraph, renamed: ReadonlyMap<string, string>,
  git: Git, ref: string | undefined, prefix: string, depth: number, deadline: number) {
  const historical = historicalIndex(root, git, ref, prefix, deadline);
  const base = new DependencyGraph(historical, new Map(historical.symbols.map(symbol => [symbol.id, symbol])));
  const origins: ChangeOrigin[] = [];
  const live: ChangeOrigin[] = [];
  const rows = [];
  const checks: { evidence: boolean; origins: ChangeOrigin[] }[] = [];
  let skipped = 0;
  let removed = 0;
  const traceOrigin = (file: string, name: string, ids: ChangeOrigin['ids'], wholeFile: boolean, moved = false) => {
    if (checks.length >= 100) {
      skipped++;
      return;
    }
    const externalOnly = !wholeFile && ids.some(id => base.file(id) !== file ||
      current.matchingNode(base, id, renamed.get(file) ?? file).length > 0);
    const origin: ChangeOrigin = { file, name, ids, renamed: moved, removed: !moved, externalOnly };
    const { uses, files, importFiles, terminal } = base.removalSites(origin, wholeFile);
    origin.importFiles = importFiles;
    origins.push(origin);
    const check = { evidence: files.size > 0 || terminal && !externalOnly, origins: [origin] };
    checks.push(check);
    const used = new Set(uses.map(edge => edge.file));
    const fallback: string[] = [];
    for (const [importer, sites] of [...files].sort(([a], [b]) => compare(a, b))) {
      const lines = [...new Set(sites.map(site => site.line))].sort((a, b) => a - b);
      rows.push(graphRow(`importer ${importer}:${lines.slice(0, 4).join(',')}` +
        `${lines.length > 4 ? ' +' + (lines.length - 4) : ''} <- ${moved ? 'renamed' : 'removed'} ${name} [base]`));
      if (!used.has(importer) && !isTestFile(importer)) fallback.push(importer);
    }
    const seedImporters = (target: ChangeOrigin[], ids: ChangeOrigin['ids']) => {
      if (!ids.length) return;
      const seed = { ...origin, ids: [...new Set(ids)], startsAt: 1, externalOnly: false };
      target.push(seed);
      check.origins.push(seed);
    };
    // An indexed import may have no reference edge for its binding. Use the
    // importing file as evidence on both sides, including deleted importers.
    seedImporters(origins, fallback.flatMap(importer => base.fileSeeds(importer)));
    seedImporters(live, [
      ...uses.flatMap(edge => current.matchingNode(base, edge.from, renamed.get(base.file(edge.from)))),
      ...fallback.flatMap(importer => current.fileSeeds(renamed.get(importer) ?? importer))
    ]);
  };
  for (const { file, names, currentFile, compareExports, renamed: moved } of removals) {
    const exports = base.exports(file);
    const currentExports = current.exports(currentFile ?? file);
    const keys = moved ? [] : compareExports ? [...new Set([...names ?? [],
      ...Object.keys(exports).filter(key => !Object.prototype.hasOwnProperty.call(currentExports, key))])] :
      names ?? Object.keys(exports).sort(compare);
    removed += keys.length;
    if (!names) {
      const layouts = Object.prototype.hasOwnProperty.call(historical.layoutStyles, file) ? historical.layoutStyles![file] : [];
      traceOrigin(file, file, [...base.fileSeeds(file), ...layouts.flatMap(layout => base.moduleSeeds(layout))], true, moved);
    }
    for (const key of keys) {
      rows.push(graphRow(`removed ${file} ${key}`));
      const ids = Object.prototype.hasOwnProperty.call(exports, key) ? exports[key] : [];
      if (names || ids.some(id => base.file(id) !== file)) traceOrigin(file, key, ids, false);
    }
  }
  const trace = base.changeRoutes(origins, depth, () => performance.now() >= deadline);
  const previousMiddleware = new Map([...middleware].map(([file, old]) => [file, base.middleware(old)]));
  return { live, trace, rows, removed, checks, skipped, previousMiddleware };
}
