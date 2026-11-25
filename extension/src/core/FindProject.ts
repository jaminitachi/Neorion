// Project selection follows this order.
// 1. Keep the requested directory if it has routes and declares Next.js or inherits it
//    from an ancestor in the same Git checkout.
//    Routes include page, layout, route, and metadata files in app or src/app, and page and
//    API files in pages or src/pages.
// 2. Keep a requested directory with a project config when it does not declare Next.js.
// 3. At a workspace root, look for routed apps outside tooling and examples with valid member
//    manifests. pnpm's glob rules normalize paths and apply exclusions regardless of order.
//    Without a workspace, look for standalone descendant apps from an unconfigured directory
//    and for routed descendants that inherit Next.js from a root that declares it.
//    Prefer configured apps with their own Next.js dependency, then other direct dependencies,
//    then inherited ones.
// 4. Fall back to the root's Next.js dependency, or search descendants for configs and
//    Next.js packages. With Next.js candidates, prefer non-tooling configs, then Next.js packages,
//    then tooling configs. Otherwise, use the first config in breadth-first order.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { metadataRouteKind } from './AppMetadata';

// Use the CommonJS entry point in the CLI and extension bundles.
const { globSync } = require('tinyglobby') as typeof import('tinyglobby');

export const ignoredProjectDirectories = ['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public'] as const;
const excluded = new Set<string>(ignoredProjectDirectories);
const toolingDirectories = new Set([
  'cypress', 'e2e', 'integrations', 'playwright', 'scripts', 'test', 'tests',
  'example', 'examples', 'demo', 'demos', 'samples', 'playground', 'playgrounds',
]);
const unavailable = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);
const maxDepth = 4;

interface Candidate {
  directory: string;
  inTooling: boolean;
}

interface Manifest {
  dependencies?: { next?: unknown };
  devDependencies?: { next?: unknown };
  optionalDependencies?: { next?: unknown };
  workspaces?: string[] | { packages?: string[] };
}

