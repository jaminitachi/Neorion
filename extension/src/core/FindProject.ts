import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ignoredProjectDirectories = ['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public'] as const;
const excluded = new Set<string>(ignoredProjectDirectories);
const excludedConfigs = new Set([...excluded, 'example', 'examples', 'demo', 'demos', 'samples', 'docs',
  'website', 'playground', 'playgrounds', 'storybook']);
const tooling = new Set(['cypress', 'e2e', 'playwright', 'test', 'tests', '__tests__', 'scripts']);
const configNames = ['tsconfig.json', 'jsconfig.json'];
const nextConfigNames = ['js', 'mjs', 'ts', 'cjs'].map(ext => `next.config.${ext}`);
const projectDepth = 4;
const directoryLimit = 2048;
const hintLimit = 5;

export type ProjectApp = { directory: string; id: string; name: string; sandbox: boolean };
export type ProjectSelection = {
  directory: string; guessCandidates?: string[]; searchLimited?: boolean; developmentPackages?: number; apps?: ProjectApp[];
};

function excludedConfigDirectory(name: string) {
  return excludedConfigs.has(name) || /-(?:test|tests|testing|e2e)$|^(?:playgrounds?|demos?|examples?)-/.test(name);
}

function excludedNextDirectory(name: string) {
  return tooling.has(name) || excludedConfigDirectory(name);
}

