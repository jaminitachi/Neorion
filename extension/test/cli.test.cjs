const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openMcp } = require('./mcp-helpers.cjs');
const { mcpCommand } = require('./mcp-command.cjs');

const { name, version } = require('../../neorion/package.json');
const packageRoot = path.resolve(__dirname, '../../neorion');
const entry = path.join(packageRoot, 'dist/neorion.cjs');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace');
  const cache = path.join(temp, 'cache');
  const home = path.join(temp, 'home');
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"include":["app/**/*"],"compilerOptions":{"jsx":"preserve"}}');
  fs.writeFileSync(path.join(root, 'app/page.tsx'), 'function DashboardShell() { return <main />; }\nexport default function Page() { return <DashboardShell />; }\n');
  const env = { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const run = (args, overrides = {}, cliEntry = entry) => spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15_000
  });
  return { root, cache, home, env, run };
}

function fakeAgent(home, agent) {
  const config = path.join(home, agent === 'claude' ? '.claude.json' : '.codex/fake-mcp.json');
  const log = path.join(home, agent + '.log');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(path.join(home, agent), `#!${process.execPath}
const fs = require('node:fs');
const [group, action, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([group, action, ...args]) + '\\n');
const file = ${JSON.stringify(config)};
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { mcpServers: {} };
if (action === 'get') {
  if (!data.mcpServers.neorion) {
    console.error("Error: No MCP server named 'neorion' found.");
    process.exit(1);
  }
  console.log(JSON.stringify(data.mcpServers.neorion));
} else if (action === 'add') {
  if (data.mcpServers.neorion) {
    console.error('Server already exists');
    process.exit(1);
  }
  const [command, ...launchArgs] = args.slice(args.indexOf('--') + 1);
  data.mcpServers.neorion = { type: 'stdio', command, args: launchArgs, env: {} };
  fs.writeFileSync(file, JSON.stringify(data));
} else if (action === 'remove') {
  delete data.mcpServers.neorion;
  fs.writeFileSync(file, JSON.stringify(data));
} else process.exit(2);
`, { mode: 0o755 });
  return {
    config,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').map(JSON.parse) : []
  };
}

function assertQueryHint(hint) {
  const block = hint.split('<!-- neorion:start -->')[1].split('<!-- neorion:end -->')[0];
  const lines = block.trim().split(/\r?\n/).filter(line => !line.startsWith('<!-- neorion:state'));
  assert.ok(lines.length <= 8);
  assert.match(block, /do not grep\. Ask Neorion first with the `neorion_query` tool/);
  for (const example of ['wrappers /settings', 'who_renders DashboardShell', 'rename_impact DashboardShell',
    'api_consumers /api/users', 'search DashboardShell']) assert.ok(block.includes(example), example);
  assert.match(block, /Include this rule in prompts you give subagents/);
  assert.match(block, /\x60# complete\x60 means trust the result/);
  assert.match(block, /\x60# partial: <reason>\x60 means read the reason and verify/);
  assert.match(block, /If MCP is unavailable, run `.+ query <kind> <target>`/);
}

test('CLI, extension, plugin and marketplace versions agree', () => {
  assert.equal(version, readJson(path.join(__dirname, '../package.json')).version);
  assert.equal(version, readJson(path.join(packageRoot, '.claude-plugin/plugin.json')).version);
  const { source } = readJson(path.join(packageRoot, '../.claude-plugin/marketplace.json')).plugins[0];
  assert.equal(source.package, name);
  assert.equal(source.version, version);
  assert.equal(spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).stdout.trim(), version);
});

test('CLI graph and query use the workspace cache', t => {
  const { root, cache, run } = fixture(t);
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  const overview = /^Overview: (.+)$/m.exec(graph.stdout)[1];
  assert.ok(overview.startsWith(path.join(cache, 'neorion') + path.sep));
  assert.ok(fs.existsSync(overview));
  const query = run(['query', 'who_renders', 'DashboardShell', '--limit', '1']);
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /app\/page\.tsx:2/);
  assert.deepEqual(fs.readdirSync(root).sort(), ['app', 'tsconfig.json']);
});

