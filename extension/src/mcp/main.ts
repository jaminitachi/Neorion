#!/usr/bin/env node
import { resolve } from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';
import { runQueries, serve } from './server';

async function main() {
  const rootFlag = process.argv.indexOf('--root', 2);
  const workspaceFlag = process.argv.indexOf('--workspace', 2);
  if (rootFlag >= 0 && workspaceFlag >= 0) throw new Error('Choose either --root or --workspace.');
  const flag = Math.max(rootFlag, workspaceFlag);
  const argument = process.argv[flag + 1];
  if (flag >= 0 && (!argument || argument.startsWith('--'))) {
    throw new Error('Usage: neorion-mcp [--root <path> | --workspace <path>]');
  }
  const configuredRoot = rootFlag >= 0 ? argument : process.env.NEORION_ROOT;
  const workspace = workspaceFlag >= 0 ? argument : configuredRoot === undefined ? process.env.NEORION_WORKSPACE : undefined;
  const root = resolve(workspace ?? configuredRoot ?? '.');
  await serve(root, { autoBuild: false, discover: workspace !== undefined });
}

if (isMainThread) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else runQueries(workerData as string);
