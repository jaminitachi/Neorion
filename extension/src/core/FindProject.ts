import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ignoredProjectDirectories = ['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public'] as const;
const excluded = new Set<string>(ignoredProjectDirectories);
const toolingDirectories = new Set(['cypress', 'e2e', 'playwright', 'scripts', 'tests']);
const maxDepth = 4;

interface Candidate {
  directory: string;
  inTooling: boolean;
}

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

function hasRouterDirectory(directory: string): boolean {
  return ['app', 'pages', 'src/app', 'src/pages'].some(name =>
    statSync(join(directory, name), { throwIfNoEntry: false })?.isDirectory());
}

export function findProject(root: string): string | undefined {
  let firstConfig: Candidate | undefined;
  let firstNextPackage: string | undefined;
  let routedConfig: string | undefined;
  let nextApp: string | undefined;
  let level: Candidate[] = [{ directory: resolve(root), inTooling: false }];
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: Candidate[] = [];
    for (const candidate of level) {
      const { directory, inTooling } = candidate;
      try {
        const config = projectConfig(directory);
        if (config) firstConfig ??= candidate;
        const hasNext = hasNextDependency(directory);
        if (hasNext) firstNextPackage ??= directory;
        if (!inTooling && (config || hasNext) && hasRouterDirectory(directory)) {
          if (config && hasNext) return directory;
          if (config) routedConfig ??= directory;
          if (hasNext) nextApp ??= directory;
        }
        if (depth === maxDepth || directory === homedir()) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name)) {
            next.push({ directory: join(directory, entry.name), inTooling: inTooling || toolingDirectories.has(entry.name) });
          }
        }
      } catch (error) {
        if (!['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    level = next.sort((a, b) => a.directory.localeCompare(b.directory));
  }
  // A configured app can rely on a Next.js dependency hoisted to the workspace.
  return nextApp ?? (firstConfig?.inTooling ? routedConfig : undefined) ?? firstConfig?.directory ?? firstNextPackage;
}

export function missingProject(root: string) {
  return `Neorion found no tsconfig.json, jsconfig.json, or package.json with a next dependency under ${root}.`;
}
