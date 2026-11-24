import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ignoredProjectDirectories = ['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public'] as const;
const excluded = new Set<string>(ignoredProjectDirectories);
const maxDepth = 4;

export function projectConfig(directory: string): string | undefined {
  return ['tsconfig.json', 'jsconfig.json'].map(name => join(directory, name))
    .find(file => statSync(file, { throwIfNoEntry: false })?.isFile());
}

function hasNextDependency(directory: string): boolean {
  const manifest = join(directory, 'package.json');
  if (!statSync(manifest, { throwIfNoEntry: false })?.isFile()) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof pkg?.dependencies?.next === 'string' || typeof pkg?.devDependencies?.next === 'string';
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

export function findProject(root: string): string | undefined {
  const start = resolve(root);
  let fallback: string | undefined;
  let level = [start];
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const directory of level) {
      try {
        if (projectConfig(directory)) return directory;
        if (!fallback && hasNextDependency(directory)) fallback = directory;
        if (depth === maxDepth || directory === homedir()) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name)) {
            next.push(join(directory, entry.name));
          }
        }
      } catch (error) {
        if (!['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    level = next.sort((a, b) => a.localeCompare(b));
  }
  return fallback;
}

export function missingProject(root: string) {
  return `Neorion found no tsconfig.json, jsconfig.json, or package.json with a next dependency under ${root}.`;
}
