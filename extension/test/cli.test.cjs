const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openMcp } = require('./mcp-helpers.cjs');
const { mcpCommand } = require('./mcp-command.cjs');
const { indexFile } = require('./workspace-cache.cjs');

const { name, version } = require('../../neorion/package.json');
const packageRoot = path.resolve(__dirname, '../../neorion');
const entry = path.join(packageRoot, 'dist/neorion.cjs');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t, withStarter = true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace');
  const cache = path.join(temp, 'cache');
  const home = path.join(temp, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  if (withStarter) {
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"include":["app/**/*"],"compilerOptions":{"jsx":"preserve"}}');
    fs.writeFileSync(path.join(root, 'app/page.tsx'), 'function DashboardShell() { return <main />; }\nexport default function Page() { return <DashboardShell />; }\n');
  }
  const env = { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = process.env.PATH;
  const run = (args, overrides = {}, cliEntry = entry) => spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15_000
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
  assert.match(block, /# complete` covers the indexed static matches in the stated scope/);
  assert.match(block, /# partial: <reason>.*verify against the source/);
  assert.match(block, /If MCP is unavailable, run `.+ query <kind> <target>`/);
  assert.match(block, /`.+ query path <from> <to>`.*`.+ query changes`/);
}

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
  assert.match(query.stdout, /^Project: workspace$/m);
  assert.match(query.stdout, /app\/page\.tsx:2/);
  const miss = run(['query', 'who_renders', 'Dashboard']);
  assert.match(miss.stdout, /^# did you mean: app\/page\.tsx#DashboardShell \(declared at line 1\)$/m);
  assert.match(miss.stdout, /^# try: .+neorion\.cjs'? query search Dashboard --kind component --root .+$/m);
  assert.deepEqual(fs.readdirSync(root).sort(), ['app', 'package.json', 'tsconfig.json']);
});

test('CLI wrapper misses point to route search and suggest dynamic Pages Router patterns', t => {
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
    if (url !== pattern) {
      const concrete = run(['query', 'wrappers', url]);
      assert.equal(concrete.status, 0, concrete.stderr);
      assert.ok(concrete.stdout.includes(`# matching pattern: ${pattern} `), concrete.stdout);
      assert.match(concrete.stdout, /^# partial: target unresolved$/m);
    }
    const query = run(['query', 'wrappers', pattern]);
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
    '--limit', '1', '--root', project], { cwd: home, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(first.status, 0, first.stderr);
  const command = /^# more: \d+ \(try (.*), or narrow the text\)$/m.exec(first.stdout)?.[1];
  assert.ok(command?.includes(process.execPath), first.stdout);
  const second = spawnSync('/bin/sh', ['-c', command], { cwd: home, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^Project: selected project$/m);
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
  const server = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
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
  assert.match(missing.stderr, /no tsconfig\.json, jsconfig\.json, or package\.json with a next dependency/);
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

function projectFixture(root, env) {
  const next = { next: '15.5.8' };
  const put = (directory, file, value) => {
    const target = path.join(root, directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const pkg = (dir, name, options = {}) => put(dir, 'package.json', { name, ...options });
  const config = (dir, include) => put(dir, 'tsconfig.json', {
    include: [include], compilerOptions: { jsx: 'preserve' },
  });
  const page = (dir, file, marker) => put(dir, file, `export default function ${marker}() { return <main />; }\n`);
  const app = (dir, name, { route = 'app/page', configured = true, ownNext = true, marker = 'Page',
    include = route.split('/')[0] + '/**/*' } = {}) => {
    pkg(dir, name, ownNext ? { dependencies: next } : {});
    if (configured) config(dir, include);
    page(dir, route + (configured ? '.tsx' : '.jsx'), marker);
  };
  const library = (dir, file = 'index.ts', marker = 'ready', include = file) => {
    config(dir, include);
    put(dir, file, `export const ${marker} = true;\n`);
  };
  const tooling = dir => library(dir, 'check.ts', 'ready', '*.ts');
  const pnpm = (dir, patterns) => put(dir, 'pnpm-workspace.yaml',
    'packages:\n' + patterns.map(pattern => `  - '${pattern}'\n`).join(''));
  const gitInit = dir => {
    const git = spawnSync('git', ['init', '-q', path.join(root, dir)], { env, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr || git.error?.message);
  };
  return { next, put, pkg, config, page, app, library, tooling, pnpm, gitInit };
}

function markedExample(f, parent) {
  f.app(path.join(parent, 'examples/admin'), 'admin', { route: 'src/app/page', marker: 'AdminMarker' });
}

test('project selection follows the precedence rule for all PR #19 review probes', async t => {
  const cases = [
    ...['cypress', 'e2e', 'scripts', 'playwright', 'tests'].map(tool => ({
      name: `configless-src-app-${tool}`,
      build(f) {
        f.app('.', 'frontend', { route: 'src/app/page', configured: false });
        f.tooling(`${tool}/nested`);
      },
    })),
    {
      name: 'configured-src-pages-with-tooling',
      build(f) {
        f.app('.', 'frontend', { route: 'src/pages/index' });
        f.tooling('e2e');
      },
    },
    ...[false, true].map(declared => ({
      name: declared ? 'declared workspace discovers its app ahead of a base config' : 'workspace-config-with-child-next-and-ui',
      build(f) {
        f.pkg('.', 'workspace', declared ? { workspaces: ['apps/*'] } : {});
        f.library('.', 'bootstrap.ts');
        f.app('apps/web', 'web');
        f.library('packages/ui');
      },
      requests: [{ expected: declared ? 'apps/web' : '.' }],
    })),
    {
      name: 'workspace-shared-config-ui-first',
      build(f) {
        f.pkg('.', 'workspace');
        f.app('services/web', 'web', { configured: false });
        f.library('packages/ui');
      },
      requests: [{ expected: 'services/web' }],
    },
    {
      name: 'configured-root-with-nested-next',
      build(f) {
        f.app('.', 'frontend', { route: 'src/app/page' });
        f.app('apps/admin', 'admin');
      },
    },
    {
      name: 'hoisted-root-with-nested-next (original undeclared fixture)',
      build(f) {
        f.pkg('.', 'workspace', { dependencies: f.next });
        f.app('apps/web', 'web', { ownNext: false, route: 'src/app/page' });
        f.app('apps/web/examples/admin', 'admin');
      },
      requests: [{ from: 'apps/web', expected: 'apps/web', query: ['Page', /src\/app\/page\.tsx:1/] }, { expected: '.' }],
    },
    {
      name: 'configless-root-with-nested-next',
      build(f) {
        f.app('.', 'frontend', { route: 'src/app/page', configured: false });
        f.app('examples/admin', 'admin');
        f.tooling('cypress');
      },
      requests: [{ expected: '.', query: ['Page', /src\/app\/page\.jsx:1/] }],
    },
    ...[[true, true], [false, true], [false, false]].map(([configured, tooling]) => ({
      name: `routerless-root-${configured ? 'configured' : 'configless'}-${tooling ? 'with-tooling' : 'alone'}`,
      build(f) {
        f.pkg('.', 'frontend', { dependencies: f.next });
        if (configured) f.config('.', 'lib/*.ts');
        f.put('.', configured ? 'lib/index.ts' : 'lib/index.js', 'export const ready = true;');
        if (tooling) f.tooling('cypress');
      },
    })),
    {
      name: 'routerless-configured-monorepo-with-ui',
      build(f) {
        f.pkg('.', 'workspace');
        f.pkg('apps/web', 'web', { dependencies: f.next });
        f.library('apps/web', 'lib/index.ts');
        f.library('packages/ui');
        f.tooling('e2e');
      },
      requests: [{ expected: 'apps/web' }],
    },
    {
      name: 'no-next-packages-ui-with-src-app',
      build(f) {
        f.tooling('cypress');
        f.pkg('packages/ui', 'ui');
        f.library('packages/ui', 'src/app/index.ts', 'ready', 'src/**/*');
      },
      requests: [{ expected: 'cypress' }],
    },
    {
      name: 'Vite workspace keeps the first Cypress config when no package declares Next.js',
      build(f) {
        f.pkg('.', 'vite-workspace', { workspaces: ['packages/*'], devDependencies: { cypress: '15.9.0' } });
        f.put('.', 'cypress.config.js', "export default { e2e: { supportFile: 'cypress/support/e2e.ts' } };");
        f.library('cypress', 'support/e2e.ts', 'installAuthCommands', 'support/*.ts');
        f.pkg('packages/ui', '@vite/ui', { devDependencies: { vite: '7.1.2' } });
        f.library('packages/ui', 'src/app/index.ts', 'mountUi', 'src/**/*');
      },
      requests: [{ expected: 'cypress', query: ['installAuthCommands', /support\/e2e\.ts:1#installAuthCommands/] }],
    },
    {
      name: 'tooling config remains available when it is the only project',
      build(f) { f.tooling('cypress'); },
      requests: [{ expected: 'cypress' }],
    },
    {
      name: 'explicit-ui-with-next-example',
      build(f) {
        f.pkg('.', 'ui');
        f.library('.');
        f.app('examples/web', 'example');
      },
      requests: [{ expected: '.', query: ['ready', /index\.ts:1/] }],
    },
    {
      name: 'turbo-mixed-config',
      build(f) {
        f.put('.', 'turbo.json', { tasks: {} });
        f.pkg('.', 'workspace');
        f.app('apps/alpha', 'alpha', { configured: false });
        f.app('apps/zeta', 'zeta');
        f.library('packages/ui');
      },
      requests: [{ expected: 'apps/zeta' }],
    },
    ...['checkout', 'checkout without outer Next', 'out-of-pattern', 'checkout with routed utility'].map(boundary => ({
      name: `nested explicit root (${boundary})`,
      build(f) {
        const checkout = 'checkouts/standalone-tools';
        const utility = checkout + '/packages/utility';
        const dependencies = boundary === 'checkout without outer Next' ? undefined : f.next;
        f.pkg('.', 'outer-next', { workspaces: ['apps/*'], dependencies });
        f.pkg(checkout, 'standalone-tools');
        f.library(checkout, 'src/root.ts', 'RootMarker', 'src/**/*');
        if (boundary.startsWith('checkout')) f.gitInit(checkout);
        f.pkg(utility, 'utility');
        f.library(utility, 'src/app/index.ts', 'UtilityMarker', 'src/**/*');
        if (boundary === 'out-of-pattern' || boundary === 'checkout with routed utility') {
          f.put(utility, 'src/app/route.ts', 'export function GET() { return new Response(); }');
        }
      },
      requests: [{ from: 'checkouts/standalone-tools', expected: 'checkouts/standalone-tools', query: ['RootMarker', /src\/root\.ts:1/] }],
    })),
    ...[false, true].flatMap(utility => [false, true].map(ancestor => ({
      name: `hoisted workspace ${utility ? 'with non-route utility' : 'alone'} (${ancestor ? 'ancestor dependency' : 'root dependency'})`,
      build(f) {
        const ws = ancestor ? 'workspace' : '.';
        if (ancestor) f.pkg('.', 'checkout', { devDependencies: f.next });
        f.pkg(ws, 'workspace', { workspaces: ['apps/*'], devDependencies: ancestor ? undefined : f.next });
        f.app(path.join(ws, 'apps/web'), 'web', { ownNext: false, route: 'src/app/page', marker: 'WebPage' });
        if (utility) {
          f.pkg(path.join(ws, 'apps/aaa-utils'), 'aaa-utils');
          f.library(path.join(ws, 'apps/aaa-utils'), 'src/app/index.ts', 'UtilityMarker', 'src/**/*');
        }
      },
      requests: [{ from: ancestor ? 'workspace' : '.', expected: ancestor ? 'workspace/apps/web' : 'apps/web',
        query: ['WebPage', /src\/app\/page\.tsx:1/], mcp: ancestor && utility }],
    }))),
    {
      name: 'workspace sharing Next.js selects its routed Pages Router member',
      build(f) {
        f.pkg('.', 'shared-next-workspace', { workspaces: ['apps/*'], dependencies: f.next });
        f.app('apps/web', '@workspace/web', { ownNext: false, route: 'src/pages/index', include: 'src/**/*' });
        f.put('apps/web', 'src/pages/api/health.ts', 'export default function health(req, res) { res.status(200).json({ ok: true }); }');
        f.put('apps/web', 'src/lib/health.ts', "export function fetchHealth() { return fetch('/api/health'); }");
      },
      requests: ['.', 'apps/web'].map(from => ({
        from, expected: 'apps/web',
        query: ['/api/health', /\/api\/health -> src\/pages\/api\/health\.ts:1[^\n]*\nsend +src\/lib\/health\.ts:1 fetchHealth GET fetch/, 'api_consumers'],
      })),
    },
    ...['package-json', 'pnpm-yaml', 'undeclared', 'pnpm configless'].map(manager => ({
      name: `hoisted-${manager} explicit with distinct markers`,
      build(f) {
        f.pkg('.', 'workspace', { dependencies: f.next, workspaces: manager === 'package-json' ? ['apps/*'] : undefined });
        if (manager.startsWith('pnpm')) f.pnpm('.', ['apps/*']);
        f.app('apps/web', 'web', { ownNext: false, route: 'src/app/page', configured: manager !== 'pnpm configless', marker: 'WebMarker' });
        markedExample(f, 'apps/web');
      },
      requests: [{ from: 'apps/web', expected: 'apps/web', query: ['WebMarker', /src\/app\/page\.[jt]sx:1/] }],
    })),
    ...['ts', 'js', 'xml'].map(extension => ({
      name: `metadata-only with sitemap.${extension}`,
      build(f) {
        f.pkg('.', extension === 'xml' ? 'static-metadata-app' : 'metadata-app', { dependencies: f.next });
        if (extension === 'js') f.tooling('cypress');
        else f.config('.', 'src/**/*');
        f.put('.', `src/app/sitemap.${extension}`, extension === 'xml' ? '<urlset></urlset>'
          : 'export default function SitemapMarker() { return [{ url: "https://example.com" }]; }');
        markedExample(f, '.');
      },
      requests: [{ expected: '.', overview: '/sitemap.xml',
        query: extension === 'xml' ? ['AdminMarker', /0 results/] : ['SitemapMarker', /src\/app\/sitemap\.[jt]s:1/] }],
    })),
    ...[undefined, '{', '[]'].flatMap(manifest => [false, true].map(ancestor => ({
      name: `workspace glob with ${manifest || 'missing'} member manifest (${ancestor ? 'ancestor dependency' : 'root dependency'})`,
      build(f) {
        const ws = ancestor ? 'workspace' : '.';
        if (ancestor) f.pkg('.', 'checkout', { dependencies: f.next });
        f.pkg(ws, 'workspace', { workspaces: ['apps/*'], dependencies: ancestor ? undefined : f.next });
        f.library(ws, 'src/root.ts', 'RootMarker', 'src/**/*');
        const generated = path.join(ws, 'apps/generated');
        f.config(generated, 'src/**/*');
        f.page(generated, 'src/app/page.tsx', 'TemplateMarker');
        if (manifest) f.put(generated, 'package.json', manifest);
      },
      requests: [{ from: ancestor ? 'workspace' : '.', expected: ancestor ? 'workspace' : '.', query: ['RootMarker', /src\/root\.ts:1/] }],
    }))),
    ...[
      ['pnpm-dot-explicit', ['apps/./*', 'apps/*/examples/*']],
      ['pnpm-dot-segment', ['apps/./*', '!apps/web/examples/**', 'examples/*'], 'examples/alternate'],
      ['pnpm-exclusion-first', ['!apps/web/examples/**', 'apps/**'], 'apps/web'],
    ].map(([name, patterns, workspaceExpected]) => ({
      name,
      build(f) {
        f.pkg('.', 'workspace', { dependencies: f.next });
        f.pnpm('.', patterns);
        f.app('apps/web', 'web', { route: 'src/app/page', ownNext: false, marker: 'WebMarker' });
        markedExample(f, 'apps/web');
        if (workspaceExpected) {
          f.app('examples/alternate', 'alternate', { route: 'src/app/page', marker: 'AlternateMarker' });
          f.library('.', 'src/root.ts', 'RootMarker', 'src/*.ts');
        }
      },
      requests: [{ from: 'apps/web', expected: 'apps/web', query: ['WebMarker', /src\/app\/page\.tsx:1/] },
        ...(workspaceExpected ? [{ expected: workspaceExpected,
          query: [workspaceExpected === 'apps/web' ? 'WebMarker' : 'AlternateMarker', /src\/app\/page\.tsx:1/] }] : [])],
    })),
    ...[
      ['normalized pnpm include', ['./apps//unused/.././*/', 'apps/*/examples/*'], true],
      ['pnpm exclusion before include', ['!./apps/web/examples/**', 'apps/**'], false],
      ['pnpm exclusion after include', ['apps/**', '!apps/web/examples/**'], false],
    ].map(([name, patterns, ownNext]) => ({
      name,
      build(f) {
        f.pkg('.', 'checkout', { dependencies: f.next });
        f.pkg('workspace', 'workspace', { workspaces: ['apps/**'] });
        f.pnpm('workspace', patterns);
        f.library('workspace', 'bootstrap.ts');
        f.app('workspace/apps/web', 'web', { ownNext, route: 'src/app/page', marker: 'WebMarker' });
        markedExample(f, 'workspace/apps/web');
      },
      requests: [{ from: 'workspace', expected: 'workspace/apps/web', query: ['WebMarker', /src\/app\/page\.tsx:1/] }],
    })),
    {
      name: 'ancestor dependency is available to a configless app outside workspace patterns',
      build(f) {
        f.pkg('.', 'checkout');
        f.pkg('projects', 'parent', { optionalDependencies: f.next, workspaces: ['apps/*'] });
        f.page('projects/checkouts/web', 'src/pages/index.jsx', 'WebMarker');
        markedExample(f, 'projects/checkouts/web');
      },
      requests: [{ from: 'projects/checkouts/web', expected: 'projects/checkouts/web', query: ['WebMarker', /src\/pages\/index\.jsx:1/] }],
    },
    {
      name: 'gitfile stops explicit inheritance and a workspace cannot enter the nested checkout',
      build(f) {
        f.pkg('.', 'outer', { workspaces: ['apps/**'] });
        f.library('.', 'bootstrap.ts');
        f.pkg('apps', 'hoisted', { dependencies: f.next });
        f.put('apps/checkout', '.git', 'gitdir: /unused/worktree');
        f.app('apps/checkout/web', 'web', { ownNext: false, configured: false, marker: 'WebMarker' });
        markedExample(f, 'apps/checkout/web');
      },
      requests: [{ from: 'apps/checkout/web', expected: 'apps/checkout/web/examples/admin' }, { expected: '.' }],
    },
    {
      name: 'workspace searches configured members beyond the generic fallback depth and skips tooling',
      build(f) {
        f.pnpm('.', ['packages/**', 'scripts/*']);
        f.app('packages/one/two/three/four/web', 'web', { route: 'src/pages/index' });
        f.app('scripts/fixture', 'fixture');
        f.library('config');
      },
      requests: [{ expected: 'packages/one/two/three/four/web' }],
    },
    {
      name: 'a route-less Next package takes precedence over a tooling config',
      build(f) {
        f.tooling('cypress');
        f.pkg('apps/web', 'web', { dependencies: f.next });
        f.put('apps/web', 'lib/index.js', 'export const ready = true;');
      },
      requests: [{ expected: 'apps/web' }],
    },
  ];

  for (const { name, build, requests = [{ expected: '.' }] } of cases) {
    await t.test(name, async t => {
      const { root, cache, env, run } = fixture(t, false);
      build(projectFixture(root, env));
      for (const { from = '.', expected, query, overview, mcp } of requests) {
        const requestedRoot = path.join(root, from);
        const graph = run(['graph', requestedRoot]);
        assert.equal(graph.status, 0, graph.stderr);
        const graphFile = /^Overview: (.+)$/m.exec(graph.stdout)?.[1];
        assert.ok(graphFile, graph.stdout);
        const expectedRoot = fs.realpathSync(path.join(root, expected));
        const cacheKey = createHash('sha256').update(expectedRoot).digest('hex');
        assert.equal(graphFile, path.join(cache, 'neorion', cacheKey, 'codebase_graph.md'), graph.stdout);
        if (overview) assert.ok(fs.readFileSync(graphFile, 'utf8').includes(overview));
        if (query) {
          const [target, matches, kind = 'search'] = query;
          const result = run(['query', kind, target, '--root', requestedRoot]);
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, matches);
          if (mcp) {
            const client = await openMcp(t, requestedRoot, {
              command: process.execPath, args: [entry, 'mcp'], cwd: requestedRoot, env,
            });
            const reply = await client.text('query', { kind, target });
            assert.equal(reply, result.stdout.trimEnd());
          }
        }
      }
    });
  }
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
  assert.match(override, /^send .* reconnectChat GET AI SDK transport$/m);
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
        customized ? [] : mode === 'upgrade' ? ['remove', 'add', 'remove'] : ['remove']);
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
    query = run(['query', 'search', 'DashboardShell', '--root', monorepo]);
  } finally {
    if (inaccessible) fs.chmodSync(path.join(monorepo, 'aaa-private'), 0o700);
  }
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /^Project: workspace\n/);
  assert.match(query.stdout, /app\/page\.tsx:1#DashboardShell/);
});
