#!/usr/bin/env node
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { CURSOR_EXTENSION_RULE, CURSOR_SETUP_RULE, hasActiveCursorRule, queryHint, updateAgentFiles } from '../core/AgentInstructions';
import { missingProject, selectProject } from '../core/FindProject';
import { ensureFresh, projectText } from '../mcp/Build';
import { isTemporaryCliInstall, mcpCommand, packageSpec } from '../core/McpCommand';
import { MCP_TARGETS, planMcp } from '../core/McpRegistration';
import { VERSION } from '../mcp/Index';
import { indexReader, runQueries, serve } from '../mcp/server';
import { kinds, queryName } from '../mcp/Tools';
import { updateClaudeHook } from './ClaudeHook';
import { setupAgent } from './SetupAgent';

const help = `Usage:
  neorion graph [dir] [--mcp-config]
  neorion query <kind> <target> [--limit n] [--root dir]
  neorion query search <text> [--kind filter] [--limit n]
  neorion query wrappers <route> [--no-external | --include-external]
  neorion query impact <symbol|file> [--depth n] [--include-tests]
  neorion query callees <symbol> [--depth n] [--uses]
  neorion query path <from> <to>
  neorion query changes [--base ref | --staged | --unstaged] [--depth n]
  neorion mcp [--root dir | --workspace dir]
  neorion setup codex [--local] [--no-hint]
  neorion setup claude [--no-hint] [--no-hook]
  neorion setup <codex|claude> --remove [--no-hint]
  neorion setup cursor [--remove]
  neorion --version | --help

Query kinds: ${kinds.join(', ')}

Wrapper flags:
  --no-external hides third-party non-provider wrappers. Providers stay visible.
  --include-external includes third-party wrappers (default).

Setup:
  claude adds an advisory Grep/Glob hook to project settings (Claude Code 2.1.295+).
  --no-hook disables the advisory.
  cursor adds the Neorion MCP server and query rule to the project.`;

function isProjectDirectory(root: string) {
  return ['tsconfig.json', 'jsconfig.json', 'package.json'].some(name => existsSync(join(root, name)));
}

function isHomeDirectory(root: string) {
  const home = homedir();
  return root === home || (existsSync(home) && root === realpathSync(home));
}

function writeHint(file: string, instruction: string) {
  const root = process.cwd();
  if (!isProjectDirectory(root)) {
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

function hintCommand(temporary: boolean, onPath: boolean) {
  if (temporary) return `npx -y ${packageSpec}`;
  if (onPath) return 'neorion';
  const entry = /[^\w./:\\-]/.test(__filename)
    ? `"${process.platform === 'win32' ? __filename : __filename.replace(/(["\\$`])/g, '\\$1')}"`
    : __filename;
  return `node ${entry}`;
}

