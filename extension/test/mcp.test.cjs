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
  schema: 1, generator: 'neorion 0.4.0', generatedAt: stamp, root: '.',
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
  write(root, indexFile, JSON.stringify(index));
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
  const index = JSON.parse(fs.readFileSync(path.join(root, indexFile), 'utf8'));
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
      assert.equal(output + '\n', fs.readFileSync(file, 'utf8'));
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
    const omitted = Number(/^# more: (\d+)/.exec(lines.pop())?.[1]);
    const shown = lines.slice(1).filter(line => !line.startsWith('#')).length;
    assert.ok(shown > 0 && shown <= max, tool);
    assert.equal(omitted, count - shown, tool);
    assert.ok(Buffer.byteLength(output) <= 6000, tool);
    assert.ok(lines.every(line => Buffer.byteLength(line) <= 400), tool);
  }
  const defaultLimit = await client.text('who_renders', { component: 'Target' });
  assert.equal(defaultLimit.split('\n').length, 42);
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
  assert.equal(ambiguous.split('\n').length, 4);
  assert.ok(ambiguous.split('\n').slice(1).every(line => /^fixture\/[abc].tsx:1#Triangle component$/.test(line)));
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
  assert.match(await client.text('api_consumers', { route: 'app/api/neorion-test/route.ts', includeTests: true }), /\[test\]/);
  assert.match(outputs.api_consumers, /^call2 .*entry.ts:2 useClient$/m);
  assert.match(outputs.rename_impact, /use  fixture\/use-client.ts:1,2  import as send/);
  assert.match(outputs.rename_impact, /use  fixture\/reexports.ts:1  re-export/);
  assert.equal(outputs.rename_impact.match(/^use  fixture\/many-\d+\.ts:/gm).length, 20);
  assert.match(outputs.rename_impact, /vi\.mock key/);
  assert.match(outputs.rename_impact, /fixture\/destructure.test.ts:1,2 \[test\]  import as run/);
  assert.match(outputs.rename_impact, /# not affected: .*writeData \(comment\).*writeData \(different symbol\)/);
  assert.doesNotMatch(outputs.rename_impact, /^use .*other.ts/m);
  assert.match(outputs.wrappers, /branch A[\s\S]+branch B/);
  assert.match(outputs.wrappers, /Provider \[cond\]/);
  assert.doesNotMatch(outputs.wrappers, /WrapperInside|QueryProvider/);
  assert.match(await client.text('wrappers', { route: '/structure', includeExternal: true }), /fixture\/providers.tsx:2 Provider, widgets#QueryProvider/);

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
    'Neorion index not found at .neorion/index.v1.json. Run "Neorion: Generate Architecture Map" in VS Code.');
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
