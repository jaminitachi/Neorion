import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const ignoredProjectDirectories = ['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public'] as const;
const excluded = new Set<string>(ignoredProjectDirectories);
const toolingDirectories = new Set(['cypress', 'e2e', 'playwright', 'scripts', 'tests']);
const unavailable = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);
const maxDepth = 4;

interface Candidate {
  directory: string;
  inTooling: boolean;
  ancestorHasNext: boolean;
}

export function projectConfig(directory: string): string | undefined {
  return ['tsconfig.json', 'jsconfig.json'].map(name => join(directory, name))
    .find(file => statSync(file, { throwIfNoEntry: false })?.isFile());
}

function hasNextDependency(directory: string): boolean {
  const manifest = join(directory, 'package.json');
  try {
    if (!statSync(manifest, { throwIfNoEntry: false })?.isFile()) return false;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof pkg?.dependencies?.next === 'string' || typeof pkg?.devDependencies?.next === 'string';
  } catch (error) {
    if (error instanceof SyntaxError || unavailable.has((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

function hasAncestorNextDependency(directory: string): boolean {
  for (let parent = dirname(directory); parent !== directory; parent = dirname(directory)) {
    if (hasNextDependency(parent)) return true;
    directory = parent;
  }
  return false;
}

function hasRouterDirectory(directory: string): boolean {
  return ['app', 'pages', 'src/app', 'src/pages'].some(name =>
    statSync(join(directory, name), { throwIfNoEntry: false })?.isDirectory());
}

export function findProject(root: string): string | undefined {
  const start = resolve(root);
  let firstConfig: Candidate | undefined;
  let firstNextPackage: string | undefined;
  let nextPackage: string | undefined;
  let configuredNextPackage: string | undefined;
  let routedConfig: string | undefined;
  let nextApp: string | undefined;
  let level: Candidate[] = [{ directory: start, inTooling: false, ancestorHasNext: hasAncestorNextDependency(start) }];
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: Candidate[] = [];
    for (const candidate of level) {
      const { directory, inTooling, ancestorHasNext } = candidate;
      try {
        const config = projectConfig(directory);
        if (config) firstConfig ??= candidate;
        const hasNext = hasNextDependency(directory);
        if (hasNext) {
          firstNextPackage ??= directory;
          if (!inTooling) {
            nextPackage ??= directory;
            if (config) configuredNextPackage ??= directory;
          }
        }
        if (!inTooling && (hasNext || (config && ancestorHasNext)) && hasRouterDirectory(directory)) {
          if (depth === 0 || (config && hasNext)) return directory;
          if (hasNext) nextApp ??= directory;
          else routedConfig ??= directory;
        }
        if (depth === maxDepth || directory === homedir()) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name)) {
            next.push({
              directory: join(directory, entry.name),
              inTooling: inTooling || toolingDirectories.has(entry.name),
              ancestorHasNext: ancestorHasNext || hasNext,
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
