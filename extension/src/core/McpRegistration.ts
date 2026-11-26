import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { valid } from 'semver';
import { applyEdits, findNodeAtLocation, modify, parseTree, getNodeValue, type ParseError, type Node } from 'jsonc-parser';
import { workspaceCache } from './WorkspaceCache';
import { mcpCommand } from './McpCommand';

export const MCP_TARGETS = {
  'Claude Code': { file: '.mcp.json', key: 'mcpServers', type: true, variable: false },
  Cursor: { file: '.cursor/mcp.json', key: 'mcpServers', type: true, variable: true },
  'VS Code (Copilot agent)': { file: '.vscode/mcp.json', key: 'servers', type: true, variable: true }
} as const;
export type McpTarget = keyof typeof MCP_TARGETS;
export const REGISTER_MCP = 'Register Neorion query tools (MCP)';
export const COPY_MCP = 'Other tools: copy configuration snippet';
const STATE = '.neorion/connect-state.json';
const CURSOR_SETUP_STATE = '.neorion/cursor-setup-state.json';
const BUNDLE = '.neorion/mcp/server.cjs';
export const CURSOR_WORKSPACE_CLI = '.neorion/cursor-setup/neorion.cjs';

type Command = { command: string; args: string[]; type?: 'stdio' };
interface ConfigState {
  createdFile: boolean;
  insertion?: string;
  entry: Command;
  createdDirectory: boolean;
  hadGroup: boolean;
  hadNeorion: boolean;
}
interface State {
  configs: Partial<Record<McpTarget, ConfigState>>;
  bundle?: { hash?: string; createdDirectory: boolean; graphHash?: string };
  legacyBundle?: State['bundle'];
}
type Change = { file: string; content: string | Buffer | null };

const json = (value: unknown) => JSON.stringify(value, null, 2);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const exists = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });
const equal = (a: unknown, b: Command) => {
  if (!a || typeof a !== 'object') return false;
  const record = a as Command;
  return Object.keys(a).length === Object.keys(b).length && record.type === b.type &&
    record.command === b.command && JSON.stringify(record.args) === JSON.stringify(b.args);
};

function checked(root: string, relative: string) {
  const file = path.join(root, relative);
  const entries = relative.split('/');
  let entry = root;
  for (const part of entries) {
    entry = path.join(entry, part);
    if (exists(entry)?.isSymbolicLink()) throw new Error(`MCP path is a symbolic link: ${relative}`);
  }
  return file;
}

function read(file: string) {
  return exists(file) ? fs.readFileSync(file, 'utf8') : null;
}

function config(original: string, target: McpTarget) {
  const errors: ParseError[] = [];
  const bom = original.startsWith('\uFEFF') ? 1 : 0;
  const jsonc = target !== 'Claude Code';
  const tree = parseTree(original.slice(bom), errors, {
    disallowComments: !jsonc,
    allowTrailingComma: jsonc
  });
  const { key, file } = MCP_TARGETS[target];
  const group = tree && findNodeAtLocation(tree, [key]);
  if (errors.length || tree?.type !== 'object' || (group && group.type !== 'object')) {
    throw new Error(`Invalid MCP configuration in ${file}`);
  }
  const properties = (node: Node) => node.children?.map(property => property.children?.[0].value) ?? [];
  if (properties(tree).filter(name => name === key).length > 1 ||
      (group && properties(group).filter(name => name === 'neorion').length > 1)) {
    throw new Error(`Duplicate MCP configuration keys in ${file}`);
  }
  return { bom, tree, group, entry: group && findNodeAtLocation(group, ['neorion']) };
}

const onOneLine = (original: string, bom: number, node: Node) =>
  !/[\r\n]/.test(original.slice(bom + node.offset, bom + node.offset + node.length));

function insert(original: string, bom: number, node: Node, key: string, value: unknown, inline: boolean) {
  const last = node.children?.[node.children.length - 1];
  const offset = bom + (last ? last.offset + last.length : node.offset + 1);
  if (inline) {
    const insertion = (last ? ', ' : '') + JSON.stringify(key) + ': ' + JSON.stringify(value);
    return { written: original.slice(0, offset) + insertion + original.slice(offset), insertion };
  }
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const column = (position: number) => /^[\t ]*/.exec(original.slice(original.lastIndexOf('\n', position - 1) + 1))![0];
  const base = node.parent ? column(bom + node.parent.offset) : '';
  const indent = last ? column(bom + last.offset) || base + '  ' : base + '  ';
  const property = JSON.stringify(key) + ': ' + json(value).replace(/\n/g, newline + indent);
  const insertion = (last ? ',' : '') + newline + indent + property +
    (original[offset] === '}' ? newline + base : '');
  return { written: original.slice(0, offset) + insertion + original.slice(offset), insertion };
}

