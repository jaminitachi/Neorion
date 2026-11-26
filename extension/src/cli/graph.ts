import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { generateGraph } from '../core/Generate';
export { inspectChangeSource } from '../core/analyzers/ChangeSource';
import { missingProject, selectProject } from '../core/FindProject';
import { mcpCommand } from '../core/McpCommand';
import { projectLabel, projectRootNotice } from '../mcp/Build';
import { VERSION } from '../mcp/Index';
import { incrementalHistory, type HistoryPlan } from '../core/analyzers/HistoricalExports';

export function run(root: string, showMcpConfig = false) {
  const start = performance.now();
  const onProgress = process.stderr.isTTY ? (message: string) => console.error(message) : undefined;
  onProgress?.('Finding the Next.js project...');
  const selection = selectProject(root);
  if (!selection) throw new Error(missingProject(root));
  const project = selection.directory;
  const label = projectLabel(project);
  onProgress?.(`Project: ${project.replace(/[\r\n]/g, ' ')}`);
  const { graph, outputPath } = generateGraph(project, { markdown: true, onProgress });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`Neorion ${VERSION} · ${label} · ${graph.metadata.router} router · ${graph.sourceFileCount} source files · ${seconds}s${projectRootNotice(selection, root)}`);
  console.log(`Overview: ${outputPath}`);
  if (showMcpConfig) {
    const mcp = mcpCommand({ localEntry: join(__dirname, 'neorion.cjs'), detectCache: true });
    console.log(`MCP:      ${JSON.stringify(mcp)}`);
  }
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--history-index') {
      const root = resolve(process.argv[3]);
      let index;
      if (process.argv[5]) {
        try {
          index = incrementalHistory(root, JSON.parse(readFileSync(process.argv[5], 'utf8')) as HistoryPlan);
        } catch {
          // A changing worktree or an unsupported scope needs the base graph.
        }
      }
      index ??= generateGraph(root, { index: true }).graph.index;
      writeFileSync(process.argv[4], JSON.stringify(index), { mode: 0o600 });
    } else if (process.argv[2] === '--build-project') {
      generateGraph(resolve(process.argv[3]), { markdown: true });
    } else run(resolve(process.argv[2] ?? '.'));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
