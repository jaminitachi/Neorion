#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { CLAUDE_HINT, updateAgentFiles } from '../core/AgentInstructions';
import { findProject, missingProject } from '../core/FindProject';
import { ensureFresh, projectText } from '../mcp/Build';
import { isTemporaryCliInstall, mcpCommand, packageSpec } from '../core/McpCommand';
import { VERSION } from '../mcp/Index';
import { indexReader, runQueries, serve } from '../mcp/server';
import { kinds, queryName } from '../mcp/Tools';

const help = `Usage:
  neorion graph [dir]
  neorion query <kind> <target> [--limit n] [--root dir]
  neorion query wrappers <route> [--no-external | --include-external]
  neorion query impact <symbol|file> [--depth n] [--include-tests]
  neorion query callees <symbol> [--depth n] [--uses]
  neorion query path <from> <to>
  neorion mcp [--root dir]
  neorion setup codex [--local] [--no-hint]
  neorion setup claude [--no-hint]
  neorion --version | --help

Query kinds: ${kinds.join(', ')}

Wrapper flags:
  --no-external hides third-party non-provider wrappers. Providers stay visible.
  --include-external includes third-party wrappers (default).`;

function writeHint(file: string, instruction: string) {
  const root = process.cwd();
  if (!['tsconfig.json', 'jsconfig.json', 'package.json'].some(name => existsSync(join(root, name)))) {
    console.log(`Skipping ${file} hint: the current directory has no tsconfig.json, jsconfig.json, or package.json.`);
    return false;
  }
  const changed = updateAgentFiles(root, root, [file], true, false, instruction);
  console.log(`${join(root, file)} (${changed ? 'written' : 'unchanged'})`);
  return true;
}

function runsCurrentEntry() {
  const path = process.env.PATH;
  if (path === undefined) return false;
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const entry = realpathSync(__filename);
  for (const directory of path.split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, 'neorion' + suffix);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate) === entry;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function setupCodex(local: boolean, noHint: boolean) {
  const skills = join(homedir(), '.agents', 'skills', 'neorion');
  mkdirSync(skills, { recursive: true });
  copyFileSync(join(__dirname, '../skills/neorion/SKILL.md'), join(skills, 'SKILL.md'));
  console.log('✓ Skill installed: ~/.agents/skills/neorion');

  let skippedHint = false;
  if (!noHint) {
    const entry = /[^\w./:\\-]/.test(__filename)
      ? `"${process.platform === 'win32' ? __filename : __filename.replace(/(["\\$`])/g, '\\$1')}"`
      : __filename;
    const cli = !local && isTemporaryCliInstall(__filename) ? `npx -y ${packageSpec}` :
      !local && runsCurrentEntry() ? 'neorion' : `node ${entry}`;
    skippedHint = !writeHint('AGENTS.md', `For architecture questions (who renders/wraps/calls/imports X, rename impact), run \`${cli} query <kind> <target>\` in the shell first (kinds: ${kinds.join(', ')}) and trust a result that ends with \`# complete\`. Only open files to confirm specifics, or when the result ends with \`# partial\`.`);
  }

  const { command, args } = mcpCommand({ localEntry: __filename, detectCache: !local });
  const result = spawnSync('codex', ['mcp', 'add', 'neorion', '--', command, ...args], { encoding: 'utf8' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.log(`Add to ~/.codex/config.toml:\n[mcp_servers.neorion]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`);
  } else {
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not register the Neorion MCP server.');
    console.log('✓ MCP server registered: neorion  (check: codex mcp list)');
  }
  console.log(skippedHint ? 'Next: rerun setup from the project root to add the AGENTS.md hint.' :
    'Next: start `codex` in this project and ask "which pages render <Component>?"');
}

async function main([command, ...args]: string[]) {
  if ((!command || command === '--help') && !args.length) return console.log(help);
  if (command === '--version' && !args.length) return console.log(VERSION);
  if (command === 'graph' && args.length <= 1) {
    if (args[0]?.startsWith('--')) throw new Error(help);
    const { run } = require('./graph.cjs') as typeof import('./graph');
    return run(resolve(args[0] ?? '.'));
  }
  if (command === 'setup' && (args[0] === 'codex' || args[0] === 'claude')) {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { ...(args[0] === 'codex' ? { local: { type: 'boolean' as const } } : {}), 'no-hint': { type: 'boolean' } }
    });
    if (args[0] === 'codex') return setupCodex(!!values.local, !!values['no-hint']);
    if (!values['no-hint']) writeHint('CLAUDE.md', CLAUDE_HINT);
    return console.log(`claude --plugin-dir "${resolve(__dirname, '..')}"`);
  }
  if (command !== 'query' && command !== 'mcp') throw new Error(help);
  const query = command === 'query';
  const { values, positionals } = parseArgs({
    args,
    options: { root: { type: 'string' }, ...(query ? {
      limit: { type: 'string' as const },
      depth: { type: 'string' as const },
      'include-tests': { type: 'boolean' as const },
      uses: { type: 'boolean' as const },
      'no-external': { type: 'boolean' as const },
      'include-external': { type: 'boolean' as const }
    } : {}) },
    allowPositionals: query
  });
  const root = resolve(values.root ?? process.env.NEORION_ROOT ?? '.');
  if (!query) return serve(root, { autoBuild: true });
  const [kind, target, to] = positionals;
  if (positionals.length !== (kind === 'path' ? 3 : 2)) throw new Error(help);
  if (values['no-external'] && values['include-external']) throw new Error('Choose either --no-external or --include-external.');
  const externalOption = values['no-external'] ? { includeExternal: false } :
    values['include-external'] ? { includeExternal: true } : {};
  if (kind !== 'wrappers' && 'includeExternal' in externalOption) throw new Error('External wrapper flags require the wrappers query.');
  const project = findProject(root);
  if (!project) throw new Error(missingProject(root));
  const build = await ensureFresh(project);
  if (build.error) throw new Error(build.error);
  const engine = indexReader(project)();
  if (!engine) throw new Error(`Neorion index missing. Run "neorion graph" in ${project}.`);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const graphOptions = {
    ...(to === undefined ? {} : { to }),
    ...(values.depth === undefined ? {} : { depth: Number(values.depth) }),
    ...(values['include-tests'] === undefined ? {} : { includeTests: values['include-tests'] }),
    ...(values.uses === undefined ? {} : { uses: values.uses })
  };
  console.log(projectText(project, engine.query(queryName, { kind, target, limit, ...externalOption, ...graphOptions })));
}

if (isMainThread) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else runQueries(workerData as string);
