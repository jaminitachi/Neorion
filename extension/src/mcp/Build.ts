import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { workspaceCache } from '../core/WorkspaceCache';
import { GRAPH_INDEX_REVISION, INDEX_PATH, INDEX_SCHEMA, QUERY_INDEX_REVISION, VERSION, WRAPPER_INDEX_REVISION, type QueryIndex } from './Index';
import { projectSnapshot } from '../core/ProjectSnapshot';

type BuildResult = { error?: string; building?: boolean };
const builds = new Map<string, Promise<BuildResult>>();
const enabled = () => process.env.NEORION_AUTOBUILD !== '0';
const firstLine = (message: string) => message.split(/\r?\n/, 1)[0];

async function fresh(root: string, indexPath: string) {
  let index: QueryIndex;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    return false;
  }
  if (index?.schema !== INDEX_SCHEMA || index.generator !== VERSION || !index.files) return false;
  if (index.wrapperRevision !== WRAPPER_INDEX_REVISION || !Array.isArray(index.serverActions)) return false;
  if (index.queryRevision !== QUERY_INDEX_REVISION || index.graphRevision !== GRAPH_INDEX_REVISION) return false;
  return typeof index.projectSnapshot === 'string' && index.projectSnapshot === projectSnapshot(root);
}

function liveOwner(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function build(root: string) {
  const cache = workspaceCache(root);
  const index = join(cache, INDEX_PATH);
  const lock = join(dirname(index), 'build.lock');
  if (await fresh(root, index)) return;
  for (const directory of [cache, dirname(index)]) {
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Invalid graph cache directory: ${directory}`);
  }

  while (true) {
    const handle = await open(lock, 'wx', 0o600).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (handle) {
      try {
        await handle.writeFile(String(process.pid));
        if (!await fresh(root, index)) {
          await runGenerator(root);
          if (!await fresh(root, index)) throw new Error('Project changed during the build. Retry the query');
        }
      } finally {
        await handle.close();
        await unlink(lock);
      }
      return;
    }

    try {
      const entry = await lstat(lock);
      if (!entry.isFile()) throw new Error(`Invalid graph build lock: ${lock}`);
      const pid = Number(await readFile(lock, 'utf8'));
      // The creator may still be writing its PID.
      if ((!pid && Date.now() - entry.mtimeMs < 1000) || liveOwner(pid)) {
        await delay(100);
        continue;
      }
      const current = await lstat(lock);
      if (entry.ino === current.ino && entry.mtimeMs === current.mtimeMs) await unlink(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (await fresh(root, index)) return;
  }
}

function runGenerator(root: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, 'graph.cjs'), root], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(0, 4096); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(firstLine(stderr.trim()) || `Graph generator exited with ${signal ?? code}`));
    });
  });
}

export function ensureFresh(root: string): Promise<BuildResult> {
  if (!enabled()) return Promise.resolve<BuildResult>({});
  const previous = builds.get(root);
  if (previous) return previous;

  const pending = build(root).then(
    () => ({}),
    (error: Error) => ({ error: `Graph build failed: ${firstLine(error.message)}.` })
  ).finally(() => { builds.delete(root); });
  builds.set(root, pending);
  return pending;
}

export async function waitForBuild(root: string, pending: Promise<BuildResult>): Promise<BuildResult> {
  const ms = Number(process.env.NEORION_BUILD_WAIT_MS ?? 45_000);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<BuildResult>(resolve => {
      timer = setTimeout(() => resolve({ building: true, error: `Building graph for ${root} (large project). Ask again in ~30s.` }),
        Number.isFinite(ms) && ms >= 0 ? ms : 45_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export function projectText(root: string, text: string) {
  return `Project: ${basename(root).replace(/[\r\n]/g, ' ')}\n${text}`;
}
