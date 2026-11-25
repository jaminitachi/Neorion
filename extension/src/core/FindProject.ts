import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Minimatch } from 'minimatch';
import { parse } from 'yaml';
import { metadataRouteKind } from './AppMetadata';

export const ignoredProjectDirectories = ['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public'] as const;
const excluded = new Set<string>(ignoredProjectDirectories);
const toolingDirectories = new Set(['cypress', 'e2e', 'playwright', 'scripts', 'tests']);
const unavailable = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);
const maxDepth = 4;

interface Candidate {
  directory: string;
  inTooling: boolean;
  workspace?: Workspace;
}

interface Manifest {
  dependencies?: { next?: unknown };
  devDependencies?: { next?: unknown };
  workspaces?: string[] | { packages?: string[] };
}

interface Workspace {
  directory: string;
  hasNext: boolean;
  patterns: Minimatch[];
}

export function projectConfig(directory: string): string | undefined {
  return ['tsconfig.json', 'jsconfig.json'].map(name => join(directory, name))
    .find(file => statSync(file, { throwIfNoEntry: false })?.isFile());
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
  return typeof pkg?.dependencies?.next === 'string' || typeof pkg?.devDependencies?.next === 'string';
}

function workspaceAt(directory: string, pkg: Manifest | undefined): Workspace | undefined {
  const workspaces = pkg?.workspaces;
  const paths = pnpmPackages(directory) ?? (Array.isArray(workspaces) ? workspaces : workspaces?.packages);
  if (!Array.isArray(paths)) return;
  const patterns = paths.flatMap(path => typeof path === 'string' && path.length > 0
    ? [new Minimatch(path.replace(/^(!*)\.\//, '$1').replace(/\/+$/, ''), { flipNegate: true, nocomment: true })]
    : []);
  return { directory, hasNext: hasNextDependency(pkg), patterns };
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

function ancestorWorkspace(directory: string): Workspace | undefined {
  while (!existsSync(join(directory, '.git'))) {
    const parent = dirname(directory);
    if (parent === directory) break;
    const workspace = workspaceAt(parent, readManifest(parent));
    if (workspace) return workspace;
    directory = parent;
  }
}

function isWorkspaceMember(directory: string, workspace: Workspace): boolean {
  const member = relative(workspace.directory, directory).split(sep).join('/');
  return workspace.patterns.reduce((included, pattern) =>
    pattern.match(member) ? !pattern.negate : included, false);
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

export function findProject(root: string): string | undefined {
  const start = resolve(root);
  let firstConfig: Candidate | undefined;
  let firstNextPackage: string | undefined;
  let nextPackage: string | undefined;
  let configuredNextPackage: string | undefined;
  let hoistedApp: string | undefined;
  let nextApp: string | undefined;
  let level: Candidate[] = [{ directory: start, inTooling: false, workspace: ancestorWorkspace(start) }];
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: Candidate[] = [];
    for (const candidate of level) {
      const { directory, inTooling, workspace } = candidate;
      try {
        if (workspace && existsSync(join(directory, '.git'))) continue;
        const config = projectConfig(directory);
        if (config) firstConfig ??= candidate;
        const pkg = readManifest(directory);
        const member = pkg !== undefined && workspace !== undefined && isWorkspaceMember(directory, workspace);
        const eligible = depth === 0 || !workspace || member;
        const hasNext = hasNextDependency(pkg);
        if (eligible && hasNext) {
          firstNextPackage ??= directory;
          if (!inTooling) {
            nextPackage ??= directory;
            if (config) configuredNextPackage ??= directory;
          }
        }
        if (eligible && !inTooling && (hasNext || (member && workspace?.hasNext)) &&
            (hasRouteFile(routerDirectory(directory, 'app'), 'app') ||
              hasRouteFile(routerDirectory(directory, 'pages'), 'pages'))) {
          if (depth === 0 || (config && hasNext)) return directory;
          if (hasNext) nextApp ??= directory;
          else hoistedApp ??= directory;
        }
        if (depth === maxDepth || directory === homedir()) continue;
        const childWorkspace = workspaceAt(directory, pkg) ?? workspace;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name)) {
            next.push({
              directory: join(directory, entry.name),
              inTooling: inTooling || toolingDirectories.has(entry.name),
              workspace: childWorkspace,
            });
          }
        }
      } catch (error) {
        if (!unavailable.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    level = next.sort((a, b) => a.directory.localeCompare(b.directory));
  }
  const routedProject = nextApp ?? hoistedApp;
  if (routedProject) return routedProject;
  if (firstConfig?.inTooling) {
    return configuredNextPackage ?? nextPackage ?? firstConfig.directory;
  }
  return firstConfig?.directory ?? nextPackage ?? firstNextPackage;
}

export function missingProject(root: string) {
  return `Neorion found no tsconfig.json, jsconfig.json, or package.json with a next dependency under ${root}.`;
}
