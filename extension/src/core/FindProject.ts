import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Minimatch } from 'minimatch';

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

function readManifest(directory: string): Manifest | undefined {
  const manifest = join(directory, 'package.json');
  try {
    if (statSync(manifest, { throwIfNoEntry: false })?.isFile()) {
      return JSON.parse(readFileSync(manifest, 'utf8'));
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && !unavailable.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

function hasNextDependency(pkg: Manifest | undefined): boolean {
  return typeof pkg?.dependencies?.next === 'string' || typeof pkg?.devDependencies?.next === 'string';
}

function workspaceAt(directory: string, pkg: Manifest | undefined): Workspace | undefined {
  const workspaces = pkg?.workspaces;
  const paths = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  if (!Array.isArray(paths)) return;
  const patterns = paths.filter(path => typeof path === 'string' && path.length > 0).map(path =>
    new Minimatch(path.replace(/^(!*)\.\//, '$1').replace(/\/+$/, ''), { flipNegate: true, nocomment: true }));
  return { directory, hasNext: hasNextDependency(pkg), patterns };
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

function hasWorkspaceNext(directory: string, workspace: Workspace | undefined): boolean {
  if (!workspace?.hasNext) return false;
  const member = relative(workspace.directory, directory).split(sep).join('/');
  return workspace.patterns.reduce((included, pattern) =>
    pattern.match(member) ? !pattern.negate : included, false);
}

export function routerDirectory(directory: string, router: 'app' | 'pages'): string {
  const root = join(directory, router);
  return existsSync(root) ? root : join(directory, 'src', router);
}

function hasRouteFile(directory: string, router: 'app' | 'pages'): boolean {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    const isRoute = router === 'app'
      ? /^(?:page|layout|route)\.[jt]sx?$/
      : /^(?!_(?:app|document|error)\.[jt]sx?$)(?!.*\.d\.ts$).+\.[jt]sx?$/;
    return entries.some(entry => entry.isFile() && isRoute.test(entry.name)) ||
      entries.some(entry => entry.isDirectory() && !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' && (router === 'pages' || !entry.name.startsWith('_')) &&
        hasRouteFile(join(directory, entry.name), router));
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
  let routedConfig: string | undefined;
  let nextApp: string | undefined;
  let level: Candidate[] = [{ directory: start, inTooling: false, workspace: ancestorWorkspace(start) }];
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: Candidate[] = [];
    for (const candidate of level) {
      const { directory, inTooling } = candidate;
      try {
        const config = projectConfig(directory);
        if (config) firstConfig ??= candidate;
        const pkg = readManifest(directory);
        const hasNext = hasNextDependency(pkg);
        const workspace = candidate.workspace && !existsSync(join(directory, '.git')) ? candidate.workspace : undefined;
        if (hasNext) {
          firstNextPackage ??= directory;
          if (!inTooling) {
            nextPackage ??= directory;
            if (config) configuredNextPackage ??= directory;
          }
        }
        if (!inTooling && (hasNext || (config && hasWorkspaceNext(directory, workspace))) &&
            (hasRouteFile(routerDirectory(directory, 'app'), 'app') ||
              hasRouteFile(routerDirectory(directory, 'pages'), 'pages'))) {
          if (depth === 0 || (config && hasNext)) return directory;
          if (hasNext) nextApp ??= directory;
          else routedConfig ??= directory;
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
  const routedProject = nextApp ?? routedConfig;
  if (routedProject) return routedProject;
  if (firstConfig?.inTooling) {
    return configuredNextPackage ?? nextPackage ?? firstConfig.directory;
  }
  return firstConfig?.directory ?? nextPackage ?? firstNextPackage;
}

export function missingProject(root: string) {
  return `Neorion found no tsconfig.json, jsconfig.json, or package.json with a next dependency under ${root}.`;
}
