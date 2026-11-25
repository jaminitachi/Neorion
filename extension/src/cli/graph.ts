import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { findProject, generateGraph } from '../core/Generate';
export { inspectChangeSource } from '../core/analyzers/ChangeSource';
import { missingProject } from '../core/FindProject';
import { mcpCommand } from '../core/McpCommand';
import { VERSION } from '../mcp/Index';

export function run(root: string) {
  const start = performance.now();
  const project = findProject(root);
  if (!project) throw new Error(missingProject(root));
  const { graph, outputPath } = generateGraph(project, { markdown: true });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`Neorion ${VERSION} · ${graph.metadata.name} · ${graph.metadata.router} router · ${graph.sourceFileCount} source files · ${seconds}s`);
  console.log(`Overview: ${outputPath}`);
  const mcp = mcpCommand({ localEntry: join(__dirname, 'neorion.cjs'), detectCache: true });
  console.log(`MCP:      ${JSON.stringify(mcp)}`);
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--history-index') {
      const { graph } = generateGraph(resolve(process.argv[3]), { index: true });
      writeFileSync(process.argv[4], JSON.stringify(graph.index), { mode: 0o600 });
    } else run(resolve(process.argv[2] ?? '.'));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
