import * as fs from 'fs';
import * as path from 'path';
import { workspaceCache } from './WorkspaceCache';

export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/neorion.mdc'];
export const CLAUDE_HINT = 'For architecture questions (who renders/wraps/calls/imports X, rename impact), use the neorion_query tool first and trust its result; only open files to confirm specifics.';
const START = '<!-- neorion:start -->';
const END = '<!-- neorion:end -->';
const STATE = /^<!-- neorion:state (\{.*\}|[\w+/=]+) -->\r?$/m;
const FRONTMATTER = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;
const ALWAYS_APPLY = /^alwaysApply:[^\r\n]*/m;

interface BlockState {
  created?: boolean;
  header?: boolean;
  createdRulesDirectory?: boolean;
  previousSetting?: string;
  headerEof?: boolean;
}

export function updateAgentFiles(root: string, graphRoot: string, targets: string[], connect: boolean, mcp = false, instruction?: string) {
  const changes: { file: string; content: string; remove: boolean; removeRulesDirectory: boolean }[] = [];
  for (const target of targets) {
    if (!AGENT_FILES.includes(target)) throw new Error('Unknown AI instruction file');
    const file = path.join(root, target);
    for (let entry = file; entry !== root; entry = path.dirname(entry)) {
      if (fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`AI instruction path is a symbolic link: ${target}`);
      }
    }
    const exists = fs.existsSync(file);
    if (!exists && !connect) continue;
    const original = exists ? fs.readFileSync(file, 'utf8') : '';
    const nl = original.includes('\r\n') ? '\r\n' : '\n';
    const header = ['---', 'description: Neorion architecture map', 'alwaysApply: true', '---', ''].join(nl);
    const start = original.indexOf(START);
    const end = original.indexOf(END);
    if ((start >= 0 || end >= 0) && (start < 0 || end < start ||
        original.indexOf(START, start + START.length) >= 0 || original.indexOf(END, end + END.length) >= 0)) {
      throw new Error(`Invalid Neorion markers in ${target}`);
    }
    if (start < 0 && !connect) continue;
    const after = end + END.length;
    const encoded = start >= 0 ? STATE.exec(original.slice(start, end))?.[1] : undefined;
    const state: BlockState = encoded
      ? JSON.parse(encoded.startsWith('{') ? encoded : Buffer.from(encoded, 'base64').toString('utf8')) : {};
    if (!exists) state.created = true;
    let content = start < 0 ? original :
      original.slice(0, start) + original.slice(after + (original.startsWith(nl, after) ? nl.length : 0));
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
    const cursor = target.endsWith('.mdc');

    if (connect) {
      if (cursor) {
        if (!fs.existsSync(path.dirname(file))) state.createdRulesDirectory = true;
        const frontmatter = FRONTMATTER.exec(content)?.[0];
        if (!frontmatter) {
          state.header = true;
          content = bom + header + content.slice(bom.length);
        } else {
          const setting = ALWAYS_APPLY.exec(frontmatter);
          if (!/^alwaysApply:[ \t]*true(?:[ \t]+#.*)?[ \t]*$/.test(setting?.[0] ?? '')) {
            state.previousSetting ??= setting?.[0] ?? '';
            const offset = setting?.index ?? frontmatter.indexOf(nl) + nl.length;
            content = content.slice(0, offset) + 'alwaysApply: true' +
              (setting ? content.slice(offset + setting[0].length) : nl + content.slice(offset));
          }
        }
      }
      const frontmatter = FRONTMATTER.exec(content)?.[0];
      const offset = frontmatter?.length ?? bom.length;
      const separator = frontmatter && !frontmatter.endsWith(nl) ? nl : '';
      if (separator) state.headerEof = true;
      const block = [
        START,
        instruction ?? (mcp ? 'Use neorion_query for rendering, wrappers, rename impact, API consumers, and symbol or route search.' :
          `For architecture questions, read the Neorion overview at \`${path.join(workspaceCache(graphRoot), 'codebase_graph.md')}\`.`),
        ...(Object.keys(state).length ? [
          `<!-- neorion:state ${JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`
        ] : []),
        END,
        ''
      ].join(nl);
      content = content.slice(0, offset) + separator + block + content.slice(offset);
    } else {
      if (cursor && state.header && content.startsWith(bom + header)) {
        content = bom + content.slice(bom.length + header.length);
      } else if (cursor && typeof state.previousSetting === 'string') {
        const frontmatter = FRONTMATTER.exec(content)?.[0];
        const setting = frontmatter && ALWAYS_APPLY.exec(frontmatter);
        if (setting && setting[0] === 'alwaysApply: true') {
          const end = setting.index + setting[0].length;
          content = content.slice(0, setting.index) + state.previousSetting +
            content.slice(end + (state.previousSetting === '' && content.startsWith(nl, end) ? nl.length : 0));
        }
      }
      if (state.headerEof && FRONTMATTER.exec(content)?.[0] === content && content.endsWith(nl)) {
        content = content.slice(0, -nl.length);
      }
    }
    if (content !== original) changes.push({
      file, content, remove: !connect && !!state.created && !content,
      removeRulesDirectory: cursor && !!state.createdRulesDirectory
    });
  }
  for (const { file, content, remove, removeRulesDirectory } of changes) {
    if (remove) {
      fs.unlinkSync(file);
      if (removeRulesDirectory) {
        try {
          fs.rmdirSync(path.dirname(file));
        } catch (error) {
          if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  return changes.length;
}
