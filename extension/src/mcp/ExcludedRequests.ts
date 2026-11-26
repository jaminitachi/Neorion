import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { ignoredProjectDirectories, workspaceDirectories } from '../core/FindProject';
import type { RouteNode } from '../core/types/GraphTypes';
import type { collectExcludedRequests } from '../core/analyzers/ExcludedHttp';
import type { FetchEntry, QueryIndex } from './Index';

const ignored = new Set([
  ...ignoredProjectDirectories, '.git', '.next', '.neorion', 'cdk.out', '.vercel', '.turbo', '.output', '.sst', '.open-next'
]);
const maxFileBytes = 512 * 1024;
const maxScanBytes = 16 * 1024 * 1024;
const maxScripts = 128;
const maxEntries = 20_000;

export function scanExcludedRequests(root: string, index: QueryIndex, checkPath: (file: string) => string) {
  const fetches: FetchEntry[] = [];
  const result: { fetches: FetchEntry[]; issue?: string } = { fetches };
  const routes: RouteNode[] = index.routes.filter(route => route.kind === 'api').map(route => ({
    id: String(route.id), type: 'api', file: route.file, path: route.url, pages: route.pages,
    methods: route.methods, isClient: false, domain: ''
  }));
  if (!routes.length) return result;
  const workspacePackages = new Set(workspaceDirectories(root)?.directories);
  const url = index.appUrlConfig ?? index.pagesUrlConfig;
  const config = url && { url, rules: [], issues: [] };
  const parse = (...args: Parameters<typeof collectExcludedRequests>) =>
    (require('./graph.cjs') as typeof import('../cli/graph')).collectExcludedRequests(...args);
  let entries = 0;
  let bytes = 0;
  let scripts = 0;
  const scan = (directory: string): boolean => {
    let children;
    try {
      children = readdirSync(path.join(root, directory), { withFileTypes: true });
    } catch {
      result.issue ??= 'excluded HTTP source unreadable';
      return true;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > maxEntries || scripts >= maxScripts || bytes >= maxScanBytes) return false;
      if (child.name.startsWith('.') || ignored.has(child.name)) continue;
      const file = directory ? directory + '/' + child.name : child.name;
      if (child.isDirectory()) {
        if (workspacePackages.has(path.join(root, file))) continue;
        if (!scan(file)) return false;
        continue;
      }
      if (!child.isFile() || Object.prototype.hasOwnProperty.call(index.files, file) ||
          !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
      try {
        const absolute = checkPath(file);
        const size = statSync(absolute).size;
        if (size > maxFileBytes) {
          result.issue ??= 'excluded HTTP source size limit';
          continue;
        }
        if (bytes + size > maxScanBytes) return false;
        bytes += size;
        const text = readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '');
        const globalFetch = /\bfetch\s*(?:[<(]|\?\.|\/[/\*])/.test(text);
        const httpImport = /\bfrom(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*['"](?:axios|node-fetch|undici|(?:node:)?https?)['"]/.test(text);
        if (!globalFetch && !httpImport) continue;
        scripts++;
        parse(root, file, text, routes, config, entry => fetches.push(entry));
      } catch {
        result.issue ??= 'excluded HTTP source unreadable';
      }
    }
    return true;
  };
  if (!scan('')) result.issue ??= 'excluded HTTP source scan limit';
  return result;
}
