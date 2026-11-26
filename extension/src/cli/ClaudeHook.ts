import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, getNodeValue, modify, parseTree, SyntaxKind, type Node, type ParseError } from 'jsonc-parser';
import { workspaceCache } from '../core/WorkspaceCache';
import { INDEX_PATH, LEGACY_INDEX_PATH } from '../mcp/Index';
import { isEntry } from './AgentMcp';
import { errorCode, read } from './SetupFiles';

const matcher = 'Grep|Glob';
const marker = 'neorion-query-advisory';
const createdSettings = 'created-settings';
const createdDirectory = 'created-directory';
const createdHooks = 'created-hooks';
const createdArray = 'created-array';
const inlineTail = 'inline-array-tail:';
const inlineHooksTail = 'inline-hooks-tail:';
const settingsPath = '.claude/settings.json';
const eventPath = ['hooks', 'PreToolUse'];

// Serialized into the command hook so it works with Node alone, even after an npx install expires.
function runAdvisory(cacheFor: typeof workspaceCache, indexPath: string, legacyPath: string) {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const { lstatSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } =
    require('node:fs') as typeof import('node:fs');
  const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path') as typeof import('node:path');
  const stat = (file: string) => statSync(file, { throwIfNoEntry: false });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const firstHint = (cache: string, sessionId: unknown, target: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return true;
    const sessions = join(cache, 'claude-advisory');
    const session = join(sessions, hash(sessionId));
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    if (!lstatSync(sessions).isDirectory()) return false;
    try {
      mkdirSync(session, { mode: 0o700 });
      const expired = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const entry of readdirSync(sessions, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const directory = join(sessions, entry.name);
        const info = lstatSync(directory, { throwIfNoEntry: false });
        if (info?.isDirectory() && info.mtimeMs < expired) rmSync(directory, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!lstatSync(session).isDirectory()) return false;
    try {
      writeFileSync(join(session, hash(target)), '', { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return false;
    }
  };
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
      const { cwd, hook_event_name, session_id, tool_name, tool_input } = JSON.parse(input);
      if (hook_event_name !== 'PreToolUse' || (tool_name !== 'Grep' && tool_name !== 'Glob') ||
          typeof cwd !== 'string' || !isAbsolute(cwd) || typeof tool_input?.pattern !== 'string') return;

      const pattern = tool_input.pattern.trim();
      if (pattern.length > 160) return;
      let target = pattern;
      let routeHandler = false;
      if (tool_name === 'Grep') {
        target = target.replace(/^(?:\^|\\b)|(?:\$|\\b)$/g, '');
        if (/^use[A-Z]/.test(target)) return;
      } else if (!target.startsWith('/')) {
        const stem = target.replace(/^(?:\.\/|\*\*\/)/, '')
          .replace(/\.(?:[jt]sx?|\{(?:[jt]sx?,)*[jt]sx?\})$/, '');
        const appFile = /^(?:src\/)?app\/(?:(.+)\/)?(page|route)$/.exec(stem);
        const pagesFile = /^(?:src\/)?pages\/(?!_)(.+)$/.exec(stem);
        if (appFile) {
          target = '/' + (appFile[1] ?? '').split('/').filter(part => !/^\([^()]+\)$/.test(part)).join('/');
          routeHandler = appFile[2] === 'route';
        } else if (pagesFile) {
          target = '/' + pagesFile[1].replace(/(?:^|\/)index$/, '');
        } else {
          target = stem.split('/').pop()!.replace(/^\*+|\*+$/g, '');
        }
      }
      const route = /^\/[\w.[\]/-]*$/.test(target) && !target.includes('//');
      const symbol = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(target);
      if (symbol && (/^(?:on[A-Z]\w*|className|dangerouslySetInnerHTML|htmlFor|tabIndex|autoFocus|suppressHydrationWarning)$/.test(target) ||
          /^(?:getInitialProps|getServerSideProps|getStaticPaths|getStaticProps|generateMetadata|generateStaticParams|generateViewport|generateImageMetadata|generateSitemaps|fetchCache|dynamicParams|preferredRegion|maxDuration)$/.test(target) ||
          /^(?:NextRequest|NextResponse|NextApiRequest|NextApiResponse|NextPage|NextConfig|Metadata|ResolvingMetadata|Viewport|ImageResponse)$/.test(target) ||
          /^(?:CoreMessage|ModelMessage|UIMessage|UIMessageChunk|LanguageModel|LanguageModelUsage)$/.test(target) ||
          /^[A-Z]\w*(?:Props|Type|Kind)$/.test(target))) return;
      const kind = route ? (routeHandler || /^\/api(?:\/|$)/.test(target) ? 'api_consumers' : 'wrappers') :
        symbol && /^[A-Z]/.test(target) && /[a-z]/.test(target)
          ? (/^(?:Error|Promise|React|Props)$/.test(target) ? undefined : target.endsWith('Error') ? 'search' : 'who_renders')
          : symbol && /[a-z][A-Z]|_/.test(target) ? 'search' : undefined;
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
                if (!firstHint(cache, session_id, target)) return;
                const additionalContext = 'Neorion index available. Try the `neorion_query` tool (kind `' + kind +
                  '`, target `' + target + '`).';
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

function ownsHook(value: unknown): value is { args: unknown[] } {
  return isEntry(value) && value.type === 'command' && value.command === 'node' &&
    Array.isArray(value.args) && value.args[0] === '-e' && value.args[2] === '--' && value.args[3] === marker;
}

export function updateClaudeHook(root: string, install: boolean) {
  try {
    editClaudeSettings(root, install);
  } catch (error) {
    if (install) console.warn(`Skipping Neorion Claude hook: ${(error as Error).message}`);
  }
}

function hasComments(source: string) {
  const scanner = createScanner(source);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) return true;
  }
  return false;
}

const lineIndent = (source: string, offset: number) =>
  /^[\t ]*/.exec(source.slice(source.lastIndexOf('\n', offset - 1) + 1))![0];
const indentUnit = (indent: string) => indent.includes('\t') ? '\t' : '  ';
const lineEnding = (source: string) => source.includes('\r\n') ? '\r\n' : '\n';
const singleLine = (source: string) => !/[\r\n]/.test(source.trimEnd());
const closingLine = (tail: string) => /(\r?\n)([\t ]*)$/.exec(tail);
const afterLastGroup = (array: Node, last = array.children?.at(-1)) =>
  last ? last.offset + last.length : array.offset + 1;
const renderJson = (value: unknown, unit: string, eol: string, indent: string) =>
  JSON.stringify(value, null, unit).replace(/\n/g, eol + indent);

function expandInlineTail(tail: string, hasPrevious: boolean, rendered: string, eol: string, closingIndent: string) {
  const indent = closingIndent + indentUnit(closingIndent);
  const scanner = createScanner(tail, true);
  const trailing = scanner.scan() === SyntaxKind.CommaToken;
  const comma = scanner.getTokenOffset();
  const trivia = (trailing ? tail.slice(0, comma) + tail.slice(comma + 1) : tail).trim();
  return (hasPrevious ? ',' : '') + eol + indent + rendered + (trailing ? ',' : '') +
    (trivia ? eol + indent + trivia : '') + eol + closingIndent;
}

function appendGroup(source: string, array: Node, group: unknown) {
  const last = array.children?.at(-1);
  const end = array.offset + array.length - 1;
  const afterLast = afterLastGroup(array, last);
  if (singleLine(source)) {
    const insertion = (last ? ',' : '') + JSON.stringify(group);
    return source.slice(0, afterLast) + insertion + source.slice(afterLast);
  }

  const tail = source.slice(afterLast, end);
  const closing = closingLine(tail);
  const eol = closing?.[1] ?? lineEnding(source);
  const closingIndent = closing?.[2] ?? lineIndent(source, array.offset);
  const unit = indentUnit(closingIndent);
  if (!closing) {
    const rendered = renderJson(group, unit, eol, closingIndent + unit);
    return source.slice(0, afterLast) + expandInlineTail(tail, !!last, rendered, eol, closingIndent) + source.slice(end);
  }
  const scanner = createScanner(source, true);
  scanner.setPosition(afterLast);
  const trailingComma = !!last && scanner.scan() === SyntaxKind.CommaToken;
  const lastIndent = last && lineIndent(source, last.offset);
  const indent = lastIndent && lastIndent.length > closingIndent.length
    ? lastIndent : closingIndent + unit;
  const rendered = renderJson(group, indent.slice(closingIndent.length), eol, indent);
  return applyEdits(source, [
    { offset: end - closingIndent.length, length: 0, content: indent + rendered + (trailingComma ? ',' : '') + eol },
    ...(last && !trailingComma ? [{ offset: afterLast, length: 0, content: ',' }] : [])
  ]);
}

function restoreInlineTail(source: string, node: Node, tail: string) {
  const container = node.parent!;
  if (container.children?.at(-1) !== node) return;
  const previous = container.children.at(-2);
  const start = previous ? previous.offset + previous.length : container.offset + 1;
  const end = container.offset + container.length - 1;
  const rendered = source.slice(node.offset, node.offset + node.length);
  const expected = expandInlineTail(tail, !!previous, rendered, lineEnding(source), lineIndent(source, container.offset));
  // Preserve the current trivia if the user edited the generated layout.
  if (source.slice(start, end) !== expected) return;
  const restored = source.slice(0, start) + tail + source.slice(end);
  const errors: ParseError[] = [];
  parseTree(restored, errors, { allowTrailingComma: true });
  if (!errors.length) return restored;
}

function removeSetting(source: string, path: (string | number)[], wholeGroup = false) {
  const node = findNodeAtLocation(parseTree(source)!, path)!;
  const item = node.parent?.type === 'property' ? node.parent : node;
  const siblings = item.parent?.children ?? [];
  const previous = siblings[siblings.indexOf(item) - 1];
  const scanner = createScanner(source, true);
  const end = item.offset + item.length;
  if (wholeGroup && previous && /^,[\t ]*$/.test(source.slice(previous.offset + previous.length, item.offset)) &&
      siblings.at(-1) === item) {
    return source.slice(0, previous.offset + previous.length) + source.slice(end);
  }
  // Remove the node and the adjacent comma separately so JSONC trivia survives.
  const edits = [{ offset: item.offset, length: item.length, content: '' }];
  scanner.setPosition(end);
  let token = scanner.scan();
  if (wholeGroup) {
    const lineStart = source.lastIndexOf('\n', item.offset - 1) + 1;
    const suffix = /^[\t ]*,?[\t ]*\r?\n/.exec(source.slice(end));
    if (suffix && /^[\t ]*$/.test(source.slice(lineStart, item.offset))) {
      edits[0] = { offset: lineStart, length: end + suffix[0].length - lineStart, content: '' };
      if (token === SyntaxKind.CommaToken && suffix[0].includes(',')) return applyEdits(source, edits);
    }
  }
  if (token !== SyntaxKind.CommaToken && previous) {
    scanner.setPosition(previous.offset + previous.length);
    token = scanner.scan();
  }
  if (token === SyntaxKind.CommaToken) {
    edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: '' });
  }
  return applyEdits(source, edits);
}

function removeEmptyClaudeDirectory(directory: string) {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
  }
}

