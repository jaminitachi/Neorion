const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openMcp } = require('./mcp-helpers.cjs');
const { indexFile: indexPath } = require('./workspace-cache.cjs');

const entry = path.resolve(__dirname, '../../neorion/dist/neorion.cjs');
const source = path.join(__dirname, 'fixtures/impact-graph');

function fixture(t, reverse = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-graph-kinds-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  const cache = path.join(temp, 'cache');
  function copy(from, to) {
    fs.mkdirSync(to, { recursive: true });
    const entries = fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of reverse ? entries.reverse() : entries) {
      const source = path.join(from, entry.name);
      const destination = path.join(to, entry.name);
      if (entry.isDirectory()) copy(source, destination);
      else fs.copyFileSync(source, destination);
    }
  }
  copy(source, root);
  const env = { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache };
  const run = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trimEnd();
  };
  const query = (...args) => run(['query', ...args], { NEORION_AUTOBUILD: '0' });
  const build = () => {
    const overview = /^Overview: (.+)$/m.exec(run(['graph']))[1];
    return path.join(path.dirname(overview), indexPath);
  };
  return { root, env, run, query, build };
}

const stable = output => output.replace(/index \d{4}-\d\d-\d\dT\d\d:\d\dZ/g, 'index TIMESTAMP');

