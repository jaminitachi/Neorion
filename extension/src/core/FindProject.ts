import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const excluded = new Set(['node_modules', '.next', '.git']);

export function findProject(root: string): string | undefined {
  let level = [resolve(root)];
  while (level.length) {
    const next: string[] = [];
    for (const directory of level) {
      if (statSync(join(directory, 'tsconfig.json'), { throwIfNoEntry: false })?.isFile()) return directory;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !excluded.has(entry.name)) next.push(join(directory, entry.name));
      }
    }
    level = next.sort((a, b) => a.localeCompare(b));
  }
}

export function missingTsconfig(root: string) {
  return `Neorion needs a TypeScript project: no tsconfig.json under ${root}.`;
}
