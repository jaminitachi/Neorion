import { resolve } from 'node:path';
import { findProject, generateGraph } from '../core/Generate';
import { missingTsconfig } from '../core/FindProject';
import { VERSION } from '../mcp/Index';

export function run(root: string) {
  const start = performance.now();
  const project = findProject(root);
  if (!project) throw new Error(missingTsconfig(root));
  const { graph, outputPath } = generateGraph(project, { markdown: true });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`Neorion ${VERSION} · ${graph.metadata.name} · ${graph.metadata.router} router · ${graph.sourceFileCount} source files · ${seconds}s`);
  console.log(`Overview: ${outputPath}`);
  console.log('Try:      npx neorion query who_renders DashboardShell');
  console.log(`MCP:      ${JSON.stringify({ command: 'npx', args: ['-y', `neorion@${VERSION}`, 'mcp'] })}   (Cursor, Windsurf, Gemini CLI, …)`);
}

if (require.main === module) {
  try {
    run(resolve(process.argv[2] ?? '.'));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