const launchBundle = (flag: string) => [
  'const [workspace, project] = process.argv.slice(1);',
  'const { join, resolve } = require("node:path");',
  `const cache = (${workspaceCache.toString()})(workspace);`,
  `const server = join(cache, ${JSON.stringify(BUNDLE)});`,
  'if (!require("node:fs").existsSync(server)) {',
  '  console.error("Neorion MCP bundle missing. Run Neorion: Connect AI tools in this workspace.");',
  '  process.exit(1);',
  '}',
  `process.argv.splice(1, 2, server, ${JSON.stringify(flag)}, resolve(workspace, project));`,
  'process.execArgv = [];',
  'require(server);'
].join('\n');

function isCursorNeorionEntry(value: unknown, localEntry: string) {
  if (!value || typeof value !== 'object') return false;
  const { type, command, args } = value as Command;
  if ((type !== undefined && type !== 'stdio') || !Array.isArray(args) ||
      !args.every(arg => typeof arg === 'string')) return false;
  const workspace = '${workspaceFolder}';
  const matches = (expected: Command) => command === expected.command && JSON.stringify(args) === JSON.stringify(expected.args);
  if (matches(mcpCommand({ root: workspace, localEntry }))) return true;

  const root = args.at(-1);
  if (!root || (root !== workspace && !root.startsWith(workspace + '/'))) return false;
  if (matches(mcpCommand({ root, discover: true, useRelease: true, workspaceCli: CURSOR_WORKSPACE_CLI,
    requireWorkspaceCli: true }))) return true;
  // Compare the full launch arguments after extracting the installed package's version.
  const spec = (command === 'npx' ? args[1] : /\bnpx -y (\S+) mcp\b/.exec(args[1] ?? '')?.[1]) ?? '';
  const releaseVersion = /\/download\/v([^/]+)\//.exec(spec)?.[1];
  const version = valid(releaseVersion ?? spec.split('@').at(-1) ?? '');
  const options = { root, registryVersion: version ?? undefined, useRelease: !!releaseVersion };
  return !!version && [false, true].some(discover => matches(mcpCommand({ ...options, discover, platform: 'linux' })) ||
    matches(mcpCommand({ ...options, discover, platform: 'win32' })) ||
    !!releaseVersion && matches(mcpCommand({ ...options, discover, workspaceCli: CURSOR_WORKSPACE_CLI })));
}

function isExtensionCursorEntry(cache: string, entry: unknown) {
  try {
    // The generated bundle launcher can differ across CLI and extension builds.
    const source = read(checked(cache, STATE));
    const registered = source && (JSON.parse(source) as State | null)?.configs?.Cursor?.entry;
    return !!registered && equal(entry, registered);
  } catch {
    return false;
  }
}

export function mcpSnippet(tool: 'Codex CLI' | 'Windsurf' | 'Gemini CLI', root: string, bundleSource: string, discover: boolean) {
  const command: Command = { command: 'node', args: [bundleSource, discover ? '--workspace' : '--root', root] };
  return tool === 'Codex CLI'
    ? `[mcp_servers.neorion]\ncommand = ${JSON.stringify(command.command)}\nargs = ${JSON.stringify(command.args)}\n`
    : json({ mcpServers: { neorion: command } });
}

