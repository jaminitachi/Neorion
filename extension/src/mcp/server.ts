import { readFileSync, realpathSync, statSync } from 'node:fs';
import { workspaceCache } from '../core/WorkspaceCache';
import { resolve } from 'node:path';
import { parentPort, Worker } from 'node:worker_threads';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { INDEX_PATH, INDEX_SCHEMA, LEGACY_INDEX_PATH, VERSION, type QueryIndex } from './Index';
import { QueryEngine, type QueryAnswer } from './Query';
import { appMode, missingProject, selectedApp, selectProject } from '../core/FindProject';
import { appList, appQueryText, ensureFresh, projectText, waitForBuild } from './Build';
import { historyBudgetMs } from './ChangesHistory';
import { legacyKind, queryName, tools } from './Tools';

type Call = { id: number; name: string; args: unknown };
type Response = QueryAnswer & { id: number; isError?: true };
const missing = 'Neorion index missing or invalid. Run "Neorion: Generate Architecture Map" in VS Code.';

export function indexReader(root: string) {
  let engine: QueryEngine | undefined;
  let loaded: string | undefined;
  function readIndex() {
    // A long-lived stdio session picks up an atomically regenerated index.
    try {
      const cache = workspaceCache(root);
      const file = [INDEX_PATH, LEGACY_INDEX_PATH].map(indexPath => resolve(cache, indexPath))
        .find(candidate => statSync(candidate, { throwIfNoEntry: false })) ?? resolve(realpathSync(root), LEGACY_INDEX_PATH);
      if (realpathSync(file) !== file) throw new Error(missing);
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error(missing);
      const signature = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (signature !== loaded) {
        const index: QueryIndex = JSON.parse(readFileSync(file, 'utf8'));
        if ((index.schema !== INDEX_SCHEMA && index.schema !== 1) || index.root !== '.' || typeof index.generatedAt !== 'string' ||
            !index.files || !index.wrapChains || !index.routeWrap || !Array.isArray(index.symbols) ||
            !Array.isArray(index.routes) || !Array.isArray(index.renderEdges) ||
            !Array.isArray(index.references) || !Array.isArray(index.fetches)) throw new Error(missing);
        engine = new QueryEngine(root, index);
        loaded = signature;
      }
    } catch {
      engine = undefined;
      loaded = undefined;
    }
    return engine;
  }

  return readIndex;
}

export function runQueries(root: string) {
  const readIndex = indexReader(root);
  const port = parentPort!;
  readIndex();
  port.postMessage('ready');
  port.on('message', ({ id, name, args }: Call) => {
    let response: Response;
    try {
      const query = readIndex();
      if (!query) throw new Error(missing);
      response = { id, ...query.query(name, args) };
    } catch (error) {
      response = { id, isError: true, text: String((error as Error).message).replace(/[\r\n]/g, ' ').slice(0, 120) };
    }
    port.postMessage(response);
  });
}

function queryWorker(project: string | undefined, autoBuild: boolean, budget: number) {
  let worker: Worker | undefined;
  let nextId = 0;
  const pending = new Map<number, (response?: Response) => void>();
  function clear(current: Worker) {
    if (worker !== current) return;
    worker = undefined;
    for (const settle of pending.values()) settle();
  }
  function start() {
    const current = new Worker(__filename, { workerData: project });
    worker = current;
    current.on('message', (response: Response | 'ready') => {
      if (response !== 'ready' && worker === current) pending.get(response.id)?.(response);
    });
    current.on('error', error => console.error(error));
    current.on('exit', () => clear(current));
    if (autoBuild && process.stdin.readableEnded) current.unref();
    return current;
  }

  function stop() {
    const current = worker;
    if (!current) return;
    clear(current);
    void current.terminate();
  }

  function ask(name: string, args: unknown) {
    const id = ++nextId;
    const current = worker ?? start();
    return new Promise<Response | undefined>(done => {
      const timeout = setTimeout(() => {
        if (worker === current) stop();
      }, budget);
      pending.set(id, response => {
        clearTimeout(timeout);
        pending.delete(id);
        done(response);
      });
      current.postMessage({ id, name, args } satisfies Call);
    });
  }

  return { start, ask, stop, unref: () => worker?.unref() };
}

function appWorkers(project: string, autoBuild: boolean) {
  const interactive = queryWorker(project, autoBuild, 2000);
  const history = queryWorker(project, autoBuild, historyBudgetMs + 1000);
  let changesQueue = Promise.resolve();
  let stopped = false;
  return {
    interactive,
    ask(name: string, args: Record<string, unknown>) {
      if (stopped) return Promise.resolve(undefined);
      if (name !== queryName || args.kind !== 'changes') return interactive.ask(name, args);
      // Give each history request its own budget and reuse the comparison graph.
      const response = changesQueue.then(() => stopped ? undefined : history.ask(name, args));
      changesQueue = response.then(() => undefined, () => undefined);
      return response;
    },
    stop() {
      stopped = true;
      interactive.stop();
      history.stop();
    },
    unref() {
      interactive.unref();
      history.unref();
    }
  };
}

