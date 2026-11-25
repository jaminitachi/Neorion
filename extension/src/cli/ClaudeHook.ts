import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type ParseError } from 'jsonc-parser';
import { workspaceCache } from '../core/WorkspaceCache';
import { INDEX_PATH, LEGACY_INDEX_PATH } from '../mcp/Index';
import { isEntry } from './AgentMcp';
import { read } from './SetupFiles';

const matcher = 'Grep|Glob';
const marker = 'neorion-query-advisory';
const settingsPath = '.claude/settings.json';

// Serialized into the command hook so it works with Node alone, even after an npx install expires.
function runAdvisory(cacheFor: typeof workspaceCache, indexPath: string, legacyPath: string) {
  const { statSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path') as typeof import('node:path');
  const stat = (file: string) => statSync(file, { throwIfNoEntry: false });
  const stdin = process.stdin;
  let input = '';
  const timer = setTimeout(() => stdin.destroy(), 40);
  stdin.setEncoding('utf8').on('data', chunk => {
    input += chunk;
    if (input.length > 16_384) stdin.destroy();
  }).on('close', () => clearTimeout(timer)).on('error', () => clearTimeout(timer)).on('end', () => {
    clearTimeout(timer);
    if (input.length > 16_384) return;
    try {
      const { cwd, hook_event_name, tool_name, tool_input } = JSON.parse(input);
      if (hook_event_name !== 'PreToolUse' || (tool_name !== 'Grep' && tool_name !== 'Glob') ||
          typeof cwd !== 'string' || !isAbsolute(cwd) || typeof tool_input?.pattern !== 'string') return;

      const pattern = tool_input.pattern.trim();
      if (pattern.length > 160) return;
      let target = pattern;
      let routeHandler = false;
      if (tool_name === 'Grep') {
        target = target.replace(/^(?:\^|\\b)|(?:\$|\\b)$/g, '');
      } else if (!target.startsWith('/')) {
        const stem = target.replace(/^(?:\.\/|\*\*\/)/, '')
          .replace(/\.(?:[jt]sx?|\{(?:[jt]sx?,)*[jt]sx?\})$/, '');
        const appFile = /^(?:src\/)?app\/(?:(.+)\/)?(page|route)$/.exec(stem);
        const pagesFile = /^(?:src\/)?pages\/(?!_)(.+)$/.exec(stem);
        if (appFile) {
          target = '/' + (appFile[1] ?? '');
          routeHandler = appFile[2] === 'route';
        } else if (pagesFile) {
          target = '/' + pagesFile[1].replace(/(?:^|\/)index$/, '');
        } else {
          target = stem.split('/').pop()!.replace(/^\*+|\*+$/g, '');
        }
      }
      const route = /^\/[\w.[\]/-]*$/.test(target) && !target.includes('//');
      const symbol = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(target);
      const kind = route ? (routeHandler || /^\/api(?:\/|$)/.test(target) ? 'api_consumers' : 'wrappers') :
        symbol && /^[A-Z]/.test(target) && /[a-z]/.test(target) ? 'who_renders' :
        symbol && (/[a-z][A-Z]|_/.test(target) || (target !== pattern && tool_name === 'Grep')) ? 'search' : undefined;
      if (!kind) return;

      const searchPath = typeof tool_input.path === 'string' ? resolve(cwd, tool_input.path) : cwd;
      const fromCwd = relative(cwd, searchPath);
      let directory = fromCwd === '..' || fromCwd.startsWith('..' + sep) || isAbsolute(fromCwd) ? cwd : searchPath;
      if (!stat(directory)?.isDirectory()) directory = dirname(directory);
      for (let depth = 0; depth < 8; depth++) {
        if (stat(directory)?.isDirectory()) {
          const cache = cacheFor(directory);
          if ([join(cache, indexPath), join(cache, legacyPath), join(directory, legacyPath)]
            .some(file => stat(file)?.isFile())) {
            const manifest = join(directory, 'package.json');
            const size = stat(manifest);
            if (size?.isFile() && size.size <= 65_536) {
              const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
              if (typeof pkg?.dependencies?.next === 'string' || typeof pkg?.devDependencies?.next === 'string') {
                const argument = route ? '"' + target + '"' : target;
                const additionalContext = 'Neorion index available. Try `neorion query ' + kind + ' ' + argument + '`.';
                process.stdout.on('error', () => {});
                process.stdout.write(JSON.stringify({ hookSpecificOutput: {
                  hookEventName: 'PreToolUse', additionalContext
                } }) + '\n');
                return;
              }
            }
          }
        }
        const parent = dirname(directory);
        if (parent === directory) return;
        directory = parent;
      }
    } catch {
      // Advisory only. Unreadable input and inaccessible projects are silent.
    }
  });
}

function ownsHook(value: unknown) {
  return isEntry(value) && value.type === 'command' && value.command === 'node' &&
    Array.isArray(value.args) && value.args[0] === '-e' && value.args[2] === '--' && value.args[3] === marker;
}

export function updateClaudeHook(root: string, install: boolean) {
  const file = join(root, settingsPath);
  for (const path of [dirname(file), file]) {
    if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Claude settings path is a symbolic link: ${path}`);
    }
  }
  const original = read(file)?.toString('utf8');
  if (!install && original === undefined) return;
  const bom = original?.startsWith('\uFEFF') ? '\uFEFF' : '';
  let source = original?.slice(bom.length) ?? '{}\n';
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true });
  const hooks = tree && findNodeAtLocation(tree, ['hooks']);
  const events = hooks && findNodeAtLocation(hooks, ['PreToolUse']);
  if (errors.length || tree?.type !== 'object' || (hooks && hooks.type !== 'object') ||
      (events && events.type !== 'array')) {
    throw new Error(`Invalid Claude hook configuration in ${file}`);
  }
  const eventPath = ['hooks', 'PreToolUse'];
  const groups: unknown[] = events ? getNodeValue(events) : [];
  const edit = (path: (string | number)[], value: unknown, insertion = false) => {
    source = applyEdits(source, modify(source, [...eventPath, ...path], value, {
      isArrayInsertion: insertion,
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' }
    }));
  };

  const command = install ? {
    type: 'command',
    command: 'node',
    args: ['-e', `(${runAdvisory.toString()})(${workspaceCache.toString()}, ${JSON.stringify(INDEX_PATH)}, ${JSON.stringify(LEGACY_INDEX_PATH)})`,
      '--', marker],
    timeout: 1,
    onFailure: 'continue'
  } : undefined;
  let installed = false;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (!isEntry(group) || !Array.isArray(group.hooks)) continue;
    const owned = group.hooks.map((hook, j) => ownsHook(hook) ? j : -1).filter(j => j !== -1);
    if (!owned.length) continue;
    if ((!command || installed) && owned.length === group.hooks.length &&
        group.matcher === matcher && Object.keys(group).length === 2) {
      edit([i], undefined);
      continue;
    }
    for (const j of owned.reverse()) {
      if (command && !installed && group.matcher === matcher) {
        if (!isDeepStrictEqual(group.hooks[j], command)) edit([i, 'hooks', j], command);
        installed = true;
      } else {
        edit([i, 'hooks', j], undefined);
      }
    }
  }
  if (command && !installed) {
    const group = { matcher, hooks: [command] };
    if (events) edit([-1], group, true);
    else edit([], [group]);
  }
  const content = bom + source;
  if (content === original) return;
  fs.mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.neorion-settings-${randomUUID()}.tmp`);
  try {
    const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode;
    fs.writeFileSync(temporary, content, { flag: 'wx', mode });
    if (read(file)?.toString('utf8') !== original) throw new Error(`Claude settings changed during setup: ${file}. Rerun setup.`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`${file} (Neorion hook ${install ? 'installed' : 'removed'})`);
}
