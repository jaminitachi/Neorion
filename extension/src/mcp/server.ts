import { readFileSync, realpathSync, statSync } from 'node:fs';
import { workspaceCache } from '../core/WorkspaceCache';
import { resolve } from 'node:path';
import { parentPort, Worker } from 'node:worker_threads';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { INDEX_PATH, INDEX_SCHEMA, LEGACY_INDEX_PATH, VERSION, type QueryIndex } from './Index';
import { QueryEngine } from './Query';
import { missingProject, selectProject } from '../core/FindProject';
import { ensureFresh, projectText, waitForBuild } from './Build';
import { historyBudgetMs } from './ChangesHistory';
import { legacyKind, queryName, tools } from './Tools';

type Call = { id: number; name: string; args: unknown };
type Response = { id: number; text: string; isError?: true };
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
      response = { id, text: query.query(name, args) };
    } catch (error) {
      response = { id, isError: true, text: String((error as Error).message).replace(/[\r\n]/g, ' ').slice(0, 120) };
    }
    port.postMessage(response);
  });
}

export async function serve(root: string, { autoBuild, explicit }: { autoBuild: boolean; explicit?: boolean }) {
  const selection = autoBuild ? selectProject(root, explicit) : { directory: root };
  const project = selection?.directory;
  let worker: Worker | undefined;
  let nextId = 0;
  const pending = new Map<number, (response?: Response) => void>();
  function start() {
    const current = new Worker(__filename, { workerData: project });
    worker = current;
    current.on('message', (response: Response | 'ready') => {
      if (response !== 'ready' && worker === current) pending.get(response.id)?.(response);
    });
    current.on('error', error => console.error(error));
    current.on('exit', () => {
      if (worker !== current) return;
      worker = undefined;
      for (const settle of pending.values()) settle();
    });
    if (autoBuild && process.stdin.readableEnded) current.unref();
    return current;
  }

  if (project) {
    const initial = start();
    // Include initial index loading in initialize latency.
    await new Promise<void>((ready, reject) => {
      initial.once('message', () => ready());
      initial.once('error', reject);
      initial.once('exit', () => reject(new Error('Neorion query worker exited before initialization.')));
    });
  }
  const server = new Server({ name: 'neorion-mcp', version: VERSION }, { capabilities: { tools: {} } });
  server.onclose = () => { void worker?.terminate(); };
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  const reply = (text: string, isError?: boolean) =>
    ({ ...(isError === undefined ? {} : { isError }), content: [{ type: 'text' as const, text }] });

  async function ask(name: string, args: unknown) {
    const id = ++nextId;
    const current = worker ?? start();
    const response = await new Promise<Response | undefined>(done => {
      const timeout = setTimeout(() => {
        // The engine tries to return partial results first. This also bounds stalled I/O.
        if (worker === current) {
          worker = undefined;
          for (const settle of pending.values()) settle();
          void current.terminate();
        }
      }, 2000);
      pending.set(id, response => {
        clearTimeout(timeout);
        pending.delete(id);
        done(response);
      });
      current.postMessage({ id, name, args } satisfies Call);
    });
    return response;
  }

  async function askChanges(args: unknown) {
    // An older Git snapshot can take longer to index. Keep it off the
    // interactive worker used by the other queries.
    const current = new Worker(__filename, { workerData: project });
    return new Promise<Response | undefined>(done => {
      const finish = (response?: Response) => {
        clearTimeout(timeout);
        void current.terminate();
        done(response);
      };
      const timeout = setTimeout(finish, historyBudgetMs + 1000);
      current.on('error', () => finish());
      current.on('exit', () => finish());
      current.on('message', (response: Response | 'ready') => {
        if (response === 'ready') current.postMessage({ id: 0, name: queryName, args } satisfies Call);
        else finish(response);
      });
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    if (name !== queryName && !legacyKind(name)) return reply('Unknown Neorion tool.', true);
    if (!selection) return reply(missingProject(root), true);
    const project = selection.directory;
    if (autoBuild) {
      const build = await waitForBuild(project, ensureFresh(project));
      if (build.error) return reply(build.error, !build.building);
    }
    const response = await (name === queryName && args.kind === 'changes' ? askChanges(args) : ask(name, args));
    const target = args.target ?? args.component ?? args.symbol ?? args.route ?? args.text;
    const label = typeof target === 'string' ? target.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').slice(0, 80) : '';
    const kind = legacyKind(name) ?? args.kind ?? 'query';
    const text = response?.text ?? `# timeout ${kind}${label ? ' ' + label : ''} : 0 results\n# partial: timed out`;
    return reply(autoBuild && !response?.isError ? projectText(selection, text) : text, response?.isError);
  });
  process.stdin.once('end', () => {
    // Let a piped CLI request finish even after its input reaches EOF.
    if (autoBuild) worker?.unref();
    else void server.close();
  });
  await server.connect(new StdioServerTransport());
}
