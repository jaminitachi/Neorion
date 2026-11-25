import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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

export type ProjectSelection = { directory: string; guessCandidates?: string[]; searchLimited?: boolean };

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

// A missing manifest allows hoisting. A broken manifest can't establish a project.
function nextDependency(directory: string): 'runtime' | 'development' | false | null {
  const manifest = join(directory, 'package.json');
  if (!isFile(manifest)) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
    if (typeof pkg.dependencies?.next === 'string') return 'runtime';
    return typeof pkg.devDependencies?.next === 'string' ? 'development' : false;
  } catch (error) {
    if (error instanceof SyntaxError || unavailable(error)) return null;
    throw error;
  }
}

function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (!unavailable(error)) throw error;
    return [];
  }
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

function hasOwnRoutes(directory: string) {
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
  if (confirm && (selection?.directory === start || selection?.guessCandidates?.includes(start) ||
    !selection && stat(start)?.isDirectory())) return { directory: start };
  return selection;
}

function discoverProject(start: string): ProjectSelection | undefined {
  if (nextConfig(start)) return { directory: start };
  const manifestNext = nextDependency(start);
  const dependency = !!manifestNext;
  if (dependency && hasOwnRoutes(start)) return { directory: start };
  const parent = parentProject(start);
  // A nested candidate can be chosen by opening it directly, including apps with hoisted Next.
  if (parent.project && (dependency || manifestNext !== null && parent.next && hasInheritedRoutes(start))) {
    return { directory: start };
  }
  const rootConfig = projectConfig(start);
  if (rootConfig && excludedNextDirectory(basename(start))) return { directory: start };

  const inheritedNext = new Map([[start, manifestNext !== null && (dependency || parent.next)]]);
  const apps: { directory: string; dependency: boolean }[] = [];
  const developmentPackages: typeof apps = [];
  let visited = 0;
  for (const directory of nestedDirectories(start, name => !excludedNextDirectory(name), projectDepth)) {
    if (visited++ === directoryLimit) break;
    const manifestNext = nextDependency(directory);
    const dependency = !!manifestNext;
    const canInherit = manifestNext !== null && inheritedNext.get(dirname(directory)) === true &&
      !existsSync(join(directory, '.git'));
    inheritedNext.set(directory, dependency || canInherit);
    if (manifestNext === 'runtime' || nextConfig(directory) || (dependency || canInherit) && hasInheritedRoutes(directory)) {
      apps.push({ directory, dependency });
    } else if (dependency) {
      developmentPackages.push({ directory, dependency });
    }
  }
  const searchLimited = visited > directoryLimit;
  // A build-time Next dependency is weaker evidence than an app or a runtime dependency.
  const eligible = apps.length ? apps : developmentPackages;
  if (apps.length + developmentPackages.length === 1 && !searchLimited) return { directory: eligible[0].directory };
  if (eligible.length) {
    const candidates = eligible.map(app => app.directory);
    // Master checks the requested directory's config first, then searches breadth-first.
    if (rootConfig) return { directory: start, guessCandidates: [start, ...candidates], searchLimited };
    const chosen = eligible.find(app => projectConfig(app.directory)) ?? eligible.find(app => app.dependency) ?? eligible[0];
    return { directory: chosen.directory, guessCandidates: candidates, searchLimited };
  }

  if (rootConfig) return searchLimited ? { directory: start, guessCandidates: [start], searchLimited } : { directory: start };
  const configs: string[] = [];
  let visitedConfigs = 0;
  for (const directory of nestedDirectories(start, name => !excludedConfigDirectory(name), projectDepth)) {
    if (visitedConfigs++ === directoryLimit) break;
    if (projectConfig(directory)) configs.push(directory);
  }
  // Preserve master's config-first fallback for repos without Next evidence, including Cypress.
  const directory = dependency ? start : configs[0];
  if (directory) {
    const candidates = dependency ? [start, ...configs] : configs;
    return { directory, guessCandidates: candidates, searchLimited: searchLimited || visitedConfigs > directoryLimit };
  }
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
