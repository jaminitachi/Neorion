import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ignoredProjectDirectories = ['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public'] as const;
const excluded = new Set<string>(ignoredProjectDirectories);
const excludedNext = new Set([...excluded, 'cypress', 'e2e', 'playwright', 'tests', 'scripts',
  'examples', 'example', 'demo', 'demos', 'samples', 'docs', 'playground']);
const configNames = ['tsconfig.json', 'jsconfig.json'];
const nextConfigNames = ['js', 'mjs', 'ts', 'cjs'].map(ext => `next.config.${ext}`);

export type ProjectSelection = { directory: string; guessCandidates?: string[] };

function unavailable(error: unknown) {
  return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function isFile(file: string) {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile();
  } catch (error) {
    if (!unavailable(error)) throw error;
    return false;
  }
}

export function projectConfig(directory: string): string | undefined {
  return configNames.map(name => join(directory, name)).find(isFile);
}

export function nextConfig(directory: string): string | undefined {
  return nextConfigNames.map(name => join(directory, name)).find(isFile);
}

function hasNextDependency(directory: string): boolean {
  const manifest = join(directory, 'package.json');
  if (!isFile(manifest)) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof pkg?.dependencies?.next === 'string' || typeof pkg?.devDependencies?.next === 'string';
  } catch (error) {
    if (error instanceof SyntaxError || unavailable(error)) return false;
    throw error;
  }
}

function* nestedDirectories(start: string, ignored: ReadonlySet<string>, maxDepth = Infinity) {
  let level = [start];
  const home = homedir();
  for (let depth = 0; level.length && depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const directory of level) {
      if (directory === home) continue;
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name)) {
            next.push(join(directory, entry.name));
          }
        }
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    level = next.sort((a, b) => a.localeCompare(b));
    yield* level;
  }
}

export function selectProject(root: string): ProjectSelection | undefined {
  const start = resolve(root);
  if (hasNextDependency(start) || nextConfig(start)) return { directory: start };

  const apps = [];
  for (const directory of nestedDirectories(start, excludedNext)) {
    const dependency = hasNextDependency(directory);
    if (dependency || nextConfig(directory)) apps.push({ directory, dependency });
  }
  if (apps.length === 1) return { directory: apps[0].directory };
  const rootConfig = projectConfig(start);
  if (apps.length > 1) {
    const candidates = apps.map(app => app.directory);
    // Master checks the requested directory's config first, then searches breadth-first.
    if (rootConfig) return { directory: start, guessCandidates: [start, ...candidates] };
    const chosen = apps.find(app => projectConfig(app.directory)) ?? apps.find(app => app.dependency) ?? apps[0];
    return { directory: chosen.directory, guessCandidates: candidates };
  }

  if (rootConfig) return { directory: start };
  const configs = [...nestedDirectories(start, excluded, 4)].filter(projectConfig);
  if (configs.length) return { directory: configs[0], guessCandidates: configs };
}

export function findProject(root: string): string | undefined {
  return selectProject(root)?.directory;
}

export function missingProject(root: string) {
  return `Neorion found no tsconfig.json, jsconfig.json, next.config file, or package.json with a next dependency under ${root}.`;
}
