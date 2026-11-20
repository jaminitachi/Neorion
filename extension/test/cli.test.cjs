const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openMcp } = require('./mcp-helpers.cjs');

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
  const run = (args, overrides = {}) => spawnSync(process.execPath, [entry, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15_000
  });
  return { root, cache, home, env, run };
}

test('CLI, extension, plugin and marketplace versions agree', () => {
  const { version } = readJson(path.join(packageRoot, 'package.json'));
  assert.equal(version, readJson(path.join(__dirname, '../package.json')).version);
  assert.equal(version, readJson(path.join(packageRoot, '.claude-plugin/plugin.json')).version);
  assert.equal(version, readJson(path.join(packageRoot, '../.claude-plugin/marketplace.json')).plugins[0].source.version);
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

test('Codex setup installs the skill and prints config when Codex is unavailable', t => {
  const { home, run } = fixture(t);
  const setup = run(['setup', 'codex'], { PATH: home, Path: home });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /\[mcp_servers\.neorion\]/);
  assert.match(setup.stdout, /args = \["-y","neorion@0\.5\.0","mcp"\]/);
  assert.equal(fs.readFileSync(path.join(home, '.agents/skills/neorion/SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(packageRoot, 'skills/neorion/SKILL.md'), 'utf8'));
});