function editClaudeSettings(root: string, install: boolean) {
  const file = join(root, settingsPath);
  const directory = dirname(file);
  for (const path of [directory, file]) {
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
  const groups: unknown[] = events ? getNodeValue(events) : [];
  const ownedHooks = groups.flatMap(group => isEntry(group) && Array.isArray(group.hooks)
    ? group.hooks.filter(ownsHook) : []);
  const hasMarker = (marker: string) => ownedHooks.some(hook => hook.args.slice(4).includes(marker));
  // Older setup used the Props/Type-only exclusion and did not record container ownership.
  const legacyGroup = groups[0];
  const legacyContainers = groups.length === 1 && ownedHooks.length === 1 &&
    typeof ownedHooks[0].args[1] === 'string' && ownedHooks[0].args[1].includes('(?:Props|Type)$') &&
    isEntry(legacyGroup) && legacyGroup.matcher === matcher && Object.keys(legacyGroup).length === 2 &&
    Array.isArray(legacyGroup.hooks) && legacyGroup.hooks.length === 1;
  const created = original === undefined || hasMarker(createdSettings);
  const madeDirectory = install && fs.mkdirSync(directory, { recursive: true }) !== undefined;
  const ownsDirectory = madeDirectory || hasMarker(createdDirectory);
  const ownsHooks = !hooks || hasMarker(createdHooks) || created || legacyContainers && hooks.children?.length === 1;
  const ownsArray = !events || hasMarker(createdArray) || created || legacyContainers;
  const recordedTails = (args: unknown[]) => args.slice(4).filter((arg): arg is string =>
    typeof arg === 'string' && (arg.startsWith(inlineTail) || arg.startsWith(inlineHooksTail)));
  const jsonc = hasComments(source);
  const edit = (path: (string | number)[], value: unknown) => {
    if (value === undefined && jsonc) {
      source = removeSetting(source, path);
      return;
    }
    const options = original !== undefined && singleLine(source) ? {} :
      { formattingOptions: { insertSpaces: true, tabSize: 2, eol: lineEnding(source) } };
    source = applyEdits(source, modify(source, path, value, options));
  };

  const flags = [
    ...(created ? [createdSettings] : []), ...(ownsDirectory ? [createdDirectory] : []),
    ...(ownsHooks ? [createdHooks] : []), ...(ownsArray ? [createdArray] : [])
  ];
  const command = install ? {
    type: 'command',
    command: 'node',
    args: ['-e', `(${runAdvisory.toString()})(${workspaceCache.toString()}, ${JSON.stringify(INDEX_PATH)}, ${JSON.stringify(LEGACY_INDEX_PATH)})`,
      '--', marker, ...flags],
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
      const path = [...eventPath, i];
      const node = findNodeAtLocation(parseTree(source)!, path)!;
      if (!jsonc || !hasComments(source.slice(node.offset, node.offset + node.length))) {
        const hook = group.hooks[0];
        const tails = group.hooks.length === 1 && ownsHook(hook) ? recordedTails(hook.args) : [];
        const objectTail = tails.find(arg => arg.startsWith(inlineHooksTail));
        const events = node.parent!;
        const eventProperty = events.parent!;
        if (!install && objectTail && events.children?.length === 1 && eventProperty.parent?.children?.length === 1 &&
            !hasComments(source.slice(eventProperty.offset, eventProperty.offset + eventProperty.length))) {
          const restored = restoreInlineTail(source, eventProperty, objectTail.slice(inlineHooksTail.length));
          if (restored !== undefined) {
            source = restored;
            continue;
          }
        }
        const tail = tails.find(arg => arg.startsWith(inlineTail));
        source = (tail && restoreInlineTail(source, node, tail.slice(inlineTail.length))) ?? removeSetting(source, path, true);
        continue;
      }
    }
    for (const j of owned.reverse()) {
      if (command && !installed && group.matcher === matcher) {
        // jsonc-parser gives parsed objects a null prototype.
        const current = JSON.parse(JSON.stringify(group.hooks[j]));
        const updated = { ...command, args: [...command.args, ...recordedTails(current.args)] };
        if (!isDeepStrictEqual(current, updated)) edit([...eventPath, i, 'hooks', j], updated);
        installed = true;
      } else {
        edit([...eventPath, i, 'hooks', j], undefined);
      }
    }
  }
  if (command && !installed) {
    const current = parseTree(source)!;
    const array = findNodeAtLocation(current, eventPath);
    if (array && !singleLine(source)) {
      const tail = source.slice(afterLastGroup(array), array.offset + array.length - 1);
      if (!closingLine(tail)) command.args.push(inlineTail + tail);
    }
    const group = { matcher, hooks: [command] };
    const object = findNodeAtLocation(current, ['hooks']);
    const objectTail = object && !object.children?.length && !singleLine(source)
      ? source.slice(object.offset + 1, object.offset + object.length - 1) : undefined;
    if (array) source = appendGroup(source, array, group);
    else if (object && objectTail !== undefined && !closingLine(objectTail)) {
      command.args.push(inlineHooksTail + objectTail);
      const indent = lineIndent(source, object.offset);
      const unit = indentUnit(indent);
      const eol = lineEnding(source);
      const rendered = `"PreToolUse": ${renderJson([group], unit, eol, indent + unit)}`;
      source = source.slice(0, object.offset + 1) + expandInlineTail(objectTail, false, rendered, eol, indent) +
        source.slice(object.offset + object.length - 1);
    } else edit(eventPath, [group]);
  }
  if (!install && bom + source !== original) {
    for (const path of [...(ownsArray ? [eventPath] : []), ...(ownsHooks ? [['hooks']] : [])]) {
      const node = findNodeAtLocation(parseTree(source)!, path);
      if (node && !node.children?.length && !hasComments(source.slice(node.offset, node.offset + node.length))) {
        edit(path, undefined);
      }
    }
  }
  const content = bom + source;
  if (content === original) return;
  const checkUnchanged = () => {
    if (read(file)?.toString('utf8') !== original) throw new Error(`Claude settings changed during setup: ${file}. Rerun setup.`);
  };
  if (!install && created && !parseTree(source)?.children?.length && !hasComments(source)) {
    checkUnchanged();
    fs.unlinkSync(file);
    if (ownsDirectory) removeEmptyClaudeDirectory(directory);
    console.log(`${file} (Neorion hook removed)`);
    return;
  }
  const temporary = join(directory, `.neorion-settings-${randomUUID()}.tmp`);
  let written = false;
  try {
    const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode;
    fs.writeFileSync(temporary, content, { flag: 'wx', mode });
    checkUnchanged();
    fs.renameSync(temporary, file);
    written = true;
  } finally {
    fs.rmSync(temporary, { force: true });
    if (madeDirectory && !written) removeEmptyClaudeDirectory(directory);
  }
  console.log(`${file} (Neorion hook ${install ? 'installed' : 'removed'})`);
}
