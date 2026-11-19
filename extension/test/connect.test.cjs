const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { register } = require('./run.cjs');

const REGISTER = 'Register Neorion query tools (MCP)';
const COPY = 'Other tools: copy configuration snippet';
const files = { 'Claude Code': '.mcp.json', Cursor: '.cursor/mcp.json', 'VS Code (Copilot agent)': '.vscode/mcp.json' };
const original = '{\r\n\t"mcpServers" : { "other" : {"command":"keep"} },\r\n\t"notes" : [1, 2]\r\n}\r\n';
const key = target => target === 'VS Code (Copilot agent)' ? 'servers' : 'mcpServers';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-connect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = name => path.join(root, name);
  const read = name => fs.readFileSync(file(name), 'utf8');
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), value);
  };
  const selections = { instructions: ['CLAUDE.md', REGISTER], targets: Object.keys(files), mode: 'Use pinned npm package' };
  let snippet;
  const messages = [];
  const { commands } = register(root, undefined, [], {
    clipboard: text => { snippet = text; },
    window: {
      showInformationMessage(message) { messages.push(message); },
      async showQuickPick(items, options) {
        if (typeof items[0] === 'string') {
          return options.placeHolder.includes('global') ? selections.format : selections.mode;
        }
        assert.equal(items.find(item => item.label === REGISTER)?.picked ?? false, false);
        const chosen = items.find(item => item.label === REGISTER) ? selections.instructions : selections.targets;
        return items.filter(item => chosen.includes(item.label));
      }
    }
  });
  return { file, read, write, selections, messages, snippet: () => snippet,
    connect: () => commands.get('neo.connectAITools')(), disconnect: () => commands.get('neo.disconnectAITools')() };
}

test('R1 and R6 opt-in is off, legacy instructions persist, and global configurations are clipboard-only', async t => {
  const env = setup(t);
  env.selections.instructions = ['CLAUDE.md', COPY];
  for (const format of ['Codex CLI', 'Windsurf', 'Gemini CLI']) {
    env.selections.format = format;
    await env.connect();
    const snippet = env.snippet();
    if (format === 'Codex CLI') assert.match(snippet, /^\[mcp_servers\.neorion\]/);
    else assert.equal(JSON.parse(snippet).mcpServers.neorion.command, 'npx');
    assert.match(snippet, /neorion-mcp@0.4.0/);
  }
  assert.match(env.read('CLAUDE.md'), /read .*codebase_graph\.md.*first/);
  for (const file of Object.values(files)) assert.ok(!fs.existsSync(env.file(file)));
  assert.ok(!fs.existsSync(env.file('.neorion/connect-state.json')));
});

test('R2, R3, R5 and R6 merge byte-preservingly, match client formats, and reverse registration', async t => {
  const env = setup(t);
  env.write('.mcp.json', original);
  await env.connect();
  const edited = env.read('.mcp.json');
  assert.equal(edited.replace(/,\r\n\s+"neorion": \{[\s\S]*?\r\n\s*\}/, ''), original);
  for (const [target, file] of Object.entries(files)) {
    const entry = JSON.parse(env.read(file))[key(target)].neorion;
    assert.equal(entry.command, 'npx');
    assert.deepEqual(entry.args, ['-y', 'neorion-mcp@0.4.0', '--root', target === 'Claude Code' ? '.' : '${workspaceFolder}']);
    assert.equal(entry.type, target === 'Cursor' ? undefined : 'stdio');
  }
  assert.match(env.read('CLAUDE.md'), /call the neorion_\* tools first/);
  assert.doesNotMatch(env.read('CLAUDE.md'), /read .*codebase_graph\.md.*first/);
  assert.ok(env.messages.some(message => message.includes('Claude Code asks for approval')));
  await env.connect();
  await env.disconnect();
  await env.disconnect();
  assert.equal(env.read('.mcp.json'), original);
  for (const file of ['.cursor', '.vscode', 'CLAUDE.md', '.neorion/connect-state.json']) assert.ok(!fs.existsSync(env.file(file)), file);
});

test('R3 preserves user edits and existing matching servers, and reverses bundled installation', async t => {
  const env = setup(t);
  const matching = '{"mcpServers":{"neorion":{"type":"stdio","command":"npx","args":["-y","neorion-mcp@0.4.0","--root","."]}}}';
  env.write('.mcp.json', matching);
  env.selections.targets = ['Claude Code'];
  await env.connect();
  await env.disconnect();
  assert.equal(env.read('.mcp.json'), matching);
  env.selections.targets = ['VS Code (Copilot agent)'];
  env.selections.mode = 'Use bundled server';
  const jsonc = '{\n  // keep\n  "servers": { "other": {"command":"foo"}, },\n}\n';
  env.write('.vscode/mcp.json', jsonc);
  await env.connect();
  assert.match(env.read('.vscode/mcp.json'), /"command": "node"/);
  assert.match(env.read('.vscode/mcp.json'), /\.neorion\/mcp\/server.cjs/);
  assert.deepEqual(fs.readFileSync(env.file('.neorion/mcp/server.cjs')), fs.readFileSync(path.join(__dirname, '../out/mcp.cjs')));
  await env.disconnect();
  assert.equal(env.read('.vscode/mcp.json'), jsonc);
  assert.ok(!fs.existsSync(env.file('.neorion/mcp')));
  await env.connect();
  env.write('.vscode/mcp.json', env.read('.vscode/mcp.json').replace('"foo"', '"edited"'));
  await env.disconnect();
  assert.match(env.read('.vscode/mcp.json'), /"edited"/);
  assert.match(env.read('.vscode/mcp.json'), /\/\/ keep/);
  assert.doesNotMatch(env.read('.vscode/mcp.json'), /neorion/);
});

test('R4 rejects conflicts, malformed files, JSONC for strict clients, and symlinks without partial writes', async t => {
  const env = setup(t);
  for (const original of ['{broken', '{// comment\n}', '{"mcpServers":{"neorion":{"command":"unrelated"}}}']) {
    env.write('.mcp.json', original);
    await assert.rejects(env.connect(), /Invalid MCP configuration|conflicts/);
    assert.equal(env.read('.mcp.json'), original);
    assert.ok(!fs.existsSync(env.file('CLAUDE.md')));
    assert.ok(!fs.existsSync(env.file('.cursor/mcp.json')));
  }
  env.write('.mcp.json', '{}');
  fs.symlinkSync(env.file('.mcp.json'), env.file('.vscode'), 'dir');
  await assert.rejects(env.connect(), /symbolic link/);
  assert.equal(env.read('.mcp.json'), '{}');
  assert.ok(!fs.existsSync(env.file('CLAUDE.md')));
});
