const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parse } = require('jsonc-parser');
const { openMcp } = require('./mcp-helpers.cjs');
const { mcpCommand, releaseSpec } = require('./mcp-command.cjs');
const { cachePath, indexFile } = require('./workspace-cache.cjs');

const { name, version } = require('../../neorion/package.json');
const packageRoot = path.resolve(__dirname, '../../neorion');
const entry = path.join(packageRoot, 'dist/neorion.cjs');
const cursorWorkspaceCli = '.neorion/cursor-setup/neorion.cjs';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const cliSpawnTimeout = 60_000;

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
  for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = process.env.PATH;
  const run = (args, overrides = {}, cliEntry = entry, cwd = root) => childProcess.spawnSync(process.execPath, [cliEntry, ...args], {
    cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: cliSpawnTimeout
  });
  return { root, cache, home, env, run };
}

function fakeAgent(home, agent, { claudeHome = home, oldCodex = '' } = {}) {
  const config = agent === 'claude' ? path.join(claudeHome, '.claude.json') : path.join(home, '.codex/fake-mcp.json');
  const log = path.join(home, agent + '.log');
  const windows = process.platform === 'win32';
  const program = path.join(home, agent + (windows ? '.cjs' : ''));
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(program, `#!${process.execPath}
const fs = require('node:fs');
const [group, action, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([group, action, ...args]) + '\\n');
const file = ${JSON.stringify(config)};
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { mcpServers: {} };
if (action === 'get') {
  if (${JSON.stringify(oldCodex)}) {
    console.error("error: unrecognized subcommand 'get'");
    process.exit(2);
  }
  if (!data.mcpServers.neorion) {
    console.error("Error: No MCP server named 'neorion' found.");
    process.exit(1);
  }
  console.log(JSON.stringify(data.mcpServers.neorion));
} else if (action === 'list') {
  if (!args.includes('--json')) {
    console.log('Name  Command');
    for (const [name, entry] of Object.entries(data.mcpServers)) console.log(name + '  ' + entry.command);
  } else if (${JSON.stringify(oldCodex)} === 'text-list') {
    console.error("error: unexpected argument '--json' found");
    process.exit(2);
  } else {
    console.log(JSON.stringify(Object.entries(data.mcpServers).map(([name, entry]) => ({ name, ...entry }))));
  }
} else if (action === 'add') {
  if (process.env.FAKE_ADD_FAILURE) {
    console.error('Cannot load Codex configuration');
    process.exit(1);
  }
  if (${JSON.stringify(agent)} === 'claude' && data.mcpServers.neorion) {
    console.error('Server already exists');
    process.exit(1);
  }
  const [command, ...launchArgs] = args.slice(args.indexOf('--') + 1);
  data.mcpServers.neorion = { type: 'stdio', command, args: launchArgs, env: {} };
  fs.writeFileSync(file, JSON.stringify(data));
} else if (action === 'remove') {
  if (process.env.FAKE_REMOVE_FAILURE) process.exit(1);
  delete data.mcpServers.neorion;
  fs.writeFileSync(file, JSON.stringify(data));
} else process.exit(2);
`, { mode: 0o755 });
  if (windows) fs.writeFileSync(path.join(home, agent + '.cmd'), `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`);
  return {
    config,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').map(JSON.parse) : []
  };
}

