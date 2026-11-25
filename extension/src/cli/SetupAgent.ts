import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mcpCommand } from '../core/McpCommand';
import { Agent, agentMcp, Command, Entry, isEntry, missingClient, transport, uninspectableEntry } from './AgentMcp';
import { errorCode, read } from './SetupFiles';

interface SetupState {
  skill?: string;
  mcp?: { config: string; entry: Entry };
}

const releasedSkills = new Map([
  ['5a08a84a85e7cd844ae8f751883ef3a6f6d57dea7e33026ebdf5aae40c306e7d', '0.5.0'],
  ['3d8879d76ce3305c3cf671b1a9975558ed755de6c496f30776b9dd3d4e7a3a48', '0.5.1'],
  ['dccc73d6cea7da5eb153d1f2927a61e7735395b6110cf773e43bcd17a1408712', '0.5.2']
]);
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

function isLegacyCodexEntry(entry: Entry, version: string) {
  const launcher = transport(entry);
  const defaults: Entry = {
    name: 'neorion', enabled: true, disabled_reason: null, enabled_tools: null, disabled_tools: null,
    startup_timeout_sec: null, tool_timeout_sec: null, auth_status: 'unsupported'
  };
  if (launcher !== entry && Object.entries(entry).some(([key, value]) => key !== 'transport' && defaults[key] !== value)) {
    return false;
  }
  const launchDefaults: Entry = { type: 'stdio', env: null, env_vars: [], cwd: null };
  if (!Object.entries(launcher).every(([key, value]) => key === 'command' || key === 'args' ||
      (key === 'env' && isDeepStrictEqual(value, {})) || isDeepStrictEqual(launchDefaults[key], value))) {
    return false;
  }
  const { command, args } = launcher;
  if (typeof command !== 'string' || !Array.isArray(args)) return false;
  const [cli, subcommand] = args;
  if (args.length === 2 && subcommand === 'mcp' && typeof cli === 'string' &&
      (posix.isAbsolute(cli) || win32.isAbsolute(cli)) &&
      /\/neorion\/dist\/neorion\.cjs$/i.test(cli.replace(/\\/g, '/')) &&
      /^(node|nodejs|node\.exe)$/i.test(win32.basename(command)) &&
      (posix.isAbsolute(command) || win32.isAbsolute(command))) return true;
  return (['linux', 'win32'] as const).some(platform => {
    const pinned = mcpCommand({ platform, registryVersion: version });
    const launchArgs = args.map(arg => typeof arg === 'string' ? arg.replace(/\n\s*/g, ' ') : arg);
    return command === pinned.command && isDeepStrictEqual(launchArgs, pinned.args);
  });
}

export function setupAgent(agent: Agent, entry: string, command: Command, remove: boolean, updateHint: () => void) {
  const claudeHome = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const directory = agent === 'claude'
    ? join(claudeHome, 'skills', 'neorion')
    : join(homedir(), '.agents', 'skills', 'neorion');
  const skill = join(directory, 'SKILL.md');
  const stateFile = join(directory, '.neorion-setup.json');
  fs.mkdirSync(directory, { recursive: true });
  const lock = join(directory, '.neorion-setup.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    throw new Error(`Neorion setup is locked. If no setup process is running, delete the lock directory and rerun setup: ${lock}`);
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

    if (agent === 'claude' || remove) updateHint();
    const mcp = agentMcp(agent, claudeHome, command);
    if (state.mcp && state.mcp.config !== mcp.config) {
      throw new Error(`Neorion was registered in ${state.mcp.config}. Use that configuration to remove it first.`);
    }
    const existing = fs.lstatSync(skill, { throwIfNoEntry: false });
    const installed = existing?.isFile() ? read(skill) : undefined;
    const installedHash = installed && hash(installed);
    const legacy = !state.skill && installedHash ? releasedSkills.get(installedHash) : undefined;
    const ownsSkill = !!installedHash && (installedHash === state.skill || legacy !== undefined);
    const current = mcp.current();
    // Older Codex setup recorded neither item. Require the paired released skill and a default launch entry.
    if (!state.mcp && agent === 'codex' && legacy && isEntry(current) && isLegacyCodexEntry(current, legacy)) {
      state.mcp = { config: mcp.config, entry: current };
      save();
    }
    const ownsMcp = !!state.mcp && isDeepStrictEqual(current, state.mcp.entry);

    if (remove) {
      if (ownsSkill) {
        fs.unlinkSync(skill);
        console.log(`Skill removed: ${skill}`);
      } else if (existing) {
        console.log(`Keeping ${state.skill ? 'modified skill' : 'existing skill (not installed by this setup)'}: ${skill}`);
      }
      delete state.skill;
      save();

      if (state.mcp && current === missingClient) mcp.removeManually();
      if (state.mcp && current === uninspectableEntry) {
        throw new Error('Could not verify the Neorion MCP entry. Upgrade Codex and rerun setup --remove.');
      }
      if (ownsMcp) {
        mcp.remove();
        console.log(`MCP server removed: neorion (${mcp.config})`);
      } else if (current !== undefined && current !== missingClient) {
        console.log(`Keeping ${state.mcp ? 'modified MCP server' : 'existing MCP server (not registered by this setup)'}: neorion (${mcp.config})`);
      }
      delete state.mcp;
      save();
      return;
    }

    const source = fs.readFileSync(join(dirname(entry), '../skills/neorion/SKILL.md'));
    const installSkill = () => {
      if (!existing || (ownsSkill && !installed?.equals(source))) {
        if (existing) replace(skill, source, existing.mode & 0o777);
        else fs.writeFileSync(skill, source, { flag: 'wx' });
        state.skill = hash(source);
        save();
        console.log(`Skill installed: ${skill}`);
      } else {
        console.log(`${ownsSkill ? 'Skill unchanged' : 'Keeping existing skill (not installed by this setup)'}: ${skill}`);
      }
    };
    const register = () => {
      if (isEntry(current) && ownsMcp) {
        const launch = transport(current);
        if (launch.command === command.command && isDeepStrictEqual(launch.args, command.args)) {
          console.log(`MCP server unchanged: neorion (${mcp.config})`);
          return;
        }
        if (agent === 'claude') mcp.remove();
      } else if (current !== undefined && current !== missingClient) {
        console.log(`Keeping ${state.mcp ? 'modified MCP server' : 'existing MCP server (not registered by this setup)'}: neorion (${mcp.config})`);
        return;
      }
      if (mcp.add()) {
        const registered = mcp.current();
        if (isEntry(registered)) {
          state.mcp = { config: mcp.config, entry: registered };
          save();
        } else if (registered === uninspectableEntry) {
          console.log('This version of Codex cannot verify the entry for automatic removal. Use codex mcp remove neorion.');
        } else {
          throw new Error(`Could not confirm the Neorion MCP server in ${mcp.config}.`);
        }
        console.log(`MCP server registered: neorion (${mcp.config})`);
      }
    };
    if (agent === 'codex') {
      register();
      installSkill();
      updateHint();
    } else {
      installSkill();
      register();
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    if (remove) {
      try {
        fs.rmdirSync(directory);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
      }
    }
  }
}
