#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { workspaceCache } from '../core/WorkspaceCache';
import { resolve } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { INDEX_PATH, VERSION, type QueryIndex } from './Index';
import { QueryEngine } from './Query';
import { legacyKind, queryName, tools } from './Tools';

type Call = { id: number; name: string; args: unknown };
type Response = { id: number; text: string; isError?: true };
const missing = 'Neorion index missing or invalid. Run "Neorion: Generate Architecture Map" in VS Code.';

function runQueries(root: string) {
  let engine: QueryEngine | undefined;
  let loaded: string | undefined;
  function readIndex() {
    // A long-lived stdio session picks up an atomically regenerated index.
    try {
      const cached = resolve(workspaceCache(root), INDEX_PATH);
      const file = statSync(cached, { throwIfNoEntry: false }) ? cached : resolve(realpathSync(root), INDEX_PATH);
      if (realpathSync(file) !== file) throw new Error(missing);
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error(missing);
      const signature = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (signature !== loaded) {
        const index: QueryIndex = JSON.parse(readFileSync(file, 'utf8'));
        if (index.schema !== 1 || index.root !== '.' || typeof index.generatedAt !== 'string' ||
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

async function serve() {
  const rootFlag = process.argv.indexOf('--root', 2);
  if (rootFlag >= 0 && (!process.argv[rootFlag + 1] || process.argv[rootFlag + 1].startsWith('--'))) {
    throw new Error('Usage: neorion-mcp [--root <path>]');
  }
  const root = resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : process.env.NEORION_ROOT ?? process.cwd());
  let worker: Worker | undefined;
  let nextId = 0;
  const pending = new Map<number, (response?: Response) => void>();
  function start() {
    const current = new Worker(__filename, { workerData: root });
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
    return current;
  }

  const initial = start();
  // Include initial index loading in initialize latency and release the process on EOF.
  await new Promise<void>((ready, reject) => {
    initial.once('message', () => ready());
    initial.once('error', reject);
    initial.once('exit', () => reject(new Error('Neorion query worker exited before initialization.')));
  });
  const server = new Server({ name: 'neorion-mcp', version: VERSION }, { capabilities: { tools: {} } });
  server.onclose = () => { void worker?.terminate(); };
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    if (name !== queryName && !legacyKind(name)) {
      return { isError: true, content: [{ type: 'text', text: 'Unknown Neorion tool.' }] };
    }
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
    const target = args.target ?? args.component ?? args.symbol ?? args.route ?? args.text;
    const label = typeof target === 'string' ? target.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').slice(0, 80) : '';
    const text = response?.text ?? `# timeout ${legacyKind(name) ?? args.kind ?? 'query'} ${label} : 0 results (partial: timed out)`;
    return { ...(response?.isError ? { isError: true } : {}), content: [{ type: 'text', text }] };
  });
  process.stdin.once('end', () => { void server.close(); });
  await server.connect(new StdioServerTransport());
}

if (isMainThread) {
  serve().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else runQueries(workerData as string);
