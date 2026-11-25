import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compare, DependencyGraph, graphRow, hasGraph, type ChangeOrigin } from './Graph';
import type { QueryIndex } from './Index';

export const sourceFile = /\.[cm]?[jt]sx?$/;
export const routeAsset = /(?:\.css|(?:^|\/)(?:robots\.txt|sitemap\.xml|opengraph-image\.(?:png|jpe?g|gif)))$/;
export const historyBudgetMs = 20_000;
type Git = (args: string[], input?: Buffer, maxBuffer?: number) => Buffer;
export type Removal = { file: string; names?: string[]; currentFile?: string; compareExports?: boolean };

function historicalIndex(git: Git, ref: string | undefined, prefix: string, deadline: number): QueryIndex {
  const snapshot = mkdtempSync(join(tmpdir(), 'neorion-base-'));
  try {
    const tree = ref ? git(['ls-tree', '-r', '--full-tree', '-z', ref]) :
      git(['ls-files', '--stage', '--full-name', '-z', '--', ':/']);
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
    const index = JSON.parse(readFileSync(result, 'utf8')) as QueryIndex;
    if (!hasGraph(index)) throw new Error('Could not index comparison tree');
    return index;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

export function traceRemovals(removals: Removal[], current: DependencyGraph, renamed: ReadonlyMap<string, string>,
  git: Git, ref: string | undefined, prefix: string, depth: number, deadline: number) {
  const historical = historicalIndex(git, ref, prefix, deadline);
  const base = new DependencyGraph(historical, new Map(historical.symbols.map(symbol => [symbol.id, symbol])));
  const origins: ChangeOrigin[] = [];
  const live: ChangeOrigin[] = [];
  const rows = [];
  const evident = new Set<ChangeOrigin>();
  const missing = [];
  let removed = 0;
  const traceOrigin = (file: string, name: string, ids: ChangeOrigin['ids'], wholeFile: boolean) => {
    if (origins.length >= 100) {
      missing.push(name);
      return;
    }
    const externalOnly = !wholeFile && ids.some(id => base.file(id) !== file ||
      current.matchingNode(base, id, renamed.get(file) ?? file).length > 0);
    const origin: ChangeOrigin = { file, name, ids, removed: true, externalOnly };
    const { uses, files, importFiles, sideEffects, terminal } = base.removalSites(origin, wholeFile);
    origin.importFiles = importFiles;
    origins.push(origin);
    if (files.size || terminal && !externalOnly) evident.add(origin);
    for (const [importer, sites] of [...files].sort(([a], [b]) => compare(a, b))) {
      const lines = [...new Set(sites.map(site => site.line))].sort((a, b) => a - b);
      rows.push(graphRow(`importer ${importer}:${lines.slice(0, 4).join(',')}` +
        `${lines.length > 4 ? ' +' + (lines.length - 4) : ''} <- removed ${name} [base]`));
    }
    const liveIds = [...new Set(uses.flatMap(edge => current.matchingNode(base, edge.from, renamed.get(base.file(edge.from)))))];
    if (liveIds.length) live.push({ ...origin, ids: liveIds, startsAt: 1, externalOnly: false });
    if (sideEffects.length) {
      // A side-effect import has no symbol edge. Trace its importing file in
      // the old graph too, in case it was deleted by the same diff.
      origins.push({ ...origin, ids: sideEffects, startsAt: 1 });
    }
  };
  for (const { file, names, currentFile, compareExports } of removals) {
    const exports = base.exports(file);
    const currentExports = current.exports(currentFile ?? file);
    const keys = compareExports ? Object.keys(exports).filter(key => !Object.prototype.hasOwnProperty.call(currentExports, key)) :
      names ?? Object.keys(exports).sort(compare);
    removed += keys.length;
    if (!names) {
      const layouts = Object.prototype.hasOwnProperty.call(historical.layoutStyles, file) ? historical.layoutStyles![file] : [];
      traceOrigin(file, file, [...base.fileSeeds(file), ...layouts.flatMap(layout => base.moduleSeeds(layout))], true);
    }
    for (const key of keys) {
      rows.push(graphRow(`removed ${file} ${key}`));
      const ids = Object.prototype.hasOwnProperty.call(exports, key) ? exports[key] : [];
      if (names || ids.some(id => base.file(id) !== file)) traceOrigin(file, key, ids, false);
    }
  }
  const trace = base.changeRoutes(origins, depth, () => performance.now() >= deadline);
  for (const origin of origins) if (!origin.startsAt && !evident.has(origin) && !trace.traced.has(origin)) missing.push(origin.name);
  return { live, trace, rows, removed, missing };
}