test('wrapper queries include only third-party components on the page chain by default', async t => {
  const { root, env, run } = fixture(t);
  fs.cpSync(path.join(__dirname, 'fixtures/external-wrappers'), root, { recursive: true });
  const query = ['query', 'wrappers', '/'];
  const standard = run(query);
  assert.equal(standard.status, 0, standard.stderr);
  const providers = '# providers (outermost first): SWRConfig (external: swr), SessionProvider (external: next-auth/react), Scope (external: widgets), ContextShell, theme.Provider';
  assert.match(standard.stdout, /^1 app\/layout\.tsx:8 RootLayout, Grid \(external: widgets\), Tabs \(external: @radix-ui\/react-tabs\), widgets\.Root \(external: widgets\), LocalContext, LocalConfig, theme\.Consumer providers:/m);
  assert.ok(standard.stdout.split('\n').includes(providers));
  assert.match(standard.stdout, /^# not wrappers: rendered inside the page$/m);
  assert.match(standard.stdout, /1 file, 1 page/);
  assert.doesNotMatch(standard.stdout, /Link|Icon|PageDecoration|motion\.div/);
  assert.equal(run([...query, '--include-external']).stdout, standard.stdout);

  const hidden = run([...query, '--no-external']);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.match(hidden.stdout, /^1 app\/layout\.tsx:8 RootLayout, LocalContext, LocalConfig, theme\.Consumer providers:/m);
  assert.ok(hidden.stdout.split('\n').includes(providers));
  assert.doesNotMatch(hidden.stdout, /\b(?:Grid|Tabs|widgets\.Root)\b/);

  const client = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
  const args = { kind: 'wrappers', target: '/' };
  assert.equal(await client.text('query', args), standard.stdout.trimEnd());
  assert.equal(await client.text('query', { ...args, includeExternal: false }), hidden.stdout.trimEnd());
});

test('CLI MCP builds a missing index and gives the same answer as query', { timeout: 20_000 }, async t => {
  const { root, env, run } = fixture(t);
  const server = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
  const list = await server.request('tools/list', {});
  assert.deepEqual(list.tools.map(tool => tool.name), ['neorion_query']);
  const args = { kind: 'who_renders', target: 'DashboardShell' };
  const cold = await server.text('query', args);
  assert.match(cold, /app\/page\.tsx:2/);
  assert.equal(await server.text('query', args), cold);
  assert.equal(run(['query', args.kind, args.target]).stdout.trimEnd(), cold);
});

test('CLI MCP rebuilds an index without the wrapper revision', { timeout: 20_000 }, async t => {
  const { root, env, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'app/layout.tsx'),
    'function ShellProvider({children}) { return <main>{children}</main>; }\n' +
    'export default function Layout({children}) { return <ShellProvider>{children}</ShellProvider>; }');
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  const overview = /^Overview: (.+)$/m.exec(graph.stdout)[1];
  const file = path.join(path.dirname(overview), '.neorion/index.v1.json');
  const index = readJson(file);
  const revision = index.wrapperRevision;
  assert.ok(Number.isInteger(revision));
  delete index.wrapperRevision;
  for (const chain of Object.values(index.wrapChains)) {
    for (const wrapper of chain) delete wrapper.provider;
  }
  fs.writeFileSync(file, JSON.stringify(index));

  const server = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '1' }
  });
  const result = await server.text('query', { kind: 'wrappers', target: '/' });
  assert.match(result, / providers: ShellProvider$/m);
  assert.equal(readJson(file).wrapperRevision, revision);
});

