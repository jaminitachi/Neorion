import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { makeRe } from 'minimatch';
import picomatch from 'picomatch';
import type { Node } from 'ts-morph';
import { type Issue, type Registration, slash, sourceExtension } from './RouteTypes';

const folderExtensions = ['.js', '.jsx', '.ts', '.tsx', '.md', '.mdx'];

function segments(name: string, param: string) {
  const result: { raw: string; url: string }[] = [];
  let raw = '';
  let url = '';
  let optional = false;
  let escaped = false;
  const finish = () => {
    if (raw) result.push({ raw, url });
    raw = url = '';
  };
  for (const [i, char] of [...name].entries()) {
    if (!escaped && !optional && (char === '.' || char === '/')) {
      finish();
      continue;
    }
    raw += char;
    if (escaped) {
      if (char === ']') escaped = false;
      else url += char;
    } else if (char === '[') escaped = true;
    else if (char === '(' && !optional) optional = true;
    else if (char === ')' && optional) {
      optional = false;
      url += '?';
    } else if (char === param && !url) url += /[./]|^$/.test(name[i + 1] ?? '') ? '*' : ':';
    else url += char;
  }
  if (optional || escaped || /[:*]/.test(name)) return;
  finish();
  return result;
}

function urlPath(parts: NonNullable<ReturnType<typeof segments>>, index: boolean) {
  return (index ? parts.slice(0, -1) : parts).flatMap(({ raw, url }) =>
    raw.startsWith('_') ? [] : [raw.endsWith('_') ? url.slice(0, -1) : url]).join('/');
}

type Candidate = Registration & { fullPath: string; key: string[]; layout: boolean };

function childrenOf(candidates: Candidate[], auto: boolean, issue: Issue): Registration[] {
  const winners = new Map<string, Candidate>();
  const parents = new Map<string, Candidate>();
  for (const route of candidates) {
    if (winners.has(route.id)) {
      issue(route.site, `duplicate file route ID ${route.id}`);
      continue;
    }
    winners.set(route.id, route);
    if (route.index || auto && !route.layout) continue;
    const key = route.key.join('/');
    const prior = parents.get(key);
    if (!prior || route.id < prior.id) parents.set(key, route);
  }
  const roots: Registration[] = [];
  const urls = new Set<string>();
  for (const route of winners.values()) {
    const matchKey = route.fullPath + (route.index ? '?index' : '');
    if (!auto && !route.layout && matchKey && urls.has(matchKey)) {
      issue(route.site, `file route URL collision at /${route.fullPath}`);
      continue;
    }
    if (!route.layout) urls.add(matchKey);
    let parent: Candidate | undefined;
    for (let n = route.key.length - (route.index && auto ? 0 : 1); n >= 0; n--) {
      parent = parents.get(route.key.slice(0, n).join('/'));
      if (parent && parent !== route) break;
      parent = undefined;
    }
    const local = parent?.fullPath && route.fullPath.startsWith(parent.fullPath + '/')
      ? route.fullPath.slice(parent.fullPath.length + 1) : route.fullPath === parent?.fullPath ? '' : route.fullPath;
    route.path = local || undefined;
    if (parent) (parent.children ??= []).push(route);
    else roots.push(route);
  }
  return roots;
}

type FileOptions = { directory: string; ignored: string[]; auto?: { param: string; colocation: string } };

export function fileRoutes(app: string, options: FileOptions, site: Node, issue: Issue): Registration[] {
  const { directory, ignored, auto } = options;
  if (/[\x00-\x1f]/.test(directory)) {
    issue(site, 'invalid file routes directory');
    return [];
  }
  const root = path.resolve(app, directory);
  const prefix = slash(path.relative(app, root));
  if (!prefix || prefix === '..' || prefix.startsWith('../')) {
    issue(site, 'file routes directory must be inside appDirectory');
    return [];
  }
  const files: { name: string; module: string }[] = [];
  const ignores = auto ? [] : ['**/.*', ...ignored].map(pattern => makeRe(pattern));
  const match = auto ? picomatch(ignored, { dot: true }) :
    (relative: string) => ignores.some(regex => regex && regex.test(relative));
  const visit = (directory: string) => {
    const entries = readdirSync(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(directory, entry.name);
      if (match(auto ? name : path.posix.join(prefix, name))) continue;
      if (auto && entry.name.startsWith(auto.colocation)) continue;
      if (entry.isSymbolicLink()) {
        issue(site, `symlinked file route unresolved (${prefix}/${name})`);
      } else if (entry.isDirectory()) {
        if (auto) visit(name);
        else {
          const available = readdirSync(path.join(root, name), { withFileTypes: true })
            .filter(file => file.isFile()).map(file => file.name);
          const modules = ['route', 'index'].flatMap(base => folderExtensions.map(ext => base + ext))
            .filter(module => available.includes(module));
          if (modules.length > 1) issue(site, `multiple folder route modules (${prefix}/${name})`);
          if (modules[0]) files.push({ name, module: name + '/' + modules[0] });
        }
      } else if (entry.isFile()) {
        if (auto && /\.server\.[^.]+$/.test(name)) continue;
        if (!sourceExtension.test(name) && !/\.mdx?$/.test(name) || /\.d\.[cm]?ts$/.test(name)) {
          if (!auto) issue(site, `unsupported file route module (${prefix}/${name})`);
          continue;
        }
        files.push({ name: name.replace(/\.[^.]+$/, ''), module: name });
      }
    }
  };
  if (!existsSync(root)) return [];
  const relativeRoot = path.relative(realpathSync(app), realpathSync(root));
  if (relativeRoot === '..' || relativeRoot.startsWith('..' + path.sep) || !lstatSync(root).isDirectory()) {
    issue(site, 'file routes directory is not a local directory');
    return [];
  }
  visit('');
  const candidates: Candidate[] = [];
  for (const { name, module } of files) {
    const parts = segments(name, auto?.param ?? '$');
    if (!parts?.length) {
      issue(site, `invalid file route syntax (${prefix}/${name})`);
      continue;
    }
    const last = parts.at(-1)!.raw;
    const index = auto ? parts.some(part => /^_?index$/.test(part.raw)) : name.endsWith('_index');
    const layout = auto ? /(?:^|[/.])_layout$/.test(name) : last.startsWith('_') && !index;
    const key = parts.map(part => part.raw);
    if (auto) {
      while (key.length && /^(?:_?index|_?route|_layout)$/.test(key.at(-1)!)) key.pop();
      if (name.includes('/')) while (/^_?route$/.test(parts.at(-1)?.raw ?? '')) parts.pop();
    }
    candidates.push({
      id: prefix + '/' + name, file: prefix + '/' + module, site, index, layout,
      fullPath: urlPath(parts, index), key
    });
  }
  // Official flat route ancestry is based on the raw name before escaping.
  if (!auto) candidates.sort((a, b) => b.id.length - a.id.length);
  return childrenOf(candidates, !!auto, issue);
}