test('impact and callees trace indexed behavior consistently across CLI, MCP and file order', { timeout: 40_000 }, async t => {
  const { root, env, query, build } = fixture(t);
  const reversed = fixture(t, true);
  build();
  reversed.build();
  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  async function check(kind, target, options = {}, flags = []) {
    const output = query(kind, target, ...flags);
    assert.equal(query(kind, target, ...flags), output);
    assert.equal(await mcp.text('query', { kind, target, ...options }), output);
    assert.equal(stable(reversed.query(kind, target, ...flags)), stable(output));
    assert.ok(Buffer.byteLength(output.split('\n').slice(1).join('\n')) <= 6000);
    return output;
  }
  const impact = await check('impact', 'normalize');
  for (const evidence of [/api GET \/api\/items\/\[id\]/, /page \/b\/\[id\].*generateMetadata/,
    /page \/items.*\[cond\]/, /meta sitemap \/sitemap\.xml/, /action createItem/,
    /layout app\/\(main\)\/layout\.tsx  wraps 2 routes \(\/items, \/other\)/, /# tests: 1 file/,
    /# partial: tRPC client proxy not traced \(server\/router\.ts:4\)/]) assert.match(impact, evidence);
  assert.match(impact, /d1 call server\/router\.ts:4 create/);
  assert.doesNotMatch(impact, /api POST/);
  assert.match(query('search', 'prepareMutation'), /# neighbors: .*; tRPC client proxy not traced \(server\/router\.ts:4\)/);
  assert.match(query('impact', 'POST'), /# complete/);
  const typeUse = query('impact', 'exampleContext');
  assert.match(typeUse, /d1 module server\/router\.ts:9/);
  assert.match(typeUse, /# complete/);
  const constant = query('impact', 'DATA_SUFFIX');
  assert.match(constant, /d1 use server\/data\.ts:5 getData/);
  assert.match(constant, /page \/b\/\[id\]/);
  const shallow = query('impact', 'normalize', '--depth', '1');
  assert.match(shallow, /# partial: depth limit/);
  assert.match(query('impact', 'createItem', '--depth', '1'), /layout .*wraps 2 routes/);
  assert.match(query('impact', 'normalize', '--include-tests'), /normalize\.test\.ts:2.*\[test\]/);
  assert.match(query('impact', 'formatDate'), /# ambiguous impact/);
  assert.match(query('impact', 'lib/format-a.ts#formatDate'), /# complete/);
  assert.match(query('impact', 'components/chart.tsx#default'), /page \/items/);
  assert.match(query('impact', 'components/chart.tsx#Chart'), /\bd1 dyn /);
  assert.match(query('impact', 'parse'), /d1 call hooks\/use-items\.ts:4 onError/);
  assert.doesNotMatch(query('impact', 'parse'), /module lib\/normalize\.ts/);
  assert.match(query('impact', 'submitItem'), /action createItem/);
  const barrel = query('impact', 'CreateItem');
  assert.match(barrel, /page \/items/);
  assert.doesNotMatch(barrel, /components\/index\.ts/);
  assert.match(query('impact', 'middleware.ts'), /matcher: '\/items\/:path\*'/);

  const callees = await check('callees', 'createItem');
  assert.match(callees, /db\.\$transaction  server\/db\.ts#db/);
  assert.match(callees, /ext next\/cache  revalidatePath/);
  assert.match(callees, /: 2 project calls/);
  assert.match(callees, /^d1 call :7,10,11 \+1  normalize/m);
  assert.equal(callees.split('\n').filter(line => line.includes('  normalize  ')).length, 1);
  assert.match(callees, /# unresolved: 1 calls/);
  assert.doesNotMatch(callees, /anotherAction/);
  assert.match(query('callees', 'CreateItem'), /d1 action .*createItem/);
  assert.match(query('callees', 'useItems'), /fetch .*GET \/api\/items\/\[id\].*\(SWR key\)/);
  assert.doesNotMatch(query('callees', 'useItems'), /\bfetch .*mutate/);
  assert.match(query('callees', 'useItems', '--uses', '--depth', '2'), /d2 call .*parse/);
});

test('impact reports bounded hubs, timeout, and legacy index coverage', { timeout: 30_000 }, t => {
  const { root, query, run, build } = fixture(t);
  const hub = Array.from({ length: 200 }, (_, i) => `export function caller${i}() { return cn(); }`).join('\n');
  fs.writeFileSync(path.join(root, 'lib/hub.ts'), `export function cn() {}\n${hub}\n`);
  const actions = Array.from({ length: 6 }, (_, i) => `export async function extraAction${i}() { return normalize('extra'); }`);
  fs.appendFileSync(path.join(root, 'server/actions.ts'), '\n' + actions.join('\n') + '\n');
  const indexFile = build();
  const impact = query('impact', 'cn');
  assert.match(impact, /hub collapsed/);
  assert.match(impact, /200 callers in 1 files/);
  const actionImpact = query('impact', 'normalize');
  assert.match(actionImpact, /^actions: 7 in 1 file \(top: createItem /m);
  assert.match(actionImpact, /^page \/items.* via CreateItem > createItem/m);
  assert.match(actionImpact, /^d1 call .*createItem/m);
  assert.doesNotMatch(actionImpact, /^action /m);
  const timed = run(['query', 'impact', 'cn'], { NEORION_QUERY_DEADLINE_MS: '1', NEORION_AUTOBUILD: '0' });
  assert.match(timed, /# timeout impact/);
  assert.match(timed, /# partial: timed out/);
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(index.schema, 2);
  const cn = index.symbols.find(symbol => symbol.name === 'cn');
  assert.equal(index.references.filter(([target, file, , kind]) => target === cn.id && file === null && kind === 'call').length, 200);
  assert.equal(index.symbols.filter(symbol => symbol.name === 'parse').length, 1);
  delete index.graphRevision;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  assert.match(query('impact', 'cn'), /# partial: regenerate legacy index/);
  assert.match(run(['query', 'impact', 'cn']), /# complete/);
});

test('path gives the shortest directed chain from a page, symbol, or layout', { timeout: 30_000 }, async t => {
  const { root, env, query, build } = fixture(t);
  build();
  const directly = query('path', '/items', 'createItem');
  assert.match(directly, /: 2 hops /);
  assert.match(directly, /^0 route \/items.* Items$/m);
  assert.match(directly, /^1 render .*CreateItem \[cond\]$/m);
  assert.match(directly, /^2 action .*createItem -> server\/actions\.ts:6$/m);
  const fromFile = query('path', 'app/(main)/items/page.tsx', 'server/actions.ts#submitItem');
  assert.equal(fromFile, directly);
  const layout = query('path', '/other', 'createItem');
  assert.match(layout, /^1 wrap .*layout\.tsx:\d+ MainLayout$/m);
  assert.match(layout, /^5 action .*sidebar\.tsx:3 createItem/m);
  const noPath = query('path', '/other', '/api/items/1');
  assert.match(noPath, /no directed path/);
  assert.match(noPath, /to is reached from routes: \/b\/\[id\]/);
  assert.match(query('path', 'normalize', 'CreateItem'), /no directed path/);
  assert.match(query('path', '/b/review', '/api/items/1'), /^2 fetch .*GET \/api\/items\/\[id\]/m);
  assert.match(query('path', 'useItems', 'app/api/items/[id]/route.ts#GET'), /^1 fetch .*GET \/api\/items\/\[id\]/m);
  assert.match(query('path', 'normalize', 'normalize'), /: 0 hops /);
  assert.match(query('path', '/other', 'formatDate'), /# ambiguous path/);
  assert.match(query('search', 'getData'), /# neighbors: 2 caller files, 1 callees, reaches 2 routes/);
  assert.doesNotMatch(query('search', 'formatDate'), /# neighbors/);

  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  assert.equal(await mcp.text('query', { kind: 'path', target: '/items', to: 'createItem' }), directly);
  assert.equal((await mcp.call('query', { kind: 'path', target: '/items' })).isError, true);
});

test('tRPC resolves router paths, client aliases and server callers while reporting cache-only sites', { timeout: 40_000 }, async t => {
  const { root, env, query, build } = fixture(t);
  build();
  const target = 'server/trpc-routes.ts#invoices.total';
  const consumers = query('api_consumers', 'invoices.total');
  assert.match(consumers, /# ambiguous api_consumers invoices.total/);
  assert.match(consumers, /server\/trpc-routes.ts:12#invoices.total tRPC procedure/);
  assert.match(consumers, /server\/trpc-other.ts:6#invoices.total tRPC procedure/);
  assert.match(query('search', 'invoices.list'), /procedure server\/trpc-routes.ts:14#invoices.list/);
  assert.match(query('api_consumers', 'invoices.list'), /InvoicePanel \(useInfiniteQuery\)/);
  assert.match(query('api_consumers', 'invoices.changed'), /InvoicePanel \(useSubscription\)/);

  const create = query('api_consumers', 'invoices.create');
  assert.match(create, /2 caller sites/);
  assert.match(create, /InvoicePanel \(useMutation\)/);
  assert.match(create, /writeThroughFactory \(create\)/);
  assert.match(create, /# complete: indexed tRPC callers/);
  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  assert.equal(await mcp.text('query', { kind: 'api_consumers', target: 'invoices.create' }), create);
  assert.match(query('callees', 'invoices.create'), /d1 call :13  storeInvoice/);
  assert.match(query('callees', 'history.create'), /d1 call :13  storeInvoice/);
  assert.match(query('path', '/trpc-check', 'storeInvoice'), /2 trpc .*invoices.create/);
  assert.match(query('who_renders', 'invoices.create'), /page \/trpc-check/);
  const upstream = query('impact', 'calculateTotal');
  assert.match(upstream, /invoices.total/);
  assert.match(upstream, /page \/trpc-check/);
  assert.doesNotMatch(upstream, /trpc-cache|useDynamic|unrelated/);
  assert.match(query('callees', 'useDynamic'), /# partial: tRPC procedure target unresolved/);
  assert.match(query('path', 'useDynamic', 'calculateTotal'), /# partial: tRPC procedure target unresolved/);

  const dynamic = query('api_consumers', 'server/trpc-other.ts#invoices.total');
  assert.match(dynamic, /0 caller sites/);
  assert.match(dynamic, /# partial: tRPC procedure target unresolved/);
  const total = query('api_consumers', target);
  assert.match(total, /4 caller sites, 3 cache-only/);
  assert.match(total, /readThroughRouter \(total\)/);
  assert.match(total, /readThroughTransport \(query\)/);
  assert.match(total, /InvoicePanel \(useQuery\)/);
  assert.match(total, /InvoicePanel \(useSuspenseQuery\)/);
  for (const operation of ['invalidate', 'fetch', 'prefetch']) {
    assert.ok(total.split('\n').some(line => line.startsWith('cache-only app/trpc-cache/page.tsx:') && line.endsWith(`(${operation})`)));
  }
  assert.doesNotMatch(total, /unrelated/);
  assert.match(query('path', '/trpc-cache', target), /no directed path/);
});

function gitFixture(t) {
  const project = fixture(t);
  const { root, env } = project;
  const file = name => path.join(root, name);
  const edit = (name, transform) => fs.writeFileSync(file(name), transform(fs.readFileSync(file(name), 'utf8')));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Neorion Tests', '-c', 'user.email=tests@neorion.local', ...args], {
      cwd: root, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
      encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  for (const name of ['trpc.ts', 'trpc-module.d.ts', 'router.ts']) fs.unlinkSync(file('server/' + name));
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'Fixture');
  const changes = (...flags) => project.run(['query', 'changes', ...flags]);
  return { ...project, file, edit, git, changes };
}

test('changes maps code hunks, wrapper components, CSS, and config to affected routes', { timeout: 65_000 }, async t => {
  const { root, env, file, edit, git, changes } = gitFixture(t);
  const blank = changes();
  assert.match(blank, /0 files, 0 symbols, 0 routes/);
  assert.match(blank, /# complete: git diff HEAD/);

  edit('server/data.ts', text => text.replace("DATA_SUFFIX = ''", "DATA_SUFFIX = '!'"));
  const constant = changes();
  assert.match(constant, /changed server\/data\.ts:4 DATA_SUFFIX/);
  assert.match(constant, /route page \/b\/\[id\].*DATA_SUFFIX d2/);
  git('restore', 'server/data.ts');

  edit('server/actions.ts', text => text.replace('  const label', '  // Preserve the item label.\n  const label'));
  const comments = changes();
  assert.match(comments, /comment server\/actions\.ts:7 createItem \[comment only\]/);
  assert.match(comments, /1 files, 0 symbols, 0 routes/);
  assert.match(comments, /# complete: git diff HEAD/);
  git('restore', 'server/actions.ts');

  edit('lib/normalize.ts', text => text.replace('value.trim()', 'value.toLowerCase().trim()'));
  const body = changes();
  assert.match(body, /changed lib\/normalize\.ts:1-3 normalize \+1 -1/);
  assert.match(body, /route api GET \/api\/items\/\[id\]/);
  assert.doesNotMatch(body, /route api POST/);
  assert.match(body, /route page \/items /);
  assert.match(body, /route sitemap \/sitemap\.xml /);
  assert.match(body, /route page \/other /);
  git('restore', 'lib/normalize.ts');

  edit('components/providers.tsx', text => text.replace('<section>', '<section data-theme="dark">'));
  edit('app/(main)/layout.tsx', text => text.replace('<Sidebar />', '<Sidebar key="layout" />'));
  const wrappers = changes();
  assert.match(wrappers, /wraps components\/providers\.tsx#Providers : 2 routes/);
  assert.match(wrappers, /wraps app\/\(main\)\/layout\.tsx : 2 routes/);
  assert.match(wrappers, /route page \/items .* <- MainLayout d0, Providers d0/);
  git('restore', '.');

  edit('app/(main)/main.css', text => text.replace('black', 'white'));
  const stylesheet = changes();
  assert.match(stylesheet, /wraps app\/\(main\)\/layout\.tsx : 2 routes/);
  assert.match(stylesheet, /file app\/\(main\)\/main\.css \[layout stylesheet\]/);
  assert.match(stylesheet, /route page \/other/);
  git('restore', '.');

  edit('next.config.ts', text => text.replace('true', 'false'));
  edit('middleware.ts', text => text.replace('/items/', '/other/'));
  fs.mkdirSync(file('prisma'));
  fs.writeFileSync(file('prisma/schema.prisma'), 'model User { id Int @id }\n');
  const config = changes();
  assert.match(config, /file next\.config\.ts \[config: all routes\]/);
  assert.match(config, /middleware middleware\.ts.*matcher: '\/other\/:path\*'/);
  assert.match(config, /file prisma\/schema\.prisma \[schema\]/);
  const mcp = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
  assert.equal(await mcp.text('query', { kind: 'changes' }), config);
  assert.equal((await mcp.call('query', { kind: 'changes', scope: 'staged', base: 'main' })).isError, true);
  for (const base of ['--output=x', '-x', 'a b', '$(id)']) {
    assert.equal((await mcp.call('query', { kind: 'changes', base })).isError, true);
  }
});

test('changes supports Git scopes, renames, removed exports, and untracked components', { timeout: 65_000 }, t => {
  const { file, edit, git, changes } = gitFixture(t);
  edit('lib/normalize.ts', text => text.replace('value.trim()', 'value.toLowerCase()'));
  git('add', 'lib/normalize.ts');
  edit('components/providers.tsx', text => text.replace('<section>', '<section id="scope">'));
  const staged = changes('--staged');
  assert.match(staged, /changed lib\/normalize\.ts:1-3 normalize/);
  assert.doesNotMatch(staged, /providers\.tsx/);
  const worktree = changes('--unstaged');
  assert.match(worktree, /changed components\/providers\.tsx:1 Providers/);
  assert.doesNotMatch(worktree, /changed lib\/normalize\.ts/);

  edit('lib/normalize.ts', text => text.replace('value.toLowerCase()', 'value.toUpperCase()'));
  assert.match(changes('--staged'), /changed lib\/normalize\.ts:1-3 normalize.*\[worktree differs\]/);
  edit('lib/normalize.ts', text => '\n'.repeat(30) + text);
  const drift = changes('--staged');
  assert.match(drift, /\[worktree differs\]/);
  assert.match(drift, /# partial: worktree differs from staged/);
  assert.doesNotMatch(drift, /# complete/);
  edit('lib/normalize.ts', text => text.slice(30));
  git('switch', '-qc', 'topic');
  git('add', 'lib/normalize.ts');
  git('commit', '-qm', 'Normalize casing');
  const base = changes('--base', 'main');
  assert.match(base, /# changes merge-base main/);
  assert.match(base, /changed lib\/normalize\.ts:1-3 normalize/);
  assert.match(base, /changed components\/providers\.tsx:1 Providers/);
  assert.match(changes('--base', 'missing-ref'), /# partial: invalid base ref missing-ref/);
  git('restore', '.');

  git('mv', 'lib/format-a.ts', 'lib/format with space.ts');
  assert.match(changes(), /renamed lib\/format-a\.ts -> lib\/format with space\.ts/);
  git('commit', '-qm', 'Rename definition');
  edit('lib/format with space.ts', () => '');
  fs.unlinkSync(file('lib/format-b.ts'));
  const removed = changes();
  assert.match(removed, /removed lib\/format with space\.ts formatDate/);
  assert.match(removed, /deleted lib\/format-b\.ts/);
  git('restore', '.');

  fs.writeFileSync(file('components/added.tsx'), 'export function Added() { return <p>New</p>; }\n');
  edit('app/(main)/other/page.tsx', text => "import { Added } from '../../../components/added';\n" + text.replace('<main />', '<Added />'));
  const untracked = changes('--unstaged');
  assert.match(untracked, /changed components\/added\.tsx:1 Added/);
  assert.match(untracked, /route page \/other .*Added d1/);
});

test('changes disables the repository fsmonitor setting even when it rebuilds the graph', { timeout: 30_000 }, t => {
  const { git, run, file } = gitFixture(t);
  git('config', 'core.fsmonitor', 'true');
  const traceFile = file('.git/trace.jsonl');
  assert.match(run(['query', 'changes'], { GIT_TRACE2_EVENT: traceFile }), /# complete: git diff HEAD/);
  const invocations = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.event === 'start').map(event => event.argv.slice(1));
  assert.ok(invocations.some(args => args.includes('diff')));
  assert.ok(invocations.filter(args => args.includes('ls-files')).length >= 2);
  for (const args of invocations) assert.deepEqual(args.slice(0, 2), ['-c', 'core.fsmonitor=false']);
});

test('changes returns a partial result outside Git and scopes a nested project', { timeout: 40_000 }, t => {
  const plain = fixture(t);
  assert.match(plain.run(['query', 'changes']), /# partial: not a git repository/);
  const { root, file, git, run } = gitFixture(t);
  fs.mkdirSync(file('nested'));
  git('mv', 'tsconfig.json', 'app', 'components', 'lib', 'hooks', 'server', 'nested');
  git('commit', '-qm', 'Nest the project');
  fs.writeFileSync(file('outside.ts'), 'export const outside = true;\n');
  fs.appendFileSync(file('nested/lib/normalize.ts'), '\nexport const fresh = 1;\n');
  const nested = run(['query', 'changes', '--root', path.join(root, 'nested')]);
  assert.match(nested, /# outside project: 1 files/);
  assert.match(nested, /changed lib\/normalize\.ts:10 fresh/);
  assert.doesNotMatch(nested, /outside\.ts/);
});
