import { join, relative, resolve } from 'node:path';
import { findProject, generateGraph } from '../core/Generate';
import { missingProject } from '../core/FindProject';
import { mcpCommand } from '../core/McpCommand';
import { projectLabel } from '../mcp/Build';
import { VERSION } from '../mcp/Index';

export function run(root: string, showMcpConfig = false) {
  const start = performance.now();
  const onProgress = process.stderr.isTTY ? (message: string) => console.error(message) : undefined;
  onProgress?.('Finding the Next.js project...');
  const project = findProject(root);
  if (!project) throw new Error(missingProject(root));
  const label = projectLabel(project);
  const selected = relative(root, project).replace(/[\r\n]/g, ' ');
  onProgress?.(`Project: ${label}${selected ? ` (${selected})` : ''}`);
  const { graph, outputPath } = generateGraph(project, { markdown: true, onProgress });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`Neorion ${VERSION} · ${label} · ${graph.metadata.router} router · ${graph.sourceFileCount} source files · ${seconds}s`);
  console.log(`Overview: ${outputPath}`);
  if (showMcpConfig) {
    const mcp = mcpCommand({ localEntry: join(__dirname, 'neorion.cjs'), detectCache: true });
    console.log(`MCP:      ${JSON.stringify(mcp)}`);
  }
}

if (require.main === module) {
  try {
    run(resolve(process.argv[2] ?? '.'));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
