const { cachePath } = require('./workspace-cache.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { generate } = require('./run.cjs');
const { openMcp } = require('./mcp-helpers.cjs');

const indexFile = '.neorion/index.v1.json';
const stamp = '2026-11-19T06:00:00.000Z';
const emptyIndex = () => ({
  schema: 1, coverage: 2, generator: 'neorion 0.4.0', generatedAt: stamp, root: '.',
  files: {}, symbols: [], routes: [], renderEdges: [], wrapChains: {}, routeWrap: {}, references: [], fetches: []
});

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, file, contents) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function saveIndex(root, index) {
  write(cachePath(root), indexFile, JSON.stringify(index));
}

async function program(t, base) {
  const root = temporary(t);
  if (base) fs.cpSync(base, root, { recursive: true, filter: file =>
    !['.git', 'node_modules', '.next', '.neorion', 'codebase_graph.md', 'neorion'].includes(path.basename(file)) });
  else write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve' }, include: ['**/*.ts', '**/*.tsx'] }));
  const files = {
    'app/structure/page.tsx': "import { WrapperInside } from '../../fixture/providers'; import { X, Y } from '../../fixture/client';\nexport default function Page() { return <WrapperInside><X/><Y/></WrapperInside>; }",
    'app/structure/layout.tsx': "import { Provider } from '../../fixture/providers';\nexport default function Layout({children}) { return Date.now() ? <Provider>{children}</Provider> : <main>{children}</main>; }",
    'app/api/neorion-test/route.ts': 'export function GET() {}',
    'app/api/neorion-test/[id]/route.ts': 'export function GET() {}',
    'fixture/client.tsx': "import { Tooltip as Imported } from 'recharts'; import * as External from 'widgets'; import { TIMEOUT_MS } from 'widgets';\nexport const Timeout = TIMEOUT_MS; export const X = Imported;\nexport const Y = External.Sub;\nexport function writeData() { return fetch('/api/neorion-test'); }",
    'fixture/providers.tsx': "import { QueryProvider } from 'widgets';\nexport function Provider({children}) { return <QueryProvider>{children}</QueryProvider>; }\nexport function WrapperInside({children}) { return <div>{children}</div>; }",
    'fixture/use-client.ts': "import { writeData as send } from './client';\nexport function useClient() { return send(); }",
    'fixture/entry.ts': "import { useClient } from './use-client';\nexport function start() { return useClient(); }",
    'fixture/reexports.ts': "export * from './client';",
    'fixture/destructure.test.ts': "export async function check() { const { writeData: run } = await import('./client');\nreturn run(); }",
    'fixture/dynamic.ts': "export async function dynamic() { return (await import('./client')).writeData(); }",
    'fixture/client.test.ts': "import { writeData } from './client';\nvi.mock(import('./client'), () => ({ writeData: () => {} }));\nwriteData();",
    'fixture/other.ts': '// writeData mention\nexport function writeData() {}\nexport function Triangle() {}',
    'fixture/a.tsx': 'export function Triangle() { return <div/>; }',
    'fixture/b.tsx': 'export function Triangle() { return <div/>; }',
    'fixture/c.tsx': 'export function Triangle() { return <div/>; }'
  };
  for (const [file, source] of Object.entries(files)) {
    if (file.startsWith('app/') && fs.existsSync(path.join(root, 'src/app'))) {
      write(root, 'src/' + file, source.replaceAll('../../fixture/', '../../../fixture/'));
    } else write(root, file, source);
  }
  if (!base) {
    for (let i = 0; i < 20; i++) write(root, `fixture/many-${i}.ts`, "export { writeData as again } from './client';");
  }
  await generate(root);
  const index = JSON.parse(fs.readFileSync(cachePath(root, indexFile), 'utf8'));
  index.generatedAt = stamp;
  saveIndex(root, index);
  return { root, index };
}

const requests = {
  who_renders: { component: 'fixture/client.tsx#X', direct: true },
  wrappers: { route: '/structure' },
  rename_impact: { symbol: 'fixture/client.tsx#writeData' },
  api_consumers: { route: '/api/neorion-test', callers: 2 },
  search: { text: 'writeData' }
};