async function main([command, ...args]: string[]) {
  if ((!command || command === '--help') && !args.length) return console.log(help);
  if (command === '--version' && !args.length) return console.log(VERSION);
  if (command === 'graph') {
    const { values, positionals } = parseArgs({
      args, options: { 'mcp-config': { type: 'boolean' } }, allowPositionals: true
    });
    if (positionals.length > 1) throw new Error(help);
    const { run } = require('./graph.cjs') as typeof import('./graph');
    return run(resolve(positionals[0] ?? '.'), values['mcp-config']);
  }
  if (command === 'setup' && (args[0] === 'codex' || args[0] === 'claude' || args[0] === 'cursor')) {
    const agent = args[0];
    const codex = agent === 'codex';
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        ...(codex ? { local: { type: 'boolean' as const } } : {}),
        ...(agent === 'claude' ? { 'no-hook': { type: 'boolean' as const } } : {}),
        ...(agent === 'cursor' ? {} : { 'no-hint': { type: 'boolean' as const } }),
        remove: { type: 'boolean' }
      }
    });
    const temporary = !values.local && isTemporaryCliInstall(__filename);
    const onPath = !values.local && !temporary && runsCurrentEntry();
    const localEntry = temporary ? undefined : __filename;
    const root = process.cwd();
    const remove = !!values.remove;
    if (agent === 'cursor') {
      const mcp = planMcp(root, root, ['Cursor'], false, '', !remove, { cursorSetup: { localEntry } });
      mcp.commit(() => {
        const writeRule = !remove && !hasActiveCursorRule(root, CURSOR_EXTENSION_RULE);
        if (updateAgentFiles(root, root, [CURSOR_SETUP_RULE], writeRule, true, queryHint(hintCommand(temporary, onPath)))) {
          console.log(`${join(root, CURSOR_SETUP_RULE)} (${writeRule ? 'written' : 'Neorion block removed'})`);
        }
      });
      const config = join(root, MCP_TARGETS.Cursor.file);
      if (mcp.count) console.log(`${config} (Neorion MCP setup ${remove ? 'removed' : 'configured'})`);
      return;
    }
    const file = codex ? 'AGENTS.md' : 'CLAUDE.md';
    let skippedHint = false;
    setupAgent(agent, __filename, mcpCommand({ localEntry }), remove, () => {
      if (!values['no-hint']) {
        if (remove) {
          if (updateAgentFiles(root, root, [file], false)) console.log(`${join(root, file)} (Neorion block removed)`);
        } else {
          skippedHint = !writeHint(file, queryHint(hintCommand(temporary, onPath)));
        }
      }
      if (agent === 'claude') {
        if (remove || values['no-hook']) updateClaudeHook(root, false);
        else if (isProjectDirectory(root) && !isHomeDirectory(root)) {
          updateClaudeHook(root, true);
        }
      }
    });
    if (codex && !values.remove) {
      console.log(skippedHint ? 'Next: rerun setup from the project root to add the AGENTS.md hint.' :
        'Next: start `codex` in this project and ask "which pages render <Component>?"');
    }
    return;
  }
  if (command !== 'query' && command !== 'mcp') throw new Error(help);
  const query = command === 'query';
  const { values, positionals } = parseArgs({
    args,
    options: { root: { type: 'string' }, workspace: { type: 'string' }, ...(query ? {
      limit: { type: 'string' as const },
      kind: { type: 'string' as const },
      depth: { type: 'string' as const },
      'include-tests': { type: 'boolean' as const },
      uses: { type: 'boolean' as const },
      base: { type: 'string' as const },
      staged: { type: 'boolean' as const },
      unstaged: { type: 'boolean' as const },
      'no-external': { type: 'boolean' as const },
      'include-external': { type: 'boolean' as const }
    } : {}) },
    allowPositionals: query
  });
  if (query && values.workspace !== undefined) throw new Error('--workspace requires the mcp command.');
  if (values.root !== undefined && values.workspace !== undefined) throw new Error('Choose either --root or --workspace.');
  const configuredRoot = values.root ?? (values.workspace === undefined ? process.env.NEORION_ROOT : undefined);
  const workspace = values.workspace ?? (configuredRoot === undefined ? process.env.NEORION_WORKSPACE : undefined);
  const root = resolve(workspace ?? configuredRoot ?? '.');
  const confirm = workspace === undefined && configuredRoot !== undefined;
  if (!query) return serve(root, { autoBuild: true, confirm });
  const [kind, target, to] = positionals;
  if (positionals.length !== (kind === 'path' ? 3 : kind === 'changes' ? 1 : 2)) throw new Error(help);
  if (values.kind !== undefined && kind !== 'search') throw new Error('--kind requires the search query.');
  if (kind !== 'changes') for (const flag of ['base', 'staged', 'unstaged'] as const) {
    if (values[flag] !== undefined) throw new Error(`--${flag} requires the changes query.`);
  }
  if (Number(!!values.staged) + Number(!!values.unstaged) + Number(values.base !== undefined) > 1) {
    throw new Error('Choose only one of --base, --staged, or --unstaged.');
  }
  if (values['no-external'] && values['include-external']) throw new Error('Choose either --no-external or --include-external.');
  const externalOption = values['no-external'] ? { includeExternal: false } :
    values['include-external'] ? { includeExternal: true } : {};
  if (kind !== 'wrappers' && 'includeExternal' in externalOption) throw new Error('External wrapper flags require the wrappers query.');
  const selection = selectProject(root, confirm);
  if (!selection) throw new Error(missingProject(root));
  const project = selection.directory;
  const build = await ensureFresh(project);
  if (build.error) throw new Error(build.error);
  const engine = indexReader(project)();
  if (!engine) throw new Error(`Neorion index missing. Run graph in ${project} using the same CLI invocation.`);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const options = {
    ...(target === undefined ? {} : { target }),
    ...(to === undefined ? {} : { to }),
    ...(values.kind === undefined ? {} : { filter: values.kind }),
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.staged || values.unstaged ? { scope: values.staged ? 'staged' : 'unstaged' } : {}),
    ...(values.depth === undefined ? {} : { depth: Number(values.depth) }),
    ...(values['include-tests'] === undefined ? {} : { includeTests: values['include-tests'] }),
    ...(values.uses === undefined ? {} : { uses: values.uses })
  };
  const installed = basename(process.argv[1]) === 'neorion' && !isTemporaryCliInstall(__filename) && runsCurrentEntry();
  const invocation = installed ? ['neorion'] : [process.execPath, __filename];
  console.log(projectText(selection, root, engine.query(queryName, { kind, limit, ...externalOption, ...options }, { invocation, root: project })));
}

if (isMainThread) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else runQueries(workerData as string);