function assertQueryHint(hint) {
  const block = hint.split('<!-- neorion:start -->')[1].split('<!-- neorion:end -->')[0];
  assert.match(block, /rename affects.*`neorion_query` tool before grepping/);
  for (const kind of ['wrappers', 'who_renders', 'rename_impact', 'api_consumers', 'search', 'impact', 'callees']) {
    assert.ok(block.includes(`\x60${kind} <`), kind);
  }
  assert.match(block, /Query kinds are .*`path <from> <to>`, `changes`\./);
  assert.match(block, /For `path`, pass `target` and `to` in MCP\. For `changes`, omit `target`\./);
  assertMonorepoGuidance(block);
  assert.match(block, /# complete` covers the indexed static matches in the stated scope/);
  assert.match(block, /# partial: <reason>.*verify against the source/);
  assert.match(block, /If MCP is unavailable, run `.+ query <kind> <target>`/);
  assert.match(block, /`.+ query path <from> <to>`.*`.+ query changes`/);
}

function assertMonorepoGuidance(text) {
  assert.match(text, /MCP `app`.*CLI `--app <name>`/);
  assert.match(text, /`App:` sections and `\[app\]` row prefixes/);
  assert.match(text, /If Neorion only lists apps, rerun the query with .*listed app name/);
}

test('the Neorion skill documents app selection, combined results, and list mode', () => {
  assertMonorepoGuidance(fs.readFileSync(path.join(packageRoot, 'skills/neorion/SKILL.md'), 'utf8'));
});

function copyCli(directory) {
  const copied = path.join(directory, 'dist/neorion.cjs');
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.copyFileSync(entry, copied);
  fs.cpSync(path.join(packageRoot, 'skills'), path.join(directory, 'skills'), { recursive: true });
  return copied;
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
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"different-package-name"}');
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  assert.match(graph.stdout, / · workspace · app router · /);
  assert.doesNotMatch(graph.stdout, /^MCP:/m);
  assert.equal(graph.stderr, '');
  const config = run(['graph', '--mcp-config']);
  assert.equal(config.status, 0, config.stderr);
  assert.deepEqual(JSON.parse(/^MCP:\s+(.+)$/m.exec(config.stdout)[1]), { command: process.execPath, args: [entry, 'mcp'] });
  const overview = /^Overview: (.+)$/m.exec(graph.stdout)[1];
  assert.ok(overview.startsWith(path.join(cache, 'neorion') + path.sep));
  assert.ok(fs.existsSync(overview));
  const query = run(['query', 'who_renders', 'DashboardShell', '--limit', '1']);
  assert.equal(query.status, 0, query.stderr);
  assert.equal(query.stdout.split('\n')[0], `Project: ${root}`);
  assert.match(query.stdout, /app\/page\.tsx:2/);
  const miss = run(['query', 'who_renders', 'Dashboard']);
  assert.match(miss.stdout, /^# did you mean: app\/page\.tsx#DashboardShell \(declared at line 1\)$/m);
  assert.match(miss.stdout, /^# try: .+neorion\.cjs'? query search Dashboard --kind component --root .+$/m);
  assert.deepEqual(fs.readdirSync(root).sort(), ['app', 'package.json', 'tsconfig.json']);
});

test('CLI wrapper misses point to route search and concrete Pages URLs resolve to their patterns', t => {
  const { root, run } = fixture(t);
  fs.rmSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"include":["pages/**/*"]}');
  fs.mkdirSync(path.join(root, 'pages/blog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pages/_app.tsx'), 'export default function MyApp({ Component }) { return <Component />; }');
  for (const page of ['[slug]', 'archive', 'posts/[...parts]']) {
    const file = path.join(root, 'pages/blog', page + '.tsx');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default function BlogPost() { return <main />; }');
  }
  const miss = run(['query', 'wrappers', '/']);
  assert.equal(miss.status, 0, miss.stderr);
  assert.match(miss.stdout, /^# try: .+neorion\.cjs'? query search \/ --kind route --root .+$/m);
  assert.match(miss.stdout, /^# partial: target unresolved$/m);
  const routes = run(['query', 'search', '/', '--kind', 'route', '--limit', '1']);
  assert.equal(routes.status, 0, routes.stderr);
  assert.match(routes.stdout, /^route .* \/blog\//m);
  assert.match(routes.stdout, /# more: 2 \(try .+neorion\.cjs'? query search \/ --kind route --limit 3 --root .+/);
  assert.doesNotMatch(routes.stdout, /^component /m);
  for (const [url, pattern] of [
    ['/blog/example-post', '/blog/[slug]'], ['/blog/archive', '/blog/archive'], ['/blog/posts/a/b', '/blog/posts/[...parts]']
  ]) {
    const query = run(['query', 'wrappers', url]);
    assert.equal(query.status, 0, query.stderr);
    assert.ok(query.stdout.includes(`# wrappers ${pattern} : 1 file, 1 page`), query.stdout);
    assert.match(query.stdout, /^1 pages\/_app\.tsx:1 MyApp$/m);
  }
});

test('CLI hints replay a source query from outside its explicitly selected project', { skip: process.platform === 'win32' }, t => {
  const { root, home, env } = fixture(t);
  const direct = copyCli(path.join(home, "checkout's source"));
  fs.copyFileSync(path.join(path.dirname(entry), 'graph.cjs'), path.join(path.dirname(direct), 'graph.cjs'));
  const project = path.join(home, 'selected project');
  fs.renameSync(root, project);
  env.PATH = home;
  const first = spawnSync(process.execPath, [direct, 'query', 'search', 'app', '--kind', 'component',
    '--limit', '1', '--root', project], { cwd: home, env, encoding: 'utf8', timeout: cliSpawnTimeout });
  assert.equal(first.status, 0, first.stderr);
  const command = /^# more: \d+ \(try (.*), or narrow the text\)$/m.exec(first.stdout)?.[1];
  assert.ok(command?.includes(process.execPath), first.stdout);
  const second = spawnSync('/bin/sh', ['-c', command], { cwd: home, env, encoding: 'utf8', timeout: cliSpawnTimeout });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.split('\n')[0], `Project: ${project}`);
  assert.match(second.stdout, /^# search "app" kind=component : 2 results /m);
  assert.doesNotMatch(second.stdout, /^# more:/m);
});

test('CLI and MCP index JSX with jsconfig paths, baseUrl, and inherited include', async t => {
  const { root, env, run } = fixture(t);
  fs.unlinkSync(path.join(root, 'tsconfig.json'));
  fs.unlinkSync(path.join(root, 'app/page.tsx'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'base.json'), '{"include":["app/**/*.jsx","src/**/*.jsx","public/explicit.jsx"]}');
  fs.writeFileSync(path.join(root, 'jsconfig.json'), `{
    // Neorion applies the JavaScript project defaults.
    "compilerOptions": {"allowJs": false, "checkJs": true, "baseUrl": "./src", "paths": {"@ui/*": ["*"]}},
    "extends": "./base.json",
  }`);
  fs.writeFileSync(path.join(root, 'app/page.jsx'),
    'import { Card } from "@ui/card";\nimport { Label } from "label";\n' +
    'export default function Page() { return <Card><Label /></Card>; }');
  fs.writeFileSync(path.join(root, 'src/card.jsx'), 'export function Card({children}) { return <main>{children}</main>; }');
  fs.writeFileSync(path.join(root, 'src/label.jsx'), 'export function Label() { return <span />; }');
  fs.writeFileSync(path.join(root, 'public/explicit.jsx'), 'export const Explicit = 1;');
  fs.writeFileSync(path.join(root, 'ignored.jsx'), 'export function Ignored() { return <aside />; }');
  const server = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root,
    env: { ...env, NEORION_BUILD_WAIT_MS: '120000' } });
  for (const target of ['Card', 'Label']) {
    const result = await server.text('query', { kind: 'who_renders', target });
    assert.match(result, /^\/  app\/page\.jsx:3/m);
    assert.equal(run(['query', 'who_renders', target]).stdout.trimEnd(), result);
  }
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  assert.match(graph.stdout, /app router · 4 source files/);
  assert.ok(fs.existsSync(/^Overview: (.+)$/m.exec(graph.stdout)[1]));
  assert.ok(!fs.existsSync(path.join(root, 'tsconfig.json')));
});

test('CLI discovers configless Next.js projects and diagnoses missing projects', t => {
  const { root, run } = fixture(t);
  fs.unlinkSync(path.join(root, 'tsconfig.json'));
  fs.renameSync(path.join(root, 'app/page.tsx'), path.join(root, 'app/page.jsx'));
  const missing = run(['graph']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no tsconfig\.json, jsconfig\.json, next\.config file, or package\.json with a next dependency/);
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"next":"15.0.0"}}');
  const dynamic = path.join(root, 'app', '[id]');
  fs.mkdirSync(dynamic);
  fs.writeFileSync(path.join(dynamic, 'page.jsx'), 'export default function Item() { return <article />; }');
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  assert.match(graph.stdout, /app router · 2 source files/);
  assert.match(fs.readFileSync(/^Overview: (.+)$/m.exec(graph.stdout)[1], 'utf8'), /\[id\].*page\.jsx=Item/);
  const query = run(['query', 'who_renders', 'DashboardShell']);
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /^\/  app\/page\.jsx:2/m);
  assert.deepEqual(fs.readdirSync(root).sort(), ['app', 'package.json']);
});

const nextDep = { dependencies: { next: '15.0.0' } };
const projectMarkers = {
  dep: ['package.json', JSON.stringify(nextDep)],
  nx: ['package.json', JSON.stringify({ devDependencies: nextDep.dependencies, workspaces: ['apps/*'] })],
  manifest: ['package.json', '{}'],
  gitfile: ['.git', 'gitdir: ../.git/modules/checkout\n'],
  ts: ['tsconfig.json', '{}'],
  js: ['jsconfig.json', '{}'],
  ...Object.fromEntries(['js', 'mjs', 'ts', 'cjs'].map(ext => [`next.${ext}`, [`next.config.${ext}`, '']]))
};

function moveIntoApp(root, folder, config = true) {
  const project = path.join(root, folder);
  fs.mkdirSync(project, { recursive: true });
  fs.renameSync(path.join(root, 'app'), path.join(project, 'app'));
  if (config) fs.writeFileSync(path.join(project, 'next.config.js'), '');
  return project;
}

test('CLI --root discovers the sole Next app in a workspace from outside it', t => {
  const { home, root, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(nextDep));
  moveIntoApp(root, 'apps/web', false);
  const result = run(['query', 'who_renders', 'DashboardShell', '--root', root], {}, entry, home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\/  app\/page\.tsx:2/m);
  assert.match(result.stdout, /^# complete:/m);
  assert.doesNotMatch(result.stdout, /project root guessed/);
});

test('MCP workspace discovery preserves the guess for the Claude plugin and legacy --root launcher', async t => {
  const { env, home, root } = fixture(t);
  fs.unlinkSync(path.join(root, 'tsconfig.json'));
  moveIntoApp(root, 'apps/web');
  fs.mkdirSync(path.join(root, 'apps/worker'));
  fs.writeFileSync(path.join(root, 'apps/worker/next.config.js'), '');
  const plugin = readJson(path.join(packageRoot, '.mcp.json')).mcpServers.neorion;
  const pluginArgs = plugin.args.map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}', packageRoot).replace('${CLAUDE_PROJECT_DIR}', root));
  for (const [name, args] of [['legacy --root', [entry, 'mcp', '--root', root]], ['plugin', pluginArgs]]) {
    await t.test(name, async subtest => {
      const client = await openMcp(subtest, root, { command: process.execPath, args, cwd: home, env });
      const result = await client.text('query', { kind: 'who_renders', target: 'DashboardShell' });
      assert.match(result, /^\/  app\/page\.tsx:2/m);
      assert.match(result, /^# partial: project root guessed$/m);
      assert.doesNotMatch(result, /^# complete:/m);
    });
  }
});

test('A selected workspace root gives a confirmation hint and NEORION_ROOT matches --root', async t => {
  const { env, root, run } = fixture(t);
  fs.mkdirSync(path.join(root, 'apps/web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps/worker'));
  fs.writeFileSync(path.join(root, 'apps/web/next.config.js'), '');
  fs.writeFileSync(path.join(root, 'apps/worker/next.config.js'), '');
  const search = ['query', 'search', 'DashboardShell'];
  const initial = run(search);
  assert.equal(initial.status, 0, initial.stderr);
  assert.match(initial.stdout, /^# partial: project root guessed$/m);
  await t.test('root confirmation hint', () => {
    assert.match(initial.stdout, /Use --root \./);
    assert.doesNotMatch(initial.stdout, /Run from the chosen directory/);
  });
  const confirmed = run([...search, '--root', '.']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(confirmed.stdout, /^# complete:/m);
  await t.test('CLI environment root', () => {
    const fromEnv = run(search, { NEORION_ROOT: root });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(fromEnv.stdout, confirmed.stdout);
  });
  await t.test('MCP environment root', async subtest => {
    const client = await openMcp(subtest, root, { command: process.execPath, args: [entry, 'mcp'],
      cwd: root, env: { ...env, NEORION_ROOT: root } });
    assert.equal(await client.text('query', { kind: 'search', target: 'DashboardShell' }), confirmed.stdout.trimEnd());
  });
  await t.test('Claude plugin discovers even when the workspace root is a candidate', async subtest => {
    const plugin = readJson(path.join(packageRoot, '.mcp.json')).mcpServers.neorion;
    const args = plugin.args.map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}', packageRoot).replace('${CLAUDE_PROJECT_DIR}', root));
    const client = await openMcp(subtest, root, { command: process.execPath, args, cwd: root, env });
    const result = await client.text('query', { kind: 'search', target: 'DashboardShell' });
    assert.match(result, /^# partial: project root guessed$/m);
    assert.doesNotMatch(result, /^# complete:/m);
  });
});

test('monorepo app indexes share workspace source and keep route results app-scoped', async t => {
  const { root, env, run } = fixture(t);
  fs.rmSync(path.join(root, 'app'), { recursive: true });
  fs.rmSync(path.join(root, 'tsconfig.json'));
  fs.cpSync(path.join(__dirname, 'fixtures/monorepo'), root, { recursive: true });
  const cli = (...args) => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  const graph = cli('graph');
  assert.match(graph, /^App: "apps\/admin"$/m);
  assert.match(graph, /^App: "apps\/web"$/m);
  const [adminPath, webPath] = [...graph.matchAll(/^Overview: (.+)$/gm)]
    .map(match => path.join(path.dirname(match[1]), indexFile));
  assert.notEqual(webPath, adminPath);
  const search = cli('query', 'search', 'SharedCard');
  assert.match(search, /^\["apps\/admin"\] component \.\.\/\.\.\/packages\/ui\/src\/card\.tsx:1#SharedCard .*workspace package: @fixture\/ui/m);
  assert.match(search, /^\["apps\/web"\] component /m);
  assert.match(search, /# complete: all listed apps/);
  assert.match(cli('query', 'wrappers', '/', '--app', 'web', '--no-external'), /SharedProvider \(workspace package: @fixture\/ui\)/);
  assert.match(cli('query', 'who_renders', '../../packages/ui/src/card.tsx#SharedCard', '--app', 'apps/web'), /^\/  app\/page\.tsx:7/m);
  assert.match(cli('query', 'api_consumers', 'post.all', '--app', '@fixture/web'), /call app\/page\.tsx:8 WebPage \(queryOptions\)/);
  assert.match(cli('query', 'impact', 'post.all', '--app', 'apps/web'), /trpc app\/page\.tsx:8 WebPage/);
  const allProcedures = cli('query', 'api_consumers', 'post.all');
  assert.match(allProcedures, /^\["apps\/admin"\] # not present in this app$/m);
  assert.match(allProcedures, /# complete: all listed apps\s*$/);
  assert.match(cli('query', 'rename_impact', 'WebPage'), /# complete: all listed apps\s*$/);
  const absent = cli('query', 'who_renders', 'NoSuchComponent');
  assert.match(absent, /^# partial: \["apps\/admin"\] target unresolved$/m);
  assert.match(absent, /# partial: see app results\s*$/);

  const web = readJson(webPath);
  const admin = readJson(adminPath);
  assert.ok(web.files['../../packages/trpc/src/index.ts']);
  assert.ok(!Object.keys(web.files).some(file => file.includes('/apps/admin/') || file.includes('/unused/')));
  assert.ok(!Object.keys(admin.files).some(file => file.includes('/apps/web/') || file.includes('/packages/api/')));
  const missing = run(['query', 'search', 'SharedCard', '--app', 'missing']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Unknown app "missing".*apps\/admin.*apps\/web/);

  await t.test('MCP exposes the same namespaces and app filter', async subtest => {
    const preload = path.join(path.dirname(root), 'record-workers.cjs');
    const workerLog = path.join(path.dirname(root), 'workers.log');
    fs.writeFileSync(preload, `
const threads = require('node:worker_threads');
if (threads.isMainThread) threads.Worker = class extends threads.Worker {
  constructor(file, options) {
    super(file, options);
    require('node:fs').appendFileSync(${JSON.stringify(workerLog)}, options.workerData + '\\n');
  }
};`);
    const client = await openMcp(subtest, root, { command: process.execPath,
      args: ['--require', preload, entry, 'mcp', '--workspace', root], cwd: root, env });
    const result = await client.text('query', { kind: 'search', target: 'SharedCard' });
    assert.match(result, /^\["apps\/admin"\] component /m);
    assert.match(result, /^\["apps\/web"\] component /m);
    assert.equal(await client.text('query', { kind: 'search', target: 'SharedCard' }), result);
    const callers = await client.text('query', { kind: 'api_consumers', target: 'post.all', app: 'web' });
    assert.match(callers, /call app\/page\.tsx:8 WebPage/);
    assert.match(callers, /^# complete: indexed tRPC callers and cache sites$/m);
    const allCallers = await client.text('query', { kind: 'api_consumers', target: 'post.all' });
    assert.match(allCallers, /^\["apps\/admin"\] # not present in this app$/m);
    assert.match(allCallers, /# complete: all listed apps$/);
    assert.deepEqual(fs.readFileSync(workerLog, 'utf8').trimEnd().split('\n').sort(),
      ['admin', 'web'].map(app => path.join(root, 'apps', app)).sort());
  });

  const git = (...args) => childProcess.execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'workspace fixture');
  const cardFile = path.join(root, 'packages/ui/src/card.tsx');
  const card = fs.readFileSync(cardFile, 'utf8');
  fs.writeFileSync(cardFile, card.replace('String(options)', 'JSON.stringify(options)'));
  const changes = cli('query', 'changes', '--app', 'web');
  assert.match(changes, /packages\/ui\/src\/card\.tsx/);
  assert.match(changes, /route page \/ +app\/page\.tsx/);

  fs.writeFileSync(path.join(root, 'packages/ui/src/card.tsx'), 'export const NewCard = () => <article />;\n');
  assert.match(cli('query', 'search', 'NewCard', '--app', 'web'), /card\.tsx:1#NewCard/);

  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'next.config.js'), '');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"jsx":"preserve"}}');
  fs.writeFileSync(path.join(root, 'app/page.tsx'), 'export default function RootOnly() { return <main />; }');
  assert.match(cli('query', 'search', 'RootOnly'), /^\["\."\] component app\/page\.tsx:1#RootOnly/m);
  assert.doesNotMatch(cli('query', 'search', 'AdminPage', '--app', '.'), /#AdminPage/);
  fs.rmSync(path.join(root, 'app'), { recursive: true });
  fs.rmSync(path.join(root, 'next.config.js'));
  fs.rmSync(path.join(root, 'tsconfig.json'));

  for (const app of ['events', 'settings']) {
    const directory = path.join(root, 'apps', app);
    fs.cpSync(path.join(root, 'apps/admin'), directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: app, dependencies: nextDep.dependencies }));
  }
  const listed = cli('query', 'search', 'SharedCard');
  assert.match(listed, /^# Next.js apps$/m);
  assert.match(listed, /Use --app <name>/);
  assert.doesNotMatch(listed, /^# complete:/m);
  assert.match(cli('graph'), /--all-apps/);
});

test('workspace gaps follow traversed runtime sites and retain external call rows', t => {
  const { root, run } = fixture(t);
  fs.rmSync(path.join(root, 'app'), { recursive: true });
  fs.rmSync(path.join(root, 'tsconfig.json'));
  fs.cpSync(path.join(__dirname, 'fixtures/monorepo'), root, { recursive: true });
  for (const pkg of ['sdk', 'types', 'declarations']) fs.mkdirSync(path.join(root, 'packages', pkg));
  fs.mkdirSync(path.join(root, 'packages/sdk/dist'));
  fs.writeFileSync(path.join(root, 'packages/sdk/package.json'), JSON.stringify({
    name: '@fixture/sdk', main: 'dist/index.js', types: 'dist/index.d.ts'
  }));
  fs.writeFileSync(path.join(root, 'packages/sdk/dist/index.js'), 'exports.track = () => {};');
  fs.writeFileSync(path.join(root, 'packages/sdk/dist/index.d.ts'), 'export declare function track(event: string): void;');
  fs.writeFileSync(path.join(root, 'packages/declarations/package.json'), '{"name":"@fixture/declarations","types":"index.d.ts"}');
  fs.writeFileSync(path.join(root, 'packages/declarations/index.d.ts'), 'export declare function send(): void;');
  fs.writeFileSync(path.join(root, 'packages/types/package.json'), '{"name":"@fixture/types"}');
  const app = path.join(root, 'apps/web/app');
  fs.appendFileSync(path.join(app, 'layout.tsx'), `
import type { Missing } from '@fixture/types/import';
export type { Missing as Exported } from '@fixture/types/export';
import { type Inline } from '@fixture/types/inline';
export { type Inline as ExportedInline } from '@fixture/types/inline-export';
type ImportExpression = import('@fixture/types/expression').Missing;
`);
  fs.mkdirSync(path.join(app, 'tracking'));
  fs.writeFileSync(path.join(app, 'tracking/page.tsx'), `
import { Track } from './track';
export default function TrackingPage() { return <Track />; }
`);
  fs.writeFileSync(path.join(app, 'tracking/track.tsx'), `
import { track } from '@fixture/sdk';
import type { Event } from '@fixture/sdk';
import { send } from '@fixture/declarations';
import { Leaf } from './leaf';
export function Track() { track('view'); send(); return <Leaf />; }
export function Unrelated(event: Event) { return event; }
export function MissingRender() { return <Missing />; }
import { Missing } from '@fixture/types/render';
`);
  fs.writeFileSync(path.join(app, 'tracking/leaf.tsx'), 'export function Leaf() { return <span />; }');
  fs.mkdirSync(path.join(app, 'wrapped'));
  fs.writeFileSync(path.join(app, 'wrapped/page.tsx'), 'export default function WrappedPage() { return <main />; }');
  fs.writeFileSync(path.join(app, 'wrapped/layout.tsx'), `
import { MissingProvider } from '@fixture/types/provider';
export default function WrappedLayout({ children }) { return <MissingProvider>{children}</MissingProvider>; }
`);
  const query = (kind, target, ...flags) => {
    const result = run(['query', kind, target, '--app', 'web', ...flags]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(query('wrappers', '/'), /# complete: indexed wrapper chains\s*$/);
  assert.match(query('search', 'NoMatchingName'), /# complete: indexed name and path matches\s*$/);
  const partial = /# partial: unresolved workspace modules @fixture\/declarations, @fixture\/sdk\s*$/;
  const callees = query('callees', 'Track');
  assert.match(callees, /^d1 ext @fixture\/sdk +track:6$/m);
  assert.match(callees, /^d1 ext @fixture\/declarations +send:6$/m);
  assert.match(callees, partial);
  const firstHopScope = /# complete: indexed calls, renders, fetches, package calls \(depth 1\)\s*$/;
  assert.match(query('callees', 'TrackingPage', '--depth', '1'), firstHopScope);
  assert.match(query('callees', 'TrackingPage', '--depth', '2'), partial);
  assert.match(query('callees', 'Unrelated'), firstHopScope);
  assert.match(query('rename_impact', 'Unrelated'), /# complete: checker-resolved edit files\s*$/);
  assert.match(query('who_renders', 'Leaf'), /# complete: indexed JSX paths\s*$/);
  const search = query('search', 'Leaf');
  assert.match(search, /^# neighbors:/m);
  assert.match(search, /# complete: indexed name and path matches\s*$/);
  assert.match(query('callees', 'MissingRender'), /# partial: unresolved workspace modules @fixture\/types\/render\s*$/);
  assert.match(query('wrappers', '/wrapped'), /# partial: unresolved workspace modules @fixture\/types\/provider\s*$/);
});

test('workspace discovery orders docs and website with production apps', t => {
  const { root, run } = fixture(t);
  fs.rmSync(path.join(root, 'app'), { recursive: true });
  fs.rmSync(path.join(root, 'tsconfig.json'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"workspaces":["apps/*"]}');
  for (const name of ['web', 'website', 'docs', 'dev']) {
    const app = path.join(root, 'apps', name);
    fs.mkdirSync(path.join(app, 'app'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name, dependencies: { next: '15.0.0' } }));
    fs.writeFileSync(path.join(app, 'app/page.tsx'), 'export default function Page() { return null; }');
  }
  const listed = run(['query', 'search', 'Page']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual([...listed.stdout.matchAll(/^  "apps\/(\w+)"/gm)].map(match => match[1]),
    ['docs', 'web', 'website', 'dev']);
});

test('explicit --root rejects directories without a project', t => {
  const { root, run } = fixture(t);
  fs.mkdirSync(path.join(root, 'plain/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plain/package.json'), '{"name":"plain"}');
  fs.writeFileSync(path.join(root, 'plain/src/index.ts'), 'export const plain = 1;');
  const result = run(['query', 'search', 'plain', '--root', 'plain']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Neorion found no tsconfig\.json/);
  assert.doesNotMatch(result.stdout, /^# complete:/m);
});

test('CLI Project line shows the full path for an unambiguous nested app', t => {
  const { root, run } = fixture(t);
  const project = moveIntoApp(root, 'apps/web');
  const query = run(['query', 'search', 'DashboardShell']);
  assert.equal(query.status, 0, query.stderr);
  assert.equal(query.stdout.split('\n')[0], `Project: ${project}`);
  assert.match(query.stdout, /^# complete:/m);
});

test('CLI ranks dependency-only Next libraries below apps and omits them from the app hint', t => {
  const { root, run } = fixture(t);
  fs.unlinkSync(path.join(root, 'tsconfig.json'));
  const app = moveIntoApp(root, 'apps/web');
  const libraries = ['lib', 'packages/ui', 'packages/utils'];
  for (const folder of libraries) {
    const directory = path.join(root, folder);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      devDependencies: nextDep.dependencies, peerDependencies: nextDep.dependencies
    }));
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{}');
  }
  const query = run(['query', 'search', 'DashboardShell']);
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /app\/page\.tsx:1#DashboardShell/);
  const hint = /^# hint: .*$/m.exec(query.stdout)?.[0];
  assert.ok(hint?.includes(`Selected ${JSON.stringify(app)}. Found 3 other packages with only a development dependency on Next.`), query.stdout);
  assert.doesNotMatch(hint, /Candidates:/);
  for (const folder of libraries) assert.ok(!hint.includes(JSON.stringify(path.join(root, folder))), hint);
  assert.match(query.stdout, /^# partial: project root guessed$/m);
  assert.doesNotMatch(query.stdout, /^# complete:/m);
});

for (const { name, markers, selected, candidates, start = '.', pageRoot = selected, src, javascript, checkMcp } of [
  { name: 'configless JavaScript root with Cypress', markers: { '.': ['dep'], cypress: ['ts'] }, selected: '.', javascript: true },
  { name: 'root Next config with e2e and scripts configs', markers: { '.': ['next.cjs'], e2e: ['ts'], scripts: ['ts'] }, selected: '.' },
  { name: 'Dub from repository root', markers: { 'apps/web': ['dep', 'ts'], 'packages/cli': ['ts'] }, selected: 'apps/web' },
  { name: 'Dub with a second Next app', markers: { '.': ['manifest'], 'apps/admin': ['dep'], 'apps/web': ['dep', 'ts'], 'packages/cli': ['ts'] },
    selected: 'apps/web', candidates: ['apps/admin', 'apps/web'], checkMcp: true },
  { name: 'Rallly from repository root', markers: { 'apps/web': ['next.ts', 'ts'], 'apps/landing': ['next.ts', 'ts'] },
    selected: 'apps/landing', candidates: ['apps/landing', 'apps/web'] },
  { name: 'Formbricks from repository root', markers: { 'apps/deployment-check': ['ts'], 'apps/web': ['next.mjs', 'ts'] }, selected: 'apps/web' },
  { name: 'integrated Nx with Next declared in the root', markers: { '.': ['nx'], 'apps/web': ['next.js', 'ts'] }, selected: 'apps/web' },
  { name: 'hoisted Next with no child config or dependency', markers: { '.': ['dep'], 'apps/web': ['manifest'] }, selected: 'apps/web', src: true },
  { name: 'checkout boundary stops Next inheritance', markers: { '.': ['dep', 'ts'], 'apps/checkout': ['gitfile', 'manifest'] },
    selected: '.', pageRoot: 'apps/checkout' },
  { name: 'library with Next examples and a root config', markers: { '.': ['ts'],
    ...Object.fromEntries(['node_modules', 'cypress', 'e2e', 'playwright', 'test', 'tests', '__tests__', 'scripts',
      'example', 'examples', 'demo', 'demos', 'samples', 'docs', 'website', 'playground', 'playgrounds', 'storybook',
      'ssr-testing', 'bundler-tests', 'playground-v6'].map(dir => [`${dir}/web`, ['dep', 'ts']])) }, selected: '.' },
  { name: 'library with a root config and several Next packages outside examples', markers: { '.': ['ts'],
    'examples/web': ['dep', 'ts'], 'integrations/web': ['next.js', 'ts'], 'packages/next': ['dep', 'ts'] },
    selected: '.', candidates: ['.', 'integrations/web', 'packages/next'] },
  { name: 'sole nested Next app in a workspace with a root config', markers: { '.': ['ts'], 'apps/web': ['dep', 'ts'] }, selected: 'apps/web' },
  { name: 'nested scan stops at depth four', markers: { '.': ['ts'], 'one/two/three/four/five': ['next.js'] }, selected: '.' },
  { name: 'wrapper containing a clone', markers: { 'clone/apps/web': ['next.js'] }, selected: 'clone/apps/web' },
  { name: 'saas-starter root', markers: { '.': ['dep', 'next.ts', 'ts'] }, selected: '.' },
  { name: 'config-only fallback below the requested directory', markers: { scripts: ['ts'], 'scripts/other': ['dep'], tools: ['js'] },
    selected: 'scripts', candidates: ['scripts', 'tools'] },
  { name: 'config-only project selected explicitly', markers: { 'packages/lib': ['ts'] }, selected: 'packages/lib', start: 'packages/lib' }
]) {
  test(`CLI project root: ${name}`, async t => {
    const { root, env, run } = fixture(t);
    fs.unlinkSync(path.join(root, 'tsconfig.json'));
    for (const [folder, keys] of Object.entries(markers)) {
      const directory = path.join(root, folder);
      fs.mkdirSync(directory, { recursive: true });
      for (const key of keys) {
        const [file, contents] = projectMarkers[key];
        fs.writeFileSync(path.join(directory, file), contents);
      }
    }
    const app = path.join(root, pageRoot, src ? 'src/app' : 'app');
    if (pageRoot !== '.' || src) {
      fs.mkdirSync(path.dirname(app), { recursive: true });
      fs.renameSync(path.join(root, 'app'), app);
    }
    if (javascript) fs.renameSync(path.join(app, 'page.tsx'), path.join(app, 'page.jsx'));

    const cwd = path.join(root, start);
    const project = path.join(root, selected);
    const label = path.basename(project);
    const search = ['query', 'search', 'DashboardShell'];
    // Query first so auto-build must index the selected directory directly.
    const query = run(search, {}, entry, cwd);
    assert.equal(query.status, 0, query.stderr);
    assert.equal(query.stdout.split('\n')[0], `Project: ${project}`);
    assert.ok(query.stdout.includes(`${pageRoot === selected ? '' : pageRoot + '/'}${src ? 'src/' : ''}app/page.${javascript ? 'jsx' : 'tsx'}:1#DashboardShell`), query.stdout);
    const graph = run(['graph', cwd]);
    assert.equal(graph.status, 0, graph.stderr);
    assert.ok(graph.stdout.split('\n')[0].includes(` · ${label} · ${pageRoot === selected ? 'app' : 'none'} router · `), graph.stdout);
    if (candidates) {
      for (const output of [graph.stdout, query.stdout]) {
        assert.match(output, /^# partial: project root guessed$/m);
        assert.doesNotMatch(output, /^# complete/m);
        const hint = /^# hint: .*$/m.exec(output)?.[0];
        assert.ok(hint?.includes(candidates.map(dir => JSON.stringify(path.join(root, dir))).join(', ')), output);
        assert.match(hint, selected === start ? /Use --root \./ : /Run from the chosen directory or use --root <dir>/);
      }
      for (const candidate of candidates) {
        const directory = path.join(root, candidate);
        const explicit = run([...search, '--root', directory]);
        assert.equal(explicit.status, 0, explicit.stderr);
        assert.equal(explicit.stdout.split('\n')[0], `Project: ${directory}`);
        assert.match(explicit.stdout, /^# complete:/m);
        if (candidate === '.') continue;
        const direct = run(search, {}, entry, directory);
        assert.equal(direct.status, 0, direct.stderr);
        assert.equal(direct.stdout, explicit.stdout);
      }
    } else {
      assert.match(query.stdout, /^# complete:/m);
      assert.doesNotMatch(graph.stdout + query.stdout, /project root guessed/);
    }
    if (checkMcp) {
      const miss = run(['query', 'wrappers', '/missing']);
      assert.equal(miss.status, 0, miss.stderr);
      assert.match(miss.stdout, /^# partial: project root guessed$/m);
      assert.match(miss.stdout, /^# partial: target unresolved$/m);
      assert.doesNotMatch(miss.stdout, /^# complete/m);
      const client = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
      // Graph rebuilt the index after the CLI query, possibly in a different minute.
      const withoutIndexTime = text => text.trimEnd().replace(/\(index [\dTZ:-]+, fresh\)/, '(index, fresh)');
      assert.equal(withoutIndexTime(await client.text('query', { kind: 'search', target: 'DashboardShell' })),
        withoutIndexTime(query.stdout));
      await client.close();
      const explicit = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp', '--root', root], cwd: root, env });
      assert.equal(await explicit.text('query', { kind: 'search', target: 'DashboardShell' }),
        run([...search, '--root', root]).stdout.trimEnd());
    }
  });
}

test('CLI shows five project candidates and stops scanning wide trees', t => {
  const { root, run } = fixture(t);
  for (let index = 0; index < 7; index++) {
    const directory = path.join(root, 'apps', String(index));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'next.config.js'), '');
  }
  const search = ['query', 'search', 'DashboardShell'];
  const query = run(search);
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /and 3 more\./);
  assert.doesNotMatch(query.stdout, /^# complete|scan reached its limit/m);

  const wide = path.join(root, 'generated');
  fs.mkdirSync(wide);
  for (let index = 0; index < 2100; index++) fs.mkdirSync(path.join(wide, String(index)));
  const limited = run(search);
  assert.equal(limited.status, 0, limited.stderr);
  assert.match(limited.stdout, /scan reached its limit/);
  assert.doesNotMatch(limited.stdout, /^# complete/m);
});

for (const withConfig of [true, false]) {
  test(`JavaScript ${withConfig ? 'jsconfig' : 'configless'} defaults exclude build outputs and public assets`, t => {
    const { root, run } = fixture(t);
    fs.unlinkSync(path.join(root, 'tsconfig.json'));
    fs.renameSync(path.join(root, 'app/page.tsx'), path.join(root, 'app/page.jsx'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"next":"15.0.0"}}');
    if (withConfig) fs.writeFileSync(path.join(root, 'jsconfig.json'), '{"compilerOptions":{"paths":{"@app/*":["./app/*"]}}}');
    for (const directory of ['out/_next/static', 'build', 'dist', 'coverage', 'vendor', 'public']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.writeFileSync(path.join(root, directory, 'bundled.js'), 'export const BundledSymbol = 1;');
    }

    const graph = run(['graph']);
    assert.equal(graph.status, 0, graph.stderr);
    assert.match(graph.stdout, /app router · 1 source files/);
    const query = run(['query', 'search', 'BundledSymbol']);
    assert.equal(query.status, 0, query.stderr);
    assert.match(query.stdout, /0 results/);
  });
}

test('wrapper queries include only third-party components on the page chain by default', async t => {
  const { root, env, run } = fixture(t);
  fs.cpSync(path.join(__dirname, 'fixtures/external-wrappers'), root, { recursive: true });
  const query = ['query', 'wrappers', '/'];
  const standard = run(query);
  assert.equal(standard.status, 0, standard.stderr);
  const providers = '# providers (outermost first): SWRConfig (external: swr), SessionProvider (external: next-auth/react), Scope (external: widgets), ContextShell, theme.Provider';
  assert.match(standard.stdout, /^1 app\/layout\.tsx:8 RootLayout, Grid \(external: widgets\), Tabs \(external: @radix-ui\/react-tabs\), widgets\.Root \(external: widgets\), LocalContext, LocalConfig, theme\.Consumer providers:/m);
  assert.ok(standard.stdout.split('\n').includes(providers));
  assert.doesNotMatch(standard.stdout, /^# not wrappers:/m);
  assert.match(standard.stdout, /1 file, 1 page/);
  assert.doesNotMatch(standard.stdout, /Link|Icon|PageDecoration|motion\.div/);
  assert.equal(run([...query, '--include-external']).stdout, standard.stdout);

  const hidden = run([...query, '--no-external']);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.match(hidden.stdout, /^1 app\/layout\.tsx:8 RootLayout, LocalContext, LocalConfig, theme\.Consumer providers:/m);
  assert.ok(hidden.stdout.split('\n').includes(providers));
  assert.doesNotMatch(hidden.stdout, /\b(?:Grid|Tabs|widgets\.Root)\b/);
  assert.match(run(['--help']).stdout, /Wrapper flags:\n  --no-external hides third-party non-provider wrappers\. Providers stay visible\.\n  --include-external includes third-party wrappers \(default\)\./);

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

async function chatTransportQueries(t, source) {
  const { root, env, run } = fixture(t);
  for (const route of ['chat', 'other']) {
    const directory = path.join(root, 'app', 'api', route);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() {}\nexport function POST() {}\n');
  }
  fs.writeFileSync(path.join(root, 'app/chat.ts'), source);
  const server = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
  return async (kind, target, to) => {
    const result = await server.text('query', { kind, target, to });
    const cli = run(['query', kind, target, ...(to ? [to] : [])]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trimEnd(), result);
    return result;
  };
}

test('CLI and MCP keep transport receiver mutations out of complete POST paths', async t => {
  const query = await chatTransportQueries(t, `
    import { DefaultChatTransport } from 'ai';
    export function receiverChat() {
      return new DefaultChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest() {
          this.api = '/api/other';
          return { body: {} };
        },
      });
    }
  `);
  const partial = /^# partial: possible AI SDK transport URL override$/m;
  const configured = await query('api_consumers', '/api/chat');
  assert.match(configured, /^send .* receiverChat \? AI SDK transport \[possible URL override\] \[partial url\]$/m);
  assert.match(configured, partial);
  const actual = await query('api_consumers', '/api/other');
  assert.match(actual, /^send .* receiverChat .* \[mention\]$/m);
  assert.match(actual, partial);
  for (const route of ['/api/chat', '/api/other']) {
    const result = await query('path', 'receiverChat', route);
    assert.match(result, /no directed path/);
    assert.match(result, partial);
  }
  const callees = await query('callees', 'receiverChat');
  assert.match(callees, /0 fetches/);
  assert.match(callees, partial);
});

test('CLI and MCP index a literal reconnect override as a GET request', async t => {
  const query = await chatTransportQueries(t, `
    import { DefaultChatTransport } from 'ai';
    export function reconnectChat() {
      return new DefaultChatTransport({
        api: '/api/chat',
        prepareReconnectToStreamRequest: () => ({ api: '/api/other' }),
      });
    }
  `);
  const override = await query('api_consumers', '/api/other');
  assert.match(override, /1 site in 1 file: 1 request/);
  assert.match(override, /^send .* reconnectChat GET AI SDK transport \[possible reconnect\]$/m);
  assert.match(override, /^# complete:/m);
  const configured = await query('api_consumers', '/api/chat');
  assert.match(configured, /^send .* reconnectChat POST AI SDK transport$/m);
  assert.match(configured, /^# complete:/m);
  const result = await query('path', 'reconnectChat', '/api/other');
  assert.match(result, /1 hop/);
  assert.match(result, /^1 fetch .* GET \/api\/other \(GET\)/m);
  assert.match(result, /^# complete:/m);
});

test('CLI MCP rebuilds an index without the wrapper revision', { timeout: 20_000 }, async t => {
  const { root, env, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'app/layout.tsx'),
    'function ShellProvider({children}) { return <main>{children}</main>; }\n' +
    'export default function Layout({children}) { return <ShellProvider>{children}</ShellProvider>; }');
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  const overview = /^Overview: (.+)$/m.exec(graph.stdout)[1];
  const file = path.join(path.dirname(overview), indexFile);
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

test('CLI query refreshes an older same-version index missing same-file use sites', t => {
  const { root, run } = fixture(t);
  fs.appendFileSync(path.join(root, 'app/page.tsx'), 'const Shell = DashboardShell;\n');
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  const overview = /^Overview: (.+)$/m.exec(graph.stdout)[1];
  const file = path.join(path.dirname(overview), indexFile);
  const index = readJson(file);
  const revision = index.queryRevision;
  assert.ok(Number.isInteger(revision));
  index.queryRevision = revision - 1;
  index.references = [];
  for (const symbol of index.symbols) delete symbol.localUses;
  fs.writeFileSync(file, JSON.stringify(index));

  const result = run(['query', 'rename_impact', 'DashboardShell'], { NEORION_AUTOBUILD: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^use  app\/page\.tsx:2,3$/m);
  assert.equal(readJson(file).queryRevision, revision);
});

test('CLI rejects same-version graph caches from both sides of the render-edge merge', t => {
  const { run } = fixture(t);
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  const indexPath = path.join(path.dirname(/^Overview: (.+)$/m.exec(graph.stdout)[1]), indexFile);
  const index = readJson(indexPath);
  assert.ok(index.wrapperRevision > 5 && index.queryRevision > 8 && index.graphRevision > 11);
  for (const [wrapperRevision, trailingSlots] of [[5, ['lib/view.tsx']], [4, ['prop body', 'app/page.tsx:2:1']]]) {
    const renderEdges = index.renderEdges.map(edge => [...edge.slice(0, 4), null, null, ...trailingSlots]);
    fs.writeFileSync(indexPath, JSON.stringify({ ...index, wrapperRevision, queryRevision: 8, graphRevision: 11, renderEdges }));
    const query = run(['query', 'who_renders', 'DashboardShell'], { NEORION_AUTOBUILD: '1' });
    assert.equal(query.status, 0, query.stderr);
    assert.match(query.stdout, /^\/  app\/page\.tsx/m);
    const refreshed = readJson(indexPath);
    assert.deepEqual(refreshed.renderEdges, index.renderEdges);
    assert.equal(refreshed.graphRevision, index.graphRevision);
  }
});

test('Codex setup installs the skill and prints config when Codex is unavailable', t => {
  const { home, root, run } = fixture(t);
  const setup = run(['setup', 'codex'], { PATH: home, Path: home });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /\[mcp_servers\.neorion\]/);
  assert.ok(setup.stdout.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(setup.stdout.includes(`args = ${JSON.stringify([entry, 'mcp'])}`));
  const skill = fs.readFileSync(path.join(home, '.agents/skills/neorion/SKILL.md'), 'utf8');
  assert.equal(skill, fs.readFileSync(path.join(packageRoot, 'skills/neorion/SKILL.md'), 'utf8'));
  const listedKinds = [...skill.matchAll(/^- `(\w+)`/gm)].map(([, kind]) => kind);
  const helpKinds = run(['--help']).stdout.match(/^Query kinds: (.+)$/m)[1].split(', ');
  assert.deepEqual(listedKinds.sort(), helpKinds.sort());
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

test('Codex inspection failure leaves the hint and skill absent', { skip: process.platform === 'win32' }, t => {
  const { home, root, run } = fixture(t);
  fs.writeFileSync(path.join(home, 'codex'),
    '#!/bin/sh\necho "registration failed" >&2\nexit 1\n', { mode: 0o755 });
  const setup = run(['setup', 'codex'], { PATH: home });
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /registration failed[\s\S]*CODEX_HOME/);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(home, '.agents/skills/neorion/SKILL.md')), false);
});

test('Codex setup chooses a temporary npm command or a quoted local entry', t => {
  const { home, root, run } = fixture(t);
  const cachedPackage = path.join(home, 'cache with spaces', '_npx', 'abc', 'node_modules', 'neorion');
  const cachedEntry = copyCli(cachedPackage);
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

test('Claude setup registers at user scope once, installs the skill and reverses only its changes', t => {
  const { home, root, run } = fixture(t);
  const { config, calls } = fakeAgent(home, 'claude');
  const env = { PATH: home };
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
  assert.match(hint, /If MCP is unavailable, run `node .+ query <kind> <target>`/);
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
  assert.ok(!fs.existsSync(path.dirname(skill)));
});

const setupFixture = file => path.join(__dirname, 'fixtures/setup', file);
const neorionHooks = settings => (settings.hooks?.PreToolUse ?? []).flatMap(group => group.hooks)
  .filter(hook => hook.args?.includes('neorion-query-advisory'));

test('Claude setup merges the advisory and removes only its own hook', t => {
  const { home, root, run } = fixture(t);
  fakeAgent(home, 'claude');
  const env = { PATH: home };
  const file = path.join(root, '.claude/settings.json');
  const source = setupFixture('claude-settings.json');
  const original = readJson(source);
  fs.mkdirSync(path.dirname(file));
  fs.copyFileSync(source, file);
  const installed = run(['setup', 'claude'], env);
  assert.equal(installed.status, 0, installed.stderr);
  const settings = readJson(file);
  const groups = settings.hooks.PreToolUse;
  assert.deepEqual(groups.slice(0, -1), original.hooks.PreToolUse);
  assert.deepEqual(settings.permissions, original.permissions);
  assert.deepEqual(settings.hooks.PostToolUse, original.hooks.PostToolUse);
  assert.equal(groups.at(-1).matcher, 'Grep|Glob');
  assert.equal(neorionHooks(settings).length, 1);
  const contents = fs.readFileSync(file, 'utf8');
  const repeated = run(['setup', 'claude'], env);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);

  // Preserve another handler added to the same matcher after setup.
  const shared = { type: 'command', command: 'another-search-hook' };
  groups.at(-1).hooks.push(shared);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  original.hooks.PreToolUse.push({ matcher: 'Grep|Glob', hooks: [shared] });
  for (let i = 0; i < 2; i++) {
    const removed = run(['setup', 'claude', '--remove'], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(readJson(file), original);
  }
});

test('Claude setup allows a CLI launch to take longer than the old spawn timeout', t => {
  const { home, run } = fixture(t);
  fakeAgent(home, 'claude');
  const spawn = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.ok(options.timeout > 15_000 && Number.isFinite(options.timeout));
    return spawnSync(command, args, options);
  });
  const result = run(['setup', 'claude', '--no-hook'], { PATH: home });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(spawn.mock.callCount(), 1);
});

test('Claude --no-hook leaves project settings alone or disables an installed advisory', t => {
  const { home, root, run } = fixture(t);
  fakeAgent(home, 'claude');
  const env = { PATH: home };
  const file = path.join(root, '.claude/settings.json');
  const optOut = () => {
    const result = run(['setup', 'claude', '--no-hook'], env);
    assert.equal(result.status, 0, result.stderr);
  };
  optOut();
  assert.ok(!fs.existsSync(file));
  assertQueryHint(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'));
  fs.mkdirSync(path.dirname(file));
  fs.copyFileSync(setupFixture('claude-settings.json'), file);
  const original = fs.readFileSync(file, 'utf8');
  optOut();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(run(['setup', 'claude', '--no-hint'], env).status, 0);
  assert.equal(neorionHooks(readJson(file)).length, 1);
  optOut();
  assert.deepEqual(readJson(file), JSON.parse(original));
});

test('Claude setup continues with skill and MCP changes when project settings are unsafe or invalid', async t => {
  for (const variant of ['settings symlink', 'directory symlink', 'invalid event']) {
    await t.test(variant, t => {
      const { home, root, run } = fixture(t);
      const { config } = fakeAgent(home, 'claude');
      const env = { PATH: home };
      const directory = path.join(root, '.claude');
      const file = path.join(directory, 'settings.json');
      const skill = path.join(home, '.claude/skills/neorion/SKILL.md');
      const hint = path.join(root, 'CLAUDE.md');
      const original = variant === 'invalid event' ? '{"hooks":{"PreToolUse":{}}}' : '{}';
      let target = file;
      if (variant === 'directory symlink') {
        const shared = path.join(home, 'shared');
        target = path.join(shared, 'settings.json');
        fs.mkdirSync(shared);
        fs.symlinkSync(shared, directory, 'junction');
      } else {
        fs.mkdirSync(directory);
        if (variant === 'settings symlink') {
          target = path.join(home, 'shared-settings.json');
          try {
            fs.symlinkSync(target, file, 'file');
          } catch (error) {
            if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
            return t.skip('Creating file symlinks requires Windows Developer Mode or administrator access');
          }
        }
      }
      fs.writeFileSync(target, original);

      const installed = run(['setup', 'claude'], env);
      assert.equal(installed.status, 0, installed.stderr);
      assert.match(installed.stderr, /Skipping Neorion Claude hook: (Claude settings path is a symbolic link|Invalid Claude hook configuration)/);
      assert.ok(fs.existsSync(hint));
      assert.ok(fs.existsSync(skill));
      assert.ok(readJson(config).mcpServers.neorion);
      const removed = run(['setup', 'claude', '--remove'], env);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(removed.stderr, '');
      assert.ok(!fs.existsSync(hint));
      assert.ok(!fs.existsSync(skill));
      assert.equal(readJson(config).mcpServers.neorion, undefined);

      const optedOut = run(['setup', 'claude', '--no-hook'], env);
      assert.equal(optedOut.status, 0, optedOut.stderr);
      assert.equal(optedOut.stderr, '');
      assert.ok(fs.existsSync(skill));
      assert.ok(readJson(config).mcpServers.neorion);
      assert.equal(fs.readFileSync(target, 'utf8'), original);
      assert.equal(fs.realpathSync(file), fs.realpathSync(target));
    });
  }
});

test('Claude installs the hook only in projects and skips the user settings directory', t => {
  const { home, root, env, run } = fixture(t);
  const { config } = fakeAgent(home, 'claude');
  fs.unlinkSync(path.join(root, 'tsconfig.json'));
  const result = run(['setup', 'claude'], { PATH: home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipping CLAUDE\.md hint/);
  assert.match(result.stderr, /^Skipping Neorion Claude hook: the current directory has no tsconfig\.json, jsconfig\.json, or package\.json\.$/m);
  assert.ok(!fs.existsSync(path.join(root, '.claude')));
  assert.ok(readJson(config).mcpServers.neorion);
  const atHome = (...flags) => spawnSync(process.execPath, [entry, 'setup', 'claude', '--no-hint', ...flags], {
    cwd: home, env: { ...env, PATH: home }, encoding: 'utf8'
  });
  for (const project of [false, true]) {
    if (project) fs.writeFileSync(path.join(home, 'package.json'), '{}');
    const installed = atHome();
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stderr, /^Skipping Neorion Claude hook: the current directory is your home directory\.$/m);
    assert.ok(!fs.existsSync(path.join(home, '.claude/settings.json')));
  }
  for (const flag of ['--no-hook', '--remove']) {
    const result = atHome(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
});

test('Claude cleans up created settings and prunes empty containers in legacy settings', t => {
  const { home, root, run } = fixture(t);
  fakeAgent(home, 'claude');
  const env = { PATH: home };
  const file = path.join(root, '.claude/settings.json');
  const setup = (...args) => {
    const result = run(['setup', 'claude', '--no-hint', ...args], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  };
  setup();
  setup();
  setup('--remove');
  assert.ok(!fs.existsSync(path.dirname(file)));

  fs.mkdirSync(path.dirname(file));
  setup();
  setup('--no-hook');
  assert.ok(!fs.existsSync(file));
  assert.ok(fs.existsSync(path.dirname(file)));
  fs.rmdirSync(path.dirname(file));

  setup();
  const sibling = path.join(path.dirname(file), 'settings.local.json');
  fs.writeFileSync(sibling, '{}');
  setup('--remove');
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(sibling, 'utf8'), '{}');

  setup();
  const settings = readJson(file);
  neorionHooks(settings)[0].args.pop();
  fs.writeFileSync(file, '\uFEFF{\r\n  // Keep project settings\r\n  "hooks": ' +
    JSON.stringify(settings.hooks) + ',\r\n  "permissions": {},\r\n}\r\n');
  setup('--no-hook');
  const preserved = fs.readFileSync(file, 'utf8');
  assert.match(preserved, /^\uFEFF/);
  assert.match(preserved, /\/\/ Keep project settings/);
  assert.doesNotMatch(preserved.replaceAll('\r\n', ''), /\n/);
  assert.deepEqual(parse(preserved.slice(1), [], { allowTrailingComma: true }), { permissions: {} });

  fs.writeFileSync(file, '{}\n');
  setup();
  setup('--remove');
  assert.deepEqual(readJson(file), {});
});

test('Claude hook setup preserves compact user groups and adjacent JSONC comments', t => {
  const { home, root, run } = fixture(t);
  fakeAgent(home, 'claude');
  const file = path.join(root, '.claude/settings.json');
  fs.mkdirSync(path.dirname(file));
  const group = '{ "matcher":"Grep|Glob", "hooks":[{"type":"command","command":"user-search"}] }';
  for (const [suffix, installedSuffix] of [[',', ','], [', // User search hook', ', // User search hook'],
    [' // User search hook', ', // User search hook'], ['', ',']]) {
    const userLine = `\t\t\t${group}${suffix}\r\n`;
    const original = '\uFEFF{\r\n\t"hooks": {\r\n\t\t"PreToolUse": [\r\n' + userLine + '\t\t]\r\n\t}\r\n}\r\n';
    fs.writeFileSync(file, original);
    const added = run(['setup', 'claude', '--no-hint'], { PATH: home });
    assert.equal(added.status, 0, added.stderr);
    const installed = fs.readFileSync(file, 'utf8');
    assert.ok(installed.includes(`\t\t\t${group}${installedSuffix}\r\n`));
    assert.equal(neorionHooks(parse(installed.slice(1))).length, 1);
    const removed = run(['setup', 'claude', '--remove', '--no-hint'], { PATH: home });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('Installed Claude hook suggests queries and exits silently when out of scope', t => {
  const { home, root, env, run } = fixture(t);
  fakeAgent(home, 'claude');
  const setup = run(['setup', 'claude'], { PATH: home });
  assert.equal(setup.status, 0, setup.stderr);
  const [hook] = neorionHooks(readJson(path.join(root, '.claude/settings.json')));
  assert.equal(hook.command, 'node');
  assert.equal(hook.onFailure, 'continue');
  const payload = (tool_name, pattern, searchPath, session = 'fixture-session') => JSON.stringify({
    session_id: session, cwd: root, hook_event_name: 'PreToolUse',
    tool_name, tool_input: { pattern, path: searchPath }, tool_use_id: 'fixture-tool'
  });
  const invoke = input => {
    const result = spawnSync(process.execPath, hook.args, { cwd: home, env, input, encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const manifest = path.join(root, 'package.json');
  const component = payload('Grep', '\\bDashboardShell\\b');
  fs.writeFileSync(manifest, '{"dependencies":{"next":"^15.0.0"}}');
  assert.equal(invoke(component), '');
  const graph = run(['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  const componentGlob = '**/*DashboardShell*.{tsx,ts}';
  for (const [input, kind, target] of [
    [component, 'who_renders', 'DashboardShell'],
    [payload('Glob', componentGlob, 'app', '../another/session'), 'who_renders', 'DashboardShell'],
    [payload('Glob', '**/app/settings/[id]/page.tsx'), 'wrappers', '/settings/[id]'],
    [payload('Grep', '/api/users'), 'api_consumers', '/api/users'],
    [payload('Grep', 'signOut'), 'search', 'signOut']
  ]) {
    const output = invoke(input);
    assert.equal(output.trimEnd().split('\n').length, 1);
    assert.deepEqual(JSON.parse(output), { hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Neorion index available. Try the \x60neorion_query\x60 tool (kind \x60${kind}\x60, target \x60${target}\x60).`
    } });
  }
  for (const input of ['{', ' '.repeat(17_000), component, payload('Glob', componentGlob, 'app'),
    payload('Bash', 'DashboardShell'), payload('Glob', '**/*.{tsx,ts}'),
    ...['Dashboard.*|Shell', 'Error', 'Promise', 'React', 'Props', '^export', '^import', 'useState', 'useCurrentUser',
      'className', '\\bonClick\\b', 'getServerSideProps', 'generateMetadata', 'dangerouslySetInnerHTML',
      'NextResponse', 'Metadata', 'ButtonProps', 'ButtonType']
      .map(pattern => payload('Grep', pattern))
  ]) {
    assert.equal(invoke(input), '', input);
  }
  fs.writeFileSync(manifest, '{"dependencies":{"react":"^19.0.0"}}');
  assert.equal(invoke(payload('Grep', 'DashboardShell', undefined, 'non-next-project')), '');
});

function assertCursorLauncher({ command, args, type }, releaseFallback = true) {
  assert.equal(command, 'node');
  assert.equal(type, 'stdio');
  assert.deepEqual([args[0], ...args.slice(2)], ['-e', '--', '${workspaceFolder}']);
  assert.ok(args[1].includes(cursorWorkspaceCli));
  assert.equal(args[1].includes(releaseSpec()), releaseFallback);
  assert.ok(!args[1].includes(entry));
}

test('Cursor uses the local CLI and keeps release fallback for single apps', async t => {
  for (const monorepo of [false, true]) {
    await t.test(monorepo ? 'monorepo' : 'single app', async subtest => {
      const { root, env, cache, home, run } = fixture(subtest);
      if (monorepo) {
        fs.rmSync(path.join(root, 'app'), { recursive: true });
        fs.rmSync(path.join(root, 'tsconfig.json'));
        fs.cpSync(path.join(__dirname, 'fixtures/monorepo'), root, { recursive: true });
      }
      const setup = run(['setup', 'cursor']);
      assert.equal(setup.status, 0, setup.stderr);
      const cached = path.join(cache, 'neorion', path.basename(cachePath(root)), cursorWorkspaceCli);
      assert.ok(fs.existsSync(cached));
      const config = readJson(path.join(root, '.cursor/mcp.json')).mcpServers.neorion;
      assertCursorLauncher(config, !monorepo);
      const launch = { ...config, args: config.args.map(arg => arg === '${workspaceFolder}' ? root : arg), cwd: home, env };
      if (monorepo) {
        fs.rmSync(path.dirname(cached), { recursive: true });
        const missing = spawnSync(launch.command, launch.args, { cwd: home, env, encoding: 'utf8', timeout: cliSpawnTimeout });
        assert.equal(missing.status, 1);
        assert.equal(missing.stdout, '');
        assert.match(missing.stderr, /Neorion MCP bundle missing.*neorion setup cursor.*workspace root/);
        const repaired = run(['setup', 'cursor']);
        assert.equal(repaired.status, 0, repaired.stderr);
        assert.ok(fs.existsSync(cached));
        assert.ok(fs.existsSync(path.join(path.dirname(cached), 'graph.cjs')));
        assert.deepEqual(readJson(path.join(root, '.cursor/mcp.json')).mcpServers.neorion, config);
      }
      await subtest.test('stdio', async serverTest => {
        const client = await openMcp(serverTest, root, launch);
        const result = await client.text('query', { kind: 'search', target: monorepo ? 'SharedCard' : 'DashboardShell' });
        if (monorepo) {
          assert.match(result, /^App: "apps\/admin"$/m);
          assert.match(result, /^App: "apps\/web"$/m);
          assert.match(result, /# complete: all listed apps$/);
          const selected = await client.text('query', { kind: 'search', target: 'SharedCard', app: 'web' });
          assert.match(selected, /^Project: .*[/\\]apps[/\\]web$/m);
          assert.doesNotMatch(selected, /^App:/m);
        } else assert.match(result, /app\/page\.tsx:1#DashboardShell/);
      });
      const removed = run(['setup', 'cursor', '--remove']);
      assert.equal(removed.status, 0, removed.stderr);
      assert.ok(!fs.existsSync(path.dirname(cached)));
    });
  }
});

test('Cursor setup merges MCP and shares the Claude hint, with idempotent project removal', t => {
  const { home, root, run } = fixture(t);
  fakeAgent(home, 'claude');
  const env = { PATH: home };
  const config = path.join(root, '.cursor/mcp.json');
  const rule = path.join(root, '.cursor/rules/neorion-query.mdc');
  const otherRule = path.join(root, '.cursor/rules/other.mdc');
  fs.mkdirSync(path.dirname(rule), { recursive: true });
  fs.copyFileSync(setupFixture('cursor-mcp.json'), config);
  fs.writeFileSync(otherRule, '# Existing rule\n');
  const original = fs.readFileSync(config, 'utf8');
  assert.equal(run(['setup', 'claude', '--no-hook'], env).status, 0);
  const added = run(['setup', 'cursor'], env);
  assert.equal(added.status, 0, added.stderr);
  const { neorion, ...otherServers } = readJson(config).mcpServers;
  assert.deepEqual(otherServers, JSON.parse(original).mcpServers);
  assertCursorLauncher(neorion);
  const hint = fs.readFileSync(rule, 'utf8');
  assert.match(hint, /^---\ndescription: .+\nalwaysApply: true\n---\n/);
  assertQueryHint(hint);
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(hint.includes(`npx -y ${releaseSpec()}`));
  assert.ok(!hint.includes(entry));
  const guidance = text => text.split('<!-- neorion:start -->\n')[1].split('<!-- neorion:state ')[0]
    .split('\nIf MCP is unavailable, run ')[0];
  assert.equal(guidance(hint), guidance(claude));
  const merged = fs.readFileSync(config, 'utf8');
  const repeated = run(['setup', 'cursor'], env);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, '');
  assert.equal(fs.readFileSync(config, 'utf8'), merged);
  assert.equal(fs.readFileSync(rule, 'utf8'), hint);
  for (let i = 0; i < 2; i++) {
    const removed = run(['setup', 'cursor', '--remove'], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.readFileSync(config, 'utf8'), original);
    assert.ok(!fs.existsSync(rule));
    assert.equal(fs.readFileSync(otherRule, 'utf8'), '# Existing rule\n');
  }
  assert.ok(!fs.existsSync(path.join(home, '.cursor')));
  const help = run(['--help']).stdout;
  assert.match(help, /setup claude .*--no-hook/);
  assert.match(help, /Claude Code 2\.1\.295\+/);
  assert.match(help, /setup cursor \[--remove\]/);
});

test('Cursor preserves compact JSONC and a pre-existing extension rule through setup and removal', t => {
  const { root, run } = fixture(t);
  const config = path.join(root, '.cursor/mcp.json');
  const extensionRule = path.join(root, '.cursor/rules/neorion.mdc');
  const setupRule = path.join(root, '.cursor/rules/neorion-query.mdc');
  fs.mkdirSync(path.dirname(extensionRule), { recursive: true });
  const original = '\uFEFF{\r\n  // Keep this server\r\n  "mcpServers": { "other": {"command":"keep"}, },\r\n}\r\n';
  fs.writeFileSync(config, original);
  const setup = (...args) => {
    const result = run(['setup', 'cursor', ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const extension = '---\nalwaysApply: true\n---\n<!-- neorion:start -->\nExtension guidance\n<!-- neorion:end -->\n';
  fs.writeFileSync(extensionRule, extension);
  setup();
  assert.ok(!fs.existsSync(setupRule));
  const merged = fs.readFileSync(config, 'utf8');
  assert.match(merged, /"mcpServers": \{ "other": \{"command":"keep"\}, "neorion": \{[^\r\n]+\}, \},\r\n/);
  assert.match(merged, /\/\/ Keep this server/);
  assert.equal(parse(merged.slice(1), [], { allowTrailingComma: true }).mcpServers.neorion.type, 'stdio');
  assert.equal(setup(), '');
  setup('--remove');
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(fs.readFileSync(extensionRule, 'utf8'), extension);

  // A project with both older rules loses only the CLI's marked block.
  fs.unlinkSync(extensionRule);
  setup();
  assert.ok(fs.existsSync(setupRule));
  fs.appendFileSync(setupRule, 'Keep this rule text.\n');
  fs.writeFileSync(extensionRule, extension);
  setup();
  assert.equal(fs.readFileSync(setupRule, 'utf8'), 'Keep this rule text.\n');
  assert.equal(fs.readFileSync(extensionRule, 'utf8'), extension);
});

test('Cursor migrates an owned local entry to a release archive and leaves a matching user entry intact', t => {
  const { root, cache, run } = fixture(t);
  const config = path.join(root, '.cursor/mcp.json');
  const state = path.join(cache, 'neorion', path.basename(cachePath(root)), '.neorion/cursor-setup-state.json');
  const implicit = mcpCommand({ localEntry: entry, root: '${workspaceFolder}' });
  const insertion = ', "neorion": ' + JSON.stringify(implicit);
  const prefix = '{"mcpServers":{"other":{"command":"keep"}';
  const original = prefix + '}}\n';
  const withServer = prefix + insertion + '}}\n';
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(config, withServer);
  fs.writeFileSync(state, JSON.stringify({
    configs: { Cursor: { createdFile: false, insertion, entry: implicit, hadGroup: true, hadNeorion: false } }
  }));
  const setup = (...args) => {
    const result = run(['setup', 'cursor', ...args]);
    assert.equal(result.status, 0, result.stderr);
  };
  setup();
  assertCursorLauncher(readJson(config).mcpServers.neorion);
  setup('--remove');
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  fs.writeFileSync(config, withServer);
  setup();
  setup('--remove');
  assert.equal(fs.readFileSync(config, 'utf8'), withServer);
});

test('Cursor reuses extension registry entries and gives guidance for conflicting servers', t => {
  const { root, run } = fixture(t);
  const config = path.join(root, '.cursor/mcp.json');
  const rule = path.join(root, '.cursor/rules/neorion-query.mdc');
  fs.mkdirSync(path.dirname(config));
  for (const options of [{ root: '${workspaceFolder}' }, { root: '${workspaceFolder}/apps/web', registryVersion: '0.5.2' },
    { root: '${workspaceFolder}', registryVersion: '0.5.2', platform: 'win32' },
    { root: '${workspaceFolder}', discover: true, platform: 'linux' },
    { root: '${workspaceFolder}', discover: true, platform: 'win32' },
    { root: '${workspaceFolder}', registryVersion: '0.5.2', useRelease: true }]) {
    const original = JSON.stringify({ mcpServers: { neorion: {
      ...mcpCommand(options), type: 'stdio'
    } } });
    fs.writeFileSync(config, original);
    const added = run(['setup', 'cursor']);
    assert.equal(added.status, 0, added.stderr);
    assert.ok(fs.existsSync(rule));
    assert.equal(fs.readFileSync(config, 'utf8'), original);
    const removed = run(['setup', 'cursor', '--remove']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!fs.existsSync(rule));
    assert.equal(fs.readFileSync(config, 'utf8'), original);
  }

  const conflict = '{"mcpServers":{"neorion":{"command":"another-server"}}}';
  fs.writeFileSync(config, conflict);
  const failed = run(['setup', 'cursor']);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Keep the existing entry or remove it.*before rerunning setup/);
  assert.equal(fs.readFileSync(config, 'utf8'), conflict);
  assert.ok(!fs.existsSync(rule));
});

test('Setup upgrades or removes a released 0.5.2 Codex skill and an untracked legacy registration', async t => {
  const legacySkill = path.join(__dirname, 'fixtures/neorion-0.5.2-skill.md');
  for (const mode of ['upgrade', 'direct removal', 'preserve customized server']) {
    await t.test(mode, t => {
      const { home, root, run } = fixture(t);
      const { config, calls } = fakeAgent(home, 'codex');
      const directory = path.join(home, '.agents/skills/neorion');
      const skill = path.join(directory, 'SKILL.md');
      const hintFile = path.join(root, 'AGENTS.md');
      const projectInstructions = '# Project instructions\n';
      const oldHint = 'For architecture questions, run `neorion query <kind> <target>` in the shell first.';
      fs.writeFileSync(hintFile, `<!-- neorion:start -->\n${oldHint}\n<!-- neorion:end -->\n${projectInstructions}`);
      const legacyEntry = mode === 'direct removal' ? mcpCommand({ registryVersion: '0.5.2' })
        : { command: process.execPath, args: [path.join(home, 'old/neorion/dist/neorion.cjs'), 'mcp'] };
      const customized = mode === 'preserve customized server';
      const server = { name: 'neorion', enabled: true, disabled_reason: null, enabled_tools: null,
        transport: { type: 'stdio', ...legacyEntry, env: customized ? { USER_SET: '1' } : null, env_vars: [], cwd: null } };
      fs.mkdirSync(directory, { recursive: true });
      fs.copyFileSync(legacySkill, skill);
      fs.writeFileSync(config, JSON.stringify({ mcpServers: { neorion: server } }));
      const env = { PATH: home };
      if (mode !== 'direct removal') {
        const upgraded = run(['setup', 'codex', '--local'], env);
        assert.equal(upgraded.status, 0, upgraded.stderr);
        assert.match(upgraded.stdout, /Skill installed/);
        assert.deepEqual(fs.readFileSync(skill), fs.readFileSync(path.join(packageRoot, 'skills/neorion/SKILL.md')));
        const hint = fs.readFileSync(hintFile, 'utf8');
        assertQueryHint(hint);
        assert.ok(!hint.includes(oldHint));
        if (!customized) assert.deepEqual(readJson(config).mcpServers.neorion.args, [entry, 'mcp']);
      }
      const removed = run(['setup', 'codex', '--remove'], env);
      assert.equal(removed.status, 0, removed.stderr);
      assert.ok(!fs.existsSync(skill));
      assert.equal(fs.readFileSync(hintFile, 'utf8'), projectInstructions);
      assert.deepEqual(readJson(config).mcpServers, customized ? { neorion: server } : {});
      assert.deepEqual(calls().filter(([, action]) => action !== 'get').map(([, action]) => action),
        customized ? [] : mode === 'upgrade' ? ['add', 'remove'] : ['remove']);
    });
  }
});

test('Claude repairs a stale owned registration with an absolute launcher on POSIX', {
  skip: process.platform === 'win32'
}, t => {
  const { home, root, run } = fixture(t);
  const { config, calls } = fakeAgent(home, 'claude');
  const checkout = path.join(home, 'old checkout', 'neorion');
  const stale = copyCli(checkout);
  const env = { PATH: home };
  assert.equal(run(['setup', 'claude'], env, stale).status, 0);
  fs.renameSync(checkout, path.join(home, 'moved'));
  assert.ok(!fs.existsSync(stale));
  fs.symlinkSync(entry, path.join(home, 'neorion'));
  const repaired = run(['setup', 'claude'], env);
  assert.equal(repaired.status, 0, repaired.stderr);
  const add = ['mcp', 'add', '--scope', 'user', 'neorion', '--'];
  assert.deepEqual(calls(), [[...add, process.execPath, stale, 'mcp'],
    ['mcp', 'remove', '--scope', 'user', 'neorion'], [...add, process.execPath, entry, 'mcp']]);
  const registered = { type: 'stdio', command: process.execPath, args: [entry, 'mcp'], env: {} };
  assert.deepEqual(readJson(config).mcpServers.neorion, registered);
  assert.deepEqual(readJson(path.join(home, '.claude/skills/neorion/.neorion-setup.json')).mcp.entry, registered);
  assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /run `neorion query <kind> <target>`/);
  assert.match(run(['setup', 'claude'], env).stdout, /MCP server unchanged/);
  assert.equal(calls().length, 3);
});

test('Claude setup from the npx cache pins both server and fallback to the package version', t => {
  const { home, root, run } = fixture(t);
  const { config } = fakeAgent(home, 'claude');
  const cached = copyCli(path.join(home, 'cache with spaces/_npx/abc/node_modules/neorion'));
  const setup = run(['setup', 'claude'], { PATH: home }, cached);
  assert.equal(setup.status, 0, setup.stderr);
  assert.deepEqual(readJson(config).mcpServers.neorion, { type: 'stdio', ...mcpCommand(), env: {} });
  const hint = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(hint.includes(`run \x60npx -y ${name}@${version} query`));
  assert.ok(!hint.includes('_npx'));
});

test('Claude setup honors CLAUDE_CONFIG_DIR and --remove --no-hint preserves the project hint', t => {
  const { home, root, run } = fixture(t);
  const claudeHome = path.join(home, 'custom config');
  const { config } = fakeAgent(home, 'claude', { claudeHome });
  const env = { PATH: home, CLAUDE_CONFIG_DIR: claudeHome };
  const file = path.join(root, 'CLAUDE.md');
  const directory = path.join(claudeHome, 'skills/neorion');
  const setup = run(['setup', 'claude'], env);
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(fs.existsSync(path.join(directory, 'SKILL.md')));
  assert.ok(readJson(config).mcpServers.neorion);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
  assert.ok(!fs.existsSync(path.join(home, '.claude.json')));
  const hint = fs.readFileSync(file, 'utf8');
  const removed = run(['setup', 'claude', '--remove', '--no-hint'], env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), hint);
  assert.deepEqual(readJson(config).mcpServers, {});
  assert.ok(!fs.existsSync(directory));
  assert.equal(run(['setup', 'claude', '--remove'], env).status, 0);
  assert.ok(!fs.existsSync(file));
});

test('A leftover setup lock reports a recovery path and leaves the project untouched', t => {
  const { home, root, run } = fixture(t);
  const lock = path.join(home, '.claude/skills/neorion/.neorion-setup.lock');
  fs.mkdirSync(lock, { recursive: true });
  const failed = run(['setup', 'claude'], { PATH: home });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /If no setup process is running, delete the lock directory and rerun setup/);
  assert.ok(failed.stderr.includes(lock));
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
  fs.rmdirSync(lock);
  assert.equal(run(['setup', 'claude'], { PATH: home }).status, 0);
  assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
});

test('A temporarily unreadable Claude config gets a retry message and preserves the file', t => {
  const { home, run } = fixture(t);
  const config = path.join(home, '.claude.json');
  fs.writeFileSync(config, '{');
  const failed = run(['setup', 'claude'], { PATH: home });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /wait and rerun setup/);
  assert.ok(failed.stderr.includes(config));
  assert.equal(fs.readFileSync(config, 'utf8'), '{');
  fs.writeFileSync(config, '{}');
  assert.equal(run(['setup', 'claude'], { PATH: home }).status, 0);
});

test('Removal tells the user how to retry a missing or broken agent and keeps its ownership record', t => {
  const { home, run } = fixture(t);
  const empty = path.join(home, 'empty');
  fs.mkdirSync(empty);
  for (const [agent, settings, scope] of [['claude', '.claude', ' --scope user'], ['codex', '.agents', '']]) {
    const { config } = fakeAgent(home, agent);
    const state = path.join(home, settings, 'skills/neorion/.neorion-setup.json');
    assert.equal(run(['setup', agent], { PATH: home }).status, 0);
    const original = readJson(state).mcp;
    for (const env of [{ PATH: empty }, { PATH: home, FAKE_REMOVE_FAILURE: '1' }]) {
      const failed = run(['setup', agent, '--remove'], env);
      assert.equal(failed.status, 1);
      assert.ok(failed.stderr.includes(`${agent} mcp remove${scope} neorion`));
      assert.doesNotMatch(failed.stderr, /spawnSync|ENOENT/);
      assert.deepEqual(readJson(state).mcp, original);
      assert.ok(readJson(config).mcpServers.neorion);
    }
    assert.equal(run(['setup', agent, '--remove'], { PATH: home }).status, 0);
    assert.deepEqual(readJson(config).mcpServers, {});
  }
});

test('An older Codex can use mcp add while an existing unowned entry stays intact', async t => {
  for (const oldCodex of ['json-list', 'text-list']) {
    await t.test(oldCodex, t => {
      const { home, run } = fixture(t);
      const { config, calls } = fakeAgent(home, 'codex', { oldCodex });
      const env = { PATH: home };
      const setup = run(['setup', 'codex'], env);
      assert.equal(setup.status, 0, setup.stderr);
      assert.match(setup.stdout, /MCP server registered/);
      const removed = run(['setup', 'codex', '--remove'], env);
      const custom = { mcpServers: { neorion: { command: 'custom' } } };
      assert.equal(removed.status, 0, removed.stderr);
      if (oldCodex === 'json-list') assert.deepEqual(readJson(config).mcpServers, {});
      else assert.match(removed.stdout, /Keeping existing MCP server/);
      fs.writeFileSync(config, JSON.stringify(custom));
      const preserved = run(['setup', 'codex'], env);
      assert.equal(preserved.status, 0, preserved.stderr);
      assert.match(preserved.stdout, /Keeping existing MCP server/);
      assert.deepEqual(readJson(config), custom);
      assert.equal(calls().filter(([, action]) => action === 'add').length, 1);
    });
  }
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
    if (process.platform === 'win32') assert.match(fallback.stdout, /Run this command in PowerShell/);
    assert.ok(fallback.stdout.includes(process.execPath));
    assert.ok(fallback.stdout.includes(entry));
    assert.equal(fs.readFileSync(config, 'utf8'), original);
  }
});

test('Codex setup and remove preserve unrelated servers and project text', t => {
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

test('Setup and remove preserve preexisting or modified Neorion skills and servers', t => {
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
      if (preexisting) assert.match(added.stdout, /Keeping existing skill \(not installed by this setup\)/);
      if (!preexisting) {
        fs.writeFileSync(config, JSON.stringify(custom));
        fs.writeFileSync(skill, 'Custom skill');
      }
      const removed = run(['setup', agent, '--remove'], env);
      assert.equal(removed.status, 0, removed.stderr);
      assert.match(removed.stdout, preexisting ? /Keeping existing MCP server \(not registered by this setup\)/ : /Keeping modified MCP server/);
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

test('Both setup targets write the project hint in a folder with only jsconfig.json', t => {
  const { home, root, run } = fixture(t);
  fs.renameSync(path.join(root, 'tsconfig.json'), path.join(root, 'jsconfig.json'));
  for (const [agent, file] of [['codex', 'AGENTS.md'], ['claude', 'CLAUDE.md']]) {
    const setup = run(['setup', agent], { PATH: home, Path: home });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /<!-- neorion:start -->/);
  }
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
    query = run(['query', 'search', 'DashboardShell'], {}, entry, monorepo);
  } finally {
    if (inaccessible) fs.chmodSync(path.join(monorepo, 'aaa-private'), 0o700);
  }
  assert.equal(query.status, 0, query.stderr);
  assert.equal(query.stdout.split('\n')[0], `Project: ${root}`);
  assert.match(query.stdout, /app\/page\.tsx:1#DashboardShell/);
});

test('subcommand help succeeds and invalid graph flags include usage', t => {
  const { run } = fixture(t);
  for (const args of [[], ['graph'], ['query'], ['mcp'], ['setup'], ['setup', 'codex'], ['setup', 'claude'], ['setup', 'cursor']]) {
    for (const flag of ['-h', '--help']) {
      const result = run([...args, flag], { PATH: '' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Usage:/m);
    }
  }
  assert.match(run(['query', 'search', '--', '-h']).stdout, /# search "-h"/);
  const invalid = run(['graph', '--unknown']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown option '--unknown'[\s\S]*Usage:/);
});

test('CLI and MCP suggest the dominant search kind beyond the visible rows', async t => {
  const { root, env, run } = fixture(t);
  for (const name of ['a', 'b', 'c']) {
    const directory = path.join(root, 'app', 'api', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() {}');
  }
  const args = { kind: 'search', target: 'api', limit: 1 };
  assert.match(run(['query', 'search', 'api', '--limit', '1']).stdout, /^# more: .*--kind api\)/m);
  const server = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
  assert.match(await server.text('query', args), /^# more: .*filter="api"\)/m);
});

test('root installation README scopes AI SDK evidence labels to source builds', () => {
  const readme = fs.readFileSync(path.join(packageRoot, '../README.md'), 'utf8');
  assert.match(readme, /In source builds,[^\n]*`\[mention\]`[^\n]*`\[possible URL override\]`/);
});

test('failed Codex MCP registration leaves the project hint and skill untouched', t => {
  const { root, home, run } = fixture(t);
  const mock = fakeAgent(home, 'codex');
  const env = { PATH: home + path.delimiter + process.env.PATH, FAKE_ADD_FAILURE: '1' };
  const hint = path.join(root, 'AGENTS.md');
  fs.writeFileSync(hint, '# Project instructions\n');
  const result = run(['setup', 'codex'], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot load Codex configuration[\s\S]*Check that CODEX_HOME/);
  assert.equal(fs.readFileSync(hint, 'utf8'), '# Project instructions\n');
  assert.equal(fs.existsSync(path.join(home, '.agents/skills/neorion')), false);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
  assert.equal(fs.existsSync(mock.config), false);
  assert.ok(mock.calls().some(([, action]) => action === 'add'));
  fs.mkdirSync(path.join(home, '.agents'));
  assert.equal(run(['setup', 'codex'], env).status, 1);
  assert.deepEqual(fs.readdirSync(path.join(home, '.agents')), []);
  fs.mkdirSync(path.join(home, '.agents/skills/other'), { recursive: true });
  assert.equal(run(['setup', 'codex'], env).status, 1);
  assert.deepEqual(fs.readdirSync(path.join(home, '.agents/skills')), ['other']);
});

test('declared React SDK ranges select the hook endpoint without installed types', t => {
  const { root, run } = fixture(t);
  for (const route of ['chat', 'custom']) {
    const directory = path.join(root, 'app', 'api', route);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function POST() {}');
  }
  fs.writeFileSync(path.join(root, 'app/chat.ts'), `
    import { useChat } from '@ai-sdk/react';
    export function useCustomChat() { return useChat({ api: '/api/custom' }); }
  `);
  const file = path.join(root, 'package.json');
  const query = route => run(['query', 'api_consumers', '/api/' + route]).stdout;
  for (const [range, send, other] of [['^1.2.0', 'custom', 'chat'], ['^2.0.0', 'chat', 'custom']]) {
    fs.writeFileSync(file, JSON.stringify({ dependencies: { '@ai-sdk/react': range } }));
    assert.match(query(send), /useCustomChat POST AI SDK transport/);
    assert.doesNotMatch(query(other), /useCustomChat POST AI SDK transport/);
  }
  fs.writeFileSync(file, JSON.stringify({ dependencies: { '@ai-sdk/react': '^1.2.0 || ^2.0.0' } }));
  for (const route of ['custom', 'chat']) assert.match(query(route), /useCustomChat POST AI SDK transport \[partial url\]/);
});

test('an app inherits the workspace SDK declaration and refreshes when it changes', t => {
  const { root, run } = fixture(t);
  const workspace = path.join(root, 'workspace');
  const app = path.join(workspace, 'apps', 'web');
  fs.mkdirSync(app, { recursive: true });
  for (const name of ['app', 'tsconfig.json']) fs.renameSync(path.join(root, name), path.join(app, name));
  for (const route of ['chat', 'custom']) {
    const directory = path.join(app, 'app', 'api', route);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function POST() {}');
  }
  fs.writeFileSync(path.join(app, 'app', 'chat.ts'), `
    import { useChat } from '@ai-sdk/react';
    export function useCustomChat() { return useChat({ api: '/api/custom' }); }
  `);
  const manifest = (dir, range, fields = {}) => fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ ...fields, dependencies: range ? { '@ai-sdk/react': range } : {} }));
  manifest(app, undefined, { name: 'web' });
  const consumer = /useCustomChat POST AI SDK transport/;
  const query = route => {
    const result = run(['query', 'api_consumers', '/api/' + route, '--root', app]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  manifest(workspace, '^2.0.0', { workspaces: ['apps/*'] });
  assert.match(query('chat'), consumer);
  assert.doesNotMatch(query('custom'), consumer);
  manifest(workspace, '^1.0.0', { workspaces: ['apps/*'] });
  assert.match(query('custom'), consumer);
  assert.doesNotMatch(query('chat'), consumer);
  manifest(app, '^2.0.0', { name: 'web' });
  assert.match(query('chat'), consumer);
  assert.doesNotMatch(query('custom'), consumer);
  manifest(app, 'catalog:', { name: 'web' });
  const yaml = path.join(workspace, 'pnpm-workspace.yaml');
  fs.writeFileSync(yaml, "packages:\n  - 'apps/*'\ncatalog:\n  '@ai-sdk/react': '^1.1.0'\n");
  assert.match(query('custom'), consumer);
  assert.doesNotMatch(query('chat'), consumer);
  fs.writeFileSync(yaml, "packages: [apps/*]\ncatalog: { '@ai-sdk/react': '^2.1.0' }\ncatalogs:\n  legacy: { '@ai-sdk/react': '~1.2.0' }\n");
  assert.match(query('chat'), consumer);
  assert.doesNotMatch(query('custom'), consumer);
  manifest(app, 'catalog:legacy', { name: 'web' });
  assert.match(query('custom'), consumer);
  assert.doesNotMatch(query('chat'), consumer);
  fs.unlinkSync(yaml);
  for (const route of ['custom', 'chat']) assert.match(query(route), /useCustomChat POST AI SDK transport \[partial url\]/);
});