for (const fixture of ['create-next-app', 'ai-chatbot']) {
  const directory = fixture === 'ai-chatbot' ? process.env.NEORION_BENCH_REPOS : process.env.NEORION_FIXTURES;
  test(`U1 five golden outputs for ${fixture}`, { skip: !directory }, async t => {
    const { root } = await program(t, path.join(directory, fixture));
    const client = await openMcp(t, root);
    const queries = fixture === 'create-next-app' ? requests : {
      who_renders: { component: 'DataStreamProvider', direct: true },
      wrappers: { route: 'app/(chat)/page.tsx' },
      rename_impact: { symbol: 'app/(chat)/actions.ts#deleteTrailingMessages' },
      api_consumers: { route: '/api/vote' },
      search: { text: 'data-stream' }
    };
    for (const [name, args] of Object.entries(queries)) {
      const output = await client.text(name, args);
      const file = path.join(__dirname, 'goldens', fixture, name + '.txt');
      // Coverage is exercised against synthetic fixtures below.
      assert.equal(output.replace(/# (?:complete|partial): [^\n]+$/, ''), fs.readFileSync(file, 'utf8'));
    }
  });
}

test('U2 all tools apply UTF-8, line and byte budgets with exact omission counts', async t => {
  const root = temporary(t);
  const index = emptyIndex();
  const wide = '한'.repeat(700);
  index.symbols.push({ id: 1, name: 'Target', file: 'target.tsx', line: 1, kind: 'component', exported: true, aliasOf: null });
  index.routes.push({ id: 20_000, kind: 'api', url: '/api/test', file: 'app/api/test/route.ts' });
  index.wrapChains.chain = [];
  index.routeWrap[2] = 'chain';
  for (let i = 2; i < 10_002; i++) {
    const file = `app/source-${String(i).padStart(5, '0')}/page.tsx`;
    index.symbols.push({ id: i, name: 'Parent' + i, file, line: 1, kind: 'component', exported: true, aliasOf: wide });
    index.routes.push({ id: i, kind: 'page', url: `/source-${i}`, file, component: i });
    index.renderEdges.push([i, 1, 8, 0]);
    index.references.push([1, file, 5, 'import', wide]);
    index.wrapChains.chain.push({ file, symbol: wide, line: 1, conditional: false });
    index.fetches.push({ file, line: 5, fn: wide, method: 'GET', via: 'fetch', url: '/api/test', route: 20_000 });
  }
  saveIndex(root, index);
  const client = await openMcp(t, root);
  for (const [tool, args, count, max] of [
    ['who_renders', { component: 'Target', direct: true, limit: 100 }, 20_000, 100],
    ['wrappers', { route: '/source-2', limit: 100 }, 10_001, 100],
    ['rename_impact', { symbol: 'Target' }, 10_001, 40],
    ['api_consumers', { route: '/api/test', limit: 100 }, 10_000, 100],
    ['search', { text: 'Parent', limit: 50 }, 10_000, 50]
  ]) {
    const output = await client.text(tool, args);
    const lines = output.split('\n');
    assert.match(lines.pop(), /^# partial: output truncated$/);
    const omitted = Number(/^# more: (\d+)/.exec(lines.pop())?.[1]);
    const shown = lines.slice(1).filter(line => !line.startsWith('#')).length;
    assert.ok(shown > 0 && shown <= max, tool);
    assert.equal(omitted, count - shown, tool);
    assert.ok(Buffer.byteLength(output) <= 6000, tool);
    assert.ok(lines.every(line => Buffer.byteLength(line) <= 400), tool);
  }
  const defaultLimit = await client.text('who_renders', { component: 'Target' });
  assert.equal(defaultLimit.split('\n').length, 43);
});

test('U3–U10 deterministic queries, ambiguity, suggestions, freshness, aliases, callers, rename traps and wrapper boundaries', async t => {
  const { root, index } = await program(t);
  const client = await openMcp(t, root);
  const outputs = Object.fromEntries(await Promise.all(Object.entries(requests).map(async ([tool, args]) =>
    [tool, await client.text(tool, args)])));
  for (let i = 0; i < 100; i++) assert.equal(await client.text('who_renders', requests.who_renders), outputs.who_renders);
  for (const key of ['symbols', 'routes', 'renderEdges', 'references', 'fetches']) index[key].reverse();
  for (const locations of Object.values(index.mentions)) locations.reverse();
  saveIndex(root, index);
  for (const [tool, args] of Object.entries(requests)) assert.equal(await client.text(tool, args), outputs[tool], tool);

  const ambiguous = await client.text('who_renders', { component: 'Triangle' });
  assert.match(ambiguous, /^# ambiguous /);
  assert.equal(ambiguous.split('\n').length, 5);
  assert.ok(ambiguous.split('\n').slice(1, -1).every(line => /^fixture\/[abc].tsx:1#Triangle component$/.test(line)));
  const typo = await client.text('rename_impact', { symbol: 'writeDta' });
  assert.match(typo, /0 results/);
  assert.match(typo, /^# did you mean: .*#writeData$/m);
  assert.ok(typo.split('\n').length <= 6);

  assert.match(outputs.who_renders, /^\/structure  app\/structure\/page.tsx:2  depth 1$/m);
  assert.match(await client.text('who_renders', { component: 'Y' }), /^\/structure/m);
  assert.match(await client.text('search', { text: 'fixture/client.tsx', kind: 'component' }), /alias of widgets#Sub/);
  assert.doesNotMatch(await client.text('search', { text: 'fixture/client.tsx', kind: 'component' }), /#Timeout/);
  assert.doesNotMatch(await client.text('api_consumers', { route: '/api/neorion-test', callers: 0 }), /^call/m);
  const callers = await client.text('api_consumers', { route: '/api/neorion-test', callers: 1 });
  assert.match(callers, /^call1 .*use-client.ts:2 writeData$/m);
  assert.doesNotMatch(callers, /^call2|\[test\]/m);
  assert.match(callers, /^# partial: caller depth limit$/m);
  assert.match(await client.text('api_consumers', { route: 'app/api/neorion-test/route.ts', includeTests: true }), /\[test\]/);
  assert.match(outputs.api_consumers, /^call2 .*entry.ts:2 useClient$/m);
  assert.match(outputs.rename_impact, /use  fixture\/use-client.ts:1,2  import as send/);
  assert.match(outputs.rename_impact, /# pass-through fixture\/reexports\.ts:1 \(no edit\)/);
  assert.doesNotMatch(outputs.rename_impact, /^use .*reexports.ts/m);
  assert.equal(outputs.rename_impact.match(/^use  fixture\/many-\d+\.ts:/gm).length, 20);
  assert.match(outputs.rename_impact, /vi\.mock key/);
  assert.match(outputs.rename_impact, /fixture\/destructure.test.ts:1,2 \[test\]  import as run/);
  assert.match(outputs.rename_impact, /# not affected: .*writeData \(comment\).*writeData \(different symbol\)/);
  assert.doesNotMatch(outputs.rename_impact, /^use .*other.ts/m);
  assert.match(outputs.wrappers, /branch A[\s\S]+branch B/);
  assert.match(outputs.wrappers, /Provider providers: QueryProvider \(external: widgets\) \[cond\]/);
  assert.doesNotMatch(outputs.wrappers, /WrapperInside/);
  assert.equal(await client.text('wrappers', { route: '/structure', includeExternal: true }), outputs.wrappers);

  const page = path.join(root, 'app/structure/page.tsx');
  fs.utimesSync(page, 1, 1);
  assert.equal(await client.text('who_renders', requests.who_renders), outputs.who_renders);
  const source = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, source.replace('function Page', 'function Test'));
  assert.equal(fs.statSync(page).size, index.files['app/structure/page.tsx'].size);
  fs.utimesSync(page, 1, 1);
  const stale = await client.text('who_renders', requests.who_renders);
  assert.match(stale, /stale 1 files; regenerate the index/);
  assert.match(stale, /^\/structure .* \[stale\]$/m);
});

test('U11 returns tool errors for absent or invalid indexes and escaping or invalid inputs', async t => {
  const root = temporary(t);
  const client = await openMcp(t, root);
  const missing = await client.call('search', { text: 'thing' });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text,
    'Neorion index missing or invalid. Run "Neorion: Generate Architecture Map" in VS Code.');
  saveIndex(root, { ...emptyIndex(), schema: 2 });
  assert.deepEqual(await client.call('search', { text: 'thing' }), missing);
  saveIndex(root, emptyIndex());
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'), 'dir');
  for (const component of ['../src/file.tsx#Foo', '/etc/file.tsx#Foo', 'escape/file.tsx#Foo']) {
    assert.equal((await client.call('who_renders', { component })).isError, true, component);
  }
  for (const invalid of [{ text: 'x' }, { text: 'fine', limit: 51 }, { text: 'fine', limit: null }, { text: 'fine', fake: 0 }]) {
    assert.equal((await client.call('search', invalid)).isError, true);
  }
  assert.match(await client.text('search', { text: 'thing' }), /0 results/);
});

test('who_renders follows a JSX callback returned by a hook to the page route', async t => {
  const root = temporary(t);
  fs.cpSync(path.join(__dirname, 'fixtures/render-factory'), root, { recursive: true });
  await generate(root);

  const client = await openMcp(t, root);
  const component = 'ui/editor.tsx#Editor';
  const routes = await client.text('who_renders', { component });
  assert.match(routes, /2 routes/);
  assert.match(routes, /^\/  app\/page\.tsx:3  depth 3 via DialogCallback > EditorDialog$/m);
  assert.match(routes, /^\/preview  app\/preview\/page\.tsx:3  depth 3 via DialogCallback > EditorDialog$/m);

  const direct = await client.text('who_renders', { component, direct: true });
  assert.match(direct, /^direct ui\/editor-dialog\.tsx:5#EditorDialog$/m);

  const dialog = await client.text('who_renders', { component: 'EditorDialog', direct: true });
  assert.match(dialog, /^direct ui\/editor-dialog\.tsx:9#DialogCallback$/m);
  assert.doesNotMatch(dialog, /UnusedCallback/);
});

test('wrappers list rendered providers in chain order for each branch', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{"compilerOptions":{"jsx":"preserve"}}');
  write(root, 'context.ts', 'export const ConfigContext = { Provider: null };');
  write(root, 'app/page.tsx', 'export default function Page() { return <main />; }');
  write(root, 'app/layout.tsx', [
    "import { Suspense, ExternalProvider, FallbackProvider } from 'widgets';",
    "import { ConfigContext } from '../context';",
    "import { ChildProvider } from './child-provider';",
    'function InlineProvider({children}) { return <ExternalProvider>{children}</ExternalProvider>; }',
    'export default function RootProvider({children}) {',
    '  return Date.now() ? <Suspense><ConfigContext.Provider><InlineProvider><ExternalProvider><ChildProvider>{children}</ChildProvider></ExternalProvider></InlineProvider></ConfigContext.Provider></Suspense>',
    '    : <FallbackProvider>{children}</FallbackProvider>;',
    '}'
  ].join('\n'));
  write(root, 'app/child-provider.tsx', [
    "import { ExternalProvider } from 'other-widgets';",
    'const ChildContext = { Provider: null };',
    'export function ChildProvider({children}) { return <ChildContext.Provider><ExternalProvider><fooProvider>{children}</fooProvider></ExternalProvider></ChildContext.Provider>; }'
  ].join('\n'));
  await generate(root);
  const client = await openMcp(t, root);
  const output = await client.text('wrappers', { route: '/' });
  assert.match(output, /^# providers \(outermost first, branch A\): RootProvider, ConfigContext\.Provider, InlineProvider, ExternalProvider \(external: widgets\), ChildProvider, ChildContext\.Provider, ExternalProvider \(external: other-widgets\)$/m);
  assert.match(output, /^# providers \(outermost first, branch B\): RootProvider, FallbackProvider \(external: widgets\)$/m);
  assert.match(output, /^1 app\/layout.tsx:5 RootProvider, Suspense \(external: widgets\) providers: ConfigContext\.Provider, InlineProvider, ExternalProvider \(external: widgets\) \[cond\]$/m);
  assert.match(output, /^2 app\/child-provider.tsx:3 ChildProvider providers: ChildContext\.Provider, ExternalProvider \(external: other-widgets\) \[cond\]$/m);
  assert.doesNotMatch(output, /context\.ts:|fooProvider/);
  assert.match(output, /^# complete: indexed wrapper chains$/m);
  const local = await client.text('wrappers', { route: '/', includeExternal: false });
  assert.match(local, /RootProvider providers: ConfigContext\.Provider, InlineProvider/);
  assert.match(local, /^# providers \(outermost first, branch B\): RootProvider, FallbackProvider \(external: widgets\)$/m);
  assert.doesNotMatch(local, /Suspense/);
});

test('helper-wrapped server actions appear in the graph and resolve to their runtime use sites', async t => {
  const root = temporary(t);
  fs.cpSync(path.join(__dirname, 'fixtures/server-actions'), root, { recursive: true });
  const overview = await generate(root);
  assert.match(overview, /^app\/page\.tsx > app\/actions\.ts#discard app\/actions\.ts#save app\/actions\.ts#signOut app\/actions\.ts#submit$/m);
  assert.match(overview, /^lib\/call\.ts > app\/actions\.ts#default app\/actions\.ts#discard app\/actions\.ts#helper app\/actions\.ts#picked app\/actions\.ts#plainHelper app\/actions\.ts#reexported app\/actions\.ts#save app\/actions\.ts#signOut$/m);
  assert.doesNotMatch(overview, /#(?:Options|Result|literal|typeOnly|mixed)/);

  const client = await openMcp(t, root);
  const query = target => client.text('query', { kind: 'api_consumers', target });
  for (const [name, lines] of [
    ['app/actions.ts#submit', ['app/page.tsx:12']],
    ['save', ['app/page.tsx:10,13', 'lib/call.ts:8']],
    ['discard', ['app/page.tsx:10,11', 'lib/call.ts:8']],
    ['signOut', ['app/page.tsx:14', 'lib/call.ts:4']],
    ['reexported', ['lib/call.ts:16']],
    ['plainHelper', ['lib/call.ts:16']],
    ['helper', ['lib/call.ts:17']],
    ['default', ['lib/call.ts:16']],
    ['defAct', ['lib/call.ts:16']],
    ['picked', ['lib/call.ts:16']],
    ['onlyInline', ['app/panels.tsx:9']],
    ['app/panels.tsx#ServerPanel.inline', ['app/panels.tsx:3']],
    ['unused', []]
  ]) {
    const output = await query(name);
    assert.match(output, /# complete: indexed server action callers$/m, name);
    assert.deepEqual(output.split('\n').filter(line => line.startsWith('call   ')).map(line => line.slice(7)), lines, name);
  }
  assert.match(await query('app/actions.ts#reexported'), /^# api_consumers app\/actions\.ts:19#reexported /m);
  assert.match(await query('reexportedElsewhere'), /^# api_consumers lib\/other-actions\.ts:4#reexportedElsewhere : 0 caller files /m);
  assert.match(await query('plainHelper'), /^# api_consumers app\/actions\.ts:21#plainHelper /m);
  assert.match(await query('helper'), /^# api_consumers app\/actions\.ts:28#helper /m);
  assert.match(await query('defAct'), /^# api_consumers app\/actions\.ts:22#default /m);
  assert.match(await query('submit'), /^# ambiguous api_consumers submit/m);
  assert.match(await query('inline'), /^# ambiguous api_consumers inline[^\n]*\napp\/panels\.tsx:2#ServerPanel\.inline server action\napp\/panels\.tsx:7#OtherPanel\.inline server action/m);
  assert.match(await query('singOut'), /^# did you mean: app\/actions\.ts:10#signOut$/m);
  assert.match(await query('app/panels.tsx#onlyInlne'), /^# did you mean: app\/panels\.tsx:8#OtherPanel\.onlyInline$/m);
  assert.match(await query('literal'), /^# partial: target unresolved$/m);

  const files = ['app/actions.ts', 'lib/other-actions.ts', 'app/page.tsx', 'app/panels.tsx', 'lib/call.ts', 'lib/reex.ts'];
  const reexports = () => JSON.parse(fs.readFileSync(cachePath(root, indexFile), 'utf8')).serverActions
    .filter(action => action.name.startsWith('reexported')).sort((a, b) => a.name.localeCompare(b.name));
  const expected = reexports();
  for (const order of [files, [...files].reverse()]) {
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve' }, files: order }));
    assert.equal(await generate(root), overview);
    assert.deepEqual(reexports(), expected);
  }
});

test('star re-exported actions get a unique ID when the base ID is already registered', t => {
  const { buildSync } = require('esbuild');
  const { Project } = require('ts-morph');
  const { outputFiles } = buildSync({
    entryPoints: [path.join(__dirname, '../src/core/analyzers/ComponentAnalyzer.ts')],
    bundle: true, packages: 'external', platform: 'node', write: false
  });
  const analyzerModule = { exports: {} };
  new Function('module', 'require', outputFiles[0].text)(analyzerModule, require);
  const { ComponentAnalyzer } = analyzerModule.exports;

  const root = temporary(t);
  write(root, 'actions.ts', "'use server';\nexport * from './implementation';");
  write(root, 'implementation.ts', 'export async function run() {}');
  write(root, 'caller.ts', "import { run } from './actions';\nrun();");
  const project = new Project();
  const files = project.addSourceFilesAtPaths(path.join(root, '*.ts'));
  const barrel = project.getSourceFileOrThrow('actions.ts');
  // Pass the barrel twice to exercise a collision at the star re-export registration.
  const { actions, index } = new ComponentAnalyzer(root).analyze([barrel, ...files], [], true);
  assert.deepEqual(actions, ['action:actions.ts#run', 'action:actions.ts#run~2']);
  assert.deepEqual(index.serverActions, [
    { name: 'run', file: 'actions.ts', line: 2, callers: [] },
    { name: 'run', file: 'actions.ts', line: 2, callers: [['caller.ts', 2]] }
  ]);
});

test('rename impact lists same-file calls and references once without duplicating the declaration', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{}');
  write(root, 'queries.ts', [
    'export function getUser() {}',
    'export function first() { getUser(); }',
    'export const callback = getUser;',
    'export const object = { getUser };',
    'export function other(getUser: () => void) { getUser(); }',
    'export function second() { getUser(); getUser(); }',
    'export function recurse(n: number) { if (n) recurse(n - 1); }'
  ].join('\n'));
  write(root, 'caller.ts', 'import { getUser } from "./queries";\ngetUser();');
  await generate(root);
  const client = await openMcp(t, root);
  const output = await client.text('rename_impact', { symbol: 'getUser' });
  assert.match(output, /^# rename_impact queries\.ts#getUser : 2 files /m);
  assert.deepEqual(output.split('\n').filter(line => /^(decl|use )/.test(line)), [
    'decl queries.ts:1', 'use  caller.ts:1,2', 'use  queries.ts:2,3,4,6'
  ]);
  const recurse = await client.text('rename_impact', { symbol: 'recurse' });
  assert.match(recurse, / : 1 file .*\ndecl queries\.ts:7\nuse  queries\.ts:7\n/);
});

test('API consumers count request sites and flag distinct generated files', async t => {
  const root = temporary(t);
  const index = emptyIndex();
  index.routes = [{ id: 1, url: '/api/data', file: 'app/api/data/route.ts', kind: 'api' }];
  const files = ['generated/a.ts', 'src/__generated__/a.tsx', 'a.generated.js', 'a.gen.ts', 'a.gen.tsx', 'a.gen.js', 'a.gen.mtsx', 'a.gen.cjs', 'a.d.ts', 'a.d.mts', 'a.d.cts'];
  index.fetches = [...files, 'z.ts', 'generated/a.ts', 'not-generated/b.ts'].map((file, i) => ({
    file, line: i + 1, route: 1, method: 'GET', via: 'fetch'
  }));
  saveIndex(root, index);
  const client = await openMcp(t, root);
  const output = await client.text('api_consumers', { route: '/api/data' });
  assert.match(output, /14 requests \(11 generated files\)/);
  const sends = output.split('\n').filter(line => line.startsWith('send'));
  assert.deepEqual(sends.slice(0, 2), ['send   not-generated/b.ts:14 GET fetch', 'send   z.ts:12 GET fetch']);
  assert.deepEqual(sends.slice(2).map(line => /^send +([^:]+):\d+ GET fetch \[generated\]$/.exec(line)?.[1]),
    [...files, 'generated/a.ts'].sort());
  index.fetches = index.fetches.slice(0, 1);
  saveIndex(root, index);
  const single = await openMcp(t, root);
  assert.match(await single.text('api_consumers', { route: '/api/data' }), /1 request \(1 generated file\)/);
});

test('API consumers count and label SWR reads, mutates, fallback keys, and other literals', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{"compilerOptions":{"jsx":"preserve"}}');
  write(root, 'app/api/user/route.ts', 'export function GET() {}');
  write(root, 'app/page.tsx', [
    'import useSWR, { mutate as invalidate, SWRConfig as Config } from "swr";',
    'export default function Page() {',
    '  useSWR("/api/user");',
    '  useSWR(["/api/user", 1]);',
    '  useSWR("/api/user");',
    '  invalidate("/api/user");',
    '  return <Config value={{ fallback: { "/api/user": {} } }} />;',
    '}'
  ].join('\n'));
  write(root, 'unrelated.test.ts', 'const value = { fallback: { "/api/user": {} } };');
  await generate(root);
  const client = await openMcp(t, root);
  const query = args => client.text('query', { kind: 'api_consumers', target: '/api/user', ...args });
  const output = await query({ includeTests: false });
  assert.match(output, / : 3 reads, 1 mutate, 1 fallback key \(index/);
  assert.deepEqual(output.split('\n').filter(line => line.startsWith('send')), [
    'send   app/page.tsx:3 Page GET SWR key', 'send   app/page.tsx:4 Page GET SWR key',
    'send   app/page.tsx:5 Page GET SWR key', 'send   app/page.tsx:6 Page ? SWR mutate',
    'send   app/page.tsx:7 Page ? SWR fallback key'
  ]);
  const limited = await query({ limit: 1 });
  assert.match(limited, / : 3 reads, 1 mutate, 1 fallback key, 1 route literal, showing 1 /);
  assert.match(await query(), /^send +unrelated\.test\.ts:1 \? route literal \[test\]$/m);
});

test('compact API queries cover route literals, SWR keys, wrappers, and uncertainty', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{}');
  write(root, 'app/api/widgets/[id]/route.ts', 'export function GET() {}');
  write(root, 'app/api/widgets/reserved/route.ts', 'export function GET() {}');
  write(root, 'app/api/ping/route.ts', 'export function GET() {}');
  write(root, 'widget.ts', [
    "import useSWR, { mutate as invalidate } from 'swr';",
    'export function update(id: string) { return invalidate(`/api/widgets/${id}?refresh=1`); }',
    'export const useWidget = () => useSWR(["/api/widgets/123", 1]);',
    'declare function request(input: string): void;',
    'export function wrapped(id: string) { request(`/api/widgets/${id}`); }',
    'export const key = `/api/widgets/456`;',
    'export function ping() { return fetch("/api/ping"); }'
  ].join('\n'));
  write(root, 'caller.ts', 'import { wrapped } from "./widget"; export const open = () => wrapped("123");');
  write(root, 'widget.test.ts', 'export const fixture = "/api/widgets/789";');
  await generate(root);
  const client = await openMcp(t, root);
  const query = async target => {
    const result = await client.request('tools/call', {
      name: 'neorion_query', arguments: { kind: 'api_consumers', target }
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return result.content[0].text;
  };
  const widgets = await query('/api/widgets/[id]');
  assert.match(widgets, /^send +widget\.ts:2 update \? SWR mutate \[partial url\]$/m);
  assert.match(widgets, /^send +widget\.ts:3 useWidget GET SWR key$/m);
  assert.match(widgets, /^send +widget\.ts:5 wrapped \? route literal \[partial url\]$/m);
  assert.match(widgets, /^send +widget\.ts:6 \? route literal$/m);
  assert.match(widgets, /^send +widget\.test\.ts:1 .*\[test\]$/m);
  assert.match(widgets, /^call1 +caller\.ts:1 wrapped$/m);
  assert.match(widgets, /^# partial: uncertain URL matches$/m);
  assert.match(await query('/api/widgets/reserved'), /^# partial: uncertain URL matches$/m);
  assert.match(await query('/api/ping'), /^# complete: indexed route literals/m);
  write(root, 'widget.ts', 'export const replacement = "/api/ping";');
  assert.match(await query('/api/ping'), /^# partial: stale index$/m);
});

test('only static trailing-slash URLs match the list route', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{}');
  for (const route of ['items', 'items/[id]', 'items/special', 'items-other', 'exact/[id]']) {
    write(root, `app/api/${route}/route.ts`, 'export function GET() {} export function POST() {}');
  }
  write(root, 'items.ts', [
    'declare const id: string;',
    'fetch("/api/items/" + id);',
    'fetch("/api/items/");',
    'fetch("/api/items/?limit=1");',
    'fetch("/api/items");',
    'const tail = "123";',
    'fetch("/api/exact/" + tail);',
    'declare function request(url: string): void;',
    'request("/api/items/" + id);',
    'fetch("/api/items/", { method: "POST" });',
    'fetch("/api/items?" + id);',
    'fetch(`/api/exact/123?${id ? `key=${id}` : ""}`);'
  ].join('\n'));
  await generate(root);
  const client = await openMcp(t, root);
  for (const route of ['items/[id]', 'items/special']) {
    const output = await client.text('api_consumers', { route: '/api/' + route });
    assert.match(output, /^send +items\.ts:2 GET fetch \[partial url\]$/m);
    assert.match(output, /^send +items\.ts:9 \? route literal \[partial url\]$/m);
    assert.match(output, /^# partial: uncertain URL matches$/m);
  }
  const list = await client.text('api_consumers', { route: '/api/items' });
  assert.deepEqual(list.match(/^send.*$/gm), [
    'send   items.ts:3 GET fetch [partial url]',
    'send   items.ts:4 GET fetch [partial url]',
    'send   items.ts:5 GET fetch',
    'send   items.ts:10 POST fetch [partial url]',
    'send   items.ts:11 GET fetch [partial url]'
  ]);
  assert.match(list, /^# partial: dynamic URL$/m);
  assert.doesNotMatch(await client.text('api_consumers', { route: '/api/items-other' }), /^send/m);
  const exact = await client.text('api_consumers', { route: '/api/exact/[id]' });
  assert.match(exact, /^send +items\.ts:7 GET fetch$/m);
  assert.match(exact, /^send +items\.ts:12 GET fetch$/m);
  assert.match(exact, /^# complete:/m);
});

test('template URLs resolve local and imported string constants and report unresolved suffixes', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{}');
  for (const route of ['local/[id]', 'imported/[id]', 'exact-local/[id]', 'exact-imported/[id]']) {
    write(root, `app/api/${route}/route.ts`, 'export function DELETE() {}');
  }
  write(root, 'paths.ts', 'export const remote = "/api/imported/"; export const exact = "/api/exact-imported"; export const key = "123";');
  write(root, 'barrel.ts', 'export { remote as prefix, exact, key } from "./paths";');
  write(root, 'public.ts', 'export * from "./barrel";');
  write(root, 'imported.ts', [
    'import { prefix, exact, key } from "./public";',
    'declare const id: string;',
    'fetch(`${prefix}${id}`, { method: "DELETE" });',
    'fetch(`${exact}/${key}`, { method: "DELETE" });'
  ].join('\n'));
  write(root, 'local.ts', [
    'const prefix = "/api/local" as const;',
    'const exact = "/api/exact-local"; const key = "123";',
    'declare const id: string;',
    'fetch(`${prefix}/${id}`, { method: "DELETE" });',
    'fetch(`${exact}/${key}`, { method: "DELETE" });'
  ].join('\n'));
  await generate(root);
  const client = await openMcp(t, root);
  for (const [source, dynamicLine, exactLine] of [['local', 4, 5], ['imported', 3, 4]]) {
    const dynamic = await client.text('api_consumers', { route: `/api/${source}/[id]` });
    assert.ok(dynamic.includes(`send   ${source}.ts:${dynamicLine} DELETE fetch\n`), dynamic);
    assert.match(dynamic, /^# complete:/m);
    const exact = await client.text('api_consumers', { route: `/api/exact-${source}/[id]` });
    assert.ok(exact.includes(`send   ${source}.ts:${exactLine} DELETE fetch\n`), exact);
    assert.match(exact, /^# complete:/m);
  }
});

test('API URL patterns retain literal segments after unknown path parameters', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{}');
  for (const route of [
    'groups/[group]/files/[file]/rotate', 'groups/[group]/files/[file]/rename',
    'groups/[group]/stores/[store]/files', 'groups/[group]/stores/[store]/members',
    'groups/static/files/[file]/rotate', 'groups/[group]/branding',
    'spanning/[...path]', 'orders', 'orders/[order]', 'orders/[order]/items',
    'folders/manage', 'rooms/[room]/folders/manage', 'unrelated/manage', 'maybe/nested/path/extra/tail', 'maybe/nested/path/extra/unrelated'
  ]) {
    write(root, `app/api/${route}/route.ts`, 'export function GET() {}');
  }
  write(root, 'patterns.ts', [
    "import { mutate } from 'swr';",
    'declare const group: string, id: string, pieces: string[];',
    'fetch("/api/groups/" + group + "/files/" + id + "/rotate");',
    'const key = `/api/groups/${group}/stores/${id}`;',
    'mutate(`${key}/files`);',
    'const joined = pieces.join("/"); fetch("/api/spanning/" + joined + "/tail");',
    'fetch("https://example.com/api/orders/" + id);',
    'fetch(process.env.API + "/api/orders/" + id);',
    'let base = "/api/orders";',
    'fetch(base + "/" + id);',
    'const urls = { orders: "/api/orders" };',
    'fetch(`${urls.orders}/${id}`);',
    'fetch(`https://example.com/api/orders/${id}`);',
    'fetch(`${process.env.API}/api/orders/${id}`);',
    'fetch(`/api/groups/${group}/files/${id}/rotate`);',
    'fetch("/api/orders/" + id);',
    'fetch(`/api/orders/${id}`);',
    'declare const condition: boolean;',
    'const target = condition ? `rooms/${id}/folders` : "folders";',
    'fetch(`/api/${target}/manage`);',
    'const maybe = condition ? "fixed" : `nested/${group}`;',
    'fetch("/api/maybe/" + maybe + "/tail");',
    'fetch(condition ? `/api/orders/${id}` : "/api/other");'
  ].join('\n'));
  await generate(root);
  const client = await openMcp(t, root);
  const query = route => client.text('api_consumers', { route: '/api/' + route });
  const rotate = await query('groups/[group]/files/[file]/rotate');
  assert.match(rotate, /^send +patterns\.ts:3 GET fetch \[partial url\]$/m);
  assert.match(rotate, /^send +patterns\.ts:15 GET fetch \[partial url\]$/m);
  assert.match(await query('groups/[group]/stores/[store]/files'), /^send +patterns\.ts:5 \? SWR mutate \[partial url\]$/m);
  assert.match(await query('spanning/[...path]'), /^send +patterns\.ts:6 GET fetch \[partial url\]$/m);
  const staticRotate = await query('groups/static/files/[file]/rotate');
  assert.match(staticRotate, /^send +patterns\.ts:3 GET fetch \[partial url\]$/m);
  assert.match(staticRotate, /^send +patterns\.ts:15 GET fetch \[partial url\]$/m);
  for (const route of ['folders/manage', 'rooms/[room]/folders/manage']) {
    assert.match(await query(route), /^send +patterns\.ts:20 GET fetch \[partial url\]$/m);
  }
  assert.match(await query('maybe/nested/path/extra/tail'), /^send +patterns\.ts:22 GET fetch \[partial url\]$/m);
  for (const route of ['groups/[group]/files/[file]/rename', 'orders/[order]/items', 'unrelated/manage',
    'maybe/nested/path/extra/unrelated', 'groups/[group]/stores/[store]/members', 'groups/[group]/branding']) {
    assert.doesNotMatch(await query(route), /^send/m);
  }
  const orders = await query('orders/[order]');
  for (const line of [7, 8, 10, 12, 13, 14]) {
    assert.match(orders, new RegExp(`^send +patterns\\.ts:${line} GET fetch \\[partial url\\]$`, 'm'));
  }
  assert.match(orders, /^send +patterns\.ts:16 GET fetch$/m);
  assert.match(orders, /^send +patterns\.ts:17 GET fetch$/m);
  assert.match(orders, /^send +patterns\.ts:23 GET fetch \[partial url\]$/m);
  assert.match(orders, /^# partial:/m);
  assert.doesNotMatch(await query('orders'), /^send .*fetch/m);
});

test('conditional API path slots widen only for resolved slash-containing branches', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{}');
  for (const route of [
    'paths/folders/manage', 'paths/rooms/[room]/folders/manage', 'paths/other/manage',
    'orders', 'orders/[order]', 'orders/[order]/items', 'orders/[order]/items/extra'
  ]) {
    write(root, `app/api/${route}/route.ts`, 'export function GET() {}');
  }
  write(root, 'paths.ts', [
    'declare const condition: boolean, id: string;',
    'export const target = condition ? `rooms/${id}/folders` : "folders";'
  ].join('\n'));
  write(root, 'calls.ts', [
    'import { target } from "./paths";',
    'declare const condition: boolean, id: string, input: { id: string };',
    'fetch(`/api/paths/${target}/manage`);',
    'let mutable = condition ? `rooms/${id}/folders` : "folders";',
    'fetch(`/api/paths/${mutable}/manage`);',
    'const paths = { target: condition ? `rooms/${id}/folders` : "folders" };',
    'fetch(`/api/paths/${paths.target}/manage`);',
    'const nullable = condition ? id : null;',
    'fetch(`/api/orders/${nullable}/items`);',
    'const optional = condition ? input.id : undefined;',
    'fetch(`/api/orders/${optional}`);',
    'fetch(`/api/orders/${condition ? id : ""}`);',
    'fetch(`/api/orders/${condition ? null : ""}`);'
  ].join('\n'));
  await generate(root);
  const client = await openMcp(t, root);
  const query = route => client.text('api_consumers', { route: '/api/' + route });
  for (const route of ['paths/folders/manage', 'paths/rooms/[room]/folders/manage']) {
    const result = await query(route);
    for (const line of [3, 5, 7]) {
      assert.match(result, new RegExp(`^send +calls\\.ts:${line} GET fetch \\[partial url\\]$`, 'm'));
    }
  }
  assert.doesNotMatch(await query('paths/other/manage'), /^send +calls\.ts:3 /m);
  const items = await query('orders/[order]/items');
  assert.match(items, /^send +calls\.ts:9 GET fetch$/m);
  assert.match(items, /^# complete:/m);
  const order = await query('orders/[order]');
  assert.match(order, /^send +calls\.ts:11 GET fetch$/m);
  assert.match(order, /^send +calls\.ts:12 GET fetch$/m);
  assert.doesNotMatch(order, /^send +calls\.ts:13 /m);
  assert.match(order, /^# complete:/m);
  const orders = await query('orders');
  assert.match(orders, /^send +calls\.ts:12 GET fetch \[partial url\]$/m);
  assert.match(orders, /^send +calls\.ts:13 GET fetch \[partial url\]$/m);
  assert.doesNotMatch(await query('orders/[order]/items/extra'), /^send/m);
});

test('empty conditional URL fragments preserve routes with and without optional segments', async t => {
  const root = temporary(t);
  write(root, 'tsconfig.json', '{}');
  const routes = ['teams/[teamId]/views', 'teams/[teamId]/groups/[groupId]/views'];
  for (const route of routes) {
    write(root, `app/api/${route}/route.ts`, 'export function GET() {}');
  }
  write(root, 'calls.ts', [
    'declare const teamId: string, groupId: string | undefined;',
    'fetch(`/api/teams/${teamId}${groupId ? `/groups/${groupId}` : ""}/views`);',
    'fetch("/api/teams/" + teamId + (groupId ? "/groups/" + groupId : "") + "/views");',
    'const groupPath = groupId ? `/groups/${groupId}` : "";',
    'fetch(`/api/teams/${teamId}${groupPath}/views`);'
  ].join('\n'));
  await generate(root);
  const client = await openMcp(t, root);
  for (const route of routes) {
    const result = await client.text('api_consumers', { route: '/api/' + route });
    for (const line of [2, 3, 5]) {
      assert.match(result, new RegExp(`^send +calls\\.ts:${line} GET fetch \\[partial url\\]$`, 'm'));
    }
  }
});
