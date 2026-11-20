const { cachePath } = require('./workspace-cache.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { generate, register } = require('./run.cjs');
const { openMcp } = require('./mcp-helpers.cjs');

const REGISTER = 'Register Neorion query tools (MCP)';
const COPY = 'Other tools: copy configuration snippet';
const files = { 'Claude Code': '.mcp.json', Cursor: '.cursor/mcp.json', 'VS Code (Copilot agent)': '.vscode/mcp.json' };
const original = '{\r\n\t"mcpServers" : { "other" : {"command":"keep"} },\r\n\t"notes" : [1, 2]\r\n}\r\n';
const key = target => target === 'VS Code (Copilot agent)' ? 'servers' : 'mcpServers';
const npmMode = 'Use pinned npm package (requires publishing)';
const bundledMode = 'Use bundled server';
function setup(t, project = '.') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-connect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = name => path.join(root, name);
  const read = name => fs.readFileSync(file(name), 'utf8');
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), value);
  };
  const selections = { instructions: ['CLAUDE.md', REGISTER], targets: Object.keys(files), mode: npmMode };
  let snippet;
  const messages = [];
  const { commands } = register(root, undefined, [file(path.join(project, 'tsconfig.json'))], {
    clipboard: text => { snippet = text; },
    window: {
      showInformationMessage(message) { messages.push(message); },
      async showQuickPick(items, options) {
        if (typeof items[0] === 'string') {
          if (options.placeHolder.includes('global')) return selections.format;
          assert.deepEqual(items, [bundledMode, npmMode]);
          return selections.mode ?? items[0];
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
    const args = [path.resolve(__dirname, '../out/mcp.cjs'), '--root', env.file('.')];
    if (format === 'Codex CLI') {
      assert.equal(snippet, `[mcp_servers.neorion]\ncommand = "node"\nargs = ${JSON.stringify(args)}\n`);
    } else {
      assert.deepEqual(JSON.parse(snippet).mcpServers.neorion, { command: 'node', args });
    }
  }
  assert.match(env.read('CLAUDE.md'), /read the Neorion overview .*codebase_graph\.md/);
  for (const file of Object.values(files)) assert.ok(!fs.existsSync(env.file(file)));
  assert.ok(!fs.existsSync(cachePath(env.file('.'), '.neorion/connect-state.json')));
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
    assert.deepEqual(entry.args, ['-y', 'neorion@0.5.0', 'mcp', '--root', target === 'Claude Code' ? '.' : '${workspaceFolder}']);
    assert.equal(entry.type, target === 'Cursor' ? undefined : 'stdio');
  }
  assert.match(env.read('CLAUDE.md'), /Use neorion_query/);
  assert.doesNotMatch(env.read('CLAUDE.md'), /read the Neorion overview .*codebase_graph\.md/);
  assert.ok(env.messages.some(message => message.includes('Claude Code asks for approval')));
  await env.connect();
  env.selections.mode = bundledMode;
  await env.connect();
  assert.equal(JSON.parse(env.read('.mcp.json')).mcpServers.neorion.command, 'node');
  env.selections.mode = npmMode;
  await env.connect();
  assert.equal(env.read('.mcp.json'), edited);
  await env.disconnect();
  await env.disconnect();
  assert.equal(env.read('.mcp.json'), original);
  for (const file of ['.cursor', '.vscode', 'CLAUDE.md', '.neorion/connect-state.json']) assert.ok(!fs.existsSync(env.file(file)), file);
});

test('R3 preserves user edits and existing matching servers, and reverses bundled installation', async t => {
  const env = setup(t);
  const matching = '{"mcpServers":{"neorion":{"type":"stdio","command":"npx","args":["-y","neorion@0.5.0","mcp","--root","."]}}}';
  env.write('.mcp.json', matching);
  env.selections.targets = ['Claude Code'];
  await env.connect();
  await env.disconnect();
  assert.equal(env.read('.mcp.json'), matching);
  env.selections.targets = ['VS Code (Copilot agent)'];
  env.selections.mode = bundledMode;
  const jsonc = '{\n  // keep\n  "servers": { "other": {"command":"foo"}, },\n}\n';
  env.write('.vscode/mcp.json', jsonc);
  await env.connect();
  assert.match(env.read('.vscode/mcp.json'), /"command": "node"/);

  assert.deepEqual(fs.readFileSync(cachePath(env.file('.'), '.neorion/mcp/server.cjs')), fs.readFileSync(path.join(__dirname, '../out/mcp.cjs')));
  await env.disconnect();
  assert.equal(env.read('.vscode/mcp.json'), jsonc);
  assert.ok(!fs.existsSync(cachePath(env.file('.'), '.neorion/mcp')));
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

test('R5 bundled registration resolves the server and monorepo root for each client', async t => {
  const env = setup(t, 'apps/web');
  env.write('apps/web/tsconfig.json', '{}');
  env.write('apps/web/example.ts', 'export const Example = 1;');
  await generate(env.file('apps/web'));
  env.selections.mode = undefined;
  await env.connect();
  for (const [target, file] of Object.entries(files)) {
    const entry = JSON.parse(env.read(file))[key(target)].neorion;
    const workspace = target === 'Claude Code' ? '.' : '${workspaceFolder}';
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args.slice(2), ['--', workspace, 'apps/web']);
    assert.equal(entry.args[0], '-e');
    assert.ok(!env.read(file).includes(env.file('.')));
    assert.equal(entry.type, target === 'Cursor' ? undefined : 'stdio');
    const args = entry.args.map(arg => arg === '${workspaceFolder}' ? env.file('.') : arg);
    const client = await openMcp(t, env.file('.'), { command: entry.command, args, cwd: env.file('.') });
    assert.match(await client.text('search', { text: 'Example' }), /constant example\.ts:1#Example/);
    assert.equal(client.stderr(), '');
    await client.close();
  }
});

test('Connect migrates a managed workspace bundle and old instructions to the cache', async t => {
  const env = setup(t);
  const { createHash } = require('node:crypto');
  const bundle = 'old server';
  const entry = { command: 'node', args: ['.neorion/mcp/server.cjs', '--root', '.'], type: 'stdio' };
  env.write('.neorion/mcp/server.cjs', bundle);
  env.write('.mcp.json', JSON.stringify({ mcpServers: { neorion: entry } }));
  env.write('.neorion/connect-state.json', JSON.stringify({
    configs: { 'Claude Code': { createdFile: true, entry, hadGroup: false, hadNeorion: false } },
    bundle: { hash: createHash('sha256').update(bundle).digest('hex'), createdDirectory: true }
  }));
  env.write('CLAUDE.md', '<!-- neorion:start -->\nOld hint: confirm by reading the source.\n<!-- neorion:end -->\n');
  env.selections.targets = ['Claude Code'];
  env.selections.mode = bundledMode;
  await env.connect();
  assert.equal(JSON.parse(env.read('.mcp.json')).mcpServers.neorion.args[0], '-e');
  assert.ok(fs.existsSync(cachePath(env.file('.'), '.neorion/mcp/server.cjs')));
  assert.ok(!fs.existsSync(env.file('.neorion/mcp/server.cjs')));
  assert.ok(!fs.existsSync(env.file('.neorion/connect-state.json')));
  assert.match(env.read('CLAUDE.md'), /^<!-- neorion:start -->\nUse neorion_query[^\n]*\n<!-- neorion:end -->\n$/);
  await env.disconnect();
  assert.ok(!fs.existsSync(env.file('.mcp.json')));
});
