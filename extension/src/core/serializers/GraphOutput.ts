import { INDEX_PATH } from '../../mcp/Index';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DETAIL_DIRECTORY, DETAIL_MARKER, MarkdownSerializer } from './MarkdownSerializer';
import type { CodebaseGraph } from '../types/GraphTypes';

function fileList(root: string): string {
  const generated = (file: string) => file === 'codebase_graph.md' ||
    file.startsWith(DETAIL_DIRECTORY + '/') || file.startsWith('.neorion/');
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
    }).split('\0').filter(file => file && !generated(file)).join('\n') + '\n';
  } catch {
    // A generated scaffold or exported source tree may have no Git index.
    const walk = (directory: string): string[] =>
      fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
        if (['.git', '.neorion', 'node_modules', '.next', 'codebase_graph.md'].includes(entry.name)) return [];
        const relative = path.posix.join(directory, entry.name);
        if (relative === DETAIL_DIRECTORY || generated(relative)) return [];
        return entry.isDirectory() ? walk(relative) : [relative];
      });
    return walk('').sort().join('\n') + '\n';
  }
}

export function writeGraph(root: string, graph: CodebaseGraph): string {
  const { overview, details } = new MarkdownSerializer().serialize(graph, fileList(root));
  const directory = path.join(root, DETAIL_DIRECTORY);
  for (const folder of [path.dirname(directory), directory]) {
    if (fs.lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Graph output directory is a symbolic link: ${path.relative(root, folder)}`);
    }
  }
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
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || !fs.readFileSync(file, 'utf8').startsWith(DETAIL_MARKER))) {
      throw new Error(`Graph detail conflicts with an existing file at ${DETAIL_DIRECTORY}/${name}`);
    }
  }
  for (const [name, content] of details) fs.writeFileSync(path.join(directory, name), content);
  const output = path.join(root, 'codebase_graph.md');
  fs.writeFileSync(output, overview);
  for (const file of stale) fs.unlinkSync(file);
  const legacy = path.join(root, '.neorion/graph');
  if (fs.existsSync(legacy) && !fs.lstatSync(path.dirname(legacy)).isSymbolicLink() &&
      fs.lstatSync(legacy).isDirectory()) {
    for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(legacy, entry.name);
      if (fs.readFileSync(file, 'utf8').startsWith(DETAIL_MARKER)) fs.unlinkSync(file);
    }
  }
  if (graph.index) {
    const target = path.join(root, INDEX_PATH);
    const parent = path.dirname(target);
    if ([parent, target].some(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())) {
      throw new Error(`Index path is a symbolic link: ${INDEX_PATH}`);
    }
    fs.mkdirSync(parent, { recursive: true });
    const temporary = target + '.' + randomUUID();
    try {
      fs.writeFileSync(temporary, JSON.stringify(graph.index), { flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return output;
}
