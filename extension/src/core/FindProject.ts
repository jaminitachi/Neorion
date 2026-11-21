import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage']);
const maxDepth = 4;

export function findProject(root: string): string | undefined {
  const start = resolve(root);
  let level = [start];
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const directory of level) {
      try {
        if (statSync(join(directory, 'tsconfig.json'), { throwIfNoEntry: false })?.isFile()) return directory;
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
}

export function missingTsconfig(root: string) {
  return `Neorion needs a TypeScript project: no tsconfig.json under ${root}.`;
}