export function planMcp(root: string, project: string, targets: McpTarget[], bundled: boolean, bundleSource: string,
  connect: boolean, { discover = false, cursorSetup }: { discover?: boolean; cursorSetup?: { legacyLocalEntry: string; requireWorkspaceCli?: boolean } } = {}) {
  const changes: Change[] = [];
  const directories = new Set<string>();
  const cache = workspaceCache(root);
  if (exists(cache)?.isSymbolicLink()) throw new Error('Neorion cache is a symbolic link');
  const stateFile = checked(cache, cursorSetup ? CURSOR_SETUP_STATE : STATE);
  const originalState = read(stateFile);
  const legacyStateFile = cursorSetup ? undefined : checked(root, STATE);
  const legacyState = originalState === null && legacyStateFile ? read(legacyStateFile) : null;
  const state: State = JSON.parse(originalState ?? legacyState ?? '{"configs":{}}');
  if (!state.configs || typeof state.configs !== 'object' ||
      Object.keys(state.configs).some(target => !Object.prototype.hasOwnProperty.call(MCP_TARGETS, target))) throw new Error('Invalid Neorion MCP connection state.');
  if (legacyState !== null) {
    state.legacyBundle = state.bundle;
    delete state.bundle;
  }
  const bundlePath = cursorSetup ? CURSOR_WORKSPACE_CLI : BUNDLE;
  const bundle = checked(cache, bundlePath);
  const graphBundlePath = path.posix.join(path.posix.dirname(bundlePath), 'graph.cjs');
  const relativeProject = discover ? '' : path.relative(root, project).split(path.sep).join('/');
  const projectArgument = relativeProject || '.';
  const updated = new Set<McpTarget>();

  let preserveLegacyBundle = false;
  let installCursorBundle = false;
  for (const target of connect ? targets : Object.keys(state.configs) as McpTarget[]) {
    const { file: configFile, key, type, variable } = MCP_TARGETS[target];
    const file = checked(root, configFile);
    const original = read(file);
    const previous = state.configs[target];
    if (!connect) {
      if (original !== null && previous && !previous.hadNeorion) {
        const parsed = config(original, target);
        if (parsed.entry && equal(getNodeValue(parsed.entry), previous.entry)) {
          const offset = previous.insertion ? original.indexOf(previous.insertion) : -1;
          const exact = offset >= 0 && original.indexOf(previous.insertion!, offset + 1) < 0;
          const removeGroup = !previous.hadGroup && parsed.group?.children?.length === 1;
          const edited = original.slice(parsed.bom);
          let strip: string | undefined;
          if (exact && (previous.hadGroup || removeGroup)) {
            const candidate = original.slice(parsed.bom, offset) + original.slice(offset + previous.insertion!.length);
            try {
              if (!config(candidate, target).entry) strip = candidate;
            } catch {
              // A sibling added after Neorion can require a different comma placement.
            }
          }
          strip ??= applyEdits(edited, modify(edited, removeGroup ? [key] : [key, 'neorion'], undefined, {}));
          const withoutBom = config(strip, target);
          const empty = !withoutBom.tree.children?.length;
          const hasComments = /\/\/|\/\*/.test(strip);
          changes.push({ file, content: previous.createdFile && empty && !hasComments
            ? null : original.slice(0, parsed.bom) + strip });
        }
        if (previous.createdDirectory) directories.add(path.dirname(file));
      }
      if (previous?.entry.args?.[0]?.endsWith(BUNDLE) && previous.entry.args[0] !== bundle &&
          original !== null && !changes.some(change => change.file === file)) preserveLegacyBundle = true;
      delete state.configs[target];
      updated.add(target);
      continue;
    }
    const scopedProject = variable ? '${workspaceFolder}' + (relativeProject ? '/' + relativeProject : '') : projectArgument;
    const entry: Command = bundled
      ? { command: 'node', args: ['-e', launchBundle(discover ? '--workspace' : '--root'), '--',
          variable ? '${workspaceFolder}' : '.', projectArgument] }
      : mcpCommand({ root: scopedProject, discover, useRelease: !!cursorSetup,
          workspaceCli: cursorSetup && CURSOR_WORKSPACE_CLI, requireWorkspaceCli: cursorSetup?.requireWorkspaceCli });
    if (type) entry.type = 'stdio';
    const parsed = config(original ?? '{}', target);
    const current = parsed.entry && getNodeValue(parsed.entry);
    const implicitStdio = target === 'Cursor' && (!previous || previous.hadNeorion) &&
      equal(current, { command: entry.command, args: entry.args });
    if (cursorSetup) {
      installCursorBundle = !parsed.entry || equal(current, entry) || implicitStdio ||
        !!(previous && !previous.hadNeorion && equal(current, previous.entry));
      if (!installCursorBundle && parsed.entry &&
          (isCursorNeorionEntry(current, cursorSetup.legacyLocalEntry) || isExtensionCursorEntry(cache, current))) continue;
    }
    const inline = target === 'Cursor' && !!parsed.group && onOneLine(original!, parsed.bom, parsed.group);
    if (parsed.entry && !equal(current, entry) && !implicitStdio) {
      if (!previous || previous.hadNeorion || !equal(getNodeValue(parsed.entry), previous.entry)) {
        const next = cursorSetup ? '. Keep the existing entry or remove it from Cursor (or through the extension that registered it) before rerunning setup.' : '';
        throw new Error(`Neorion MCP server conflicts with an existing entry in ${configFile}${next}`);
      }
      const source = original!;
      const start = parsed.bom + parsed.entry.offset;
      const end = start + parsed.entry.length;
      const indent = /^[\t ]*/.exec(source.slice(source.lastIndexOf('\n', start - 1) + 1))![0];
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const replacement = inline ? JSON.stringify(entry) : json(entry).replace(/\n/g, newline + indent);
      const offset = previous.insertion ? source.indexOf(previous.insertion) : -1;
      const insertion = previous.insertion;
      const nextInsertion = insertion && offset >= 0 && start >= offset && end <= offset + insertion.length
        ? insertion.slice(0, start - offset) + replacement + insertion.slice(end - offset) : undefined;
      state.configs[target] = { ...previous, entry, insertion: nextInsertion };
      changes.push({ file, content: source.slice(0, start) + replacement + source.slice(end) });
      updated.add(target);
      continue;
    }
    if (parsed.entry && previous) continue;
    const edit = parsed.entry ? undefined : insert(original ?? '{}', parsed.bom,
      parsed.group ?? parsed.tree, parsed.group ? 'neorion' : key, parsed.group ? entry : { neorion: entry }, inline);
    state.configs[target] = {
      createdFile: previous?.createdFile ?? original === null, insertion: edit?.insertion, entry: implicitStdio ? current : entry,
      hadGroup: previous?.hadGroup ?? !!parsed.group, hadNeorion: !!parsed.entry,
      createdDirectory: previous?.createdDirectory ?? !exists(path.dirname(file))
    };
    if (edit) changes.push({ file, content: edit.written + (original === null ? '\n' : '') });
    updated.add(target);
  }

  const source = cursorSetup?.legacyLocalEntry ?? bundleSource;
  if (connect && (bundled && targets.length || installCursorBundle)) {
    const graphBundle = checked(cache, graphBundlePath);
    const update = (source: string, file: string, owned: string | undefined) => {
      const content = fs.readFileSync(source);
      const next = hash(content);
      const previous = exists(file) ? hash(fs.readFileSync(file)) : undefined;
      if (previous && previous !== owned && previous !== next) {
        throw new Error(`Neorion MCP bundle conflicts with an existing file at ${path.relative(cache, file)}`);
      }
      if (previous !== next) changes.unshift({ file, content });
      return previous === next ? owned : next;
    };
    const serverHash = update(source, bundle, state.bundle?.hash);
    const graphHash = update(path.join(path.dirname(source), 'graph.cjs'), graphBundle, state.bundle?.graphHash);
    if (serverHash || graphHash) {
      state.bundle = {
        hash: serverHash, graphHash, createdDirectory: state.bundle?.createdDirectory ?? !exists(path.dirname(bundle))
      };
    }
  } else if (!connect && state.bundle) {
    if (exists(bundle) && hash(fs.readFileSync(bundle)) === state.bundle.hash) changes.push({ file: bundle, content: null });
    if (state.bundle.graphHash) {
      const graphBundle = checked(cache, graphBundlePath);
      if (exists(graphBundle) && hash(fs.readFileSync(graphBundle)) === state.bundle.graphHash) {
        changes.push({ file: graphBundle, content: null });
      }
    }
    if (state.bundle.createdDirectory) directories.add(path.dirname(bundle));
    delete state.bundle;
  }

  if (state.legacyBundle && !Object.values(state.configs).some(({ entry, hadNeorion }) =>
    hadNeorion || entry.args?.[0]?.endsWith(BUNDLE) && entry.args[0] !== bundle)) {
    const oldBundle = checked(root, BUNDLE);
    // Only retire a bundle that is still owned by this registration.
    if (!preserveLegacyBundle && exists(oldBundle) && hash(fs.readFileSync(oldBundle)) === state.legacyBundle.hash) {
      changes.push({ file: oldBundle, content: null });
      if (state.legacyBundle.createdDirectory) directories.add(path.dirname(oldBundle));
    }
    delete state.legacyBundle;
  }
  const nextState = Object.keys(state.configs).length || state.bundle || state.legacyBundle ? json(state) + '\n' : null;
  if (originalState !== nextState) changes.push({ file: stateFile, content: nextState });
  if (legacyState !== null && legacyStateFile) changes.push({ file: legacyStateFile, content: null });
  return {
    count: updated.size,
    configured: Object.keys(state.configs).length > 0,
    commit(finalize?: () => void) {
      const undo: Change[] = [];
      const created = new Set<string>();
      try {
        for (const { file, content } of changes) {
          undo.push({ file, content: exists(file) ? fs.readFileSync(file) : null });
          if (content === null) fs.rmSync(file, { force: true });
          else {
            const first = fs.mkdirSync(path.dirname(file), { recursive: true });
            if (first) for (let dir = path.dirname(file); dir !== path.dirname(first); dir = path.dirname(dir)) created.add(dir);
            fs.writeFileSync(file, content);
          }
        }
        finalize?.();
      } catch (error) {
        for (const { file, content } of undo.reverse()) {
          if (content === null) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, content);
        }
        for (const dir of created) removeEmpty(dir);
        throw error;
      }
      for (const dir of directories) removeEmpty(dir);
    }
  };
}

function removeEmpty(directory: string) {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}
