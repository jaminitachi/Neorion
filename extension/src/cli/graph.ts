import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { generateGraph } from '../core/Generate';
export { inspectChangeSource } from '../core/analyzers/ChangeSource';
export { collectExcludedRequests } from '../core/analyzers/ExcludedHttp';
import { appMode, missingProject, selectedApp, selectProject, type ProjectSelection } from '../core/FindProject';
import { mcpCommand } from '../core/McpCommand';
import { appList, projectLabel, projectRootNotice } from '../mcp/Build';
import { VERSION } from '../mcp/Index';
import { incrementalHistory, type HistoryPlan } from '../core/analyzers/HistoricalExports';

function runProject(selection: ProjectSelection, root: string, start: number, onProgress?: (message: string) => void) {
  const project = selection.directory;
  onProgress?.(`Project: ${project.replace(/[\r\n]/g, ' ')}`);
  const { graph, outputPath } = generateGraph(project, { markdown: true, onProgress });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`Neorion ${VERSION} · ${projectLabel(project)} · ${graph.metadata.router} router · ${graph.sourceFileCount} source files · ${seconds}s${projectRootNotice(selection, root)}`);
  console.log(`Overview: ${outputPath}`);
}

export function run(root: string, showMcpConfig = false, app?: string, allApps = false) {
  const start = performance.now();
  const onProgress = process.stderr.isTTY ? (message: string) => console.error(message) : undefined;
  onProgress?.('Finding the Next.js project...');
  const discovered = selectProject(root);
  if (!discovered) throw new Error(missingProject(root));
  const selection = app === undefined ? discovered : selectedApp(discovered, app);
  const mode = appMode(selection, allApps);
  if (mode === 'list') {
    console.log(appList(selection).replace('Use --app <name> on the CLI or set app in the MCP query.', 'Run neorion graph --app <name> for one app or use --all-apps to build all of them.'));
  } else if (mode === 'all' && selection.apps!.length > 1) {
    const failed: string[] = [];
    for (const app of selection.apps!) {
      console.log(`App: ${JSON.stringify(app.id)}`);
      try {
        execFileSync(process.execPath, [__filename, '--graph-app', app.directory], { stdio: 'inherit' });
      } catch {
        failed.push(JSON.stringify(app.id));
      }
    }
    if (selection.searchLimited) console.log('# partial: directory scan limit reached');
    if (failed.length) throw new Error(`Graph build failed for ${failed.join(', ')}.`);
  } else {
    const project = mode === 'all' ? { directory: selection.apps![0].directory } : selection;
    runProject(project, root, start, onProgress);
  }
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
    } else if (process.argv[2] === '--graph-app') {
      const directory = resolve(process.argv[3]);
      runProject({ directory }, directory, performance.now(), process.stderr.isTTY ? message => console.error(message) : undefined);
    } else if (process.argv[2] === '--build-project') {
      generateGraph(resolve(process.argv[3]), { markdown: true });
    } else run(resolve(process.argv[2] ?? '.'));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
