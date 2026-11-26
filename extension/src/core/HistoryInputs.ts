import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const sourceFile = /\.[cm]?[jt]sx?$/;
export const routeAsset = /(?:\.css|(?:^|\/)(?:robots\.txt|sitemap\.xml|opengraph-image\.(?:png|jpe?g|gif)))$/;

export const historicalInput = (file: string) =>
  sourceFile.test(file) || file.endsWith('.json') || /(?:^|\/)pnpm-workspace\.yaml$/.test(file) || routeAsset.test(file);

export type HistoryEdit = { file: string; names: string[] };

export function historyEnvironmentSupported(root: string) {
  // The base checkout has no installed modules or framework-generated types.
  for (let directory = root; directory !== dirname(directory); directory = dirname(directory)) {
    if (existsSync(join(directory, 'node_modules')) || existsSync(join(directory, 'pnpm-workspace.yaml'))) return false;
  }
  return true;
}

export function listHistoryInputs(directory: string, prefix = '', files = new Set<string>()): Set<string> | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.neorion') continue;
    if (entry.isSymbolicLink() || entry.name === '.next' || entry.name === 'node_modules') return;
    const file = prefix + entry.name;
    if (entry.isDirectory()) {
      if (!listHistoryInputs(join(directory, entry.name), file + '/', files)) return;
    } else if (entry.isFile() && historicalInput(file)) files.add(file);
  }
  return files;
}
