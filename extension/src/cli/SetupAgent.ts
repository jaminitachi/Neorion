import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mcpCommand } from '../core/McpCommand';

export type Agent = 'claude' | 'codex';
type Command = ReturnType<typeof mcpCommand>;
interface SetupState {
  skill?: string;
  mcp?: { config: string; entry: unknown };
}

const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

function read(file: string) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function commandText(program: string, args: string[]) {
  const quote = (arg: string) => /^[\w./:-]+$/.test(arg) ? arg : process.platform === 'win32'
    ? "'" + arg.replace(/'/g, "''") + "'"
    : "'" + arg.replace(/'/g, "'\\''") + "'";
  return [program, ...args.map(quote)].join(' ');
}

function mcpRegistration(agent: Agent, claudeHome: string, command: Command) {
  const claude = agent === 'claude';
  const config = claude
    ? join(process.env.CLAUDE_CONFIG_DIR ? claudeHome : homedir(), '.claude.json')
    : join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'config.toml');
  const run = (args: string[]) => spawnSync(agent, args, { encoding: 'utf8' });
  const addArgs = ['mcp', 'add', ...(claude ? ['--scope', 'user'] : []),
    'neorion', '--', command.command, ...command.args];
  const removeArgs = ['mcp', 'remove', ...(claude ? ['--scope', 'user'] : []), 'neorion'];
  const failure = (result: ReturnType<typeof run>, verb: string) => result.error ??
    new Error(result.stderr.trim() || `Could not ${verb} the Neorion MCP server with ${agent}.`);

  function current(requireClient = false) {
    if (claude) {
      const source = read(config);
      if (!source) return undefined;
      const data = JSON.parse(source.toString().replace(/^\uFEFF/, ''));
      const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!object(data) || (Object.prototype.hasOwnProperty.call(data, 'mcpServers') && !object(data.mcpServers))) {
        throw new Error(`Invalid MCP configuration in ${config}`);
      }
      return data.mcpServers?.neorion;
    }
    const result = run(['mcp', 'get', 'neorion', '--json']);
    if (!requireClient && errorCode(result.error) === 'ENOENT') return undefined;
    if (result.status === 0) return JSON.parse(result.stdout);
    if (result.stderr.includes("No MCP server named 'neorion' found.")) return undefined;
    throw failure(result, 'inspect');
  }

  return {
    config, current,
    add() {
      const result = run(addArgs);
      if (result.status === 0) return true;
      if (claude) {
        console.log(`Claude MCP registration failed. Run this command to register it at user scope:\n${commandText(agent, addArgs)}`);
      } else if (errorCode(result.error) === 'ENOENT') {
        console.log(`Add to ${config}:\n[mcp_servers.neorion]\ncommand = ${JSON.stringify(command.command)}\nargs = ${JSON.stringify(command.args)}`);
      } else {
        throw failure(result, 'register');
      }
      return false;
    },
    remove() {
      const result = run(removeArgs);
      if (result.status !== 0) throw failure(result, 'remove');
    }
  };
}

export function setupAgent(agent: Agent, entry: string, local: boolean, remove: boolean, updateHint: () => void) {
  const claudeHome = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const directory = agent === 'claude'
    ? join(claudeHome, 'skills', 'neorion')
    : join(homedir(), '.agents', 'skills', 'neorion');
  const skill = join(directory, 'SKILL.md');
  const stateFile = join(directory, '.neorion-setup.json');
  if (remove && !fs.existsSync(directory)) {
    updateHint();
    return;
  }

  fs.mkdirSync(directory, { recursive: true });
  const lock = join(directory, '.neorion-setup.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    throw new Error(`Another Neorion setup is using ${directory}.`);
  }
  try {
    if (fs.lstatSync(stateFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Neorion setup state is a symbolic link: ${stateFile}`);
    }
    const state: SetupState = JSON.parse(read(stateFile)?.toString() ?? '{}');
    const replace = (file: string, content: Buffer | string, mode: number) => {
      const temporary = join(lock, randomUUID());
      fs.writeFileSync(temporary, content, { mode });
      fs.renameSync(temporary, file);
    };
    const save = () => {
      if (!state.skill && !state.mcp) {
        fs.rmSync(stateFile, { force: true });
        return;
      }
      replace(stateFile, JSON.stringify(state) + '\n', 0o600);
    };
    const mcp = mcpRegistration(agent, claudeHome, mcpCommand({
      localEntry: entry, detectCache: agent === 'codex' && !local
    }));
    updateHint();
    const existing = fs.lstatSync(skill, { throwIfNoEntry: false });
    const installed = existing?.isFile() ? read(skill) : undefined;
    if (remove) {
      if (state.skill) {
        if (installed && hash(installed) === state.skill) {
          fs.unlinkSync(skill);
          console.log(`Skill removed: ${skill}`);
        } else if (existing) {
          console.log(`Keeping modified skill: ${skill}`);
        }
        delete state.skill;
        save();
      }
      if (state.mcp) {
        if (state.mcp.config !== mcp.config) {
          throw new Error(`Neorion was registered in ${state.mcp.config}. Use that configuration to remove it.`);
        }
        const current = mcp.current(true);
        if (isDeepStrictEqual(current, state.mcp.entry)) {
          mcp.remove();
          console.log(`MCP server removed: neorion (${mcp.config})`);
        } else if (current !== undefined) {
          console.log(`Keeping modified MCP server: neorion (${mcp.config})`);
        }
        delete state.mcp;
        save();
      }
      return;
    }

    const source = fs.readFileSync(join(dirname(entry), '../skills/neorion/SKILL.md'));
    if (!existing || (installed && !installed.equals(source) && hash(installed) === state.skill)) {
      if (existing) replace(skill, source, existing.mode & 0o777);
      else fs.writeFileSync(skill, source, { flag: 'wx' });
      state.skill = hash(source);
      save();
      console.log(`Skill installed: ${skill}`);
    } else {
      console.log(`Skill unchanged: ${skill}`);
    }

    if (state.mcp && state.mcp.config !== mcp.config) {
      throw new Error(`Neorion was registered in ${state.mcp.config}. Remove that registration before using a different configuration.`);
    }
    if (mcp.current() !== undefined) {
      console.log(`MCP server unchanged: neorion (${mcp.config})`);
    } else if (mcp.add()) {
      const registered = mcp.current();
      if (registered === undefined) throw new Error(`Could not confirm the Neorion MCP server in ${mcp.config}.`);
      state.mcp = { config: mcp.config, entry: registered };
      save();
      console.log(`MCP server registered: neorion (${mcp.config})`);
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
