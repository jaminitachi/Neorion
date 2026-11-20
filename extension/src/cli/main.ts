#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { findProject, missingTsconfig } from '../core/FindProject';
import { ensureFresh, projectText } from '../mcp/Build';
import { VERSION } from '../mcp/Index';
import { indexReader, runQueries, serve } from '../mcp/server';
import { kinds, queryName } from '../mcp/Tools';

const help = `Usage:
  neorion graph [dir]
  neorion query <kind> <target> [--limit n] [--root dir]
  neorion mcp [--root dir]
  neorion setup codex [--local]
  neorion --version | --help

Query kinds: ${kinds.join(', ')}`;

function setupCodex(local: boolean) {
  const skills = join(homedir(), '.agents', 'skills', 'neorion');
  mkdirSync(skills, { recursive: true });
  copyFileSync(join(__dirname, '../skills/neorion/SKILL.md'), join(skills, 'SKILL.md'));
  console.log('✓ Skill installed: ~/.agents/skills/neorion');

  const [command, ...args] = local
    ? [process.execPath, __filename, 'mcp']
    : ['npx', '-y', `neorion@${VERSION}`, 'mcp'];
  const result = spawnSync('codex', ['mcp', 'add', 'neorion', '--', command, ...args], { encoding: 'utf8' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.log(`Add to ~/.codex/config.toml:\n[mcp_servers.neorion]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`);
  } else {
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not register the Neorion MCP server.');
    console.log('✓ MCP server registered: neorion  (check: codex mcp list)');
  }
  console.log('Next: cd into a Next.js project and run `codex`. Ask "which pages render <Component>?"');
}

async function main([command, ...args]: string[]) {
  if ((!command || command === '--help') && !args.length) return console.log(help);
  if (command === '--version' && !args.length) return console.log(VERSION);
  if (command === 'graph' && args.length <= 1) {
    if (args[0]?.startsWith('--')) throw new Error(help);
    const { run } = require('./graph.cjs') as typeof import('./graph');
    return run(resolve(args[0] ?? '.'));
  }
  if (command === 'setup' && args[0] === 'codex' &&
      (args.length === 1 || (args.length === 2 && args[1] === '--local'))) return setupCodex(args.length === 2);
  if (command !== 'query' && command !== 'mcp') throw new Error(help);
  const query = command === 'query';
  const { values, positionals } = parseArgs({
    args,
    options: { root: { type: 'string' }, ...(query ? { limit: { type: 'string' as const } } : {}) },
    allowPositionals: query
  });
  const root = resolve(values.root ?? process.env.NEORION_ROOT ?? '.');
  if (!query) return serve(root, { autoBuild: true });
  if (positionals.length !== 2) throw new Error(help);
  const project = findProject(root);
  if (!project) throw new Error(missingTsconfig(root));
  const build = await ensureFresh(project);
  if (build.error) throw new Error(build.error);
  const engine = indexReader(project)();
  if (!engine) throw new Error(`Neorion index missing. Run "npx neorion graph" in ${project}.`);
  const [kind, target] = positionals;
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  console.log(projectText(project, engine.query(queryName, { kind, target, limit })));
}

if (isMainThread) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else runQueries(workerData as string);