export async function serve(root: string, { autoBuild, confirm, discover = autoBuild }:
  { autoBuild: boolean; confirm?: boolean; discover?: boolean }) {
  const selection = discover ? selectProject(root, confirm) : { directory: root };
  const project = selection?.directory;
  const mode = selection && appMode(selection);
  const workers = new Map<string, ReturnType<typeof appWorkers>>();
  if (mode === 'all') {
    for (const app of selection!.apps!) workers.set(app.directory, appWorkers(app.directory, autoBuild));
  } else if (project && mode === 'single') {
    workers.set(project, appWorkers(project, autoBuild));
  }
  const temporaryWorkers = new Set<ReturnType<typeof appWorkers>>();
  let appsQueue = Promise.resolve();
  let closed = false;
  if (project && mode === 'single') {
    const initial = workers.get(project)!.interactive.start();
    // Include initial index loading in initialize latency.
    await new Promise<void>((ready, reject) => {
      initial.once('message', () => ready());
      initial.once('error', reject);
      initial.once('exit', () => reject(new Error('Neorion query worker exited before initialization.')));
    });
  }
  const server = new Server({ name: 'neorion-mcp', version: VERSION }, { capabilities: { tools: {} } });
  server.onclose = () => {
    closed = true;
    for (const pool of workers.values()) pool.stop();
    for (const pool of temporaryWorkers) pool.stop();
  };
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  const reply = (text: string, isError?: boolean) =>
    ({ ...(isError === undefined ? {} : { isError }), content: [{ type: 'text' as const, text }] });

  async function queryApp(project: string, name: string, args: Record<string, unknown>):
    Promise<QueryAnswer & { error: boolean; building: boolean }> {
    if (autoBuild) {
      const build = await waitForBuild(project, ensureFresh(project));
      if (build.error) return { text: build.error, error: !build.building, building: !!build.building };
    }
    if (closed) return { text: '# partial: MCP server closed', error: true, building: false };
    const cached = workers.get(project);
    const pool = cached ?? appWorkers(project, autoBuild);
    if (!cached) temporaryWorkers.add(pool);
    try {
      const response = await pool.ask(name, args);
      return { text: response?.text ?? '# partial: timed out', targetResolved: response?.targetResolved,
        error: !!response?.isError, building: false };
    } finally {
      if (!cached) {
        pool.stop();
        temporaryWorkers.delete(pool);
      }
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: { app, ...args } = {} } = request.params;
    if (name !== queryName && !legacyKind(name)) return reply('Unknown Neorion tool.', true);
    if (!selection) return reply(missingProject(root), true);
    if (app !== undefined) {
      if (name !== queryName || typeof app !== 'string' || !app) return reply('Invalid app argument.', true);
      try {
        const chosen = selectedApp(selection, app);
        const result = await queryApp(chosen.directory, name, args);
        return reply(result.error || result.building ? result.text : projectText(chosen, root, result.text), result.error || undefined);
      } catch (error) {
        return reply((error as Error).message, true);
      }
    }
    if (mode === 'list') return reply(appList(selection));
    if (mode === 'all') {
      const response = appsQueue.then(async () => {
        const results = [];
        for (const app of selection.apps!) {
          const result = await queryApp(app.directory, name, args);
          results.push({ app: app.id, ...result });
          // Let the current build finish before starting more apps on the next request.
          if (result.building) return reply(appQueryText(results) + '\n# partial: remaining apps pending');
        }
        return reply(appQueryText(results), results.every(result => result.error) || undefined);
      });
      appsQueue = response.then(() => undefined, () => undefined);
      return response;
    }
    const project = selection.directory;
    if (autoBuild) {
      const build = await waitForBuild(project, ensureFresh(project));
      if (build.error) return reply(build.error, !build.building);
    }
    const response = await workers.get(project)!.ask(name, args);
    const target = args.target ?? args.component ?? args.symbol ?? args.route ?? args.text;
    const label = typeof target === 'string' ? target.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').slice(0, 80) : '';
    const kind = legacyKind(name) ?? args.kind ?? 'query';
    const text = response?.text ?? `# timeout ${kind}${label ? ' ' + label : ''} : 0 results\n# partial: timed out`;
    return reply(discover && !response?.isError ? projectText(selection, root, text) : text, response?.isError);
  });
  process.stdin.once('end', () => {
    // Let a piped CLI request finish even after its input reaches EOF.
    if (autoBuild) {
      for (const pool of workers.values()) pool.unref();
      for (const pool of temporaryWorkers) pool.unref();
    }
    else void server.close();
  });
  await server.connect(new StdioServerTransport());
}
