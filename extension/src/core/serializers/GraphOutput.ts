import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DETAIL_DIRECTORY, DETAIL_MARKER, MarkdownSerializer } from './MarkdownSerializer';
import type { CodebaseGraph } from '../types/GraphTypes';

function fileList(root: string): string {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
    }).split('\0').filter(Boolean).join('\n') + '\n';
  } catch {
    // A generated scaffold or exported source tree may have no Git index.
    const walk = (directory: string): string[] =>
      fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
        if (['.git', '.neorion', 'node_modules', '.next', 'codebase_graph.md'].includes(entry.name)) return [];
        const relative = path.posix.join(directory, entry.name);
        return entry.isDirectory() ? walk(relative) : [relative];
      });
    return walk('').sort().join('\n') + '\n';
  }
}

export function writeGraph(root: string, graph: CodebaseGraph): string {
  const { overview, details } = new MarkdownSerializer().serialize(graph, fileList(root));
  const directory = path.join(root, DETAIL_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const stale: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(directory, entry.name);
    if (!fs.readFileSync(file, 'utf8').startsWith(DETAIL_MARKER)) continue;
    if (!details.has(entry.name)) stale.push(file);
  }
  for (const name of details.keys()) {
    const file = path.join(directory, name);
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(DETAIL_MARKER)) {
      throw new Error(`Graph detail conflicts with an existing file at ${DETAIL_DIRECTORY}/${name}`);
    }
  }
  for (const [name, content] of details) fs.writeFileSync(path.join(directory, name), content);
  const output = path.join(root, 'codebase_graph.md');
  fs.writeFileSync(output, overview);
  for (const file of stale) fs.unlinkSync(file);
  return output;
}