function unavailable(error: unknown) {
  return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function stat(file: string, followLinks = true) {
  try {
    return (followLinks ? statSync : lstatSync)(file, { throwIfNoEntry: false });
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
}

function isFile(file: string) {
  return stat(file)?.isFile();
}

export function projectConfig(directory: string): string | undefined {
  return configNames.map(name => join(directory, name)).find(isFile);
}

export function nextConfig(directory: string): string | undefined {
  return nextConfigNames.map(name => join(directory, name)).find(isFile);
}

function projectManifest(directory: string) {
  const manifest = join(directory, 'package.json');
  if (!isFile(manifest)) return;
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    return pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg : null;
  } catch (error) {
    if (error instanceof SyntaxError || unavailable(error)) return null;
    throw error;
  }
}

// A missing manifest allows hoisting. A broken manifest can't establish a project.
function nextDependency(directory: string): 'runtime' | 'development' | false | null {
  const pkg = projectManifest(directory);
  if (pkg === null) return null;
  if (typeof pkg?.dependencies?.next === 'string') return 'runtime';
  return typeof pkg?.devDependencies?.next === 'string' ? 'development' : false;
}

function workspacePatterns(directory: string): string[] {
  const workspace = projectManifest(directory)?.workspaces;
  if (Array.isArray(workspace)) return workspace;
  if (Array.isArray(workspace?.packages)) return workspace.packages;
  try {
    const yaml = readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8');
    const packages = /^packages:[^\S\r\n]*(?:#.*)?\r?\n((?:[ \t]+[^\r\n]*\r?\n|\r?\n)*)/m.exec(yaml)?.[1] ?? '';
    return [...(packages + '\n').matchAll(/^\s*-\s+['"]?([!\w./*?-]+)['"]?\s*(?:#.*)?$/gm)].map(match => match[1]);
  } catch { return []; }
}

function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (!unavailable(error)) throw error;
    return [];
  }
}

export function workspaceDirectories(root: string) {
  const patterns = workspacePatterns(root).filter(pattern => typeof pattern === 'string' &&
    /^!?[\w./*?-]+$/.test(pattern) && !isAbsolute(pattern.replace(/^!/, '')) && !pattern.split('/').includes('..'));
  if (!patterns.length) return;
  const directories = new Set<string>();
  const visited = new Set<string>();
  let limited = false;
  const matchSegment = (pattern: string) => new RegExp('^' + pattern.replace(/\./g, '\\.')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  const expansions = (pattern: string) => {
    const parts = pattern.split('/').filter(part => part && part !== '.');
    const matchers = parts.map(matchSegment);
    const matches: string[] = [];
    function visit(directory: string, index: number) {
      if (limited || directory !== root && existsSync(join(directory, '.git'))) return;
      visited.add(directory);
      if (visited.size > directoryLimit) {
        limited = true;
        return;
      }
      if (index === parts.length) {
        if (isFile(join(directory, 'package.json'))) matches.push(directory);
        return;
      }
      const part = parts[index];
      if (!/[*?]/.test(part)) {
        const child = join(directory, part);
        if (stat(child, false)?.isDirectory()) visit(child, index + 1);
        return;
      }
      if (part === '**') visit(directory, index + 1);
      for (const entry of entries(directory)) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || excluded.has(entry.name)) continue;
        if (part === '**') visit(join(directory, entry.name), index);
        else if (matchers[index].test(entry.name)) visit(join(directory, entry.name), index + 1);
      }
    }
    visit(root, 0);
    return matches;
  };
  for (const pattern of patterns) if (!pattern.startsWith('!')) for (const directory of expansions(pattern)) directories.add(directory);
  for (const pattern of patterns) if (pattern.startsWith('!')) {
    for (const directory of expansions(pattern.slice(1))) directories.delete(directory);
  }
  return { directories: [...directories].sort((a, b) => a.localeCompare(b)), limited };
}

function* nestedDirectories(start: string, descend: (name: string, directory: string) => boolean, maxDepth: number) {
  let level = [start];
  const home = homedir();
  for (let depth = 0; level.length && depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const directory of level) {
      if (directory === home) continue;
      for (const entry of entries(directory)) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && descend(entry.name, directory)) {
          next.push(join(directory, entry.name));
        }
      }
      if (next.length > directoryLimit) break;
    }
    level = next.sort((a, b) => a.localeCompare(b));
    yield* level;
  }
}

export function hasOwnRoutes(directory: string) {
  const src = join(directory, 'src');
  const bases = stat(src, false)?.isDirectory() && !existsSync(join(src, '.git')) ? [directory, src] : [directory];
  for (const router of ['app', 'pages']) {
    for (const base of bases) {
      const root = join(base, router);
      // Don't follow linked router directories. Discovery only examines this checkout.
      if (!stat(root, false)?.isDirectory() || existsSync(join(root, '.git'))) continue;
      if (hasRouteFile(root, router)) return true;
      let remaining = directoryLimit;
      const routes = nestedDirectories(root, (name, parent) => !excluded.has(name) &&
        (router === 'pages' || !name.startsWith('_')) && !existsSync(join(parent, name, '.git')), Infinity);
      for (const folder of routes) {
        if (--remaining === 0) break;
        if (hasRouteFile(folder, router)) return true;
      }
    }
  }
  return false;
}

function hasRouteFile(directory: string, router: string) {
  return entries(directory).some(entry => entry.isFile() && (router === 'app'
    ? /^(?:page|layout|route)\.[jt]sx?$/.test(entry.name)
    // In the Pages Router, ordinary source basenames such as index.jsx are routes.
    : /\.[jt]sx?$/.test(entry.name) && !/(?:^_(?:app|document|error)\.|\.(?:d|test|spec)\.[jt]sx?$)/.test(entry.name)));
}

function hasInheritedRoutes(directory: string) {
  // src/app and src/pages belong to the project above src.
  return basename(directory) !== 'src' && hasOwnRoutes(directory);
}

function parentProject(start: string) {
  let directory = start;
  let project = false;
  let next = false;
  for (let depth = 0; depth < projectDepth && !existsSync(join(directory, '.git')); depth++) {
    const name = basename(directory);
    if (excludedNextDirectory(name) || name.startsWith('.')) break;
    const parent = dirname(directory);
    if (parent === directory || parent === homedir()) break;
    project ||= isFile(join(parent, 'package.json')) || existsSync(join(parent, '.git'));
    const dependency = nextDependency(parent);
    if (dependency === null) break;
    next ||= !!dependency;
    directory = parent;
  }
  return { project, next };
}

export function selectProject(root: string, confirm = false): ProjectSelection | undefined {
  const start = resolve(root);
  const selection = discoverProject(start);
  if (confirm && selection?.guessCandidates &&
      (selection.directory === start || selection.guessCandidates.includes(start))) return { directory: start };
  return selection;
}

function discoverProject(start: string): ProjectSelection | undefined {
  const ownConfig = nextConfig(start);
  const manifestNext = nextDependency(start);
  const dependency = !!manifestNext;
  const ownRoutes = (ownConfig || dependency) && hasOwnRoutes(start);
  const declared = workspaceDirectories(start);
  const named = (directory: string, id: string, sandbox = false): ProjectApp => {
    const name = projectManifest(directory)?.name;
    return { directory, id, name: typeof name === 'string' ? name : basename(directory), sandbox };
  };
  const standalone = (): ProjectSelection => ({ directory: start, apps: [named(start, basename(start))] });
  const hasWorkspaceChildren = declared?.directories.some(directory => directory !== start);
  if ((ownConfig || ownRoutes) && !hasWorkspaceChildren) return standalone();
  const parent = parentProject(start);
  // A nested candidate can be chosen by opening it directly, including apps with hoisted Next.
  if (!hasWorkspaceChildren && parent.project &&
      (dependency || manifestNext !== null && parent.next && hasInheritedRoutes(start))) {
    return hasOwnRoutes(start) ? standalone() : { directory: start };
  }
  const rootConfig = projectConfig(start);
  if (rootConfig && excludedNextDirectory(basename(start))) return { directory: start };

  const inheritedNext = new Map([[start, manifestNext !== null && (dependency || parent.next)]]);
  const apps: { directory: string; dependency: boolean; sandbox: boolean }[] = [];
  const developmentPackages: typeof apps = [];
  const verified = ownRoutes ? [named(start, '.')] : [];
  const discovered = new Set(declared?.directories);
  // Fall back to the project-root scan for checkouts without workspace metadata.
  const directories = declared?.directories.length ? declared.directories :
    nestedDirectories(start, name => !excludedNextDirectory(name), projectDepth);
  let visited = 0;
  for (const directory of directories) {
    if (directory === start) continue;
    if (visited++ === directoryLimit) break;
    const manifestNext = nextDependency(directory);
    const dependency = !!manifestNext;
    const canInherit = manifestNext !== null && (inheritedNext.get(dirname(directory)) === true ||
      discovered.has(directory) && inheritedNext.get(start) === true) && !existsSync(join(directory, '.git'));
    inheritedNext.set(directory, dependency || canInherit);
    const id = relative(start, directory).split(sep).join('/');
    const sandbox = id.split('/').some(part => part === 'dev' || part === 'sandbox' || part === 'sandboxes' ||
      excludedNextDirectory(part) || /^(?:dev|sandbox)-/.test(part) || /^example-apps?$/.test(part));
    const config = nextConfig(directory);
    const manifest = dependency || canInherit || config ? projectManifest(directory) : undefined;
    const hoistedApp = id.startsWith('apps/') && !id.split('/').slice(1).some(part => ['app', 'pages', 'src'].includes(part));
    const routes = (dependency || !!config || canInherit && (!!manifest || hoistedApp || !!projectConfig(directory))) &&
      hasInheritedRoutes(directory);
    const nextScript = Object.values(manifest?.scripts ?? {}).some(script =>
      typeof script === 'string' && /(?:^|\s)next\s+(?:dev|build|start)(?:\s|$)/.test(script));
    if (routes || config && nextScript) {
      verified.push({ directory, id, name: typeof manifest?.name === 'string' ? manifest.name : basename(directory), sandbox });
    }
    // Runtime-only dependencies can still be chosen explicitly as projects, but aren't proof of an app.
    if (manifestNext === 'runtime' || config || routes) apps.push({ directory, dependency, sandbox });
    else if (dependency) developmentPackages.push({ directory, dependency, sandbox });
  }
  const searchLimited = visited > directoryLimit || !!declared?.limited;
  const products = verified.filter(app => !app.sandbox);
  const appOptions = verified.length ? verified.sort((a, b) => Number(a.sandbox) - Number(b.sandbox) || a.id.localeCompare(b.id)) : undefined;
  if (products.length && verified.length > 1) return { directory: products[0].directory, apps: appOptions, searchLimited };
  if (ownRoutes && !searchLimited) return standalone();

  const configs: string[] = [];
  // A config-only library is a better default than a sandbox or a tooling directory.
  let visitedConfigs = 0;
  if (!rootConfig && !apps.some(app => !app.sandbox)) {
    for (const directory of nestedDirectories(start, name => !excludedConfigDirectory(name), projectDepth)) {
      if (visitedConfigs++ === directoryLimit) break;
      if (projectConfig(directory)) configs.push(directory);
    }
  }
  const libraries = configs.filter(directory => relative(start, directory).split(sep)[0] === 'packages' &&
    isFile(join(directory, 'package.json')) && stat(join(directory, 'src'))?.isDirectory())
    .map(directory => ({ directory, pkg: projectManifest(directory) }))
    .filter(({ pkg }) => typeof pkg?.name === 'string' && pkg.private !== true);
  libraries.sort((a, b) => {
    const rank = (name: string) => name === basename(start) ? 0 : name.startsWith('@') ? 2 : 1;
    return rank(a.pkg.name) - rank(b.pkg.name) || a.directory.localeCompare(b.directory);
  });
  const preferredLibrary = libraries[0]?.directory;
  const eligible = apps.length ? apps : developmentPackages;
  const guess = (directory: string, candidates: string[]) => ({
    directory, guessCandidates: candidates, searchLimited: searchLimited || visitedConfigs > directoryLimit,
    developmentPackages: apps.length ? developmentPackages.length : 0, apps: appOptions
  });
  if (preferredLibrary && !dependency && !apps.some(app => !app.sandbox)) {
    return guess(preferredLibrary, [...new Set([...libraries.map(pkg => pkg.directory), ...eligible.map(app => app.directory)])]);
  }
  if (verified.length > 1 && !rootConfig) return { directory: verified[0].directory, apps: appOptions, searchLimited };
  if (apps.length + developmentPackages.length === 1 && !searchLimited) return { directory: eligible[0].directory, apps: appOptions };
  if (eligible.length) {
    const candidates = eligible.map(app => app.directory);
    if (rootConfig) return guess(start, [start, ...candidates]);
    const preferred = eligible.filter(app => !app.sandbox);
    const ranked = preferred.length ? preferred : eligible;
    const chosen = products[0] ?? ranked.find(app => projectConfig(app.directory)) ?? ranked.find(app => app.dependency) ?? ranked[0];
    return guess(chosen.directory, candidates);
  }

  if (rootConfig) return searchLimited ? guess(start, [start]) : { directory: start };
  const directory = dependency ? start : configs[0];
  if (directory) return guess(directory, dependency ? [start, ...configs] : configs);
}

export function selectedApp(selection: ProjectSelection, name: string): ProjectSelection {
  const apps = selection.apps ?? [];
  const exact = apps.find(app => app.id === name);
  const matches = exact ? [exact] : apps.filter(app => app.name === name || basename(app.directory) === name);
  if (matches.length === 1) return { directory: matches[0].directory };
  const available = apps.length ? ' Available apps: ' + apps.map(app => JSON.stringify(app.id)).join(', ') + '.' : '';
  throw new Error((matches.length ? `Ambiguous app ${JSON.stringify(name)}.` : `Unknown app ${JSON.stringify(name)}.`) + available);
}

export function appMode(selection: ProjectSelection, force = false) {
  if (force && selection.apps?.length) return 'all';
  if (selection.searchLimited && selection.apps?.length && !selection.guessCandidates) return 'list';
  if ((selection.apps?.length ?? 0) < 2 || selection.guessCandidates) return 'single';
  return selection.apps!.length > 3 ? 'list' : 'all';
}

export function formatProjectCandidates(candidates: string[]) {
  const names = candidates.slice(0, hintLimit).map(directory => JSON.stringify(directory));
  const remaining = candidates.length - names.length;
  return names.join(', ') + (remaining ? ` and ${remaining} more` : '');
}

export function findProject(root: string): string | undefined {
  return selectProject(root)?.directory;
}

export function missingProject(root: string) {
  return `Neorion found no tsconfig.json, jsconfig.json, next.config file, or package.json with a next dependency under ${root}.`;
}
