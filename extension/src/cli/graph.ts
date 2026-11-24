import { join, resolve } from 'node:path';
import { findProject, generateGraph } from '../core/Generate';
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
    run(resolve(process.argv[2] ?? '.'));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
