import type { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { mcpCommand } from '../core/McpCommand';
import { errorCode, read } from './SetupFiles';

const { sync: spawn }: { sync: typeof spawnSync } = require('cross-spawn');

export type Agent = 'claude' | 'codex';
export type Command = ReturnType<typeof mcpCommand>;
export type Entry = Record<string, unknown>;
export const missingClient = Symbol('missing client');
export const uninspectableEntry = Symbol('uninspectable entry');

export function isEntry(value: unknown): value is Entry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function transport(entry: Entry) {
  return isEntry(entry.transport) ? entry.transport : entry;
}

function commandText(program: string, args: string[]) {
  const quote = (arg: string) => /^[\w./:-]+$/.test(arg) ? arg : process.platform === 'win32'
    ? "'" + arg.replace(/'/g, "''") + "'"
    : "'" + arg.replace(/'/g, "'\\''") + "'";
  return [program, ...args.map(quote)].join(' ');
}

function unsupported(result: { stderr: string }, argument: string) {
  return result.stderr.split('\n').some(line => line.includes(argument) &&
    /unrecognized|unknown|unexpected|invalid choice/i.test(line));
}

export function agentMcp(agent: Agent, claudeHome: string, command: Command) {
  const claude = agent === 'claude';
  const config = claude
    ? join(process.env.CLAUDE_CONFIG_DIR ? claudeHome : homedir(), '.claude.json')
    : join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'config.toml');
  const run = (args: string[]) => spawn(agent, args, { encoding: 'utf8' });
  const addArgs = ['mcp', 'add', ...(claude ? ['--scope', 'user'] : []),
    'neorion', '--', command.command, ...command.args];
  const removeArgs = ['mcp', 'remove', ...(claude ? ['--scope', 'user'] : []), 'neorion'];
  const shell = process.platform === 'win32' ? ' in PowerShell' : '';
  const failure = (result: ReturnType<typeof run>, verb: string) => {
    const detail = result.error?.message || result.stderr?.trim() || `Could not ${verb} the Neorion MCP server with ${agent}.`;
    return new Error(claude ? detail : detail +
      `
Check that CODEX_HOME points to a writable directory and that ${config} is valid, then rerun setup.`);
  };
  let codexLookup: 'get' | 'json-list' | 'text-list' = 'get';

  function removeManually(): never {
    throw new Error(`Could not remove the Neorion MCP server with ${agent}. Run this command${shell}:\n${commandText(agent, removeArgs)}`);
  }

  function current(): Entry | typeof missingClient | typeof uninspectableEntry | undefined {
    if (claude) {
      const source = read(config);
      if (!source) return undefined;
      let data: unknown;
      try {
        data = JSON.parse(source.toString().replace(/^\uFEFF/, ''));
      } catch {
        throw new Error(`Could not read JSON in ${config}. If Claude Code is updating it, wait and rerun setup.`);
      }
      if (!isEntry(data) || ('mcpServers' in data && !isEntry(data.mcpServers))) {
        throw new Error(`Invalid MCP configuration in ${config}`);
      }
      const entry = (data.mcpServers as Entry | undefined)?.neorion;
      return isEntry(entry) ? entry : entry === undefined ? undefined : uninspectableEntry;
    }
    if (codexLookup === 'get') {
      const result = run(['mcp', 'get', 'neorion', '--json']);
      if (errorCode(result.error) === 'ENOENT') return missingClient;
      if (result.status === 0) return JSON.parse(result.stdout);
      if (result.stderr.includes("No MCP server named 'neorion' found.")) return undefined;
      if (!unsupported(result, 'get') && !unsupported(result, '--json')) throw failure(result, 'inspect');
      codexLookup = 'json-list';
    }
    if (codexLookup === 'json-list') {
      const result = run(['mcp', 'list', '--json']);
      if (errorCode(result.error) === 'ENOENT') return missingClient;
      if (result.status === 0) {
        const entries: Entry[] = JSON.parse(result.stdout);
        return entries.find(entry => entry.name === 'neorion');
      }
      if (!unsupported(result, '--json')) throw failure(result, 'inspect');
      codexLookup = 'text-list';
    }
    const result = run(['mcp', 'list']);
    if (errorCode(result.error) === 'ENOENT') return missingClient;
    if (result.status !== 0) throw failure(result, 'inspect');
    return /^\s*neorion(?:[ \t]|$)/m.test(result.stdout) ? uninspectableEntry : undefined;
  }

  return {
    config, current,
    add() {
      const result = run(addArgs);
      if (result.status === 0) return true;
      if (claude) {
        console.log(`Claude MCP registration failed. Run this command${shell} to register it at user scope:\n${commandText(agent, addArgs)}`);
      } else if (errorCode(result.error) === 'ENOENT') {
        console.log(`Add to ${config}:\n[mcp_servers.neorion]\ncommand = ${JSON.stringify(command.command)}\nargs = ${JSON.stringify(command.args)}`);
      } else {
        throw failure(result, 'register');
      }
      return false;
    },
    removeManually,
    remove() {
      if (run(removeArgs).status !== 0) removeManually();
    }
  };
}