test('Codex setup installs the skill and prints config when Codex is unavailable', t => {
  const { home, root, run } = fixture(t);
  const setup = run(['setup', 'codex'], { PATH: home, Path: home });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /\[mcp_servers\.neorion\]/);
  assert.ok(setup.stdout.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(setup.stdout.includes(`args = ${JSON.stringify([entry, 'mcp'])}`));
  assert.equal(fs.readFileSync(path.join(home, '.agents/skills/neorion/SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(packageRoot, 'skills/neorion/SKILL.md'), 'utf8'));
  const agents = path.join(root, 'AGENTS.md');
  const hint = fs.readFileSync(agents, 'utf8');
  assertQueryHint(hint);
  const hintEntry = /\s/.test(entry) ? `"${entry}"` : entry;
  assert.ok(hint.includes(`run \`node ${hintEntry} query <kind> <target>\``));
  assert.match(setup.stdout, /Next: start `codex` in this project/);
  assert.ok(setup.stdout.includes(agents + ' (written)'));
  assert.ok(run(['setup', 'codex'], { PATH: home, Path: home }).stdout.includes(agents + ' (unchanged)'));
  assert.equal(fs.readFileSync(agents, 'utf8'), hint);
});

test('Codex setup uses bare neorion only when PATH resolves to this entry', { skip: process.platform === 'win32' }, t => {
  const { home, root, run } = fixture(t);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const link = path.join(bin, 'neorion');
  fs.symlinkSync(entry, link);
  const earlier = path.join(home, 'neorion');
  fs.symlinkSync(process.execPath, earlier);
  const hint = () => fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const matchingPath = { PATH: bin };
  assert.equal(run(['setup', 'codex'], matchingPath).status, 0);
  assert.ok(hint().includes('run `neorion query'));
  assert.equal(run(['setup', 'codex', '--local'], matchingPath).status, 0);
  assert.ok(hint().includes('run `node '));
  assert.equal(run(['setup', 'codex'], { PATH: [home, bin].join(path.delimiter) }).status, 0);
  assert.ok(hint().includes('run `node '));
});

test('Codex setup writes the hint before failed registration', { skip: process.platform === 'win32' }, t => {
  const { home, root, run } = fixture(t);
  fs.writeFileSync(path.join(home, 'codex'),
    '#!/bin/sh\n[ -f AGENTS.md ] || exit 2\necho "registration failed" >&2\nexit 1\n', { mode: 0o755 });
  const setup = run(['setup', 'codex'], { PATH: home });
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /registration failed/);
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
});

test('Codex setup chooses a temporary npm command or a quoted local entry', t => {
  const { home, root, run } = fixture(t);
  const cachedPackage = path.join(home, 'cache with spaces', '_npx', 'abc', 'node_modules', 'neorion');
  const cachedEntry = path.join(cachedPackage, 'dist/neorion.cjs');
  fs.mkdirSync(path.dirname(cachedEntry), { recursive: true });
  fs.copyFileSync(entry, cachedEntry);
  fs.cpSync(path.join(packageRoot, 'skills'), path.join(cachedPackage, 'skills'), { recursive: true });
  const env = { PATH: home, Path: home };
  const hint = () => fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const cached = run(['setup', 'codex'], env, cachedEntry);
  assert.equal(cached.status, 0, cached.stderr);
  const mcp = mcpCommand();
  assert.ok(cached.stdout.includes(`args = ${JSON.stringify(mcp.args)}`));
  assert.ok(hint().includes(`run \`npx -y ${name}@${version} query`));
  const local = run(['setup', 'codex', '--local'], env, cachedEntry);
  assert.equal(local.status, 0, local.stderr);
  assert.ok(local.stdout.includes(`args = ${JSON.stringify([cachedEntry, 'mcp'])}`));
  assert.ok(hint().includes(`run \`node "${cachedEntry}" query`));
});

test('Claude setup registers at user scope once, installs the skill and reverses only its changes', {
  skip: process.platform === 'win32'
}, t => {
  const { home, root, run } = fixture(t);
  const { config, calls } = fakeAgent(home, 'claude');
  const env = { PATH: home };
  fs.symlinkSync(entry, path.join(home, 'neorion'));
  const other = { mcpServers: { other: { command: 'keep' } }, projects: { '/any': { mcpServers: { neorion: { command: 'local' } } } } };
  fs.writeFileSync(config, JSON.stringify(other));
  const file = path.join(root, 'CLAUDE.md');
  const skill = path.join(home, '.claude/skills/neorion/SKILL.md');
  const original = '\uFEFF# Existing instructions\r\nKeep this text.\r\n';
  fs.writeFileSync(file, original);
  const unsupported = run(['setup', 'claude', '--local'], env);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Unknown option '--local'/);
  const setup = run(['setup', 'claude'], env);
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(setup.stdout.includes(file + ' (written)'));
  assert.ok(setup.stdout.includes(skill));
  assert.ok(setup.stdout.includes(config));
  assert.deepEqual(fs.readFileSync(skill), fs.readFileSync(path.join(packageRoot, 'skills/neorion/SKILL.md')));
  const hint = fs.readFileSync(file, 'utf8');
  assertQueryHint(hint);
  assert.match(hint, /If MCP is unavailable, run `neorion query <kind> <target>`/);
  assert.ok(hint.startsWith('\uFEFF<!-- neorion:start -->\r\n'));
  assert.ok(hint.endsWith('<!-- neorion:end -->\r\n' + original.slice(1)));
  assert.doesNotMatch(hint.replaceAll('\r\n', ''), /\n/);
  assert.ok(run(['setup', 'claude'], env).stdout.includes(file + ' (unchanged)'));
  assert.equal(fs.readFileSync(file, 'utf8'), hint);
  const add = ['mcp', 'add', '--scope', 'user', 'neorion', '--', process.execPath, entry, 'mcp'];
  assert.deepEqual(calls(), [add]);
  assert.deepEqual(readJson(config).mcpServers.neorion.args, [entry, 'mcp']);
  fs.unlinkSync(path.join(root, 'tsconfig.json'));
  for (let i = 0; i < 2; i++) {
    const removed = run(['setup', 'claude', '--remove'], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.ok(!fs.existsSync(skill));
    assert.deepEqual(readJson(config), other);
  }
  assert.deepEqual(calls(), [add, ['mcp', 'remove', '--scope', 'user', 'neorion']]);
});

test('Claude setup protects invalid hint markers and prints an exact fallback if registration fails', t => {
  const { home, root, run } = fixture(t);
  const env = { PATH: home, Path: home };
  const file = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(file, '<!-- neorion:start -->');
  const malformed = run(['setup', 'claude'], env);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid Neorion markers/);
  assert.equal(fs.readFileSync(file, 'utf8'), '<!-- neorion:start -->');
  const config = path.join(home, '.claude.json');
  const original = '{"mcpServers":{"other":{"command":"keep"}}}';
  fs.writeFileSync(config, original);
  for (const hasBinary of process.platform === 'win32' ? [false] : [false, true]) {
    if (hasBinary) fs.writeFileSync(path.join(home, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const fallback = run(['setup', 'claude', '--no-hint'], env);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /^claude mcp add --scope user neorion -- .+ mcp$/m);
    assert.ok(fallback.stdout.includes(process.execPath));
    assert.ok(fallback.stdout.includes(entry));
    assert.equal(fs.readFileSync(config, 'utf8'), original);
  }
});

test('Codex setup and remove preserve unrelated servers and project text', { skip: process.platform === 'win32' }, t => {
  const { home, root, run } = fixture(t);
  const { config, calls } = fakeAgent(home, 'codex');
  const env = { PATH: home };
  const skill = path.join(home, '.agents/skills/neorion/SKILL.md');
  const file = path.join(root, 'AGENTS.md');
  const original = '# Other instructions\n';
  const other = { mcpServers: { other: { command: 'keep' } } };
  fs.writeFileSync(config, JSON.stringify(other));
  fs.writeFileSync(file, original);
  for (const args of [['--local'], ['--local'], ['--remove'], ['--remove']]) {
    const result = run(['setup', 'codex', ...args], env);
    assert.equal(result.status, 0, result.stderr);
    if (args.includes('--local')) {
      assertQueryHint(fs.readFileSync(file, 'utf8'));
      assert.ok(fs.existsSync(skill));
    }
  }
  assert.deepEqual(calls().filter(([, action]) => action !== 'get'), [
    ['mcp', 'add', 'neorion', '--', process.execPath, entry, 'mcp'],
    ['mcp', 'remove', 'neorion']
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!fs.existsSync(skill));
  assert.deepEqual(readJson(config), other);
});

test('Setup and remove preserve preexisting or modified Neorion skills and servers', { skip: process.platform === 'win32' }, t => {
  const { home, root, run } = fixture(t);
  for (const [agent, file, skills] of [['claude', 'CLAUDE.md', '.claude'], ['codex', 'AGENTS.md', '.agents']]) {
    const { config, calls } = fakeAgent(home, agent);
    const skill = path.join(home, skills, 'skills/neorion/SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    const env = { PATH: home };
    const custom = { mcpServers: { neorion: { command: 'custom' } } };
    for (const preexisting of [false, true]) {
      if (preexisting) {
        fs.writeFileSync(config, JSON.stringify(custom));
        fs.writeFileSync(skill, 'Custom skill');
      }
      const added = run(['setup', agent], env);
      assert.equal(added.status, 0, added.stderr);
      if (!preexisting) {
        fs.writeFileSync(config, JSON.stringify(custom));
        fs.writeFileSync(skill, 'Custom skill');
      }
      const removed = run(['setup', agent, '--remove'], env);
      assert.equal(removed.status, 0, removed.stderr);
      assert.ok(!fs.existsSync(path.join(root, file)));
      assert.equal(fs.readFileSync(skill, 'utf8'), 'Custom skill');
      assert.deepEqual(readJson(config), custom);
    }
    assert.deepEqual(calls().filter(([, action]) => action !== 'get').map(([, action]) => action), ['add']);
  }
});

test('Both setup targets honor --no-hint and skip directories without project markers', t => {
  const { home, root, run } = fixture(t);
  const env = { PATH: home, Path: home };
  const project = path.join(root, 'tsconfig.json');
  for (const [agent, file] of [['codex', 'AGENTS.md'], ['claude', 'CLAUDE.md']]) {
    fs.writeFileSync(project, '{}');
    const optOut = run(['setup', agent, '--no-hint'], env);
    assert.equal(optOut.status, 0, optOut.stderr);
    assert.doesNotMatch(optOut.stdout, /Skipping/);
    assert.ok(!fs.existsSync(path.join(root, file)));
    fs.unlinkSync(project);
    const skipped = run(['setup', agent], env);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.ok(skipped.stdout.includes('Skipping ' + file + ' hint'));
    if (agent === 'codex') assert.match(skipped.stdout, /Next: rerun setup from the project root/);
    assert.ok(!fs.existsSync(path.join(root, file)));
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(run(['setup', 'claude'], env).status, 0);
  assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
});

test('CLI indexes a new page and waits for the updated graph after an edit', t => {
  const { root, run } = fixture(t);
  const legacy = path.join(root, 'codebase_graph.md');
  const legacyContents = '# old architecture (app router)\n' +
    'Detail headings name source areas. Numbered parts continue the same area.\n' +
    'Fact prefixes: rendered (including layout reachability)\n';
  fs.writeFileSync(legacy, legacyContents);
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);

  const page = path.join(root, 'app', 'new', 'page.tsx');
  fs.mkdirSync(path.dirname(page));
  fs.writeFileSync(page, 'export default function AddedPage() { return <main />; }\n');
  const added = run(['query', 'search', 'AddedPage']);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /fresh/);
  assert.match(added.stdout, /app\/new\/page\.tsx:1#AddedPage/);

  fs.writeFileSync(page, 'export default function EditedPage() { return <main />; }\n');
  const edited = run(['query', 'search', 'EditedPage']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.match(edited.stdout, /fresh/);
  assert.match(edited.stdout, /app\/new\/page\.tsx:1#EditedPage/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyContents);
});

test('CLI MCP refreshes a warm graph after a page is added', { timeout: 20_000 }, async t => {
  const { root, env } = fixture(t);
  const server = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
  assert.match(await server.text('query', { kind: 'search', target: 'LatePage' }), /0 results/);
  const page = path.join(root, 'app', 'late', 'page.tsx');
  fs.mkdirSync(path.dirname(page));
  fs.writeFileSync(page, 'export default function LatePage() { return <main />; }\n');
  assert.match(await server.text('query', { kind: 'search', target: 'LatePage' }), /app\/late\/page\.tsx:1#LatePage/);
});

test('CLI project discovery skips hidden, generated, and unreadable directories', t => {
  const { root, run } = fixture(t);
  const monorepo = path.dirname(root);
  const inaccessible = process.platform !== 'win32' && process.getuid?.() !== 0;
  for (const name of ['.hidden', 'dist', 'vendor', ...(inaccessible ? ['aaa-private'] : [])]) {
    const directory = path.join(monorepo, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{}');
    if (name === 'aaa-private') fs.chmodSync(directory, 0o000);
  }
  let query;
  try {
    query = run(['query', 'search', 'DashboardShell', '--root', monorepo]);
  } finally {
    if (inaccessible) fs.chmodSync(path.join(monorepo, 'aaa-private'), 0o700);
  }
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /^Project: workspace\n/);
  assert.match(query.stdout, /app\/page\.tsx:1#DashboardShell/);
});
