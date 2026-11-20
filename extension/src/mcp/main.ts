#!/usr/bin/env node
import { resolve } from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';
import { runQueries, serve } from './server';

async function main() {
  const rootFlag = process.argv.indexOf('--root', 2);
  const argument = process.argv[rootFlag + 1];
  if (rootFlag >= 0 && (!argument || argument.startsWith('--'))) {
    throw new Error('Usage: neorion-mcp [--root <path>]');
  }
  const root = resolve(rootFlag >= 0 ? argument : process.env.NEORION_ROOT ?? process.cwd());
  await serve(root, { autoBuild: false });
}

if (isMainThread) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else runQueries(workerData as string);