export function projectConfig(directory: string): string | undefined {
  try {
    return ['tsconfig.json', 'jsconfig.json'].map(name => join(directory, name))
      .find(file => statSync(file, { throwIfNoEntry: false })?.isFile());
  } catch (error) {
    if (!unavailable.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

function readProjectFile(directory: string, name: string): string | undefined {
  const file = join(directory, name);
  try {
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) return readFileSync(file, 'utf8');
  } catch (error) {
    if (!unavailable.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

function readManifest(directory: string): Manifest | undefined {
  const file = readProjectFile(directory, 'package.json');
  if (file === undefined) return;
  try {
    const pkg = JSON.parse(file);
    if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) return pkg;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

function hasNextDependency(pkg: Manifest | undefined): boolean {
  return [pkg?.dependencies?.next, pkg?.devDependencies?.next, pkg?.optionalDependencies?.next]
    .some(version => typeof version === 'string');
}

function workspacePatterns(directory: string, pkg: Manifest | undefined): string[] | undefined {
  const workspaces = pkg?.workspaces;
  const paths = pnpmPackages(directory) ?? (Array.isArray(workspaces) ? workspaces : workspaces?.packages);
  if (Array.isArray(paths)) return paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
}

function pnpmPackages(directory: string): unknown[] | undefined {
  const file = readProjectFile(directory, 'pnpm-workspace.yaml');
  if (file === undefined) return;
  try {
    const packages = parse(file, { logLevel: 'error' })?.packages;
    return Array.isArray(packages) ? packages : [];
  } catch {
    // The file still marks a workspace boundary when its package list cannot be parsed.
    return [];
  }
}

function* checkoutAncestors(directory: string): Generator<string> {
  while (!existsSync(join(directory, '.git'))) {
    const parent = dirname(directory);
    if (parent === directory) break;
    yield parent;
    directory = parent;
  }
}

function inheritsNext(directory: string): boolean {
  for (const parent of checkoutAncestors(directory)) {
    if (hasNextDependency(readManifest(parent))) return true;
  }
  return false;
}

function workspaceMembers(root: string, patterns: string[]): Candidate[] {
  // Match manifest paths, as pnpm does, so e.g. apps/** can include apps/package.json.
  const manifests = globSync(patterns.map(pattern => pattern.replace(/\/?$/, '/package.json')), {
    cwd: root,
    expandDirectories: false,
    followSymbolicLinks: false,
    ignore: ['**/.git/**', '**/node_modules/**', '**/bower_components/**'],
  });
  const members = manifests.map(file => dirname(file)).filter(directory => directory !== '.');
  members.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return members.flatMap(member => {
    const directory = resolve(root, member);
    for (const parent of checkoutAncestors(directory)) {
      if (parent === root) {
        return [{ directory, inTooling: relative(root, directory).split(sep).some(part => toolingDirectories.has(part)) }];
      }
    }
    return [];
  });
}

export function routerDirectory(directory: string, router: 'app' | 'pages'): string {
  const root = join(directory, router);
  return existsSync(root) ? root : join(directory, 'src', router);
}

function hasRouteFile(directory: string, router: 'app' | 'pages', atRoot = true): boolean {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    const isRoute = router === 'app'
      ? /^(?:page|layout|route)\.[jt]sx?$/
      : /^(?!_(?:app|document|error)\.[jt]sx?$)(?!.*\.d\.ts$).+\.[jt]sx?$/;
    return entries.some(entry => entry.isFile() &&
      (isRoute.test(entry.name) || (router === 'app' && metadataRouteKind(entry.name, atRoot)))) ||
      entries.some(entry => entry.isDirectory() && !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' && (router === 'pages' || !entry.name.startsWith('_')) &&
        hasRouteFile(join(directory, entry.name), router, false));
  } catch (error) {
    if (!unavailable.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    return false;
  }
}

function hasProjectRoutes(directory: string): boolean {
  return hasRouteFile(routerDirectory(directory, 'app'), 'app') ||
    hasRouteFile(routerDirectory(directory, 'pages'), 'pages');
}

function* descendants(root: string): Generator<Candidate> {
  let level: Candidate[] = [{ directory: root, inTooling: false }];
  for (let depth = 0; level.length && depth < maxDepth; depth++) {
    const children: Candidate[] = [];
    for (const { directory, inTooling } of level) {
      if (directory === homedir()) continue;
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name)) {
            children.push({
              directory: join(directory, entry.name),
              inTooling: inTooling || toolingDirectories.has(entry.name),
            });
          }
        }
      } catch (error) {
        if (!unavailable.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    level = children.sort((a, b) => a.directory.localeCompare(b.directory));
    yield* level;
  }
}

export function findProject(root: string): string | undefined {
  const start = resolve(root);
  const manifest = readManifest(start);
  const hasOwnNext = hasNextDependency(manifest);
  if (hasProjectRoutes(start) && (hasOwnNext || inheritsNext(start))) return start;

  if (!hasOwnNext && projectConfig(start)) return start;

  const patterns = workspacePatterns(start, manifest);
  const candidates = patterns ? workspaceMembers(start, patterns) : [...descendants(start)];
  let routedWithNext: string | undefined;
  let routedWithInheritedNext: string | undefined;
  let nextPackage: string | undefined;
  let toolingNextPackage: string | undefined;
  for (const { directory, inTooling } of candidates) {
    const pkg = readManifest(directory);
    if (patterns && !pkg) continue;
    const hasNext = hasNextDependency(pkg);
    if (inTooling) {
      if (hasNext) toolingNextPackage ??= directory;
      continue;
    }
    if (hasNext) nextPackage ??= directory;
    if ((!hasNext && !patterns && !hasOwnNext) || !hasProjectRoutes(directory)) continue;
    if (hasNext) {
      if (projectConfig(directory)) return directory;
      routedWithNext ??= directory;
    } else if (inheritsNext(directory)) {
      routedWithInheritedNext ??= directory;
    }
  }
  if (routedWithNext || routedWithInheritedNext) return routedWithNext ?? routedWithInheritedNext;
  if (hasOwnNext) return start;

  const hasNextCandidate = Boolean(nextPackage || toolingNextPackage);
  let toolingConfig: string | undefined;
  // An independent checkout can have its own Next.js manifest and no config.
  let descendantNext: Candidate | undefined;
  for (const candidate of patterns ? descendants(start) : candidates) {
    const { directory, inTooling } = candidate;
    if (projectConfig(directory)) {
      if (!hasNextCandidate || !inTooling) return directory;
      toolingConfig ??= directory;
    } else if (patterns && !hasNextCandidate && (!descendantNext || (descendantNext.inTooling && !inTooling)) &&
      hasNextDependency(readManifest(directory))) {
      descendantNext = candidate;
    }
  }
  return nextPackage ?? toolingNextPackage ?? toolingConfig ?? descendantNext?.directory;
}

export function missingProject(root: string) {
  return `Neorion found no tsconfig.json, jsconfig.json, or package.json with a next dependency under ${root}.`;
}
